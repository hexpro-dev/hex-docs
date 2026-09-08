import { describe, expect, test } from 'vitest';

import { AST_VERSION } from '../../src/contracts/ast.js';
import {
	AUDIENCE_MASK,
	DEFAULT_B,
	DEFAULT_FIELD_WEIGHTS,
	DEFAULT_K1,
	INDEX_NORMALISATION,
	SEARCH_FIELDS,
	SEARCH_INDEX_KIND,
	SEARCH_INDEX_VERSION,
	TOKENISER_VERSION,
	validateSearchIndexShape,
	type AudienceMask,
	type SearchDoc,
	type SearchField,
	type SearchIndex,
} from '../../src/contracts/search.js';
import { assertIndexCompatible, decodeTerms, searchIndex } from '../../src/search/query.js';

const SHA = 'a'.repeat(40);

/**
 * The fixture index, declared the way a person reads it and encoded by the test.
 *
 * The columnar arrays are built here from the occurrence table below rather than typed
 * out, for two reasons. A hand-typed `post` array is a set of deltas nobody can check by
 * eye, and a decoder tested against arrays written to match the decoder agrees with
 * itself by construction. `validateSearchIndexShape` then confirms that what the
 * encoder produced is a legal index rather than a shape only this reader accepts.
 */
interface Occurrence {
	term: string;
	field: SearchField;
	doc: number;
	tf: number;
}

/** Ascending by code unit, which is what the prefix walk depends on. */
const DICTIONARY = ['api', 'ndef', 'nfc', 'ntag', 'ntag213', 'tag'];

const DOCS: SearchDoc[] = [
	{
		slug: 'b-guide',
		anchor: '_top',
		title: 'Guide',
		heading: '',
		depth: 1,
		audience: AUDIENCE_MASK.both,
		translated: 'current',
	},
	// Document 1 sorts after document 0 by id and before it by slug, which is what makes
	// the tie-break test able to tell the two orderings apart.
	{
		slug: 'a-basics',
		anchor: '_top',
		title: 'Tag basics',
		heading: '',
		depth: 1,
		audience: AUDIENCE_MASK.both,
		translated: 'current',
	},
	{
		slug: 'c-chips',
		anchor: 'ntag213',
		title: 'Chips',
		heading: 'NTAG213 chips',
		depth: 2,
		audience: AUDIENCE_MASK.both,
		translated: 'current',
	},
	{
		slug: 'd-api',
		anchor: '_top',
		title: 'API',
		heading: '',
		depth: 1,
		audience: AUDIENCE_MASK.developer,
		translated: 'current',
	},
	{
		slug: 'a-basics',
		anchor: 'about',
		title: 'Tag basics',
		heading: 'About',
		depth: 2,
		audience: AUDIENCE_MASK.both,
		translated: 'current',
	},
];

const OCCURRENCES: Occurrence[] = [
	{ term: 'tag', field: 'title', doc: 1, tf: 1 },
	{ term: 'tag', field: 'title', doc: 4, tf: 1 },
	{ term: 'tag', field: 'body', doc: 0, tf: 3 },
	{ term: 'ndef', field: 'body', doc: 0, tf: 1 },
	{ term: 'ndef', field: 'body', doc: 3, tf: 1 },
	{ term: 'nfc', field: 'body', doc: 0, tf: 1 },
	{ term: 'nfc', field: 'body', doc: 1, tf: 1 },
	{ term: 'nfc', field: 'body', doc: 4, tf: 1 },
	{ term: 'ntag', field: 'body', doc: 0, tf: 1 },
	// Document 2 holds both `ntag` and the term `ntag` is a prefix of. It is the only
	// section a one-word query reaches twice, and it is what makes a coordination count
	// taken over expansions rather than over query terms visible as a doubled score.
	{ term: 'ntag', field: 'body', doc: 2, tf: 1 },
	{ term: 'ntag213', field: 'heading', doc: 2, tf: 1 },
	{ term: 'ntag213', field: 'body', doc: 2, tf: 3 },
	{ term: 'api', field: 'title', doc: 3, tf: 1 },
];

const LENGTHS: Record<SearchField, number[]> = {
	title: [1, 2, 1, 1, 2],
	heading: [0, 0, 2, 0, 1],
	// Equal in every section on purpose: it is what makes an exact tie constructible,
	// and a tie is what the (slug, anchor) ordering exists for.
	body: [40, 40, 40, 40, 40],
};

const N = DOCS.length;

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function occurrencesOf(term: string, field: SearchField): Occurrence[] {
	return OCCURRENCES.filter((entry) => entry.term === term && entry.field === field).sort(
		(left, right) => left.doc - right.doc,
	);
}

function documentFrequency(term: string): number {
	return new Set(OCCURRENCES.filter((entry) => entry.term === term).map((entry) => entry.doc)).size;
}

function encode(field: SearchField): { cnt: number[]; post: number[] } {
	const cnt: number[] = [];
	const post: number[] = [];
	for (const term of DICTIONARY) {
		const postings = occurrencesOf(term, field);
		cnt.push(postings.length);
		let previous = 0;
		for (const [i, posting] of postings.entries()) {
			post.push(i === 0 ? posting.doc : posting.doc - previous, posting.tf);
			previous = posting.doc;
		}
	}
	return { cnt, post };
}

function fixture(overrides: Partial<SearchIndex> = {}): SearchIndex {
	return {
		kind: SEARCH_INDEX_KIND,
		v: SEARCH_INDEX_VERSION,
		ast: AST_VERSION,
		tokeniser: TOKENISER_VERSION,
		norm: INDEX_NORMALISATION,
		stem: false,
		match: 'or-coord',
		locale: 'en',
		bundle: SHA,
		n: N,
		terms: DICTIONARY.join('\n'),
		df: DICTIONARY.map(documentFrequency),
		f: { title: encode('title'), heading: encode('heading'), body: encode('body') },
		len: LENGTHS,
		totalLen: { title: sum(LENGTHS.title), heading: sum(LENGTHS.heading), body: sum(LENGTHS.body) },
		w: DEFAULT_FIELD_WEIGHTS,
		k1: DEFAULT_K1,
		b: DEFAULT_B,
		docs: DOCS,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// A second implementation of the same arithmetic
// ---------------------------------------------------------------------------

/**
 * BM25 computed from the readable declaration rather than from the columnar arrays.
 *
 * This is the point of the fixture being declarative. The scorer under test reads
 * prefix-summed counts and document deltas; this one reads a list of occurrences. They
 * agree only if the decoder walks the layout the contract describes, and a decoder that
 * assumed a different layout would score silently wrong rather than throw.
 */
function idf(term: string): number {
	const df = documentFrequency(term);
	return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

function contribution(term: string, field: SearchField, doc: number): number {
	const posting = occurrencesOf(term, field).find((entry) => entry.doc === doc);
	if (posting === undefined) return 0;
	const average = sum(LENGTHS[field]) / N;
	const ratio = (LENGTHS[field][doc] as number) / average;
	const tfNorm =
		(posting.tf * (DEFAULT_K1 + 1)) /
		(posting.tf + DEFAULT_K1 * (1 - DEFAULT_B + DEFAULT_B * ratio));
	return DEFAULT_FIELD_WEIGHTS[field] * idf(term) * tfNorm;
}

/**
 * The expected score for one section.
 *
 * `groups` is the dictionary terms each query term reached: one term for an exact
 * match, several for the expansion of the last word. Grouped rather than flat, because
 * the coordination factor counts query terms and a flat list could not tell a two-word
 * query from one word that completed to two terms. `queryTerms` is the divisor, which
 * is the number of distinct terms the query tokenised to.
 */
/**
 * The score one query term's expansion should produce for one document.
 *
 * A group is one query token and the dictionary terms it expanded to. Within a term the
 * fields sum, because a word in the title and in the body of the same section is two
 * pieces of evidence about that section. Across the terms of one group the **best** is
 * taken, not the sum: summing is what let a one-word query completing to forty terms
 * score like a forty-term query matched in full, and this helper summed too, so it agreed
 * with the scorer about an answer they were both wrong about.
 */
function expected(groups: string[][], doc: number, queryTerms: number): number {
	let total = 0;
	let matched = 0;
	for (const group of groups) {
		let best = 0;
		let hit = false;
		for (const term of group) {
			let perTerm = 0;
			for (const field of SEARCH_FIELDS) {
				const value = contribution(term, field, doc);
				perTerm += value;
				if (value > 0) hit = true;
			}
			if (perTerm > best) best = perTerm;
		}
		total += best;
		if (hit) matched += 1;
	}
	return total * (matched / queryTerms);
}

function identities(
	index: SearchIndex,
	query: string,
	options: { audience?: AudienceMask; limit?: number } = {},
): string[] {
	return searchIndex(index, query, options).map((hit) => `${hit.doc.slug}#${hit.doc.anchor}`);
}

describe('the fixture is a legal index, not a shape only this reader accepts', () => {
	test('the encoder produces an index the contract validates', () => {
		expect(validateSearchIndexShape(fixture())).toEqual([]);
	});

	test('the dictionary is strictly ascending, which the prefix walk depends on', () => {
		const terms = decodeTerms(fixture());
		expect(terms).toEqual(DICTIONARY);
		expect([...terms].sort()).toEqual(terms);
	});

	test('an empty dictionary decodes to nothing, not to one empty term', () => {
		// `''.split('\n')` is `['']`: a one-term dictionary whose only term is empty,
		// which every prefix walk then matches and which has no `df` entry.
		expect(decodeTerms(fixture({ terms: '' }))).toEqual([]);
		expect(''.split('\n')).toEqual(['']);
	});

	test('every declared occurrence is reachable through the columnar postings', () => {
		let swept = 0;
		const index = fixture();
		for (const occurrence of OCCURRENCES) {
			const doc = DOCS[occurrence.doc] as SearchDoc;
			expect(
				identities(index, occurrence.term),
				`${occurrence.term} in ${occurrence.field} of document ${occurrence.doc}`,
			).toContain(`${doc.slug}#${doc.anchor}`);
			swept += 1;
		}
		expect(swept).toBe(OCCURRENCES.length);
		expect(swept).toBe(13);
	});
});

describe('the header is refused rather than misread', () => {
	test('a matching header passes', () => {
		expect(() => assertIndexCompatible(fixture())).not.toThrow();
	});

	/**
	 * Every header field that is a fixed value, and a value that is not it.
	 *
	 * Listed here and cross-checked against the header below, rather than only listed.
	 * This used to be six hand-written rows ending in `expect(swept).toBe(6)`, and `stem`
	 * was a seventh header field with no comparison in the runtime at all: the list could
	 * not notice, because it was the same hand that wrote both.
	 */
	const HEADER_FIELDS: Readonly<Record<string, unknown>> = {
		kind: 'hexdocs.page',
		v: SEARCH_INDEX_VERSION + 1,
		ast: AST_VERSION + 1,
		tokeniser: TOKENISER_VERSION + 1,
		norm: 'NFC',
		match: 'and',
		stem: true,
	};

	test('every fixed header field refuses by name', () => {
		// Every failure in search is silent: an index the client does not understand
		// scores as empty and renders as "no results", which is indistinguishable from a
		// query that genuinely matched nothing.
		let swept = 0;
		for (const [field, value] of Object.entries(HEADER_FIELDS)) {
			const broken = { ...fixture(), [field]: value } as unknown as SearchIndex;
			expect(() => assertIndexCompatible(broken), field).toThrow(new RegExp(`\\b${field} is `));
			// Scoring is refused too, so there is no path that reads an index the header
			// says this runtime cannot read.
			expect(() => searchIndex(broken, 'tag'), field).toThrow();
			swept += 1;
		}
		expect(swept).toBe(Object.keys(HEADER_FIELDS).length);
	});

	test('the list above is every header field this runtime pins', () => {
		// The direction that catches the next `stem`. A field added to the index header
		// with a fixed value and no comparison in `headerExpectations` is a field an
		// incompatible index can carry silently, and it lands here as a name in one set and
		// not the other rather than as a number nobody updated.
		const header = fixture() as unknown as Record<string, unknown>;
		// Everything the header carries that is a measurement or a per-project setting
		// rather than a compatibility claim: the locale and the bundle sha it was built
		// from, the corpus statistics BM25 needs, the tuned weights, and the documents.
		const variable = new Set([
			'locale',
			'bundle',
			'n',
			'terms',
			'df',
			'f',
			'len',
			'totalLen',
			'w',
			'k1',
			'b',
			'docs',
		]);
		const fixed = Object.keys(header).filter((key) => !variable.has(key));
		expect([...fixed].sort()).toEqual(Object.keys(HEADER_FIELDS).sort());
	});

	test('the message names every field that disagrees, not only the first', () => {
		const broken = { ...fixture(), v: 99, norm: 'NFC' } as unknown as SearchIndex;
		expect(() => assertIndexCompatible(broken)).toThrow(/v is 99/);
		expect(() => assertIndexCompatible(broken)).toThrow(/norm is "NFC"/);
	});
});

describe('BM25 over three weighted fields', () => {
	test('a term in a title outranks the same term in a body', () => {
		const hits = searchIndex(fixture(), 'tag');
		expect(hits.map((hit) => hit.doc.slug)).toEqual(['a-basics', 'a-basics', 'b-guide']);
		// Three occurrences in a body still lose to one in a title, which is the whole
		// reason the weights are in the file.
		expect(hits[0]?.score).toBeGreaterThan(hits[2]?.score as number);
	});

	test('the score is the arithmetic the contract states', () => {
		const hits = searchIndex(fixture(), 'tag');
		expect(hits[0]?.score).toBeCloseTo(expected([['tag']], 1, 1), 12);
		expect(hits[2]?.score).toBeCloseTo(expected([['tag']], 0, 1), 12);
	});

	test('a section matching more of the query outranks one matching less of it', () => {
		// Document 0 holds both terms in its body and document 1 holds one of them in its
		// title. With one term the title wins; with two the coordination bonus turns it
		// over, which is what `or-coord` means.
		expect(identities(fixture(), 'tag')[0]).toBe('a-basics#_top');
		expect(identities(fixture(), 'tag ndef')).toEqual([
			'b-guide#_top',
			'a-basics#_top',
			'a-basics#about',
			'd-api#_top',
		]);
	});

	test('the coordination factor is the share of distinct query terms matched', () => {
		const hits = searchIndex(fixture(), 'tag ndef');
		const both = hits.find((hit) => hit.doc.slug === 'b-guide');
		const one = hits.find((hit) => hit.doc.anchor === 'about');
		expect(both?.score).toBeCloseTo(expected([['tag'], ['ndef']], 0, 2), 12);
		expect(one?.score).toBeCloseTo(expected([['tag'], ['ndef']], 4, 2), 12);
		// Halved, because it matched one of the two words the reader typed.
		expect(one?.score).toBeCloseTo(expected([['tag']], 4, 1) / 2, 12);
	});

	test('a repeated query term is one distinct term, not two', () => {
		expect(searchIndex(fixture(), 'tag tag')[0]?.score).toBeCloseTo(
			searchIndex(fixture(), 'tag')[0]?.score as number,
			12,
		);
	});

	test('a hit carries the dictionary terms it matched', () => {
		const hits = searchIndex(fixture(), 'ntag');
		expect(hits.find((hit) => hit.doc.slug === 'c-chips')?.terms).toEqual(['ntag', 'ntag213']);
		expect(hits.find((hit) => hit.doc.slug === 'b-guide')?.terms).toEqual(['ntag']);
	});

	test('a query with no terms, and one with no matches, return nothing', () => {
		expect(searchIndex(fixture(), '!!!')).toEqual([]);
		expect(searchIndex(fixture(), 'zzz')).toEqual([]);
	});

	test('an index with no sections returns nothing rather than dividing by zero', () => {
		const empty = fixture({
			n: 0,
			terms: '',
			df: [],
			f: {
				title: { cnt: [], post: [] },
				heading: { cnt: [], post: [] },
				body: { cnt: [], post: [] },
			},
			len: { title: [], heading: [], body: [] },
			totalLen: { title: 0, heading: 0, body: 0 },
			docs: [],
		});
		expect(validateSearchIndexShape(empty)).toEqual([]);
		expect(searchIndex(empty, 'tag')).toEqual([]);
	});

	test('a field with no lengths scores a number rather than NaN', () => {
		// A NaN score does not throw and does not sort last. It sorts wherever the
		// comparator puts it, so the ranking degrades in one locale with nothing to show
		// for it.
		const flat = fixture({
			len: { title: [0, 0, 0, 0, 0], heading: [0, 0, 0, 0, 0], body: [0, 0, 0, 0, 0] },
			totalLen: { title: 0, heading: 0, body: 0 },
		});
		expect(validateSearchIndexShape(flat)).toEqual([]);
		const hits = searchIndex(flat, 'tag');
		expect(hits.length).toBeGreaterThan(0);
		for (const hit of hits) expect(Number.isFinite(hit.score)).toBe(true);
	});
});

describe('prefix expansion completes the word the reader is still typing', () => {
	test('the last term matches every dictionary term it is a prefix of', () => {
		// `ntag213` is in the dictionary and `c-chips` holds no `ntag` posting at all, so
		// its presence here is the expansion and nothing else.
		const hits = searchIndex(fixture(), 'ntag');
		expect(hits.map((hit) => hit.doc.slug)).toEqual(['c-chips', 'b-guide']);
		expect(hits[0]?.score).toBeCloseTo(expected([['ntag', 'ntag213']], 2, 1), 12);
	});

	test('a prefix matching only the longer term finds only it', () => {
		expect(identities(fixture(), 'ntag2')).toEqual(['c-chips#ntag213']);
	});

	test('an expansion counts once for coordination, however many terms it reached', () => {
		const hits = searchIndex(fixture(), 'ntag');
		const chips = hits.find((hit) => hit.doc.slug === 'c-chips');
		// Two dictionary terms under one query term. A coordination count taken over
		// expansions would read 2/1 here and double the score.
		expect(chips?.terms).toEqual(['ntag', 'ntag213']);
		expect(chips?.score).toBeCloseTo(expected([['ntag', 'ntag213']], 2, 1), 12);
	});

	test('an expansion contributes its best term, not the sum of all of them', () => {
		// The coordination factor was credited with preventing this and cannot: it is a
		// divisor, and the numerator was the sum over every expansion. Measured on the real
		// English index before the fix, `password tag` put a section matching only
		// completions of `tag` and no `password` at all above a section matching both words
		// the reader typed.
		const chips = searchIndex(fixture(), 'ntag').find((hit) => hit.doc.slug === 'c-chips');
		const both = ['ntag', 'ntag213'].map((term) =>
			SEARCH_FIELDS.reduce((sum, field) => sum + contribution(term, field, 2), 0),
		);
		const [first = 0, second = 0] = both;
		// Both expansions really do hit this document, which is what makes the difference
		// between the sum and the best observable here at all.
		expect(first).toBeGreaterThan(0);
		expect(second).toBeGreaterThan(0);
		expect(chips?.score).toBeCloseTo(Math.max(first, second), 12);
		expect(chips?.score).toBeLessThan(first + second);
	});

	test('a term the reader finished typing is not expanded', () => {
		// `ntag2` is not in the dictionary and is not the last token, so it matches
		// nothing, and `c-chips` is absent even though a term does begin with it.
		const hits = searchIndex(fixture(), 'ntag2 tag');
		expect(hits.map((hit) => hit.doc.slug)).not.toContain('c-chips');
		expect(hits[0]?.score).toBeCloseTo(expected([['tag']], 1, 1) / 2, 12);
	});
});

describe('the audience mask filters rather than ranks', () => {
	test('a developer-only section is removed for a reader asking for user pages', () => {
		expect(identities(fixture(), 'ndef')).toEqual(['b-guide#_top', 'd-api#_top']);
		expect(identities(fixture(), 'ndef', { audience: AUDIENCE_MASK.user })).toEqual([
			'b-guide#_top',
		]);
	});

	test('a section marked both matches either audience', () => {
		expect(identities(fixture(), 'ndef', { audience: AUDIENCE_MASK.developer })).toEqual([
			'b-guide#_top',
			'd-api#_top',
		]);
	});

	test('a filter that removes everything returns nothing', () => {
		expect(searchIndex(fixture(), 'api', { audience: AUDIENCE_MASK.user })).toEqual([]);
	});
});

describe('ties break on identity, so the same query answers the same way twice', () => {
	test('equal scores order by slug and then by anchor, not by document id', () => {
		// Documents 0, 1 and 4 hold one occurrence of `nfc` in bodies of equal length, so
		// the three scores are identical and there is nothing left to prefer between them.
		// Without the tie-break the order falls out of the posting order, and a screenshot
		// in a bug report stops being reproducible.
		const hits = searchIndex(fixture(), 'nfc');
		const scores = hits.map((hit) => hit.score);
		expect(scores[0]).toBeCloseTo(scores[1] as number, 12);
		expect(scores[1]).toBeCloseTo(scores[2] as number, 12);
		expect(hits.map((hit) => `${hit.doc.slug}#${hit.doc.anchor}`)).toEqual([
			'a-basics#_top',
			'a-basics#about',
			'b-guide#_top',
		]);
	});

	test('the limit takes the head of that order', () => {
		const all = identities(fixture(), 'nfc');
		expect(identities(fixture(), 'nfc', { limit: 2 })).toEqual(all.slice(0, 2));
		expect(searchIndex(fixture(), 'nfc', { limit: 0 })).toEqual([]);
	});
});
