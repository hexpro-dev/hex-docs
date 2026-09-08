/**
 * What every bundle key is served as, checked against the writer that compresses it.
 *
 * Nothing here touches the network and nothing here needs to: `mediaFor` is a pure
 * function of a key string. What it cannot prove is that S3 or a browser agrees with the
 * table's content types, which is a claim about two systems this repository does not run.
 * That belongs to step 6, when a bucket exists to fetch a key back out of.
 *
 * The keys are **derived** from `pageKey`, `rawKey`, `searchKey`, `llmsKey`, `assetKey`
 * and `MANIFEST_KEY` rather than written as literals, so a change to any key format lands
 * here as a failure instead of leaving a table describing a shape nothing produces any
 * more. The failure it exists to catch is silent in every other direction: a gzip member
 * uploaded with no `Content-Encoding` reaches the browser as bytes it cannot decode, and
 * the AWS CLI's own answer produces exactly that for two thirds of a bundle.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { LOCALES } from '../../../src/contracts/locales.js';
import {
	ASSET_EXTENSIONS,
	MANIFEST_KEY,
	assetKey,
	isGzipped,
	llmsKey,
	pageKey,
	rawKey,
	searchKey,
	type AssetExtension,
	type BundleManifest,
} from '../../../src/contracts/manifest.js';
import { ASSET_CONTENT_TYPES, KEY_RULES, keyRuleProblems, mediaFor } from '../../src/s3/keys.js';

/** A digest-shaped name, because `assetKey` puts the content hash in the filename. */
const DIGEST = 'a'.repeat(64);

interface Shape {
	/** The rule in `KEY_RULES` this shape must reach. Checked in both directions below. */
	readonly rule: string;
	/** What the key helpers produce for this shape. Never a literal. */
	readonly keys: readonly string[];
	readonly contentType: string;
	/**
	 * What the table must say, and what `isGzipped` must independently say.
	 *
	 * Written once and asserted against both, because the two decisions live in two files:
	 * the bundle writer compresses on `isGzipped` and the publisher labels on the table.
	 * A test that read the flag off the rule would agree with itself.
	 */
	readonly gzipped: boolean;
}

/**
 * Every key shape a manifest can hold, built by the five helpers that write them.
 *
 * The slugs are deliberately awkward: a nested slug puts a second slash after the locale,
 * which is the part of `pages/<locale>/<slug>.json.gz` a prefix-and-suffix rule could get
 * wrong, and `pt-BR` is the one locale carrying a hyphen and a capital.
 */
const SHAPES: readonly Shape[] = [
	{
		rule: 'manifest',
		keys: [MANIFEST_KEY],
		contentType: 'application/json',
		gzipped: false,
	},
	{
		rule: 'pages',
		keys: LOCALES.flatMap((locale) => [
			pageKey(locale, 'index'),
			pageKey(locale, 'guide/first-tag'),
			pageKey(locale, 'reference/api'),
		]),
		contentType: 'application/json',
		gzipped: true,
	},
	{
		rule: 'raw',
		keys: LOCALES.flatMap((locale) => [
			rawKey(locale, 'index'),
			rawKey(locale, 'developer/architecture'),
		]),
		contentType: 'text/markdown; charset=utf-8',
		gzipped: true,
	},
	{
		rule: 'search',
		keys: LOCALES.map((locale) => searchKey(locale)),
		contentType: 'application/json',
		gzipped: true,
	},
	{
		rule: 'llms',
		keys: LOCALES.map((locale) => llmsKey(locale)),
		contentType: 'text/plain; charset=utf-8',
		gzipped: false,
	},
	// One shape per image format, so a format added to `ASSET_EXTENSIONS` with no content
	// type fails here rather than being served as binary/octet-stream by a static host.
	...ASSET_EXTENSIONS.map((ext: AssetExtension) => ({
		rule: `assets.${ext}`,
		keys: [assetKey(DIGEST, ext)],
		contentType: ASSET_CONTENT_TYPES[ext],
		gzipped: false,
	})),
];

const ALL_KEYS = SHAPES.flatMap((shape) => shape.keys);

/** Which rule a key lands on, by the same matching order `mediaFor` uses. */
function ruleIdFor(key: string): string | null {
	for (const rule of KEY_RULES) {
		const hit =
			rule.key !== null
				? key === rule.key
				: key.startsWith(rule.prefix) &&
					key.endsWith(rule.suffix) &&
					key.length > rule.prefix.length + rule.suffix.length;
		if (hit) return rule.id;
	}
	return null;
}

// ---------------------------------------------------------------------------
// The table against the keys the helpers write
// ---------------------------------------------------------------------------

describe('every key a helper can produce has a content type', () => {
	test.each(SHAPES.map((shape) => [shape.rule, shape] as const))(
		'%s keys resolve to the type and encoding the table declares',
		(_id, shape) => {
			expect(shape.keys.length).toBeGreaterThan(0);
			for (const key of shape.keys) {
				expect([key, mediaFor(key)]).toEqual([
					key,
					{ contentType: shape.contentType, gzipped: shape.gzipped },
				]);
				expect([key, ruleIdFor(key)]).toEqual([key, shape.rule]);
			}
		},
	);

	test('the gzipped half of the table agrees with isGzipped for every one of those keys', () => {
		// The comparison this file exists for, and it is not the one `mediaFor` makes
		// internally: that one reads the same `isGzipped` the writer reads, so it can only
		// fail when the table is wrong. This one reads the declared expectation in `SHAPES`
		// against both, so a table and a writer that were changed together to agree on the
		// wrong answer still fail.
		let compared = 0;
		for (const shape of SHAPES) {
			for (const key of shape.keys) {
				expect([key, isGzipped(key)]).toEqual([key, shape.gzipped]);
				compared += 1;
			}
		}
		expect(compared).toBe(ALL_KEYS.length);
		// Both answers actually occur, so the sweep is not one constant compared with itself.
		expect(new Set(SHAPES.map((shape) => shape.gzipped))).toEqual(new Set([true, false]));
	});
});

describe('the rule table and the key shapes cover each other', () => {
	test('every rule in KEY_RULES is reached by a key a helper produces', () => {
		// The direction that catches a rule for a key shape nothing writes any more. Such a
		// rule is dead weight that still answers `mediaFor`, so it can only be found by
		// asking which rules the real key writers reach.
		const reached = new Set(ALL_KEYS.map((key) => ruleIdFor(key)));
		const unreached = KEY_RULES.filter((rule) => !reached.has(rule.id)).map((rule) => rule.id);
		expect(unreached, 'no key helper produces a key matching these rules').toEqual([]);
	});

	test('every key a helper produces reaches a rule, and the claimed rule set is exact', () => {
		// The other direction. A key shape with no rule is refused by `mediaFor` rather than
		// guessed at, which is correct and would stop a publish dead, so it has to fail here
		// instead.
		const unmatched = ALL_KEYS.filter((key) => ruleIdFor(key) === null);
		expect(unmatched, 'these keys match no rule and could not be uploaded').toEqual([]);

		expect(new Set(SHAPES.map((shape) => shape.rule))).toEqual(
			new Set(KEY_RULES.map((rule) => rule.id)),
		);
		expect(SHAPES).toHaveLength(KEY_RULES.length);
	});

	test('keyRuleProblems finds nothing, and it examined every rule to say so', () => {
		expect(keyRuleProblems()).toEqual([]);
		// The rules `keyRuleProblems` walks are the rules this file claims, so a rule added
		// to the table without a shape here cannot hide behind that empty list.
		expect(KEY_RULES.length).toBeGreaterThan(SHAPES.length - ASSET_EXTENSIONS.length);

		// The gap, named rather than implied. Neither this function's problem-reporting arms
		// nor the throw in `mediaFor` can be reached by any string while the table is right:
		// every rule's suffix decides `isGzipped` for every key that matches it, so the two
		// cannot disagree about a key without the table itself being edited. Both arms
		// therefore go uncovered, and what stands behind them is the sweep above, which reads
		// the declared expectation in `SHAPES` against `isGzipped` rather than against the
		// rule. A table edited to disagree fails there, one test earlier than here.
		expect(
			KEY_RULES.filter((rule) => rule.key === null).every(
				(rule) => rule.gzipped === rule.suffix.endsWith('.gz'),
			),
		).toBe(true);
	});

	test('every rule states who fetches it and what a wrong header does', () => {
		// `why` is the only record of why a type was chosen, and a table of one-word
		// placeholders would satisfy the type. Not a behaviour, and it is here rather than in
		// a lint because nothing else reads these strings.
		for (const rule of KEY_RULES) {
			expect([rule.id, rule.why.length > 60]).toEqual([rule.id, true]);
		}
	});
});

// ---------------------------------------------------------------------------
// What is refused
// ---------------------------------------------------------------------------

describe('a key nothing recognises is refused rather than guessed at', () => {
	test.each([
		['a top-level file that is not the manifest', 'index.json'],
		['a prefix with nothing after it', 'pages/'],
		['a page key with no locale and no slug', 'pages/.json.gz'],
		['a raw key with no locale and no slug', 'raw/.md.gz'],
		['a search key with no locale', 'search/.idx.json.gz'],
		['an llms key with no locale', 'llms/.txt'],
		['an asset with no digest', `assets/.png`],
		['an image format the manifest cannot carry', `assets/${DIGEST}.gif`],
		['a page payload that was never compressed', 'pages/en/index.json'],
		['the manifest under a prefix that is already stripped off', 'bundle/manifest.json'],
	])('%s', (_name, key) => {
		expect([key, mediaFor(key)]).toEqual([key, null]);
	});

	test('the shortest real key of each shape is still accepted', () => {
		// The control for the row above: `pages/.json.gz` is refused because the length check
		// is strictly greater, and a check that refused one character more would refuse a
		// single-character slug as well. Both arms of that comparison are exercised.
		expect(mediaFor('pages/x.json.gz')).not.toBeNull();
		expect(mediaFor('raw/x.md.gz')).not.toBeNull();
		expect(mediaFor('search/x.idx.json.gz')).not.toBeNull();
		expect(mediaFor('llms/x.txt')).not.toBeNull();
		expect(mediaFor('assets/x.png')).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Against a manifest the compiler really wrote
// ---------------------------------------------------------------------------

describe('every object key in the goldened manifest resolves', () => {
	// The helpers say what a key can look like; this says what one does look like. The
	// golden manifest is the compiler's own output over the fixture corpus, so a key format
	// that changed in `manifest.ts` and in this table together, and nowhere else, still has
	// to agree with a file written before the change.
	const GOLDEN = JSON.parse(
		readFileSync(join(fileURLToPath(new URL('../golden/manifest.json', import.meta.url))), 'utf8'),
	) as BundleManifest;

	test('each stored object gets a type, and its encoding matches how it was written', () => {
		expect(GOLDEN.objects.length).toBeGreaterThan(50);
		for (const object of GOLDEN.objects) {
			const media = mediaFor(object.key);
			expect([object.key, media === null]).toEqual([object.key, false]);
			expect([object.key, media?.gzipped]).toEqual([object.key, isGzipped(object.key)]);
		}
		expect(mediaFor(MANIFEST_KEY)).toEqual({ contentType: 'application/json', gzipped: false });
	});

	test('the goldened bundle exercises more than one rule, and names which', () => {
		// Counting is not coverage: a bundle of ninety pages reaches four rules, and the two
		// image formats it does not carry are covered by the derived shapes above and by
		// nothing else. Saying so here is cheaper than a reader assuming this row is the
		// whole story.
		const reached = new Set(GOLDEN.objects.map((object) => ruleIdFor(object.key)));
		expect([...reached].sort()).toEqual([
			'assets.png',
			'assets.svg',
			'llms',
			'pages',
			'raw',
			'search',
		]);
		const missed = KEY_RULES.map((rule) => rule.id).filter((id) => !reached.has(id));
		expect(missed).toEqual(['manifest', 'assets.jpg', 'assets.webp', 'assets.avif']);
	});
});
