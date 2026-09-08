/**
 * The search index format.
 *
 * Every failure mode in this subsystem is silent. An index built with one tokeniser
 * and queried with another returns nothing, with no error, in one language, and never
 * on the machine of the person who changed the tokeniser. So the header records
 * everything the two halves could disagree about, and the runtime refuses at load
 * rather than scoring an index it does not understand.
 *
 * The index is built by Node in a GitHub Action and queried by the same functions in
 * a browser. That is the whole reason the parameters live in the file: if the weights
 * lived in the client, changing one would silently re-rank every already-published
 * bundle, including labelled versions somebody pinned precisely so they would not
 * change.
 *
 * Layout is columnar JSON rather than a hand-rolled binary format. Gzip does well on
 * runs of small integers, and a binary codec would have to be written twice, once in
 * the compiler and once in a zero-dependency runtime, which is two chances to disagree
 * about the same bytes.
 */

import type { AstVersion } from './ast.js';
import type { Locale } from './locales.js';

/** Refuses to be anything else: a mis-globbed page AST would otherwise score as empty. */
export const SEARCH_INDEX_KIND = 'hexdocs.index';

/** The index format version. Independent of the AST major. */
export const SEARCH_INDEX_VERSION = 1;

/**
 * The tokeniser identity.
 *
 * Bumped by any change to normalisation, the word-character table, the bigram rule, the
 * Arabic folding or the character classification. The runtime refuses an index built by a
 * tokeniser it does not implement, which converts the worst class of bug here,
 * correct-looking empty results in one language, into a loud failure at load.
 *
 * 2: `classify` tested Script_Extensions alone for the CJK arm, which is not a letter
 * test, so U+3002, U+3001, U+300C, U+300D and U+30FB joined the CJK run beside them
 * instead of ending it. 127 of 2709 Chinese terms and 221 of 3048 Japanese terms in the
 * corpus were punctuation bigrams, and `countWords` counted them. The arm is now
 * intersected with the word-character table, which changes term spellings in two
 * languages, which is exactly what this number is for.
 */
export const TOKENISER_VERSION = 2;

/**
 * The normalisation form applied to index text and to every query, before
 * tokenisation.
 *
 * NFKC rather than the NFC the plan named, on measured evidence from the corpus: the
 * same product name is spelled `NTAG 210µ` with U+00B5 MICRO SIGN in the chip matrix
 * and `NTAG210μ` with U+03BC GREEK SMALL LETTER MU in the store listing. NFC keeps
 * those distinct and a reader who types one never finds the other. NFKC also folds the
 * fullwidth forms that appear in the Japanese legal documents, and it subsumes the
 * compatibility folding the plan already required for Arabic.
 *
 * It is applied to tokeniser input only. Displayed text is never normalised: the
 * corpus carries U+FE0F and U+200F that are load-bearing on the page.
 *
 * Folding does not fix a difference in tokenisation, only in code points. `NTAG 210µ`
 * still tokenises to two terms and `NTAG210μ` to one, so a project that spells a part
 * number two ways still needs the glossary entry that pins one spelling.
 */
export const NORMALISATION_FORMS = ['NFC', 'NFKC'] as const;

export type NormalisationForm = (typeof NORMALISATION_FORMS)[number];

export const INDEX_NORMALISATION: NormalisationForm = 'NFKC';

/**
 * The three scored fields, weighted separately.
 *
 * One closed union keys `f`, `len`, `totalLen` and `w`. A field present in one map and
 * absent from another would produce `undefined` in the BM25 arithmetic, which is
 * `NaN`, which sorts a section last rather than throwing.
 */
export const SEARCH_FIELDS = ['title', 'heading', 'body'] as const;

export type SearchField = (typeof SEARCH_FIELDS)[number];

/**
 * The anchor for the text above a page's first heading.
 *
 * A declared sentinel, not the empty string. This is the same lesson as the section
 * root slug: a value that fails its own validity rule has to be special-cased at every
 * call site, and one of them eventually forgets.
 */
export const PAGE_ROOT_ANCHOR = '_top';

/**
 * How multiple query terms combine.
 *
 * Recorded rather than assumed, because a compiler and a client written months apart
 * will each pick a sensible default and they will not be the same one.
 *
 * `or-coord` is a disjunction with a coordination bonus for sections matching more of
 * the query. Note what the format cannot do: postings carry no positions, so phrase
 * and adjacency queries are not expressible. In particular, two overlapping CJK
 * bigrams both matching a section does **not** mean they were adjacent in it, and a
 * quoted-phrase interface built over this format would be answering a question the
 * data cannot answer.
 */
export const MATCH_MODES = ['or-coord'] as const;

export type MatchMode = (typeof MATCH_MODES)[number];

/**
 * Audience as a bitmask: `user` 1, `developer` 2, `both` 3. Zero is forbidden.
 *
 * A mask makes `both` structural. Filtering is `record.audience & wanted`, with no
 * call site having to remember that one enum member means "match either of the other
 * two". Audience is a filter rather than a ranking signal, so getting it wrong does
 * not degrade an ordering, it removes results and the reader sees an empty page.
 */
export const AUDIENCE_MASK = { user: 1, developer: 2, both: 3 } as const;

export type AudienceMask = (typeof AUDIENCE_MASK)[keyof typeof AUDIENCE_MASK];

/**
 * A section's translation state, as the index carries it.
 *
 * Three states, not the five the manifest uses: the index only needs to know whether
 * to trust the text it holds. `missing` covers a section whose text is an English
 * fallback inside a non-English bundle, which matters because that English was
 * tokenised by the Latin path and sits in, say, the Japanese index where no Japanese
 * query will ever reach it.
 */
export const INDEXED_TRANSLATION_STATES = ['current', 'stale', 'missing'] as const;

export type IndexedTranslationState = (typeof INDEXED_TRANSLATION_STATES)[number];

/**
 * One section. Its position in the array is its document id.
 *
 * Identity is the `(slug, anchor)` pair, unique across the array. Sections rather than
 * pages is the whole point: the corpus's most-searched page is a thirty-four row
 * support matrix, and a result that can only address the page has not helped.
 */
export interface SearchDoc {
	slug: string;
	/** A heading id from the page, or `PAGE_ROOT_ANCHOR`. */
	anchor: string;
	/** The page title, repeated per section so a result renders without a second lookup. */
	title: string;
	/** This section's own heading text. Empty for the page-root section. */
	heading: string;
	depth: number;
	audience: AudienceMask;
	translated: IndexedTranslationState;
}

/**
 * One field's postings, in three parallel columnar arrays.
 *
 * `cnt` holds postings-per-term rather than offsets: the decoder prefix-sums them.
 * Counts serialise as smaller numbers, which is what gzip rewards, and they make the
 * length invariant one comparison rather than a scan.
 */
export interface SearchPostings {
	/** Length exactly `terms.length`. Each element >= 0. */
	cnt: number[];
	/**
	 * Length exactly `2 * sum(cnt)`. Consecutive `(docDelta, tf)` pairs.
	 *
	 * Within one term's slice the first `docDelta` is an absolute document id and every
	 * later one is at least 1, so decoded ids strictly ascend and every one is below
	 * `n`. `tf` is always at least 1.
	 *
	 * `validateSearchIndexShape` decodes and checks all of that. It has to: a zero delta
	 * is a duplicated posting, which double-counts a term's frequency in BM25, and an
	 * out-of-range id dereferences `docs[i]` as `undefined` while rendering a result.
	 * Neither throws. Both produce a wrong ranking in one language that nobody here
	 * reads.
	 */
	post: number[];
}

export interface SearchIndex {
	kind: typeof SEARCH_INDEX_KIND;
	v: typeof SEARCH_INDEX_VERSION;
	/**
	 * The AST major, pinned exactly like every sibling version field on this object.
	 *
	 * Typed as the literal rather than `number` so the schema can be a literal too. A
	 * bare `number` would force the schema looser than the type it mirrors, and an index
	 * globbed out of an `ast-2` prefix would load into an `ast-1` runtime, which is the
	 * one thing the key namespace exists to make impossible.
	 */
	ast: AstVersion;
	tokeniser: typeof TOKENISER_VERSION;
	norm: NormalisationForm;
	/** Always false. Prefix matching does the same work with fewer surprises. */
	stem: false;
	match: MatchMode;

	locale: Locale;
	/**
	 * The publishing commit, 40 lower-case hex.
	 *
	 * There is no version label anywhere in this file, and there cannot be. The bundle
	 * is written on every push to `main`, before any label exists, and it is write-once.
	 * A label inside it would either always be absent or force an immutable object to be
	 * rewritten the day the web repository labels the sha, and two sites may label the
	 * same sha differently.
	 */
	bundle: string;

	/** The number of sections. Every array length below is checked against it. */
	n: number;

	/**
	 * The dictionary: terms joined by `\n`.
	 *
	 * Strictly ascending by UTF-16 code unit, not by `localeCompare`. Sorted order is
	 * load-bearing, because prefix expansion is a binary search for the lower bound
	 * followed by a linear walk, and unsorted input silently misses completions rather
	 * than failing. `localeCompare` would also make the encoder locale-dependent, and
	 * therefore make the bundle sha change between runners.
	 *
	 * An empty dictionary is the empty string, which must not decode to `['']`.
	 */
	terms: string;
	/**
	 * Document frequency per term. Length exactly `T`, each element in `[1, n]`.
	 *
	 * Outside that range the idf goes negative or `NaN`. `validateSearchIndexShape` also
	 * asserts that each entry equals the size of the union of document ids for that term
	 * across all fields, which is the one check that catches a builder that filled
	 * postings and frequencies in two passes that disagree. That sentence sat here for a
	 * while describing a check nothing performed, which is the worse half: it is how the
	 * invariant gets relied on.
	 */
	df: number[];

	f: Record<SearchField, SearchPostings>;
	/** Token count of each field in each section. Length exactly `n`. */
	len: Record<SearchField, number[]>;
	/**
	 * The sum of `len[field]`, as an integer.
	 *
	 * Not the average. A float that came out of a division is not byte-stable across
	 * platforms, and the bundle sha is what change detection compares, so a
	 * non-deterministic encoder reports a deploy on every build. The reader divides.
	 */
	totalLen: Record<SearchField, number>;

	/** Field weights, and the two BM25 parameters. In the file, not in the client. */
	w: Record<SearchField, number>;
	/** `(0, 10]`. */
	k1: number;
	/** `[0, 1]`. */
	b: number;

	docs: SearchDoc[];
}

export const DEFAULT_FIELD_WEIGHTS: Record<SearchField, number> = {
	title: 4,
	heading: 2,
	body: 1,
};

export const DEFAULT_K1 = 1.2;
export const DEFAULT_B = 0.75;

/**
 * The length relationships, which a schema cannot express and which are the whole
 * reason this format is checkable at all.
 *
 * It lives in the runtime half rather than in the toolchain because both sides need
 * it: the compiler asserts before uploading, and the client asserts once at load.
 * Every failure in search is silent, so a truncated array does not throw, it scores
 * the wrong sections and somebody notices the ranking six months later.
 */
function decodePostings(
	field: SearchField,
	postings: SearchPostings,
	n: number,
): string | undefined {
	let cursor = 0;
	for (const [term, count] of postings.cnt.entries()) {
		let id = 0;
		for (let i = 0; i < count; i += 1) {
			const delta = postings.post[cursor] as number;
			const tf = postings.post[cursor + 1] as number;
			cursor += 2;

			if (i === 0) {
				if (delta < 0 || delta >= n) {
					return `f.${field} term ${term} starts at document ${delta}, which is outside [0, ${n}).`;
				}
				id = delta;
			} else {
				if (delta < 1) {
					return (
						`f.${field} term ${term} has a delta of ${delta} at posting ${i}. ` +
						`A delta below 1 is a duplicated posting, which double-counts that term's frequency.`
					);
				}
				id += delta;
				if (id >= n) {
					return `f.${field} term ${term} reaches document ${id} at posting ${i}, but n is ${n}.`;
				}
			}

			if (tf < 1) {
				return `f.${field} term ${term} has a term frequency of ${tf} at posting ${i}. A posting with no occurrences should not exist.`;
			}
		}
	}
	return undefined;
}

export function validateSearchIndexShape(index: SearchIndex): string[] {
	const problems: string[] = [];
	// An empty dictionary is the empty string, and must not decode to [''].
	const terms = index.terms === '' ? [] : index.terms.split('\n');
	const termCount = terms.length;

	if (index.df.length !== termCount) {
		problems.push(`df has ${index.df.length} entries for ${termCount} terms.`);
	}
	if (index.docs.length !== index.n) {
		problems.push(`docs has ${index.docs.length} entries but n is ${index.n}.`);
	}
	for (let i = 1; i < termCount; i += 1) {
		if ((terms[i - 1] as string) >= (terms[i] as string)) {
			problems.push(
				`terms are not strictly ascending at index ${i} ("${terms[i - 1]}" then "${terms[i]}"). ` +
					`Prefix expansion binary-searches this dictionary, so unsorted input silently misses completions.`,
			);
			break;
		}
	}
	for (const field of SEARCH_FIELDS) {
		const postings = index.f[field];
		if (postings.cnt.length !== termCount) {
			problems.push(`f.${field}.cnt has ${postings.cnt.length} entries for ${termCount} terms.`);
		}
		// The sign check comes before the length identity, because a negative count
		// cancels part of a positive one and the identity then holds on an index whose
		// term slices are all shifted. The decoder walks the shifted slices and reports
		// a delta problem against the wrong term, which is a message that sends the
		// reader to a term that is fine.
		const negative = postings.cnt.findIndex((value) => value < 0);
		if (negative !== -1) {
			problems.push(
				`f.${field}.cnt is ${postings.cnt[negative]} at term ${negative}. A count below zero ` +
					`shifts every later term's slice while leaving sum(cnt) * 2 satisfiable.`,
			);
		}
		const expected = postings.cnt.reduce((total, value) => total + value, 0) * 2;
		if (postings.post.length !== expected) {
			problems.push(
				`f.${field}.post has ${postings.post.length} entries; sum(cnt) * 2 is ${expected}.`,
			);
		}
		if (index.len[field].length !== index.n) {
			problems.push(`len.${field} has ${index.len[field].length} entries but n is ${index.n}.`);
		}

		// `totalLen` is what the reader divides by `n` to get the average document
		// length, which is the whole reason BM25 was chosen over tf-idf. A wrong value
		// does not throw: it collapses every length-normalisation term toward 1 and
		// ranks by raw term frequency, for the entire locale.
		const measured = index.len[field].reduce((total, value) => total + value, 0);
		if (measured !== index.totalLen[field]) {
			problems.push(
				`totalLen.${field} is ${index.totalLen[field]}, but len.${field} sums to ${measured}. ` +
					`avgdl would be wrong for every section in this locale.`,
			);
		}

		// Decode the postings. One problem per field: a broken index should say what is
		// wrong once, not once per posting.
		//
		// Skipped when the length identity or the sign check already failed, because the
		// decoder would then be walking slices it cannot trust and would report a
		// document id or a delta about a posting that does not exist. The useful message
		// is the one above. `test/contracts/search.test.ts` pins the count of f.<field>
		// problems at one for a truncated index, which is what fails if this guard goes.
		if (postings.post.length === expected && negative === -1) {
			const problem = decodePostings(field, postings, index.n);
			if (problem !== undefined) problems.push(problem);
		}
	}
	// Both bounds, not just the upper one. A df of zero divides by zero in the idf and
	// a df above n makes the logarithm's argument negative, and neither throws: one
	// produces Infinity and the other NaN, and a NaN score sorts wherever the comparator
	// happens to put it.
	for (const value of index.df) {
		if (value < 1 || value > index.n) {
			problems.push(
				`df contains ${value}, which is outside [1, ${index.n}]. idf would be NaN or negative.`,
			);
			break;
		}
	}

	// The check `df`'s own contract has always claimed and nothing performed. `df` is
	// computed in one pass over the postings and the postings are written in another, so
	// the two can disagree with nothing to notice: a df above the true union inflates
	// every idf for that term and a df below it deflates them, and neither throws, sorts
	// last, or shows up as anything but slightly wrong ranking in one language.
	//
	// Only when every field decoded cleanly. A truncated or corrupt posting list is
	// already reported above, and walking it again here would add a second problem about
	// the same bytes and bury the first.
	if (problems.length === 0) {
		for (const [term, expectedDf] of index.df.entries()) {
			const ids = new Set<number>();
			for (const field of SEARCH_FIELDS) {
				const postings = index.f[field];
				// Indexed without a fallback, because `cnt.length` against the term count is
				// checked above and a mismatch there leaves `problems` non-empty, so this
				// block never runs on a short array. A `?? 0` here would be a branch nothing
				// can reach, which is a guard that reads as protection and is not.
				const count = postings.cnt[term] as number;
				let cursor = 0;
				for (let earlier = 0; earlier < term; earlier += 1) {
					cursor += (postings.cnt[earlier] as number) * 2;
				}
				let id = 0;
				for (let i = 0; i < count; i += 1) {
					const delta = postings.post[cursor] as number;
					cursor += 2;
					id = i === 0 ? delta : id + delta;
					ids.add(id);
				}
			}
			if (ids.size !== expectedDf) {
				problems.push(
					`df[${term}] is ${expectedDf} and the postings name ${ids.size} distinct documents. ` +
						`The frequencies and the postings were filled in two passes that disagree, so every ` +
						`idf for that term is wrong.`,
				);
				break;
			}
		}
	}

	const seen = new Set<string>();
	for (const doc of index.docs) {
		const key = `${doc.slug}#${doc.anchor}`;
		if (seen.has(key)) {
			problems.push(`docs contains "${key}" twice. Section identity is the (slug, anchor) pair.`);
			break;
		}
		seen.add(key);
	}

	return problems;
}

// ---------------------------------------------------------------------------
// Reserved for the semantic tier
// ---------------------------------------------------------------------------

/**
 * Quantisations a vector sidecar may use. Declared now, emitted by nothing.
 *
 * The semantic tier is designed and shipped off. Reserving the closed enums means a
 * later toolchain can start writing vectors without a format change, and means a
 * bundle built against one embedding model is refused rather than silently compared
 * against another model's vectors, which produces confident nonsense.
 */
export const VECTOR_QUANTISATIONS = ['int8', 'float32'] as const;

export type VectorQuantisation = (typeof VECTOR_QUANTISATIONS)[number];

export interface EmbeddingModelRef {
	/** `BAAI/bge-m3`. */
	id: string;
	/** 1024 for bge-m3. */
	dimensions: number;
	quantisation: VectorQuantisation;
	/** The revision the vectors were produced with, when the host reports one. */
	revision: string | null;
}
