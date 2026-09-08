/**
 * The bundle manifest, and the key layout it describes.
 *
 * One rule governs every field here: **the manifest must be byte-reproducible from
 * the commit alone.** Publishing the same sha twice has to write identical bytes,
 * because the write-once refusal is unconditional and a build that changed nothing
 * must not look like a rewrite. That is why there is no `builtAt`, no runner
 * identity, no timing and no lint counts, why every list is sorted by a stated key,
 * and why locales are in tuple order rather than alphabetical order.
 *
 * Reproducibility needs one more thing the field list cannot express: **every object
 * in this file is serialised with its keys in code point order, by one named
 * serialiser.** That covers `pages`, `redirects`, `search`, `llms`, `coverage` and
 * every `PageRecord.locales`, and it is why none of them declares a key order of its
 * own. `validateManifestShape` checks the orders that are not key orders at all, the
 * locale tuple order and the sorts on `assets` and `objects`, and re-checks the `pages`
 * key order as well: that one decides which page wins a duplicate slug, so it is worth
 * catching without the serialiser in the loop. When the serialiser lands, the rest
 * become its responsibility and this sentence changes with it.
 *
 * The second rule is that nothing may need a page payload to answer a question about
 * the bundle. `hexdocs prefetch` decides what to download, `hexdocs diff` compares two
 * labels, `propose_label` prints a coverage table, and `hexdocs verify` asserts the
 * key set in the bucket. None of them may parse fourteen hundred page files to do it,
 * which is why the flat `objects` and `assets` lists are mandatory rather than
 * redundant.
 */

import { AST_VERSION, type AstVersion } from './ast.js';
import { sortLocales } from './locales.js';
import type { Audience, TranslationState } from './frontmatter.js';
import type { HeadingDepth } from './ast.js';
import type { Locale } from './locales.js';

/** The manifest's own shape version. Separate from the AST major, on purpose. */
export const MANIFEST_VERSION = 1;

/**
 * ISO 8601, UTC, second precision: `2026-09-07T04:11:52Z`.
 *
 * `git log --format=%cI` emits a local offset, so two runners in two timezones would
 * write different bytes for the same commit. Normalising to `Z` is part of the
 * contract, not a formatting preference.
 */
export const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Image formats a bundle may carry, in their canonical spelling.
 *
 * `svg` carries an obligation the raster formats do not, and it is worth stating
 * plainly because the reasoning that admitted it only considered half the picture.
 * Inside `<img>` an SVG cannot run script, which is true and is how the renderer uses
 * it. But `hexdocs prefetch` copies assets into the consuming site's `public/`, Vite
 * copies that into `build/client/`, and the result is a directly navigable same-origin
 * URL. Navigated to, that file is a document served as `image/svg+xml`, and any
 * `<script>` or `on*` handler in it runs in the site's own origin.
 *
 * So a vector asset is parsed at publish time and refused unless it is free of
 * `script`, `foreignObject`, `<a href>`, external references and every `on*`
 * attribute. The rule id is `asset-svg-unsafe`, it is a protected rule, and it is the
 * thing to grep for when a diagram is rejected.
 *
 * It stays in the list rather than being dropped because mermaid and math are both
 * deferred to `ast-2`, so a committed SVG is currently the only way to put a diagram
 * on a page.
 */
export const ASSET_EXTENSIONS = ['png', 'jpg', 'webp', 'avif', 'svg'] as const;

export type AssetExtension = (typeof ASSET_EXTENSIONS)[number];

/**
 * How the colour space was determined.
 *
 * `vector` is SVG, where the question does not arise. The other three come from
 * reading the file: a PNG `cICP` chunk, an embedded ICC profile, or neither.
 * ImageMagick cannot read `cICP` at all, reports `sRGB` regardless, and silently
 * no-ops a `-profile` conversion, which is why the probe is named in the record: it
 * says which reader answered.
 */
export const COLOUR_PROBES = ['cicp', 'iccp', 'untagged', 'vector'] as const;

export type ColourProbe = (typeof COLOUR_PROBES)[number];

export interface AssetRecord {
	/** Content hash. Also the filename: `assets/<sha256>.<ext>`. */
	sha256: string;
	/**
	 * Sniffed from the bytes, never taken from the filename.
	 *
	 * A `.png` that is really a JPEG would otherwise be served as `image/png` by the
	 * static file server the prefetch copies it into, and a non-canonical spelling
	 * (`jpeg`, `JPG`) would give one file two keys and break write-once.
	 */
	ext: AssetExtension;
	bytes: number;
	/**
	 * Both required. The renderer has to set an intrinsic size or every page with an
	 * image reflows as it loads, and there is no runtime image library to ask. A file
	 * whose dimensions cannot be read is a publish error.
	 */
	width: number;
	height: number;
	/**
	 * Always sRGB in a published bundle.
	 *
	 * A Display P3 asset is **refused**, not converted. Converting during the build
	 * would make the same source file hash differently on a different runner, because
	 * ffmpeg output varies by build, and the content hash is the key. Refusing puts the
	 * conversion in the author's hands, once, where it can be checked by measuring
	 * saturation rather than by looking at it on a wide-gamut display.
	 */
	colour: { space: 'srgb'; probe: ColourProbe };
	/**
	 * Base64 of a 20 by 20 webp, with no `data:` prefix. `null` for vector assets and
	 * for anything too small to be worth it.
	 *
	 * Stored bare so the URI is constructed in exactly one place in the renderer. CSP
	 * is `img-src 'self' blob: data:`, so the data URI itself is legal.
	 */
	lqip: string | null;
}

export interface HeadingRecord {
	id: string;
	depth: HeadingDepth;
}

export interface PageLocaleRecord {
	/** sha256 over the uncompressed canonical JSON of the page payload. */
	digest: string;
	/** Uncompressed length of that JSON. */
	bytes: number;
	/** sha256 over the markdown bytes served at `<slug>.md` for this locale. */
	rawDigest: string;
	rawBytes: number;
	/** NFC-normalised. */
	title: string;
	/**
	 * The shorter sidebar label, when the page carries one.
	 *
	 * Here because the sidebar is built from this manifest and nowhere else: the bundle
	 * has no `nav.json`, and the compiled page payload is only ever loaded for the page
	 * the reader is on. Without it, the one field whose whole purpose is the sidebar was
	 * a field the sidebar could not see.
	 */
	navTitle?: string;
	description: string;
	/** From `git log -1 --format=%cI` on this file, normalised to UTC. */
	updatedAt: string;
	/**
	 * The one translation fact that is stored rather than derived.
	 *
	 * `stale` on its own would be storable and is not stored: it is
	 * `updatedAt < sourceUpdatedAt`, one comparison over two fields already here. But
	 * `scaffolded` cannot be derived from timestamps at all, which is the whole reason
	 * it exists, so the state is recorded and the comparison is not.
	 *
	 * This is the page's **own** state, and `coverage` counts it. The effective state, the
	 * worst of the page and every snippet it transcludes, is on the compiled page where
	 * the reader's notice reads it. Two numbers because there are two questions: a
	 * translator asks which files to open, and a reader asks whether to trust the words in
	 * front of them, and a page whose only stale part is a shared fragment answers those
	 * differently. `TranslationRecord.state` in `frontmatter.ts` is the other half.
	 */
	state: TranslationState;
	words: number;
	/**
	 * Every heading, in document order.
	 *
	 * A count would be cheaper and would not do the job. Heading parity is graded: an
	 * error when the translation is current, and a warning **naming the drifted
	 * headings** when it is already stale. A number cannot name anything, and
	 * downloading every page payload in seven locales to grade parity is exactly what
	 * the manifest exists to avoid.
	 */
	headings: HeadingRecord[];
}

export interface PageRecord {
	/** Page-level, not per locale. */
	audience: Audience;
	/** Semantic version, or `null`. */
	since: string | null;
	/**
	 * Keyed by locale. An absent key means the page does not exist in that locale.
	 *
	 * There is exactly one reading of an absent key, and `locales` at the top of the
	 * manifest is what makes that true: it is the authority on which languages the
	 * bundle contains at all, and `validateManifestShape` asserts that every page's
	 * keys are a subset of it. Without that cross-check, absent would mean two things
	 * and three consumers would pick differently.
	 *
	 * The alternative, every locale present with an explicit `null`, was rejected on
	 * the day-one case: hex-nfc's first bundle is English-only, so a sixty-page manual
	 * would carry three hundred and sixty null entries saying nothing. It also has a
	 * quiet benefit here, since `noUncheckedIndexedAccess` now forces a caller reading
	 * a locale to handle its absence, which is the case that produces a blank page.
	 */
	locales: Partial<Record<Locale, PageLocaleRecord>>;
}

/**
 * The nav, resolved: every page in reading order, flat.
 *
 * No inline titles: `nav.json` is language-neutral and titles come from each locale's
 * front matter, which this manifest already carries per page per locale. Inlining
 * seven locales of title here would be a derived field with nothing checking it
 * against the pages it was derived from.
 *
 * Flat, and it used to carry a `children` array that nothing ever wrote. It could not
 * have been right: a `nav.json` group is not a page, so the compiler flattens it, and a
 * group holding two pages from different sections is a shape no slug hierarchy can
 * express. The renderer derives its sidebar nesting from the slugs themselves, where a
 * section root is a real page with a real translated title, and a field with no writer
 * and no reader is worse than no field because the next person builds on it.
 */
export interface ManifestNavNode {
	slug: string;
	/**
	 * Present when `nav.json` marks this page hidden.
	 *
	 * Without it the reader cannot honour what `nav.ts` promises, which is that a hidden
	 * page stays out of the sidebar, the sitemap and prev/next while remaining published
	 * and indexable. The reason the page is hidden stays in `nav.json`, because it is for
	 * whoever has to explain the decision in a year and not for the renderer.
	 *
	 * The page stays in this array rather than being removed from it, so `nav` remains
	 * the answer to "what order are the pages in" and `llmsOrder` and this list continue
	 * to agree. A hidden page is published, so it belongs in `llms-full.txt`.
	 */
	hidden?: true;
}

export interface SearchIndexRecord {
	digest: string;
	bytes: number;
	/** Section-level records in the index. Compared against a floor and a ceiling. */
	records: number;
	/** Distinct terms. A collapse here is how a tokeniser regression shows up. */
	terms: number;
}

export interface ObjectRecord {
	/** Relative to the `ast-N` prefix: `pages/ja/guide/first-tag.json.gz`. */
	key: string;
	/** sha256 of the bytes as stored, gzip included. This is what S3 holds. */
	digest: string;
	/** Stored length, gzip included. The same bytes `digest` covers. */
	bytes: number;
}

/**
 * The gzip member every compressed object must be written as. A specification for a
 * writer that does not exist yet, not an options bag.
 *
 * Gzip output is not a function of its input alone, and the digest above is taken over
 * the stored bytes, so the member has to be pinned or the same commit produces
 * different objects on two machines and the write-once refusal fires on a re-run that
 * changed nothing.
 *
 * Only `level` is a zlib option. Measured on Node 22.22, and pinned by
 * `test/contracts/manifest.test.ts`: `zlib.gzipSync(buf, { level, mtime, os })` and
 * `zlib.gzipSync(buf, { level })` return byte-identical output, because node's zlib has
 * no `os` or `mtime` option and silently ignores both. It writes byte 9 from the
 * platform it was compiled on, 19 on macOS and 3 on Linux, so a member produced by
 * spreading this object into `gzipSync` carries exactly the host-dependent byte this
 * constant exists to remove.
 *
 * So the writer, when it lands, compresses with `level` and then patches byte 9 to
 * `os`. It does not need to write `mtime`: node already writes zeros into bytes 4 to 7,
 * and `filename: null` is already the default because `gzipSync` sets no FNAME flag.
 * Both are here so that the assertion exists and the test can measure them, rather than
 * being properties nothing states and a future writer has to rediscover.
 *
 * The claim is scoped to one zlib major; a deflate change across zlib versions would
 * need a re-publish, which is additive and safe because objects are commit-addressed.
 */
export const GZIP_SETTINGS = {
	/** The only member of this object that is a zlib option. */
	level: 9,
	/** Bytes 4 to 7. Node writes these already; the writer asserts rather than sets. */
	mtime: 0,
	/** Byte 9. 255 is "unknown", the only value that does not encode the build host. */
	os: 255,
	/** No FNAME field, so bit 3 of byte 3 stays clear and no local path is embedded. */
	filename: null,
} as const;

export interface BundleCounts {
	pages: number;
	locales: number;
	objects: number;
	/**
	 * Stored total across every object, gzip included: the sum of `objects[].bytes`.
	 *
	 * Stored rather than uncompressed, because that is the number `hexdocs prefetch`
	 * needs for a size budget and a truncated-download check, and it is the only one
	 * this file already carries per object and can therefore recompute.
	 */
	bytes: number;
}

/**
 * Every count here is derived from the page records, and every one is recomputed by
 * `validateManifestShape`. A derived field with nothing checking it against what it
 * was derived from is exactly what this file refuses elsewhere, in the comment on
 * `ManifestNavNode` explaining why nav titles are not inlined.
 */
export interface LocaleCoverage {
	/** Pages with a record in this locale, whatever its state. */
	pages: number;
	/** Of those, the ones in state `source` or `current`. */
	translated: number;
	/** Of those, the ones in state `stale`. */
	stale: number;
	/**
	 * Of those, the ones in state `scaffolded`: a file that exists and is still
	 * English. Counted separately because it is neither translated nor stale, and
	 * folding it into either is how a project reads as fully translated when six
	 * languages of it have never been touched.
	 */
	scaffolded: number;
}

export interface BundleManifest {
	manifest: typeof MANIFEST_VERSION;
	/**
	 * Must equal the `N` in the `ast-N` key segment this manifest was read from.
	 *
	 * The key is not trusted; the manifest self-declares and the reader compares. A
	 * manifest claiming 1 while sitting under `ast-2` would hand an older pinned
	 * runtime a payload shape it cannot render, and it would render most of it.
	 */
	ast: AstVersion;

	/** Must equal the `<project>` key segment and the consuming config's `project`. */
	project: string;
	/** 40 lower-case hex. Must equal the `<sha>` key segment. */
	commit: string;
	/** The commit's committer date. Deterministic, and what orders two labels. */
	commitTimestamp: string;

	/**
	 * `@hex-pro/docs-kit@<exact version>`.
	 *
	 * The only build-identity field that survives, because it is the one that makes
	 * "the toolchain changed under a published sha" an actionable message rather than a
	 * mystery diff. It is deterministic per checkout, which the others were not.
	 */
	generator: string;

	/** Non-empty, unique, in `LOCALES` tuple order rather than alphabetical. */
	locales: Locale[];
	/** A member of `locales`. Every fallback and every staleness comparison uses it. */
	sourceLocale: Locale;

	/** Keyed by slug, keys sorted by code point. */
	pages: Record<string, PageRecord>;
	nav: ManifestNavNode[];
	/**
	 * Old slug to current slug. Every value is a key of `pages`; no key is also a key
	 * of `pages`; no cycles.
	 *
	 * It is also what lets `hexdocs diff` call a removed slug plus an added slug a
	 * rename rather than a deletion and an addition, which is the difference between a
	 * release note that says "renamed" and one that says a page was deleted.
	 */
	redirects: Record<string, string>;

	/**
	 * Sorted by `sha256`, one record per distinct digest.
	 *
	 * A walk of `docs/site/assets/`, not of the image references in the pages. This line
	 * used to say the opposite, which is a claim a consumer could reasonably build on: an
	 * author who deletes the last reference to a diagram and leaves the file behind still
	 * gets a record and an object for it, and `hexdocs prefetch` still copies it into the
	 * consuming site's `public/` and therefore into the deployed image, on every deploy.
	 *
	 * The directory walk is the right behaviour and the reference walk would not be. An
	 * asset referenced only from a locale that failed to compile, or only from a page held
	 * back as a draft, would vanish from the bundle and take the reference with it. What is
	 * missing is a rule reporting the orphan, which is `ast-2` work: it needs the image
	 * nodes of every page in every locale collected during the compile, and a decision
	 * about whether an asset referenced only by a draft counts as referenced.
	 */
	assets: AssetRecord[];
	/** One entry for every locale in `locales`, and no others. Cross-checked. */
	search: Partial<Record<Locale, SearchIndexRecord>>;
	/** Per-locale `llms.txt`. One entry for every locale in `locales`. Cross-checked. */
	llms: Partial<Record<Locale, { digest: string; bytes: number }>>;
	/**
	 * Nav order, as the recipe for `llms-full.txt`.
	 *
	 * `llms-full` is not stored. It is the raw markdown of every page concatenated in
	 * this order, which the consumer already holds locally after a prefetch. Storing it
	 * would duplicate well over a megabyte per commit and let it drift from the pages
	 * it summarises; as a recipe, drift is not expressible.
	 */
	llmsOrder: string[];

	/**
	 * Every object under this prefix except `manifest.json`, sorted by key.
	 *
	 * `hexdocs verify` asserts that the actual key set in the bucket equals this
	 * exactly, which is how a stray object from an abandoned build or a missing object
	 * from a partial upload is caught. Neither is visible from the page records.
	 */
	objects: ObjectRecord[];

	counts: BundleCounts;
	/**
	 * One entry for every locale in `locales`, and no others, derived from the page
	 * records. Both the key set and every count are recomputed by
	 * `validateManifestShape`.
	 */
	coverage: Partial<Record<Locale, LocaleCoverage>>;
}

/**
 * The invariants a schema cannot express, checked in one place so every reader can
 * assume them afterwards.
 *
 * Returns a problem per violation rather than throwing on the first, because a
 * manifest that is wrong in four ways should say so once.
 */
/** `2026-09-07T12:00:00Z`, the one spelling `utcTimestampSchema` accepts. */
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function validateManifestShape(manifest: BundleManifest): string[] {
	const problems: string[] = [];
	const declared = new Set<string>(manifest.locales);

	if (!declared.has(manifest.sourceLocale)) {
		problems.push(
			`sourceLocale "${manifest.sourceLocale}" is not in locales [${manifest.locales.join(', ')}]. ` +
				`Every fallback and every staleness comparison resolves against it, so all of them would be undefined.`,
		);
	}

	for (const [field, record] of [
		['search', manifest.search],
		['llms', manifest.llms],
		['coverage', manifest.coverage],
	] as const) {
		const keys = Object.keys(record);
		for (const key of keys) {
			if (!declared.has(key))
				problems.push(`${field} has an entry for "${key}", which is not in locales.`);
		}
		for (const locale of manifest.locales) {
			if (!(locale in record))
				problems.push(`${field} is missing an entry for "${locale}", which is in locales.`);
		}
	}

	for (const [slug, page] of Object.entries(manifest.pages)) {
		for (const [key, record] of Object.entries(page.locales)) {
			if (!declared.has(key)) {
				problems.push(
					`pages["${slug}"].locales has an entry for "${key}", which is not in locales.`,
				);
			}
			// `missing` is how a page reports itself in a diagnostic, where every locale
			// is listed and one of them has nothing. In a manifest the absence of the key
			// is the statement, so a present record claiming `missing` is two answers to
			// the same question, and the coverage recount counts it as neither translated
			// nor stale nor scaffolded while still counting it in `pages`.
			if (record?.state === 'missing') {
				problems.push(
					`pages["${slug}"].locales.${key} has state "missing". A record that exists is not ` +
						`missing; absence of the key is how a manifest says a page has no ${key} translation.`,
				);
			}
			// The three fields whose schemas require content, checked here as well because
			// this function runs on every build and the schemas run in the toolchain's own
			// tests. A page whose front matter did not validate used to take an empty title
			// and an empty description, and a file the git walk had no date for took an empty
			// `updatedAt`. All three are refused by the bundle schemas, so the page compiled,
			// the manifest was written, and the failure arrived downstream as a digest
			// mismatch naming nothing. Named here, it names the page and the field.
			if (record !== undefined) {
				for (const [field, value] of [
					['title', record.title],
					['description', record.description],
				] as const) {
					if (value.trim() === '') {
						problems.push(
							`pages["${slug}"].locales.${key}.${field} is empty. The bundle schema requires ` +
								`content, so this page would be refused on read rather than here.`,
						);
					}
				}
				if (!UTC_TIMESTAMP.test(record.updatedAt)) {
					problems.push(
						`pages["${slug}"].locales.${key}.updatedAt is "${record.updatedAt}", which is not a ` +
							`UTC timestamp. Freshness is a comparison of these, so an unparseable one compares ` +
							`as neither newer nor older and the page reads current against everything.`,
					);
				}
			}
		}
	}

	for (const [from, to] of Object.entries(manifest.redirects)) {
		if (from in manifest.pages) {
			problems.push(
				`redirects has "${from}" as a source, but a live page has that slug. It would shadow the page.`,
			);
		}
		if (!(to in manifest.pages)) {
			problems.push(`redirects sends "${from}" to "${to}", which is not a page in this bundle.`);
		}
	}

	// Every other place a slug appears must name a page that exists. A nav entry or an
	// llms.txt line pointing at a slug the bundle does not carry renders as a link to
	// nothing, and the reader is the one who finds out.
	for (const slug of manifest.nav.map((node) => node.slug)) {
		if (!(slug in manifest.pages))
			problems.push(`nav names "${slug}", which is not a page in this bundle.`);
	}
	for (const slug of manifest.llmsOrder) {
		if (!(slug in manifest.pages)) {
			problems.push(`llmsOrder names "${slug}", which is not a page in this bundle.`);
		}
	}

	// ---- the orders the file header claims ---------------------------------

	const sortedLocales = sortLocales(manifest.locales);
	if (manifest.locales.join(',') !== sortedLocales.join(',')) {
		problems.push(
			`locales is [${manifest.locales.join(', ')}]; canonical order is [${sortedLocales.join(', ')}]. ` +
				`Two builders in different orders write different bytes for identical content.`,
		);
	}

	const pageKeys = Object.keys(manifest.pages);
	const sortedKeys = [...pageKeys].sort();
	if (pageKeys.join('\u0000') !== sortedKeys.join('\u0000')) {
		problems.push('pages keys are not in code point order.');
	}

	const assetIds = manifest.assets.map((asset) => asset.sha256);
	if (assetIds.join(',') !== [...assetIds].sort().join(',')) {
		problems.push('assets is not sorted by sha256.');
	}
	if (new Set(assetIds).size !== assetIds.length) {
		problems.push('assets contains the same sha256 twice. One file would have two records.');
	}

	const objectKeys = manifest.objects.map((object) => object.key);
	if (objectKeys.join('\u0000') !== [...objectKeys].sort().join('\u0000')) {
		problems.push('objects is not sorted by key.');
	}
	if (new Set(objectKeys).size !== objectKeys.length) {
		problems.push('objects lists the same key twice.');
	}

	// ---- the derived fields ------------------------------------------------

	const expectedCounts: BundleCounts = {
		pages: pageKeys.length,
		locales: manifest.locales.length,
		objects: manifest.objects.length,
		bytes: manifest.objects.reduce((total, object) => total + object.bytes, 0),
	};
	for (const key of Object.keys(expectedCounts) as (keyof BundleCounts)[]) {
		if (manifest.counts[key] !== expectedCounts[key]) {
			problems.push(
				`counts.${key} is ${manifest.counts[key]}; recounting gives ${expectedCounts[key]}.`,
			);
		}
	}

	for (const locale of manifest.locales) {
		const declared = manifest.coverage[locale];
		if (declared === undefined) continue;
		const records = Object.values(manifest.pages)
			.map((page) => page.locales[locale])
			.filter((record): record is PageLocaleRecord => record !== undefined);
		const expected: LocaleCoverage = {
			pages: records.length,
			translated: records.filter((r) => r.state === 'source' || r.state === 'current').length,
			stale: records.filter((r) => r.state === 'stale').length,
			scaffolded: records.filter((r) => r.state === 'scaffolded').length,
		};
		for (const key of Object.keys(expected) as (keyof LocaleCoverage)[]) {
			if (declared[key] !== expected[key]) {
				problems.push(
					`coverage.${locale}.${key} is ${declared[key]}; recounting the page records gives ${expected[key]}.`,
				);
			}
		}
	}

	return problems;
}

// ---------------------------------------------------------------------------
// The key layout
// ---------------------------------------------------------------------------

/**
 * `<project>/<sha>/ast-<major>`.
 *
 * The `ast-N` segment is the entire write-once mechanism. Recompiling an old commit
 * at a new AST major adds objects beside the old ones and overwrites none, so an
 * older pinned runtime keeps reading exactly the bundle it was built against, and
 * "this key already exists with different bytes" becomes an unconditional refusal
 * with no legitimate exception to reason about.
 */
export function bundlePrefix(project: string, commit: string, ast: number = AST_VERSION): string {
	return `${project}/${commit}/ast-${ast}`;
}

export const MANIFEST_KEY = 'manifest.json';

export function pageKey(locale: Locale, slug: string): string {
	return `pages/${locale}/${slug}.json.gz`;
}

export function rawKey(locale: Locale, slug: string): string {
	return `raw/${locale}/${slug}.md.gz`;
}

export function searchKey(locale: Locale): string {
	return `search/${locale}.idx.json.gz`;
}

export function llmsKey(locale: Locale): string {
	return `llms/${locale}.txt`;
}

export function assetKey(sha256: string, ext: AssetExtension): string {
	return `assets/${sha256}.${ext}`;
}

/**
 * Objects stored gzipped, and therefore served with `Content-Encoding: gzip`.
 *
 * `llms/<locale>.txt` is not among them: it is fetched by tools that may not
 * negotiate encoding, and it is small.
 */
export function isGzipped(key: string): boolean {
	return key.endsWith('.gz');
}
