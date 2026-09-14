/**
 * The consuming site's docs server: every request a docs route answers, decided here.
 *
 * A consuming site holds one `app/lib/docs.server.ts` that hands this function its configs
 * and three globs, and two route modules whose loaders are one line each. Everything subtle lives here, once,
 * for both consumers, because every piece of it was measured to go wrong in a way that
 * renders a perfectly good page:
 *
 * - React Router matches case-insensitively and a page row answers `/hex-nfc/docs`,
 *   `/hex-nfc/docs/`, `/HEX-NFC/Docs` and `/gu%69de` alike, so the slug is found by a lookup
 *   table keyed on the lower-cased, decoded, slashless path and is never parsed out of the
 *   pathname. A pathname-derived slug works in every test that types the canonical spelling.
 * - A machine row has no default export, so no parent loader runs for it and the `:lang`
 *   segment reaches it unvalidated. `resource()` therefore decides the language itself, in
 *   the order hex-web's `routes/lang.tsx` does.
 * - The bundle is data the site did not produce. A manifest that is missing, malformed or
 *   for another commit is a 500 naming `hexdocs prefetch`, never an exception at import,
 *   which would take down every route the module is reachable from rather than the docs.
 *
 * It uses the global `Response`, and nothing else from outside the contracts: no JSX, no
 * stylesheet and no node module, so it stays reachable from the node-safe barrel.
 */

import { AST_VERSION } from '../contracts/ast.js';
import { LOCALES, matchLocale, SOURCE_LOCALE, type Locale } from '../contracts/locales.js';
import {
	BUNDLE_TREE,
	llmsKey,
	MANIFEST_KEY,
	MANIFEST_VERSION,
	pageKey,
	PUBLIC_TREE,
	RAW_ASSET_LINK,
	RAW_PAGE_LINK,
	rawKey,
	validateManifestShape,
	type BundleManifest,
	type PageRecord,
} from '../contracts/manifest.js';
import type { DocsSeo, DocsSiteConfig, VersionEntry } from '../contracts/site.js';
import { isSectionRoot, requireSlug, slugToPath } from '../contracts/slug.js';
import { docsHref, docsRawHref, type DocsSitemapRow } from './address.js';
import { docsRoute, indexableLanguages, servedLocale, type DocsPageData } from './route.js';

export interface DocsSources {
	configs: readonly DocsSiteConfig[];
	/** Eager glob of `../docs/_bundles/*\/*\/manifest.json`, `import: 'default'`. */
	manifests: Record<string, unknown>;
	/** Lazy glob of `../docs/_bundles/*\/*\/pages/**\/*.json`, `import: 'default'`. */
	pages: Record<string, () => Promise<unknown>>;
	/**
	 * Lazy glob of `../docs/_bundles/*\/*\/raw/**\/*.md` and `../docs/_bundles/*\/*\/llms/*.txt`,
	 * `query: '?raw'`, `import: 'default'`.
	 *
	 * Typed as resolving to `unknown`, not `string`. The module `install` writes passes
	 * `import.meta.glob<string>`, which Vite 7 types as resolving to `string`, but that type
	 * argument is an assertion Vite never checks, and the module is the consumer's to edit.
	 * The same glob written without it resolves to `unknown`, which a `string` here would
	 * refuse with TS2322. So the field takes the widest glob a consumer may write, and each
	 * value is checked when it is read, which is also what refuses a glob written without
	 * `import: 'default'`.
	 */
	text: Record<string, () => Promise<unknown>>;
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
	/** `llms.txt`, `llms-full.txt` and every `<slug>.md`. Always resolves to a `Response`. */
	resource(url: URL): Promise<Response>;
	/**
	 * The sitemap rows. Hidden pages and redirect sources are excluded, and `languages` is
	 * `indexableLanguages` of each page's record. Throws a `Response` 500 when a bundle
	 * cannot be served, because a sitemap that silently dropped a project is the failure
	 * nobody sees.
	 */
	sitemap(): DocsSitemapRow[];
}

const PLAIN_TEXT = 'text/plain; charset=utf-8';
const MARKDOWN = 'text/markdown; charset=utf-8';

/** The directory a bundle's public objects are served from: `/_docs/<project>/<label>`. */
function bundleBaseOf(project: string, label: string): string {
	return `/${PUBLIC_TREE}/${project}/${label}`;
}

/** Where `hexdocs prefetch` writes an object: its key with the gzip suffix gone. */
function stored(key: string): string {
	return key.endsWith('.gz') ? key.slice(0, -'.gz'.length) : key;
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

/**
 * Machine text: `noindex`, `nosniff`, and the language of what was actually served.
 *
 * No `Link: rel=canonical`. A `noindex` beside a canonical is two contradictory
 * instructions, and a canonical has to be absolute, which needs an origin this module
 * does not have: behind the deploy's tunnel `request.url` says `http://`.
 */
function machineText(body: string, type: string, languages: readonly Locale[]): Response {
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': type,
			'X-Content-Type-Options': 'nosniff',
			'X-Robots-Tag': 'noindex',
			'Content-Language': languages.join(', '),
		},
	});
}

// ---------------------------------------------------------------------------
// Glob keys
// ---------------------------------------------------------------------------

/**
 * `<anything>/_bundles/<project>/<label>/<object>`, split on the tree name.
 *
 * Parsed on the `BUNDLE_TREE` segment rather than on a prefix, so the relative path a
 * consumer's glob produces decides nothing, and a server module moved to another directory
 * keeps working. The last occurrence is used, which is unambiguous: no project,
 * label, locale or slug segment may begin with an underscore. A key that does not have
 * that shape names no bundle and is ignored; if every key is like that, every request
 * for the site reports its bundle as missing, which names the fix.
 */
function splitKey(key: string): { bundle: string; object: string } | undefined {
	const segments = key.split('/');
	const at = segments.lastIndexOf(BUNDLE_TREE);
	if (at < 0 || segments.length < at + 4) return undefined;
	return {
		bundle: `${segments[at + 1]}/${segments[at + 2]}`,
		object: segments.slice(at + 3).join('/'),
	};
}

interface BundleFiles {
	manifest?: unknown;
	pages: Map<string, () => Promise<unknown>>;
	text: Map<string, () => Promise<unknown>>;
}

function indexSources(sources: DocsSources): Map<string, BundleFiles> {
	const bundles = new Map<string, BundleFiles>();
	const filesFor = (bundle: string): BundleFiles => {
		let files = bundles.get(bundle);
		if (files === undefined) {
			files = { pages: new Map(), text: new Map() };
			bundles.set(bundle, files);
		}
		return files;
	};
	for (const [key, value] of Object.entries(sources.manifests)) {
		const split = splitKey(key);
		if (split !== undefined && split.object === MANIFEST_KEY)
			filesFor(split.bundle).manifest = value;
	}
	for (const [key, load] of Object.entries(sources.pages)) {
		const split = splitKey(key);
		if (split !== undefined) filesFor(split.bundle).pages.set(split.object, load);
	}
	for (const [key, load] of Object.entries(sources.text)) {
		const split = splitKey(key);
		if (split !== undefined) filesFor(split.bundle).text.set(split.object, load);
	}
	return bundles;
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

type Bundle =
	| {
			ok: true;
			manifest: BundleManifest;
			label: string;
			bundleBase: string;
			files: BundleFiles;
	  }
	| { ok: false; message: string };

/**
 * The default version's bundle for one site, checked once.
 *
 * Four identity checks before the shape check, because each names a different wrong
 * state and all of them are a site that ran `hexdocs prefetch` against a different config
 * or not at all. The commit comparison is the one worth stating: a relabel moves a label
 * to another commit, and a build that skipped the prefetch would otherwise serve the old
 * commit's pages under the new label with nothing on the page to show it.
 *
 * `validateManifestShape` is written against the manifest type and dereferences it
 * freely, so an object that is not shaped like a manifest throws from inside it. That
 * throw is caught here and becomes the same refusal. Letting it escape would be a
 * `TypeError` inside a page loader and inside the sitemap loader, which React Router
 * answers with a 500 that says nothing about prefetching.
 */
function checkBundle(site: DocsSiteConfig, bundles: Map<string, BundleFiles>): Bundle {
	const version: VersionEntry | undefined = site.versions.find((entry) => entry.default === true);
	if (version === undefined) {
		return {
			ok: false,
			message: `The ${site.project} docs config has no default version, so there is no bundle to serve. Label a version as the default and run hexdocs prefetch.`,
		};
	}
	const refuse = (reason: string): Bundle => ({
		ok: false,
		message: `The ${site.project} docs bundle for version "${version.label}" cannot be served: ${reason}. Run hexdocs prefetch for this site, then rebuild.`,
	});

	const files = bundles.get(`${site.project}/${version.label}`);
	const value = files?.manifest;
	if (files === undefined || value === undefined) {
		return refuse(`no ${BUNDLE_TREE}/${site.project}/${version.label}/${MANIFEST_KEY} was found`);
	}
	if (typeof value !== 'object' || value === null) return refuse('its manifest is not an object');
	const claimed = value as Partial<BundleManifest>;
	if (claimed.manifest !== MANIFEST_VERSION) {
		return refuse(`its manifest version is ${String(claimed.manifest)}, not ${MANIFEST_VERSION}`);
	}
	if (claimed.ast !== AST_VERSION) {
		return refuse(
			`it was compiled at ast-${String(claimed.ast)} and this runtime reads ast-${AST_VERSION}`,
		);
	}
	if (claimed.project !== site.project) {
		return refuse(`its manifest names project "${String(claimed.project)}"`);
	}
	if (claimed.commit !== version.commit) {
		return refuse(
			`its manifest is commit ${String(claimed.commit)} and the label names ${version.commit}`,
		);
	}

	let problems: string[];
	try {
		problems = validateManifestShape(value as BundleManifest);
	} catch (error) {
		problems = [`it is not shaped like a manifest (${String(error)})`];
	}
	if (problems.length > 0) return refuse(problems.join(' '));

	return {
		ok: true,
		manifest: value as BundleManifest,
		label: version.label,
		bundleBase: bundleBaseOf(site.project, version.label),
		files,
	};
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
 * 3. `en` in any casing is a 301 to the bare path.
 * 4. Any other casing is a 301 to the canonical one.
 *
 * Every redirect keeps `url.search`, and rebuilds the remainder from the raw pathname so
 * its percent-encoding survives. The lookup itself decodes, so `/gu%69de` finds `guide`
 * the way the router already matched it; a segment that does not decode is a 404.
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

	const rest = raw.slice(1).join('/');
	if (match.locale === SOURCE_LOCALE) return { kind: 'moved', location: `/${rest}${url.search}` };
	if (segment !== match.locale) {
		const tail = rest === '' ? '' : `/${rest}`;
		return { kind: 'moved', location: `/${match.locale}${tail}${url.search}` };
	}

	const entry = table.get(`/${decoded.slice(1).join('/')}`.toLowerCase());
	if (entry === undefined) return { kind: 'missing' };
	return { kind: 'found', locale: match.locale, entry };
}

/**
 * The raw link destinations the compiler wrote, made into addresses.
 *
 * `RAW_PAGE_LINK` becomes `<locale prefix><basePath>/`, so a link in a Japanese body goes
 * to the Japanese raw address, which falls back per page by itself. `RAW_ASSET_LINK`
 * becomes the bundle's public asset directory. The match includes the `](` in front of
 * the prefix, so prose that mentions the scheme is left as written.
 */
function resolveLinks(
	text: string,
	site: DocsSiteConfig,
	locale: Locale,
	bundleBase: string,
): string {
	const pagePrefix = docsHref({ basePath: site.basePath, locale, slug: 'index' });
	return text
		.replaceAll(`](${RAW_PAGE_LINK}`, `](${pagePrefix}/`)
		.replaceAll(`](${RAW_ASSET_LINK}`, `](${bundleBase}/assets/`);
}

/** One trailing slash off, which is the one spelling difference that stays indexable. */
function withoutTrailingSlash(path: string): string {
	return path.endsWith('/') ? path.slice(0, -1) : path;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export function docsServer(sources: DocsSources): DocsServer {
	const bundles = indexSources(sources);
	const checked = new Map<DocsSiteConfig, Bundle>();
	let tables: Tables | { broken: string } | undefined;

	const bundleFor = (site: DocsSiteConfig): Bundle => {
		let bundle = checked.get(site);
		if (bundle === undefined) {
			bundle = checkBundle(site, bundles);
			checked.set(site, bundle);
		}
		return bundle;
	};

	// Built on first use rather than at construction, and a failure is kept rather than
	// thrown. `docsServer` runs at the top of a module the route config loads, so a throw
	// here would fail every route in the site rather than answering the docs ones with a
	// 500 that says what is wrong.
	const tablesOrError = (): Tables | { broken: string } => {
		if (tables === undefined) {
			try {
				tables = buildTables(sources.configs);
			} catch (error) {
				tables = { broken: `The docs site configs cannot be routed: ${String(error)}` };
			}
		}
		return tables;
	};

	// Both readers answer `undefined` for an object the glob does not have and for one whose
	// loader rejects, because to the reader both mean the object is not in this build.
	// `page()` then refuses the payload and `resource()` names the object,
	// and both answer with a 500 rather than letting a rejection escape a loader that
	// promises a `Response`.
	const read = async (loaders: BundleFiles['pages'], key: string): Promise<unknown> => {
		const loader = loaders.get(stored(key));
		try {
			return loader === undefined ? undefined : await loader();
		} catch {
			return undefined;
		}
	};
	const load = (files: BundleFiles, key: string): Promise<unknown> => read(files.pages, key);

	// A text object that is not a string is unreadable too. That is what a glob written
	// without `import: 'default'` hands over, a module object with the text inside it, and
	// serving `[object Object]` as markdown with a 200 is the failure that looks like a page.
	const readText = async (files: BundleFiles, key: string): Promise<string | undefined> => {
		const text = await read(files.text, key);
		return typeof text === 'string' ? text : undefined;
	};

	return {
		async page(url) {
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

			const bundle = bundleFor(site);
			if (!bundle.ok) throw plain(500, bundle.message);

			const result = await docsRoute({
				manifest: bundle.manifest,
				site,
				locale,
				slug,
				bundleBase: bundle.bundleBase,
				load: (served, wire) => load(bundle.files, pageKey(served, wire)),
			});
			if (!result.ok) {
				if (result.reason === 'redirect') throw moved(`${result.to}${url.search}`);
				if (result.reason === 'no-such-page') throw plain(404, 'Not Found');
				throw plain(
					500,
					`The ${site.project} docs page "${slug}" in ${locale} cannot be served (${result.reason}). Run hexdocs prefetch for this site, then rebuild.`,
				);
			}

			// Served, and indexable only at its canonical spelling. React Router answers
			// `/HEX-NFC/Docs` and `/hex-nfc/docs//` from the same row, and each is a
			// duplicate of the canonical address that must not be indexed. A redirect would
			// also do, and the site does not redirect case variants of its own pages either.
			const canonical = docsHref({ basePath: site.basePath, locale, slug });
			const exact = withoutTrailingSlash(url.pathname) === canonical;
			return {
				seo: { indexable: result.seo.indexable && exact, languages: result.seo.languages },
				data: result.data,
				...(site.themeClass === undefined ? {} : { themeClass: site.themeClass }),
			};
		},

		async resource(url) {
			const routed = tablesOrError();
			if ('broken' in routed) return plain(500, routed.broken);

			const located = locate(url, routed.resources);
			if (located.kind === 'moved') return moved(located.location);
			if (located.kind === 'missing') return plain(404, 'Not Found');

			const { locale, entry } = located;
			const site = entry.site;
			const bundle = bundleFor(site);
			if (!bundle.ok) return plain(500, bundle.message);

			const manifest = bundle.manifest;
			const source = manifest.sourceLocale;
			const missingObject = (key: string): Response =>
				plain(
					500,
					`The ${site.project} docs bundle for version "${bundle.label}" has no readable ${stored(key)}. Run hexdocs prefetch for this site, then rebuild.`,
				);

			if (entry.kind === 'llms') {
				const served = manifest.locales.includes(locale) ? locale : source;
				const key = llmsKey(served);
				const text = await readText(bundle.files, key);
				if (text === undefined) return missingObject(key);
				return machineText(resolveLinks(text, site, locale, bundle.bundleBase), PLAIN_TEXT, [
					served,
				]);
			}

			if (entry.kind === 'raw') {
				const record = manifest.pages[entry.slug];
				if (record === undefined) return plain(404, 'Not Found');
				const served = servedLocale(record, locale, source);
				const key = rawKey(served, entry.slug);
				const text = await readText(bundle.files, key);
				if (text === undefined) return missingObject(key);
				return machineText(resolveLinks(text, site, locale, bundle.bundleBase), MARKDOWN, [served]);
			}

			// `llms-full.txt` is not stored. It is the raw markdown of every page in
			// `llmsOrder`, hidden pages included because a hidden page is published, each in
			// the locale `servedLocale` picks, joined by one blank line. Every page opens with its
			// own `# Title`, so the join needs no separator of its own.
			const bodies: string[] = [];
			const languages = new Set<Locale>();
			for (const slug of manifest.llmsOrder) {
				const served = servedLocale(manifest.pages[slug] as PageRecord, locale, source);
				const key = rawKey(served, slug);
				const text = await readText(bundle.files, key);
				if (text === undefined) return missingObject(key);
				bodies.push(text.replace(/\n+$/, ''));
				languages.add(served);
			}
			const body = `${bodies.join('\n\n')}\n`;
			return machineText(
				resolveLinks(body, site, locale, bundle.bundleBase),
				PLAIN_TEXT,
				LOCALES.filter((one) => languages.has(one)),
			);
		},

		sitemap() {
			const routed = tablesOrError();
			if ('broken' in routed) throw plain(500, routed.broken);

			const rows: DocsSitemapRow[] = [];
			for (const site of sources.configs) {
				const bundle = bundleFor(site);
				if (!bundle.ok) throw plain(500, bundle.message);
				const hidden = new Set(site.hidden ?? []);
				for (const slug of site.pages) {
					const record = bundle.manifest.pages[slug];
					// A slug the config lists and the bundle lacks is a page `page()` answers
					// with a 404, so listing it would advertise one. `hexdocs prefetch` refuses
					// that skew before a build gets here.
					if (hidden.has(slug) || record === undefined) continue;
					const parsed = requireSlug(slug, 'sitemap');
					const path = slugToPath(parsed);
					rows.push({
						path: docsHref({ basePath: site.basePath, locale: SOURCE_LOCALE, slug }),
						// The docs home above a section root above a leaf, which is the shape
						// hex-web's own table uses for its section pages.
						priority: path === '' ? '0.8' : isSectionRoot(parsed) ? '0.7' : '0.6',
						changefreq: 'monthly',
						languages: indexableLanguages(record),
					});
				}
			}
			return rows.sort((a, b) => (a.path < b.path ? -1 : 1));
		},
	};
}
