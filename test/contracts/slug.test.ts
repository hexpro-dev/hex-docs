import { describe, expect, test } from 'vitest';

import {
	compareSlugStrings,
	compareSlugs,
	formatSlug,
	isSectionRoot,
	isValidSlug,
	MAX_SEGMENT_LENGTH,
	MAX_SLUG_DEPTH,
	parseSlug,
	requireSlug,
	RESERVED_SLUG_ROOTS,
	slugParent,
	slugToPath,
} from '../../src/contracts/slug.js';

const VALID = ['index', 'guide/index', 'guide/first-tag', 'reference/chip-support', 'a/b/c/index'];

describe('parsing', () => {
	test('index is a section root with no section, not an empty string', () => {
		const parsed = parseSlug('index');
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.slug).toEqual({ kind: 'index', section: [] });
	});

	test('a nested index is a section root carrying its section', () => {
		const parsed = parseSlug('guide/index');
		expect(parsed.ok && parsed.slug).toEqual({ kind: 'index', section: ['guide'] });
	});

	test('an ordinary page carries its section and its name', () => {
		const parsed = parseSlug('guide/first-tag');
		expect(parsed.ok && parsed.slug).toEqual({
			kind: 'page',
			section: ['guide'],
			name: 'first-tag',
		});
	});

	test.each(VALID)('%s round-trips through parse and format', (slug) => {
		const parsed = parseSlug(slug);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(formatSlug(parsed.slug)).toBe(slug);
	});
});

describe('rejections, each naming what is wrong', () => {
	test.each([
		['', 'empty'],
		['/guide', 'leading-or-trailing-slash'],
		['guide/', 'leading-or-trailing-slash'],
		['guide//first', 'empty-segment'],
		['Guide/First', 'bad-segment'],
		['guide/first_tag', 'bad-segment'],
		['guide/first.tag', 'bad-segment'],
		['guide/-first', 'bad-segment'],
		['guide/first-', 'bad-segment'],
		['a/b/c/d/e', 'too-deep'],
		['index/guide', 'nested-index'],
		['search', 'reserved-root'],
		['v/1-0-0', 'reserved-root'],
	])('%p is rejected as %s', (input, problem) => {
		const parsed = parseSlug(input);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.problem).toBe(problem);
			expect(parsed.message.length).toBeGreaterThan(20);
		}
	});

	test('a dot is refused because every page is also published at <slug>.md and <slug>.json', () => {
		expect(isValidSlug('guide/notes.md')).toBe(false);
	});

	test('a segment longer than the limit is refused with its length', () => {
		const long = 'a'.repeat(MAX_SEGMENT_LENGTH + 1);
		const parsed = parseSlug(long);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.problem).toBe('segment-too-long');
			expect(parsed.message).toContain(String(MAX_SEGMENT_LENGTH + 1));
		}
	});

	test('every reserved root is actually refused', () => {
		expect(RESERVED_SLUG_ROOTS.length).toBeGreaterThan(0);
		for (const reserved of RESERVED_SLUG_ROOTS) {
			expect(isValidSlug(reserved)).toBe(false);
			expect(isValidSlug(`${reserved}/child`)).toBe(false);
		}
	});

	test('a reserved word is fine anywhere but the first segment', () => {
		expect(isValidSlug('guide/search')).toBe(true);
	});

	test('requireSlug throws with the caller context', () => {
		expect(() => requireSlug('Guide', 'nav.json items[0].doc')).toThrowError(
			/nav\.json items\[0\]\.doc/,
		);
	});

	test('the depth limit is the stated one', () => {
		expect(isValidSlug(Array.from({ length: MAX_SLUG_DEPTH }, (_, i) => `s${i}`).join('/'))).toBe(
			true,
		);
		expect(
			isValidSlug(Array.from({ length: MAX_SLUG_DEPTH + 1 }, (_, i) => `s${i}`).join('/')),
		).toBe(false);
	});
});

describe('addresses', () => {
	test.each([
		['index', ''],
		['guide/index', 'guide'],
		['guide/first-tag', 'guide/first-tag'],
	])('%s addresses %p', (slug, path) => {
		const parsed = parseSlug(slug);
		expect(parsed.ok && slugToPath(parsed.slug)).toBe(path);
	});

	test('only section roots want a trailing slash', () => {
		expect(isSectionRoot(requireSlug('guide/index', 'x'))).toBe(true);
		expect(isSectionRoot(requireSlug('guide/first-tag', 'x'))).toBe(false);
	});
});

describe('parents', () => {
	test('a page belongs to its section root', () => {
		expect(slugParent(requireSlug('guide/first-tag', 'x'))).toEqual({
			kind: 'index',
			section: ['guide'],
		});
	});

	test('a section root belongs to the one above it', () => {
		expect(slugParent(requireSlug('a/b/index', 'x'))).toEqual({ kind: 'index', section: ['a'] });
	});

	test('the docs home has no parent', () => {
		expect(slugParent(requireSlug('index', 'x'))).toBeUndefined();
	});
});

describe('ordering', () => {
	test('is deterministic regardless of input order, which is what keeps a rebuild byte-identical', () => {
		const slugs = ['guide/first-tag', 'index', 'reference/chip', 'guide/index', 'guide/second'];
		const a = [...slugs].sort(compareSlugStrings);
		const b = [...slugs].reverse().sort(compareSlugStrings);
		expect(a).toEqual(b);
	});

	test('puts a section root before its children', () => {
		expect(['guide/first-tag', 'guide/index', 'index'].sort(compareSlugStrings)).toEqual([
			'index',
			'guide/index',
			'guide/first-tag',
		]);
	});

	test('is lexicographic across different first segments, not shallow-before-deep', () => {
		// The docstring used to promise "shallow before deep" in general. It is only true
		// where one path is a prefix of the other, and the test that named the property
		// only exercised that case. Anyone reimplementing this order from the sentence
		// would have produced a different sort.
		expect(['zzz', 'reference/chip', 'a/b/c'].sort(compareSlugStrings)).toEqual([
			'a/b/c',
			'reference/chip',
			'zzz',
		]);
		expect(compareSlugStrings('reference/chip', 'zzz')).toBeLessThan(0);
	});

	test('is a total order: comparing a value with itself is zero', () => {
		for (const slug of VALID) {
			const parsed = requireSlug(slug, 'x');
			expect(compareSlugs(parsed, parsed)).toBe(0);
		}
	});

	test('input the parser rejects sorts into one bucket after every valid slug', () => {
		// `apple` is a valid slug and `Zebra` is not, so the valid one comes first
		// whatever the two strings compare as.
		expect(compareSlugStrings('Zebra', 'apple')).toBeGreaterThan(0);
		expect(compareSlugStrings('apple', 'Zebra')).toBeLessThan(0);
		expect(compareSlugStrings('Zebra', 'Zebra')).toBe(0);
		// Within the rejected bucket, code point order: uppercase Z sorts before h.
		expect(compareSlugStrings('Zebra', 'hello!')).toBeLessThan(0);
		expect(compareSlugStrings('index', 'hello!')).toBeLessThan(0);
		expect(compareSlugStrings('hello!', 'index')).toBeGreaterThan(0);
	});

	test('is transitive even when the parser rejects some input', () => {
		// The previous fallback compared unparseable input by raw string against parsed
		// input by structure, which produced the cycle index < guide < hello! < index.
		// Sort then returned a different answer for each input permutation of the same
		// three strings, so a "deterministic" manifest depended on readdir order.
		const values = ['index', 'guide', 'hello!', 'guide/first-tag', 'Zebra'];
		const permutations: string[][] = [];
		const permute = (rest: string[], taken: string[]): void => {
			if (rest.length === 0) permutations.push(taken);
			for (const [i, value] of rest.entries()) {
				permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...taken, value]);
			}
		};
		permute(values, []);
		expect(permutations.length).toBe(120);

		const expected = [...values].sort(compareSlugStrings);
		for (const permutation of permutations) {
			expect([...permutation].sort(compareSlugStrings)).toEqual(expected);
		}
	});

	test('the comparator itself is antisymmetric across every pair', () => {
		const values = ['index', 'guide/index', 'guide/first-tag', 'hello!', 'Zebra', 'a/b/c/index'];
		for (const a of values) {
			for (const b of values) {
				expect(Math.sign(compareSlugStrings(a, b)) + Math.sign(compareSlugStrings(b, a))).toBe(0);
			}
		}
	});
});
