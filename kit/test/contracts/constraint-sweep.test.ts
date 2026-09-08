import { describe, expect, test } from 'vitest';
import type { z } from 'zod';

import { AST_VERSION } from '../../../src/contracts/ast.js';
import { MANIFEST_VERSION } from '../../../src/contracts/manifest.js';
import {
	PAGE_ROOT_ANCHOR,
	SEARCH_INDEX_KIND,
	SEARCH_INDEX_VERSION,
	TOKENISER_VERSION,
} from '../../../src/contracts/search.js';
import { DEFAULT_BUDGETS, PLAIN_CODE_LANGUAGE } from '../../../src/contracts/project.js';
import { LOCALES } from '../../../src/contracts/locales.js';
import {
	assetRecordSchema,
	bundleManifestSchema,
	compiledPageSchema,
	objectRecordSchema,
	pageLocaleRecordSchema,
	searchIndexSchema,
} from '../../src/contracts/bundle.schema.js';
import {
	docsProjectConfigSchema,
	docsSiteConfigSchema,
	frontMatterSchema,
	versionEntrySchema,
} from '../../src/contracts/config.schema.js';
import { checkRowSchema, findingSchema } from '../../src/contracts/diagnostics.schema.js';

/**
 * The constraints whose loss would ship something wrong.
 *
 * `drift.ts` proves a schema's inferred type equals its hand-written twin, and cannot
 * prove the schema validates as tightly as the type suggests: `z.string()` and
 * `z.string().regex(...)` both infer `string`. Dropping a regex therefore leaves the
 * whole gate green.
 *
 * This is the table that holds them. It is not every `.min(1)` in the package: it is
 * every identifier pattern, path grammar and numeric bound where a looser schema
 * publishes a bundle a consumer cannot use, or writes a file somewhere it should not.
 * Each row states the value that must be refused and why it matters.
 */
const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const STAMP = '2026-09-07T04:11:52Z';

const LABEL = Object.fromEntries(LOCALES.map((l) => [l, `Docs ${l}`]));

const VALID = {
	frontMatter: { title: 'Scanning a tag', description: 'How to read an NDEF tag.' },
	versionEntry: { label: '1.0.0', commit: SHA, released: '2026-09-07' },
	assetRecord: {
		sha256: DIGEST,
		ext: 'png',
		bytes: 1,
		width: 750,
		height: 1334,
		colour: { space: 'srgb', probe: 'cicp' },
		lqip: null,
	},
	objectRecord: { key: 'pages/en/index.json.gz', digest: DIGEST, bytes: 1 },
	pageLocaleRecord: {
		digest: DIGEST,
		bytes: 1,
		rawDigest: DIGEST,
		rawBytes: 1,
		title: 'Hex NFC',
		description: 'The manual.',
		updatedAt: STAMP,
		state: 'source',
		words: 0,
		headings: [],
	},
	finding: {
		rule: 'no-em-dash',
		severity: 'error',
		category: 'house-style',
		location: { kind: 'project' },
		locale: null,
		message: 'x',
		consequence: 'y',
		remediation: null,
		suggestion: null,
		excerpt: null,
	},
	checkRow: {
		id: 'wiring-submodule',
		status: 'pass',
		examined: 1,
		unit: 'entries',
		findings: [],
		note: null,
	},
	siteConfig: {
		site: 1,
		project: 'hex-nfc',
		basePath: '/hex-nfc/docs',
		navLabel: LABEL,
		versions: [{ label: '1.0.0', commit: SHA, released: '2026-09-07', default: true }],
		pages: ['index'],
	},
	projectConfig: {
		docs: 1,
		project: 'hex-nfc',
		productName: 'Hex NFC',
		repo: 'hexpro-dev/hex-nfc',
		defaultAudience: 'both',
		headingIds: 'slug',
		sections: [{ id: 'guide', kind: 'guide' }],
		i18n: { locales: ['en'], sourceLocale: 'en', parity: 'graceful' },
		budgets: DEFAULT_BUDGETS,
		code: { languages: [PLAIN_CODE_LANGUAGE] },
		toc: { enabled: true, maxDepth: 3, minHeadings: 3 },
		lint: { extends: 'house', maxDisables: 0 },
	},
	compiledPage: {
		ast: AST_VERSION,
		project: 'hex-nfc',
		slug: 'index',
		locale: 'en',
		title: 'Hex NFC',
		description: 'The manual.',
		audience: 'both',
		pageKind: 'article',
		tags: [],
		toc: true,
		headings: [],
		body: [],
		translation: { state: 'source', sourceUpdated: STAMP },
		reading: { words: 1, minutes: 1 },
		snippets: [],
		sourceFile: 'content/en/index.md',
	},
	searchIndex: {
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
		len: { title: [1], heading: [0], body: [0] },
		totalLen: { title: 1, heading: 0, body: 0 },
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
	},
} as const;

type Row = [
	name: string,
	schema: z.ZodType,
	valid: unknown,
	field: string,
	bad: unknown,
	why: string,
];

const ROWS: Row[] = [
	// Identifiers. A looser pattern gives one thing two keys, or one key two things.
	[
		'versionEntry',
		versionEntrySchema,
		VALID.versionEntry,
		'commit',
		'73b7be1',
		'an abbreviated sha collides eventually',
	],
	[
		'versionEntry',
		versionEntrySchema,
		VALID.versionEntry,
		'commit',
		SHA.toUpperCase(),
		'upper case makes a second key for one commit',
	],
	[
		'versionEntry',
		versionEntrySchema,
		VALID.versionEntry,
		'released',
		'07-09-2026',
		'a non-ISO date sorts wrong',
	],
	[
		'versionEntry',
		versionEntrySchema,
		VALID.versionEntry,
		'label',
		'a label with spaces',
		'a label is a URL segment',
	],
	[
		'assetRecord',
		assetRecordSchema,
		VALID.assetRecord,
		'sha256',
		'short',
		'the digest is the filename',
	],
	[
		'assetRecord',
		assetRecordSchema,
		VALID.assetRecord,
		'ext',
		'jpeg',
		'a non-canonical extension gives one file two keys',
	],
	[
		'assetRecord',
		assetRecordSchema,
		VALID.assetRecord,
		'width',
		0,
		'a zero dimension reserves no space and the page reflows',
	],
	['assetRecord', assetRecordSchema, VALID.assetRecord, 'height', 0, 'as above'],
	[
		'assetRecord',
		assetRecordSchema,
		VALID.assetRecord,
		'lqip',
		'',
		'an empty placeholder is not a placeholder',
	],
	[
		'pageLocaleRecord',
		pageLocaleRecordSchema,
		VALID.pageLocaleRecord,
		'updatedAt',
		'2026-09-07T04:11:52+10:00',
		'a local offset makes two runners disagree',
	],
	[
		'pageLocaleRecord',
		pageLocaleRecordSchema,
		VALID.pageLocaleRecord,
		'digest',
		'nope',
		'the digest is how hexdocs diff compares two labels',
	],
	[
		'pageLocaleRecord',
		pageLocaleRecordSchema,
		VALID.pageLocaleRecord,
		'title',
		'',
		'an empty title renders as a blank nav entry',
	],
	[
		'pageLocaleRecord',
		pageLocaleRecordSchema,
		VALID.pageLocaleRecord,
		'bytes',
		0,
		'a zero-length page payload is not a page',
	],

	// Paths. A looser grammar writes a file somewhere it should not.
	[
		'objectRecord',
		objectRecordSchema,
		VALID.objectRecord,
		'key',
		'../../../app/root.tsx',
		'prefetch writes these into a website build tree',
	],
	[
		'objectRecord',
		objectRecordSchema,
		VALID.objectRecord,
		'key',
		'pages/en/../../root.tsx',
		'a traversal past the first segment',
	],
	[
		'objectRecord',
		objectRecordSchema,
		VALID.objectRecord,
		'key',
		'app/root.tsx',
		'an object outside the four known prefixes',
	],
	[
		'compiledPage',
		compiledPageSchema,
		VALID.compiledPage,
		'slug',
		'../escape',
		'the slug becomes a URL path and a filename',
	],
	[
		'compiledPage',
		compiledPageSchema,
		VALID.compiledPage,
		'slug',
		// One segment over MAX_SEGMENT_LENGTH but well under the whole-slug maximum,
		// which is depth times segment length. The schema used to accept this and
		// parseSlug refused it, so the two disagreed about what a slug is and the build
		// failed somewhere other than the mistake.
		`guide/${'a'.repeat(65)}`,
		'a single segment over the per-segment limit fits inside the total',
	],
	[
		'compiledPage',
		compiledPageSchema,
		VALID.compiledPage,
		'sourceFile',
		'',
		'the edit-this-page link needs a path',
	],

	// Config identifiers, which join two repositories together.
	[
		'siteConfig',
		docsSiteConfigSchema,
		VALID.siteConfig,
		'project',
		'Hex_NFC',
		'the project id is an S3 prefix and a URL segment',
	],
	[
		'siteConfig',
		docsSiteConfigSchema,
		VALID.siteConfig,
		'basePath',
		'/hex-nfc/docs/',
		'a trailing slash makes two addresses',
	],
	[
		'siteConfig',
		docsSiteConfigSchema,
		VALID.siteConfig,
		'basePath',
		'/ja/hex-nfc/docs',
		'a baked locale would have to exist seven times',
	],
	// The refinement is derived from matchLocale rather than from a membership test
	// against the seven canonical spellings, so it refuses the alias forms too. Both
	// rows exist because that is a claim the comment on the refinement makes and
	// nothing checked: swapping it for the obvious hand-rolled list left the whole kit
	// suite green while /pt-br/hex-nfc/docs became an accepted basePath, which the
	// address builder would turn into /pt-BR/pt-br/hex-nfc/docs.
	[
		'siteConfig',
		docsSiteConfigSchema,
		VALID.siteConfig,
		'basePath',
		'/pt-br/hex-nfc/docs',
		'the lower-cased spelling is what a pasted browser address carries',
	],
	[
		'siteConfig',
		docsSiteConfigSchema,
		VALID.siteConfig,
		'basePath',
		'/zh-hans/hex-nfc/docs',
		'the Xcode string-catalogue spelling of the same language',
	],
	[
		'siteConfig',
		docsSiteConfigSchema,
		VALID.siteConfig,
		'themeClass',
		'App NFC',
		'a class name with a space is two classes',
	],
	[
		'projectConfig',
		docsProjectConfigSchema,
		VALID.projectConfig,
		'repo',
		'hex-nfc',
		'owner/name is how the edit link and the timestamps resolve',
	],
	[
		'projectConfig',
		docsProjectConfigSchema,
		VALID.projectConfig,
		'productName',
		'',
		'the one project string the UI prints',
	],

	// Front matter.
	[
		'frontMatter',
		frontMatterSchema,
		VALID.frontMatter,
		'title',
		'',
		'an empty title has no rendering anywhere, and the corpus disproved the character floor that used to be here: the Chinese guide is titled with two characters and is correct',
	],
	[
		'frontMatter',
		frontMatterSchema,
		VALID.frontMatter,
		'description',
		'',
		'the meta description and the search snippet',
	],
	[
		'frontMatter',
		frontMatterSchema,
		VALID.frontMatter,
		'since',
		'v1.0.0',
		'a v prefix breaks the version comparison',
	],
	[
		'frontMatter',
		frontMatterSchema,
		VALID.frontMatter,
		'navTitle',
		'a',
		'a one-character sidebar label',
	],

	// Diagnostics: the shape three renderers read.
	[
		'finding',
		findingSchema,
		VALID.finding,
		'rule',
		'no--em-dash',
		'a doubled hyphen makes a suppression match nothing',
	],
	['finding', findingSchema, VALID.finding, 'message', '', 'a finding with no message'],
	[
		'finding',
		findingSchema,
		VALID.finding,
		'consequence',
		'',
		'the reason an agent would otherwise have to ask for',
	],
	[
		'finding',
		findingSchema,
		VALID.finding,
		'suggestion',
		'',
		'empty and null must not both mean "no fix"',
	],
	[
		'checkRow',
		checkRowSchema,
		VALID.checkRow,
		'unit',
		'',
		'the unit is what the zero-examined message names',
	],
	['checkRow', checkRowSchema, VALID.checkRow, 'examined', -1, 'a negative count is not a count'],

	// Numbers a reader divides by or indexes with.
	[
		'searchIndex',
		searchIndexSchema,
		VALID.searchIndex,
		'k1',
		0,
		'k1 of zero removes term frequency from the score',
	],
	[
		'searchIndex',
		searchIndexSchema,
		VALID.searchIndex,
		'b',
		1.5,
		'b outside [0,1] inverts length normalisation',
	],
	[
		'searchIndex',
		searchIndexSchema,
		VALID.searchIndex,
		'bundle',
		'abc',
		'the index is keyed by the publishing commit',
	],
	[
		'searchIndex',
		searchIndexSchema,
		VALID.searchIndex,
		'ast',
		AST_VERSION + 1,
		'an index from another AST major',
	],
	[
		'manifest',
		bundleManifestSchema,
		{
			manifest: MANIFEST_VERSION,
			ast: AST_VERSION,
			project: 'p',
			commit: SHA,
			commitTimestamp: STAMP,
			generator: '@hex-pro/docs-kit@0.1.0',
			locales: ['en'],
			sourceLocale: 'en',
			pages: {},
			nav: [],
			redirects: {},
			assets: [],
			search: {},
			llms: {},
			llmsOrder: [],
			objects: [],
			counts: { pages: 0, locales: 1, objects: 0, bytes: 0 },
			coverage: {},
		},
		'generator',
		'@hexpro/docs-kit@0.1.0',
		'the scope is @hex-pro, matching @hex-pro/i18n',
	],
];

describe('the constraint sweep', () => {
	test('covers every schema whose constraints a looser version would silently drop', () => {
		expect(ROWS.length).toBeGreaterThan(30);
		expect(new Set(ROWS.map(([subject]) => subject)).size).toBeGreaterThanOrEqual(10);
	});

	test.each(
		ROWS.map(([name, schema, valid, field, bad, why]) => ({
			name,
			schema,
			valid,
			field,
			bad,
			why,
		})),
	)('$subject / $field refuses $bad: $why', ({ schema, valid, field, bad }) => {
		// The fixture itself must be valid, or the negative case proves nothing.
		expect(schema.safeParse(valid).success).toBe(true);
		expect(schema.safeParse({ ...(valid as object), [field]: bad }).success).toBe(false);
	});
});
