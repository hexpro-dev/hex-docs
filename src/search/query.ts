/**
 * The client half of search: refuse an index this runtime does not understand, then
 * score it.
 *
 * BM25 over three weighted fields, with the parameters read out of the index rather
 * than held here. That is the whole reason they are in the file: a labelled bundle was
 * pinned by somebody precisely so it would not change, and a weight that lived in the
 * client would silently re-rank every already-published bundle the day it moved.
 *
 * The arithmetic is written out in `score` rather than folded into one expression,
 * because a second implementation has to be able to agree with this one term by term.
 */

import { AST_VERSION } from '../contracts/ast.js';
import {
	INDEX_NORMALISATION,
	MATCH_MODES,
	SEARCH_FIELDS,
	SEARCH_INDEX_KIND,
	SEARCH_INDEX_VERSION,
	TOKENISER_VERSION,
	type AudienceMask,
	type SearchDoc,
	type SearchField,
	type SearchIndex,
} from '../contracts/search.js';
import { tokeniseQuery } from './tokenise.js';

/** The only mode this client scores. `MATCH_MODES` is the closed union it comes from. */
const SUPPORTED_MATCH_MODE = MATCH_MODES[0];

export interface SearchHit {
	doc: SearchDoc;
	score: number;
	/**
	 * The dictionary terms this section matched, ascending by code unit.
	 *
	 * Dictionary terms rather than query terms, because the caller highlights with
	 * them: a reader who typed `ntag` and matched `ntag213` wants the word that is
	 * actually on the page marked, not the four letters they had finished typing.
	 */
	terms: string[];
}

interface HeaderExpectation {
	field: string;
	found: unknown;
	expected: unknown;
}

function headerExpectations(index: SearchIndex): HeaderExpectation[] {
	return [
		{ field: 'kind', found: index.kind, expected: SEARCH_INDEX_KIND },
		{ field: 'v', found: index.v, expected: SEARCH_INDEX_VERSION },
		{ field: 'ast', found: index.ast, expected: AST_VERSION },
		{ field: 'tokeniser', found: index.tokeniser, expected: TOKENISER_VERSION },
		{ field: 'norm', found: index.norm, expected: INDEX_NORMALISATION },
		{ field: 'match', found: index.match, expected: SUPPORTED_MATCH_MODE },
		// The seventh, and it was the one missing. `stem` says how terms were produced, and
		// `TOKENISER_VERSION`'s documented bump triggers are normalisation, the word
		// character table, the bigram rule and the Arabic folding, none of which is
		// stemming. So a toolchain that added a stemmer could ship `stem: true` at the same
		// tokeniser version and this runtime accepted it: measured on the real English
		// index, `assertIndexCompatible` returned and `searchIndex(index, 'tag')` scored 38
		// hits. A genuinely stemmed index queried with unstemmed tokens returns nothing for
		// most queries, silently, which is the whole failure class this header exists to
		// make loud.
		{ field: 'stem', found: index.stem, expected: false },
	];
}

/**
 * Refuses an index this runtime cannot query, naming every field that disagrees.
 *
 * Every failure in search is silent. An index built with one tokeniser and scored with
 * another returns nothing, with no error, in one language, and never on the machine of
 * the person who changed the tokeniser. So the header is compared once, loudly, at
 * load, and the alternative to throwing is a page that renders a working search box
 * over an index it is quietly misreading.
 *
 * The types say these comparisons cannot fail. They can: an index arrives from
 * `JSON.parse` over a file written by a different commit of the toolchain, and the
 * declared literals are what that file is being checked against.
 */
export function assertIndexCompatible(index: SearchIndex): void {
	const mismatched: string[] = [];

	for (const { field, found, expected } of headerExpectations(index)) {
		if (found !== expected) {
			mismatched.push(`${field} is ${JSON.stringify(found)}, expected ${JSON.stringify(expected)}`);
		}
	}

	if (mismatched.length === 0) return;

	throw new Error(
		`This search index cannot be queried by this runtime: ${mismatched.join('; ')}. ` +
			`Rebuild the bundle, or mount the version of this package that built it.`,
	);
}

/**
 * The dictionary, decoded.
 *
 * An empty dictionary is the empty string, and `''.split('\n')` is `['']`: a one-term
 * dictionary whose only term is empty, which every prefix walk matches and which has no
 * `df` entry behind it.
 */
export function decodeTerms(index: SearchIndex): string[] {
	return index.terms === '' ? [] : index.terms.split('\n');
}

/**
 * Fills one value per field from the closed union.
 *
 * The cast is filled on the next line by iterating `SEARCH_FIELDS`, so a field added to
 * that union arrives here without an edit. A hand-written object literal would compile
 * with a field missing only until someone widened the union, and the missing entry
 * would be `undefined` in the arithmetic, which is `NaN`, which sorts a section
 * wherever the comparator happens to put it.
 */
function perField<T>(compute: (field: SearchField) => T): Record<SearchField, T> {
	const out = {} as Record<SearchField, T>;
	for (const field of SEARCH_FIELDS) out[field] = compute(field);
	return out;
}

/**
 * Where each term's postings start, in `post` array positions.
 *
 * `cnt` is postings-per-term, so the starts are a prefix sum doubled: the pairs are
 * `(docDelta, tf)`.
 */
function postingStarts(counts: readonly number[]): number[] {
	const starts: number[] = [];
	let cursor = 0;
	for (const count of counts) {
		starts.push(cursor);
		cursor += count * 2;
	}
	return starts;
}

/** The first dictionary position at or after `prefix`. The dictionary is sorted. */
function lowerBound(dictionary: readonly string[], prefix: string): number {
	let low = 0;
	let high = dictionary.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if ((dictionary[mid] as string) < prefix) low = mid + 1;
		else high = mid;
	}
	return low;
}

/**
 * Every dictionary position whose term starts with `prefix`, including an exact match.
 *
 * A binary search for the lower bound and a walk forward while the prefix holds. This
 * is the only reason the dictionary's sort order is load-bearing, and why it is sorted
 * by code unit rather than by `localeCompare`: an encoder whose order depended on the
 * runner's locale would produce a different bundle sha on a different machine, and a
 * dictionary sorted any other way makes this walk stop early and silently miss
 * completions rather than fail.
 */
function expandPrefix(dictionary: readonly string[], prefix: string): number[] {
	const found: number[] = [];
	for (let i = lowerBound(dictionary, prefix); i < dictionary.length; i += 1) {
		if (!(dictionary[i] as string).startsWith(prefix)) break;
		found.push(i);
	}
	return found;
}

/**
 * Ranked sections for a query.
 *
 * `or-coord`, which is what the index header declares: a disjunction, with the total
 * multiplied by the share of the query's distinct terms a section matched.
 */
export function searchIndex(
	index: SearchIndex,
	query: string,
	options: { audience?: AudienceMask; limit?: number } = {},
): SearchHit[] {
	// Checked here as well as at load, because there is no path on which scoring an
	// index whose header disagrees produces anything but a wrong answer that looks
	// like a right one.
	assertIndexCompatible(index);

	const tokens = tokeniseQuery(query);
	if (tokens.length === 0 || index.n === 0) return [];

	const dictionary = decodeTerms(index);
	const positions = new Map<string, number>();
	for (const [position, term] of dictionary.entries()) positions.set(term, position);

	// Only the last token is expanded. The reader is still typing that one; the earlier
	// ones they finished, and expanding a finished word turns `tag ndef` into a query
	// that also matches every term beginning with `ndef`, which is not what was asked.
	const last = tokens[tokens.length - 1] as string;
	const distinct = [...new Set(tokens)];

	const averageLength = perField((field) => index.totalLen[field] / index.n);
	const starts = perField((field) => postingStarts(index.f[field].cnt));

	const wanted = options.audience;
	const totals = new Map<number, number>();
	const matchedTokens = new Map<number, Set<string>>();
	const matchedTerms = new Map<number, Set<string>>();

	for (const token of distinct) {
		const expansion = token === last ? expandPrefix(dictionary, token) : exactly(positions, token);

		// Per document, the best single expansion of this token rather than the sum of all
		// of them. Summing is what made a one-word query that completes to forty terms score
		// like a forty-term query matched in full: measured on the English index, `password
		// tag` put `developer/architecture#where-a-scan-happens` at rank 3 with 4.25 on
		// `tag, tagcodec, tagerror, tagrecord, tagsession` and no `password` at all, above
		// `guide/first-tag#before-you-start` at 3.13 with both words the reader typed. The
		// comment below used to claim the coordination factor prevented exactly that; it
		// cannot, because it is a divisor and the numerator was the inflated sum.
		//
		// Taking the best is the standard treatment for prefix and wildcard expansion. A
		// token that is not the last one expands to exactly itself, so nothing changes for
		// the words the reader has finished typing.
		const best = new Map<number, number>();

		for (const position of expansion) {
			const term = dictionary[position] as string;
			const df = index.df[position] as number;
			// `validateSearchIndexShape` is what keeps df inside [1, n]. Above n the
			// logarithm's argument drops below 1 and the idf goes negative, so a matched
			// term would subtract from a section's score instead of failing.
			const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));

			/** This one dictionary term's contribution per document, summed across fields. */
			const perTerm = new Map<number, number>();

			for (const field of SEARCH_FIELDS) {
				const postings = index.f[field];
				const count = postings.cnt[position] as number;
				let cursor = starts[field][position] as number;
				let doc = 0;

				for (let i = 0; i < count; i += 1) {
					const delta = postings.post[cursor] as number;
					const tf = postings.post[cursor + 1] as number;
					cursor += 2;
					// The first delta in a term's slice is an absolute document id and every
					// later one is a gap of at least 1.
					doc = i === 0 ? delta : doc + delta;

					const record = index.docs[doc] as SearchDoc;
					// Audience is a filter, never a ranking signal: a section the reader may
					// not see is removed, not demoted.
					if (wanted !== undefined && (record.audience & wanted) === 0) continue;

					const average = averageLength[field];
					// A field that is empty in every section has an average length of zero,
					// and `len / 0` is NaN. NaN does not throw and does not sort last: it
					// sorts wherever the comparator puts it, so the ranking degrades in one
					// locale with nothing to show for it. Treating the ratio as 1 makes the
					// length normalisation a no-op, which is what a field with no lengths
					// deserves.
					const ratio = average === 0 ? 1 : (index.len[field][doc] as number) / average;
					const tfNorm = (tf * (index.k1 + 1)) / (tf + index.k1 * (1 - index.b + index.b * ratio));

					// The fields of one term do sum: a word in the title and in the body of the
					// same section is two pieces of evidence about that section. It is across
					// expansions of one token that the maximum is taken, below.
					perTerm.set(doc, (perTerm.get(doc) ?? 0) + index.w[field] * idf * tfNorm);
					// Under the query term, not under the dictionary term it expanded to, so
					// the coordination factor counts the words the reader typed. `matchedTerms`
					// keeps every expansion, because that is what the caller highlights: the
					// words actually on the page, not the four letters typed so far.
					add(matchedTokens, doc, token);
					add(matchedTerms, doc, term);
				}
			}

			for (const [doc, value] of perTerm) {
				if (value > (best.get(doc) ?? 0)) best.set(doc, value);
			}
		}

		for (const [doc, value] of best) totals.set(doc, (totals.get(doc) ?? 0) + value);
	}

	const hits: SearchHit[] = [];
	for (const [doc, total] of totals) {
		const coordination = (matchedTokens.get(doc) as Set<string>).size / distinct.length;
		hits.push({
			doc: index.docs[doc] as SearchDoc,
			score: total * coordination,
			// The default sort is by code unit, which is the order the dictionary is in.
			terms: [...(matchedTerms.get(doc) as Set<string>)].sort(),
		});
	}

	hits.sort(byScoreThenIdentity);

	return options.limit === undefined ? hits : hits.slice(0, options.limit);
}

function exactly(positions: ReadonlyMap<string, number>, term: string): number[] {
	const position = positions.get(term);
	return position === undefined ? [] : [position];
}

function add(map: Map<number, Set<string>>, doc: number, value: string): void {
	const found = map.get(doc);
	if (found === undefined) map.set(doc, new Set([value]));
	else found.add(value);
}

/**
 * Score descending, then `(slug, anchor)` ascending by code unit.
 *
 * Ties are ordinary here: two sections of equal length holding one occurrence of the
 * same term score identically, and there is nothing left to prefer between them. What
 * cannot be ordinary is the answer changing. Without a tie-break the order falls out of
 * the engine's sort and the posting order behind it, so the same query returns the same
 * results in a different order in a different browser, and a screenshot in a bug report
 * stops being reproducible.
 *
 * The joiner is U+000A, which is below every character a slug or a heading id can
 * contain, so comparing the joined strings is comparing the pair.
 *
 * The last arm is unreachable while the index is valid: identity is the `(slug, anchor)`
 * pair and `validateSearchIndexShape` refuses a duplicate. It is here because a
 * comparator that is not a total order gives an implementation-defined ordering, which
 * is the thing the other two arms exist to remove.
 */
function byScoreThenIdentity(left: SearchHit, right: SearchHit): number {
	if (right.score !== left.score) return right.score - left.score;
	const a = `${left.doc.slug}\n${left.doc.anchor}`;
	const b = `${right.doc.slug}\n${right.doc.anchor}`;
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
