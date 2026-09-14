/**
 * Slug to address, in one place.
 *
 * Every link the renderer emits, the sidebar's active-item test, the route rows a
 * consuming site declares, the lookup `docsServer` answers a request with and the sitemap
 * rows all go through here. A second spelling of any of them is a page that renders
 * perfectly at one address while the site advertises another.
 *
 * The rules themselves come from the estate and are not this package's to choose.
 * English is unprefixed and the other six carry `/<locale>` at the front of the path, in
 * the spelling `LOCALES` declares, so `pt-BR` keeps its capital letters. A pinned version
 * is `/v/<label>` immediately after the mount, which is why `v` is a reserved slug root.
 *
 * **No address ends in a slash**, a section root and the docs home included. Both
 * consumers' `normalise`, `localeUrl` and sitemap strip one trailing slash, and kcalc's
 * root loader 301s a slashed document URL, so the slashless form is the only one either
 * site can emit as a canonical. Step 5 gave section roots a trailing slash, and the docs
 * home, which is hex-nfc's only page, shipped with `noindex` and no alternates because the
 * host's path test normalised the slash away before comparing.
 *
 * The consequence is that a leaf `guide` and a section root `guide/index` are the same
 * address. The compiler refuses that pair by name, as an arm of `slug-reserved`, because
 * under slashless addresses they would also produce two route rows with one route id.
 */

import { SOURCE_LOCALE, type Locale } from '../contracts/locales.js';
import type { DocsSiteConfig } from '../contracts/site.js';
import { requireSlug, slugToPath, type ParsedSlug } from '../contracts/slug.js';

export interface DocsAddress {
	/** The mount, with a leading slash and no trailing one: `/hex-nfc/docs`. */
	basePath: string;
	locale: Locale;
	/** A version label, for a pinned address. Absent is the default version. */
	version?: string;
	/** A heading id or alias within the target page. */
	anchor?: string;
}

/** `''` for English, `/<locale>` for the other six. */
function localePrefix(locale: Locale): string {
	return locale === SOURCE_LOCALE ? '' : `/${locale}`;
}

/**
 * The path for one parsed slug.
 *
 * The join is written once, without a tidy-up pass over the result. A regex that
 * collapses repeated slashes afterwards hides the case it was added for, and the case
 * here is real: the docs home's path is the empty string, so an unconditional
 * `${base}/${path}` gives `/hex-nfc/docs/` for the home.
 */
export function docsHrefFor(slug: ParsedSlug, address: DocsAddress): string {
	const version = address.version === undefined ? '' : `/v/${address.version}`;
	const path = slugToPath(slug);
	const tail = path === '' ? '' : `/${path}`;
	const anchor = address.anchor === undefined ? '' : `#${address.anchor}`;
	return `${localePrefix(address.locale)}${address.basePath}${version}${tail}${anchor}`;
}

/**
 * The path for one address, given a slug in wire form.
 *
 * Refuses a slug it cannot parse rather than emitting a plausible wrong address, because
 * every caller is either building a link the reader will click or building a route row.
 * Both fail invisibly if this guesses.
 */
export function docsHref(address: DocsAddress & { slug: string }): string {
	return docsHrefFor(requireSlug(address.slug, 'docsHref'), address);
}

/**
 * The address a page's raw markdown is served at: `<locale prefix><basePath>/<wire slug>.md`.
 *
 * The wire slug rather than the address path, so the home is `index.md` and a section
 * root is `guide/index.md`. That is the spelling `llms.txt` links with, relative to its
 * own address, and the one the raw tree in a bundle is keyed by, so one rule answers the
 * route row, the lookup and the link. The address path would make the home `.md` with
 * nothing in front of the dot.
 *
 * There is no version and no anchor. A pinned version has no routes at all in this step,
 * and a markdown response has nothing to scroll to.
 */
export function docsRawHref(address: { basePath: string; locale: Locale; slug: string }): string {
	requireSlug(address.slug, 'docsRawHref');
	return `${localePrefix(address.locale)}${address.basePath}/${address.slug}.md`;
}

/**
 * A URL for one object in a prefetched bundle.
 *
 * The key comes from the manifest's own `assetKey`, `searchKey` and `rawKey`, so the
 * publisher and the renderer cannot grow two spellings of the same object path. One base
 * rather than one per kind, for the same reason: two bases is two things to get right per
 * install, and one of them is always the one that is wrong.
 *
 * The `.gz` suffix is dropped. Objects are stored gzipped in the bundle and `hexdocs
 * prefetch` writes them decompressed into the site's own `public/`, because a static file
 * server hands a `.gz` file to the browser with no `Content-Encoding` and the browser
 * shows a page of binary.
 */
export function bundleUrl(bundleBase: string, key: string): string {
	const base = bundleBase.endsWith('/') ? bundleBase.slice(0, -1) : bundleBase;
	const trimmed = key.endsWith('.gz') ? key.slice(0, -'.gz'.length) : key;
	return `${base}/${trimmed}`;
}

// ---------------------------------------------------------------------------
// What a consuming site derives from its docs configs
// ---------------------------------------------------------------------------

/** The two route modules a consuming site holds. Their loaders are one line each. */
export const DOCS_PAGE_MODULE = 'routes/docs.tsx';
export const DOCS_MACHINE_MODULE = 'routes/docs.machine.tsx';

/**
 * One route a consuming site has to declare.
 *
 * `page` mounts at both the bare and the `:lang` mounts, like every other page, through
 * the site's own page registry, which gives each mount's row its own id prefix. It carries
 * no id of its own on purpose: measured against hex-web's table, a per-row page id used at
 * both mounts collides with itself, and React Router refuses the whole route config.
 *
 * `machine` mounts **top level**, beside `robots.txt` and `sitemap.xml`, and carries the
 * language as a segment the route validates itself. A leaf match with no default export is
 * dispatched to `queryRoute`, which runs that one route's loader and no parent's, so a
 * machine endpoint answers `GET /banana/hex-nfc/docs/llms.txt` unless its own loader says
 * otherwise. Every machine row shares one module file, so it carries an `id`: without one,
 * React Router derives the id from the file and throws on the second row.
 */
export interface DocsRouteRow {
	/** With a leading slash and no locale. The consumer slices the slash off. */
	readonly path: string;
	/** The route module, relative to the site's `app/` directory. */
	readonly file: typeof DOCS_PAGE_MODULE | typeof DOCS_MACHINE_MODULE;
	readonly kind: 'page' | 'machine';
	/** Present exactly on machine rows: `docs:<path>`. */
	readonly id?: string;
}

function machineRow(path: string): DocsRouteRow {
	return { path, file: DOCS_MACHINE_MODULE, kind: 'machine', id: `docs:${path}` };
}

/**
 * Every route row for a set of docs configs.
 *
 * Every row is a static path, so no two rows can tie in React Router's ranking and the
 * declaration order decides nothing. That was not true in step 5, whose `search.json` and
 * `*.md` rows were a tie and a pattern that matched only its own literal spelling; the
 * order is kept stable anyway, machine rows first, so a diff of the table is a diff of the
 * page set.
 *
 * Raw markdown is one static row per page per mount rather than a pattern. Measured
 * against the installed router: a splat swallows every mistyped page URL into the machine
 * module, and a parameter per depth routes `typo.md` there too, while a row per page
 * serves exactly the published addresses and leaves every other URL to the site's own
 * 404 page. The cost is two rows per page.
 *
 * A redirect source gets a page row at both mounts and no raw row. The page loader answers
 * it with a 301, and without the row it is a 404 at the router, which is the state step 5
 * shipped: `sync` removes a renamed slug from `pages`, so every inbound link to the old
 * name broke while the manifest said the redirect existed.
 *
 * Two configs at one `basePath` are not deduplicated. They produce the same route ids
 * twice, and React Router refuses the config naming the first of them, which is the loudest
 * place a configuration error can surface during a build.
 */
export function docsRouteRows(sites: readonly DocsSiteConfig[]): DocsRouteRow[] {
	const machine: DocsRouteRow[] = [];
	const pages: DocsRouteRow[] = [];

	for (const site of sites) {
		for (const leaf of ['llms.txt', 'llms-full.txt']) {
			machine.push(machineRow(`${site.basePath}/${leaf}`));
			machine.push(machineRow(`/:lang${site.basePath}/${leaf}`));
		}
		for (const slug of site.pages) {
			const raw = docsRawHref({ basePath: site.basePath, locale: SOURCE_LOCALE, slug });
			machine.push(machineRow(raw));
			machine.push(machineRow(`/:lang${raw}`));
		}
		for (const slug of [...site.pages, ...Object.keys(site.redirects ?? {})]) {
			pages.push({
				path: docsHref({ basePath: site.basePath, locale: SOURCE_LOCALE, slug }),
				file: DOCS_PAGE_MODULE,
				kind: 'page',
			});
		}
	}
	return [...machine, ...pages];
}

/**
 * A sitemap entry, in the shape hex-web's own `Entry` interface already uses, plus the
 * languages the entry exists in.
 *
 * `priority` and `changefreq` are strings because that file's are, and a number here
 * would be a cast at the one call site that consumes it. `languages` is what the host
 * iterates for both the `<loc>` loop and the alternates, so a page with no Spanish
 * translation, or with one that is only scaffolded, is neither listed nor named in
 * Spanish. `docsServer`'s `sitemap()` is the only writer, because the languages come from
 * the manifest and the site config alone cannot say.
 */
export interface DocsSitemapRow {
	readonly path: string;
	readonly priority: string;
	readonly changefreq: string;
	readonly languages: Locale[];
}
