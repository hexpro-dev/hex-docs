/**
 * The search index, built over the real corpus and read back the way a browser reads it.
 *
 * Every failure in this subsystem is silent. A builder whose two passes disagree does not
 * throw, it ranks the wrong sections; a dictionary sorted by `localeCompare` does not
 * throw, it makes prefix expansion stop early and miss completions; a status glyph left
 * as text does not throw, it makes a search for "supported" match no row and look like no
 * results. So nothing here asserts that the builder ran. Everything asserts what came out,
 * decoded independently of the code that encoded it.
 *
 * There are no findings in this subsystem and therefore no line numbers to assert. The
 * positional claim a search index makes instead is document identity: a document id is a
 * position in `docs`, every posting is a reference to one, and a section that moves takes
 * every posting with it. So `docs` is asserted in full and in order, derived from
 * `sectionsOf`, rather than by count.
 *
 * The indexes under test are the ones the build actually published: they are read back out
 * of the gzip members `buildBundle` returns, so the fallback wiring, the state reduction
 * and the canonical JSON are all in the path. The one exception is the columnar encoding,
 * which is built from two hand-made pages whose every posting is worked out by hand in the
 * expectation table, because the corpus cannot say what the pairs should be.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
	FIXTURE_PAGES,
	contentPath,
	materialiseCorpus,
	readAppFile,
	snippetPath,
	type FixturePage,
	type MaterialisedCorpus,
} from '../../../fixtures/index.js';
import {
	AST_VERSION,
	type Block,
	type Inline,
	type StatusValue,
} from '../../../src/contracts/ast.js';
import { LOCALES, SOURCE_LOCALE, type Locale } from '../../../src/contracts/locales.js';
import { searchKey } from '../../../src/contracts/manifest.js';
import type { CompiledPage } from '../../../src/contracts/page.js';
import { compareSlugStrings } from '../../../src/contracts/slug.js';
import { STATUS_GLYPHS, statusGlyphText } from '../../../src/contracts/source.js';
import {
	AUDIENCE_MASK,
	DEFAULT_B,
	DEFAULT_FIELD_WEIGHTS,
	DEFAULT_K1,
	INDEX_NORMALISATION,
	MATCH_MODES,
	PAGE_ROOT_ANCHOR,
	SEARCH_FIELDS,
	SEARCH_INDEX_KIND,
	SEARCH_INDEX_VERSION,
	TOKENISER_VERSION,
	validateSearchIndexShape,
	type SearchField,
	type SearchIndex,
} from '../../../src/contracts/search.js';
import { blockText, inlineText } from '../../../src/ast/text.js';
import { searchIndex } from '../../../src/search/query.js';
import { tokenise } from '../../../src/search/tokenise.js';
import { statusLabel } from '../../../src/ui/status.js';
import { searchIndexSchema } from '../../src/contracts/bundle.schema.js';
import { buildBundle, type BuildResult } from '../../src/compile/build.js';
import { buildSearchIndex, sectionsOf } from '../../src/compile/search.js';

// ---------------------------------------------------------------------------
// Reading an index back
// ---------------------------------------------------------------------------

/**
 * Decodes one field's postings into term to document to term frequency.
 *
 * Written out here rather than imported, because the whole point of the round trip is
 * that a second reader agrees with the writer. A decoder that shared an implementation
 * with `encode` would agree with it whatever either of them did, which is the failure the
 * columnar format is most exposed to: two passes that fill `cnt` and `post` from
 * different pictures of the same postings produce an index that validates and ranks the
 * wrong sections.
 */
function decodeField(index: SearchIndex, field: SearchField): Map<string, Map<number, number>> {
	const postings = index.f[field];
	const out = new Map<string, Map<number, number>>();
	let cursor = 0;
	for (const [position, term] of decodeTerms(index).entries()) {
		const count = postings.cnt[position] as number;
		const byDoc = new Map<number, number>();
		let doc = 0;
		for (let i = 0; i < count; i += 1) {
			const delta = postings.post[cursor] as number;
			const frequency = postings.post[cursor + 1] as number;
			cursor += 2;
			doc = i === 0 ? delta : doc + delta;
			byDoc.set(doc, frequency);
		}
		out.set(term, byDoc);
	}
	// A decoder that stopped short would silently ignore the tail of `post`, which is the
	// half of a two-pass disagreement that leaves the length identity satisfied.
	expect(cursor, `f.${field}.post has trailing entries no term claimed`).toBe(postings.post.length);
	return out;
}

/** The dictionary. An empty one is the empty string and must not decode to `['']`. */
function decodeTerms(index: SearchIndex): string[] {
	return index.terms === '' ? [] : index.terms.split('\n');
}

/** One section, as `sectionsOf` returns them. The type is internal to the compiler. */
type Section = ReturnType<typeof sectionsOf>[number];

/** An element that has to be there, so a corpus that lost it fails here and says so. */
function at<T>(items: readonly T[], position: number): T {
	const found = items[position];
	if (found === undefined) throw new Error(`there is no element ${position} of ${items.length}.`);
	return found;
}

/**
 * Status glyphs in the source above the chip matrix's first heading, from the page and
 * the snippet it transcludes.
 *
 * Counted by each spelling's first code point, which is what makes the warning sign one
 * glyph rather than two: the corpus writes every one of them with U+FE0F, and the bare
 * spelling exists in the table for the source that does not.
 *
 * The em dash is cell-scoped and would be a violation anywhere else on these two files,
 * so counting every one of them here is counting status cells. A prose em dash added to
 * either file fails the house lint before it reaches this count.
 */
function glyphsInSource(): number {
	let total = 0;
	for (const path of [
		`docs/site/${contentPath(SOURCE_LOCALE, CHIP_SLUG)}`,
		`docs/site/${snippetPath(SOURCE_LOCALE, 'legend')}`,
	]) {
		const source = readAppFile(path);
		const cut = source.search(/^## /m);
		const region = cut === -1 ? source : source.slice(0, cut);
		for (const first of new Set(
			STATUS_GLYPHS.map((spelling) => spelling.codePoints[0] as number),
		)) {
			total += region.split(String.fromCodePoint(first)).length - 1;
		}
	}
	return total;
}

/** Terms across every locale's dictionary, so a sweep can state exactly what it covered. */
function dictionaryTotal(): number {
	return [...indexes.values()].reduce((total, index) => total + decodeTerms(index).length, 0);
}

/** Occurrences of one term in a piece of text, as the index counts them. */
function occurrences(text: string, term: string): number {
	return tokenise(text).filter((found) => found === term).length;
}

// ---------------------------------------------------------------------------
// Walking a compiled page
// ---------------------------------------------------------------------------

/**
 * Every heading node in a page body, in document order.
 *
 * Not `CompiledPage.headings`: that is the table of contents, already filtered by
 * `toc.maxDepth`, so a page with an h4 has a heading the field does not list. Deriving
 * the expectation from the field the splitter is not allowed to read would make this
 * suite agree with a splitter that dropped exactly the headings the reader can still
 * deep-link to.
 */
function headingsIn(page: CompiledPage): Extract<Block, { type: 'heading' }>[] {
	return page.body.filter(
		(block): block is Extract<Block, { type: 'heading' }> => block.type === 'heading',
	);
}

/**
 * The blocks of one section: everything after a heading up to the next heading of any
 * depth, and the blocks before the first heading as the page-root section.
 *
 * The split is re-done here rather than taken from `sectionsOf`, so the arithmetic below
 * is checked against a second opinion about where a section ends. `sectionsOf`'s own
 * split is pinned separately against the page's heading nodes.
 */
function splitBlocks(page: CompiledPage): Block[][] {
	const sections: Block[][] = [[]];
	for (const block of page.body) {
		if (block.type === 'heading') sections.push([]);
		else (sections.at(-1) as Block[]).push(block);
	}
	return sections;
}

/** Every status node in a run of blocks, in document order. */
function statusValues(blocks: readonly Block[]): StatusValue[] {
	const found: StatusValue[] = [];

	const inline = (nodes: readonly Inline[]): void => {
		for (const node of nodes) {
			if (node.type === 'status') found.push(node.value);
			else if ('children' in node) inline(node.children);
		}
	};

	const walk = (nodes: readonly Block[]): void => {
		for (const node of nodes) {
			switch (node.type) {
				case 'paragraph':
				case 'heading':
					inline(node.children);
					break;
				case 'list':
					for (const item of node.children) walk(item.children);
					break;
				case 'blockquote':
					walk(node.children);
					break;
				case 'callout':
					if (node.title !== undefined) inline(node.title);
					walk(node.children);
					break;
				case 'table':
					if (node.caption !== undefined) inline(node.caption);
					for (const cell of node.header) inline(cell.children);
					for (const row of node.rows) for (const cell of row) inline(cell.children);
					break;
				case 'figure':
					inline([node.image]);
					if (node.caption !== undefined) inline(node.caption);
					break;
				case 'steps':
					for (const step of node.children) {
						inline(step.title);
						walk(step.children);
					}
					break;
				default:
					break;
			}
		}
	};

	walk(blocks);
	return found;
}

// ---------------------------------------------------------------------------
// The corpus, compiled once
// ---------------------------------------------------------------------------

/** Every page the bundle publishes. The draft is compiled and deliberately not indexed. */
const PUBLISHED: readonly FixturePage[] = FIXTURE_PAGES.filter((page) => page.draft !== true);
const DRAFTS: readonly FixturePage[] = FIXTURE_PAGES.filter((page) => page.draft === true);

const CHIP_SLUG = 'reference/chip-support';

let corpus: MaterialisedCorpus | undefined;
let result: BuildResult | undefined;
const indexes = new Map<Locale, SearchIndex>();

/** The compiled page a locale's index carries for a slug: its own, or the source fallback. */
function pageFor(slug: string, locale: Locale): CompiledPage {
	const compiled = (result as BuildResult).pages.get(slug);
	const output = compiled?.get(locale) ?? compiled?.get(SOURCE_LOCALE);
	if (output === undefined)
		throw new Error(`${slug} did not compile in ${locale} or in the source locale.`);
	return output.page;
}

beforeAll(() => {
	corpus = materialiseCorpus(mkdtempSync(join(tmpdir(), 'hexdocs-search-')));
	result = buildBundle(corpus.root, { generator: '@hex-pro/docs-kit@0.1.0' });
	for (const locale of LOCALES) {
		const object = result.objects.find((entry) => entry.key === searchKey(locale));
		if (object === undefined) continue;
		indexes.set(locale, JSON.parse(gunzipSync(object.bytes).toString('utf8')) as SearchIndex);
	}
}, 120_000);

afterAll(() => {
	if (corpus !== undefined) rmSync(corpus.root, { recursive: true, force: true });
});

describe('the build produced one index per locale', () => {
	test('every declared locale has an index, and each one names itself', () => {
		// A locale silently missing an index is a language whose search box returns
		// nothing forever, and the manifest's `search` record would be absent rather than
		// wrong, which nothing downstream refuses.
		expect([...indexes.keys()].sort()).toEqual([...LOCALES].sort());
		for (const [locale, index] of indexes) {
			expect(index.locale, locale).toBe(locale);
			expect(index.bundle, locale).toBe((result as BuildResult).manifest.commit);
			expect(index.n, locale).toBe(index.docs.length);
		}
		expect(indexes.size).toBe(LOCALES.length);
	});

	test('the header records everything the two halves could disagree about', () => {
		// The runtime refuses an index whose header does not match, so a header that
		// drifted from the constants would make every published bundle unqueryable at
		// load. Checked against the constants rather than against literals, so a
		// deliberate bump moves both sides at once.
		for (const [locale, index] of indexes) {
			expect(index.kind, locale).toBe(SEARCH_INDEX_KIND);
			expect(index.v, locale).toBe(SEARCH_INDEX_VERSION);
			expect(index.ast, locale).toBe(AST_VERSION);
			expect(index.tokeniser, locale).toBe(TOKENISER_VERSION);
			expect(index.norm, locale).toBe(INDEX_NORMALISATION);
			expect(index.stem, locale).toBe(false);
			expect(index.match, locale).toBe(MATCH_MODES[0]);
			expect(index.w, locale).toEqual(DEFAULT_FIELD_WEIGHTS);
			expect(index.k1, locale).toBe(DEFAULT_K1);
			expect(index.b, locale).toBe(DEFAULT_B);
		}
		expect(indexes.size).toBe(LOCALES.length);
	});
});

// ---------------------------------------------------------------------------
// sectionsOf
// ---------------------------------------------------------------------------

describe('sectionsOf', () => {
	test('a page splits into the text above the first heading plus one section per heading', () => {
		// Swept over every page and every locale rather than spot-checked, because a split
		// that agreed with the heading list on one page and lost a section on another
		// would drop that section out of search with nothing to show for it.
		let swept = 0;
		for (const page of PUBLISHED) {
			for (const locale of LOCALES) {
				const compiled = pageFor(page.slug, locale);
				const sections = sectionsOf(compiled, locale);
				const label = `${page.slug} in ${locale}`;

				expect(sections.length, label).toBe(headingsIn(compiled).length + 1);
				expect(sections[0], label).toMatchObject({
					anchor: PAGE_ROOT_ANCHOR,
					heading: '',
					depth: 0,
				});
				expect(
					sections.slice(1).map((section) => ({ anchor: section.anchor, depth: section.depth })),
					label,
				).toEqual(
					headingsIn(compiled).map((entry) => ({ anchor: entry.id, depth: entry.depth as number })),
				);
				swept += 1;
			}
		}
		expect(PUBLISHED.length).toBeGreaterThan(5);
		expect(swept).toBe(PUBLISHED.length * LOCALES.length);
	});

	test('a heading too deep for the table of contents still gets its own section', () => {
		// `CompiledPage.headings` is the table of contents, filtered by `toc.maxDepth`. A
		// section is not a table of contents entry: the h4 in `guide/troubleshooting` is
		// below the cut and still deep-linkable, and a splitter that took its list from
		// that field would fold four paragraphs into the section above and address them at
		// the wrong anchor.
		const maxDepth = (result as BuildResult).project.config.toc.maxDepth;
		const page = pageFor('guide/troubleshooting', SOURCE_LOCALE);
		const deeper = headingsIn(page).filter((heading) => heading.depth > maxDepth);
		expect(deeper.length, `no heading below the toc cut of ${maxDepth}`).toBeGreaterThan(0);

		const anchors = new Set(sectionsOf(page, SOURCE_LOCALE).map((section) => section.anchor));
		for (const heading of deeper) expect(anchors.has(heading.id), heading.id).toBe(true);
		// The other direction: every table of contents entry is a section too, so the two
		// lists differ only by the depth cut.
		for (const entry of page.headings) expect(anchors.has(entry.id), entry.id).toBe(true);
		expect(page.headings.length).toBeLessThan(headingsIn(page).length);
	});

	test("a section's body stops at the next heading of any depth", () => {
		// `guide/troubleshooting` is the only page in the corpus with an h2 followed by an
		// h3 followed by an h4 followed by another h2, which is what makes it the only
		// page that can tell "splits on headings" from "splits on h2". A split that only
		// broke on depth 2 would put four sections' worth of text under one anchor, and
		// every result for it would deep-link the reader to the wrong place.
		const page = pageFor('guide/troubleshooting', SOURCE_LOCALE);
		const sections = sectionsOf(page, SOURCE_LOCALE);
		const depths = sections.map((section) => section.depth);
		expect(depths.slice(0, 5)).toEqual([0, 2, 3, 4, 2]);

		const [root, first, third, fourth, second] = [0, 1, 2, 3, 4].map((position) =>
			at(sections, position),
		) as [Section, Section, Section, Section, Section];

		expect(root.body).toContain('Most failed scans come down');
		expect(root.body).not.toContain('The NFC antenna sits');

		expect(first.heading).toBe('Why does nothing happen when I hold a tag to my phone?');
		expect(first.body).toContain('The NFC antenna sits at the top');
		expect(first.body).not.toContain('A tag can be readable by one app');

		expect(third.heading).toBe('Check the tag before you blame the phone');
		expect(third.body).toContain('A tag can be readable by one app');
		expect(third.body).not.toContain('A few chips answer the first poll');

		expect(fourth.heading).toBe('Tags that read once and then go quiet');
		expect(fourth.body).toContain('A few chips answer the first poll');
		expect(fourth.body).not.toContain('Tag connection lost');

		expect(second.heading).toBe('Why does the scan stop halfway through?');
		expect(second.body).toContain('Tag connection lost');
	});

	test('the section heading is the heading node flattened, in every locale', () => {
		// A result row prints this string. A heading whose inline markup survived into it,
		// or whose text came from the wrong node, is wrong on the page and nowhere else.
		let swept = 0;
		for (const page of PUBLISHED) {
			for (const locale of LOCALES) {
				const compiled = pageFor(page.slug, locale);
				expect(
					sectionsOf(compiled, locale)
						.slice(1)
						.map((section) => section.heading),
					`${page.slug} in ${locale}`,
				).toEqual(headingsIn(compiled).map((heading) => inlineText(heading.children)));
				swept += 1;
			}
		}
		expect(swept).toBe(PUBLISHED.length * LOCALES.length);
	});
});

// ---------------------------------------------------------------------------
// Document identity
// ---------------------------------------------------------------------------

describe('the documents', () => {
	test('docs is every published section, in page order then document order', () => {
		// A document id is a position in this array and every posting is a reference to
		// one, so a section inserted or reordered moves every posting after it. Derived
		// from `sectionsOf` over the pages the build compiled rather than written out, so
		// the expectation moves when the corpus does.
		const order = PUBLISHED.map((page) => page.slug).sort(compareSlugStrings);
		let swept = 0;
		for (const [locale, index] of indexes) {
			const expected: { slug: string; anchor: string; depth: number }[] = [];
			for (const slug of order) {
				for (const section of sectionsOf(pageFor(slug, locale), locale)) {
					expected.push({ slug, anchor: section.anchor, depth: section.depth });
				}
			}
			expect(
				index.docs.map((doc) => ({ slug: doc.slug, anchor: doc.anchor, depth: doc.depth })),
				locale,
			).toEqual(expected);
			expect(index.n, locale).toBe(expected.length);
			swept += 1;
		}
		expect(swept).toBe(LOCALES.length);
	});

	test('a section carries its page audience as a mask, never zero', () => {
		// Audience is a filter and not a ranking signal, so a wrong mask does not degrade
		// an ordering, it removes results and the reader sees an empty page with no error.
		let swept = 0;
		for (const [locale, index] of indexes) {
			for (const doc of index.docs) {
				expect(doc.audience, `${doc.slug} in ${locale}`).toBe(
					AUDIENCE_MASK[pageFor(doc.slug, locale).audience],
				);
				expect(doc.audience, `${doc.slug} in ${locale}`).toBeGreaterThan(0);
				swept += 1;
			}
		}
		expect(swept).toBe([...indexes.values()].reduce((total, index) => total + index.n, 0));
		expect(swept).toBeGreaterThan(200);
	});

	test('a draft is compiled and never indexed', () => {
		// The draft is in `pages` and out of `published`. A draft that reached the index
		// would be a page with no route, so every hit on it would be a link to a 404.
		expect(DRAFTS.length).toBeGreaterThan(0);
		for (const draft of DRAFTS) {
			expect((result as BuildResult).pages.has(draft.slug), draft.slug).toBe(true);
			for (const [locale, index] of indexes) {
				expect(
					index.docs.some((doc) => doc.slug === draft.slug),
					`${draft.slug} in ${locale}`,
				).toBe(false);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// The two validators
// ---------------------------------------------------------------------------

describe('the built index is well formed', () => {
	test('validateSearchIndexShape reports nothing for any locale', () => {
		// The length relationships a schema cannot express: `cnt` against the dictionary,
		// `post` against `sum(cnt) * 2`, `totalLen` against `len`, and the decoded ids
		// against `n`. The builder asserts these too, so this is the assertion that the
		// bytes which were actually written still satisfy them after canonical JSON and
		// gzip.
		let swept = 0;
		for (const [locale, index] of indexes) {
			expect(validateSearchIndexShape(index), locale).toEqual([]);
			swept += 1;
		}
		expect(swept).toBe(LOCALES.length);
	});

	test('searchIndexSchema accepts every locale', () => {
		// A different question from the one above: the schema checks the fields' types,
		// the closed unions and the ranges, and knows nothing about the array lengths.
		// Neither check subsumes the other, which is why both run.
		let swept = 0;
		for (const [locale, index] of indexes) {
			const parsed = searchIndexSchema.safeParse(index);
			expect(
				parsed.success
					? []
					: parsed.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message),
				locale,
			).toEqual([]);
			swept += 1;
		}
		expect(swept).toBe(LOCALES.length);
	});
});

// ---------------------------------------------------------------------------
// The columnar encoding
// ---------------------------------------------------------------------------

/** A compiled page with only the fields the index reads. */
function pageOf(slug: string, title: string, body: Block[]): CompiledPage {
	return {
		ast: AST_VERSION,
		project: 'fixture-app',
		slug,
		locale: SOURCE_LOCALE,
		title,
		description: '',
		audience: 'both',
		pageKind: 'article',
		tags: [],
		toc: false,
		headings: [],
		body,
		translation: { state: 'source', sourceUpdated: '2026-01-05T09:00:00Z' },
		reading: { words: 0, minutes: 1 },
		snippets: [],
		sourceFile: `content/en/${slug}.md`,
	};
}

function paragraph(value: string): Block {
	return { type: 'paragraph', children: [{ type: 'text', value }] };
}

function heading(id: string, value: string): Block {
	return { type: 'heading', depth: 2, id, idSource: 'slug', children: [{ type: 'text', value }] };
}

describe('the columnar encoding', () => {
	/*
	 * Two pages small enough that every posting is worked out by hand.
	 *
	 * The three documents are `alpha#_top`, `alpha#gamma-section` and `bravo#_top`, and
	 * each of the three is load-bearing.
	 *
	 * `alpha` is in the title of both pages, so it is a three-document posting whose ids
	 * are 0, 1 and 2. That is the only shape that tells a delta from an absolute id: a
	 * two-document posting encodes the same numbers either way, which is how an encoder
	 * that dropped the subtraction can pass a fixture that looks thorough.
	 *
	 * `beta` is in two documents by title and in one of those same two by body, so the
	 * union is 2 where the sum is 3. `delta` is in one document by title and a different
	 * one by body, so the union is 2 where any single field is 1. Between them they
	 * refuse both of the wrong answers for `df`.
	 *
	 * `beta` twice in one paragraph is the only term frequency above 1, which is what a
	 * builder that deduplicated its terms would flatten, turning BM25 into a presence
	 * test.
	 */
	// Built on first use rather than while the suite is being collected. The builder
	// asserts its own output and throws, and a throw during collection takes the whole
	// file down with "no tests", which hides which row would have named the fault.
	let built: SearchIndex | undefined;
	const index = (): SearchIndex => {
		built ??= buildSearchIndex({
			locale: SOURCE_LOCALE,
			commit: '0123456789abcdef0123456789abcdef01234567',
			pages: [
				{
					page: pageOf('alpha', 'Alpha beta', [
						paragraph('beta beta gamma'),
						heading('gamma-section', 'Gamma section'),
						paragraph('gamma delta'),
					]),
					state: 'source',
				},
				{ page: pageOf('bravo', 'Alpha delta', [paragraph('echo')]), state: 'source' },
			],
		});
		return built;
	};

	/** The dictionary, in the order every columnar array below is indexed by. */
	const TERMS = ['alpha', 'beta', 'delta', 'echo', 'gamma', 'section'];

	test('the dictionary is the union of the three fields, sorted', () => {
		expect(decodeTerms(index())).toEqual(TERMS);
		expect(index().docs.map((doc) => `${doc.slug}#${doc.anchor}`)).toEqual([
			'alpha#_top',
			'alpha#gamma-section',
			'bravo#_top',
		]);
		expect(index().n).toBe(3);
	});

	test('cnt and post are the counts and the deltas the format declares', () => {
		// Written out as literals, because this is the one place where the encoding is the
		// thing under test rather than the payload. `cnt` is postings-per-term and not an
		// offset, and within a term's slice the first number is an absolute document id and
		// every later one is a gap. `alpha` in the title field is the posting that tells
		// those apart: three documents at 0, 1 and 2 encode as `0, 1, 1` and an encoder that
		// wrote absolute ids throughout would write `0, 1, 2`, which still ascends, still
		// sits inside `[0, n)` and still decodes without complaint.
		expect(index().f.title.cnt).toEqual([3, 2, 1, 0, 0, 0]);
		expect(index().f.title.post).toEqual([0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 2, 1]);

		expect(index().f.heading.cnt).toEqual([0, 0, 0, 0, 1, 1]);
		expect(index().f.heading.post).toEqual([1, 1, 1, 1]);

		expect(index().f.body.cnt).toEqual([0, 1, 1, 1, 2, 0]);
		expect(index().f.body.post).toEqual([0, 2, 1, 1, 2, 1, 0, 1, 1, 1]);
	});

	test('decoding the postings gives back exactly the pairs that went in', () => {
		const expected: Record<SearchField, Record<string, Record<number, number>>> = {
			// Each section carries its page's title, so both of alpha's sections hold it.
			title: {
				alpha: { 0: 1, 1: 1, 2: 1 },
				beta: { 0: 1, 1: 1 },
				delta: { 2: 1 },
				echo: {},
				gamma: {},
				section: {},
			},
			heading: {
				alpha: {},
				beta: {},
				delta: {},
				echo: {},
				gamma: { 1: 1 },
				section: { 1: 1 },
			},
			body: {
				alpha: {},
				beta: { 0: 2 },
				delta: { 1: 1 },
				echo: { 2: 1 },
				gamma: { 0: 1, 1: 1 },
				section: {},
			},
		};

		let swept = 0;
		for (const field of SEARCH_FIELDS) {
			const decoded = decodeField(index(), field);
			expect([...decoded.keys()], field).toEqual(TERMS);
			for (const [term, byDoc] of decoded) {
				expect(Object.fromEntries(byDoc), `${field} ${term}`).toEqual(
					expected[field][term] as Record<number, number>,
				);
				swept += 1;
			}
		}
		expect(swept).toBe(SEARCH_FIELDS.length * TERMS.length);
	});

	test('len and totalLen are token counts and their sum, not an average', () => {
		// `totalLen` is what the reader divides by `n`. A float that came out of a division
		// is not byte-stable across platforms, and the bundle sha is what change detection
		// compares, so an encoder that stored the average reports a deploy on every build.
		expect(index().len.title).toEqual([2, 2, 2]);
		expect(index().len.heading).toEqual([0, 2, 0]);
		expect(index().len.body).toEqual([3, 2, 1]);
		expect(index().totalLen).toEqual({ title: 6, heading: 2, body: 6 });
	});

	test('df is the union across fields, which is neither the sum nor any one field', () => {
		// `beta` is in documents 0 and 1 by title and in document 0 again by body: the union
		// is 2 and the sum is 3. `delta` is in document 2 by title and document 1 by body:
		// the union is 2 and the largest single field is 1. A df taken either wrong way is
		// still inside `[1, n]`, so nothing but these numbers refuses it.
		expect(decodeTerms(index())).toEqual(TERMS);
		expect(index().df).toEqual([3, 2, 2, 1, 2, 1]);
	});

	test('the hand-made index passes both validators', () => {
		expect(validateSearchIndexShape(index())).toEqual([]);
		const parsed = searchIndexSchema.safeParse(index());
		expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// df over the real corpus
// ---------------------------------------------------------------------------

describe('document frequency', () => {
	test('df equals the size of the union of document ids across all three fields', () => {
		// The one check that catches a builder whose two passes disagree. Recomputed from
		// the decoded postings for every term in every locale, because a df that is right
		// for the common terms and wrong for the rare ones changes the idf of exactly the
		// terms the idf exists to weight.
		let swept = 0;
		for (const [locale, index] of indexes) {
			const terms = decodeTerms(index);
			const decoded = SEARCH_FIELDS.map((field) => decodeField(index, field));
			for (const [position, term] of terms.entries()) {
				const ids = new Set<number>();
				for (const field of decoded) {
					for (const id of (field.get(term) as Map<number, number>).keys()) ids.add(id);
				}
				expect(index.df[position], `${locale} term ${position} ${JSON.stringify(term)}`).toBe(
					ids.size,
				);
				swept += 1;
			}
		}
		expect(swept).toBe(dictionaryTotal());
		expect(swept).toBeGreaterThan(1000);
	});

	test('every term is in at least one document and no term is in more than n', () => {
		// Outside `[1, n]` the idf is Infinity or NaN, and a NaN score sorts wherever the
		// comparator happens to put it rather than last.
		let swept = 0;
		for (const [locale, index] of indexes) {
			for (const [position, value] of index.df.entries()) {
				expect(value, `${locale} df ${position}`).toBeGreaterThanOrEqual(1);
				expect(value, `${locale} df ${position}`).toBeLessThanOrEqual(index.n);
				swept += 1;
			}
		}
		expect(swept).toBe(dictionaryTotal());
		expect(swept).toBeGreaterThan(1000);
	});
});

// ---------------------------------------------------------------------------
// The dictionary order
// ---------------------------------------------------------------------------

describe('the dictionary order', () => {
	test('terms ascend strictly by UTF-16 code unit', () => {
		let swept = 0;
		for (const [locale, index] of indexes) {
			const terms = decodeTerms(index);
			for (let i = 1; i < terms.length; i += 1) {
				expect(
					(terms[i - 1] as string) < (terms[i] as string),
					`${locale} at ${i}: ${JSON.stringify(terms[i - 1])} then ${JSON.stringify(terms[i])}`,
				).toBe(true);
				swept += 1;
			}
		}
		// One comparison fewer per locale than there are terms, which is what makes this a
		// count rather than a claim: a dictionary that arrived empty would sweep nothing
		// and every comparison in it would pass.
		expect(swept).toBe(dictionaryTotal() - LOCALES.length);
		expect(swept).toBeGreaterThan(1000);
	});

	test('the order is not the collator order, so the assertion above is not free', () => {
		// Prefix expansion binary-searches this dictionary, and a collated order makes the
		// walk stop early and miss completions rather than fail. `localeCompare` would
		// also make the encoder depend on the runner's locale, and therefore change the
		// bundle sha between machines.
		//
		// Every locale's dictionary contains at least one adjacent pair the collator would
		// swap, so this is not a property the corpus happens to lack. Measured: one pair
		// in `en` and in `ar`, 106 in `ja`.
		let swept = 0;
		for (const [locale, index] of indexes) {
			const terms = decodeTerms(index);
			const disagreeing = terms.filter(
				(term, i) => i > 0 && (terms[i - 1] as string).localeCompare(term) > 0,
			);
			expect(
				disagreeing.length,
				`${locale} has no pair the collator would reorder`,
			).toBeGreaterThan(0);
			swept += 1;
		}
		expect(swept).toBe(LOCALES.length);
	});
});

// ---------------------------------------------------------------------------
// Status glyphs
// ---------------------------------------------------------------------------

describe('status glyphs are indexed as words in the locale of the index', () => {
	/*
	 * The property `ast.ts` says a test cannot notice. A search for "supported" that
	 * matches no row looks like no results rather than like a bug, so the check is
	 * arithmetic rather than presence: the section's term frequency has to be exactly the
	 * occurrences in its flattened text with the labels, and exactly that many fewer
	 * without them.
	 *
	 * Presence alone would prove nothing here. The Chinese page says 支持 in its own
	 * prose, the English legend says "Not supported" in a meaning column, and either
	 * would satisfy a test that only asked whether the term was in the dictionary.
	 */
	test('the yes label contributes one occurrence per glyph, in every locale', () => {
		let swept = 0;
		let assertions = 0;
		for (const [locale, index] of indexes) {
			const page = pageFor(CHIP_SLUG, locale);
			const blocks = splitBlocks(page)[0] as Block[];
			const values = statusValues(blocks);
			const label = (value: StatusValue): string => statusLabel(locale, value);
			const withLabels = blockText(blocks, { code: true, status: label });
			const withoutLabels = blockText(blocks, { code: true });

			const doc = index.docs.findIndex(
				(entry) => entry.slug === CHIP_SLUG && entry.anchor === PAGE_ROOT_ANCHOR,
			);
			expect(doc, `${locale} has no page-root section for ${CHIP_SLUG}`).toBeGreaterThanOrEqual(0);
			// The matrix and the legend both sit above the first heading, so every glyph on
			// the page is in this one section. Counted out of the source rather than written
			// down, so a row added to the matrix moves the expectation, and asserted for every
			// locale, so a translation that dropped a row fails here rather than ranking one
			// chip lower in one language.
			expect(values.length, locale).toBe(glyphsInSource());

			const body = decodeField(index, 'body');
			for (const term of new Set(tokenise(label('yes')))) {
				const fromGlyphs = values.reduce(
					(total, value) => total + occurrences(label(value), term),
					0,
				);
				expect(fromGlyphs, `${locale} ${term}`).toBeGreaterThan(0);

				const posting = (body.get(term) as Map<number, number> | undefined)?.get(doc);
				expect(posting, `${locale} ${term} is not indexed against the matrix section`).toBe(
					occurrences(withLabels, term),
				);
				expect(
					occurrences(withLabels, term) - occurrences(withoutLabels, term),
					`${locale} ${term} does not come from the glyphs`,
				).toBe(fromGlyphs);
				assertions += 1;
			}
			swept += 1;
		}
		expect(swept).toBe(LOCALES.length);
		// French spells the label as three words, so the sweep makes more claims than it has
		// locales. Derived from the label table, so a translation reworded into one word
		// moves it, and compared against the locale count so the multi-word case cannot stop
		// being covered without the comparison failing.
		const expected = LOCALES.reduce(
			(total, locale) => total + new Set(tokenise(statusLabel(locale, 'yes'))).size,
			0,
		);
		expect(assertions).toBe(expected);
		expect(assertions).toBeGreaterThan(LOCALES.length);
	});

	test('a query for the yes label returns the chip support matrix, in Chinese and in English', () => {
		// The two languages the design names, and asserted as the top hit rather than as a
		// hit anywhere in the list: a section holding twelve of the glyph that a query for
		// that glyph does not put first is a ranking nobody would ship.
		let swept = 0;
		for (const locale of ['zh', 'en'] as const) {
			const index = indexes.get(locale) as SearchIndex;
			const hits = searchIndex(index, statusLabel(locale, 'yes'));
			expect(hits.length, locale).toBeGreaterThan(0);
			expect(hits[0]?.doc.slug, locale).toBe(CHIP_SLUG);
			expect(hits[0]?.doc.anchor, locale).toBe(PAGE_ROOT_ANCHOR);
			swept += 1;
		}
		expect(swept).toBe(2);
	});

	test('the label is the index locale even when the text is the source fallback', () => {
		// `fr` has no chip matrix, so the index carries the English page. The glyphs are
		// still data, so they are still indexed in French, and a French reader searching
		// "Pris en charge" reaches the fallback page. Indexing them in the page's language
		// instead would put English words in the French index where no French query
		// reaches them.
		const index = indexes.get('fr') as SearchIndex;
		const doc = index.docs.find(
			(entry) => entry.slug === CHIP_SLUG && entry.anchor === PAGE_ROOT_ANCHOR,
		);
		expect(doc?.translated).toBe('missing');
		const hits = searchIndex(index, statusLabel('fr', 'yes'));
		expect(hits[0]?.doc.slug).toBe(CHIP_SLUG);
	});
});

// ---------------------------------------------------------------------------
// Coverage of untranslated pages
// ---------------------------------------------------------------------------

describe("a locale's index carries every published page", () => {
	test('a page with no file in the locale is present and marked missing', () => {
		// The site serves the source locale for those pages with a notice and `noindex`,
		// so a reader in French who searches for a page that exists only in English has to
		// find it. Derived from the corpus declaration rather than listed, so a page that
		// gains a translation moves the expectation with it.
		let swept = 0;
		let missing = 0;
		let present = 0;
		for (const [locale, index] of indexes) {
			for (const page of PUBLISHED) {
				const docs = index.docs.filter((doc) => doc.slug === page.slug);
				const label = `${page.slug} in ${locale}`;
				expect(docs.length, label).toBeGreaterThan(0);
				// One page is one state. A page whose sections disagreed would show a
				// translation notice on some results and not others.
				expect(new Set(docs.map((doc) => doc.translated)).size, label).toBe(1);

				const declared = page.locales[locale];
				const state = docs[0]?.translated;
				if (declared === undefined || declared === 'scaffolded') {
					expect(state, label).toBe('missing');
					missing += 1;
				} else {
					// `current` or `stale`. Never `missing`: text in the reader's own
					// language marked as a fallback would carry a notice saying the page is
					// untranslated while the reader is reading the translation.
					expect(state, label).not.toBe('missing');
					present += 1;
				}
				swept += 1;
			}
		}
		expect(swept).toBe(PUBLISHED.length * LOCALES.length);
		// Both arms have to be exercised or the sweep proves only one of them.
		expect(missing).toBeGreaterThan(0);
		expect(present).toBeGreaterThan(0);
		expect(missing + present).toBe(swept);
	});

	test('the scaffolded page reads missing although its file exists', () => {
		// The Spanish chip matrix is committed after the English source, so timestamps
		// alone call it current. It is source text under a translation's name, which from
		// a reader's point of view is the same problem as a fallback, so it lands on the
		// state that says the words are in the wrong language. A `scaffolded` that mapped
		// to `current` would put untranslated text in the index with nothing marking it.
		const declared = FIXTURE_PAGES.find((page) => page.slug === CHIP_SLUG)?.locales.es;
		expect(declared).toBe('scaffolded');
		const index = indexes.get('es') as SearchIndex;
		const docs = index.docs.filter((doc) => doc.slug === CHIP_SLUG);
		expect(docs.length).toBeGreaterThan(0);
		expect(new Set(docs.map((doc) => doc.translated))).toEqual(new Set(['missing']));
	});

	test('a stale translation is marked stale, not missing and not current', () => {
		// `guide/first-tag` is the deliberately stale page: its English file is revised in
		// a later commit than every translation. Losing the middle state would either hide
		// the staleness notice or claim the page is untranslated.
		const declared = FIXTURE_PAGES.find((page) => page.slug === 'guide/first-tag')?.locales;
		expect(declared?.fr).toBe('stale');
		const index = indexes.get('fr') as SearchIndex;
		const docs = index.docs.filter((doc) => doc.slug === 'guide/first-tag');
		expect(docs.length).toBeGreaterThan(0);
		expect(new Set(docs.map((doc) => doc.translated))).toEqual(new Set(['stale']));
	});
});

// ---------------------------------------------------------------------------
// The publish-time smoke test
// ---------------------------------------------------------------------------

/**
 * Ten or more queries per locale, each one taken verbatim from a page in that locale.
 *
 * Taken rather than invented, and checked against the file it was taken from, because a
 * query nobody can find in the corpus proves nothing when it stops returning hits: it
 * could be the index that broke or the words that were never there. The `slug` is both
 * the file the query came from and the page at least one hit has to be on.
 *
 * The purpose is the floor the plan names. Latin assertions all pass under a tokeniser
 * that stopped emitting CJK bigrams, and Chinese search returns nothing, so the Chinese
 * and Japanese rows are the ones this table exists for.
 */
const SMOKE_QUERIES: readonly { locale: Locale; query: string; slug: string }[] = [
	{ locale: 'en', query: 'Fixture App documentation', slug: 'index' },
	{ locale: 'en', query: 'What you need', slug: 'index' },
	{ locale: 'en', query: 'Scan your first tag', slug: 'guide/first-tag' },
	{ locale: 'en', query: 'Before you start', slug: 'guide/first-tag' },
	{ locale: 'en', query: 'Why does the scan stop halfway', slug: 'guide/troubleshooting' },
	{ locale: 'en', query: 'Chip support matrix', slug: CHIP_SLUG },
	{ locale: 'en', query: 'If a chip is not listed', slug: CHIP_SLUG },
	{ locale: 'en', query: 'Tag session API', slug: 'reference/api' },
	{ locale: 'en', query: 'The state machine', slug: 'reference/api' },
	{ locale: 'en', query: 'Module graph', slug: 'developer/architecture' },
	{ locale: 'en', query: 'Conventions', slug: 'reference/index' },

	{ locale: 'zh', query: 'Fixture App文档', slug: 'index' },
	{ locale: 'zh', query: '你需要什么', slug: 'index' },
	{ locale: 'zh', query: '接下来看什么', slug: 'index' },
	{ locale: 'zh', query: '从哪里开始', slug: 'guide/index' },
	{ locale: 'zh', query: '本指南不涉及的内容', slug: 'guide/index' },
	{ locale: 'zh', query: '扫描你的第一个标签', slug: 'guide/first-tag' },
	{ locale: 'zh', query: '读取标签', slug: 'guide/first-tag' },
	{ locale: 'zh', query: '芯片支持矩阵', slug: CHIP_SLUG },
	{ locale: 'zh', query: '这些注意事项是什么意思', slug: CHIP_SLUG },
	{ locale: 'zh', query: '这里有什么', slug: 'reference/index' },
	{ locale: 'zh', query: '约定', slug: 'reference/index' },

	{ locale: 'ar', query: 'توثيق Fixture App', slug: 'index' },
	{ locale: 'ar', query: 'ما تحتاج إليه', slug: 'index' },
	{ locale: 'ar', query: 'من أين تبدأ', slug: 'guide/index' },
	{ locale: 'ar', query: 'ما لا يغطيه الدليل', slug: 'guide/index' },
	{ locale: 'ar', query: 'امسح بطاقتك الأولى', slug: 'guide/first-tag' },
	{ locale: 'ar', query: 'اقرأ البطاقة', slug: 'guide/first-tag' },
	{ locale: 'ar', query: 'عندما لا ينجح المسح', slug: 'guide/troubleshooting' },
	{ locale: 'ar', query: 'لماذا يتوقف المسح في منتصفه', slug: 'guide/troubleshooting' },
	{ locale: 'ar', query: 'جدول دعم الشرائح', slug: CHIP_SLUG },
	{ locale: 'ar', query: 'إذا لم تكن الشريحة مدرجة', slug: CHIP_SLUG },
	{ locale: 'ar', query: 'ما الموجود هنا', slug: 'reference/index' },
	{ locale: 'ar', query: 'الاصطلاحات', slug: 'reference/index' },

	{ locale: 'es', query: 'Documentación de Fixture App', slug: 'index' },
	{ locale: 'es', query: 'Qué hace Fixture App', slug: 'index' },
	{ locale: 'es', query: 'Qué necesitas', slug: 'index' },
	{ locale: 'es', query: 'Por dónde seguir', slug: 'index' },
	{ locale: 'es', query: 'Por dónde empezar', slug: 'guide/index' },
	{ locale: 'es', query: 'Lo que la guía no cubre', slug: 'guide/index' },
	{ locale: 'es', query: 'Escanea tu primera etiqueta', slug: 'guide/first-tag' },
	{ locale: 'es', query: 'Antes de empezar', slug: 'guide/first-tag' },
	{ locale: 'es', query: 'Después de la lectura', slug: 'guide/first-tag' },
	{ locale: 'es', query: 'Referencia', slug: 'reference/index' },
	{ locale: 'es', query: 'Qué hay aquí', slug: 'reference/index' },
	{ locale: 'es', query: 'Convenciones', slug: 'reference/index' },

	{ locale: 'ja', query: 'Fixture App ドキュメント', slug: 'index' },
	{ locale: 'ja', query: '必要なもの', slug: 'index' },
	{ locale: 'ja', query: '次に読むもの', slug: 'index' },
	{ locale: 'ja', query: 'どこから始めるか', slug: 'guide/index' },
	{ locale: 'ja', query: 'ガイドで扱わないこと', slug: 'guide/index' },
	{ locale: 'ja', query: '最初のタグをスキャンする', slug: 'guide/first-tag' },
	{ locale: 'ja', query: 'タグを読み取る', slug: 'guide/first-tag' },
	{ locale: 'ja', query: 'スキャンできないとき', slug: 'guide/troubleshooting' },
	{ locale: 'ja', query: 'スキャンが途中で止まるのはなぜですか', slug: 'guide/troubleshooting' },
	{ locale: 'ja', query: 'チップ対応表', slug: CHIP_SLUG },
	{ locale: 'ja', query: '注意点の意味', slug: CHIP_SLUG },

	{ locale: 'fr', query: 'Documentation de Fixture App', slug: 'index' },
	{ locale: 'fr', query: 'Ce que fait Fixture App', slug: 'index' },
	{ locale: 'fr', query: 'Pour aller plus loin', slug: 'index' },
	{ locale: 'fr', query: 'Par où commencer', slug: 'guide/index' },
	{ locale: 'fr', query: 'Ce que le guide ne couvre pas', slug: 'guide/index' },
	{ locale: 'fr', query: 'Ordre de lecture pour un nouveau', slug: 'guide/index' },
	{ locale: 'fr', query: 'Scannez votre premier badge', slug: 'guide/first-tag' },
	{ locale: 'fr', query: 'Avant de commencer', slug: 'guide/first-tag' },
	{ locale: 'fr', query: 'Après la lecture', slug: 'guide/first-tag' },
	{ locale: 'fr', query: 'Référence', slug: 'reference/index' },
	{ locale: 'fr', query: 'Ce que vous trouverez ici', slug: 'reference/index' },
	{ locale: 'fr', query: 'Conventions', slug: 'reference/index' },

	{ locale: 'pt-BR', query: 'Documentação do Fixture App', slug: 'index' },
	{ locale: 'pt-BR', query: 'O que o Fixture App faz', slug: 'index' },
	{ locale: 'pt-BR', query: 'Para onde ir agora', slug: 'index' },
	{ locale: 'pt-BR', query: 'Por onde começar', slug: 'guide/index' },
	{ locale: 'pt-BR', query: 'O que o guia não cobre', slug: 'guide/index' },
	{ locale: 'pt-BR', query: 'Ordem de leitura para uma nova', slug: 'guide/index' },
	{ locale: 'pt-BR', query: 'Leia sua primeira etiqueta', slug: 'guide/first-tag' },
	{ locale: 'pt-BR', query: 'Antes de começar', slug: 'guide/first-tag' },
	{ locale: 'pt-BR', query: 'Depois da leitura', slug: 'guide/first-tag' },
	{ locale: 'pt-BR', query: 'Referência', slug: 'reference/index' },
	{ locale: 'pt-BR', query: 'O que há aqui', slug: 'reference/index' },
	{ locale: 'pt-BR', query: 'Convenções', slug: 'reference/index' },
];

describe('the status legend and the status label', () => {
	test('every legend row names the label the renderer will announce', () => {
		// Two statements about the same glyph, in two places, and they disagreed: the label
		// table read "Not applicable" for the em dash and every legend snippet defined it as
		// "Not tested". The label is what a screen reader announces and what the search index
		// carries, so a matrix row told a reader the cell was not applicable while the page's
		// own legend, three rows above, said the chip had never been tested. Nothing noticed:
		// `test/ui/status.test.ts` checks the labels are present, distinct and translated,
		// and the search tests derive their expectations from `statusLabel` itself, so both
		// agreed with whatever the label said.
		//
		// The glyph is the join. A legend row opening with a status glyph must contain that
		// glyph's label in that locale, which is checkable without either side naming the
		// other.
		let swept = 0;
		for (const locale of LOCALES) {
			const path = snippetPath(locale, 'legend');
			let source: string;
			try {
				source = readAppFile(`docs/site/${path}`);
			} catch {
				// The legend exists in the locales the chip matrix exists in and no others,
				// which is what the corpus declares. An absent one is not a failure here.
				continue;
			}
			// Every glyph has a row, checked first, because a glyph the contract declares and
			// the legend does not explain is a cell a reader cannot read.
			// By value, not by spelling. `partial` has two: the warning sign with its
			// variation selector and the bare one, and a legend that showed both would be
			// telling a reader there are two states.
			for (const value of new Set(STATUS_GLYPHS.map((spelling) => spelling.value))) {
				const spellings = STATUS_GLYPHS.filter((spelling) => spelling.value === value).map(
					statusGlyphText,
				);
				const row = source
					.split('\n')
					.find((line) => spellings.some((glyph) => line.trim().startsWith(`| ${glyph} `)));
				expect(row, `${locale} has no legend row for ${value}`).toBeDefined();
				swept += 1;
			}

			// The label is asserted for `na` alone, and the reason is worth stating. The
			// other three rows elaborate: `yes` is labelled "Supported" and its row opens
			// "Verified on hardware", which says more than the label rather than something
			// else. The `na` row said "Not tested" against a label of "Not applicable", which
			// is not an elaboration but a different claim about the same cell, and the label
			// is what a screen reader announces. Requiring the label verbatim in all four
			// rows would force the legend to restate itself and catch nothing more.
			const naRow = source.split('\n').find((line) => line.trim().startsWith('| \u2014 '));
			expect(naRow, `${locale} em dash row`).toContain(statusLabel(locale, 'na'));
			swept += 1;
		}
		expect(swept).toBeGreaterThan(15);
	});
});

describe('the sidebar label and the tags', () => {
	/**
	 * Both were written into every bundle and read by nothing.
	 *
	 * `navTitle` is the label the reader is looking at in the sidebar when they open the
	 * search box, so it is the single most likely thing for them to type: "Troubleshooting",
	 * "Architecture", "Overview" each returned nothing in English, and the Chinese, Japanese,
	 * Arabic and Portuguese words for "overview" each returned nothing in their own locale.
	 * `tags` was worse, because `DocFrontMatter` says of it "They feed search weighting", and
	 * nothing in the compiler or the client ever read the field.
	 *
	 * Swept over the corpus rather than listed, so a page given a navTitle later is covered
	 * without anybody adding a row, which is the failure a fixed list of ten queries has.
	 */
	test('every navTitle in every locale finds its own page', () => {
		let swept = 0;
		for (const locale of LOCALES) {
			const index = indexes.get(locale) as SearchIndex;
			for (const fixture of FIXTURE_PAGES) {
				if (fixture.draft === true) continue;
				const page = pageFor(fixture.slug, locale);
				if (page.navTitle === undefined || page.navTitle === '') continue;
				const hits = searchIndex(index, page.navTitle);
				expect(
					hits.some((hit) => hit.doc.slug === fixture.slug),
					`${locale} ${JSON.stringify(page.navTitle)} did not find ${fixture.slug}`,
				).toBe(true);
				swept += 1;
			}
		}
		// A sweep that found no navTitle to check is a sweep that proves nothing, and the
		// corpus gives several pages one precisely so this cannot be vacuous.
		expect(swept).toBeGreaterThan(20);
	});

	test('every tag in every locale finds the page that carries it', () => {
		let swept = 0;
		for (const locale of LOCALES) {
			const index = indexes.get(locale) as SearchIndex;
			for (const fixture of FIXTURE_PAGES) {
				if (fixture.draft === true) continue;
				const page = pageFor(fixture.slug, locale);
				for (const tag of page.tags) {
					const hits = searchIndex(index, tag);
					expect(
						hits.some((hit) => hit.doc.slug === fixture.slug),
						`${locale} tag ${JSON.stringify(tag)} did not find ${fixture.slug}`,
					).toBe(true);
					swept += 1;
				}
			}
		}
		expect(swept).toBeGreaterThan(20);
	});

	test('a tag does not outrank a page whose title is the query', () => {
		// The reason they share the title field rather than getting one with its own weight.
		// A page with eight tags must not beat the page actually called that, and BM25's
		// length normalisation over the title field is what makes that hold.
		const index = indexes.get('en') as SearchIndex;
		const hits = searchIndex(index, 'Chip support matrix');
		expect(hits[0]?.doc.slug).toBe(CHIP_SLUG);
	});
});

describe('the publish-time smoke test', () => {
	test('the table is ten queries a locale and every locale is in it', () => {
		const perLocale = new Map<Locale, number>();
		for (const entry of SMOKE_QUERIES) {
			perLocale.set(entry.locale, (perLocale.get(entry.locale) ?? 0) + 1);
		}
		for (const locale of LOCALES) {
			expect(perLocale.get(locale) ?? 0, locale).toBeGreaterThanOrEqual(10);
		}
		expect(perLocale.size).toBe(LOCALES.length);
		expect(SMOKE_QUERIES.length).toBe(81);
	});

	test('every query is a verbatim string from the page it names', () => {
		// The half that keeps the other half honest. A query that drifted from the corpus
		// would keep returning hits from some other page and the row would go on passing
		// while covering nothing.
		let swept = 0;
		for (const entry of SMOKE_QUERIES) {
			const source = readAppFile(`docs/site/${contentPath(entry.locale, entry.slug)}`);
			expect(
				source.includes(entry.query),
				`${entry.locale} ${JSON.stringify(entry.query)} is not in ${contentPath(entry.locale, entry.slug)}`,
			).toBe(true);
			swept += 1;
		}
		expect(swept).toBe(SMOKE_QUERIES.length);
	});

	test('every query returns at least one hit, on the page it came from', () => {
		let swept = 0;
		for (const entry of SMOKE_QUERIES) {
			const index = indexes.get(entry.locale) as SearchIndex;
			const hits = searchIndex(index, entry.query);
			expect(hits.length, `${entry.locale} ${entry.query}`).toBeGreaterThan(0);
			expect(
				hits.some((hit) => hit.doc.slug === entry.slug),
				`${entry.locale} ${entry.query} found ${hits
					.slice(0, 3)
					.map((hit) => hit.doc.slug)
					.join(', ')}`,
			).toBe(true);
			swept += 1;
		}
		expect(swept).toBe(SMOKE_QUERIES.length);
	});

	test('a CJK run is indexed as overlapping bigrams, not as one term and not as pieces', () => {
		// The failure the smoke table alone cannot see. A tokeniser that emitted one term
		// per run, or non-overlapping pairs, still answers every query above, because a
		// query is tokenised by the same broken tokeniser. What it cannot do is match a
		// query that starts halfway through a run, which is most of what a reader types.
		const runs: { locale: Locale; slug: string; run: string }[] = [
			{ locale: 'zh', slug: CHIP_SLUG, run: '这些注意事项是什么意思' },
			{ locale: 'ja', slug: 'index', run: '必要なもの' },
		];
		let swept = 0;
		for (const { locale, slug, run } of runs) {
			// Read back out of the page it came from, so a run that stops being in the corpus
			// fails here rather than quietly testing a string nothing indexes any more.
			expect(
				readAppFile(`docs/site/${contentPath(locale, slug)}`).includes(run),
				`${run} is not in ${contentPath(locale, slug)}`,
			).toBe(true);

			const terms = new Set(decodeTerms(indexes.get(locale) as SearchIndex));
			const bigrams = [...run].slice(0, -1).map((_, i) => run.slice(i, i + 2));
			expect(bigrams.length, locale).toBe(run.length - 1);
			for (const bigram of bigrams) {
				expect(terms.has(bigram), `${locale} dictionary has no ${bigram}`).toBe(true);
				swept += 1;
			}
		}
		expect(swept).toBe(runs.reduce((total, entry) => total + entry.run.length - 1, 0));
		expect(swept).toBeGreaterThan(10);
	});

	test('the CJK dictionaries are larger than the Latin ones, which is what bigrams buy', () => {
		// A size floor rather than a size, because the corpus moves. Measured: en 1106,
		// zh 2709, ja 3048. A run indexed as one term collapses these to roughly the
		// number of distinct runs, which is well under the Latin count, so this row fails
		// where every query above still passes.
		const size = (locale: Locale): number => decodeTerms(indexes.get(locale) as SearchIndex).length;
		expect(size('en')).toBeGreaterThan(900);
		expect(size('zh')).toBeGreaterThan(size('en') * 2);
		expect(size('ja')).toBeGreaterThan(size('en') * 2);
	});
});
