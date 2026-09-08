/**
 * Building one locale's search index.
 *
 * Sections rather than pages, which is the whole point: the corpus's most-searched page
 * is a thirty-four row support matrix, and a result that can only address the page has
 * not helped. A section is a heading and everything under it until the next heading,
 * plus one for the text above the first heading, which is `PAGE_ROOT_ANCHOR` rather
 * than the empty string for the reason the contract gives.
 *
 * Two decisions here are not derivable from the contract and would each be silent if
 * they were wrong.
 *
 * **A locale's index carries every page, including the ones with no translation.** The
 * site serves the source locale for those with a notice and `noindex`, so a reader in
 * French who searches for a page that exists only in English must find it. Those
 * sections are marked `missing`, which is exactly what that state is for: text in one
 * language sitting in another language's index.
 *
 * **A status glyph is indexed as a word in the locale's own language.** `ast.ts` names
 * this as one of the three things that break if a glyph stays text, and it is the one a
 * test cannot notice: a search for "supported" that matches no row looks like no
 * results rather than like a bug.
 */

import { AST_VERSION, type Block } from '../../../src/contracts/ast.js';
import { blockText, inlineText } from '../../../src/ast/text.js';
import type { TranslationState } from '../../../src/contracts/frontmatter.js';
import type { Locale } from '../../../src/contracts/locales.js';
import type { CompiledPage } from '../../../src/contracts/page.js';
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
	type IndexedTranslationState,
	type SearchDoc,
	type SearchField,
	type SearchIndex,
	type SearchPostings,
} from '../../../src/contracts/search.js';
import { tokenise } from '../../../src/search/tokenise.js';
import { statusLabel } from '../../../src/ui/status.js';

export interface IndexablePage {
	page: CompiledPage;
	/** The page's effective state in the locale being indexed. */
	state: TranslationState | 'fallback';
}

/**
 * The five states a page can be in, reduced to the three the index needs.
 *
 * The index only has to know whether to trust the text it holds. `scaffolded` is source
 * text under a translation's name, which is the same problem as a fallback from the
 * reader's point of view, so both land on the state that says the words are in the
 * wrong language.
 */
function indexedState(state: TranslationState | 'fallback'): IndexedTranslationState {
	if (state === 'source' || state === 'current') return 'current';
	if (state === 'stale') return 'stale';
	return 'missing';
}

interface Section {
	anchor: string;
	heading: string;
	depth: number;
	body: string;
}

/** Splits a page into its sections: the text above the first heading, then one each. */
export function sectionsOf(page: CompiledPage, locale: Locale): Section[] {
	const options = {
		code: true,
		status: (value: Parameters<typeof statusLabel>[1]) => statusLabel(locale, value),
	};
	const sections: Section[] = [{ anchor: PAGE_ROOT_ANCHOR, heading: '', depth: 0, body: '' }];
	const bodies: Block[][] = [[]];

	for (const block of page.body) {
		if (block.type === 'heading') {
			sections.push({
				anchor: block.id,
				heading: inlineText(block.children, options),
				depth: block.depth,
				body: '',
			});
			bodies.push([]);
			continue;
		}
		(bodies.at(-1) as Block[]).push(block);
	}

	for (const [index, section] of sections.entries()) {
		section.body = blockText(bodies[index] as Block[], options);
	}
	return sections;
}

interface Accumulator {
	/** Term to document id to term frequency, per field. */
	postings: Record<SearchField, Map<string, Map<number, number>>>;
	lengths: Record<SearchField, number[]>;
}

export interface BuildIndexOptions {
	locale: Locale;
	/** The publishing commit. There is no version label in a bundle and there cannot be. */
	commit: string;
	pages: readonly IndexablePage[];
}

export function buildSearchIndex(options: BuildIndexOptions): SearchIndex {
	const docs: SearchDoc[] = [];
	const accumulator: Accumulator = {
		postings: { title: new Map(), heading: new Map(), body: new Map() },
		lengths: { title: [], heading: [], body: [] },
	};

	for (const entry of options.pages) {
		const { page } = entry;
		const translated = indexedState(entry.state);
		for (const section of sectionsOf(page, options.locale)) {
			const id = docs.length;
			docs.push({
				slug: page.slug,
				anchor: section.anchor,
				// A page whose front matter failed to validate still compiles, and the index
				// requires a non-empty title. The slug is the honest fallback: it is what the
				// address says, and a blank result row is not something a reader can act on.
				title: page.title === '' ? page.slug : page.title,
				heading: section.heading,
				depth: section.depth,
				audience: AUDIENCE_MASK[page.audience],
				translated,
			});

			// `navTitle` and `tags` join the title field rather than getting a field of their
			// own. Both were written into the bundle and read by nothing: searching the
			// English corpus for "troubleshooting", "architecture" or "overview" returned
			// nothing, and each of those words is the page's own sidebar label. A sweep of
			// every locale found fifty such tokens absent, including the Chinese, Japanese,
			// Arabic and Portuguese words for "overview". `tags` was worse than absent,
			// because `DocFrontMatter` says of it "They feed search weighting", and it fed
			// none.
			//
			// One field, not four, for three reasons: navTitle and title are the same kind of
			// string so the weight is already right; a fourth member of `SEARCH_FIELDS` is a
			// wire change every reader of an index would have to understand, and the header
			// records the field list precisely so that cannot happen quietly; and the length
			// normalisation BM25 does over the title field is the thing that stops a page
			// with eight tags outranking one with a matching title.
			add(
				accumulator,
				'title',
				id,
				[page.title === '' ? page.slug : page.title, page.navTitle ?? '', ...page.tags]
					.filter((part) => part !== '')
					.join(' '),
			);
			add(accumulator, 'heading', id, section.heading);
			add(accumulator, 'body', id, section.body);
		}
	}

	const dictionary = [
		...new Set(SEARCH_FIELDS.flatMap((field) => [...accumulator.postings[field].keys()])),
	].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

	const df = dictionary.map((term) => {
		const ids = new Set<number>();
		for (const field of SEARCH_FIELDS) {
			for (const id of accumulator.postings[field].get(term)?.keys() ?? []) ids.add(id);
		}
		return ids.size;
	});

	const f = {} as Record<SearchField, SearchPostings>;
	const len = {} as Record<SearchField, number[]>;
	const totalLen = {} as Record<SearchField, number>;
	for (const field of SEARCH_FIELDS) {
		f[field] = encode(dictionary, accumulator.postings[field]);
		len[field] = accumulator.lengths[field];
		totalLen[field] = accumulator.lengths[field].reduce((total, value) => total + value, 0);
	}

	const index: SearchIndex = {
		kind: SEARCH_INDEX_KIND,
		v: SEARCH_INDEX_VERSION,
		ast: AST_VERSION,
		tokeniser: TOKENISER_VERSION,
		norm: INDEX_NORMALISATION,
		stem: false,
		match: 'or-coord',
		locale: options.locale,
		bundle: options.commit,
		n: docs.length,
		terms: dictionary.join('\n'),
		df,
		f,
		len,
		totalLen,
		w: { ...DEFAULT_FIELD_WEIGHTS },
		k1: DEFAULT_K1,
		b: DEFAULT_B,
		docs,
	};

	// The builder asserts its own output rather than leaving it to the reader. Every
	// failure in this subsystem is silent: a truncated postings array does not throw, it
	// ranks the wrong sections in one language that nobody here reads.
	const problems = validateSearchIndexShape(index);
	if (problems.length > 0) {
		throw new Error(
			`The ${options.locale} search index is malformed, which is a bug in the builder rather than in the corpus:\n  ${problems.join('\n  ')}`,
		);
	}

	return index;
}

function add(accumulator: Accumulator, field: SearchField, id: number, text: string): void {
	const terms = tokenise(text);
	accumulator.lengths[field][id] = terms.length;
	if (terms.length === 0) return;
	const postings = accumulator.postings[field];
	for (const term of terms) {
		const byDoc = postings.get(term) ?? new Map<number, number>();
		byDoc.set(id, (byDoc.get(id) ?? 0) + 1);
		postings.set(term, byDoc);
	}
}

/**
 * The columnar encoding: one count per term, then consecutive `(docDelta, tf)` pairs.
 *
 * Counts rather than offsets, because counts serialise as smaller numbers and gzip
 * rewards that, and because the length invariant becomes one comparison rather than a
 * scan. Deltas are relative within a term's slice and the first is absolute.
 */
function encode(
	dictionary: readonly string[],
	postings: ReadonlyMap<string, Map<number, number>>,
): SearchPostings {
	const cnt: number[] = [];
	const post: number[] = [];

	for (const term of dictionary) {
		const byDoc = postings.get(term);
		if (byDoc === undefined) {
			cnt.push(0);
			continue;
		}
		const ids = [...byDoc.keys()].sort((a, b) => a - b);
		cnt.push(ids.length);
		let previous = 0;
		for (const [position, id] of ids.entries()) {
			post.push(position === 0 ? id : id - previous, byDoc.get(id) as number);
			previous = id;
		}
	}

	return { cnt, post };
}
