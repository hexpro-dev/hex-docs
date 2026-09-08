/**
 * Folding source lines into the single string the inline parser reads, and slicing
 * that string back out again with its positions intact.
 *
 * Every file in the corpus is hard-wrapped at roughly 75 columns, so a line break
 * inside a paragraph is an artefact of the file width and never content. `TextNode`
 * records the rule and where it comes from: `hex-web/apps/front/app/lib/legal-markdown.ts`
 * already ships it, and the part that is easy to get wrong is the joiner. It is a
 * space unless the characters on *both* sides are wide, because the seam between a
 * Latin word and a CJK word in a mixed sentence is a real space and stays one.
 *
 * The map back is the reason this is a module rather than a `join(' ')`. Without it
 * every inline finding would report the line the block started on, and a fifty-line
 * procedure would report every one of its findings against its first line.
 */

import type { FoldedText, SourceRun } from '../types.js';

/** One source line, with where it starts. Both 1-based, as every editor counts them. */
export interface SourceLine {
	text: string;
	line: number;
	/** Column of `text[0]` in the original line, after any container marker was stripped. */
	column: number;
}

/**
 * The sentinel a hard line break folds to.
 *
 * U+0000 cannot occur in the folded text: `readSource` replaces it with U+FFFD on the
 * way in, which is what CommonMark does with it and what makes this sentinel safe.
 * Marking the break in the string rather than splitting the fold into segments is what
 * keeps every offset in one coordinate system, which is the whole point of this module.
 */
export const BREAK_SENTINEL = '\u0000';

/**
 * Wide characters, for the joiner rule.
 *
 * The ranges are East Asian Wide and Fullwidth plus the CJK blocks either side of
 * them. Deliberately not `\p{scx=Han}`: the rule is about how the characters are
 * drawn, not which language they belong to, and a fullwidth Latin letter in a Japanese
 * sentence needs no space after it either.
 */
const WIDE =
	/[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3ffff}]/u;

/** True when the character is drawn full width, and therefore needs no joining space. */
export function isWide(character: string): boolean {
	return WIDE.test(character);
}

/**
 * The first and the last whole character of a string, surrogate pairs included.
 *
 * Indexing a string gives one UTF-16 code unit, and half the ranges above are astral:
 * `\u{20000}` to `\u{3ffff}` is CJK Extension B onwards, two code units each. Handing
 * `isWide` a lone surrogate matches nothing, so the astral half of the table could never
 * fire from the joiner below and an Extension B page would grow a space in the middle of
 * every wrapped sentence.
 */
function firstCharacter(text: string): string {
	const point = text.codePointAt(0);
	return point === undefined ? '' : String.fromCodePoint(point);
}

function lastCharacter(text: string): string {
	if (text === '') return '';
	const tail = text.slice(-2);
	const point = tail.codePointAt(0);
	return point !== undefined && point > 0xffff ? tail : (text.at(-1) as string);
}

/**
 * Removes a trailing hard-break marker, reporting whether one was there.
 *
 * Only the backslash spelling is recognised. Two trailing spaces mean the same thing
 * in CommonMark and are invisible in review, in a diff and in every editor that trims
 * them on save, so a page whose masthead depended on them would lose its line break to
 * a formatter with nothing to say why.
 */
function stripBreak(text: string): { text: string; hardBreak: boolean } {
	const trimmed = text.replace(/[ \t]+$/, '');
	if (trimmed.endsWith('\\') && !trimmed.endsWith('\\\\')) {
		return { text: trimmed.slice(0, -1), hardBreak: true };
	}
	return { text: trimmed, hardBreak: false };
}

/**
 * Folds a run of source lines into one string, keeping a run per line.
 *
 * A hard break contributes the sentinel instead of a joiner, so the inline parser can
 * turn it into a `break` node without knowing anything about line numbers.
 */
export function foldLines(lines: readonly SourceLine[]): FoldedText {
	let text = '';
	const runs: SourceRun[] = [];
	// The break belongs to the line that carried the backslash and takes effect before
	// the next line's content, so it is carried forward rather than applied in place. An
	// earlier version applied it to the joiner preceding the current line, which put every
	// break one line early: the masthead still had two lines and they were the wrong two.
	let pendingBreak = false;

	for (const [index, source] of lines.entries()) {
		const { text: body, hardBreak } = stripBreak(source.text);

		if (index > 0) {
			if (pendingBreak) {
				text += BREAK_SENTINEL;
			} else {
				const previous = lastCharacter(text);
				const next = firstCharacter(body);
				// A joiner is only suppressed when both sides are wide. One wide side and one
				// narrow is the mixed-script seam, which is a real space to a reader.
				const joined = previous !== '' && next !== '' && isWide(previous) && isWide(next);
				text += joined ? '' : ' ';
			}
		}

		runs.push({
			offset: text.length,
			length: body.length,
			line: source.line,
			column: source.column,
		});
		text += body;
		// A backslash on the last line has nothing to break before, so it is dropped rather
		// than left as a sentinel the inline parser would turn into a trailing empty line.
		pendingBreak = hardBreak;
	}

	return { text, runs };
}

/** A folded text holding one line, which is what a heading or a table cell is. */
export function foldOne(source: SourceLine): FoldedText {
	return foldLines([source]);
}

/**
 * Concatenates slices of a folded text, carrying the positions across.
 *
 * This is how a prose segment is built: the ranges are the text nodes' own spans, so
 * what comes out is what a reader reads, with the markup, the inline code and the
 * recognised status glyphs already gone, and with every character still pointing at
 * the line it was typed on.
 *
 * Ranges must be ascending and must not overlap. They come from a single left to right
 * parse, so a caller that broke that has a bug worth throwing over rather than a
 * position worth guessing at.
 */
export function sliceFolded(folded: FoldedText, ranges: readonly [number, number][]): FoldedText {
	let text = '';
	const runs: SourceRun[] = [];
	let previousEnd = -1;

	for (const [start, end] of ranges) {
		if (start < previousEnd) {
			throw new Error(
				`sliceFolded: range [${start}, ${end}) starts before the previous range ended at ` +
					`${previousEnd}. Ranges come from one left to right parse and cannot overlap.`,
			);
		}
		previousEnd = end;
		if (end <= start) continue;

		for (const run of folded.runs) {
			const from = Math.max(start, run.offset);
			const to = Math.min(end, run.offset + run.length);
			if (to <= from) continue;
			runs.push({
				offset: text.length + (from - start),
				length: to - from,
				line: run.line,
				column: run.column + (from - run.offset),
			});
		}
		text += folded.text.slice(start, end);
	}

	return { text, runs };
}

/** Concatenates whole folded texts, which is what a multi-block prose segment needs. */
export function concatFolded(parts: readonly FoldedText[]): FoldedText {
	let text = '';
	const runs: SourceRun[] = [];
	for (const part of parts) {
		for (const run of part.runs) {
			runs.push({ ...run, offset: run.offset + text.length });
		}
		text += part.text;
	}
	return { text, runs };
}

/**
 * Reads a source file into lines the parser can address.
 *
 * Three normalisations happen here and nowhere else. A BOM is dropped, because it
 * would otherwise become the first character of the first heading. CRLF becomes LF, so
 * a file committed from Windows parses the same as one committed from macOS. And
 * U+0000 becomes U+FFFD, which is what CommonMark specifies and what makes
 * `BREAK_SENTINEL` safe to use as a marker in the folded text.
 */
export function readSource(source: string): string {
	return source
		.replace(/^\ufeff/, '')
		.replaceAll('\r\n', '\n')
		.replaceAll('\u0000', '\ufffd');
}

/** Splits already-normalised source into addressable lines, starting at `firstLine`. */
export function toLines(source: string, firstLine = 1): SourceLine[] {
	return source.split('\n').map((text, index) => ({ text, line: firstLine + index, column: 1 }));
}
