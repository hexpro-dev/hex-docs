/**
 * Zod mirrors of the three things a bundle contains: a compiled page, the manifest,
 * and a per-locale search index.
 *
 * Nothing here is written by a human, so these schemas are not about catching typos.
 * They are the assertion that the compiler produced what the runtime expects, run
 * before an object is uploaded and again by `hexdocs prefetch` before one is written
 * into a website's build tree. That is the only place a corrupted or mismatched bundle
 * can be caught, because after that it is a static file and nothing validates it
 * again.
 */

import { z } from 'zod';

import { AST_VERSION } from '../../../src/contracts/ast.js';
import { AUDIENCES, PAGE_KINDS } from '../../../src/contracts/frontmatter.js';
import {
	ASSET_EXTENSIONS,
	COLOUR_PROBES,
	MANIFEST_VERSION,
} from '../../../src/contracts/manifest.js';
import type {
	AssetRecord,
	BundleCounts,
	BundleManifest,
	HeadingRecord,
	LocaleCoverage,
	ManifestNavNode,
	ObjectRecord,
	PageLocaleRecord,
	PageRecord,
	SearchIndexRecord,
} from '../../../src/contracts/manifest.js';
import { TRANSLATION_STATES } from '../../../src/contracts/frontmatter.js';
import type { CompiledPage, PageHeading, ReadingEstimate } from '../../../src/contracts/page.js';
import {
	INDEXED_TRANSLATION_STATES,
	MATCH_MODES,
	NORMALISATION_FORMS,
	SEARCH_FIELDS,
	SEARCH_INDEX_KIND,
	SEARCH_INDEX_VERSION,
	TOKENISER_VERSION,
} from '../../../src/contracts/search.js';
import type { SearchDoc, SearchIndex, SearchPostings } from '../../../src/contracts/search.js';
import { blockSchema } from './ast.schema.js';
import { translationRecordSchema } from './config.schema.js';
import {
	commitShaSchema,
	countSchema,
	localeSchema,
	positiveIntSchema,
	projectIdSchema,
	semverSchema,
	sha256Schema,
	slugSchema,
	utcTimestampSchema,
} from './primitives.js';

const headingDepthSchema = z.union([
	z.literal(2),
	z.literal(3),
	z.literal(4),
	z.literal(5),
	z.literal(6),
]);

// ---------------------------------------------------------------------------
// A compiled page
// ---------------------------------------------------------------------------

export const pageHeadingSchema = z.strictObject({
	id: z.string().min(1),
	depth: headingDepthSchema,
	text: z.string(),
});

export const readingEstimateSchema = z.strictObject({
	words: countSchema,
	minutes: positiveIntSchema,
});

export const compiledPageSchema = z.strictObject({
	ast: z.literal(AST_VERSION),
	project: projectIdSchema,
	slug: slugSchema,
	locale: localeSchema,
	title: z.string().min(1),
	description: z.string().min(1),
	navTitle: z.string().min(1).optional(),
	audience: z.enum(AUDIENCES),
	pageKind: z.enum(PAGE_KINDS),
	tags: z.array(z.string().min(1)),
	since: semverSchema.optional(),
	toc: z.boolean(),
	headings: z.array(pageHeadingSchema),
	body: z.array(blockSchema),
	translation: translationRecordSchema,
	reading: readingEstimateSchema,
	snippets: z.array(z.string().min(1)),
	sourceFile: z.string().min(1),
});

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

export const assetRecordSchema = z.strictObject({
	sha256: sha256Schema,
	ext: z.enum(ASSET_EXTENSIONS),
	bytes: positiveIntSchema,
	width: positiveIntSchema,
	height: positiveIntSchema,
	colour: z.strictObject({
		// The only legal value in a published bundle. A Display P3 asset is refused at
		// publish, never converted during the build: ffmpeg output varies by build, so a
		// build-time conversion would give one source file a different content hash on a
		// different runner, and the hash is the key.
		space: z.literal('srgb'),
		probe: z.enum(COLOUR_PROBES),
	}),
	lqip: z.string().min(1).nullable(),
});

export const headingRecordSchema = z.strictObject({
	id: z.string().min(1),
	depth: headingDepthSchema,
});

export const pageLocaleRecordSchema = z.strictObject({
	digest: sha256Schema,
	bytes: positiveIntSchema,
	rawDigest: sha256Schema,
	rawBytes: positiveIntSchema,
	title: z.string().min(1),
	navTitle: z.string().min(1).optional(),
	description: z.string().min(1),
	updatedAt: utcTimestampSchema,
	state: z.enum(TRANSLATION_STATES),
	words: countSchema,
	headings: z.array(headingRecordSchema),
});

export const pageRecordSchema = z.strictObject({
	audience: z.enum(AUDIENCES),
	since: semverSchema.nullable(),
	locales: z.partialRecord(localeSchema, pageLocaleRecordSchema),
});

export const manifestNavNodeSchema: z.ZodType<ManifestNavNode> = z.strictObject({
	slug: slugSchema,
	hidden: z.literal(true).optional(),
});

export const searchIndexRecordSchema = z.strictObject({
	digest: sha256Schema,
	bytes: positiveIntSchema,
	records: countSchema,
	terms: countSchema,
});

/**
 * An object key, relative to the `ast-N` prefix.
 *
 * Constrained, not merely non-empty, because `hexdocs prefetch` uses these to decide
 * what to write into a website's build tree, and `../../../app/root.tsx` passed the
 * previous `z.string().min(1)`. The leading character class alone is not enough: it
 * refuses `pages/../x` and admits `pages/en/../x`, so the traversal check is separate.
 */
export const objectKeySchema = z
	.string()
	.regex(
		/^(pages|raw|search|llms|assets)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/,
		'Expected a key under pages/, raw/, search/, llms/ or assets/.',
	)
	.refine(
		(key) => !key.split('/').includes('..'),
		'A key may not contain a parent-directory segment.',
	);

export const objectRecordSchema = z.strictObject({
	key: objectKeySchema,
	digest: sha256Schema,
	bytes: countSchema,
});

export const bundleCountsSchema = z.strictObject({
	pages: countSchema,
	locales: positiveIntSchema,
	objects: countSchema,
	bytes: countSchema,
});

export const localeCoverageSchema = z.strictObject({
	pages: countSchema,
	translated: countSchema,
	stale: countSchema,
	scaffolded: countSchema,
});

export const bundleManifestSchema = z.strictObject({
	manifest: z.literal(MANIFEST_VERSION),
	ast: z.literal(AST_VERSION),
	project: projectIdSchema,
	commit: commitShaSchema,
	commitTimestamp: utcTimestampSchema,
	generator: z.string().regex(/^@hex-pro\/docs-kit@\d+\.\d+\.\d+$/),
	locales: z.array(localeSchema).min(1),
	sourceLocale: localeSchema,
	pages: z.record(slugSchema, pageRecordSchema),
	nav: z.array(manifestNavNodeSchema),
	redirects: z.record(slugSchema, slugSchema),
	assets: z.array(assetRecordSchema),
	search: z.partialRecord(localeSchema, searchIndexRecordSchema),
	llms: z.partialRecord(
		localeSchema,
		z.strictObject({ digest: sha256Schema, bytes: positiveIntSchema }),
	),
	llmsOrder: z.array(slugSchema),
	objects: z.array(objectRecordSchema),
	counts: bundleCountsSchema,
	coverage: z.partialRecord(localeSchema, localeCoverageSchema),
});

/**
 * Keys a manifest may not carry, with the reason.
 *
 * A strict object already refuses them; naming them turns "unrecognized key: builtAt"
 * into an error that explains why a wall-clock field cannot exist in a file whose
 * whole contract is that rebuilding the same commit produces identical bytes.
 */
export const FORBIDDEN_MANIFEST_KEYS: Readonly<Record<string, string>> = {
	builtAt:
		'The manifest must be byte-reproducible from the commit alone. A wall-clock field makes a rebuild that changed nothing look like a rewrite, and the write-once refusal is unconditional.',
	node: 'Runner identity is not reproducible. The GitHub Actions run page holds it.',
	runner: 'Runner identity is not reproducible.',
	runUrl: 'Nothing reads it. The Actions run page is the record.',
	jobWorkflowRef:
		'Runner identity again, and nothing reads it. The Actions run page is the record.',
	timings: 'Not reproducible, and nothing reads it.',
	integrity:
		'A file cannot contain its own digest. The manifest sha lives downstream, in the site config version entry that decided to trust this bundle.',
	version:
		'A bundle is written on every push to main, before any label exists, and it is write-once. Labels live only in the web repository, and two sites may label the same sha differently.',
	sourceDigest:
		'Removed with the mechanism that produced it. Staleness comes from git committer dates.',
};

// ---------------------------------------------------------------------------
// The search index
// ---------------------------------------------------------------------------

export const searchDocSchema = z.strictObject({
	slug: slugSchema,
	anchor: z.string().min(1),
	title: z.string().min(1),
	heading: z.string(),
	depth: countSchema,
	// user 1, developer 2, both 3. Zero is forbidden: it would filter to nothing and
	// the reader would see an empty result list with no error.
	audience: z.union([z.literal(1), z.literal(2), z.literal(3)]),
	translated: z.enum(INDEXED_TRANSLATION_STATES),
});

export const searchPostingsSchema = z.strictObject({
	cnt: z.array(countSchema),
	post: z.array(countSchema),
});

export const searchIndexSchema = z.strictObject({
	kind: z.literal(SEARCH_INDEX_KIND),
	v: z.literal(SEARCH_INDEX_VERSION),
	ast: z.literal(AST_VERSION),
	tokeniser: z.literal(TOKENISER_VERSION),
	norm: z.enum(NORMALISATION_FORMS),
	stem: z.literal(false),
	match: z.enum(MATCH_MODES),
	locale: localeSchema,
	bundle: commitShaSchema,
	n: countSchema,
	terms: z.string(),
	df: z.array(positiveIntSchema),
	f: z.record(z.enum(SEARCH_FIELDS), searchPostingsSchema),
	len: z.record(z.enum(SEARCH_FIELDS), z.array(countSchema)),
	totalLen: z.record(z.enum(SEARCH_FIELDS), countSchema),
	w: z.record(z.enum(SEARCH_FIELDS), z.number().positive().finite()),
	k1: z.number().gt(0).lte(10),
	b: z.number().min(0).max(1),
	docs: z.array(searchDocSchema),
});

export type {
	AssetRecord,
	BundleCounts,
	BundleManifest,
	CompiledPage,
	HeadingRecord,
	LocaleCoverage,
	ManifestNavNode,
	ObjectRecord,
	PageHeading,
	PageLocaleRecord,
	PageRecord,
	ReadingEstimate,
	SearchDoc,
	SearchIndex,
	SearchIndexRecord,
	SearchPostings,
};
