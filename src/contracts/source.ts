/**
 * The source-level spellings the compiler recognises.
 *
 * Everything here is a fact about markdown that an author types, not about the tree
 * the renderer switches on. It lives in the runtime half for the same reason the
 * search index's length invariants do: two parties have to agree about it. The
 * compiler recognises these spellings, and the linter has to know which of them are
 * data before it decides whether a character is decoration.
 *
 * That second sentence is the whole reason this module exists rather than a table
 * inside the parser. `hex-nfc/docs/public/chip-support-matrix.md` carries 86 status
 * glyphs, and three of the four spellings it uses are characters the house rules ban
 * outright. A parser-private table would mean the linter and the compiler each had
 * their own idea of which check mark was data, which is exactly the drift the whole
 * package is built to refuse.
 *
 * Characters are declared as code points, never as literals, for the reason
 * `BANNED_CHARACTERS` gives in `lint.ts`: this repository lints its own source with
 * that pattern, and a literal here would flag the file that declares the rule. An
 * exemption for "the file that declares the rule" is the hole that later swallows a
 * real hit.
 */

import { CALLOUT_KINDS, type CalloutKind, type StatusValue } from './ast.js';
import { SLUG_SEGMENT_PATTERN } from './slug.js';

// ---------------------------------------------------------------------------
// Status glyphs
// ---------------------------------------------------------------------------

/**
 * Where a status glyph may be recognised.
 *
 * `inline` is anywhere an inline node can appear. `cell` is only as the entire
 * content of a table cell, whitespace aside.
 *
 * The distinction is not fussiness, it is what keeps one spelling from becoming a
 * loophole. The "not applicable" glyph in the real corpus is U+2014 EM DASH, which
 * the house rules ban everywhere and which this package's own lint would reject in
 * its own source. Recognising it anywhere would hand every author a two-character
 * way to write an em dash that no rule can see. Recognising it only as a whole cell
 * costs nothing, because that is the only place it means "not applicable" anyway.
 */
export type StatusScope = 'inline' | 'cell';

export interface StatusGlyphSpelling {
	/** The code point sequence, in order. */
	codePoints: readonly number[];
	/** For the diagnostic when a glyph is refused outside its scope. */
	name: string;
	value: StatusValue;
	scope: StatusScope;
}

/**
 * Every spelling the compiler turns into a `status` node, with its meaning.
 *
 * Taken from the real corpus rather than invented. A census of
 * `hex-nfc/docs/public/` counts 59 U+2705, 16 U+26A0 (every one followed by
 * U+FE0F) and 11 U+274C, which is the 86 the design records, plus the em dashes
 * in the "not applicable" cells that the count deliberately excludes.
 *
 * The bare U+26A0 is accepted alongside the emoji-presentation pair because an
 * author who types the character without the variation selector has written the same
 * thing, and a matrix where half the caution cells render as a `status` node and half
 * as a stray character is worse than either alternative. `variationSelector` is
 * U+FE0F. Nothing strips it from text that stays text: it carries the difference
 * between a coloured glyph and a monochrome one, which `TextNode` records.
 */
export const STATUS_GLYPHS: readonly StatusGlyphSpelling[] = [
	{ codePoints: [0x2705], name: 'white heavy check mark', value: 'yes', scope: 'inline' },
	{ codePoints: [0x26a0, 0xfe0f], name: 'warning sign', value: 'partial', scope: 'inline' },
	{ codePoints: [0x26a0], name: 'warning sign', value: 'partial', scope: 'inline' },
	{ codePoints: [0x274c], name: 'cross mark', value: 'no', scope: 'inline' },
	{ codePoints: [0x2014], name: 'em dash', value: 'na', scope: 'cell' },
];

/** The spelling as a string. Derived, so the table cannot disagree with itself. */
export function statusGlyphText(spelling: StatusGlyphSpelling): string {
	return String.fromCodePoint(...spelling.codePoints);
}

/*
 * Longest first, and this ordering is load-bearing rather than tidy. `statusAt` scans
 * from a position, so with the bare U+26A0 tried first the pair U+26A0 U+FE0F matches
 * one code point and leaves the variation selector behind as a one-character text node
 * beside the status, which is how a matrix cell renders an invisible artefact.
 *
 * A `sort` on the exported array would mutate it, so this is a copy.
 */
const BY_LENGTH: readonly StatusGlyphSpelling[] = [...STATUS_GLYPHS].sort(
	(a, b) => b.codePoints.length - a.codePoints.length,
);

export interface StatusMatch {
	value: StatusValue;
	/** Code units consumed, so a scanner can advance past the whole spelling. */
	length: number;
	/** For the diagnostic when a glyph is refused outside its scope. */
	name: string;
}

/**
 * The status glyph starting at `index`, or `undefined` if there is not one there.
 *
 * This is the form the compiler needs. A status glyph is an inline node, and the
 * corpus has one in the middle of a sentence, so recognising it means scanning text
 * rather than comparing a whole string.
 *
 * `scope` is where the text came from. A `cell`-scoped spelling is recognised only
 * when the caller says it is looking at a cell **and** the glyph is the whole of what
 * it was handed. That second condition is what keeps the em dash from being a
 * loophole: as a whole cell it means "not applicable", and anywhere else, a cell
 * included, it is the character the house rules ban.
 */
export function statusAt(text: string, index: number, scope: StatusScope): StatusMatch | undefined {
	for (const spelling of BY_LENGTH) {
		const glyph = statusGlyphText(spelling);
		if (!text.startsWith(glyph, index)) continue;
		if (spelling.scope === 'cell') {
			if (scope !== 'cell') continue;
			if (index !== 0 || glyph.length !== text.length) continue;
		}
		return { value: spelling.value, length: glyph.length, name: spelling.name };
	}
	return undefined;
}

/**
 * The status a whole run of text means, or `undefined` if the run is anything more
 * than one glyph.
 *
 * Defined in terms of `statusAt` rather than beside it, so the two cannot end up with
 * different ideas of which spellings exist or where a cell-scoped one is allowed.
 */
export function statusOf(text: string, scope: StatusScope): StatusValue | undefined {
	const trimmed = text.trim();
	const match = statusAt(trimmed, 0, scope);
	return match !== undefined && match.length === trimmed.length ? match.value : undefined;
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

/**
 * A snippet id: one slug segment, so it is safe as a filename and in a diagnostic.
 *
 * Snippets live at `docs/site/snippets/<locale>/<id>.md`, mirroring `content/`, and
 * have no address of their own, so the id is only ever a filename and a key in
 * `CompiledPage.snippets`. Per locale rather than flat, because a flat tree would
 * inject English into six translated pages and the page would still read `current`.
 *
 * Transclusion itself is a leaf directive, `::include[safety-note]`, and its grammar
 * is with the other directives below.
 */
export const SNIPPET_ID_PATTERN = SLUG_SEGMENT_PATTERN;

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

/**
 * An author-written anchor, at the end of a heading: `## Station data {#station-data}`.
 *
 * Produces `idSource: "explicit"`, which is the only one of the three that is
 * identical in every language. A translator must copy it across unchanged, and
 * `heading-set-matches-source` is what notices when they did not.
 */
export const EXPLICIT_HEADING_ID_PATTERN = /[ \t]*\{#([a-z0-9]+(?:-[a-z0-9]+)*)\}[ \t]*$/;

/**
 * A leading section number: `## 4. Termination`, `### 4.2 Refunds`.
 *
 * Produces `idSource: "section-number"` under a project configured for it, which is
 * how `#section-4` addresses the same clause in all seven languages. The trailing dot
 * is optional because both spellings are already in the legal documents.
 *
 * The number must be followed by whitespace and then something. A heading that is
 * only a number is a heading with no text, and treating it as a numbered section would
 * give it an anchor and an empty table of contents entry.
 */
export const SECTION_NUMBER_PATTERN = /^(\d+(?:\.\d+)*)\.?[ \t]+(?=\S)/;

/** `4.2` to `section-4-2`. The anchor form, which is what a link carries. */
export function sectionNumberAnchor(number: string): string {
	return `section-${number.replaceAll('.', '-')}`;
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

/**
 * The directive grammar, as remark-directive implements it.
 *
 * Not invented here. A container opens with three or more colons and a name and
 * closes with a line of colons; a leaf directive is two colons, a name and a bracketed
 * argument. Nesting adds a colon to the outer marker, which is what lets a `step` sit
 * inside a `steps` without an ambiguous close.
 *
 * Borrowing a real extension's spelling rather than picking one costs nothing and buys
 * two things: an author who has written markdown elsewhere already knows it, and the
 * source renders on GitHub as visible literal markers rather than as nothing. A
 * syntax that renders as nothing produces a page with a hole in it and no sign of why.
 *
 * The third capture is the directive's label, bracketed, which is the spelling
 * remark-directive actually implements. An earlier draft of this pattern took a bare
 * space-separated argument, `:::note Background scanning`, and the comment above still
 * claimed the grammar was borrowed rather than invented. It was not: to
 * remark-directive that line is a paragraph, so every titled container in the corpus
 * would have compiled to nothing under the extension whose spelling was being cited.
 *
 * For `figure` and `table` the label is the caption, parsed as inline markdown. A
 * caption written as the container's last paragraph instead would be ambiguous with
 * the prose that follows a table, and the ambiguity would only show up as a missing
 * sentence on a published page.
 */
export const CONTAINER_DIRECTIVE_PATTERN = /^(:{3,})([a-z][a-z0-9-]*)(?:\[([^\]]*)\])?[ \t]*$/;

/** The matching close. The colon count must equal the open's, which the parser checks. */
export const DIRECTIVE_CLOSE_PATTERN = /^(:{3,})[ \t]*$/;

/** A leaf directive: `::include[safety-note]`. Two colons, a name, one argument. */
export const LEAF_DIRECTIVE_PATTERN = /^::([a-z][a-z0-9-]*)\[([^\]]*)\][ \t]*$/;

/**
 * Container names this AST major understands, derived from the unions that produce
 * them.
 *
 * Writing the list out by hand is how a callout kind gets added to `CALLOUT_KINDS` and
 * silently stops being recognised in source: the AST would carry it, the schema would
 * accept it, and the only thing that would not produce it is the parser. A directive
 * whose name is not here is an error naming the name, never a silently dropped block.
 */
export const CONTAINER_DIRECTIVE_NAMES = [
	...CALLOUT_KINDS,
	'steps',
	'step',
	'figure',
	'table',
] as const;

export type ContainerDirectiveName = (typeof CONTAINER_DIRECTIVE_NAMES)[number];

/** The only leaf directive. Snippet transclusion: `::include[safety-note]`. */
export const SNIPPET_INCLUDE_NAME = 'include';

const CONTAINER_NAME_SET: ReadonlySet<string> = new Set<string>(CONTAINER_DIRECTIVE_NAMES);

export function isContainerDirective(name: string): name is ContainerDirectiveName {
	return CONTAINER_NAME_SET.has(name);
}

/**
 * GitHub's alert syntax, as the first line of a blockquote: `> [!WARNING]`.
 *
 * Both spellings compile to the same `callout` node. This one exists because
 * documentation lives in the app repository, where a developer reads it in the GitHub
 * UI long before it is published, and `> [!WARNING]` renders there while `:::warning`
 * does not. Upper case, because that is the only spelling GitHub recognises.
 *
 * Applied to the blockquote's first line with the quote marker already stripped.
 */
export const CALLOUT_ALERT_PATTERN = new RegExp(
	`^\\[!(${CALLOUT_KINDS.map((kind) => kind.toUpperCase()).join('|')})\\][ \\t]*$`,
);

/** The kind a matched alert or container directive names, whichever spelling was used. */
export function calloutKindOf(name: string): CalloutKind | undefined {
	const lowered = name.toLowerCase();
	return CALLOUT_KINDS.find((kind) => kind === lowered);
}

// ---------------------------------------------------------------------------
// Code fences
// ---------------------------------------------------------------------------

/**
 * The info string on a fence: a language, then space-separated options.
 *
 * ```swift title="TagSession.swift" lineNumbers start=12 highlight="2,5-7" wrap
 *
 * Quoted values and bare flags, which is the spelling every markdown toolchain in
 * this space already uses, so an author who has written a fence elsewhere writes a
 * working one here. Unknown options are an error rather than being ignored: a
 * misspelled `linenumbers` that silently did nothing would look exactly like a
 * renderer bug, and the author would go looking in the wrong half of the package.
 */
/**
 * One option on a fence info string: a name, optionally `=value`, the value either
 * quoted or a run of non-space characters.
 *
 * Anchored, and applied with a cursor rather than with `matchAll`. That is the whole
 * difference between this and the version it replaces: a global scan skips over
 * anything it cannot match, so `\`\`\`swift 2,5-7 {highlight: [2]}` reported no options
 * and no problems, and the author's real intent vanished with no sign it had been
 * there. Text an option match does not consume is now residue, and residue is a
 * problem.
 */
export const FENCE_OPTION_PATTERN = /^([A-Za-z][A-Za-z0-9]*)(?:=(?:"([^"]*)"|([^\s"]+)))?/;

/**
 * Option names a fence may carry: which field each sets on the `code` node, and
 * whether it takes a value.
 *
 * The arity is not decoration. Without it `lineNumbers=yes` and a bare `title` both
 * parse, and both are wrong in a way that produces a block missing the thing the
 * author asked for, which is exactly the "looks like a renderer bug" failure this
 * grammar exists to prevent.
 */
export const FENCE_OPTIONS = {
	title: { field: 'filename', arity: 'value' },
	lineNumbers: { field: 'showLineNumbers', arity: 'flag' },
	start: { field: 'startLine', arity: 'value' },
	highlight: { field: 'highlight', arity: 'value' },
	wrap: { field: 'wrap', arity: 'flag' },
} as const;

export type FenceOption = keyof typeof FENCE_OPTIONS;

export interface FenceInfo {
	/** Absent for an unlabelled fence, which is a real and different thing. */
	lang?: string;
	/** Present options, with `true` for a bare flag. */
	options: Partial<Record<FenceOption, string | true>>;
	/**
	 * One sentence per thing wrong with the info string, naming the token.
	 *
	 * A list rather than a throw, so the compiler can report every bad option on a page
	 * at once instead of one per run, and named rather than counted, because "three
	 * problems" sends the author back to the fence to guess which three.
	 */
	problems: string[];
}

/**
 * Splits a fence info string into a language and its options.
 *
 * Total: nothing here throws. An info string it cannot understand comes back with the
 * offending tokens described in `problems`.
 */
export function parseFenceInfo(info: string): FenceInfo {
	const trimmed = info.trim();
	if (trimmed === '') return { options: {}, problems: [] };

	const firstSpace = trimmed.search(/\s/);
	const lang = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
	const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace);

	const options: Partial<Record<FenceOption, string | true>> = {};
	const problems: string[] = [];
	let cursor = 0;

	while (cursor < rest.length) {
		const remaining = rest.slice(cursor);
		const space = /^\s+/.exec(remaining);
		if (space !== null) {
			cursor += space[0].length;
			continue;
		}

		const match = FENCE_OPTION_PATTERN.exec(remaining);
		if (match === null) {
			// Residue. Consume to the next space so the walk always advances, and report
			// it: this is the branch the previous scanner did not have.
			const span = remaining.split(/\s/)[0] as string;
			problems.push(
				`"${span}" is not an option. Options are ${Object.keys(FENCE_OPTIONS).join(', ')}.`,
			);
			cursor += span.length;
			continue;
		}

		cursor += (match[0] as string).length;
		const name = match[1] as string;
		const value = match[2] ?? match[3];
		const spec = (FENCE_OPTIONS as Record<string, { field: string; arity: string } | undefined>)[
			name
		];

		if (spec === undefined) {
			problems.push(
				`"${name}" is not an option. Options are ${Object.keys(FENCE_OPTIONS).join(', ')}.`,
			);
			continue;
		}
		if (spec.arity === 'value' && value === undefined) {
			problems.push(`"${name}" needs a value, as ${name}="...".`);
			continue;
		}
		if (spec.arity === 'flag' && value !== undefined) {
			problems.push(`"${name}" is a flag and takes no value. Write it on its own.`);
			continue;
		}
		options[name as FenceOption] = spec.arity === 'flag' ? true : (value as string);
	}

	return { lang, options, problems };
}

/**
 * `"2,5-7"` to `[2, 5, 6, 7]`, sorted and deduplicated.
 *
 * Returns `undefined` for anything it cannot read, so a typo becomes a refusal naming
 * the option rather than a silently empty highlight set. Ranges are inclusive and a
 * reversed one is not silently swapped: `7-5` is a mistake, and swapping it would
 * highlight lines the author did not name.
 */
export function parseHighlightLines(value: string): number[] | undefined {
	const found = new Set<number>();
	for (const part of value.split(',')) {
		const range = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
		if (range === null) return undefined;
		const from = Number(range[1]);
		const to = range[2] === undefined ? from : Number(range[2]);
		if (from < 1 || to < from) return undefined;
		for (let line = from; line <= to; line += 1) found.add(line);
	}
	return found.size === 0 ? undefined : [...found].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// What the compiler refuses rather than parses
// ---------------------------------------------------------------------------

/**
 * The math delimiter, reserved and refused.
 *
 * `ast.ts` records why math is deferred: the corpus has none, and `$...$` has two
 * live false positives in already-published copy. `$$` is not ambiguous in the same
 * way, so it is the one spelling worth reserving: a document that uses it is asking
 * for something this AST major cannot carry, and the compiler says so instead of
 * rendering a price as an equation.
 *
 * Refusing is what makes adding math in `ast-2` safe. Silently rendering `$$` as text
 * today would make a later parser a breaking change for every page that had used it.
 */
export const RESERVED_MATH_PATTERN = /\$\$/;

/**
 * Raw HTML, refused in source.
 *
 * There is no `html` node in the AST and no `dangerouslySetInnerHTML` in the
 * renderer, so the refusal is what makes that a structural property rather than a
 * convention. The pattern is deliberately loose: it matches an opening tag shape
 * anywhere outside code, and the compiler is responsible for not applying it inside
 * a fence or inline code.
 *
 * An HTML comment is not matched here. `hexdocs-disable-next-line` is written as one,
 * and `DISABLE_COMMENT_PATTERN` in `lint.ts` is what reads it.
 */
export const RAW_HTML_PATTERN = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/;
