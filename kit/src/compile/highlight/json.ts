/**
 * JSON, which is small enough that this one is close to complete.
 *
 * The single judgement it makes is the one that matters on a page: a string followed by
 * a colon is a key and everything else is a value, so a reader scanning a payload can
 * tell the shape from the colour. That is a lexical test rather than a structural one,
 * so a bare string sitting before a colon in something that is not an object would be
 * called a key. Real JSON has no such position, which is why the cheap test is enough.
 *
 * Nothing here validates. A fence in a docs page is often an excerpt with an ellipsis in
 * it or a comment somebody added, and refusing to colour a snippet because it would not
 * parse would take the highlighting away from exactly the pages that most need it. What
 * a rule does not recognise stays unstyled, and the characters stay where they were.
 */

import type { CodeScope } from '../../../../src/contracts/ast.js';
import type { Grammar, Span } from './index.js';

const DIGIT = /[0-9]/;
const HEX = /[0-9a-fA-F]/;
const WORD = /[A-Za-z]/;
const WHITESPACE = /\s/;

const PUNCTUATION_CHARS: ReadonlySet<string> = new Set('{}[],:'.split(''));

/**
 * Whether a token can begin at this offset.
 *
 * Used only to decide how far a run of unstyled text extends. Being wrong in the
 * generous direction costs one extra span, which `linesFrom` merges away; being wrong in
 * the mean direction would swallow a token, so every branch of the scanner is here.
 */
function startsToken(ch: string): boolean {
	return ch === '"' || ch === '-' || DIGIT.test(ch) || WORD.test(ch) || PUNCTUATION_CHARS.has(ch);
}

/**
 * How many characters the escape at `at` covers, or 0 if this is not one.
 *
 * `\uXXXX` is taken whole, and only when four hex digits really follow, so a truncated
 * one is two characters of escape rather than an escape that reaches into the text after
 * it. A backslash immediately before a newline or at the end of the input is not an
 * escape: an escape there would consume the newline and step straight over the check in
 * the scanner below that ends a string at the end of its line.
 */
function escapeLength(code: string, at: number): number {
	const next = code[at + 1];
	if (next === undefined || next === '\n') return 0;
	if (next === 'u') {
		const digits = code.slice(at + 2, at + 6);
		if (digits.length === 4 && [...digits].every((digit) => HEX.test(digit))) return 6;
	}
	return 2;
}

/** True when the next thing that is not whitespace is a colon. */
function keyFollows(code: string, from: number): boolean {
	let cursor = from;
	while (cursor < code.length && WHITESPACE.test(code[cursor] as string)) cursor += 1;
	return code[cursor] === ':';
}

/**
 * A string, pushing its spans and returning the offset after it.
 *
 * The runs are collected before any of them is pushed, because whether this string is a
 * key is only known once its closing quote has been found, and a whitespace-tolerant
 * lookahead means the colon can even be on the next line. Escapes keep their own scope
 * either way: an escape inside a key is still an escape.
 */
function stringInto(code: string, from: number, spans: Span[]): number {
	const parts: { end: number; escape: boolean }[] = [];
	let cursor = from + 1;
	let run = from;

	while (cursor < code.length) {
		const ch = code[cursor];
		if (ch === '"') {
			cursor += 1;
			break;
		}
		// A JSON string cannot contain a raw newline, so stopping here is what keeps a
		// missing closing quote from colouring the rest of the block as a string.
		if (ch === '\n') break;
		if (ch === '\\') {
			const length = escapeLength(code, cursor);
			if (length > 0) {
				if (cursor > run) parts.push({ end: cursor, escape: false });
				cursor += length;
				parts.push({ end: cursor, escape: true });
				run = cursor;
				continue;
			}
		}
		cursor += 1;
	}

	if (cursor > run) parts.push({ end: cursor, escape: false });

	const scope: CodeScope = keyFollows(code, cursor) ? 'property' : 'string';
	for (const part of parts) spans.push({ end: part.end, scope: part.escape ? 'escape' : scope });
	return cursor;
}

/** The end of a number, or `from` when the `-` turns out not to start one. */
function numberEnd(code: string, from: number): number {
	const run = (start: number): number => {
		let cursor = start;
		while (cursor < code.length && DIGIT.test(code[cursor] as string)) cursor += 1;
		return cursor;
	};

	let cursor = code[from] === '-' ? from + 1 : from;
	if (!DIGIT.test(code[cursor] ?? '')) return from;

	cursor = run(cursor);
	if (code[cursor] === '.' && DIGIT.test(code[cursor + 1] ?? '')) cursor = run(cursor + 1);

	const marker = code[cursor];
	if (marker === 'e' || marker === 'E') {
		const sign = code[cursor + 1] === '+' || code[cursor + 1] === '-' ? 1 : 0;
		if (DIGIT.test(code[cursor + 1 + sign] ?? '')) cursor = run(cursor + 1 + sign);
	}
	return cursor;
}

/**
 * Classifies a whole fence body.
 *
 * Every branch consumes at least one character, so the loop terminates on any input
 * rather than on the inputs that were tested. The last branch takes the current
 * character whatever it is and then runs on to the next thing that could start a token.
 */
function scanJson(code: string): Span[] {
	const spans: Span[] = [];
	let cursor = 0;

	while (cursor < code.length) {
		const ch = code[cursor] as string;

		if (ch === '"') {
			cursor = stringInto(code, cursor, spans);
			continue;
		}

		if (ch === '-' || DIGIT.test(ch)) {
			const end = numberEnd(code, cursor);
			if (end > cursor) {
				cursor = end;
				spans.push({ end: cursor, scope: 'number' });
				continue;
			}
		}

		if (WORD.test(ch)) {
			let end = cursor;
			while (end < code.length && WORD.test(code[end] as string)) end += 1;
			const word = code.slice(cursor, end);
			const scope =
				word === 'true' || word === 'false' ? 'boolean' : word === 'null' ? 'constant' : undefined;
			cursor = end;
			spans.push(scope === undefined ? { end } : { end, scope });
			continue;
		}

		if (PUNCTUATION_CHARS.has(ch)) {
			cursor += 1;
			spans.push({ end: cursor, scope: 'punctuation' });
			continue;
		}

		cursor += 1;
		while (cursor < code.length && !startsToken(code[cursor] as string)) cursor += 1;
		spans.push({ end: cursor });
	}

	return spans;
}

export const jsonGrammar: Grammar = {
	scopes: ['boolean', 'constant', 'escape', 'number', 'property', 'punctuation', 'string'],
	scan: scanJson,
};
