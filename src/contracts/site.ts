/**
 * `<project>.docs.json`: one documented project, as the consuming website sees it.
 *
 * The other half of the pair. `docs/site/docs.json` lives in the app repository and
 * governs the content; this lives in the web repository and says where the content is
 * mounted, which commits are labelled and what the sidebar entry is called.
 *
 * It is the sole build input from which routes, `LOCALISED_PATHS`, the hreflang set,
 * the sitemap and the theme class are all derived. Nothing about a docs mount is
 * maintained by hand anywhere else in the consuming site, which is what makes
 * installing a second documentation site one file plus one spread.
 *
 * The schema is strict, and that is load-bearing rather than tidy. An earlier design
 * had this object carrying an origin URL, a CDN host, cache TTLs and a disk cache
 * path. Every one of those is now wrong, and a permissive schema is how one of them
 * gets added back by somebody debugging a cache miss at eleven at night.
 */

import type { LocalisedLabel } from './frontmatter.js';
import type { Locale } from './locales.js';

/** The `<project>.docs.json` format version. */
export const SITE_CONFIG_VERSION = 1;

/**
 * A version label. It is a URL segment under `/v/<label>/`, so it is short, safe and
 * case-sensitively stable.
 */
export const VERSION_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** A full commit sha, lower case. Abbreviations are refused: they collide eventually. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** `YYYY-MM-DD`. A date, not a timestamp: nobody needs the minute a version shipped. */
export const RELEASE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Lower case hex, 64 characters. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A labelled commit.
 *
 * Labelling is the throttle. A bundle exists for every commit on `main`, and none of
 * them is visible until somebody writes one of these, which is what stops every
 * typo fix becoming a version bump. It is also, deliberately, a commit to the web
 * repository, and therefore a deploy: that is why nothing needs to be fetched at
 * request time, because there is no state in which S3 has something the site should
 * be showing and no deploy has happened.
 */
export interface VersionEntry {
	label: string;
	/** 40 hex characters. hex-nfc has no git tags, so a sha is the only stable handle. */
	commit: string;
	released: string;
	/**
	 * Exactly one entry carries this. It is the version served at the unprefixed
	 * address, the only one in the sitemap, and the only one that is indexable.
	 */
	default?: true;
	/**
	 * sha256 of the bundle's `manifest.json`, as fetched.
	 *
	 * Written by `hexdocs sync` and checked by `hexdocs prefetch`. The manifest cannot
	 * carry its own digest, so the only place a pinned integrity value can live is
	 * downstream of it, here, in the repository that decided to trust that bundle.
	 */
	digest?: string;
}

export interface DocsSiteConfig {
	/** Accepted and ignored. A relative path into the submodule's emitted schemas. */
	$schema?: string;
	site: typeof SITE_CONFIG_VERSION;

	/** Joins to `docs.json`'s `project` and to the S3 key prefix. */
	project: string;

	/**
	 * Where the docs mount, with a leading slash and no trailing one, and no locale.
	 *
	 * `/hex-nfc/docs`. The locale prefix is added by the address builder, because
	 * English is unprefixed and the other six are not, and a `basePath` that already
	 * contained a locale would have to exist seven times.
	 */
	basePath: string;

	/**
	 * A class the consuming site already defines, applied to the docs shell so the
	 * page picks up that app's accent: `app-hex-nfc`.
	 *
	 * Absent is a supported state. A consumer with no design system gets the package's
	 * own defaults, which is the case that has to work for this to be reusable at all.
	 */
	themeClass?: string;

	/**
	 * The sidebar and header label, in all seven languages.
	 *
	 * It lives here rather than in the site's own locale files for a specific reason:
	 * `check-locales.mjs` compares all seven files key for key in both directions, so
	 * two chrome keys would be fourteen mandatory edits rather than none. Keeping the
	 * label here is what makes "installing docs needs no locale-file edits" true, and
	 * it takes the `docs_` chrome-key collision problem with it.
	 */
	navLabel: LocalisedLabel;

	/** Newest first. Exactly one carries `default`. */
	versions: VersionEntry[];

	/**
	 * Every page slug in the default version, written by `hexdocs sync`. Not
	 * hand-maintained.
	 *
	 * It has to be a build input because `root.tsx` renders the canonical link and all
	 * eight hreflang alternates as plain JSX above `<Meta />`, gated on
	 * `isLocalisedPath`, and React Router's `meta()` can append tags but never delete
	 * them. A slug list that only existed at runtime would put a self-referential
	 * canonical plus eight alternates pointing at eight 404s on every mistyped docs
	 * URL.
	 *
	 * Per-locale presence is not here. It is in the manifest, where the sitemap
	 * generator and the fallback-implies-noindex rule read it. This list answers "is
	 * this path ours", which is a question about the route table, not about
	 * translation.
	 */
	pages: string[];

	/**
	 * The subset of `pages` that `nav.json` marks hidden. Written by `hexdocs sync`.
	 *
	 * A hidden page is published, indexable and addressable, and stays out of the
	 * sidebar, out of prev and next, and out of the sitemap. Two of those three are
	 * decided by the renderer from the manifest, which carries `hidden` on its nav
	 * nodes. The sitemap is the one that is not: this file is the sole build input from
	 * which the consuming site derives its routes, `LOCALISED_PATHS`, the hreflang set
	 * and the sitemap, and with only `pages` it could not tell the two apart. The
	 * consumer would then have had to reach into the manifest for one field, which is a
	 * second build input for one boolean.
	 *
	 * So a slug in `pages` and absent here is sitemapped, and a slug in both is not.
	 * Every entry must also be in `pages`, which the schema enforces: a hidden page that
	 * was not published would be a page with no canonical and no address, and the
	 * hiding would be indistinguishable from a deletion.
	 *
	 * Absent means none, which is the ordinary case, and `hexdocs sync` omits the key
	 * rather than writing an empty array so an ordinary config carries no noise.
	 */
	hidden?: string[];
}

/**
 * What a docs route hands the renderer.
 *
 * Plain JSON and nothing else: no `Date`, no functions, no class instances. This
 * object crosses the SSR boundary and is rebuilt on the client, and anything
 * non-serialisable becomes a hydration mismatch that appears only on docs pages,
 * only in production, and only for the consumer who noticed.
 */
export interface DocsRouteVersion {
	/** What the reader is looking at. */
	label: string;
	/** True when the address carries `/v/<label>/`. */
	pinned: boolean;
	/** The default entry's label, for the "you are reading an old version" banner. */
	latest: string;
}

/**
 * Which notice to show, as a discriminated union rather than an optional string.
 *
 * Three states, three notices, three answers to whether the page is indexable. A
 * single `fallbackFrom?: string` could express at most one of them, and collapsing
 * stale into fallback would either suppress the stale notice or wrongly mark a real
 * translation as not indexable.
 */
export type DocsTranslationNotice =
	| { state: 'current' }
	| { state: 'stale'; sourceUpdated: string }
	/**
	 * `requested` is a `Locale`, not a string. It is the language the reader asked for and
	 * it is what names the language in the notice, so a widened type would put a cast at
	 * every reader and let a locale that was never normalised reach a lookup table that
	 * has no key for it.
	 */
	| { state: 'fallback'; requested: Locale };

export interface DocsSeo {
	/**
	 * False for a pinned version, and false when the page being served is the English
	 * fallback for a locale with no translation of its own.
	 *
	 * The fallback case fires on day one. hex-nfc's first bundle is English-only, so
	 * without this every page ships seven URLs of byte-identical English, each
	 * self-canonicalising and each declaring the other six as alternates, which is the
	 * duplicate-content pattern that drags a whole group's signals down rather than
	 * just wasting a crawl.
	 */
	indexable: boolean;
}
