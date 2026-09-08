import { describe, expect, test } from 'vitest';

import { AST_VERSION } from '../../../src/contracts/ast.js';
import { MANIFEST_VERSION } from '../../../src/contracts/manifest.js';
import {
	PAGE_ROOT_ANCHOR,
	SEARCH_INDEX_KIND,
	SEARCH_INDEX_VERSION,
	TOKENISER_VERSION,
} from '../../../src/contracts/search.js';
import {
	assetRecordSchema,
	bundleManifestSchema,
	compiledPageSchema,
	FORBIDDEN_MANIFEST_KEYS,
	objectRecordSchema,
	searchIndexSchema,
} from '../../src/contracts/bundle.schema.js';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const STAMP = '2026-09-07T04:11:52Z';

const PAGE = {
	ast: AST_VERSION,
	project: 'hex-nfc',
	slug: 'guide/first-tag',
	locale: 'en',
	title: 'Writing your first tag',
	description: 'Write an NDEF record to a blank NTAG215.',
	audience: 'user',
	pageKind: 'howto',
	tags: ['scanning'],
	toc: true,
	headings: [{ id: 'before-you-start', depth: 2, text: 'Before you start' }],
	body: [
		{
			type: 'paragraph',
			children: [{ type: 'text', value: 'Hold the tag to the top of the phone.' }],
		},
	],
	translation: { state: 'source', sourceUpdated: STAMP },
	reading: { words: 240, minutes: 2 },
	snippets: [],
	sourceFile: 'content/en/guide/first-tag.md',
};

const MANIFEST = {
	manifest: MANIFEST_VERSION,
	ast: AST_VERSION,
	project: 'hex-nfc',
	commit: SHA,
	commitTimestamp: STAMP,
	generator: '@hex-pro/docs-kit@0.1.0',
	locales: ['en'],
	sourceLocale: 'en',
	pages: {
		index: {
			audience: 'both',
			since: null,
			locales: {
				en: {
					digest: DIGEST,
					bytes: 100,
					rawDigest: DIGEST,
					rawBytes: 50,
					title: 'Hex NFC',
					description: 'The manual.',
					updatedAt: STAMP,
					state: 'source',
					words: 10,
					headings: [{ id: 'a', depth: 2 }],
				},
			},
		},
	},
	nav: [{ slug: 'index' }],
	redirects: {},
	assets: [],
	search: { en: { digest: DIGEST, bytes: 10, records: 1, terms: 5 } },
	llms: { en: { digest: DIGEST, bytes: 10 } },
	llmsOrder: ['index'],
	objects: [{ key: 'pages/en/index.json.gz', digest: DIGEST, bytes: 80 }],
	counts: { pages: 1, locales: 1, objects: 1, bytes: 160 },
	coverage: { en: { pages: 1, translated: 1, stale: 0, scaffolded: 0 } },
};

const INDEX = {
	kind: SEARCH_INDEX_KIND,
	v: SEARCH_INDEX_VERSION,
	ast: AST_VERSION,
	tokeniser: TOKENISER_VERSION,
	norm: 'NFKC',
	stem: false,
	match: 'or-coord',
	locale: 'en',
	bundle: SHA,
	n: 1,
	terms: 'tag',
	df: [1],
	f: {
		title: { cnt: [1], post: [0, 1] },
		heading: { cnt: [0], post: [] },
		body: { cnt: [0], post: [] },
	},
	len: { title: [3], heading: [0], body: [40] },
	totalLen: { title: 3, heading: 0, body: 40 },
	w: { title: 4, heading: 2, body: 1 },
	k1: 1.2,
	b: 0.75,
	docs: [
		{
			slug: 'index',
			anchor: PAGE_ROOT_ANCHOR,
			title: 'Hex NFC',
			heading: '',
			depth: 1,
			audience: 3,
			translated: 'current',
		},
	],
};

describe('a compiled page', () => {
	test('validates', () => {
		const parsed = compiledPageSchema.safeParse(PAGE);
		expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
	});

	test('is pinned to the AST major it was compiled at', () => {
		expect(compiledPageSchema.safeParse({ ...PAGE, ast: AST_VERSION + 1 }).success).toBe(false);
	});

	test('carries a precomputed table of contents, because there is no parser at runtime', () => {
		expect(compiledPageSchema.safeParse({ ...PAGE, headings: undefined }).success).toBe(false);
	});

	test('refuses a body node the AST does not have', () => {
		expect(
			compiledPageSchema.safeParse({ ...PAGE, body: [{ type: 'mathBlock', tex: 'x' }] }).success,
		).toBe(false);
	});
});

describe('the manifest', () => {
	test('validates', () => {
		const parsed = bundleManifestSchema.safeParse(MANIFEST);
		expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
	});

	test.each(Object.keys(FORBIDDEN_MANIFEST_KEYS))(
		'%s is refused, and the reason is recorded',
		(key) => {
			expect(bundleManifestSchema.safeParse({ ...MANIFEST, [key]: 'anything' }).success).toBe(
				false,
			);
			expect(FORBIDDEN_MANIFEST_KEYS[key]?.length ?? 0).toBeGreaterThan(30);
		},
	);

	test('builtAt is refused with the byte-reproducibility reason', () => {
		expect(FORBIDDEN_MANIFEST_KEYS['builtAt']).toMatch(/byte-reproducible/);
	});

	test('a local-offset timestamp is refused, so two runners write the same bytes', () => {
		expect(
			bundleManifestSchema.safeParse({ ...MANIFEST, commitTimestamp: '2026-09-07T04:11:52+10:00' })
				.success,
		).toBe(false);
	});

	test('the generator scope is @hex-pro, matching @hex-pro/i18n rather than @hexpro', () => {
		expect(
			bundleManifestSchema.safeParse({ ...MANIFEST, generator: '@hexpro/docs-kit@0.1.0' }).success,
		).toBe(false);
	});

	test('an English-only bundle needs no padding for the other six languages', () => {
		expect(bundleManifestSchema.safeParse(MANIFEST).success).toBe(true);
	});
});

describe('asset records', () => {
	const ASSET = {
		sha256: DIGEST,
		ext: 'png',
		bytes: 12345,
		width: 750,
		height: 1334,
		colour: { space: 'srgb', probe: 'cicp' },
		lqip: null,
	};

	test('validate', () => {
		expect(assetRecordSchema.safeParse(ASSET).success).toBe(true);
	});

	test('sRGB is the only colour space a published bundle may carry', () => {
		// A Display P3 asset is refused at publish rather than converted: ffmpeg output
		// varies by build, so converting would give one source file a different content
		// hash on a different runner, and the hash is the key.
		expect(
			assetRecordSchema.safeParse({ ...ASSET, colour: { space: 'display-p3', probe: 'cicp' } })
				.success,
		).toBe(false);
	});

	test('the probe is recorded, because ImageMagick reports sRGB for a P3 file and no-ops the conversion', () => {
		for (const probe of ['cicp', 'iccp', 'untagged', 'vector']) {
			expect(
				assetRecordSchema.safeParse({ ...ASSET, colour: { space: 'srgb', probe } }).success,
			).toBe(true);
		}
		expect(
			assetRecordSchema.safeParse({ ...ASSET, colour: { space: 'srgb', probe: 'guessed' } })
				.success,
		).toBe(false);
	});

	test('a non-canonical extension is refused, because it would give one file two keys', () => {
		for (const ext of ['jpeg', 'JPG', 'gif', 'bmp']) {
			expect(assetRecordSchema.safeParse({ ...ASSET, ext }).success).toBe(false);
		}
		for (const ext of ['png', 'jpg', 'webp', 'avif', 'svg']) {
			expect(assetRecordSchema.safeParse({ ...ASSET, ext }).success).toBe(true);
		}
	});

	test('dimensions are required, because there is no runtime image library to ask', () => {
		expect(assetRecordSchema.safeParse({ ...ASSET, width: undefined }).success).toBe(false);
		expect(assetRecordSchema.safeParse({ ...ASSET, height: 0 }).success).toBe(false);
	});
});

describe('the search index', () => {
	test('validates', () => {
		const parsed = searchIndexSchema.safeParse(INDEX);
		expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues)).toBe(true);
	});

	test('refuses to be anything else, so a mis-globbed page does not score as an empty index', () => {
		expect(searchIndexSchema.safeParse({ ...INDEX, kind: 'something.else' }).success).toBe(false);
	});

	test('a tokeniser version it does not implement is refused at load', () => {
		expect(
			searchIndexSchema.safeParse({ ...INDEX, tokeniser: TOKENISER_VERSION + 1 }).success,
		).toBe(false);
	});

	test('stemming is a literal false, so the invariant is checkable', () => {
		expect(searchIndexSchema.safeParse({ ...INDEX, stem: true }).success).toBe(false);
	});

	test('a version label cannot be smuggled in: a bundle predates its label', () => {
		expect(searchIndexSchema.safeParse({ ...INDEX, version: '1.0.0' }).success).toBe(false);
	});

	test('an audience mask of zero is refused: it would filter to nothing', () => {
		expect(
			searchIndexSchema.safeParse({ ...INDEX, docs: [{ ...INDEX.docs[0], audience: 0 }] }).success,
		).toBe(false);
	});

	test('BM25 parameters are bounded', () => {
		expect(searchIndexSchema.safeParse({ ...INDEX, k1: 0 }).success).toBe(false);
		expect(searchIndexSchema.safeParse({ ...INDEX, b: 1.5 }).success).toBe(false);
	});
});

describe('object keys', () => {
	const record = (key: string) =>
		objectRecordSchema.safeParse({ key, digest: DIGEST, bytes: 1 }).success;

	test.each([
		'pages/en/index.json.gz',
		'raw/pt-BR/guide/first-tag.md.gz',
		'search/ja.idx.json.gz',
		'llms/ar.txt',
		`assets/${DIGEST}.png`,
	])('%s is a key', (key) => {
		expect(record(key)).toBe(true);
	});

	test.each([
		'../../../app/root.tsx',
		'pages/../x',
		'pages/en/../../../root.tsx',
		'/etc/passwd',
		'app/root.tsx',
		'',
	])('%p is refused, because prefetch writes these into a website build tree', (key) => {
		expect(record(key)).toBe(false);
	});

	test('a page key that is not a slug is refused', () => {
		expect(
			bundleManifestSchema.safeParse({ ...MANIFEST, pages: { '../escape': MANIFEST.pages.index } })
				.success,
		).toBe(false);
	});
});
