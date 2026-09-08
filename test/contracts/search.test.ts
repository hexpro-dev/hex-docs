import { describe, expect, test } from 'vitest';

import {
	AUDIENCE_MASK,
	DEFAULT_B,
	DEFAULT_FIELD_WEIGHTS,
	DEFAULT_K1,
	INDEX_NORMALISATION,
	PAGE_ROOT_ANCHOR,
	SEARCH_FIELDS,
	SEARCH_INDEX_KIND,
	SEARCH_INDEX_VERSION,
	TOKENISER_VERSION,
	validateSearchIndexShape,
	type SearchIndex,
} from '../../src/contracts/search.js';

const SHA = 'c'.repeat(40);

function index(overrides: Partial<SearchIndex> = {}): SearchIndex {
	return {
		kind: SEARCH_INDEX_KIND,
		v: SEARCH_INDEX_VERSION,
		ast: 1,
		tokeniser: TOKENISER_VERSION,
		norm: INDEX_NORMALISATION,
		stem: false,
		match: 'or-coord',
		locale: 'en',
		bundle: SHA,
		n: 2,
		terms: 'ndef\nntag\ntag',
		df: [1, 1, 2],
		f: {
			title: { cnt: [0, 0, 2], post: [0, 1, 1, 1] },
			heading: { cnt: [0, 0, 0], post: [] },
			body: { cnt: [1, 1, 0], post: [0, 3, 1, 2] },
		},
		len: { title: [3, 4], heading: [0, 0], body: [120, 80] },
		totalLen: { title: 7, heading: 0, body: 200 },
		w: DEFAULT_FIELD_WEIGHTS,
		k1: DEFAULT_K1,
		b: DEFAULT_B,
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
			{
				slug: 'index',
				anchor: 'writing-a-tag',
				title: 'Hex NFC',
				heading: 'Writing a tag',
				depth: 2,
				audience: 1,
				translated: 'current',
			},
		],
		...overrides,
	};
}

describe('the header records everything the two halves could disagree about', () => {
	test('a valid index has no complaints', () => {
		expect(validateSearchIndexShape(index())).toEqual([]);
	});

	test('there is no version label anywhere, because a bundle predates its label', () => {
		expect(Object.keys(index())).not.toContain('version');
	});

	test('the normalisation form is recorded rather than assumed', () => {
		expect(index().norm).toBe('NFKC');
	});

	test('stemming is a recorded literal, so the invariant is checkable rather than a comment', () => {
		expect(index().stem).toBe(false);
	});

	test('the audience mask makes "both" structural rather than a special case', () => {
		expect(AUDIENCE_MASK.both).toBe(AUDIENCE_MASK.user | AUDIENCE_MASK.developer);
		// Filtering is a bitwise and, so nothing has to remember that one member means
		// "match either of the other two".
		expect(AUDIENCE_MASK.both & AUDIENCE_MASK.user).toBeTruthy();
		expect(AUDIENCE_MASK.developer & AUDIENCE_MASK.user).toBe(0);
	});

	test('the page-root anchor is a declared sentinel, not an empty string', () => {
		expect(PAGE_ROOT_ANCHOR).toBe('_top');
		expect(PAGE_ROOT_ANCHOR.length).toBeGreaterThan(0);
	});

	test('BM25 parameters are in the file, so an old label keeps the ranking it shipped with', () => {
		expect(index().w).toEqual({ title: 4, heading: 2, body: 1 });
		expect(index().k1).toBeGreaterThan(0);
		expect(index().b).toBeGreaterThanOrEqual(0);
	});
});

describe('the length relationships, which are the only thing standing between a truncated index and a wrong ranking', () => {
	test('df must have one entry per term', () => {
		expect(validateSearchIndexShape(index({ df: [1, 1] }))[0]).toContain(
			'df has 2 entries for 3 terms',
		);
	});

	test('docs must have exactly n entries', () => {
		expect(validateSearchIndexShape(index({ n: 3 }))).toEqual(
			expect.arrayContaining([expect.stringContaining('docs has 2 entries but n is 3')]),
		);
	});

	test('terms must be strictly ascending, because prefix expansion binary-searches them', () => {
		const problems = validateSearchIndexShape(index({ terms: 'ntag\nndef\ntag' }));
		expect(problems[0]).toContain('not strictly ascending');
		expect(problems[0]).toContain('binary-search');
	});

	test('a duplicated term is caught by the same rule', () => {
		expect(validateSearchIndexShape(index({ terms: 'ndef\nndef\ntag' }))[0]).toContain(
			'not strictly ascending',
		);
	});

	test('sum(cnt) * 2 must equal the posting array length', () => {
		const broken = index();
		broken.f.body.post = [0, 3];
		expect(validateSearchIndexShape(broken)[0]).toContain('sum(cnt) * 2');
	});

	test('cnt must have one entry per term', () => {
		const broken = index();
		broken.f.title = { cnt: [0, 2], post: [0, 1, 1, 1] };
		expect(validateSearchIndexShape(broken).some((p) => p.includes('f.title.cnt'))).toBe(true);
	});

	test('len must have one entry per section', () => {
		const broken = index();
		broken.len.body = [120];
		expect(validateSearchIndexShape(broken).some((p) => p.includes('len.body'))).toBe(true);
	});

	test('df above n is caught, because the idf would go negative', () => {
		expect(
			validateSearchIndexShape(index({ df: [1, 1, 9] })).some((p) =>
				p.includes('idf would be NaN or negative'),
			),
		).toBe(true);
	});

	test('section identity is the (slug, anchor) pair and duplicates are caught', () => {
		const broken = index();
		broken.docs[1] = { ...(broken.docs[0] as never) };
		expect(validateSearchIndexShape(broken).some((p) => p.includes('twice'))).toBe(true);
	});

	test('an empty dictionary is the empty string and must not decode to one blank term', () => {
		const empty = index({
			terms: '',
			df: [],
			n: 0,
			docs: [],
			f: {
				title: { cnt: [], post: [] },
				heading: { cnt: [], post: [] },
				body: { cnt: [], post: [] },
			},
			len: { title: [], heading: [], body: [] },
			totalLen: { title: 0, heading: 0, body: 0 },
		});
		expect(validateSearchIndexShape(empty)).toEqual([]);
	});

	test('every scored field is checked, not just the first', () => {
		expect(SEARCH_FIELDS.length).toBe(3);
		const broken = index();
		broken.len.heading = [];
		broken.len.title = [];
		const problems = validateSearchIndexShape(broken);
		expect(problems.some((p) => p.startsWith('len.title'))).toBe(true);
		expect(problems.some((p) => p.startsWith('len.heading'))).toBe(true);
	});
});

describe('totalLen is stored rather than avgdl', () => {
	test('it is an integer, because a float from a division is not byte-stable', () => {
		for (const field of SEARCH_FIELDS) {
			expect(Number.isInteger(index().totalLen[field])).toBe(true);
		}
	});

	test('a totalLen that disagrees with len is reported', () => {
		// The previous version of this test summed the fixture and compared it to the
		// fixture's own field, so it passed whatever the code did and would have passed
		// with the invariant deleted from the contract. This one can fail.
		for (const field of SEARCH_FIELDS) {
			const broken = index();
			broken.totalLen[field] = 999999;
			const problems = validateSearchIndexShape(broken);
			expect(problems.some((p) => p.includes(`totalLen.${field}`))).toBe(true);
			expect(problems.some((p) => p.includes('avgdl would be wrong'))).toBe(true);
		}
	});

	test('the well-formed fixture still has a totalLen that agrees', () => {
		expect(validateSearchIndexShape(index())).toEqual([]);
	});
});

describe('the posting invariants, which the comment used to state and nothing enforced', () => {
	/**
	 * One term, `count` postings, in the body field, against a given n.
	 *
	 * `df` is derived from the postings rather than fixed at 1, which it used to be. That
	 * made the fixture itself state the disagreement `df`'s contract forbids: three
	 * postings under a document frequency of one. Nothing noticed, because the check the
	 * contract described did not exist, and the fixture is the reason it went on not
	 * existing. Where a test wants the disagreement it passes `df` explicitly.
	 */
	/** The distinct document ids a delta-encoded posting list names: first absolute, rest gaps. */
	const countDocuments = (post: number[]): number => {
		const ids = new Set<number>();
		let id = 0;
		for (let i = 0; i < post.length; i += 2) {
			const delta = post[i] as number;
			id = i === 0 ? delta : id + delta;
			ids.add(id);
		}
		return ids.size;
	};

	const withPostings = (post: number[], n = 3, df?: number) =>
		index({
			n,
			terms: 'tag',
			df: [df ?? countDocuments(post)],
			f: {
				title: { cnt: [0], post: [] },
				heading: { cnt: [0], post: [] },
				body: { cnt: [post.length / 2], post },
			},
			len: {
				title: new Array(n).fill(0),
				heading: new Array(n).fill(0),
				body: new Array(n).fill(10),
			},
			totalLen: { title: 0, heading: 0, body: 10 * n },
			docs: Array.from({ length: n }, (_, i) => ({
				slug: 'index',
				anchor: i === 0 ? PAGE_ROOT_ANCHOR : `section-${i}`,
				title: 'Hex NFC',
				heading: '',
				depth: 2,
				audience: 3 as const,
				translated: 'current' as const,
			})),
		});

	test('a well-formed posting list passes', () => {
		expect(validateSearchIndexShape(withPostings([0, 3, 1, 2, 1, 1]))).toEqual([]);
	});

	test('a df that disagrees with the postings is caught, in both directions', () => {
		// The one check that catches a builder filling frequencies and postings in two
		// passes that disagree. `df` is computed in one walk and the postings in another,
		// so nothing but this compares them: a df above the true union deflates every idf
		// for that term and one below inflates them, and neither throws, sorts last, or
		// shows up as anything but slightly wrong ranking in one language.
		const postings = [0, 3, 1, 2, 1, 1];
		for (const df of [1, 2]) {
			const problems = validateSearchIndexShape(withPostings(postings, 3, df));
			expect(problems.join(' '), `df ${df}`).toContain(
				`df[0] is ${df} and the postings name 3 distinct documents`,
			);
		}

		// The other direction needs room above three, because a df above `n` is caught by
		// the range check first and this one deliberately does not add a second problem
		// about the same bytes.
		expect(validateSearchIndexShape(withPostings(postings, 5, 4)).join(' ')).toContain(
			'df[0] is 4 and the postings name 3 distinct documents',
		);

		expect(validateSearchIndexShape(withPostings(postings, 3, 3))).toEqual([]);

		// A multi-term index as well as a one-term one. Every posting list is one flat
		// array and a term's slice is found by summing the counts before it, so a check
		// that only ever saw term zero would pass with that arithmetic wrong: the base
		// fixture has three terms across two fields and its `df` is [1, 1, 2].
		expect(validateSearchIndexShape(index())).toEqual([]);
		expect(validateSearchIndexShape(index({ df: [1, 2, 2] })).join(' ')).toContain(
			'df[1] is 2 and the postings name 1 distinct documents',
		);
	});

	test('a zero delta is caught: it is a duplicated posting that double-counts a term', () => {
		const problems = validateSearchIndexShape(withPostings([0, 3, 0, 5]));
		expect(problems.some((p) => p.includes('duplicated posting'))).toBe(true);
	});

	test('a first delta outside the document range is caught', () => {
		expect(
			validateSearchIndexShape(withPostings([99, 1])).some((p) => p.includes('outside [0, 3)')),
		).toBe(true);
	});

	test('a running id that walks past n is caught, not left to dereference undefined', () => {
		expect(
			validateSearchIndexShape(withPostings([2, 1, 5, 1])).some((p) => p.includes('but n is 3')),
		).toBe(true);
	});

	test('a term frequency of zero is caught', () => {
		expect(
			validateSearchIndexShape(withPostings([0, 0])).some((p) => p.includes('no occurrences')),
		).toBe(true);
	});

	test('the exact index the finding used is reported, where it previously passed clean', () => {
		// n=2, body postings [0,3, 0,5, 99,0]: a zero delta, an id of 99, and a tf of 0.
		const broken = withPostings([0, 3, 0, 5, 99, 0], 2);
		expect(validateSearchIndexShape(broken).length).toBeGreaterThan(0);
	});

	test('one problem per field, so a broken index does not emit thousands of lines', () => {
		const broken = withPostings([0, 0, 0, 0, 0, 0]);
		expect(validateSearchIndexShape(broken).filter((p) => p.startsWith('f.body')).length).toBe(1);
	});

	test('decoding is skipped when the length check already failed, so the message is the useful one', () => {
		// The previous version of this test set post to [0] against cnt [1,1,0] and
		// asserted only that the sum(cnt) message was present. It passed with the guard
		// deleted, because that fixture decodes to nothing either way: post[1] is
		// undefined and every comparison against undefined is false.
		//
		// This one claims two postings and supplies one, and the one it supplies has a
		// first document id of 7 against n = 2. Guarded, that is one message about the
		// length. Unguarded, it is two, the second naming a posting that does not exist.
		const broken = index({
			n: 2,
			terms: 'tag',
			df: [1],
			f: {
				title: { cnt: [0], post: [] },
				heading: { cnt: [0], post: [] },
				body: { cnt: [2], post: [7, 1] },
			},
			len: { title: [0, 0], heading: [0, 0], body: [10, 10] },
			totalLen: { title: 0, heading: 0, body: 20 },
			docs: [
				{
					slug: 'index',
					anchor: PAGE_ROOT_ANCHOR,
					title: 'Hex NFC',
					heading: '',
					depth: 2,
					audience: 3 as const,
					translated: 'current' as const,
				},
				{
					slug: 'index',
					anchor: 'section-1',
					title: 'Hex NFC',
					heading: '',
					depth: 2,
					audience: 3 as const,
					translated: 'current' as const,
				},
			],
		});
		const problems = validateSearchIndexShape(broken);
		expect(problems.some((p) => p.includes('sum(cnt) * 2'))).toBe(true);
		expect(problems.filter((p) => p.startsWith('f.body')).length).toBe(1);
		expect(problems.some((p) => p.includes('outside [0, 2)'))).toBe(false);
	});

	test('a negative count is named, rather than shifting every later term silently', () => {
		// cnt [-1, 3] sums to 2, so sum(cnt) * 2 is 4 and a four-entry post array
		// satisfies the length identity. Without the sign check the decoder walks
		// shifted slices and reports a delta problem against term 1, which is fine.
		const broken = index({
			n: 2,
			terms: 'nfc\ntag',
			df: [1, 1],
			f: {
				title: { cnt: [0, 0], post: [] },
				heading: { cnt: [0, 0], post: [] },
				body: { cnt: [-1, 3], post: [0, 1, 0, 1] },
			},
			len: { title: [0, 0], heading: [0, 0], body: [10, 10] },
			totalLen: { title: 0, heading: 0, body: 20 },
			docs: [
				{
					slug: 'index',
					anchor: PAGE_ROOT_ANCHOR,
					title: 'Hex NFC',
					heading: '',
					depth: 2,
					audience: 3 as const,
					translated: 'current' as const,
				},
				{
					slug: 'index',
					anchor: 'section-1',
					title: 'Hex NFC',
					heading: '',
					depth: 2,
					audience: 3 as const,
					translated: 'current' as const,
				},
			],
		});
		const problems = validateSearchIndexShape(broken);
		expect(problems.some((p) => p.includes('f.body.cnt is -1 at term 0'))).toBe(true);
		expect(problems.some((p) => p.includes('delta'))).toBe(false);
	});
});

describe('df is bounded at both ends, because both ends produce a score and not a throw', () => {
	const withDf = (df: number[]) =>
		index({
			n: 1,
			terms: 'tag',
			df,
			f: {
				title: { cnt: [0], post: [] },
				heading: { cnt: [0], post: [] },
				body: { cnt: [1], post: [0, 1] },
			},
			len: { title: [0], heading: [0], body: [10] },
			totalLen: { title: 0, heading: 0, body: 10 },
			docs: [
				{
					slug: 'index',
					anchor: PAGE_ROOT_ANCHOR,
					title: 'Hex NFC',
					heading: '',
					depth: 2,
					audience: 3 as const,
					translated: 'current' as const,
				},
			],
		});

	test('a df of zero is caught: the idf divides by it', () => {
		expect(validateSearchIndexShape(withDf([0])).some((p) => p.includes('outside [1, 1]'))).toBe(
			true,
		);
	});

	test('a df above n is caught', () => {
		expect(validateSearchIndexShape(withDf([2])).some((p) => p.includes('outside [1, 1]'))).toBe(
			true,
		);
	});

	test('a df of exactly n passes, so the bound is inclusive', () => {
		expect(validateSearchIndexShape(withDf([1]))).toEqual([]);
	});
});
