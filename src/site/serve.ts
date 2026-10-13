/**
 * The consuming site's docs server: every request a docs route answers, decided here.
 *
 * A consuming site holds one `app/lib/docs.server.ts` that hands this function its configs,
 * its globs and a few literal options, and route modules whose loaders are one line each.
 * Everything subtle lives here, once, for both consumers, because every piece of it was measured
 * to go wrong in a way that renders a perfectly good page:
 *
 * - React Router matches case-insensitively and a page row answers `/hex-nfc/docs`,
 *   `/hex-nfc/docs/`, `/HEX-NFC/Docs` and `/gu%69de` alike, so the slug is found by a lookup
 *   table keyed on the lower-cased, decoded, slashless path and is never parsed out of the
 *   pathname, and every spelling but the canonical one is a 301 to it.
 * - A machine row has no default export, so no parent loader runs for it and the `:lang`
 *   segment reaches it unvalidated. `resource()` therefore decides the language itself, in
 *   the order hex-web's `routes/lang.tsx` does.
 * - The bundle is data the site did not produce. A manifest that is missing, malformed or
 *   for another commit is a 500 naming `hexdocs prefetch`, never an exception at import,
 *   which would take down every route the module is reachable from rather than the docs.
 *
 * What the machine text says is composed in `machine.ts`, and the agent interface is
 * `agents.ts`; this module routes to them and owns the bundles they read.
 *
 * It uses the global `Response`, and nothing else from outside the contracts: no JSX, no
 * stylesheet and no node module, so it stays reachable from the node-safe barrel.
 */

import type {
	DocsAgentConfig,
	DocsAppFacts,
	DocsHostFacts,
	DocsLicence,
} from '../contracts/host.js';
import { originProblem } from '../contracts/host.js';
import { matchLocale, SOURCE_LOCALE, type Locale } from '../contracts/locales.js';
import { llmsKey, pageKey, type PageLocaleRecord, type PageRecord } from '../contracts/manifest.js';
import type { DocsSeo, DocsSiteConfig } from '../contracts/site.js';
import { isSectionRoot, requireSlug, slugToPath } from '../contracts/slug.js';
import { docsHref, docsRawHref, type DocsSitemapRow } from './address.js';
import { createAgents, DEFAULT_RATE_LIMIT, type AgentLibrary, type RateLimit } from './agents.js';
import {
	checkBundle,
	indexSources,
	loadSearchIndex,
	readObject,
	readText,
	stored,
	type Bundle,
	type DocsSources,
} from './bundle.js';
import {
	absoluteCompiledLlms,
	composeLlms,
	fullText,
	isoDate,
	machineResponse,
	machineUrl,
	MARKDOWN,
	pageMarkdown,
	PLAIN_TEXT,
	productNameOf,
	resolveLinks,
	type MachineOptions,
	type Served,
} from './machine.js';
import { docsRoute, indexableLanguages, type DocsPageData } from './route.js';

export type { DocsSources } from './bundle.js';
export type { RateLimit } from './agents.js';

/**
 * What a consuming site passes, every addition optional.
 *
 * With none of them, the server answers exactly as it did before they existed, apart from the
 * headers every machine response now carries and the redirects every variant spelling now
 * gets. kcalc passes none of them and has to keep working.
 */
export interface DocsServerOptions extends DocsSources {
	/**
	 * The site's own origin, `https://apps.hex.pro`, written as a literal in `docs.server.ts`.
	 *
	 * Every absolute URL in machine text is this string followed by a path, and the markdown
	 * twins name their canonical HTML page with it. It cannot be read off a request: behind the
	 * deploy's tunnel `request.url` says `http://`. A value that is not an origin is a 500 from
	 * every handler, naming it, rather than a throw at import.
	 */
	origin?: string;
	/** The licence the documentation is published under, stated in every machine file and page. */
	licence?: DocsLicence;
	/** The agent interface's identity and the paths the host mounts it at. */
	agents?: DocsAgentConfig;
	/** The per-process token buckets, per client address. `DEFAULT_RATE_LIMIT` when absent. */
	rateLimit?: { mcp?: RateLimit; search?: RateLimit };
	/** Milliseconds since the epoch, for the token buckets. `Date.now` when absent; tests pass one. */
	clock?: () => number;
}

export interface DocsPageLoaderData {
	seo: DocsSeo;
	data: DocsPageData;
	/** The site config's class, omitted when the config has none. */
	themeClass?: string;
}

export interface DocsServer {
	/**
	 * A docs page, for `routes/docs.tsx`. Throws a `Response` for a 301, a 404 and a 500.
	 *
	 * Thrown rather than returned so a consumer maps nothing: React Router follows a thrown
	 * 3xx with a `Location` and renders the root error boundary for anything else, which is
	 * what both consumers already do for their own pages.
	 */
	page(url: URL): Promise<DocsPageLoaderData>;
	/**
	 * `llms.txt`, `llms-full.txt` and every `<slug>.md`. Always resolves to a `Response`.
	 *
	 * Pass the `Request` rather than its URL to have `If-None-Match` and `If-Modified-Since`
	 * answered with a 304; a URL alone is still accepted and always gets the body. `host` is the
	 * site's facts about the app, from a route module, which is what `llms.txt` describes the
	 * app with and the markdown header names the product with.
	 */
	resource(input: URL | Request, host?: DocsHostFacts): Promise<Response>;
	/**
	 * The sitemap rows. Hidden pages and redirect sources are excluded, and `languages` is
	 * `indexableLanguages` of each page's record. Throws a `Response` 500 when a bundle
	 * cannot be served, because a sitemap that silently dropped a project is the failure
	 * nobody sees.
	 */
	sitemap(): DocsSitemapRow[];
	/** The MCP endpoint, for the `loader` and the `action` of one resource route. */
	mcp(request: Request, host?: DocsHostFacts): Promise<Response>;
	/** The JSON search, `?q=&app=&lang=&audience=&limit=`, for a resource route's `loader`. */
	search(request: Request, host?: DocsHostFacts): Promise<Response>;
	/** The MCP Server Card, for a resource route's `loader` and, for a preflight, its `action`. */
	serverCard(request: Request): Promise<Response>;
}

function plain(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: { 'Content-Type': PLAIN_TEXT, 'X-Content-Type-Options': 'nosniff' },
	});
}

function moved(location: string): Response {
	return new Response(null, { status: 301, headers: { Location: location } });
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

type PageEntry = { site: DocsSiteConfig; slug: string; redirectTo?: string };
type ResourceEntry =
	| { site: DocsSiteConfig; kind: 'llms' | 'llms-full' }
	| { site: DocsSiteConfig; kind: 'raw'; slug: string };

interface Tables {
	pages: Map<string, PageEntry>;
	resources: Map<string, ResourceEntry>;
}

/**
 * The two lookup tables, keyed on the lower-cased English address.
 *
 * Built from the same `pages` and `redirects` the route rows are, through the same address
 * builders, so a row and its lookup cannot disagree about a spelling. A redirect source is
 * entered first and a page second, so a slug that is somehow both is served as the page,
 * which is what `validateManifestShape` says a redirect must never shadow.
 */
function buildTables(configs: readonly DocsSiteConfig[]): Tables {
	const pages = new Map<string, PageEntry>();
	const resources = new Map<string, ResourceEntry>();
	for (const site of configs) {
		const basePath = site.basePath;
		for (const [slug, target] of Object.entries(site.redirects ?? {})) {
			const key = docsHref({ basePath, locale: SOURCE_LOCALE, slug }).toLowerCase();
			pages.set(key, { site, slug, redirectTo: target });
		}
		for (const slug of site.pages) {
			pages.set(docsHref({ basePath, locale: SOURCE_LOCALE, slug }).toLowerCase(), { site, slug });
			const raw = docsRawHref({ basePath, locale: SOURCE_LOCALE, slug }).toLowerCase();
			resources.set(raw, { site, kind: 'raw', slug });
		}
		resources.set(`${basePath}/llms.txt`.toLowerCase(), { site, kind: 'llms' });
		resources.set(`${basePath}/llms-full.txt`.toLowerCase(), { site, kind: 'llms-full' });
	}
	return { pages, resources };
}

type Located<E> =
	| { kind: 'moved'; location: string }
	| { kind: 'missing' }
	| { kind: 'found'; locale: Locale; entry: E };

/**
 * The locale and table entry a URL names, or the redirect or 404 it deserves instead.
 *
 * The order is hex-web's `routes/lang.tsx`, transcribed, because for a machine row this
 * function is the only thing that runs and the two have to give the same answer for the
 * same address:
 *
 * 1. An unprefixed path the table knows is English. Tried first because a static row
 *    outranks `:lang` in the router, so a known bare path never reached a language check.
 * 2. Otherwise the first segment must be one of the seven, compared case-insensitively,
 *    or the answer is 404. `matchLocale` also folds `zh-hans` and `pt_BR`, and that fold
 *    is refused here on purpose: `lang.tsx` accepts exactly the seven spellings, so a
 *    resource route that 301ed `/zh-hans/...` would answer an address the page beside it
 *    404s.
 * 3. `en` in any casing, and any other casing of a language, is found when the rest of the
 *    address is known, and the caller's canonical comparison then redirects it in one hop to
 *    the canonical spelling of the whole address. When the rest is not known, the language
 *    alone is corrected, as `lang.tsx` would.
 *
 * Every redirect keeps `url.search`. The lookup decodes, so `/gu%69de` finds `guide` the way
 * the router already matched it; a segment that does not decode is a 404.
 */
function locate<E>(url: URL, table: Map<string, E>): Located<E> {
	const raw = url.pathname.split('/').filter((segment) => segment !== '');
	let decoded: string[];
	try {
		decoded = raw.map((segment) => decodeURIComponent(segment));
	} catch {
		return { kind: 'missing' };
	}

	const bare = table.get(`/${decoded.join('/')}`.toLowerCase());
	if (bare !== undefined) return { kind: 'found', locale: SOURCE_LOCALE, entry: bare };

	const segment = decoded[0];
	if (segment === undefined) return { kind: 'missing' };
	const match = matchLocale(segment);
	if (!match.ok || match.locale.toLowerCase() !== segment.toLowerCase()) return { kind: 'missing' };

	const entry = table.get(`/${decoded.slice(1).join('/')}`.toLowerCase());
	if (entry !== undefined) return { kind: 'found', locale: match.locale, entry };
	if (match.locale === SOURCE_LOCALE) {
		return { kind: 'moved', location: `/${raw.slice(1).join('/')}${url.search}` };
	}
	if (segment !== match.locale) {
		const rest = raw.slice(1).join('/');
		return {
			kind: 'moved',
			location: `/${match.locale}${rest === '' ? '' : `/${rest}`}${url.search}`,
		};
	}
	return { kind: 'missing' };
}

/**
 * A 301 to the canonical spelling, or nothing when the request already used it.
 *
 * React Router matches case-insensitively, decodes, and answers `/hex-nfc/docs/guide/`,
 * `/HEX-NFC/Docs/guide`, `/hex-nfc/docs/gu%69de` and `/hex-nfc/docs//guide` from the one row,
 * and every one of them is a duplicate of the canonical address. They used to be served and
 * marked not indexable, which kept them out of the index and still showed a reader a page whose
 * address disagreed with its canonical, and still spent a crawler's fetch on each. A redirect
 * consolidates them, and the root loaders of both consumers redirect their own pages' variants
 * the same way.
 *
 * Compared as a URL path, through `new URL`, so the canonical address is percent-encoded the way
 * the request's path is, and a mount with a character that needs encoding is not redirected to
 * itself for ever. `.data` requests arrive with the canonical path, because React Router strips
 * the suffix before the loader runs, so a client navigation is never redirected.
 */
function canonicalRedirect(url: URL, canonical: string): Response | undefined {
	const path = new URL(canonical, url).pathname;
	return url.pathname === path ? undefined : moved(`${path}${url.search}`);
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** The app's facts for one project: `describe` first, then the project's catalogue entry. */
function factsFor(site: DocsSiteConfig, host: DocsHostFacts | undefined): DocsAppFacts | undefined {
	return (
		host?.describe?.(site.project) ?? host?.apps?.().find((app) => app.project === site.project)
	);
}

export function docsServer(options: DocsServerOptions): DocsServer {
	const bundles = indexSources(options);
	const checked = new Map<DocsSiteConfig, Bundle>();
	let tables: Tables | { broken: string } | undefined;
	const machine: MachineOptions = {
		...(options.origin === undefined ? {} : { origin: options.origin }),
		...(options.licence === undefined ? {} : { licence: options.licence }),
		...(options.agents === undefined ? {} : { agents: options.agents }),
	};
	// Checked here and reported per request, never thrown: `docsServer` runs at the top of a
	// module the route config loads, so a throw would fail every route in the site rather than
	// answering the docs ones with a 500 that says what is wrong.
	const configProblem =
		options.origin === undefined
			? undefined
			: originProblem(options.origin)?.replace(/^/, 'The docs origin option ');

	const bundleFor = (site: DocsSiteConfig): Bundle => {
		let bundle = checked.get(site);
		if (bundle === undefined) {
			bundle = checkBundle(site, bundles);
			checked.set(site, bundle);
		}
		return bundle;
	};

	// Built on first use rather than at construction, and a failure is kept rather than
	// thrown, for the same reason as the origin above.
	const tablesOrError = (): Tables | { broken: string } => {
		if (tables === undefined) {
			try {
				tables = buildTables(options.configs);
			} catch (error) {
				tables = { broken: `The docs site configs cannot be routed: ${String(error)}` };
			}
		}
		return tables;
	};

	// One parse of an index per process, kept as a promise so concurrent first queries share it.
	const indexes = new Map<string, ReturnType<AgentLibrary['searchIndex']>>();
	const library: AgentLibrary = {
		configs: options.configs,
		bundleFor,
		options: machine,
		broken: () => configProblem,
		searchIndex(served, locale) {
			const key = `${served.site.project}/${served.bundle.label}/${locale}`;
			let loaded = indexes.get(key);
			if (loaded === undefined) {
				loaded = loadSearchIndex(served.site, served.bundle, locale);
				indexes.set(key, loaded);
			}
			return loaded;
		},
		productName: productNameOf,
	};
	const agents = createAgents(library, {
		mcp: options.rateLimit?.mcp ?? DEFAULT_RATE_LIMIT,
		search: options.rateLimit?.search ?? DEFAULT_RATE_LIMIT,
		clock: options.clock ?? Date.now,
	});

	return {
		async page(url) {
			if (configProblem !== undefined) throw plain(500, configProblem);
			const routed = tablesOrError();
			if ('broken' in routed) throw plain(500, routed.broken);

			const located = locate(url, routed.pages);
			if (located.kind === 'moved') throw moved(located.location);
			if (located.kind === 'missing') throw plain(404, 'Not Found');

			const { locale, entry } = located;
			const { site, slug } = entry;
			if (entry.redirectTo !== undefined) {
				const target = docsHref({ basePath: site.basePath, locale, slug: entry.redirectTo });
				throw moved(`${target}${url.search}`);
			}
			const variant = canonicalRedirect(url, docsHref({ basePath: site.basePath, locale, slug }));
			if (variant !== undefined) throw variant;

			const bundle = bundleFor(site);
			if (!bundle.ok) throw plain(500, bundle.message);

			const result = await docsRoute({
				manifest: bundle.manifest,
				site,
				locale,
				slug,
				bundleBase: bundle.bundleBase,
				load: (served, wire) => readObject(bundle.files.pages, pageKey(served, wire)),
			});
			if (!result.ok) {
				if (result.reason === 'redirect') throw moved(`${result.to}${url.search}`);
				if (result.reason === 'no-such-page') throw plain(404, 'Not Found');
				throw plain(
					500,
					`The ${site.project} docs page "${slug}" in ${locale} cannot be served (${result.reason}). Run hexdocs prefetch for this site, then rebuild.`,
				);
			}

			const data: DocsPageData = {
				...result.data,
				...(options.origin === undefined
					? {}
					: { rawUrl: `${options.origin}${result.data.rawHref}` }),
				...(options.licence === undefined ? {} : { licence: options.licence }),
			};
			return {
				seo: result.seo,
				data,
				...(site.themeClass === undefined ? {} : { themeClass: site.themeClass }),
			};
		},

		async resource(input, host) {
			const url = input instanceof URL ? input : new URL(input.url);
			const headers = input instanceof URL ? undefined : input.headers;
			if (configProblem !== undefined) return plain(500, configProblem);
			const routed = tablesOrError();
			if ('broken' in routed) return plain(500, routed.broken);

			const located = locate(url, routed.resources);
			if (located.kind === 'moved') return moved(located.location);
			if (located.kind === 'missing') return plain(404, 'Not Found');

			const { locale, entry } = located;
			const site = entry.site;
			// A machine address has one spelling, with no trailing slash, in its own casing.
			// `llms.txt` links relatively when there is no origin, so served at `llms.txt/` every
			// link resolved one segment too deep and 404d, which is how this rule started.
			const canonical =
				entry.kind === 'raw'
					? docsRawHref({ basePath: site.basePath, locale, slug: entry.slug })
					: `${docsHref({ basePath: site.basePath, locale, slug: 'index' })}/${entry.kind === 'llms' ? 'llms.txt' : 'llms-full.txt'}`;
			const variant = canonicalRedirect(url, canonical);
			if (variant !== undefined) return variant;

			const bundle = bundleFor(site);
			if (!bundle.ok) return plain(500, bundle.message);
			const served: Served = { site, bundle };
			const manifest = bundle.manifest;
			const missingObject = (key: string): Response =>
				plain(
					500,
					`The ${site.project} docs bundle for version "${bundle.label}" has no readable ${stored(key)}. Run hexdocs prefetch for this site, then rebuild.`,
				);
			const facts = factsFor(site, host);

			if (entry.kind === 'llms') {
				const language = manifest.locales.includes(locale) ? locale : manifest.sourceLocale;
				let body: string;
				if (facts !== undefined) {
					body = composeLlms(served, locale, facts, machine);
				} else {
					const key = llmsKey(language);
					const text = await readText(bundle.files, key);
					if (text === undefined) return missingObject(key);
					const resolved = resolveLinks(text, served, locale, undefined);
					body =
						options.origin === undefined
							? resolved
							: absoluteCompiledLlms(resolved, served, locale, options.origin);
				}
				return machineResponse(
					{
						body,
						type: PLAIN_TEXT,
						languages: [language],
						lastModified: manifest.commitTimestamp,
						noindex: true,
					},
					headers,
				);
			}

			if (entry.kind === 'raw') {
				const record = manifest.pages[entry.slug];
				if (record === undefined) return plain(404, 'Not Found');
				const page = await pageMarkdown(served, entry.slug, locale, facts, machine);
				if (!page.ok) return missingObject(page.missing);
				// A canonical and no `noindex` once there is an origin to write one with: the
				// markdown twin is the same page as the HTML one, and `rel="canonical"` is how a
				// non-HTML duplicate is consolidated rather than suppressed. Without an origin the
				// old answer stands, because a canonical has to be absolute and nothing here knows
				// the absolute address.
				const link =
					page.canonical === undefined
						? undefined
						: [
								`<${page.canonical}>; rel="canonical"`,
								...(options.licence === undefined
									? []
									: [`<${options.licence.url}>; rel="license"`]),
							].join(', ');
				return machineResponse(
					{
						body: page.text,
						type: MARKDOWN,
						languages: page.languages,
						lastModified: page.lastModified,
						...(link === undefined ? {} : { link }),
						noindex: link === undefined,
					},
					headers,
				);
			}

			const name = facts?.name ?? (await productNameOf(served));
			const full = await fullText(served, locale, facts, name, machine);
			if (!full.ok) return missingObject(full.missing);
			return machineResponse(
				{
					body: full.text,
					type: PLAIN_TEXT,
					languages: full.languages,
					lastModified: full.lastModified,
					noindex: true,
				},
				headers,
			);
		},

		sitemap() {
			if (configProblem !== undefined) throw plain(500, configProblem);
			const routed = tablesOrError();
			if ('broken' in routed) throw plain(500, routed.broken);

			const rows: DocsSitemapRow[] = [];
			for (const site of options.configs) {
				const bundle = bundleFor(site);
				if (!bundle.ok) throw plain(500, bundle.message);
				const hidden = new Set(site.hidden ?? []);
				for (const slug of site.pages) {
					const record: PageRecord | undefined = bundle.manifest.pages[slug];
					// A slug the config lists and the bundle lacks is a page `page()` answers
					// with a 404, so listing it would advertise one. `hexdocs prefetch` refuses
					// that skew before a build gets here.
					if (hidden.has(slug) || record === undefined) continue;
					const parsed = requireSlug(slug, 'sitemap');
					const path = slugToPath(parsed);
					const languages = indexableLanguages(record);
					// Each language's own date, because each is its own `<url>`: a stale
					// translation was last changed when it was translated, not when the English
					// was. The row's `lastmod` is the newest of them, for a host that writes one.
					const lastmods: Partial<Record<Locale, string>> = {};
					for (const language of languages) {
						lastmods[language] = isoDate((record.locales[language] as PageLocaleRecord).updatedAt);
					}
					const source = record.locales[bundle.manifest.sourceLocale] as PageLocaleRecord;
					rows.push({
						path: docsHref({ basePath: site.basePath, locale: SOURCE_LOCALE, slug }),
						// The docs home above a section root above a leaf, which is the shape
						// hex-web's own table uses for its section pages.
						priority: path === '' ? '0.8' : isSectionRoot(parsed) ? '0.7' : '0.6',
						changefreq: 'monthly',
						languages,
						lastmod: [isoDate(source.updatedAt), ...Object.values(lastmods)]
							.sort()
							.at(-1) as string,
						lastmods,
					});
				}
			}
			return rows.sort((a, b) => (a.path < b.path ? -1 : 1));
		},

		mcp: (request, host) => agents.mcp(request, host),
		search: (request, host) => agents.search(request, host),
		serverCard: (request) => agents.serverCard(request),
	};
}

/** The machine text addresses for a mount, for a host that links them from its own pages. */
export function docsMachineUrls(
	origin: string | undefined,
	site: DocsSiteConfig,
	locale: Locale = SOURCE_LOCALE,
): { llms: string; llmsFull: string } {
	const served = { site } as Served;
	return {
		llms: machineUrl(origin, served, locale, 'llms.txt'),
		llmsFull: machineUrl(origin, served, locale, 'llms-full.txt'),
	};
}
