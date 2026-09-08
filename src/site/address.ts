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
