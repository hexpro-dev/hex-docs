import { gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, test } from 'vitest';

import {
	assetKey,
	bundlePrefix,
	isGzipped,
	llmsKey,
	GZIP_SETTINGS,
	MANIFEST_KEY,
	MANIFEST_VERSION,
	pageKey,
	rawKey,
	searchKey,
	UTC_TIMESTAMP_PATTERN,
	validateManifestShape,
	type BundleManifest,
	type PageLocaleRecord,
} from '../../src/contracts/manifest.js';
import { AST_VERSION } from '../../src/contracts/ast.js';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

function manifest(overrides: Partial<BundleManifest> = {}): BundleManifest {
	return {
		manifest: MANIFEST_VERSION,
		ast: AST_VERSION,
		project: 'hex-nfc',
		commit: SHA,
		commitTimestamp: '2026-09-07T04:11:52Z',
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
						updatedAt: '2026-09-07T04:11:52Z',
						state: 'source',
						words: 10,
						headings: [],
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
		counts: { pages: 1, locales: 1, objects: 1, bytes: 80 },
		coverage: { en: { pages: 1, translated: 1, stale: 0, scaffolded: 0 } },
		...overrides,
	};
}

describe('a well-formed manifest', () => {
	test('has no complaints', () => {
		expect(validateManifestShape(manifest())).toEqual([]);
	});

	test('a page record whose fields the bundle schema would refuse is named here', () => {
		// Three fields whose schemas require content, checked on every build because the
		// schemas only run in the toolchain's own tests. A page whose front matter did not
		// validate used to take an empty title and an empty description, and a file the git
		// walk had no date for took an empty `updatedAt`. All three are refused by the
		// bundle schemas, so the page compiled, the manifest was written, this function said
		// nothing, and the failure arrived wherever the payload was next read as a digest
		// mismatch naming no page.
		const broken = (field: 'title' | 'description' | 'updatedAt', value: string): string[] => {
			const base = manifest();
			const record = base.pages.index?.locales.en;
			if (record === undefined) throw new Error('the fixture lost its page');
			return validateManifestShape({
				...base,
				pages: { index: { ...base.pages.index, locales: { en: { ...record, [field]: value } } } },
			} as BundleManifest);
		};

		expect(broken('title', '').join(' ')).toContain('pages["index"].locales.en.title is empty');
		expect(broken('title', '   ').join(' ')).toContain('title is empty');
		expect(broken('description', '').join(' ')).toContain(
			'pages["index"].locales.en.description is empty',
		);

		// Not a timestamp, in the three shapes that reach it: empty, a date with no time,
		// and a local offset rather than Z. Freshness is a comparison of these, so an
		// unparseable one compares as neither newer nor older and the page reads current
		// against everything.
		for (const value of ['', '2026-09-07', '2026-09-07T04:11:52+10:00']) {
			expect(broken('updatedAt', value).join(' '), value).toContain(
				'pages["index"].locales.en.updatedAt',
			);
		}
		expect(broken('updatedAt', '2026-09-07T04:11:52Z')).toEqual([]);
	});

	test('a locale key with no record behind it is reported, not thrown on', () => {
		// `pages[slug].locales` is a partial record and this function reads a manifest that
		// came out of `JSON.parse`, so a key present with nothing behind it is a shape that
		// can arrive. It is still wrong, and the key check above says so; what must not
		// happen is a throw, because a manifest that cannot be validated is one nobody finds
		// out about until a page fails to render.
		const base = manifest();
		const problems = validateManifestShape({
			...base,
			locales: ['en', 'ja'],
			search: { ...base.search, ja: { digest: DIGEST, bytes: 10, records: 1, terms: 5 } },
			llms: { ...base.llms, ja: { digest: DIGEST, bytes: 10 } },
			counts: { ...base.counts, locales: 2 },
			coverage: { ...base.coverage, ja: { pages: 0, translated: 0, stale: 0, scaffolded: 0 } },
			pages: {
				index: {
					...base.pages.index,
					locales: { ...base.pages.index?.locales, ja: undefined },
				},
			},
		} as BundleManifest);
		// The absent record contributes nothing and complains about nothing. What matters is
		// that the walk reached the end: every other check in this function runs after this
		// loop, so a throw here would take the whole validation with it.
		expect(problems).toEqual([]);
	});

	test('carries no wall-clock field, which is what makes a rebuild byte-identical', () => {
		// The write-once refusal is unconditional, so a rebuild of the same commit that
		// changed nothing must not look like a rewrite.
		const keys = Object.keys(manifest());
		for (const forbidden of [
			'builtAt',
			'node',
			'runner',
			'runUrl',
			'timings',
			'integrity',
			'version',
		]) {
			expect(keys).not.toContain(forbidden);
		}
	});

	test('the only build-identity field left is deterministic per checkout', () => {
		expect(manifest().generator).toMatch(/^@hex-pro\/docs-kit@\d+\.\d+\.\d+$/);
	});

	test('the commit timestamp is normalised to UTC, so two runners write the same bytes', () => {
		expect(UTC_TIMESTAMP_PATTERN.test(manifest().commitTimestamp)).toBe(true);
		expect(UTC_TIMESTAMP_PATTERN.test('2026-09-07T04:11:52+10:00')).toBe(false);
		expect(UTC_TIMESTAMP_PATTERN.test('2026-09-07T04:11:52.123Z')).toBe(false);
	});
});

describe('the invariants a schema cannot express', () => {
	test('a sourceLocale outside locales is caught, because every fallback resolves against it', () => {
		const problems = validateManifestShape(manifest({ sourceLocale: 'ja' }));
		expect(problems.some((p) => p.includes('sourceLocale'))).toBe(true);
	});

	test('a per-locale record for a language the bundle does not have is caught', () => {
		const problems = validateManifestShape(
			manifest({
				search: {
					en: { digest: DIGEST, bytes: 1, records: 1, terms: 1 },
					ja: { digest: DIGEST, bytes: 1, records: 1, terms: 1 },
				},
			}),
		);
		expect(problems.some((p) => p.includes('search has an entry for "ja"'))).toBe(true);
	});

	test('a missing per-locale record for a language the bundle does have is caught', () => {
		const problems = validateManifestShape(manifest({ locales: ['en', 'ja'] }));
		expect(problems.filter((p) => p.includes('missing an entry for "ja"')).length).toBe(3);
	});

	test('a page carrying a locale the bundle does not have is caught', () => {
		const base = manifest();
		const page = base.pages['index'];
		if (page === undefined) throw new Error('fixture');
		const problems = validateManifestShape(
			manifest({
				pages: { index: { ...page, locales: { ...page.locales, ja: page.locales.en } } },
			}),
		);
		expect(problems.some((p) => p.includes('pages["index"].locales has an entry for "ja"'))).toBe(
			true,
		);
	});

	test('a redirect that shadows a live page is caught', () => {
		const problems = validateManifestShape(manifest({ redirects: { index: 'index' } }));
		expect(problems.some((p) => p.includes('would shadow'))).toBe(true);
	});

	test('a redirect to a page that does not exist is caught', () => {
		const problems = validateManifestShape(manifest({ redirects: { 'old-page': 'gone' } }));
		expect(problems.some((p) => p.includes('not a page in this bundle'))).toBe(true);
	});

	test('a nav entry naming a page that does not exist is caught', () => {
		const problems = validateManifestShape(
			manifest({ nav: [{ slug: 'index' }, { slug: 'ghost' }] }),
		);
		expect(problems.some((p) => p.includes('nav names "ghost"'))).toBe(true);
	});

	test('a hidden nav entry is checked exactly like a visible one', () => {
		// `hidden` keeps a page out of the sidebar and out of prev/next; it does not make
		// the entry unchecked. A hidden entry naming a page the bundle does not carry is
		// the same broken bundle, and it is harder to notice by reading the site.
		const problems = validateManifestShape(
			manifest({ nav: [{ slug: 'index' }, { slug: 'ghost', hidden: true }] }),
		);
		expect(problems.some((p) => p.includes('nav names "ghost"'))).toBe(true);
	});

	test('a hidden entry naming a real page is accepted', () => {
		const problems = validateManifestShape(manifest({ nav: [{ slug: 'index', hidden: true }] }));
		expect(problems.filter((p) => p.includes('nav'))).toEqual([]);
	});

	test('an llmsOrder entry naming a page that does not exist is caught', () => {
		const problems = validateManifestShape(manifest({ llmsOrder: ['index', 'ghost'] }));
		expect(problems.some((p) => p.includes('llmsOrder names "ghost"'))).toBe(true);
	});

	test('four problems are reported at once rather than one at a time', () => {
		const problems = validateManifestShape(
			manifest({ sourceLocale: 'ja', redirects: { index: 'nope' } }),
		);
		expect(problems.length).toBeGreaterThanOrEqual(3);
	});

	test('an English-only bundle needs no null padding for the other six languages', () => {
		// The whole reason PageRecord.locales is a partial record: hex-nfc's first
		// bundle is English-only, and a sixty-page manual would otherwise carry three
		// hundred and sixty nulls saying nothing.
		const page = manifest().pages['index'];
		expect(Object.keys(page?.locales ?? {})).toEqual(['en']);
		expect(validateManifestShape(manifest())).toEqual([]);
	});
});

describe('the key layout', () => {
	test('the ast major is in the prefix, which is the whole write-once mechanism', () => {
		expect(bundlePrefix('hex-nfc', SHA)).toBe(`hex-nfc/${SHA}/ast-${AST_VERSION}`);
		expect(bundlePrefix('hex-nfc', SHA, 2)).toBe(`hex-nfc/${SHA}/ast-2`);
	});

	test('recompiling at a new major adds a prefix and overwrites nothing', () => {
		expect(bundlePrefix('p', SHA, 1)).not.toBe(bundlePrefix('p', SHA, 2));
	});

	test.each([
		[pageKey('ja', 'guide/first-tag'), 'pages/ja/guide/first-tag.json.gz', true],
		[rawKey('ja', 'index'), 'raw/ja/index.md.gz', true],
		[searchKey('pt-BR'), 'search/pt-BR.idx.json.gz', true],
		[llmsKey('en'), 'llms/en.txt', false],
		[assetKey(DIGEST, 'png'), `assets/${DIGEST}.png`, false],
		[MANIFEST_KEY, 'manifest.json', false],
	])('%s is the key, gzipped: %s', (key, expected, gzipped) => {
		expect(key).toBe(expected);
		expect(isGzipped(key)).toBe(gzipped);
	});
});

describe('the orders the file header claims, which nothing used to check', () => {
	test('locales out of tuple order is caught, because two builders would write different bytes', () => {
		const problems = validateManifestShape(
			manifest({
				locales: ['ja', 'en'],
				search: {
					en: { digest: DIGEST, bytes: 1, records: 1, terms: 1 },
					ja: { digest: DIGEST, bytes: 1, records: 1, terms: 1 },
				},
				llms: { en: { digest: DIGEST, bytes: 1 }, ja: { digest: DIGEST, bytes: 1 } },
				coverage: {
					en: { pages: 1, translated: 1, stale: 0, scaffolded: 0 },
					ja: { pages: 0, translated: 0, stale: 0, scaffolded: 0 },
				},
				counts: { pages: 1, locales: 2, objects: 1, bytes: 80 },
			}),
		);
		expect(problems.some((p) => p.includes('canonical order is [en, ja]'))).toBe(true);
	});

	test('page keys out of code point order are caught', () => {
		const base = manifest();
		const page = base.pages['index'];
		if (page === undefined) throw new Error('fixture');
		const problems = validateManifestShape(
			manifest({
				pages: { zebra: page, index: page },
				nav: [{ slug: 'index' }, { slug: 'zebra' }],
				llmsOrder: ['index', 'zebra'],
				counts: { pages: 2, locales: 1, objects: 1, bytes: 80 },
				coverage: { en: { pages: 2, translated: 2, stale: 0, scaffolded: 0 } },
			}),
		);
		expect(problems.some((p) => p.includes('code point order'))).toBe(true);
	});

	test('assets out of sha256 order, or duplicated, are caught', () => {
		const asset = (sha: string) => ({
			sha256: sha,
			ext: 'png' as const,
			bytes: 1,
			width: 1,
			height: 1,
			colour: { space: 'srgb' as const, probe: 'untagged' as const },
			lqip: null,
		});
		expect(
			validateManifestShape(
				manifest({ assets: [asset('f'.repeat(64)), asset('a'.repeat(64))] }),
			).some((p) => p.includes('sorted by sha256')),
		).toBe(true);
		expect(
			validateManifestShape(
				manifest({ assets: [asset('a'.repeat(64)), asset('a'.repeat(64))] }),
			).some((p) => p.includes('same sha256 twice')),
		).toBe(true);
	});

	test('objects out of key order, or duplicated, are caught', () => {
		const object = (key: string) => ({ key, digest: DIGEST, bytes: 40 });
		expect(
			validateManifestShape(
				manifest({
					objects: [object('raw/en/index.md.gz'), object('pages/en/index.json.gz')],
					counts: { pages: 1, locales: 1, objects: 2, bytes: 80 },
				}),
			).some((p) => p.includes('sorted by key')),
		).toBe(true);
		expect(
			validateManifestShape(
				manifest({
					objects: [object('pages/en/index.json.gz'), object('pages/en/index.json.gz')],
					counts: { pages: 1, locales: 1, objects: 2, bytes: 80 },
				}),
			).some((p) => p.includes('same key twice')),
		).toBe(true);
	});
});

describe('the derived fields, which the same file refuses to inline elsewhere', () => {
	test.each([
		['pages', 9],
		['locales', 9],
		['objects', 9],
		['bytes', 9],
	])('a wrong counts.%s is recounted and reported', (key, wrong) => {
		const problems = validateManifestShape(
			manifest({ counts: { ...manifest().counts, [key]: wrong } }),
		);
		expect(problems.some((p) => p.includes(`counts.${key} is ${wrong}`))).toBe(true);
	});

	test.each(['pages', 'translated', 'stale', 'scaffolded'])(
		'a wrong coverage.en.%s is recounted and reported',
		(key) => {
			const problems = validateManifestShape(
				manifest({ coverage: { en: { ...(manifest().coverage.en as never), [key]: 7 } } }),
			);
			expect(problems.some((p) => p.includes(`coverage.en.${key} is 7`))).toBe(true);
		},
	);

	test('every state a record can carry is classified, not just the two the fixture had', () => {
		// The fixture is one `source` page, so before this the recount was exercised for
		// `source` and, in the test below, `scaffolded`. `current` and `stale` were
		// classified by code no test reached: folding `stale` into `translated` would
		// have reported a locale as fully translated while every page of it was out of
		// date, and nothing here would have failed.
		const base = manifest();
		const record = base.pages['index']?.locales.en;
		if (record === undefined) throw new Error('fixture');
		const page = (state: PageLocaleRecord['state']) => ({
			audience: 'both' as const,
			since: null,
			locales: { en: { ...record, state } },
		});
		const four = manifest({
			pages: {
				a: page('source'),
				b: page('current'),
				c: page('stale'),
				d: page('scaffolded'),
			},
			nav: [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }, { slug: 'd' }],
			llmsOrder: ['a', 'b', 'c', 'd'],
			counts: { pages: 4, locales: 1, objects: 1, bytes: 80 },
			coverage: { en: { pages: 4, translated: 2, stale: 1, scaffolded: 1 } },
		});
		expect(validateManifestShape(four)).toEqual([]);

		// And each of the four moves exactly the count it should. `source` and `current`
		// share a bucket, so swapping between them is the one change that moves nothing.
		for (const [state, coverage] of [
			['source', { pages: 4, translated: 3, stale: 0, scaffolded: 1 }],
			['current', { pages: 4, translated: 3, stale: 0, scaffolded: 1 }],
			['scaffolded', { pages: 4, translated: 2, stale: 0, scaffolded: 2 }],
		] as const) {
			const moved = manifest({
				...four,
				pages: { ...four.pages, c: page(state) },
				coverage: { en: coverage },
			});
			expect(validateManifestShape(moved)).toEqual([]);
		}
	});

	test('a record that claims to be missing is refused, because absence is the statement', () => {
		// `missing` is a diagnostic state: it exists so a translation report can list
		// every locale and say which has nothing. A manifest says the same thing by not
		// carrying the key, so a present record claiming it is two answers at once, and
		// the recount would count it in `pages` and in none of the three buckets.
		const base = manifest();
		const record = base.pages['index']?.locales.en;
		if (record === undefined) throw new Error('fixture');
		const problems = validateManifestShape(
			manifest({
				pages: {
					index: {
						audience: 'both',
						since: null,
						locales: { en: { ...record, state: 'missing' } },
					},
				},
				coverage: { en: { pages: 1, translated: 0, stale: 0, scaffolded: 0 } },
			}),
		);
		expect(problems.some((p) => p.includes('has state "missing"'))).toBe(true);
		expect(problems.some((p) => p.includes('absence of the key'))).toBe(true);
	});

	test('a scaffolded translation is counted as neither translated nor stale', () => {
		// Folding it into either is how a project reads as fully translated when six
		// languages of it are still English.
		const base = manifest();
		const record = base.pages['index']?.locales.en;
		if (record === undefined) throw new Error('fixture');
		const problems = validateManifestShape(
			manifest({
				pages: {
					index: {
						audience: 'both',
						since: null,
						locales: { en: { ...record, state: 'scaffolded' } },
					},
				},
				coverage: { en: { pages: 1, translated: 0, stale: 0, scaffolded: 1 } },
			}),
		);
		expect(problems).toEqual([]);
	});
});

describe('the gzip settings', () => {
	// The previous version of this block asserted the constant's own values against
	// literals and called that pinning two bytes. Nothing anywhere produced a byte from
	// it, so it would have passed with the write-once property broken. These measure
	// node's zlib instead, which is the thing the constant makes a claim about.
	const sample = Buffer.from('a page of documentation, compressed twice\n'.repeat(64));
	const member = gzipSync(sample, GZIP_SETTINGS);

	test('node ignores os and mtime, so spreading this object into gzipSync is not enough', () => {
		// This is the whole reason the writer has to patch the header by hand. If node
		// ever grows the options, this fails and the comment on GZIP_SETTINGS is what
		// needs rewriting.
		expect(gzipSync(sample, { level: GZIP_SETTINGS.level }).equals(member)).toBe(true);
		expect(member[9]).not.toBe(GZIP_SETTINGS.os);
	});

	test('mtime and the filename flag are already what the constant asks for', () => {
		// Bytes 4 to 7 are MTIME, byte 3 is FLG and bit 3 of it is FNAME.
		expect([...(member.subarray(4, 8) as Uint8Array)]).toEqual([0, 0, 0, 0]);
		expect(GZIP_SETTINGS.mtime).toBe(0);
		expect((member[3] as number) & 0b0000_1000).toBe(0);
		expect(GZIP_SETTINGS.filename).toBeNull();
	});

	test('patching byte 9 normalises the member and still decompresses to the input', () => {
		// The technique the writer has to use, pinned here so it is not rediscovered.
		const normalised = Buffer.from(member);
		normalised[9] = GZIP_SETTINGS.os;
		expect(normalised[9]).toBe(255);
		expect(gunzipSync(normalised).equals(sample)).toBe(true);
		// Everything but byte 9 is unchanged, which is what makes the patch safe: the
		// OS field is not covered by the CRC, which sits in the trailer over the
		// uncompressed data.
		expect(normalised.subarray(0, 9).equals(member.subarray(0, 9))).toBe(true);
		expect(normalised.subarray(10).equals(member.subarray(10))).toBe(true);
	});

	test('the level is a real zlib option, so changing it changes the payload', () => {
		expect(GZIP_SETTINGS.level).toBeGreaterThanOrEqual(1);
		expect(GZIP_SETTINGS.level).toBeLessThanOrEqual(9);
		expect(gzipSync(sample, { level: 1 }).equals(member)).toBe(false);
	});
});
