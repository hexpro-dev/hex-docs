/**
 * The markdown parser: the fold, the inline pass, the block pass and the document seam.
 *
 * Nearly every assertion here is a position as well as a shape, because the position is
 * the seam between the four modules. `fold.ts` maps every offset in the string the
 * inline parser reads back to the line and the column the author typed it on, and both
 * parsers record that position for every node they build and every problem they report.
 * A parser that produced the right tree against the wrong line would pass a test that
 * only looked at the tree, and every diagnostic in the package would then point at
 * somewhere the author has to go looking for.
 *
 * The corpus sweep at the foot is the highest-value test in the file. `fixtures/nodes.ts`
 * claims, for every AST node type, which corpus file produces it. This compiles those
 * files with the real resolvers and asserts each claim is still true of the tree that
 * comes out. Without it a page gets rewritten, the construct goes with it, and one node
 * type quietly stops being exercised anywhere with every row still green.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
	AST_NODE_TYPES,
	CALLOUT_KINDS,
	STATUS_VALUES,
	type Block,
	type Inline,
} from '../../../src/contracts/ast.js';
import {
	CONTAINER_DIRECTIVE_NAMES,
	STATUS_GLYPHS,
	statusGlyphText,
	type ContainerDirectiveName,
} from '../../../src/contracts/source.js';
import {
	DEFAULT_BUDGETS,
	DOCS_CONFIG_VERSION,
	type DocsProjectConfig,
} from '../../../src/contracts/project.js';
import { assetKey } from '../../../src/contracts/manifest.js';
import {
	FIXTURE_PAGES,
	FIXTURE_SNIPPETS,
	INCLUDE_CLAIMS,
	NODE_CLAIMS,
	materialiseCorpus,
	readAppFile,
} from '../../../fixtures/index.js';

import {
	BREAK_SENTINEL,
	concatFolded,
	foldLines,
	foldOne,
	isWide,
	readSource,
	sliceFolded,
	toLines,
	type SourceLine,
} from '../../src/compile/markdown/fold.js';
import { parseInline } from '../../src/compile/markdown/inline.js';
import { deriveHeadingId, parseBlocks, slugifyHeading } from '../../src/compile/markdown/blocks.js';
import { parseDocument } from '../../src/compile/markdown/index.js';
import {
	positionAt,
	type FoldedText,
	type NodeOrigins,
	type ParseServices,
	type ProseSegment,
	type RawFinding,
} from '../../src/compile/types.js';
import { createImageResolver, createLinkResolver } from '../../src/compile/links.js';
import { highlight } from '../../src/compile/highlight/index.js';
import { probeAsset } from '../../src/compile/assets.js';
import { sha256Hex } from '../../src/compile/serialise.js';
import { loadProject } from '../../src/compile/project.js';

// ---------------------------------------------------------------------------
// A project, and services with no project around them
// ---------------------------------------------------------------------------

const FILE = 'content/en/guide/index.md';

const CONFIG: DocsProjectConfig = {
	docs: DOCS_CONFIG_VERSION,
	project: 'fixture-app',
	productName: 'Fixture App',
	repo: 'hexpro-dev/fixture-app',
	defaultAudience: 'both',
	headingIds: 'slug',
	sections: [{ id: 'guide', kind: 'guide' }],
	i18n: { locales: ['en', 'es'], sourceLocale: 'en', parity: 'graceful' },
	budgets: DEFAULT_BUDGETS,
	code: { languages: ['text', 'swift', 'json'] },
	toc: { enabled: true, maxDepth: 3, minHeadings: 3 },
	lint: { extends: 'house', maxDisables: 2 },
};

/**
 * The four callbacks the parser needs, stubbed.
 *
 * Written out here rather than imported from `links.ts`, because these tests are about
 * what the parser does with an answer, not about which answer the resolver gives. The
 * one thing they share with the real thing is the shape: an unresolved target comes back
 * as a message, never as a thrown error, because a page full of broken links has to
 * report all of them in one run.
 */
function stubServices(overrides: Partial<ParseServices> = {}): ParseServices {
	return {
		resolveLink: (href, title) => {
			const withTitle = title === undefined ? {} : { title };
			if (href.startsWith('#')) {
				return {
					ok: true,
					link: { type: 'link', kind: 'anchor', anchor: href.slice(1), ...withTitle },
				};
			}
			if (href.startsWith('mailto:')) {
				return {
					ok: true,
					link: {
						type: 'link',
						kind: 'mailto',
						address: href.slice('mailto:'.length),
						...withTitle,
					},
				};
			}
			if (href.startsWith('https://')) {
				return { ok: true, link: { type: 'link', kind: 'external', href, ...withTitle } };
			}
			if (href === 'first-tag.md' || href === 'first-tag.md#step-one') {
				const [, anchor] = href.split('#');
				return {
					ok: true,
					link: {
						type: 'link',
						kind: 'internal',
						slug: 'guide/first-tag',
						...(anchor === undefined ? {} : { anchor }),
						...withTitle,
					},
				};
			}
			return {
				ok: false,
				message: `"${href}" resolves to no page in this project.`,
				remediation: 'Check the path, or run hexdocs mv if the page moved.',
			};
		},
		resolveImage: (src) =>
			src === 'scan.png'
				? { ok: true, src: 'assets/abc.png', width: 320, height: 208 }
				: {
						ok: false,
						message: `"${src}" is not an asset in this project.`,
						remediation: 'Commit it under docs/site/assets/.',
					},
		resolveInclude: (id) =>
			id === 'safety-note'
				? {
						ok: true,
						blocks: [
							{ type: 'paragraph', children: [{ type: 'text', value: 'Hold the tag still.' }] },
						],
					}
				: { ok: false, message: `There is no snippet "${id}".`, remediation: 'Fix the id.' },
		// One unstyled token per line, which is what the real highlighter produces for a
		// language it has no grammar for. The tokens are not what these tests are about;
		// that a fence's options reach the node is.
		highlight: (code) => ({
			lines: code.split('\n').map((line) => ({ tokens: [{ text: line }] })),
			highlighted: false,
		}),
		...overrides,
	};
}

interface ParsedBody {
	blocks: Block[];
	problems: RawFinding[];
	prose: ProseSegment[];
	includes: string[];
	origins: NodeOrigins;
}

/** Parses a body with no front matter, which is what `parseBlocks` is handed. */
function parseBody(
	source: string,
	options: {
		services?: Partial<ParseServices>;
		config?: DocsProjectConfig;
		includeDepth?: number;
	} = {},
): ParsedBody {
	const problems: RawFinding[] = [];
	const prose: ProseSegment[] = [];
	const includes: string[] = [];
	const origins: NodeOrigins = new WeakMap();
	const blocks = parseBlocks(toLines(source), {
		file: FILE,
		config: options.config ?? CONFIG,
		origins,
		services: stubServices(options.services),
		problems,
		prose,
		includes,
		includeDepth: options.includeDepth ?? 0,
	});
	return { blocks, problems, prose, includes, origins };
}

interface ParsedInline {
	nodes: Inline[];
	prose: string;
	/** Link and image titles, each its own run, kept out of the block's prose. */
	titles: FoldedText[];
	problems: RawFinding[];
	origins: NodeOrigins;
}

/** Parses one run of inline text, folding it first the way a paragraph is folded. */
function parseInlineText(
	source: string,
	options: { scope?: 'inline' | 'cell'; services?: Partial<ParseServices> } = {},
): ParsedInline {
	const problems: RawFinding[] = [];
	const origins: NodeOrigins = new WeakMap();
	const result = parseInline(foldLines(toLines(source)), {
		file: FILE,
		scope: options.scope ?? 'inline',
		origins,
		services: stubServices(options.services),
		problems,
	});
	return {
		nodes: result.nodes,
		prose: result.prose.text,
		titles: result.titles,
		problems,
		origins,
	};
}

/** Where a finding points, as one string, so a mismatch reads plainly in the diff. */
function positionOf(finding: RawFinding): string {
	const location = finding.location;
	if (location.kind !== 'file') return location.kind;
	return `${location.file}:${location.line}:${location.column}`;
}

/** Where the parser says a node came from. A node it never recorded reads `unrecorded`. */
function originOf(origins: NodeOrigins, node: object): string {
	const at = origins.get(node);
	return at === undefined ? 'unrecorded' : `${at.file}:${at.line}:${at.column}`;
}

function blockOfType<T extends Block['type']>(
	blocks: readonly Block[],
	index: number,
	type: T,
): Extract<Block, { type: T }> {
	const block = blocks[index];
	expect(block?.type, `block ${index} of ${blocks.length}`).toBe(type);
	return block as Extract<Block, { type: T }>;
}

function inlineOfType<T extends Inline['type']>(
	nodes: readonly Inline[],
	index: number,
	type: T,
): Extract<Inline, { type: T }> {
	const node = nodes[index];
	expect(node?.type, `inline ${index} of ${nodes.length}`).toBe(type);
	return node as Extract<Inline, { type: T }>;
}

/** The one problem a source was supposed to produce, with the count asserted first. */
function onlyProblem(problems: readonly RawFinding[]): RawFinding {
	expect(problems.map((problem) => `${problem.rule}: ${problem.message}`)).toHaveLength(1);
	return problems[0] as RawFinding;
}

function line(text: string, at: number, column = 1): SourceLine {
	return { text, line: at, column };
}

// ---------------------------------------------------------------------------
// fold.ts
// ---------------------------------------------------------------------------

describe('folding source lines', () => {
	test('joins two Latin lines with a space', () => {
		// The ordinary case, and the reason the fold exists at all: every corpus file is
		// hard-wrapped at about 75 columns, so a line break inside a paragraph is an
		// artefact of the file width and never content.
		const folded = foldLines([line('Hold the top edge', 1), line('against a tag.', 2)]);
		expect(folded.text).toBe('Hold the top edge against a tag.');
	});

	test('joins two wide lines with nothing at all', () => {
		// The CJK rule TextNode records. A space here is a visible gap mid-sentence in
		// Japanese and Chinese, which is what the whole joiner rule exists to avoid.
		const folded = foldLines([
			line('\u6b21\u306e\u624b\u9806\u3092', 1),
			line('\u78ba\u8a8d\u3057\u307e\u3059\u3002', 2),
		]);
		expect(folded.text).toBe('\u6b21\u306e\u624b\u9806\u3092\u78ba\u8a8d\u3057\u307e\u3059\u3002');
	});

	test('joins a mixed pair with a space, on both sides of the seam', () => {
		// One wide side and one narrow is the mixed-script seam, which is a real space to
		// a reader. Suppressing it would run a part number into the word after it.
		const wideThenNarrow = foldLines([
			line('\u30bf\u30b0\u306f', 1),
			line('NTAG213 \u3067\u3059\u3002', 2),
		]);
		expect(wideThenNarrow.text).toBe('\u30bf\u30b0\u306f NTAG213 \u3067\u3059\u3002');
		const narrowThenWide = foldLines([
			line('NTAG213', 1),
			line('\u306f\u5bfe\u5fdc\u3057\u307e\u3059\u3002', 2),
		]);
		expect(narrowThenWide.text).toBe('NTAG213 \u306f\u5bfe\u5fdc\u3057\u307e\u3059\u3002');
	});

	test('suppresses the joiner between two astral wide characters', () => {
		// U+20000 is in the WIDE table, and it is two UTF-16 code units. Reading one unit
		// off each side of the seam tests a lone surrogate, which matches nothing, so the
		// astral half of the table would silently never fire and a CJK Extension B page
		// would grow a space in the middle of every wrapped sentence.
		const folded = foldLines([line('\u{20000}', 1), line('\u{20001}', 2)]);
		expect(folded.text).toBe('\u{20000}\u{20001}');
		expect(isWide('\u{20000}')).toBe(true);
	});

	test('maps an offset back to the line and the column it was typed at', () => {
		// The whole reason this is a module rather than a join. Without the runs, every
		// finding in a fifty-line procedure reports the line the block started on.
		const folded = foldLines([line('alpha', 4), line('bravo', 5), line('charlie', 6)]);
		expect(folded.text).toBe('alpha bravo charlie');
		expect(positionAt(folded, FILE, 0)).toEqual({ file: FILE, line: 4, column: 1 });
		expect(positionAt(folded, FILE, 6)).toEqual({ file: FILE, line: 5, column: 1 });
		expect(positionAt(folded, FILE, 8)).toEqual({ file: FILE, line: 5, column: 3 });
		expect(positionAt(folded, FILE, 12)).toEqual({ file: FILE, line: 6, column: 1 });
		expect(positionAt(folded, FILE, 18)).toEqual({ file: FILE, line: 6, column: 7 });
	});

	test('carries a container marker column across, and gives a joiner to the line after it', () => {
		// A blockquote or a list item strips its marker and re-enters with the column
		// adjusted, so a finding inside one still points at the character the author typed.
		const folded = foldLines([line('quoted', 9, 3), line('again', 10, 3)]);
		expect(positionAt(folded, FILE, 0)).toEqual({ file: FILE, line: 9, column: 3 });
		// The joiner is not a character anybody typed, so it belongs to the run after it.
		expect(positionAt(folded, FILE, 6)).toEqual({ file: FILE, line: 10, column: 3 });
		expect(positionAt(folded, FILE, 7)).toEqual({ file: FILE, line: 10, column: 3 });
		expect(positionAt(folded, FILE, 8)).toEqual({ file: FILE, line: 10, column: 4 });
	});

	test('an offset past the end resolves to the end of the last run', () => {
		// A rule reporting a span that ends at the end of a paragraph is ordinary, and a
		// throw there would turn a style finding into a compiler crash.
		const folded = foldLines([line('alpha', 2)]);
		expect(positionAt(folded, FILE, 99)).toEqual({ file: FILE, line: 2, column: 6 });
		expect(positionAt({ text: '', runs: [] }, FILE, 3)).toEqual({ file: FILE, line: 1, column: 1 });
	});

	test('a trailing backslash becomes the break sentinel, not a joiner', () => {
		// The legal masthead is two consecutive source lines that mean two lines. The
		// sentinel is what the inline parser turns into a break node, and folding it to a
		// space instead loses the line break with nothing to say it did.
		const folded = foldLines([line('Fixture Pty Ltd\\', 1), line('Sydney', 2)]);
		expect(folded.text).toBe(`Fixture Pty Ltd${BREAK_SENTINEL}Sydney`);
		expect(folded.runs.map((run) => run.length)).toEqual([15, 6]);
		expect(positionAt(folded, FILE, 16)).toEqual({ file: FILE, line: 2, column: 1 });
	});

	test('a backslash on the last line is dropped rather than left dangling', () => {
		// It has nothing to break before. Left as a sentinel it reaches the inline parser
		// as a break node with no line after it, which renders as a trailing empty line.
		const folded = foldLines([line('Sydney', 1), line('Australia\\', 2)]);
		expect(folded.text).toBe('Sydney Australia');
		expect(folded.text.includes(BREAK_SENTINEL)).toBe(false);
	});

	test('a doubled backslash is an escaped backslash, not a break', () => {
		const folded = foldLines([line('C:\\\\', 1), line('next', 2)]);
		expect(folded.text).toBe('C:\\\\ next');
	});

	test('foldOne is one line and one run', () => {
		const folded = foldOne(line('## Station data', 12, 1));
		expect(folded.text).toBe('## Station data');
		expect(folded.runs).toEqual([{ offset: 0, length: 15, line: 12, column: 1 }]);
	});
});

describe('sliceFolded', () => {
	test('concatenates the slices and carries every position across', () => {
		// This is how a prose segment is built. What comes out is what a reader reads,
		// with the markup gone and every character still pointing at its own line.
		const folded = foldLines([line('alpha bravo', 3), line('charlie delta', 4)]);
		const sliced = sliceFolded(folded, [
			[0, 5],
			[12, 19],
		]);
		expect(sliced.text).toBe('alphacharlie');
		expect(sliced.runs).toEqual([
			{ offset: 0, length: 5, line: 3, column: 1 },
			{ offset: 5, length: 7, line: 4, column: 1 },
		]);
		expect(positionAt(sliced, FILE, 5)).toEqual({ file: FILE, line: 4, column: 1 });
	});

	test('splits one run when a range covers part of a line', () => {
		const folded = foldLines([line('alpha bravo', 3)]);
		const sliced = sliceFolded(folded, [[6, 11]]);
		expect(sliced.text).toBe('bravo');
		expect(sliced.runs).toEqual([{ offset: 0, length: 5, line: 3, column: 7 }]);
	});

	test('skips an empty range and keeps going', () => {
		// An empty range is what a link with no text produces, and it must not contribute
		// a zero-length run that later arithmetic divides the text at.
		const folded = foldLines([line('alpha bravo', 1)]);
		const sliced = sliceFolded(folded, [
			[0, 0],
			[6, 11],
		]);
		expect(sliced.text).toBe('bravo');
		expect(sliced.runs).toHaveLength(1);
	});

	test('throws on ranges that overlap', () => {
		// The ranges come from one left to right parse, so a caller that broke that has a
		// bug worth throwing over rather than a position worth guessing at.
		const folded = foldLines([line('alpha bravo', 1)]);
		expect(() =>
			sliceFolded(folded, [
				[0, 7],
				[5, 11],
			]),
		).toThrow(/cannot overlap/);
	});
});

describe('concatFolded', () => {
	test('offsets every run by the length of the parts before it', () => {
		const first = foldLines([line('alpha', 1)]);
		const second = foldLines([line('bravo', 2)]);
		const joined = concatFolded([first, second]);
		expect(joined.text).toBe('alphabravo');
		expect(positionAt(joined, FILE, 5)).toEqual({ file: FILE, line: 2, column: 1 });
	});
});

describe('readSource', () => {
	test('drops a BOM, converts CRLF and replaces U+0000', () => {
		// Each of the three is a character that would otherwise reach the tree. The BOM
		// becomes the first character of the first heading, a CR ends up inside a text
		// node, and a NUL would collide with the break sentinel and split a paragraph.
		const read = readSource('\ufeff# Title\r\nBody\u0000end\r\n');
		expect(read).toBe('# Title\nBody\ufffdend\n');
		expect(read.includes(BREAK_SENTINEL)).toBe(false);
	});

	test('drops only a leading BOM, so one mid-file survives as itself', () => {
		expect(readSource('a\ufeffb')).toBe('a\ufeffb');
	});

	test('toLines numbers from the line it is told, and starts every column at 1', () => {
		expect(toLines('one\ntwo', 7)).toEqual([
			{ text: 'one', line: 7, column: 1 },
			{ text: 'two', line: 8, column: 1 },
		]);
	});
});

// ---------------------------------------------------------------------------
// inline.ts
// ---------------------------------------------------------------------------

describe('inline nodes, and where each one came from', () => {
	test('emphasis', () => {
		const { nodes, origins } = parseInlineText('Writing is *destructive*.');
		const emphasis = inlineOfType(nodes, 1, 'emphasis');
		expect(inlineOfType(emphasis.children, 0, 'text').value).toBe('destructive');
		expect(originOf(origins, emphasis)).toBe(`${FILE}:1:12`);
	});

	test('strong, which is tried before emphasis', () => {
		// Without strong first, `**Write**` is an emphasis containing an emphasised empty
		// string, and the page renders a stray asterisk on a UI control name.
		const { nodes, origins } = parseInlineText('Tap **Write** to continue.');
		const strong = inlineOfType(nodes, 1, 'strong');
		expect(inlineOfType(strong.children, 0, 'text').value).toBe('Write');
		expect(originOf(origins, strong)).toBe(`${FILE}:1:5`);
	});

	test('strikethrough is exactly two tildes', () => {
		const { nodes, origins } = parseInlineText('The tag is ~~read only~~ now.');
		const struck = inlineOfType(nodes, 1, 'strikethrough');
		expect(inlineOfType(struck.children, 0, 'text').value).toBe('read only');
		expect(originOf(origins, struck)).toBe(`${FILE}:1:12`);
	});

	test('one tilde is a literal character, with a real strikethrough later on the line', () => {
		// A single tilde appears in paths and in approximate figures. Without the exactly
		// two rule the tilde in "~200" opens a span, the next `~~` closes it, and the
		// sentence between the two disappears into a strikethrough nobody asked for.
		const { nodes } = parseInlineText('About ~200 bytes in ~/Library, and ~~read only~~ tags.');
		expect(nodes.map((node) => node.type)).toEqual(['text', 'strikethrough', 'text']);
		expect(inlineOfType(nodes, 0, 'text').value).toBe('About ~200 bytes in ~/Library, and ');
		expect(inlineOfType(nodes, 2, 'text').value).toBe(' tags.');
	});

	test('inline code, with the position of the opening backtick', () => {
		const { nodes, origins } = parseInlineText('It prints `Tag is locked` and stops.');
		const code = inlineOfType(nodes, 1, 'inlineCode');
		expect(code.value).toBe('Tag is locked');
		expect(originOf(origins, code)).toBe(`${FILE}:1:11`);
	});

	test('a closing backtick run must be exactly as long as the opening one', () => {
		// CommonMark's rule. Getting it wrong turns an error string containing a backtick
		// into unparsed markdown halfway down a page.
		const { nodes } = parseInlineText('Use ``a ` b`` here.');
		expect(inlineOfType(nodes, 1, 'inlineCode').value).toBe('a ` b');

		const unclosed = parseInlineText('Use `a`` here.');
		expect(unclosed.nodes).toHaveLength(1);
		expect(inlineOfType(unclosed.nodes, 0, 'text').value).toBe('Use `a`` here.');
	});

	test('one space either side of a code span is stripped, and a lone space is not', () => {
		expect(inlineOfType(parseInlineText('a ` b ` c').nodes, 1, 'inlineCode').value).toBe('b');
		expect(inlineOfType(parseInlineText('a `  ` c').nodes, 1, 'inlineCode').value).toBe('  ');
	});

	test('a code span spanning a hard break keeps the break as a space', () => {
		// A sentinel left inside the value reaches the renderer as U+0000.
		const { nodes } = parseInlineText('Run `swift build\\\ntest` now.');
		const code = inlineOfType(nodes, 1, 'inlineCode');
		expect(code.value).toBe('swift build test');
		expect(code.value.includes(BREAK_SENTINEL)).toBe(false);
	});

	test('the four link kinds, each through the resolver', () => {
		const internal = parseInlineText('See [the first scan](first-tag.md#step-one).');
		const link = inlineOfType(internal.nodes, 1, 'link');
		expect(link.kind).toBe('internal');
		expect(link.kind === 'internal' ? link.slug : '').toBe('guide/first-tag');
		expect(link.kind === 'internal' ? link.anchor : '').toBe('step-one');
		expect(inlineOfType(link.children, 0, 'text').value).toBe('the first scan');
		expect(originOf(internal.origins, link)).toBe(`${FILE}:1:5`);

		const anchor = inlineOfType(
			parseInlineText('[What you need](#what-you-need)').nodes,
			0,
			'link',
		);
		expect(anchor.kind === 'anchor' ? anchor.anchor : '').toBe('what-you-need');

		const external = inlineOfType(
			parseInlineText('[Fixture App](https://example.com/fixture-app)').nodes,
			0,
			'link',
		);
		expect(external.kind === 'external' ? external.href : '').toBe(
			'https://example.com/fixture-app',
		);

		const mailto = inlineOfType(
			parseInlineText('[Write to us](mailto:docs@example.com)').nodes,
			0,
			'link',
		);
		expect(mailto.kind === 'mailto' ? mailto.address : '').toBe('docs@example.com');
	});

	test('a link title is scanned as prose of its own, and the destination is not scanned', () => {
		// The title used to reach no prose segment at all, which put a blind spot in every
		// house-style rule over text a reader meets through a tooltip and a screen reader.
		// It is its own segment rather than part of the paragraph's, because splicing its
		// range in folds `See [the guide](x.md "The first scan").` to `See the guideThe
		// first scan.`, an adjacency no author wrote. The destination stays out of both: it
		// is an address, and scanning it would report the hyphen in a slug as punctuation.
		const { nodes, prose, titles } = parseInlineText(
			'See [the guide](first-tag.md "The first scan").',
		);
		const link = inlineOfType(nodes, 1, 'link');
		expect(link.title).toBe('The first scan');
		expect(prose).toBe('See the guide.');
		expect(titles.map((title) => title.text)).toEqual(['The first scan']);
		// Column 31: the character after the opening quote, which is where the title's own
		// text starts and what a reader of the finding needs.
		expect(titles[0]?.runs[0]?.column).toBe(31);
	});

	test('an image, with its size from the resolver and its alt text in the prose', () => {
		// The alt text is prose a reader hears, so it is scanned like any other prose.
		const { nodes, prose, origins } = parseInlineText('A ![completed read](scan.png) appears.');
		const image = inlineOfType(nodes, 1, 'image');
		expect(image).toEqual({
			type: 'image',
			src: 'assets/abc.png',
			alt: 'completed read',
			width: 320,
			height: 208,
		});
		expect(originOf(origins, image)).toBe(`${FILE}:1:3`);
		expect(prose).toBe('A completed read appears.');
	});

	test('a hard break becomes a break node between the two lines', () => {
		const { nodes, origins } = parseInlineText('Fixture Pty Ltd\\\nSydney');
		expect(inlineOfType(nodes, 0, 'text').value).toBe('Fixture Pty Ltd');
		const hardBreak = inlineOfType(nodes, 1, 'break');
		expect(inlineOfType(nodes, 2, 'text').value).toBe('Sydney');
		// The sentinel sits at the seam, and the seam belongs to the line that follows it.
		expect(originOf(origins, hardBreak)).toBe(`${FILE}:2:1`);
	});

	test('a node on the second line of a fold records the second line', () => {
		// The property the whole fold exists for. Without it a fifty-line procedure reports
		// every one of its findings against the line its first word is on.
		const { blocks, origins } = parseBody('Words about the tag\nand then *emphasis* here.\n');
		const paragraph = blockOfType(blocks, 0, 'paragraph');
		expect(originOf(origins, paragraph)).toBe(`${FILE}:1:1`);
		expect(originOf(origins, paragraph.children[0] as object)).toBe(`${FILE}:1:1`);
		expect(originOf(origins, paragraph.children[1] as object)).toBe(`${FILE}:2:10`);
		expect(originOf(origins, paragraph.children[2] as object)).toBe(`${FILE}:2:20`);
	});

	test('a status glyph in a sentence becomes a node and leaves the prose', () => {
		// `no-decorative-unicode` must see the tick that is decoration and must not see
		// the 59 that are a support matrix, which is what taking it out of the prose does.
		const { nodes, prose, origins } = parseInlineText(
			'A \u26a0\ufe0f in the Write column means partial.',
		);
		const status = inlineOfType(nodes, 1, 'status');
		expect(status.value).toBe('partial');
		expect(originOf(origins, status)).toBe(`${FILE}:1:3`);
		expect(prose).toBe('A  in the Write column means partial.');
		// The variation selector is consumed with the glyph rather than stranded beside it
		// as a one-character text node, which is how a matrix cell renders an artefact.
		expect(inlineOfType(nodes, 2, 'text').value).toBe(' in the Write column means partial.');
	});

	test('every status spelling is recognised in its own scope and nowhere else', () => {
		let examined = 0;
		for (const spelling of STATUS_GLYPHS) {
			const glyph = statusGlyphText(spelling);
			const inScope = parseInlineText(glyph, { scope: spelling.scope });
			const status = inlineOfType(inScope.nodes, 0, 'status');
			expect(status.value, spelling.name).toBe(spelling.value);
			expect(inScope.prose.trim(), spelling.name).toBe('');

			if (spelling.scope === 'cell') {
				// The em dash means "not applicable" only as the whole of a cell. Recognising
				// it anywhere else hands every author a one-character way to write a
				// character the house rules ban, which no prose rule could then see.
				const inline = parseInlineText(glyph, { scope: 'inline' });
				expect(
					inline.nodes.map((node) => node.type),
					spelling.name,
				).toEqual(['text']);
				const partOfACell = parseInlineText(`n/a ${glyph}`, { scope: 'cell' });
				expect(
					partOfACell.nodes.map((node) => node.type),
					spelling.name,
				).toEqual(['text']);
			}
			examined += 1;
		}
		expect(examined).toBe(STATUS_GLYPHS.length);
	});
});

describe('what must not become a node', () => {
	test('an underscore inside an identifier', () => {
		// Without the rule, FIXTURE_TAG_LOG becomes emphasised text and the underscores
		// vanish from a page telling somebody what to type into a shell.
		const { nodes } = parseInlineText('Set FIXTURE_TAG_LOG to 1 and session(_:didConnect:) logs.');
		expect(nodes.map((node) => node.type)).toEqual(['text']);
		expect(inlineOfType(nodes, 0, 'text').value).toBe(
			'Set FIXTURE_TAG_LOG to 1 and session(_:didConnect:) logs.',
		);
	});

	test('an underscore that opens on a word boundary still emphasises', () => {
		const { nodes } = parseInlineText('The word _destructive_ matters.');
		expect(inlineOfType(nodes, 1, 'emphasis').children).toHaveLength(1);
	});

	test('an unmatched delimiter stays literal', () => {
		const { nodes } = parseInlineText('A 4 *5 grid, ~~struck but never closed.');
		expect(nodes.map((node) => node.type)).toEqual(['text']);
		expect(inlineOfType(nodes, 0, 'text').value).toBe('A 4 *5 grid, ~~struck but never closed.');
	});

	test('a link whose destination does not resolve keeps the words and reports the failure', () => {
		// A bundle carrying an unresolved link would publish a link to a 404 that renders
		// as a link. The words survive, the link does not, and `link-resolves` is an error
		// so nothing publishes either way.
		const { nodes, problems, prose } = parseInlineText('See [the missing page](gone.md) for more.');
		expect(nodes.map((node) => node.type)).toEqual(['text', 'text', 'text']);
		expect(nodes.map((node) => (node.type === 'text' ? node.value : '')).join('')).toBe(
			'See the missing page for more.',
		);
		expect(prose).toBe('See the missing page for more.');
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('link-resolves');
		expect(positionOf(problem)).toBe(`${FILE}:1:5`);
		expect(problem.excerpt).toBe('gone.md');
	});

	test('an image whose asset does not resolve keeps the alt text and reports the failure', () => {
		const { nodes, problems } = parseInlineText('Here ![a missing shot](gone.png) is.');
		expect(nodes.map((node) => node.type)).toEqual(['text']);
		expect(inlineOfType(nodes, 0, 'text').value).toBe('Here a missing shot is.');
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('link-resolves');
		expect(positionOf(problem)).toBe(`${FILE}:1:6`);
	});

	test('a link reported on the second line of a fold points at the second line', () => {
		// The reason positions live beside the tree. A fifty-line procedure would
		// otherwise report every one of its findings against the line the block started on.
		const { problems } = parseInlineText('The first line is fine.\nSee [the page](gone.md).');
		expect(positionOf(onlyProblem(problems))).toBe(`${FILE}:2:5`);
	});
});

describe('what the prose excludes', () => {
	test('inline code, link destinations and recognised status glyphs', () => {
		// The three things a house-style rule must never read: a fence's contents are never
		// prose, a URL is not a sentence, and a status glyph is data rather than decoration.
		const { prose } = parseInlineText(
			'Read \u2705 the `Tag is locked` message in [the guide](first-tag.md).',
		);
		expect(prose).toBe('Read  the  message in the guide.');
	});

	test('an escape contributes its character, and the columns after it stay right', () => {
		// The backslash is not what a reader reads, so it is not prose. The column is the
		// half that has to survive: the prose is a list of source ranges rather than one
		// flat slice, so the range after the escape still carries its own column and a
		// finding on the last word does not report one character early.
		const { nodes, prose } = parseInline(foldLines(toLines('A \\* is not a bullet.')), {
			file: FILE,
			scope: 'inline',
			origins: new WeakMap(),
			services: stubServices(),
			problems: [],
		});
		expect(inlineOfType(nodes, 0, 'text').value).toBe('A * is not a bullet.');
		expect(prose.text).toBe('A * is not a bullet.');
		expect(prose.text.indexOf('bullet')).toBe(13);
		expect(positionAt(prose, FILE, 13)).toEqual({ file: FILE, line: 1, column: 15 });
	});
});

// ---------------------------------------------------------------------------
// blocks.ts: headings
// ---------------------------------------------------------------------------

describe('headings', () => {
	test('a level two heading carries its text, its slug id and its position', () => {
		const { blocks, origins } = parseBody('## What you need\n');
		const heading = blockOfType(blocks, 0, 'heading');
		expect(heading.depth).toBe(2);
		expect(heading.id).toBe('what-you-need');
		expect(heading.idSource).toBe('slug');
		expect(originOf(origins, heading)).toBe(`${FILE}:1:1`);
		// The text starts after the hashes and the space, which is what a finding inside a
		// heading has to point at.
		expect(originOf(origins, heading.children[0] as object)).toBe(`${FILE}:1:4`);
	});

	test('a level one heading is refused and the line is dropped, never demoted', () => {
		// Demoting it would put two titles on the page, one of them wrong, and the nav,
		// the manifest, the search index and the tab would all still use the front matter.
		const { blocks, problems } = parseBody('Intro.\n\n# A second title\n\nBody.\n');
		expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph']);
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('no-h1-in-body');
		expect(positionOf(problem)).toBe(`${FILE}:3:1`);
		expect(problem.excerpt).toBe('# A second title');
	});

	test('an explicit id wins, and the marker leaves the heading text', () => {
		const { blocks } = parseBody('## Module graph {#module-graph}\n');
		const heading = blockOfType(blocks, 0, 'heading');
		expect(heading.id).toBe('module-graph');
		expect(heading.idSource).toBe('explicit');
		expect(inlineOfType(heading.children, 0, 'text').value).toBe('Module graph');
	});

	test('a heading deeper than four is reported and still parsed', () => {
		// Deeper than anything the package renders distinguishably. It is still a heading
		// in the tree, because dropping it would take its section with it.
		const { blocks, problems } = parseBody('##### Tags that read once\n');
		expect(blockOfType(blocks, 0, 'heading').depth).toBe(5);
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('heading-depth');
		expect(positionOf(problem)).toBe(`${FILE}:1:1`);
	});

	test('a heading inside a container reports the line the author typed it on', () => {
		const { blocks, origins } = parseBody(':::note\n\n### Inside\n\n:::\n');
		const callout = blockOfType(blocks, 0, 'callout');
		const heading = blockOfType(callout.children, 0, 'heading');
		expect(originOf(origins, heading)).toBe(`${FILE}:3:1`);
	});
});

describe('deriveHeadingId', () => {
	test('an explicit id beats a section number and a slug', () => {
		// The only anchor spelling that is identical in every language, which is why a
		// translator is asked to copy it across unchanged.
		expect(deriveHeadingId('4. Termination', 'ends', 'section-number')).toEqual({
			id: 'ends',
			source: 'explicit',
		});
	});

	test('a section number wins under a project configured for it', () => {
		// `#section-4` addresses the same clause in all seven languages. Slugified headings
		// would give every language its own anchors and break every inbound link silently.
		expect(deriveHeadingId('4.2 Refunds', undefined, 'section-number')).toEqual({
			id: 'section-4-2',
			source: 'section-number',
		});
		expect(deriveHeadingId('4.2 Refunds', undefined, 'slug')).toEqual({
			id: '4-2-refunds',
			source: 'slug',
		});
	});

	test('slugify keeps letters and numbers in any script, and falls back to section', () => {
		expect(slugifyHeading('What you need')).toBe('what-you-need');
		expect(slugifyHeading('\u6982\u8981')).toBe('\u6982\u8981');
		expect(slugifyHeading('***')).toBe('section');
	});
});

// ---------------------------------------------------------------------------
// blocks.ts: fences
// ---------------------------------------------------------------------------

describe('code fences', () => {
	test('the full option set reaches the node', () => {
		// Filename, line numbers, a start line, a highlight range and wrap in one info
		// string is what proves the fence grammar is not five separate special cases.
		const { blocks, problems, origins } = parseBody(
			[
				'```swift title="TagSession.swift" lineNumbers start=12 highlight="2,5-7" wrap',
				'public func begin() throws {',
				'}',
				'```',
			].join('\n'),
		);
		expect(problems).toEqual([]);
		const code = blockOfType(blocks, 0, 'code');
		expect(code.lang).toBe('swift');
		expect(code.filename).toBe('TagSession.swift');
		expect(code.showLineNumbers).toBe(true);
		expect(code.startLine).toBe(12);
		expect(code.highlight).toEqual([2, 5, 6, 7]);
		expect(code.wrap).toBe(true);
		expect(code.lines).toHaveLength(2);
		expect(originOf(origins, code)).toBe(`${FILE}:1:1`);
	});

	test('an absent option is absent from the node, never defaulted to a value', () => {
		const { blocks } = parseBody('```swift\nlet a = 1\n```');
		const code = blockOfType(blocks, 0, 'code');
		expect(code.showLineNumbers).toBe(false);
		expect('filename' in code).toBe(false);
		expect('startLine' in code).toBe(false);
		expect('highlight' in code).toBe(false);
		expect('wrap' in code).toBe(false);
	});

	test('an unknown option is reported rather than ignored', () => {
		// A misspelled `linenumbers` that silently did nothing looks exactly like a
		// renderer bug, and the author goes looking in the wrong half of the package.
		const { problems } = parseBody('```swift linenumbers\nlet a = 1\n```');
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('unsupported-syntax');
		expect(problem.message).toContain('"linenumbers" is not an option');
		expect(positionOf(problem)).toBe(`${FILE}:1:1`);
		expect(problem.excerpt).toBe('swift linenumbers');
	});

	test('an option given the wrong arity is reported, in both directions', () => {
		const flag = parseBody('```swift lineNumbers=yes\nlet a = 1\n```');
		expect(onlyProblem(flag.problems).message).toBe(
			'"lineNumbers" is a flag and takes no value. Write it on its own.',
		);
		const value = parseBody('```swift title\nlet a = 1\n```');
		expect(onlyProblem(value.problems).message).toBe('"title" needs a value, as title="...".');
	});

	test('a start line and a highlight list that are not numbers are refused', () => {
		const start = parseBody('```swift start=twelve\nlet a = 1\n```');
		expect(onlyProblem(start.problems).message).toBe('start="twelve" is not a line number.');
		expect('startLine' in blockOfType(start.blocks, 0, 'code')).toBe(false);

		const highlight = parseBody('```swift highlight="7-5"\nlet a = 1\n```');
		expect(onlyProblem(highlight.problems).message).toBe('highlight="7-5" is not a line list.');
		expect('highlight' in blockOfType(highlight.blocks, 0, 'code')).toBe(false);
	});

	test('an unclosed fence is reported and the rest of the file is its body', () => {
		const { blocks, problems } = parseBody('```swift\nlet a = 1\nlet b = 2\n');
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('unsupported-syntax');
		expect(problem.message).toBe('A code fence opened with 3 backticks is never closed.');
		expect(positionOf(problem)).toBe(`${FILE}:1:1`);
		expect(blocks.map((block) => block.type)).toEqual(['code']);
		expect(blockOfType(blocks, 0, 'code').lines).toHaveLength(3);
	});

	test('a fence closes only on a marker at least as long as the one that opened it', () => {
		const { blocks, problems } = parseBody(
			['````text', '```', 'still inside', '````', 'After.'].join('\n'),
		);
		expect(problems).toEqual([]);
		expect(blocks.map((block) => block.type)).toEqual(['code', 'paragraph']);
		expect(blockOfType(blocks, 0, 'code').lines).toHaveLength(2);
	});

	test('a language outside the project allowlist is reported, with the allowlist', () => {
		const { blocks, problems } = parseBody('```python\nprint(1)\n```');
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('code-fence-language');
		expect(problem.message).toBe('"python" is not in this project\'s fence language allowlist.');
		expect(problem.remediation).toContain('text, swift, json');
		expect(problem.excerpt).toBe('python');
		// The node still carries the language: a bundle compiled under a project that
		// downgraded the rule contains one, and dropping it would erase the chip as well.
		expect(blockOfType(blocks, 0, 'code').lang).toBe('python');
	});

	test('an unlabelled fence is reported and carries no language at all', () => {
		const { blocks, problems } = parseBody('```\nTagSession begin\n```');
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('code-fence-language');
		expect(problem.message).toContain('carries no language');
		expect(problem.excerpt).toBe(null);
		expect('lang' in blockOfType(blocks, 0, 'code')).toBe(false);
	});

	test('an indented fence keeps its own indentation out of the body', () => {
		const { blocks } = parseBody(['- item', '', '  ```text', '  one', '  ```'].join('\n'));
		const list = blockOfType(blocks, 0, 'list');
		const item = list.children[0];
		expect(item).toBeDefined();
		const code = blockOfType(item?.children ?? [], 1, 'code');
		expect(code.lines[0]?.tokens[0]?.text).toBe('one');
	});
});

// ---------------------------------------------------------------------------
// blocks.ts: lists
// ---------------------------------------------------------------------------

describe('lists', () => {
	test('a bullet list is tight, with one item per marker and each marker recorded', () => {
		const { blocks, origins } = parseBody('- text records\n- URI records\n');
		const list = blockOfType(blocks, 0, 'list');
		expect(list.style).toBe('bullet');
		expect(list.tight).toBe(true);
		expect('start' in list).toBe(false);
		expect(list.children).toHaveLength(2);
		expect(originOf(origins, list)).toBe(`${FILE}:1:1`);
		expect(originOf(origins, list.children[1] as object)).toBe(`${FILE}:2:1`);
	});

	test('an ordered list starting at 1 carries no start', () => {
		const { blocks } = parseBody('1. Open the sheet\n2. Hold the tag\n');
		const list = blockOfType(blocks, 0, 'list');
		expect(list.style).toBe('ordered');
		expect('start' in list).toBe(false);
	});

	test('an ordered list that does not start at 1 records where it starts', () => {
		// The only thing that stops a continued procedure being renumbered silently.
		const { blocks } = parseBody('3. "Still looking" appears\n4. Move the phone\n');
		const list = blockOfType(blocks, 0, 'list');
		expect(list.style).toBe('ordered');
		expect(list.start).toBe(3);
		expect(list.children).toHaveLength(2);
	});

	test('task items carry checked, and an ordinary item carries no such key', () => {
		const { blocks } = parseBody('- [x] An iPhone 7 or later\n- [ ] A tag\n- Neither\n');
		const list = blockOfType(blocks, 0, 'list');
		const [first, second, third] = list.children;
		expect(first?.checked).toBe(true);
		expect(second?.checked).toBe(false);
		expect(third === undefined ? true : 'checked' in third).toBe(false);
		// The marker is consumed, so it is not also text at the head of the item.
		const paragraph = blockOfType(first?.children ?? [], 0, 'paragraph');
		expect(inlineOfType(paragraph.children, 0, 'text').value).toBe('An iPhone 7 or later');
	});

	test('two levels of nesting, with the inner list inside the outer item', () => {
		const { blocks, origins } = parseBody(
			[
				'- Metal behind the tag',
				'  - A ferrite layer',
				'  - A thicker case',
				'- Another cause',
			].join('\n'),
		);
		const outer = blockOfType(blocks, 0, 'list');
		expect(outer.children).toHaveLength(2);
		const inner = blockOfType(outer.children[0]?.children ?? [], 1, 'list');
		expect(inner.children).toHaveLength(2);
		// The nested marker keeps its absolute column, so a finding inside it points at
		// the character the author typed rather than at the start of the outer item.
		expect(originOf(origins, inner.children[0] as object)).toBe(`${FILE}:2:3`);
		const nested = blockOfType(inner.children[0]?.children ?? [], 0, 'paragraph');
		expect(originOf(origins, nested)).toBe(`${FILE}:2:5`);
	});

	test('a blank line between two items makes the list loose', () => {
		const { blocks } = parseBody('- one\n\n- two\n');
		expect(blockOfType(blocks, 0, 'list').tight).toBe(false);
	});

	test('a blank line after the last item does not', () => {
		// Trailing blanks are the ordinary shape of a document. Counting them would make
		// nearly every list in the corpus loose, and the renderer branches on the flag.
		const { blocks } = parseBody('- one\n- two\n\nA paragraph.\n');
		expect(blockOfType(blocks, 0, 'list').tight).toBe(true);
		expect(blocks.map((block) => block.type)).toEqual(['list', 'paragraph']);
	});

	test('a blank line inside an item makes the list loose and keeps the two blocks apart', () => {
		const { blocks } = parseBody('- one\n\n  still one\n- two\n');
		const list = blockOfType(blocks, 0, 'list');
		expect(list.tight).toBe(false);
		expect(list.children[0]?.children.map((block) => block.type)).toEqual([
			'paragraph',
			'paragraph',
		]);
	});

	test('an ordered marker that does not start at 1 never interrupts a paragraph', () => {
		// CommonMark's rule, and it exists for a real sentence: a wrapped line beginning
		// "1985. The standard was" is prose, not a list.
		const { blocks } = parseBody('The standard dates from\n1985. It has not changed.\n');
		expect(blocks.map((block) => block.type)).toEqual(['paragraph']);
	});
});

// ---------------------------------------------------------------------------
// blocks.ts: tables
// ---------------------------------------------------------------------------

describe('tables', () => {
	test('alignment comes from the delimiter row, one entry per column', () => {
		const { blocks, origins } = parseBody(
			[
				'| Chip | Read | Write | Lock | Bytes |',
				'| :--- | --- | :---: | --- | ---: |',
				'| NTAG213 | \u2705 | \u2705 | \u274c | 137 |',
				'| NTAG215 | \u2705 | \u26a0\ufe0f | \u2014 | 504 |',
			].join('\n'),
		);
		const table = blockOfType(blocks, 0, 'table');
		expect(table.align).toEqual(['left', null, 'center', null, 'right']);
		expect(table.header).toHaveLength(5);
		expect(table.rows).toHaveLength(2);
		expect(originOf(origins, table)).toBe(`${FILE}:1:1`);
		// A cell points at its own column in its own row, which is what makes a finding in
		// an 86-cell matrix answerable.
		expect(originOf(origins, table.rows[1]?.[2] as object)).toBe(`${FILE}:4:17`);
	});

	test('a status glyph is the whole of a cell and an em dash is data only there', () => {
		const { blocks } = parseBody(
			['| Chip | Lock |', '| --- | --- |', '| NTAG213 | \u274c |', '| NTAG215 | \u2014 |'].join(
				'\n',
			),
		);
		const table = blockOfType(blocks, 0, 'table');
		expect(inlineOfType(table.rows[0]?.[1]?.children ?? [], 0, 'status').value).toBe('no');
		expect(inlineOfType(table.rows[1]?.[1]?.children ?? [], 0, 'status').value).toBe('na');
	});

	test('the align array is padded when the delimiter row is short', () => {
		// A short row would otherwise index past the end and give the last columns
		// `undefined` where the contract says `null`, which is a schema failure at publish.
		const { blocks } = parseBody(['| A | B | C |', '| --- | --- |', '| 1 | 2 | 3 |'].join('\n'));
		const table = blockOfType(blocks, 0, 'table');
		expect(table.align).toEqual([null, null, null]);
		expect(table.header).toHaveLength(3);
	});

	test('an empty header cell is reported against the header line', () => {
		// A blank header is a column a screen reader announces as nothing and a search
		// result cannot label.
		const { blocks, problems } = parseBody(
			['| Notation |  |', '| --- | --- |', '| `0x04` | A byte |'].join('\n'),
		);
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('table-header-required');
		expect(positionOf(problem)).toBe(`${FILE}:1:1`);
		expect(blockOfType(blocks, 0, 'table').header).toHaveLength(2);
	});

	test('a table longer than the budget is reported with both numbers', () => {
		const rows = Array.from({ length: 4 }, (_, index) => `| ${index} | ${index} |`);
		const { problems } = parseBody(['| A | B |', '| --- | --- |', ...rows].join('\n'), {
			config: { ...CONFIG, budgets: { ...DEFAULT_BUDGETS, tableRowsMax: 3 } },
		});
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('page-size');
		expect(problem.message).toBe('This table has 4 rows and the budget is 3.');
	});

	test('a row with no outer pipes parses to the same cells', () => {
		const { blocks } = parseBody(['A | B', '--- | ---', '1 | 2'].join('\n'));
		const table = blockOfType(blocks, 0, 'table');
		expect(table.header).toHaveLength(2);
		expect(table.rows[0]).toHaveLength(2);
	});

	test('the table ends at the first line with no pipe in it', () => {
		const { blocks } = parseBody(
			['| A | B |', '| --- | --- |', '| 1 | 2 |', 'After the table.'].join('\n'),
		);
		expect(blocks.map((block) => block.type)).toEqual(['table', 'paragraph']);
		expect(blockOfType(blocks, 0, 'table').rows).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// blocks.ts: blockquotes and callouts
// ---------------------------------------------------------------------------

describe('blockquotes', () => {
	test('a quote holds blocks, not inline, and keeps its own columns', () => {
		// Blockquote children are blocks. Inline-only children would lose both the link
		// and the paragraph boundary in the one quote in the corpus that carries both.
		const { blocks, origins } = parseBody(
			['> A tag that fails to write', '> is usually not faulty.', '>', '> Try another phone.'].join(
				'\n',
			),
		);
		const quote = blockOfType(blocks, 0, 'blockquote');
		// The bare `>` line is a blank line inside the quote, so the two halves stay two
		// paragraphs. Folding them into one would run two sentences together.
		expect(quote.children.map((block) => block.type)).toEqual(['paragraph', 'paragraph']);
		expect(originOf(origins, quote)).toBe(`${FILE}:1:1`);
		const paragraph = blockOfType(quote.children, 0, 'paragraph');
		expect(originOf(origins, paragraph)).toBe(`${FILE}:1:3`);
		expect(inlineOfType(paragraph.children, 0, 'text').value).toBe(
			'A tag that fails to write is usually not faulty.',
		);
		const second = blockOfType(quote.children, 1, 'paragraph');
		expect(originOf(origins, second)).toBe(`${FILE}:4:3`);
	});

	test('every GitHub alert kind compiles to a callout of that kind', () => {
		// The spelling that renders in the GitHub UI, where a developer reads the page
		// long before it is published. Both spellings must produce the same node.
		let examined = 0;
		for (const kind of CALLOUT_KINDS) {
			const { blocks } = parseBody(`> [!${kind.toUpperCase()}]\n> Mind this.\n`);
			const callout = blockOfType(blocks, 0, 'callout');
			expect(callout.kind, kind).toBe(kind);
			expect('title' in callout, kind).toBe(false);
			expect(blockOfType(callout.children, 0, 'paragraph').children, kind).toHaveLength(1);
			examined += 1;
		}
		expect(examined).toBe(CALLOUT_KINDS.length);
	});

	test('an alert marker in lower case is a quote, because GitHub reads only upper case', () => {
		const { blocks } = parseBody('> [!warning]\n> Mind this.\n');
		expect(blocks.map((block) => block.type)).toEqual(['blockquote']);
	});
});

// ---------------------------------------------------------------------------
// blocks.ts: directives
// ---------------------------------------------------------------------------

/**
 * One source per container directive name, checked against the union in both directions.
 *
 * A callout kind added to `CALLOUT_KINDS` without being added to the parser is exactly
 * the failure `CONTAINER_DIRECTIVE_NAMES` is derived to prevent, and a table written out
 * by hand here would go stale the same way.
 */
const CONTAINER_SOURCES: Record<ContainerDirectiveName, { source: string[]; produces: string }> = {
	note: { source: [':::note[Background scanning]', 'Body.', ':::'], produces: 'callout' },
	tip: { source: [':::tip', 'Body.', ':::'], produces: 'callout' },
	important: { source: [':::important', 'Body.', ':::'], produces: 'callout' },
	warning: { source: [':::warning[A partial read]', 'Body.', ':::'], produces: 'callout' },
	caution: { source: [':::caution', 'Body.', ':::'], produces: 'callout' },
	steps: {
		source: ['::::steps', ':::step[Open the Scan sheet]', 'Body.', ':::', '::::'],
		produces: 'steps',
	},
	step: {
		source: ['::::steps', ':::step[Open the Scan sheet]', 'Body.', ':::', '::::'],
		produces: 'steps',
	},
	figure: {
		source: [':::figure[The Scan sheet]', '![A tag](scan.png)', ':::'],
		produces: 'figure',
	},
	table: {
		source: [':::table[Chip support]', '| A | B |', '| --- | --- |', '| 1 | 2 |', ':::'],
		produces: 'table',
	},
};

describe('container directives', () => {
	test('every name in the union is understood, and nothing else is declared here', () => {
		expect(Object.keys(CONTAINER_SOURCES).sort()).toEqual([...CONTAINER_DIRECTIVE_NAMES].sort());
		let examined = 0;
		for (const name of CONTAINER_DIRECTIVE_NAMES) {
			const entry = CONTAINER_SOURCES[name];
			const { blocks, problems } = parseBody(entry.source.join('\n'));
			expect(
				problems.map((problem) => problem.message),
				name,
			).toEqual([]);
			expect(blocks[0]?.type, name).toBe(entry.produces);
			examined += 1;
		}
		expect(examined).toBe(CONTAINER_DIRECTIVE_NAMES.length);
	});

	test('a callout label becomes its title, and an absent one leaves the field absent', () => {
		// Absent means the renderer supplies the localised default label, which is a path
		// that exists in seven languages and would otherwise never run.
		const titled = parseBody(':::note[Background scanning]\nBody.\n:::');
		const callout = blockOfType(titled.blocks, 0, 'callout');
		expect(callout.kind).toBe('note');
		expect(inlineOfType(callout.title ?? [], 0, 'text').value).toBe('Background scanning');
		expect(originOf(titled.origins, (callout.title ?? [])[0] as object)).toBe(`${FILE}:1:9`);

		const untitled = parseBody(':::tip\nBody.\n:::');
		expect('title' in blockOfType(untitled.blocks, 0, 'callout')).toBe(false);
	});

	test('a steps container holds steps, each with an anchor of its own', () => {
		// A step is linkable from a support reply, which is why it carries an id at all.
		const { blocks, origins } = parseBody(
			[
				'::::steps',
				':::step[Open the Scan sheet]',
				'Tap Scan.',
				':::',
				':::step[Hold the tag]',
				'Wait.',
				':::',
				'::::',
			].join('\n'),
		);
		const steps = blockOfType(blocks, 0, 'steps');
		expect(steps.children).toHaveLength(2);
		const [first, second] = steps.children;
		expect(first?.id).toBe('open-the-scan-sheet');
		expect(second?.id).toBe('hold-the-tag');
		expect(originOf(origins, first as object)).toBe(`${FILE}:2:1`);
		expect(originOf(origins, second as object)).toBe(`${FILE}:5:1`);
		expect(blockOfType(first?.children ?? [], 0, 'paragraph').children).toHaveLength(1);
	});

	test('a figure takes its caption from the label and its image from inside', () => {
		// Written as the container's last paragraph the caption would be ambiguous with the
		// prose after a table, and the ambiguity shows up as a missing sentence on a page.
		const { blocks } = parseBody(
			[':::figure[The Scan sheet, waiting]', '![A completed read](scan.png)', ':::'].join('\n'),
		);
		const figure = blockOfType(blocks, 0, 'figure');
		expect(figure.image.src).toBe('assets/abc.png');
		expect(inlineOfType(figure.caption ?? [], 0, 'text').value).toBe('The Scan sheet, waiting');
	});

	test('a paragraph holding nothing but an image is promoted to a figure', () => {
		// A compile-time decision on purpose. Left to the renderer the difference between
		// a paragraph and a figure would depend on whether a stray space survived the parse.
		const { blocks } = parseBody('![A completed read](scan.png)\n');
		const figure = blockOfType(blocks, 0, 'figure');
		expect(figure.image.alt).toBe('A completed read');
		expect('caption' in figure).toBe(false);
	});

	test('an image with words beside it stays inline', () => {
		const { blocks } = parseBody('A ![contactless](scan.png) glyph.\n');
		const paragraph = blockOfType(blocks, 0, 'paragraph');
		expect(paragraph.children.map((child) => child.type)).toEqual(['text', 'image', 'text']);
	});

	test('a table container carries the caption onto the table it holds', () => {
		const { blocks } = parseBody(
			[':::table[Chip support]', '| A | B |', '| --- | --- |', '| 1 | 2 |', ':::'].join('\n'),
		);
		const table = blockOfType(blocks, 0, 'table');
		expect(inlineOfType(table.caption ?? [], 0, 'text').value).toBe('Chip support');
	});
});

describe('directives that are refused', () => {
	test('a close that does not match the width it opened with', () => {
		// Nesting adds a colon to the outer marker, which is what lets a step sit inside a
		// steps container without an ambiguous close. A close of the wrong width is not
		// one, and the close then reports itself as well: two findings on one mistake is
		// the honest answer, because the author has two lines to look at.
		const { problems } = parseBody('::::note\nBody.\n:::\n');
		expect(problems.map((problem) => `${positionOf(problem)} ${problem.message}`)).toEqual([
			`${FILE}:1:1 The "::::note" container is never closed at the width it opened with (4 colons).`,
			`${FILE}:3:1 A directive close with no container open above it.`,
		]);
		expect(problems.every((problem) => problem.rule === 'unsupported-syntax')).toBe(true);
	});

	test('a name that is not a container directive, with the contents kept', () => {
		// The contents are kept as ordinary blocks rather than dropped: a directive nobody
		// implemented must not take a section of the page with it.
		const { blocks, problems } = parseBody(':::aside[Sidebar]\nBody.\n:::\n');
		const problem = onlyProblem(problems);
		expect(problem.message).toBe('":::aside" is not a directive this AST major understands.');
		expect(positionOf(problem)).toBe(`${FILE}:1:1`);
		expect(blocks.map((block) => block.type)).toEqual(['paragraph']);
	});

	test('a step outside a steps container', () => {
		const { blocks, problems } = parseBody(':::step[Open the sheet]\nTap Scan.\n:::\n');
		const problem = onlyProblem(problems);
		expect(problem.message).toBe('A step container only means anything inside a steps container.');
		expect(problem.remediation).toContain('::::steps');
		expect(blocks.map((block) => block.type)).toEqual(['paragraph']);
	});

	test('anything other than a step inside a steps container', () => {
		// A container that is not a step is the case worth pinning: a steps container is
		// what HowTo structured data is derived from, and a note quietly counted as a step
		// puts a paragraph into a schema that says it is one of the reader's steps.
		const { blocks, problems } = parseBody(
			['::::steps', 'A stray paragraph.', ':::note[Not a step]', 'Body.', ':::', '::::'].join('\n'),
		);
		expect(problems.map((problem) => `${positionOf(problem)} ${problem.message}`)).toEqual([
			`${FILE}:2:1 A steps container holds step containers and nothing else.`,
			`${FILE}:3:1 A steps container holds step containers and nothing else.`,
			`${FILE}:4:1 A steps container holds step containers and nothing else.`,
			`${FILE}:5:1 A steps container holds step containers and nothing else.`,
			`${FILE}:1:1 A steps container holds step containers and nothing else, and this one holds none.`,
		]);
		expect(blockOfType(blocks, 0, 'steps').children).toEqual([]);
	});

	test('a figure with no image', () => {
		const { blocks, problems } = parseBody(':::figure[A caption]\nJust words.\n:::\n');
		const problem = onlyProblem(problems);
		expect(problem.message).toBe('A figure container holds exactly one image.');
		expect(blocks.map((block) => block.type)).toEqual(['paragraph']);
	});

	test('a figure holding more than an image says what it drops', () => {
		const { problems } = parseBody(
			[':::figure[A caption]', '![A tag](scan.png)', '', 'And a paragraph.', ':::'].join('\n'),
		);
		expect(onlyProblem(problems).message).toBe(
			'A figure container holds one image and its caption, and this one holds more.',
		);
	});

	test('a table container with no table', () => {
		const { blocks, problems } = parseBody(':::table[A caption]\nJust words.\n:::\n');
		const problem = onlyProblem(problems);
		expect(problem.message).toBe('A table container holds exactly one table.');
		expect(blocks.map((block) => block.type)).toEqual(['paragraph']);
	});

	test('a close with nothing open above it', () => {
		// It would otherwise become a paragraph reading three colons, which is a hole in
		// the page with no sign of where it came from.
		const { blocks, problems } = parseBody('A paragraph.\n\n:::\n');
		const problem = onlyProblem(problems);
		expect(problem.message).toBe('A directive close with no container open above it.');
		expect(positionOf(problem)).toBe(`${FILE}:3:1`);
		expect(blocks.map((block) => block.type)).toEqual(['paragraph']);
	});
});

describe('the include leaf directive', () => {
	test('a resolved include splices the snippet blocks in and records the id', () => {
		const { blocks, includes, problems } = parseBody(
			'Before.\n\n::include[safety-note]\n\nAfter.\n',
		);
		expect(problems).toEqual([]);
		expect(includes).toEqual(['safety-note']);
		expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
		expect(inlineOfType(blockOfType(blocks, 1, 'paragraph').children, 0, 'text').value).toBe(
			'Hold the tag still.',
		);
	});

	test('an id that is not a slug segment is refused before the resolver sees it', () => {
		const { includes, problems } = parseBody('::include[Safety Note]\n');
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('snippet-resolves');
		expect(problem.message).toContain('is not a snippet id');
		expect(positionOf(problem)).toBe(`${FILE}:1:1`);
		expect(includes).toEqual([]);
	});

	test('an unresolved include reports what the resolver said', () => {
		const { includes, problems } = parseBody('::include[missing]\n');
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('snippet-resolves');
		expect(problem.message).toBe('There is no snippet "missing".');
		expect(problem.remediation).toBe('Fix the id.');
		expect(includes).toEqual([]);
	});

	test('a snippet cannot include another snippet', () => {
		// Nesting transclusion makes the provenance of a page a graph nobody can read, and
		// one cycle away from a build that does not terminate.
		const { includes, problems } = parseBody('::include[safety-note]\n', { includeDepth: 1 });
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('snippet-resolves');
		expect(problem.message).toBe('A snippet cannot include another snippet.');
		expect(includes).toEqual([]);
	});

	test('an unknown leaf name is refused, and a container name says so', () => {
		const unknown = parseBody('::embed[a-video]\n');
		const problem = onlyProblem(unknown.problems);
		expect(problem.rule).toBe('unsupported-syntax');
		expect(problem.message).toBe(
			'"::embed" is not a leaf directive. The only one is "::include[id]".',
		);
		expect(problem.remediation).toBe(null);

		const container = parseBody('::note[Careful]\n');
		expect(onlyProblem(container.problems).remediation).toBe(
			'"note" is a container: open it with three colons and close it with three.',
		);
	});
});

// ---------------------------------------------------------------------------
// blocks.ts: the rest of the block grammar
// ---------------------------------------------------------------------------

describe('the remaining blocks', () => {
	test('a thematic break is a thematic break, never a setext heading', () => {
		// There is one heading spelling. A `---` between sections is a rule, and reading it
		// as an underline would silently turn the paragraph above it into a title.
		const { blocks, origins } = parseBody('A section.\n\n---\n\nAnother section.\n');
		expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'thematicBreak', 'paragraph']);
		expect(originOf(origins, blocks[1] as object)).toBe(`${FILE}:3:1`);
	});

	test('a paragraph folds its soft wraps and records where it starts', () => {
		const { blocks, prose, origins } = parseBody(
			'Hold the top edge of the\nphone against a tag.\n',
		);
		const paragraph = blockOfType(blocks, 0, 'paragraph');
		expect(inlineOfType(paragraph.children, 0, 'text').value).toBe(
			'Hold the top edge of the phone against a tag.',
		);
		expect(originOf(origins, paragraph)).toBe(`${FILE}:1:1`);
		expect(prose.map((segment) => segment.kind)).toEqual(['paragraph']);
		expect(positionAt(prose[0]?.folded ?? { text: '', runs: [] }, FILE, 25)).toEqual({
			file: FILE,
			line: 2,
			column: 1,
		});
	});

	test('prose is recorded per block kind, with the node it belongs to', () => {
		// A rule has to be able to ask what kind of block it is looking at without the
		// segment restating it, which is what `no-heading-punctuation` reads.
		const { blocks, prose } = parseBody(
			['## A heading', '', 'A paragraph.', '', '> A quote.', '', '- An item'].join('\n'),
		);
		expect(prose.map((segment) => segment.kind)).toEqual([
			'heading',
			'paragraph',
			'paragraph',
			'paragraph',
		]);
		expect(prose[0]?.node).toBe(blocks[0]);
	});

	test('a heading breaks a paragraph, and so does a fence', () => {
		const { blocks } = parseBody('Words.\n## Heading\nMore words.\n```text\nx\n```\n');
		expect(blocks.map((block) => block.type)).toEqual([
			'paragraph',
			'heading',
			'paragraph',
			'code',
		]);
	});
});

// ---------------------------------------------------------------------------
// index.ts: the document seam
// ---------------------------------------------------------------------------

const FRONT_MATTER = ['---', 'title: Tag session API', 'description: A page.', '---', ''].join(
	'\n',
);

// ---------------------------------------------------------------------------
// The three inline defects the adversarial review found. Each names the input that
// produced it, because each was invisible in a corpus that happens not to contain one.
// ---------------------------------------------------------------------------

describe('a bracket that opens no link', () => {
	// `readDestination` advanced its cursor with `isSpace`, the emphasis flanking
	// predicate, which counts the end of the text as whitespace. Past the end,
	// `text[cursor] ?? ''` is `''` forever, so the skip loop never terminated. The
	// compiler did not throw and did not report: it produced no output at all until
	// something killed it, which in a publish workflow is a job that looks stuck rather
	// than a build that failed. Every source here hung, and that is also what a regression
	// looks like from this file: a synchronous loop cannot be interrupted, so the failure
	// is the suite never finishing rather than a red row.
	test.each([
		['a bracketed word ending the line', 'Press [Enter]'],
		['a bracketed word with one character after it', '[a]'],
		['a bracketed word ending a sentence', 'Press [Enter] now.'],
		['a bracketed word mid-sentence', 'Open the app and choose the [Settings] menu.'],
		['a half-typed link', 'See [the guide]('],
		['a half-typed link with a destination', 'See [the guide](guide.md'],
		['a half-typed link with an unclosed title', 'See [a](guide.md "Title'],
	])('%s terminates and stays literal', (_label, source) => {
		const { nodes, prose, problems } = parseInlineText(source);
		expect(problems).toEqual([]);
		expect(inlineOfType(nodes, 0, 'text').value).toBe(source);
		expect(prose).toBe(source);
	});

	test('the character after the label is checked, so no link is invented', () => {
		// `readDestination` began at `open + 1` and never looked at `text[open]`, so the
		// character after the `]` was consumed unread and whatever followed it was parsed
		// as a destination. The page got a link the author did not write, to a page they
		// did not name, and the words that became the destination vanished from the prose
		// as well, so no house-style rule could see them either.
		const source = 'Press [Enter] first-tag.md) and stop.';
		const { nodes, prose, problems } = parseInlineText(source);
		expect(problems).toEqual([]);
		expect(inlineOfType(nodes, 0, 'text').value).toBe(source);
		expect(prose).toBe(source);
	});

	test('a parenthetical holding a bracketed reference is not a broken link', () => {
		// The louder half of the same defect. `link-resolves` is an error, so this
		// ordinary sentence refused to publish, reporting that "below" resolves to no page.
		const source = 'The tag ID (see [chip matrix] below) is printed on the label.';
		const { nodes, problems } = parseInlineText(source);
		expect(problems).toEqual([]);
		expect(inlineOfType(nodes, 0, 'text').value).toBe(source);
	});

	test('a real link is still a link', () => {
		// The guard rejects a non-parenthesis and nothing else, which is only worth
		// asserting because the cheap version of this fix is to reject too much.
		const { nodes } = parseInlineText('See the [guide](first-tag.md) for more.');
		expect(inlineOfType(nodes, 1, 'link').children).toHaveLength(1);
	});
});

describe('emphasis that contains emphasis', () => {
	test('a run of three is an emphasis wrapping a strong', () => {
		// It used to compile to `strong["*tag"]` followed by a literal `"* still."`, so
		// the reader saw an asterisk inside the bold and another one after it, and no
		// finding said anything was wrong.
		const { nodes, prose, problems } = parseInlineText('Hold the ***tag*** still.');
		expect(problems).toEqual([]);
		const emphasis = inlineOfType(nodes, 1, 'emphasis');
		const strong = inlineOfType(emphasis.children, 0, 'strong');
		expect(inlineOfType(strong.children, 0, 'text').value).toBe('tag');
		expect(prose).toBe('Hold the tag still.');
	});

	test('a strong inside an emphasis keeps both, and publishes no delimiter', () => {
		// The outer scan took the inner strong's closing run as its own, so the strong was
		// lost entirely and four delimiter characters were published as text.
		const { nodes, prose, problems } = parseInlineText('*italic **and bold** here*');
		expect(problems).toEqual([]);
		const emphasis = inlineOfType(nodes, 0, 'emphasis');
		expect(emphasis.children.map((child) => child.type)).toEqual(['text', 'strong', 'text']);
		expect(inlineOfType(emphasis.children, 1, 'strong').children).toHaveLength(1);
		expect(prose).toBe('italic and bold here');
	});

	test('an emphasis inside an emphasis keeps both', () => {
		const { nodes, prose } = parseInlineText('*a *b* c*');
		const outer = inlineOfType(nodes, 0, 'emphasis');
		expect(outer.children.map((child) => child.type)).toEqual(['text', 'emphasis', 'text']);
		expect(prose).toBe('a b c');
	});

	test('two adjacent strongs are two strongs', () => {
		// The four delimiters between them are a closing run and an opening run, not a
		// run of four, which is why the refusal below tests the flanking character.
		const { nodes, prose } = parseInlineText('**a****b**');
		expect(nodes.map((node) => node.type)).toEqual(['strong', 'strong']);
		expect(prose).toBe('ab');
	});

	test('a surplus closing delimiter stays literal, which is what CommonMark does', () => {
		const { nodes, prose } = parseInlineText('*foo**');
		expect(nodes.map((node) => node.type)).toEqual(['emphasis', 'text']);
		expect(prose).toBe('foo*');
	});

	test('a run of four or more is refused by name rather than clamped', () => {
		// Clamping to two accepted it and produced a strong whose text began with a
		// literal asterisk. A named refusal carrying a line is what this AST major is
		// entitled to do with a spelling it has no reading for; a stray asterisk on a
		// published page is not.
		const { nodes, problems } = parseInlineText('****a****');
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('unsupported-syntax');
		expect(positionOf(problem)).toBe(`${FILE}:1:1`);
		expect(inlineOfType(nodes, 0, 'text').value).toBe('****a****');
	});

	test('an unclosed run costs what a paragraph costs', () => {
		// The descend that fixes the nesting above is exponential without its memo: `*a `
		// twenty times took 49ms and forty times did not finish. The threshold is loose on
		// purpose, because what it has to separate is milliseconds from never, and as with
		// the hangs above the regression shows up as a suite that does not finish rather
		// than as this assertion failing.
		const started = performance.now();
		const { nodes } = parseInlineText('*a '.repeat(400));
		expect(nodes.length).toBeGreaterThan(0);
		expect(performance.now() - started).toBeLessThan(2000);
	});
});

describe('an unclosed container quotes the marker the author typed', () => {
	test.each([
		[':::note[A]\nText.\n', '":::note"', '3 colons'],
		['::::note[A]\n:::warning[B]\nText.\n:::\n', '"::::note"', '4 colons'],
	])('%# names the opener', (source, marker, colons) => {
		// The width was already interpolated and the marker was not, so a nested container
		// opened with four colons was reported as `":::note"`, a line that is not in the
		// file. The two halves of one message disagreed about the same construct.
		const problem = onlyProblem(parseBody(source).problems);
		expect(problem.message).toContain(marker);
		expect(problem.message).toContain(colons);
	});
});

describe('the three titles a house rule could not see', () => {
	// A link title, an image title and a fence's `title=` are all shown to a reader, by a
	// tooltip, by a screen reader and as a code block's caption. None of them reached a
	// prose segment, so every house-style rule had three blind spots in text it governs.
	// The em dash is the check: it is banned outright and protected, so it cannot be
	// switched off, and it was shipping in all three places.
	test.each([
		['a link title', 'See [the guide](first-tag.md "Read this \u2014 it is short").'],
		['an image title', 'A ![completed read](scan.png "The Scan sheet \u2014 green").'],
		['a fence title', '```swift title="Session \u2014 the whole of it"\nlet a = 0\n```'],
	])('%s reaches the prose', (_label, body) => {
		const { prose } = parseBody(body);
		const found = prose.filter((segment) => segment.folded.text.includes('\u2014'));
		expect(found.map((segment) => segment.kind)).toEqual(['title']);
		// And it carries a real position, so the finding names the line rather than the file.
		expect(found[0]?.folded.runs[0]?.line).toBeGreaterThan(0);
		expect(found[0]?.folded.runs[0]?.column).toBeGreaterThan(1);
	});

	test('the destination is still not prose', () => {
		// The opposite direction, and the reason the whole title span is added rather than
		// the whole destination: an address is not prose, and scanning one would report the
		// hyphens in a slug as punctuation an author has to justify.
		const { prose } = parseBody('See [the guide](guide/first-tag.md "A title").');
		expect(prose.some((segment) => segment.folded.text.includes('first-tag.md'))).toBe(false);
	});
});

describe('containers and comments that hold more than they can carry', () => {
	test('a figure paragraph with words around the image is reported, not silently trimmed', () => {
		// `firstImage` pulls the image out of whatever block holds it, so a paragraph with a
		// sentence around it compiled to a figure with the sentence gone. One block, so the
		// existing guard did not fire, and that guard's own message promised to report
		// exactly this. The prose segment for the dropped text is still recorded, so a house
		// style rule could report a problem at a line the reader never sees.
		const { blocks, problems } = parseBody(
			':::figure[The Scan sheet]\nBefore the image ![alt text](scan.png) after the image.\n:::\n',
		);
		const problem = onlyProblem(problems);
		expect(problem.rule).toBe('unsupported-syntax');
		expect(problem.message).toContain('an image with text around it');
		expect(blocks.map((block) => block.type)).toEqual(['figure']);
	});

	test('a figure holding nothing but its image is still clean', () => {
		const { blocks, problems } = parseBody(
			':::figure[The Scan sheet]\n![alt text](scan.png)\n:::\n',
		);
		expect(problems).toEqual([]);
		expect(blocks.map((block) => block.type)).toEqual(['figure']);
	});

	// Through `parseFile`, because `stripComments` runs in `parseDocument` and a body
	// handed straight to `parseBlocks` never sees it. The front matter block ends on line
	// 4 and its trailing newline makes line 5 the first body line.
	test('a comment sharing a line with text is reported at the comment', () => {
		// Both patterns were anchored to the start of the line, so this was neither stripped
		// nor reported: it stayed literal text and shipped an internal note on the page and
		// in the raw markdown, while the docblock said comments were gone by this point.
		const problem = onlyProblem(parseFile('Tap Write. <!-- ask design about this -->\n').problems);
		expect(problem.rule).toBe('no-raw-html');
		expect(problem.message).toContain('not the whole line');
		expect(positionOf(problem)).toBe(`${FILE}:5:12`);
	});

	test('a comment that opens and never closes is still reported', () => {
		const problem = onlyProblem(parseFile('<!-- a note that\nkeeps going\n').problems);
		expect(problem.rule).toBe('no-raw-html');
		expect(problem.message).toContain('does not close on the same line');
	});

	test('a whole-line comment is still stripped and still silent', () => {
		const parsed = parseFile('<!-- an authoring note -->\n\nText.\n');
		expect(parsed.problems).toEqual([]);
		expect(parsed.blocks.map((block) => block.type)).toEqual(['paragraph']);
	});
});

/** A whole file: front matter, then the body under test, so line numbers are absolute. */
function parseFile(body: string): ReturnType<typeof parseDocument> {
	return parseDocument(`${FRONT_MATTER}${body}`, {
		file: FILE,
		config: CONFIG,
		services: stubServices(),
	});
}

describe('parseDocument', () => {
	test('a suppression comment is recorded and never reaches the blocks', () => {
		// Stripping the comments before the parse rather than after is what makes "no
		// suppression comment ever reaches a bundle" a property of the pipeline rather than
		// of a filter somebody has to remember to run.
		const parsed = parseFile(
			[
				'A first line.',
				'',
				'<!-- hexdocs-disable-next-line no-banned-phrase: quoting the copy is the point -->',
				'The listing calls this "tap and go".',
			].join('\n'),
		);
		expect(parsed.problems).toEqual([]);
		expect(parsed.disables).toEqual([
			{
				file: FILE,
				line: 7,
				rule: 'no-banned-phrase',
				reason: 'quoting the copy is the point',
				used: false,
			},
		]);
		expect(parsed.blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph']);
		expect(JSON.stringify(parsed.blocks)).not.toContain('hexdocs-disable-next-line');
	});

	test('the comment becomes a blank line, so every line below it keeps its number', () => {
		const parsed = parseFile(
			['<!-- an authoring note -->', 'A paragraph.', '', '# A title'].join('\n'),
		);
		const problem = onlyProblem(parsed.problems);
		expect(problem.rule).toBe('no-h1-in-body');
		expect(positionOf(problem)).toBe(`${FILE}:8:1`);
	});

	test('any other HTML comment is stripped too', () => {
		// Authoring noise that must not reach a published page.
		const parsed = parseFile(['<!-- TODO: rewrite this -->', 'A paragraph.'].join('\n'));
		expect(parsed.problems).toEqual([]);
		expect(parsed.blocks.map((block) => block.type)).toEqual(['paragraph']);
		expect(JSON.stringify(parsed.blocks)).not.toContain('TODO');
	});

	test('a comment that opens and does not close on one line is refused', () => {
		// A multi-line comment would have to be stripped across a block boundary, and the
		// version that gets that subtly wrong publishes half of it.
		const parsed = parseFile(
			['<!-- an authoring note', 'that runs on -->', 'A paragraph.'].join('\n'),
		);
		const problem = onlyProblem(parsed.problems);
		expect(problem.rule).toBe('no-raw-html');
		expect(problem.message).toBe('An HTML comment that does not close on the same line.');
		expect(positionOf(problem)).toBe(`${FILE}:5:1`);
		expect(problem.excerpt).toBe('<!-- an authoring note');
	});

	test('the reserved math delimiter is refused with a position inside the paragraph', () => {
		// Silently rendering `$$` as text today would make adding mathematics in `ast-2` a
		// breaking change for every page that had used it.
		const parsed = parseFile(
			['The first line is fine.', 'The energy is $$E = mc^2$$ here.'].join('\n'),
		);
		const problem = onlyProblem(parsed.problems);
		expect(problem.rule).toBe('unsupported-syntax');
		expect(problem.message).toContain('reserved for mathematics');
		expect(positionOf(problem)).toBe(`${FILE}:6:15`);
	});

	test('the front matter body line is where the body starts, so positions are absolute', () => {
		const parsed = parseFile('A paragraph.\n');
		expect(parsed.frontMatter.bodyLine).toBe(5);
		expect(parsed.frontMatter.data.title).toBe('Tag session API');
		expect(originOf(parsed.origins, parsed.blocks[0] as object)).toBe(`${FILE}:5:1`);
	});

	test('a snippet records its origins in the map the page is parsed with', () => {
		// A WeakMap cannot be enumerated and therefore cannot be merged, so the include
		// resolver is handed the page's own map. Two maps mean every finding on a
		// transcluded block has no position at all and falls back to naming the file.
		const origins: NodeOrigins = new WeakMap();
		const snippetFile = 'snippets/en/safety-note.md';
		const snippet = `${FRONT_MATTER}Hold the tag still.\n`;
		const parsed = parseDocument(`${FRONT_MATTER}::include[safety-note]\n`, {
			file: FILE,
			config: CONFIG,
			origins,
			services: stubServices({
				resolveInclude: () => ({
					ok: true,
					blocks: parseDocument(snippet, {
						file: snippetFile,
						config: CONFIG,
						origins,
						includeDepth: 1,
						services: stubServices(),
					}).blocks,
				}),
			}),
		});
		expect(parsed.blocks).toHaveLength(1);
		expect(parsed.origins).toBe(origins);
		expect(originOf(origins, parsed.blocks[0] as object)).toBe(`${snippetFile}:5:1`);
	});

	test('a document with no front matter reports it once and still parses the body', () => {
		const parsed = parseDocument('A paragraph.\n', {
			file: FILE,
			config: CONFIG,
			services: stubServices(),
		});
		expect(parsed.problems).toHaveLength(1);
		expect(parsed.blocks.map((block) => block.type)).toEqual(['paragraph']);
	});
});

// ---------------------------------------------------------------------------
// The corpus sweep
// ---------------------------------------------------------------------------

interface SweptDocument {
	/** Every node type the tree parsed from this file carries. */
	types: Set<string>;
	/** Every `status` value in it, which is the one union a node type alone does not pin. */
	statuses: Set<string>;
	includes: string[];
	problems: RawFinding[];
}

/**
 * Parses every English page and snippet of the corpus with the real resolvers.
 *
 * The resolvers are the real ones on purpose. A stub would let a link shape that the
 * build refuses pass here, and the claims in `fixtures/nodes.ts` are claims about what
 * the build produces rather than about what a parser could produce given a friendlier
 * answer.
 */
function sweepEnglishCorpus(appRoot: string): Map<string, SweptDocument> {
	const project = loadProject(appRoot);

	const assets = new Map<string, { src: string; width: number; height: number }>();
	for (const [path, asset] of project.assets) {
		const probe = probeAsset(asset.bytes, path);
		if (!probe.ok) continue;
		assets.set(path, {
			src: assetKey(sha256Hex(asset.bytes), probe.asset.ext),
			width: probe.asset.width,
			height: probe.asset.height,
		});
	}

	const nullServices: ParseServices = {
		resolveLink: () => ({ ok: false, message: '', remediation: null }),
		resolveInclude: () => ({ ok: true, blocks: [] }),
		resolveImage: () => ({ ok: false, message: '', remediation: null }),
		highlight: () => ({ lines: [], highlighted: false }),
	};

	const redirects = new Map<string, string>();
	for (const [slug, byLocale] of project.pages) {
		const document = byLocale.get('en');
		if (document === undefined) continue;
		const front = parseDocument(document.text, {
			file: document.file,
			config: project.config,
			services: nullServices,
		}).frontMatter.data;
		for (const from of Array.isArray(front.redirectFrom) ? front.redirectFrom : []) {
			if (typeof from === 'string') redirects.set(from, slug);
		}
	}

	const targets = { slugs: new Set(project.pages.keys()), redirects, assets };
	const swept = new Map<string, SweptDocument>();

	const documents = [
		...[...project.pages.values()].map((byLocale) => byLocale.get('en')),
		...[...project.snippets.values()].map((byLocale) => byLocale.get('en')),
	];

	for (const document of documents) {
		if (document === undefined) continue;
		const origins: NodeOrigins = new WeakMap();
		const services: ParseServices = {
			resolveLink: createLinkResolver(document.file, targets),
			resolveImage: createImageResolver(document.file, targets),
			highlight,
			resolveInclude: (id) => {
				const snippet = project.snippets.get(id)?.get('en');
				if (snippet === undefined) {
					return { ok: false, message: `There is no snippet "${id}".`, remediation: null };
				}
				return {
					ok: true,
					blocks: parseDocument(snippet.text, {
						file: snippet.file,
						config: project.config,
						origins,
						includeDepth: 1,
						services: {
							...services,
							resolveLink: createLinkResolver(snippet.file, targets),
							resolveImage: createImageResolver(snippet.file, targets),
						},
					}).blocks,
				};
			},
		};

		const parsed = parseDocument(document.text, {
			file: document.file,
			config: project.config,
			origins,
			services,
		});
		swept.set(document.file, {
			types: collect(parsed.blocks, 'type'),
			statuses: collect(parsed.blocks, 'value', 'status'),
			includes: parsed.includes,
			problems: parsed.problems,
		});
	}

	return swept;
}

/**
 * Every value of one field in a tree, optionally only on nodes of one type.
 *
 * Walked rather than switched on, so a node type added to the union is swept here
 * without this function being told about it.
 */
function collect(blocks: readonly Block[], field: string, onlyType?: string): Set<string> {
	const found = new Set<string>();
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const entry of value) walk(entry);
			return;
		}
		if (value === null || typeof value !== 'object') return;
		const record = value as Record<string, unknown>;
		const wanted = onlyType === undefined || record.type === onlyType;
		if (wanted && typeof record[field] === 'string') found.add(record[field] as string);
		for (const child of Object.values(record)) walk(child);
	};
	walk(blocks);
	return found;
}

/** Where `nodes.ts` claims a construct lives, as a path under `app/`. */
function corpusPath(file: string): string {
	return `docs/site/${file}`;
}

describe('the English corpus, parsed with the real resolvers', () => {
	let root: string;
	let swept: Map<string, SweptDocument>;

	beforeAll(() => {
		// Materialised rather than read in place: `loadProject` reads git, and the corpus
		// on disk lives in a repository whose history says nothing about it.
		root = mkdtempSync(join(tmpdir(), 'hexdocs-parse-'));
		swept = sweepEnglishCorpus(materialiseCorpus(join(root, 'repo')).root);
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('every English page and snippet in the inventory is parsed', () => {
		const expected =
			FIXTURE_PAGES.filter((page) => page.locales.en !== undefined).length +
			FIXTURE_SNIPPETS.filter((snippet) => snippet.locales.en !== undefined).length;
		expect(swept.size).toBe(expected);
		expect(expected).toBeGreaterThan(0);
	});

	test('every node type claimed by a corpus file is produced from that file', () => {
		// The failure this stops is silent: a page gets rewritten, the construct goes with
		// it, the golden test still passes against whatever the page now says, and one node
		// type quietly stops being exercised anywhere.
		let examined = 0;
		for (const claim of NODE_CLAIMS) {
			const document = swept.get(claim.file);
			expect(
				document,
				`${claim.file} is claimed by ${claim.type} and was not parsed`,
			).toBeDefined();
			expect(
				document?.types.has(claim.type),
				`${claim.file} no longer produces a ${claim.type} node (${claim.variant ?? 'the only variant'})`,
			).toBe(true);
			examined += 1;
		}
		expect(examined).toBe(NODE_CLAIMS.length);
	});

	test('every AST node type is reachable from real source', () => {
		// The claims are checked one by one above. This is the other direction: a node type
		// added to the union with no corpus page behind it fails here.
		const produced = new Set<string>();
		for (const document of swept.values()) for (const type of document.types) produced.add(type);
		const missing = AST_NODE_TYPES.filter((type) => !produced.has(type));
		expect(missing).toEqual([]);
		expect(produced.size).toBe(AST_NODE_TYPES.length);
	});

	test('every status value is produced by real source, the em dash cell included', () => {
		// The four values are a complete union, so this needs no hand-written list. The one
		// that would otherwise go untested is `na`: an em dash means "not applicable" only
		// as the whole of a table cell, and everywhere else it is a character the house
		// rules ban. Node-type coverage alone does not reach it, because the same page
		// carries three other spellings that all produce a `status` node.
		const produced = new Set<string>();
		for (const document of swept.values()) {
			for (const value of document.statuses) produced.add(value);
		}
		expect([...produced].sort()).toEqual([...STATUS_VALUES].sort());
	});

	test('every declared include resolves and is recorded against its page', () => {
		// `CompiledPage.snippets` is the only record that a paragraph came from somewhere
		// else, and it is built from this list. An include that expanded but was not
		// recorded would make a page look as though it transcluded nothing.
		let examined = 0;
		for (const claim of INCLUDE_CLAIMS) {
			const document = swept.get(claim.file);
			expect(document, `${claim.file} claims ::include[${claim.id}]`).toBeDefined();
			expect(document?.includes, claim.file).toContain(claim.id);
			examined += 1;
		}
		expect(examined).toBe(INCLUDE_CLAIMS.length);
	});

	test('the whole English corpus parses with exactly one problem, the planted fence', () => {
		// The corpus is a tree that has to build. The one exception is deliberate: an
		// unlabelled fence, planted so that `Code.lang` has an absent case and so that the
		// linter has something real to report. Anything else here is a regression.
		const found = [...swept.entries()].flatMap(([file, document]) =>
			document.problems.map((problem) => ({ file, problem })),
		);
		expect(found.map((entry) => `${entry.file}: ${entry.problem.rule}`)).toHaveLength(1);

		const claim = NODE_CLAIMS.find(
			(entry) => entry.type === 'code' && entry.variant === 'no language at all',
		);
		expect(claim, 'the unlabelled fence claim is gone from nodes.ts').toBeDefined();
		const source = readAppFile(corpusPath(claim?.file ?? ''));
		const index = source.search(claim?.pattern ?? /$^/);
		expect(index, 'the unlabelled fence is no longer where nodes.ts says').toBeGreaterThan(-1);
		const at = source.slice(0, index).split('\n').length;

		const only = found[0];
		expect(only?.file).toBe(claim?.file);
		expect(only?.problem.rule).toBe('code-fence-language');
		expect(only?.problem.message).toContain('carries no language');
		expect(only === undefined ? '' : positionOf(only.problem)).toBe(`${claim?.file}:${at}:1`);
	});
});
