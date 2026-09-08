import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { appFiles, parseFixtureFrontMatter, readAppFile } from '../../../fixtures/index.js';
import { readFrontMatter } from '../../src/compile/frontmatter.js';
import type { RawFinding } from '../../src/compile/types.js';
import { frontMatterSchema, snippetFrontMatterSchema } from '../../src/contracts/index.js';

/** Every markdown file in the corpus, page and snippet alike, relative to `docs/site`. */
const markdown = appFiles()
	.filter((path) => /^docs\/site\/(content|snippets)\/.*\.md$/.test(path))
	.map((path) => path.replace('docs/site/', ''));

const pages = markdown.filter((path) => path.startsWith('content/'));
const snippets = markdown.filter((path) => path.startsWith('snippets/'));

const sourceOf = (path: string): string => readAppFile(join('docs', 'site', path));

function lineOf(problem: RawFinding): number | undefined {
	return problem.location.kind === 'file' ? problem.location.line : undefined;
}

function columnOf(problem: RawFinding): number | undefined {
	return problem.location.kind === 'file' ? problem.location.column : undefined;
}

/** The one problem a case expects, asserted by message so a failure prints them. */
function only(problems: RawFinding[]): RawFinding {
	expect(problems.map((problem) => problem.message)).toHaveLength(1);
	const [first] = problems;
	if (first === undefined) throw new Error('no problem was reported');
	return first;
}

describe('the corpus, read by both readers', () => {
	test('the sweep covers every markdown file the corpus ships', () => {
		// Literal counts, and the point is that they are literal. A glob that matched
		// nothing would leave every `test.each` below registering no tests at all and the
		// suite would pass green with the two readers never once compared. A page added to
		// the corpus is meant to be a deliberate edit here.
		expect(markdown).toHaveLength(51);
		expect(pages).toHaveLength(39);
		expect(snippets).toHaveLength(12);
	});

	test.each(markdown)('%s reads the same as the fixture reader', (path) => {
		const source = sourceOf(path);
		const block = readFrontMatter(source, path);
		const fixture = parseFixtureFrontMatter(source, path);

		// This is what replaces the real YAML parser the fixture reader's header expected
		// the compiler to use. Two narrow readers are only safe while they agree, and the
		// agreement has to be measured on the whole corpus rather than argued for.
		expect(block.problems).toEqual([]);
		expect(Object.keys(block.data)).toEqual(fixture.keys);
		expect(block.data).toEqual(fixture.data);
		expect(block.body).toBe(fixture.body);
	});

	test.each(markdown)('%s reports a body line that really is the first body line', (path) => {
		const source = sourceOf(path);
		const block = readFrontMatter(source, path);
		const lines = source.split('\n');

		expect(block.body.length).toBeGreaterThan(0);
		expect(lines[block.bodyLine - 1]).toBe(block.body.split('\n')[0]);
	});

	test.each(markdown)('%s reports a key line for every key it read', (path) => {
		const source = sourceOf(path);
		const block = readFrontMatter(source, path);
		const lines = source.split('\n');

		expect(Object.keys(block.keyLines)).toEqual(Object.keys(block.data));
		for (const [key, line] of Object.entries(block.keyLines)) {
			expect(lines[line - 1], `${path}: ${key}`).toMatch(new RegExp(`^${key}:`));
		}
	});

	test.each(markdown)('%s puts every string value at the position it records', (path) => {
		const source = sourceOf(path);
		const block = readFrontMatter(source, path);
		const lines = source.split('\n');

		const strings = Object.values(block.data).filter((value) => typeof value === 'string');
		expect(block.prose).toHaveLength(strings.length);
		expect(strings.length).toBeGreaterThan(0);

		for (const segment of block.prose) {
			expect(segment.kind).toBe('frontMatter');
			expect(segment.file).toBe(path);
			// Front matter has no block node, and `ProseSegment.node` is where a rule asks
			// what kind of block it is looking at. There is no honest answer here.
			expect(segment.node).toBeUndefined();
			expect(segment.folded.runs).toHaveLength(1);
			for (const run of segment.folded.runs) {
				const line = lines[run.line - 1] as string;
				expect(line.slice(run.column - 1, run.column - 1 + run.length)).toBe(segment.folded.text);
			}
		}
	});
});

describe('the reader hands the schemas what they validate', () => {
	test.each(pages)('%s validates as page front matter', (path) => {
		const result = frontMatterSchema.safeParse(readFrontMatter(sourceOf(path), path).data);
		expect(result.error?.issues ?? []).toEqual([]);
		expect(result.success).toBe(true);
	});

	test.each(snippets)('%s validates as snippet front matter', (path) => {
		const result = snippetFrontMatterSchema.safeParse(readFrontMatter(sourceOf(path), path).data);
		expect(result.error?.issues ?? []).toEqual([]);
		expect(result.success).toBe(true);
	});
});

interface RefusalCase {
	/** What is wrong with the source, for the test name. */
	readonly name: string;
	readonly source: string;
	readonly line: number;
	/** A fragment of the message that names the construct, and not just its effect. */
	readonly names: string;
}

const doc = (...body: string[]): string => ['---', ...body, '---', '', 'Body.', ''].join('\n');

/**
 * One case per construct the reader refuses.
 *
 * The count is asserted below, because a deleted case is otherwise a construct that
 * quietly stops being refused with every row still green. That is the same lesson
 * `fixtures/nodes.ts` records from the other side.
 */
const REFUSALS: readonly RefusalCase[] = [
	{
		name: 'no front matter at all',
		source: '# A page\n\nBody.\n',
		line: 1,
		names: 'has no front matter',
	},
	{
		name: 'front matter that is never closed',
		source: '---\ntitle: A\n\nBody.\n',
		line: 1,
		names: 'never closed',
	},
	{
		name: 'a colon followed by a space inside a bare scalar',
		source: doc('title: a: b'),
		line: 2,
		names: 'nested mapping',
	},
	{
		name: 'a leading #',
		source: doc('title: # not a title'),
		line: 2,
		names: 'comment',
	},
	{
		name: 'a # after whitespace',
		source: doc('title: A title # and a note'),
		line: 2,
		names: 'trailing comment',
	},
	{
		name: 'a block scalar indicator',
		source: doc('title: A', 'description: |'),
		line: 3,
		names: 'block scalar indicator',
	},
	{
		name: 'a YAML indicator character',
		source: doc('title: !tagged'),
		line: 2,
		names: 'indicator character',
	},
	{
		name: 'a single-quoted scalar',
		source: doc("title: 'A'"),
		line: 2,
		names: 'single-quoted scalar',
	},
	{
		name: 'a flow sequence',
		source: doc('title: A', 'tags: [chips, scanning]'),
		line: 3,
		names: 'flow sequence',
	},
	{
		name: 'a flow mapping',
		source: doc('title: {a: b}'),
		line: 2,
		names: 'flow mapping',
	},
	{
		name: 'an anchor',
		source: doc('title: &saved A'),
		line: 2,
		names: 'anchor',
	},
	{
		name: 'an alias',
		source: doc('title: *saved'),
		line: 2,
		names: 'alias',
	},
	{
		name: 'a quote inside a double-quoted scalar',
		source: doc('title: "a "b" c"'),
		line: 2,
		names: 'quote inside a double-quoted scalar',
	},
	{
		name: 'a backslash inside a double-quoted scalar',
		source: doc('title: "a\\b"'),
		line: 2,
		names: 'backslash inside a double-quoted scalar',
	},
	{
		name: 'an unterminated quoted scalar',
		source: doc('title: "unclosed'),
		line: 2,
		names: 'unterminated double-quoted scalar',
	},
	{
		name: 'a lone quote, which is too short to be terminated by its own opening quote',
		source: doc('title: "'),
		line: 2,
		names: 'unterminated double-quoted scalar',
	},
	{
		name: 'a duplicate key',
		source: doc('title: A', 'title: B'),
		line: 3,
		names: 'declared twice',
	},
	{
		name: 'a key with no value and a following key rather than a list',
		source: doc('title:', 'description: D'),
		line: 2,
		names: 'no value and no list under it',
	},
	{
		name: 'a key with no value and nothing at all under it',
		source: doc('description: D', 'title:'),
		line: 3,
		names: 'no value and no list under it',
	},
	{
		name: 'a list item with no key above it',
		source: doc('  - orphan'),
		line: 2,
		names: 'no key above it',
	},
	{
		name: 'a list item under a key that already has a scalar',
		source: doc('title: A', '  - chips'),
		line: 3,
		names: 'already has a scalar value',
	},
	{
		name: 'a key whose fact has an owner somewhere else',
		source: doc('title: A', 'order: 3'),
		line: 3,
		names: 'nav.json',
	},
	{
		name: 'a line that is neither a key nor a list item',
		source: doc('title: A', 'not a key line'),
		line: 3,
		names: 'neither',
	},
	{
		name: 'a refused scalar inside a list',
		source: doc('title: A', 'tags:', '  - a: b'),
		line: 4,
		names: 'nested mapping',
	},
];

describe('every construct outside the subset is refused by name', () => {
	test('the table still holds a case per construct', () => {
		expect(REFUSALS).toHaveLength(24);
		expect(new Set(REFUSALS.map((entry) => entry.name)).size).toBe(REFUSALS.length);
	});

	test.each(REFUSALS)('$name', (entry: RefusalCase) => {
		const problem = only(readFrontMatter(entry.source, 'page.md').problems);

		expect(problem.rule).toBe('front-matter-invalid');
		expect(problem.location.kind).toBe('file');
		expect(lineOf(problem)).toBe(entry.line);
		expect(problem.message).toContain(entry.names);
		// A refusal that named the construct and left the author to work out what to do
		// about it would be half a diagnostic. `remediation` is `string | null` for the
		// reason `diagnostics.ts` gives, and null here would read as "there is nothing to
		// suggest" rather than "nobody wrote one".
		expect(problem.remediation).not.toBeNull();
		expect(problem.locale).toBeNull();
	});

	test('a refusal points at the character inside the value, not at the key', () => {
		const problem = only(readFrontMatter(doc('title: a: b'), 'page.md').problems);
		// `title: ` is seven characters, so the value starts in column 8 and the colon it
		// trips over is in column 9. A column measured from the start of the line would be
		// two out, and a column measured from the start of the value would be one.
		expect(columnOf(problem)).toBe(9);
	});

	test('a message that names a forbidden key names the owner of the fact as well', () => {
		const problem = only(readFrontMatter(doc('title: A', 'date: 2026-01-01'), 'p.md').problems);
		expect(problem.message).toContain('`date`');
		expect(problem.message).toContain('Dates come from git');
	});

	test('every problem in the block is reported, not the first', () => {
		// Front matter that is wrong in three ways should say so once. Stopping at the
		// first turns one round of fixes into three.
		const { problems } = readFrontMatter(doc('title: a: b', 'order: 3', 'description:'), 'p.md');
		expect(problems.map(lineOf)).toEqual([2, 3, 4]);
		expect(new Set(problems.map((problem) => problem.rule))).toEqual(
			new Set(['front-matter-invalid']),
		);
	});

	test('the items under a refused key are part of that refusal, not four more of them', () => {
		const { data, problems } = readFrontMatter(
			doc('order: 3', '  - a', '  - b', 'title: T', 'description: D'),
			'p.md',
		);
		expect(problems.map(lineOf)).toEqual([2]);
		// Reading carries on afterwards. A block that stopped at the refused key would
		// report a missing title on a page that has one.
		expect(data).toEqual({ title: 'T', description: 'D' });
	});

	test('a forbidden key is refused by name and never reaches the strict schema', () => {
		// Handing it on as well would report the same mistake a second time as an
		// unrecognised key, and "unknown key: order" is the worse of the two messages.
		const { data, keyLines } = readFrontMatter(doc('title: T', 'description: D', 'slug: s'), 'p');
		expect(data).toEqual({ title: 'T', description: 'D' });
		expect(keyLines['slug']).toBe(4);
	});

	test('a key named constructor is neither forbidden nor a duplicate of the prototype', () => {
		// `in` finds `constructor` on `Object.prototype`, and indexing the forbidden-key
		// record hands back a function. Either one turns a legal key into a refusal whose
		// message carries a function where an explanation should be.
		const { data, problems } = readFrontMatter(doc('constructor: A', 'toString: B'), 'p.md');
		expect(problems).toEqual([]);
		expect(data).toEqual({ constructor: 'A', toString: 'B' });
	});
});

describe('what the reader reads', () => {
	test('scalars, lists and the two literals come back as written', () => {
		const { data, problems } = readFrontMatter(
			doc(
				'title: A page',
				'description: "One sentence."',
				'draft: true',
				'translated: false',
				'tags:',
				'  - chips',
				'  - "two words"',
			),
			'p.md',
		);
		expect(problems).toEqual([]);
		expect(data).toEqual({
			title: 'A page',
			description: 'One sentence.',
			draft: true,
			translated: false,
			tags: ['chips', 'two words'],
		});
	});

	test('a literal inside a list is the string, which is what the fixture reader makes of it', () => {
		// A list is `string[]`, so there is nowhere for a boolean to go. The two readers
		// have to make the same thing of it or the corpus sweep is comparing two answers
		// that were never going to differ.
		const source = doc('title: A', 'tags:', '  - true');
		const { data } = readFrontMatter(source, 'p.md');
		expect(data['tags']).toEqual(['true']);
		expect(parseFixtureFrontMatter(source, 'p.md').data['tags']).toEqual(['true']);
	});

	test('nothing is narrowed, because the schema is the validator', () => {
		// `draft` is a boolean in `DocFrontMatter` and this reader hands the schema the
		// string the author actually wrote. A reader that folded `yes` into true would be a
		// second, weaker schema, and the strict one would never see the mistake.
		const { data } = readFrontMatter(doc('title: A', 'description: D', 'draft: yes'), 'p.md');
		expect(data['draft']).toBe('yes');
		const result = frontMatterSchema.safeParse(data);
		expect(result.error?.issues.map((issue) => issue.path)).toEqual([['draft']]);
	});

	test('a blank line inside the block is not a problem', () => {
		const { data, problems } = readFrontMatter(doc('title: A', '', 'description: D'), 'p.md');
		expect(problems).toEqual([]);
		expect(data).toEqual({ title: 'A', description: 'D' });
	});

	test('keys are recorded in the order they are written, with their lines', () => {
		const { data, keyLines } = readFrontMatter(
			doc('title: A', 'description: D', 'tags:', '  - chips', 'audience: user'),
			'p.md',
		);
		expect(Object.keys(data)).toEqual(['title', 'description', 'tags', 'audience']);
		expect(keyLines).toEqual({ title: 2, description: 3, tags: 4, audience: 6 });
	});

	test('the first of two declarations is the one kept', () => {
		// A permissive YAML parser keeps the last. Keeping the first here means the
		// finding and the value say the same thing, and the block does not publish either
		// way.
		const { data } = readFrontMatter(doc('title: first', 'title: second'), 'p.md');
		expect(data['title']).toBe('first');
	});
});

describe('positions', () => {
	const positioned = (line: string): { line: number; column: number; text: string } => {
		const { prose } = readFrontMatter(doc('title: A', line), 'p.md');
		const segment = prose[1];
		expect(segment).toBeDefined();
		const run = segment?.folded.runs[0];
		expect(run).toBeDefined();
		return {
			line: run?.line ?? 0,
			column: run?.column ?? 0,
			text: segment?.folded.text ?? '',
		};
	};

	test('an unquoted description reports the column its first word starts in', () => {
		// `description:` is twelve characters and the space is the thirteenth, so the
		// sentence starts in column 14. This is what lets a banned phrase at offset 4 of a
		// description report a column an editor can jump to.
		expect(positioned('description: The sentence.')).toEqual({
			line: 3,
			column: 14,
			text: 'The sentence.',
		});
	});

	test('a quoted description reports the column inside the quote', () => {
		expect(positioned('description: "The sentence."')).toEqual({
			line: 3,
			column: 15,
			text: 'The sentence.',
		});
	});

	test('extra spaces after the colon move the column and nothing else', () => {
		expect(positioned('description:    The sentence.')).toEqual({
			line: 3,
			column: 17,
			text: 'The sentence.',
		});
	});

	test('trailing whitespace is trimmed off the value and leaves the column alone', () => {
		expect(positioned('description: The sentence.   ')).toEqual({
			line: 3,
			column: 14,
			text: 'The sentence.',
		});
	});

	test('whitespace the key pattern did not consume still moves the column', () => {
		// A non-breaking space is not matched by `[ \t]*` and is trimmed off the value, so the
		// column has to be measured after the trim rather than from where the pattern stopped.
		// Off by one here is off by one in every finding about that value.
		expect(positioned('description: \u00A0The sentence.')).toEqual({
			line: 3,
			column: 15,
			text: 'The sentence.',
		});
	});

	test('only string values become prose', () => {
		// The keys and the delimiters are not prose, a list of tag ids is not prose, and a
		// rule that flagged the word `description` would be unanswerable.
		const { prose } = readFrontMatter(doc('title: A', 'draft: true', 'tags:', '  - chips'), 'p.md');
		expect(prose.map((segment) => segment.folded.text)).toEqual(['A']);
	});
});

describe('the body', () => {
	test('one blank line after the closing delimiter is removed', () => {
		const parsed = readFrontMatter('---\ntitle: A\n---\n\nBody.\n', 'p.md');
		expect(parsed.body).toBe('Body.\n');
		expect(parsed.bodyLine).toBe(5);
	});

	test('a body that starts on the line after the delimiter keeps its first line', () => {
		const parsed = readFrontMatter('---\ntitle: A\n---\nBody.\n', 'p.md');
		expect(parsed.body).toBe('Body.\n');
		expect(parsed.bodyLine).toBe(4);
	});

	test('only one blank line is removed, so a deliberate gap survives', () => {
		const parsed = readFrontMatter('---\ntitle: A\n---\n\n\nBody.\n', 'p.md');
		expect(parsed.body).toBe('\nBody.\n');
		expect(parsed.bodyLine).toBe(5);
	});

	test('a file that ends at the closing delimiter has no body', () => {
		const parsed = readFrontMatter('---\ntitle: A\n---', 'p.md');
		expect(parsed.body).toBe('');
		expect(parsed.bodyLine).toBe(4);
	});

	test('CRLF line endings read the same as LF', () => {
		const parsed = readFrontMatter('---\r\ntitle: A\r\n---\r\n\r\nBody.\r\n', 'p.md');
		expect(parsed.data).toEqual({ title: 'A' });
		expect(parsed.body).toBe('Body.\n');
		expect(parsed.bodyLine).toBe(5);
	});

	test('a file with no front matter is all body, from line one', () => {
		// The page still has prose worth linting, and reading it as front matter would
		// bury the one finding that says what is wrong under one per paragraph.
		const source = '# A page\n\nBody.\n';
		const parsed = readFrontMatter(source, 'p.md');
		expect(parsed.body).toBe(source);
		expect(parsed.bodyLine).toBe(1);
		expect(parsed.data).toEqual({});
		expect(parsed.prose).toEqual([]);
	});

	test('a block that is never closed has no body to hand back', () => {
		// There is no line that separates the two halves, so there is nothing to call the
		// body. Guessing produces a stray-line finding for every paragraph in the file.
		const parsed = readFrontMatter('---\ntitle: A\n\nBody.\n', 'p.md');
		expect(parsed.body).toBe('');
		// One past the last line, which is the honest answer for a body that does not
		// start anywhere.
		expect(parsed.bodyLine).toBe(6);
		expect(parsed.data).toEqual({});
	});
});
