/**
 * Slug to address, in one place.
 *
 * Four things have to agree about what a docs URL looks like: every link the renderer
 * emits, the sidebar's active-item test, the canonical and `hreflang` set the consuming
 * site's `root.tsx` writes, and the `LOCALISED_PATHS` array that decides whether a path
 * is a docs path at all. The last two are the reason this is exported rather than kept
 * inside the renderer.
 *
 * `isLocalisedPath` in both consumers is an exact-string membership test over a flat
 * array, and it decides the canonical link, all eight alternates, the `noindex` and a
 * cookie-driven language redirect. So a consumer deriving that array with its own loop
 * would be deciding the section-root trailing slash a second time, and the failure of a
 * disagreement is not a broken link: it is a page that renders perfectly with a
 * self-referential canonical and eight alternates pointing at eight 404s. That is why
 * `docsLocalisedPaths` exists and why the address test asserts the two agree.
 *
 * The rules themselves come from the estate and are not this package's to choose.
 * English is unprefixed and the other six carry `/<locale>` at the front of the path, in
 * the spelling `LOCALES` declares, so `pt-BR` keeps its capital letters. A pinned version
 * is `/v/<label>` immediately after the mount, which is why `v` is a reserved slug root.
 * A section root is served with a trailing slash and a leaf without one.
 */

import { SOURCE_LOCALE, type Locale } from '../contracts/locales.js';
import type { DocsSiteConfig } from '../contracts/site.js';
import { isSectionRoot, requireSlug, slugToPath, type ParsedSlug } from '../contracts/slug.js';

export interface DocsAddress {
	/** The mount, with a leading slash and no trailing one: `/hex-nfc/docs`. */
	basePath: string;
	locale: Locale;
	/** A version label, for a pinned address. Absent is the default version. */
	version?: string;
	/** A heading id or alias within the target page. */
	anchor?: string;
}

/**
 * The path for one parsed slug.
 *
 * The join is written once, without a tidy-up pass over the result. A regex that
 * collapses repeated slashes afterwards hides the case it was added for, and the case
 * here is real: the docs home is a section root whose path is the empty string, so an
 * unconditional `${base}/${path}` gives `/hex-nfc/docs/` for the home and
 * `/hex-nfc/docs//guide/` for nothing at all.
 */
export function docsHrefFor(slug: ParsedSlug, address: DocsAddress): string {
	const prefix = address.locale === SOURCE_LOCALE ? '' : `/${address.locale}`;
	const version = address.version === undefined ? '' : `/v/${address.version}`;
	const path = slugToPath(slug);
	const tail = path === '' ? '/' : isSectionRoot(slug) ? `/${path}/` : `/${path}`;
	const anchor = address.anchor === undefined ? '' : `#${address.anchor}`;
	return `${prefix}${address.basePath}${version}${tail}${anchor}`;
}

/**
 * The path for one address, given a slug in wire form.
 *
 * Refuses a slug it cannot parse rather than emitting a plausible wrong address, because
 * every caller is either building a link the reader will click or building the array that
 * decides whether a URL is ours. Both fail invisibly if this guesses.
 */
export function docsHref(address: DocsAddress & { slug: string }): string {
	return docsHrefFor(requireSlug(address.slug, 'docsHref'), address);
}

/**
 * Every bare path this site config claims, for the consumer's `LOCALISED_PATHS`.
 *
 * Unprefixed and unpinned, which is the form that array holds: the locale prefix is
 * stripped before the membership test and a pinned address is not localised. Sorted, so
 * the generated array is stable across runs and a diff of it is a diff of the page set.
 */
export function docsLocalisedPaths(site: DocsSiteConfig): string[] {
	return site.pages
		.map((slug) => docsHref({ basePath: site.basePath, locale: SOURCE_LOCALE, slug }))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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

/**
 * One route a consuming site has to declare.
 *
 * `page` mounts at both the bare and the `:lang` mounts, like every other page.
 * `machine` mounts **top level**, beside `robots.txt` and `sitemap.xml`, carrying the
 * language as a segment the route validates itself. Two verified reasons, both of which
 * cost real effort to establish: a leaf match with no default export is dispatched to
 * `queryRoute`, which runs that one route's loader and no parent's, so a machine endpoint
 * mounted under `:lang` answers `GET /banana/hex-nfc/docs/llms.txt` with a 200; and
 * `preferredLanguageRedirect` cookie-redirects any bare path `isLocalisedPath` accepts.
 */
export interface DocsRouteRow {
	/** With a leading slash and no locale. The consumer slices the slash off. */
	readonly path: string;
	/** The route module, relative to the site's `app/` directory. */
	readonly file: string;
	readonly kind: 'page' | 'machine';
}

/**
 * The machine endpoints, per site and per locale.
 *
 * Three leaves and not one per page. A `.md` route per slug would be roughly a hundred
 * and thirty entries in a `routes.ts` that is ninety-five lines of which about half is
 * comment, for a table React Router matches linearly; one dynamic route with the slug as
 * a parameter answers the same addresses. The trade is that the route validates the slug
 * itself instead of the table doing it, which it has to do anyway: it also validates the
 * language, because no parent loader runs for it.
 */
const MACHINE_LEAVES = ['llms.txt', 'llms-full.txt', 'search.json'] as const;

/**
 * Every route row for a set of docs configs, in declaration order.
 *
 * **Order is the contract.** Two ties break on it and both were probed against the
 * installed React Router 7.12 rather than reasoned about. `:slug.json` fails the
 * `/^:[\w-]+$/` test, so it scores as a static segment and ties with `search.json`;
 * declaring the dynamic one first makes `/…/search.json` resolve to it with
 * `{slug: "search"}`. So every static-suffix pattern is emitted before any `:slug.*`
 * pattern, here, once, for every consumer, rather than in a comment each of them has to
 * honour.
 */
export function docsRouteRows(sites: readonly DocsSiteConfig[]): DocsRouteRow[] {
	const machine: DocsRouteRow[] = [];
	const dynamic: DocsRouteRow[] = [];
	const pages: DocsRouteRow[] = [];

	for (const site of sites) {
		for (const leaf of MACHINE_LEAVES) {
			machine.push({
				path: `${site.basePath}/${leaf}`,
				file: 'routes/docs.machine.tsx',
				kind: 'machine',
			});
			machine.push({
				path: `/:lang${site.basePath}/${leaf}`,
				file: 'routes/docs.machine.tsx',
				kind: 'machine',
			});
		}
		// The raw markdown tree. Declared after every static suffix above and before the
		// page rows, which is the whole ordering rule in one place.
		dynamic.push({
			path: `${site.basePath}/*.md`,
			file: 'routes/docs.raw.tsx',
			kind: 'machine',
		});
		dynamic.push({
			path: `/:lang${site.basePath}/*.md`,
			file: 'routes/docs.raw.tsx',
			kind: 'machine',
		});

		for (const slug of site.pages) {
			pages.push({
				path: docsHref({ basePath: site.basePath, locale: SOURCE_LOCALE, slug }),
				file: 'routes/docs.tsx',
				kind: 'page',
			});
		}
	}
	return [...machine, ...dynamic, ...pages];
}

/**
 * Every bare path a set of docs configs claims, for `LOCALISED_PATHS`.
 *
 * The multi-site form of `docsLocalisedPaths`, and it exists because both consumers glob
 * `app/docs/*.docs.json`: adding a second documented project to one site has to be one
 * JSON file and no code edit, or the claim that installing docs is one config file stops
 * being true on the second install.
 *
 * Duplicates are removed rather than refused. Two sites with the same `basePath` is a
 * configuration error, but it is one `install` and `verify-install` report on with the
 * file names in hand; a throw from an address builder during a consumer's build names
 * neither file.
 */
export function docsLocalisedPathsFor(sites: readonly DocsSiteConfig[]): string[] {
	const seen = new Set<string>();
	for (const site of sites) for (const path of docsLocalisedPaths(site)) seen.add(path);
	return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * A sitemap entry, in the shape hex-web's own `Entry` interface already uses.
 *
 * `priority` and `changefreq` are strings because that file's are, and a number here
 * would be a cast at the one call site that consumes it.
 */
export interface DocsSitemapRow {
	readonly path: string;
	readonly priority: string;
	readonly changefreq: string;
}

/**
 * The sitemap rows, with hidden pages excluded.
 *
 * The one place the `hidden` list is read. `nav.ts` promises a hidden page stays out of
 * the sidebar, out of prev and next, and out of the sitemap while remaining published
 * and indexable, and the first two are the renderer's job from the manifest. This is the
 * third, and it is why the site config carries the list at all: a hand-listed docs
 * spread in a consumer's sitemap cannot know which pages are hidden, so it advertises
 * them.
 *
 * A section root is weighted above a leaf, which is the same shape hex-web's own table
 * uses for its section pages, and the docs home above both.
 */
export function docsSitemapRows(sites: readonly DocsSiteConfig[]): DocsSitemapRow[] {
	const rows: DocsSitemapRow[] = [];
	for (const site of sites) {
		const hidden = new Set(site.hidden ?? []);
		for (const slug of site.pages) {
			if (hidden.has(slug)) continue;
			const parsed = requireSlug(slug, 'docsSitemapRows');
			const path = docsHrefFor(parsed, { basePath: site.basePath, locale: SOURCE_LOCALE });
			rows.push({
				path,
				priority: slugToPath(parsed) === '' ? '0.8' : isSectionRoot(parsed) ? '0.7' : '0.6',
				changefreq: 'monthly',
			});
		}
	}
	return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
