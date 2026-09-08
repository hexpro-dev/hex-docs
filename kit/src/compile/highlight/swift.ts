/**
 * Swift, as a lexer sized to the corpus. It is not a Swift parser and it never will be.
 *
 * It reads left to right, one character at a time, with no symbol table, no knowledge of
 * scope and no idea what any name refers to. That is enough to colour the 47 Swift
 * fences in hex-nfc and kcalc's documents correctly, and it is worth writing down what
 * it gets wrong so nobody trusts it further than it goes:
 *
 * - **A type used as a value reads as a call.** `NFCTagReaderSession(pollingOption:)`
 *   scopes the name as a function, because an identifier immediately followed by `(` is
 *   the call rule and the call rule is checked first. An initialiser is a call, so this
 *   is defensible, but it is a guess and not a deduction.
 * - **A label that looks like a call.** Nothing distinguishes an argument label, a
 *   dictionary key or an enum case from a name of the same shape, so `queue.async {`
 *   scopes `async` as a keyword because `async` is one, even though here it is a method.
 * - **An upper-case identifier is assumed to be a type.** A constant named `Version` is
 *   coloured as a type, and a lower-case type name is not coloured at all.
 * - **String interpolation is not re-entered.** `\(` is scoped as an escape and the
 *   expression after it stays inside the string, so a `"` inside an interpolation ends
 *   the string early and the rest of the line is highlighted as code.
 * - **Raw strings and regex literals are not recognised.** `#"..."#` highlights as a
 *   plain string with a stray `#`, and a `/.../` regex literal is read as a comment or
 *   as division depending on what follows it.
 *
 * Each of those is a wrong colour on a page, never a wrong character: every branch here
 * consumes source and hands back the offset it reached, and `linesFrom` slices the
 * original string by those offsets.
 */

import type { CodeScope } from '../../../../src/contracts/ast.js';
import type { Grammar, Span } from './index.js';

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * Swift's reserved words, plus the declaration modifiers that are reserved in context.
 *
 * Sorted, and the suite asserts it stays sorted, because a list this long is read by
 * eye and an out-of-place entry is how the same word gets added twice.
 *
 * `true`, `false` and `nil` are deliberately not here. They are keywords in the language
 * and `boolean` and `constant` in the highlight vocabulary, and colouring a literal the
 * same as `guard` throws away the one distinction a reader scanning a snippet for its
 * default value actually wants.
 *
 * The context-reserved half stops at the declaration modifiers. `get`, `set`, `left`,
 * `right`, `none`, `Type` and `Protocol` are reserved in context too and are left out on
 * purpose: each is an ordinary identifier often enough that colouring it as a keyword
 * would be wrong more often than right.
 */
export const SWIFT_KEYWORDS: ReadonlySet<string> = new Set([
	'Any',
	'Self',
	'as',
	'associatedtype',
	'async',
	'await',
	'break',
	'case',
	'catch',
	'class',
	'continue',
	'convenience',
	'default',
	'defer',
	'deinit',
	'didSet',
	'do',
	'dynamic',
	'else',
	'enum',
	'extension',
	'fallthrough',
	'fileprivate',
	'final',
	'for',
	'func',
	'guard',
	'if',
	'import',
	'in',
	'indirect',
	'init',
	'inout',
	'internal',
	'is',
	'lazy',
	'let',
	'mutating',
	'nonmutating',
	'open',
	'operator',
	'override',
	'precedencegroup',
	'private',
	'protocol',
	'public',
	'repeat',
	'required',
	'rethrows',
	'return',
	'self',
	'some',
	'static',
	'struct',
	'subscript',
	'super',
	'switch',
	'throw',
	'throws',
	'try',
	'typealias',
	'unowned',
	'var',
	'weak',
	'where',
	'while',
	'willSet',
]);

/** Swift identifiers are not ASCII-only, so these are Unicode properties rather than ranges. */
const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;
const UPPER_START = /^\p{Lu}/u;
const DIGIT = /[0-9]/;
const HEX = /[0-9a-fA-F]/;
const BINARY = /[01]/;
const OCTAL = /[0-7]/;

const OPERATOR_CHARS: ReadonlySet<string> = new Set('+-*/%=<>!&|^~?'.split(''));
const PUNCTUATION_CHARS: ReadonlySet<string> = new Set('(){}[],;:.'.split(''));

/**
 * Whether a token can begin at this offset.
 *
 * Only used to decide how far a run of unstyled text extends, so it may be wrong in the
 * safe direction: a character wrongly called a token start costs one extra span, which
 * `linesFrom` merges back. A character wrongly called uninteresting would swallow a
 * token, so every branch of the scanner below is represented here.
 */
function startsToken(ch: string): boolean {
	return (
		ch === '"' ||
		ch === '/' ||
		ch === '@' ||
		ch === '$' ||
		DIGIT.test(ch) ||
		IDENT_START.test(ch) ||
		OPERATOR_CHARS.has(ch) ||
		PUNCTUATION_CHARS.has(ch)
	);
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

/** The offset of the newline that ends this line, or the end of the input. */
function lineEnd(code: string, from: number): number {
	const at = code.indexOf('\n', from);
	return at === -1 ? code.length : at;
}

/**
 * The end of a block comment, counting nesting.
 *
 * Swift really does nest block comments, and the count is what keeps a commented-out
 * block that itself contains a comment from ending early. Without it the inner
 * comment's closing marker ends the outer one and the rest of the snippet highlights as
 * live code.
 *
 * An unterminated comment runs to the end of the fence, which is the honest reading: the
 * author wrote an opener and no closer.
 */
function blockCommentEnd(code: string, from: number): number {
	let depth = 0;
	let cursor = from;
	while (cursor < code.length) {
		if (code.startsWith('/*', cursor)) {
			depth += 1;
			cursor += 2;
			continue;
		}
		if (code.startsWith('*/', cursor)) {
			depth -= 1;
			cursor += 2;
			if (depth === 0) return cursor;
			continue;
		}
		cursor += 1;
	}
	return code.length;
}

/**
 * How many characters the escape sequence at `at` covers, or 0 if this is not one.
 *
 * `\u{1F600}` is taken whole so the braces are not left outside the escape, and only
 * when the closing brace is on the same line, so an unclosed one cannot eat the rest of
 * the fence. A backslash at the end of a line or at the end of the input is not an
 * escape here: Swift's line continuation is one, but reading it as an escape would let
 * an unterminated single-line string swallow the line below it.
 */
function escapeLength(code: string, at: number): number {
	const next = code[at + 1];
	if (next === undefined || next === '\n') return 0;
	if (next === 'u' && code[at + 2] === '{') {
		const close = code.indexOf('}', at + 3);
		if (close !== -1 && close < lineEnd(code, at)) return close + 1 - at;
	}
	return 2;
}

/**
 * A string literal, pushing its spans and returning the offset after it.
 *
 * Escapes break the run, so `"a\nb"` is string, escape, string rather than one token, in
 * a corpus where the escape is often the point of the line. A `"""` literal crosses
 * lines and a `"` one stops at the first newline, which is what Swift itself does and
 * what keeps a missing closing quote from colouring the rest of the fence as a string.
 */
function stringInto(code: string, from: number, spans: Span[]): number {
	const triple = code.startsWith('"""', from);
	const delimiter = triple ? '"""' : '"';
	let cursor = from + delimiter.length;
	let run = from;

	while (cursor < code.length) {
		if (code.startsWith(delimiter, cursor)) {
			cursor += delimiter.length;
			break;
		}
		const ch = code[cursor];
		if (!triple && ch === '\n') break;
		if (ch === '\\') {
			const length = escapeLength(code, cursor);
			if (length > 0) {
				if (cursor > run) spans.push({ end: cursor, scope: 'string' });
				cursor += length;
				spans.push({ end: cursor, scope: 'escape' });
				run = cursor;
				continue;
			}
		}
		cursor += 1;
	}

	if (cursor > run) spans.push({ end: cursor, scope: 'string' });
	return cursor;
}

/** The end of a numeric literal starting at a digit. Never returns `from`. */
function numberEnd(code: string, from: number): number {
	const prefix = code.slice(from, from + 2).toLowerCase();
	const radix = prefix === '0x' ? HEX : prefix === '0b' ? BINARY : prefix === '0o' ? OCTAL : null;
	const run = (start: number, digits: RegExp): number => {
		let cursor = start;
		while (cursor < code.length) {
			const ch = code[cursor] as string;
			if (!digits.test(ch) && ch !== '_') break;
			cursor += 1;
		}
		return cursor;
	};

	if (radix !== null && radix.test(code[from + 2] ?? '')) return run(from + 2, radix);

	let cursor = run(from, DIGIT);
	if (code[cursor] === '.' && DIGIT.test(code[cursor + 1] ?? '')) cursor = run(cursor + 1, DIGIT);

	const marker = code[cursor];
	if (marker === 'e' || marker === 'E') {
		const sign = code[cursor + 1] === '+' || code[cursor + 1] === '-' ? 1 : 0;
		if (DIGIT.test(code[cursor + 1 + sign] ?? '')) cursor = run(cursor + 1 + sign, DIGIT);
	}
	return cursor;
}

/** The end of the identifier starting at `from`. */
function identEnd(code: string, from: number): number {
	let cursor = from;
	while (cursor < code.length && IDENT_PART.test(code[cursor] as string)) cursor += 1;
	return cursor;
}

/**
 * What an identifier means, as far as a lexer can tell.
 *
 * The order is the whole rule. A keyword is a keyword wherever it appears; a call is
 * recognised before a member, so `.begin()` is a function rather than a property; and
 * the upper-case guess is last, so it only applies to a name nothing else explained.
 */
function identScope(code: string, from: number, end: number): CodeScope | undefined {
	const word = code.slice(from, end);
	if (SWIFT_KEYWORDS.has(word)) return 'keyword';
	if (word === 'true' || word === 'false') return 'boolean';
	if (word === 'nil') return 'constant';
	if (code[end] === '(') return 'function';
	if (code[from - 1] === '.') return 'property';
	if (UPPER_START.test(word)) return 'type';
	return undefined;
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/**
 * Classifies a whole fence body.
 *
 * Every branch consumes at least one character, including the last one, which is what
 * makes the loop terminate on any input at all rather than on the inputs that were
 * tested. The final branch consumes the current character unconditionally and then runs
 * on to the next thing that could start a token, so a character no rule claims costs one
 * span rather than one per character.
 */
function scanSwift(code: string): Span[] {
	const spans: Span[] = [];
	let cursor = 0;

	while (cursor < code.length) {
		const ch = code[cursor] as string;

		if (ch === '/' && code[cursor + 1] === '/') {
			const doc = code[cursor + 2] === '/';
			cursor = lineEnd(code, cursor);
			spans.push({ end: cursor, scope: doc ? 'doc' : 'comment' });
			continue;
		}

		if (ch === '/' && code[cursor + 1] === '*') {
			const doc = code[cursor + 2] === '*';
			cursor = blockCommentEnd(code, cursor);
			spans.push({ end: cursor, scope: doc ? 'doc' : 'comment' });
			continue;
		}

		if (ch === '"') {
			cursor = stringInto(code, cursor, spans);
			continue;
		}

		if (DIGIT.test(ch)) {
			cursor = numberEnd(code, cursor);
			spans.push({ end: cursor, scope: 'number' });
			continue;
		}

		// `@objc`, `@MainActor`. The `@` is part of the attribute rather than punctuation
		// beside it, because it is part of the name the author would search for.
		if (ch === '@' && IDENT_START.test(code[cursor + 1] ?? '')) {
			cursor = identEnd(code, cursor + 1);
			spans.push({ end: cursor, scope: 'attribute' });
			continue;
		}

		// `$0`, `$1`: a closure's shorthand argument, and a real variable rather than
		// punctuation. The same spelling covers a property wrapper's projected value.
		if (ch === '$') {
			const end = identEnd(code, cursor + 1);
			if (end > cursor + 1) {
				cursor = end;
				spans.push({ end: cursor, scope: 'variable' });
				continue;
			}
		}

		if (IDENT_START.test(ch)) {
			const end = identEnd(code, cursor);
			const scope = identScope(code, cursor, end);
			spans.push(scope === undefined ? { end } : { end, scope });
			cursor = end;
			continue;
		}

		if (OPERATOR_CHARS.has(ch)) {
			cursor += 1;
			while (cursor < code.length && OPERATOR_CHARS.has(code[cursor] as string)) cursor += 1;
			spans.push({ end: cursor, scope: 'operator' });
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

export const swiftGrammar: Grammar = {
	scopes: [
		'attribute',
		'boolean',
		'comment',
		'constant',
		'doc',
		'escape',
		'function',
		'keyword',
		'number',
		'operator',
		'property',
		'punctuation',
		'string',
		'type',
		'variable',
	],
	scan: scanSwift,
};
