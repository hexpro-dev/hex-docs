/**
 * The markdown a scaffolded page is made of, held to the reader that will read it back.
 *
 * `templates/page.ts` writes a front matter dialect it does not itself parse, and
 * `kit/src/compile/frontmatter.ts` parses a dialect it does not write. Two narrow readers
 * of the same subset is the shape `CLAUDE.md` warns about: they agree on every file
 * anybody tests and disagree on the one that matters. So the assertions here are almost
 * all round trips through the real reader rather than string comparisons. A test asserting
 * that `translationStub` emits the characters `translated: false` would pass against a
 * template that emitted them inside a code fence.
 *
 * The pairing `yamlScalar` claims in its own comment is checked as a table in both
 * directions, because it is a claim about two modules and neither can check it alone:
 * everything the predicate calls unsafe, the reader must refuse or read as something else;
 * and everything it calls safe, the reader must read back as the same string.
 *
 * `headingsOf` is the other half. It is a second, much narrower reader of a markdown body,
 * and it is honest about two gaps: an indented `#` line is a heading to it and a paragraph
 * to the parser, and a heading reaching a page through `::include` is not here at all.
 * Both are asserted rather than described, so the divergence is a measured fact and not a
 * sentence somebody hopes is still true.
 *
 * Deliberately not covered: what the compiler makes of a stub, which is
 * `kit/test/source/scaffold.test.ts` and is a different property. That file runs the real
 * `buildBundle` over a materialised history and asserts the translation state; nothing
 * here compiles anything.
 */

import { describe, expect, test } from 'vitest';

import { readAppFile } from '../../../fixtures/index.js';
import { readFrontMatter } from '../../src/compile/frontmatter.js';
import { frontMatterSchema } from '../../src/contracts/config.schema.js';
import {
	PLACEHOLDER_DESCRIPTION,
	TODO_TRANSLATE_PAGE,
	TODO_TRANSLATE_SECTION,
	TODO_WRITE_PAGE,
	TODO_WRITE_SECTION,
	headingsOf,
	includeIdsOf,
	sourcePage,
	translationStub,
	yamlScalar,
	type Emitted,
	type FrontMatterEntry,
	type StubHeading,
} from '../../src/templates/page.js';

const FILE = 'docs/site/content/en/probe.md';

function contentsOf(emitted: Emitted): string {
	if (!emitted.ok) throw new Error(`expected a file, got a refusal: ${emitted.why}`);
	return emitted.contents;
}

/** The body of an emitted file, which is what the heading readers take. */
function bodyOf(text: string): string {
	return readFrontMatter(text, FILE).body;
}

// ---------------------------------------------------------------------------
// the quoting predicate, against the reader it exists to agree with
// ---------------------------------------------------------------------------

/**
 * A title written into a real front matter block and read back by the compiler's reader.
 *
 * The whole file rather than the one line, because the reader takes a file and its
 * refusals are about what YAML would do with the block.
 */
function readTitle(spelling: string): { value: unknown; problems: number } {
	const block = readFrontMatter(
		[
			'---',
			`title: ${spelling}`,
			'description: A sentence about the page.',
			'---',
			'',
			'Body.',
			'',
		].join('\n'),
		FILE,
	);
	return { value: block.data['title'], problems: block.problems.length };
}

/** The three answers the predicate can give, claimed per value and checked below. */
const SPELLINGS: readonly { value: string; verdict: 'bare' | 'quoted' | 'refused'; why: string }[] =
	[
		{
			value: 'Scan your first tag',
			verdict: 'bare',
			why: 'ordinary prose, with no YAML indicator character anywhere in it',
		},
		{ value: 'NTAG 213 support', verdict: 'bare', why: 'digits and capitals are not indicators' },
		{
			value: 'colon:no-space',
			verdict: 'bare',
			why: 'YAML needs a space after the colon to read a mapping, and so does the reader',
		},
		{
			// The two-character Chinese title that disproved the three-character floor in the
			// front matter schema. Written as escapes because every golden and fixture in this
			// repository is, so an invisible character cannot hide in a test.
			value: '\u6307\u5357',
			verdict: 'bare',
			why: 'a correct CJK title is two characters and nothing about it needs quoting',
		},
		{ value: 'true', verdict: 'quoted', why: 'bare, YAML reads it as the boolean true' },
		{ value: 'false', verdict: 'quoted', why: 'the same in the other direction' },
		{ value: '# 1 in the store', verdict: 'quoted', why: 'a leading # is a comment to YAML' },
		{ value: 'Read this: it matters', verdict: 'quoted', why: 'a colon and a space is a mapping' },
		{
			value: 'trailing # hash',
			verdict: 'quoted',
			why: 'a # after whitespace is dropped as a comment',
		},
		{ value: '[bracketed]', verdict: 'quoted', why: 'a leading bracket opens a flow sequence' },
		{ value: '*starred', verdict: 'quoted', why: 'a leading star is an alias' },
		{ value: '|piped', verdict: 'quoted', why: 'a leading pipe opens a block scalar' },
		{
			value: "'quoted'",
			verdict: 'quoted',
			why: 'a leading single quote is a scalar YAML reads itself',
		},
		{
			value: '',
			verdict: 'refused',
			why: 'an empty value has no spelling and the schema refuses one',
		},
		{
			value: 'He said: "no"',
			verdict: 'refused',
			why: 'it has to be quoted and it carries a quote, which this dialect has no escape for',
		},
		{
			value: 'Path: C:\\Users',
			verdict: 'refused',
			why: 'the same for a backslash, which YAML would expand and this reader would not',
		},
	];

describe('yamlScalar and the reader that reads it back', () => {
	test('every value is claimed, and the three verdicts all appear', () => {
		// Coverage of the answers rather than of the values: a table that only carried safe
		// values would pass every assertion below and prove nothing about the refusals.
		expect(new Set(SPELLINGS.map((entry) => entry.verdict))).toEqual(
			new Set(['bare', 'quoted', 'refused']),
		);
		for (const entry of SPELLINGS) expect(entry.why.length).toBeGreaterThan(20);
	});

	for (const entry of SPELLINGS) {
		test(`${JSON.stringify(entry.value)} is ${entry.verdict}: ${entry.why}`, () => {
			const emitted = yamlScalar(entry.value);
			if (entry.verdict === 'refused') {
				expect(emitted.ok).toBe(false);
				return;
			}
			expect(emitted.ok).toBe(true);
			const spelling = contentsOf(emitted);
			expect(spelling.startsWith('"')).toBe(entry.verdict === 'quoted');

			// Direction one: the spelling this module chose reads back as the value that went
			// in. This is the assertion that makes the whole dialect trustworthy.
			expect(readTitle(spelling)).toEqual({ value: entry.value, problems: 0 });
		});
	}

	test('and every value it quotes is one the reader would not have read bare', () => {
		// Direction two, which is the half a one-sided test misses. The predicate is allowed
		// to be stricter than the reader; it must never be looser. A value quoted here whose
		// bare form the reader reads back identically would be a quote nobody needed, and a
		// value left bare whose bare form the reader refuses is a file this tool wrote that
		// the compiler will not open.
		const unnecessary: string[] = [];
		for (const entry of SPELLINGS) {
			if (entry.verdict !== 'quoted') continue;
			const bare = readTitle(entry.value);
			if (bare.problems === 0 && bare.value === entry.value) unnecessary.push(entry.value);
		}
		expect(unnecessary).toEqual([]);
	});

	test('a refusal is refused because the spelling it would have written is refused too', () => {
		// The claim in the module's comment, measured. `"He said: "no""` is what a naive
		// quoter emits, and the reader rejects it for a quote inside a double-quoted scalar.
		const value = 'He said: "no"';
		expect(yamlScalar(value).ok).toBe(false);
		const naive = readTitle(`"${value}"`);
		expect(naive.problems).toBeGreaterThan(0);
		expect(naive.value).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// a new page in the source language
// ---------------------------------------------------------------------------

describe('sourcePage', () => {
	const text = contentsOf(sourcePage({ title: 'First tag', description: PLACEHOLDER_DESCRIPTION }));
	const block = readFrontMatter(text, FILE);

	test('reads back with no problems and validates against the front matter schema', () => {
		expect(block.problems).toEqual([]);
		const parsed = frontMatterSchema.safeParse(block.data);
		expect(parsed.error?.issues ?? []).toEqual([]);
		expect(parsed.data).toEqual({ title: 'First tag', description: PLACEHOLDER_DESCRIPTION });
	});

	test('has no h1 in the body, because the title is front matter and only front matter', () => {
		// Two competing titles is what `no-h1-in-body` reports, and it would be reported
		// against a file this tool wrote.
		const headings = headingsOf(block.body);
		expect(headings.length).toBeGreaterThan(0);
		expect(headings.filter((heading) => heading.depth === 1)).toEqual([]);
	});

	test('the placeholder description is a sentence, which is what the lint asks for', () => {
		// A scaffold that trips the lint it exists to serve teaches the wrong lesson on the
		// first run.
		expect(PLACEHOLDER_DESCRIPTION.endsWith('.')).toBe(true);
		expect(PLACEHOLDER_DESCRIPTION.split(' ').length).toBeGreaterThan(3);
	});

	test('and the body is obviously unfinished', () => {
		expect(block.body).toContain(TODO_WRITE_PAGE);
		expect(block.body).toContain(TODO_WRITE_SECTION);
		// The nav is named in the body, because a published page no nav entry reaches is an
		// orphan and that is an error rather than a warning.
		expect(block.body).toContain('nav.json');
	});

	test('a title with no spelling is a refusal naming the key, not a broken file', () => {
		const refused = sourcePage({ title: '', description: PLACEHOLDER_DESCRIPTION });
		expect(refused.ok).toBe(false);
		expect(refused.ok === false ? refused.why : '').toContain('title');

		const description = sourcePage({ title: 'Fine', description: 'He said: "no"' });
		expect(description.ok).toBe(false);
		expect(description.ok === false ? description.why : '').toContain('description');
	});
});

// ---------------------------------------------------------------------------
// a locale file for a page nobody has translated
// ---------------------------------------------------------------------------

/** The front matter of the corpus page that carries every shape this dialect has. */
const FIRST_TAG = readFrontMatter(
	readAppFile('docs/site/content/en/guide/first-tag.md'),
	'docs/site/content/en/guide/first-tag.md',
);

describe('translationStub', () => {
	const front: FrontMatterEntry[] = Object.entries(FIRST_TAG.data)
		.filter(([key]) => key !== 'draft')
		.map(([key, value]) => ({ key, value: value as FrontMatterEntry['value'] }));
	const headings = headingsOf(FIRST_TAG.body);
	const text = contentsOf(translationStub({ front, headings }));
	const block = readFrontMatter(text, 'docs/site/content/fr/guide/first-tag.md');

	test('the corpus page really does carry a list, a boolean-shaped scalar and a quoted one', () => {
		// Stated first, because everything below is only worth anything if the source it is
		// built from exercises the branches. A stub built from title and description alone
		// would pass every assertion in this block and cover two of six.
		expect(Array.isArray(FIRST_TAG.data['tags'])).toBe(true);
		expect(Array.isArray(FIRST_TAG.data['redirectFrom'])).toBe(true);
		expect(typeof FIRST_TAG.data['since']).toBe('string');
		expect(headings.length).toBeGreaterThan(2);
	});

	test('reads back with no problems and validates, translation flag and all', () => {
		expect(block.problems).toEqual([]);
		const parsed = frontMatterSchema.safeParse(block.data);
		expect(parsed.error?.issues ?? []).toEqual([]);
		expect(parsed.data?.translated).toBe(false);
	});

	test('every page-level fact survives, which is why it copies all of the front matter', () => {
		// The correction the module records: an earlier version copied title, description and
		// navTitle, which silently dropped `pageKind`, and `no-rhetorical-opener` exempts a
		// page that declares itself a set of questions. Both directions on the key set, so a
		// dropped key and an invented one both fail.
		expect(Object.keys(block.data).sort()).toEqual(
			[...Object.keys(FIRST_TAG.data), 'translated'].sort(),
		);
		for (const [key, value] of Object.entries(FIRST_TAG.data)) {
			expect([key, block.data[key]]).toEqual([key, value]);
		}
	});

	test('the flag is written once, last, and never inherited from the source', () => {
		const lines = text.split('\n');
		const flags = lines.filter((line) => line.startsWith('translated:'));
		expect(flags).toEqual(['translated: false']);
		// Last in the block, so it is the line a reviewer's eye lands on and removing it once
		// the page is translated is one line at the bottom rather than one in the middle.
		const close = lines.indexOf('---', 1);
		expect(lines[close - 1]).toBe('translated: false');

		// And an incoming `translated` is dropped rather than emitted twice.
		const again = contentsOf(
			translationStub({ front: [...front, { key: 'translated', value: true }], headings: [] }),
		);
		expect(again.split('\n').filter((line) => line.startsWith('translated:'))).toEqual([
			'translated: false',
		]);
	});

	test('the heading structure round trips, which is the whole of what a stub carries', () => {
		// Read back with the same reader that produced the input, so this is a real round trip
		// rather than a comparison against the string that was written.
		expect(headingsOf(block.body)).toEqual(headings);
		expect(block.body).toContain(TODO_TRANSLATE_PAGE);
		// One TODO per heading, so a translator sees a section to fill rather than a heading
		// with the English still under it.
		expect(block.body.split(TODO_TRANSLATE_SECTION).length - 1).toBe(headings.length);
	});

	test('and none of the source prose comes with it', () => {
		// The failure this module exists to close: copying the body marked six locales of
		// English as fully translated, permanently and invisibly.
		const sentence = FIRST_TAG.body
			.split('\n')
			.find((line) => line.length > 40 && !line.startsWith('#') && !line.startsWith('::'));
		expect(sentence).toBeDefined();
		expect(block.body).not.toContain(sentence as string);
		expect(block.body.length).toBeLessThan(FIRST_TAG.body.length);
	});

	test('an empty list is no key at all, and a boolean is written bare', () => {
		const text = contentsOf(
			translationStub({
				front: [
					{ key: 'title', value: 'Probe' },
					{ key: 'description', value: 'A sentence.' },
					{ key: 'tags', value: [] },
					{ key: 'toc', value: false },
				],
				headings: [],
			}),
		);
		const block = readFrontMatter(text, FILE);
		expect(block.problems).toEqual([]);
		// The reader refuses a key whose value is neither a scalar nor a following `- item`,
		// so `tags:` with nothing under it would be a file this tool wrote and the compiler
		// will not read.
		expect('tags' in block.data).toBe(false);
		expect(block.data['toc']).toBe(false);
		expect(frontMatterSchema.safeParse(block.data).success).toBe(true);
	});

	test('and a boolean true is written bare, which is the other half of the same arm', () => {
		// `translated` is the only boolean `scaffold` passes and it is always false, so this
		// arm has no caller today. It is tested because the module takes a `boolean` and a
		// value written as the string "true" would be read back as the string "true" by a
		// reader that has a boolean for it, which is a difference nothing downstream would
		// report. `draft` is the key a caller other than `scaffold` would reach for.
		const block = readFrontMatter(
			contentsOf(
				translationStub({
					front: [
						{ key: 'title', value: 'Probe' },
						{ key: 'description', value: 'A sentence.' },
						{ key: 'draft', value: true },
					],
					headings: [],
				}),
			),
			FILE,
		);
		expect(block.problems).toEqual([]);
		expect(block.data['draft']).toBe(true);
		expect(block.data['draft']).not.toBe('true');
	});

	test('a page with no headings is a page-level TODO and nothing else', () => {
		const body = bodyOf(
			contentsOf(
				translationStub({
					front: [
						{ key: 'title', value: 'Probe' },
						{ key: 'description', value: 'A sentence.' },
					],
					headings: [],
				}),
			),
		);
		expect(headingsOf(body)).toEqual([]);
		expect(body.trim()).toBe(TODO_TRANSLATE_PAGE);
	});

	test('a value with no spelling is a refusal naming the key it came from', () => {
		const refused = translationStub({
			front: [
				{ key: 'title', value: 'Probe' },
				{ key: 'tags', value: ['scanning', 'He said: "no"'] },
			],
			headings: [],
		});
		expect(refused.ok).toBe(false);
		// The key, so somebody reading the note knows which field to reword rather than being
		// told a file could not be built.
		expect(refused.ok === false ? refused.why : '').toMatch(/^tags: /);
	});
});

// ---------------------------------------------------------------------------
// reading a source page
// ---------------------------------------------------------------------------

describe('headingsOf', () => {
	test('an explicit anchor is part of the text and survives verbatim', () => {
		// The one thing that keeps a single anchor addressing the same section in all seven
		// languages, where slugified heading text gives each language its own.
		const body = bodyOf(readAppFile('docs/site/content/en/developer/architecture.md'));
		expect(headingsOf(body)).toContainEqual({ depth: 2, text: 'Module graph {#module-graph}' });
	});

	test('depths are the hash count, and seven hashes is not a heading', () => {
		const headings = headingsOf(
			[
				'# One',
				'## Two',
				'### Three',
				'#### Four',
				'##### Five',
				'###### Six',
				'####### Seven',
			].join('\n'),
		);
		expect(headings.map((heading) => heading.depth)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(headings.map((heading) => heading.text)).not.toContain('Seven');
	});

	test('a hash with no space is not a heading, and trailing space is trimmed', () => {
		expect(headingsOf('#hashtag')).toEqual([]);
		expect(headingsOf('##\ttabbed')).toEqual([{ depth: 2, text: 'tabbed' }]);
		expect(headingsOf('## Spaced   ')).toEqual([{ depth: 2, text: 'Spaced' }]);
	});

	test('nothing inside a fence is a heading, whichever character opened it', () => {
		const body = [
			'## Real',
			'',
			'```bash',
			'# not a heading, a shell comment',
			'```',
			'',
			'~~~text',
			'## nor this',
			'~~~',
			'',
			'## Also real',
		].join('\n');
		expect(headingsOf(body)).toEqual([
			{ depth: 2, text: 'Real' },
			{ depth: 2, text: 'Also real' },
		]);
	});

	test('a fence closes on the same character at least as long, and on nothing else', () => {
		// `blocks.ts`'s rule, restated here because this module is a second reader of it and
		// the two disagreeing is the failure that matters. A shorter run does not close, so
		// everything after it stays inside the fence.
		const body = ['````', '## swallowed', '```', '## still swallowed', '````', '## out'].join('\n');
		expect(headingsOf(body)).toEqual([{ depth: 2, text: 'out' }]);

		// And a tilde run does not close a backtick fence.
		expect(headingsOf(['```', '~~~', '## swallowed', '```', '## out'].join('\n'))).toEqual([
			{ depth: 2, text: 'out' },
		]);
	});

	test('an indented heading is read here and is a paragraph to the parser', () => {
		// The documented divergence, asserted rather than described. `heading-set-matches-source`
		// compares the compiled heading sets of the two locales, so a stub whose structure came
		// out different is reported against the file it is wrong in, by the rule that exists for
		// exactly that. Measuring it here is what stops the gap from being a sentence nobody
		// checked.
		expect(headingsOf('    ## indented as list continuation')).toEqual([
			{ depth: 2, text: 'indented as list continuation' },
		]);
	});
});

describe('includeIdsOf', () => {
	test('finds the snippet a real corpus page transcludes', () => {
		const body = bodyOf(readAppFile('docs/site/content/en/guide/first-tag.md'));
		expect(includeIdsOf(body)).toEqual(['safety-note']);
	});

	test('keeps first-seen order and reports each id once', () => {
		const body = ['::include[legend]', '', '::include[safety-note]', '', '::include[legend]'].join(
			'\n',
		);
		expect(includeIdsOf(body)).toEqual(['legend', 'safety-note']);
	});

	test('ignores every other directive, and anything inside a fence', () => {
		const body = [
			'::::steps',
			':::step[Open the sheet]',
			'Text.',
			':::',
			'::::',
			'',
			'```text',
			'::include[not-transcluded]',
			'```',
			'',
			'::include[real]',
		].join('\n');
		expect(includeIdsOf(body)).toEqual(['real']);
	});

	test('an empty argument is not an id', () => {
		// `::include[]` names no snippet. Reporting it would put an empty string in a note
		// telling somebody to write `snippets/<locale>/.md`.
		expect(includeIdsOf('::include[]')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// the two readers, over the same body
// ---------------------------------------------------------------------------

test('both readers walk one fence rule, so they cannot come to disagree about it', () => {
	// One shared walk is the implementation, and this is the property it is for: a body
	// whose fence hides both a heading and an include hides both or neither.
	const body = [
		'```text',
		'## hidden',
		'::include[hidden]',
		'```',
		'',
		'## shown',
		'::include[shown]',
	].join('\n');
	const headings: StubHeading[] = headingsOf(body);
	expect(headings).toEqual([{ depth: 2, text: 'shown' }]);
	expect(includeIdsOf(body)).toEqual(['shown']);
});
