/**
 * The highlighter.
 *
 * One invariant carries most of this file: the text of the tokens, put back together, is
 * the fence body with at most one trailing newline removed. A highlighter that loses a
 * character publishes a snippet that does not compile, and a coloured code block is
 * exactly the thing nobody proofreads. So the round trip is asserted over every unit
 * case, over every fence in the fixture corpus, and over span lists no grammar produces.
 *
 * The second is that every scope a grammar emits is one the AST declares, checked by
 * sweeping the tokens rather than by reading the source and trusting it, and checked in
 * both directions against each grammar's declared vocabulary so that a rule which stops
 * firing fails here instead of quietly dropping a colour.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { CODE_SCOPES } from '../../../src/contracts/ast.js';
import type { CodeScope, CodeToken } from '../../../src/contracts/ast.js';
import { PLAIN_CODE_LANGUAGE } from '../../../src/contracts/project.js';
import { parseFenceInfo } from '../../../src/contracts/source.js';
import { SITE_ROOT, contentPath } from '../../../fixtures/index.js';
import type { HighlightResult } from '../../src/compile/types.js';
import {
	GRAMMARS,
	LANGUAGE_LABELS,
	highlight,
	languageLabel,
	linesFrom,
} from '../../src/compile/highlight/index.js';
import { SWIFT_KEYWORDS } from '../../src/compile/highlight/swift.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The invariant, written once so every caller asserts the same thing. */
const rebuild = (result: HighlightResult): string =>
	result.lines.map((line) => line.tokens.map((token) => token.text).join('')).join('\n');

/** What the round trip must equal: the input, less at most one trailing newline. */
const expected = (code: string): string => (code.endsWith('\n') ? code.slice(0, -1) : code);

const tokensOf = (result: HighlightResult): CodeToken[] =>
	result.lines.flatMap((line) => line.tokens);

/** Tokens as pairs, which reads better in a failure than a list of objects. */
const pairs = (code: string, lang: string): [string, CodeScope | undefined][] =>
	tokensOf(highlight(code, lang)).map((token) => [token.text, token.scope]);

const SCOPES: ReadonlySet<string> = new Set<string>(CODE_SCOPES);

interface Case {
	readonly name: string;
	readonly code: string;
}

// ---------------------------------------------------------------------------
// The unit corpus
// ---------------------------------------------------------------------------

/*
 * Between them these have to reach every scope `swiftGrammar` claims, and every branch
 * of the lexer, including the ones that only fire on source that is wrong: an
 * unterminated string, an unclosed comment, a truncated escape. A docs fence is often an
 * excerpt, so malformed input is the ordinary case rather than the hostile one.
 */
const SWIFT_CASES: readonly Case[] = [
	{ name: 'a declaration', code: 'let count = 42' },
	{ name: 'a line comment', code: 'session.begin() // fire and forget' },
	{ name: 'a doc comment', code: '/// The identifier the chip reports.\nlet uid = "04A2"' },
	{ name: 'a block comment over two lines', code: '/* first\n   second */ let a = 1' },
	{ name: 'a doc block comment', code: '/** Opens the reader session. */' },
	{ name: 'nested block comments', code: '/* outer /* inner */ still outer */ let a = 1' },
	{ name: 'an unterminated block comment', code: 'let a = 1 /* runs to the end' },
	{ name: 'a comment with no newline after it', code: '// the last line of the fence' },
	{ name: 'a string with an escape', code: 'let prompt = "Hold the tag.\\nKeep holding."' },
	{ name: 'adjacent escapes', code: 'let gap = "\\n\\t"' },
	{ name: 'a unicode escape', code: 'let tick = "\\u{2714} done"' },
	{ name: 'an unclosed unicode escape', code: 'let broken = "\\u{2714 done"' },
	{ name: 'a unicode escape whose brace is on the next line', code: '"""\n\\u{41\n}\n"""' },
	{ name: 'a multi-line string', code: 'let body = """\n{"v": 2}\n"""' },
	{ name: 'an unterminated string', code: 'let broken = "no closing quote\nlet next = 1' },
	{ name: 'a backslash at the end of the fence', code: 'let trailing = "\\' },
	{ name: 'a string ending on an escape', code: 'let cut = "a\\t' },
	{ name: 'a decimal point at the end of the fence', code: 'let a = 1.' },
	{ name: 'an at sign at the end of the fence', code: 'let a = @' },
	{ name: 'a line continuation in a multi-line string', code: '"""\nfirst \\\nsecond\n"""' },
	{ name: 'attributes', code: '@objc @MainActor final class TagSession {}' },
	{ name: 'an at sign that starts nothing', code: 'let mixed = a @ b' },
	{ name: 'closure shorthand arguments', code: 'items.sorted { $0.createdAt > $1.createdAt }' },
	{ name: 'a dollar that starts nothing', code: 'let price = $ 5' },
	{ name: 'numbers', code: 'let values = [0xFF, 0b1010, 0o755, 1_000, 1.5, 2e10, 1e-3, 0]' },
	{ name: 'a hex prefix with no hex digits', code: 'let mask = 0xZZ' },
	{ name: 'a hex prefix at the end of the fence', code: 'let mask = 0x' },
	{ name: 'an exponent marker with no exponent', code: 'let odd = 12e' },
	{ name: 'literals', code: 'if ready == true { return nil } else { return false }' },
	{
		name: 'a call, a type and a member',
		code: 'let session = NFCTagReaderSession(pollingOption: [.iso14443], delegate: self)',
	},
	{
		name: 'a compiler directive, which this lexer does not know',
		code: '#if DEBUG\nlet on = true\n#endif',
	},
	{ name: 'a function signature', code: 'public func begin(_ intent: Intent) throws -> Bool' },
];

const JSON_CASES: readonly Case[] = [
	{ name: 'an object', code: '{\n  "v": 2,\n  "kind": "route"\n}' },
	{ name: 'literals', code: '{"ok": true, "off": false, "gone": null}' },
	{ name: 'numbers', code: '[0, -2.5, 3e4, 1E+2, 7]' },
	{ name: 'a minus that starts nothing', code: '[-]' },
	{ name: 'escapes', code: '{"quote": "a \\" b", "accent": "\\u00e9"}' },
	{ name: 'a truncated unicode escape', code: '{"short": "\\u12"}' },
	{ name: 'a unicode escape with no hex after it', code: '{"bad": "\\uZZZZ"}' },
	{ name: 'adjacent escapes', code: '{"gap": "\\n\\t"}' },
	{ name: 'a key whose colon is on the next line', code: '{"key"\n: 1}' },
	{ name: 'an unterminated string', code: '{"open\n: 1}' },
	{ name: 'a string that runs to the end of the fence', code: '{"open' },
	{ name: 'a backslash at the end of the fence', code: '{"a": "b\\' },
	{ name: 'a string ending on an escape', code: '{"gap": "a\\t' },
	{ name: 'a minus at the end of the fence', code: '[1, -' },
	{ name: 'a decimal point at the end of the fence', code: '[1.' },
	{ name: 'an exponent marker at the end of the fence', code: '[1e' },
	{ name: 'text that is not JSON', code: '{ oops }' },
	{ name: 'a bare word at the end of the fence', code: 'true' },
	{ name: 'an excerpt with an ellipsis', code: '{\n  "v": 2,\n  ...\n}' },
];

/**
 * Cases by language, checked against `GRAMMARS` in both directions below, so a grammar
 * added without unit cases fails rather than being covered by the corpus sweep alone.
 */
const GRAMMAR_CASES: Readonly<Record<string, readonly Case[]>> = {
	json: JSON_CASES,
	swift: SWIFT_CASES,
};

// ---------------------------------------------------------------------------
// The fixture corpus
// ---------------------------------------------------------------------------

/**
 * Fences as they are written, info string and body kept apart.
 *
 * The body keeps the newline before the closing marker, because that is what the parser
 * will hand the highlighter and it is the newline the one-trailing-newline rule is
 * about. Extracted with a regex rather than by parsing, so this suite does not depend on
 * a compiler that does not exist yet.
 */
const FENCE_PATTERN = /^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm;

interface Fence {
	readonly file: string;
	readonly lang: string | undefined;
	readonly body: string;
}

function fencesIn(file: string): Fence[] {
	const markdown = readFileSync(join(SITE_ROOT, file), 'utf8');
	const found: Fence[] = [];
	for (const match of markdown.matchAll(FENCE_PATTERN)) {
		found.push({ file, lang: parseFenceInfo(match[1] ?? '').lang, body: match[2] ?? '' });
	}
	return found;
}

const CORPUS_FENCES: readonly Fence[] = [
	...fencesIn(contentPath('en', 'reference/api')),
	...fencesIn(contentPath('en', 'developer/architecture')),
];

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

describe('the round trip', () => {
	test('every unit case comes back byte for byte', () => {
		let swept = 0;
		for (const [lang, cases] of Object.entries(GRAMMAR_CASES)) {
			for (const unit of cases) {
				expect(rebuild(highlight(unit.code, lang)), `${lang}: ${unit.name}`).toBe(
					expected(unit.code),
				);
				// The same body through a language with no grammar has to survive too, and it
				// is a different code path: no spans at all rather than a covering list.
				expect(rebuild(highlight(unit.code, 'metal')), `metal: ${unit.name}`).toBe(
					expected(unit.code),
				);
				swept += 1;
			}
		}
		expect(swept).toBe(SWIFT_CASES.length + JSON_CASES.length);
		expect(swept).toBe(51);
	});

	test('every fence in the corpus comes back byte for byte', () => {
		expect(CORPUS_FENCES).toHaveLength(6);
		for (const fence of CORPUS_FENCES) {
			const result = highlight(fence.body, fence.lang);
			expect(rebuild(result), `${fence.file}: ${fence.lang ?? '(unlabelled)'}`).toBe(
				expected(fence.body),
			);
		}
	});

	test('a trailing newline is removed once and only once', () => {
		expect(rebuild(highlight('let a = 1\n', 'swift'))).toBe('let a = 1');
		expect(rebuild(highlight('let a = 1\n\n', 'swift'))).toBe('let a = 1\n');
		expect(highlight('let a = 1\n\n', 'swift').lines).toHaveLength(2);
		expect(highlight('let a = 1\n\n', 'swift').lines[1]?.tokens).toEqual([]);
	});

	test('an empty fence is one empty line', () => {
		for (const lang of [undefined, PLAIN_CODE_LANGUAGE, 'swift', 'json', 'metal']) {
			const result = highlight('', lang);
			expect(result.lines, `${lang ?? '(none)'}`).toEqual([{ tokens: [] }]);
			expect(rebuild(result)).toBe('');
		}
	});

	test('a fence of nothing but newlines keeps every blank line', () => {
		const result = highlight('\n\n\n', 'swift');
		expect(result.lines).toEqual([{ tokens: [] }, { tokens: [] }, { tokens: [] }]);
		expect(rebuild(result)).toBe('\n\n');
		expect(rebuild(highlight('\n', undefined))).toBe('');
	});
});

// ---------------------------------------------------------------------------
// The scopes
// ---------------------------------------------------------------------------

describe('the scopes', () => {
	test('every scope emitted anywhere is a member of CODE_SCOPES', () => {
		let swept = 0;
		const bodies = [
			...Object.entries(GRAMMAR_CASES).flatMap(([lang, cases]) =>
				cases.map((unit) => ({ lang: lang as string | undefined, code: unit.code })),
			),
			...CORPUS_FENCES.map((fence) => ({ lang: fence.lang, code: fence.body })),
		];
		for (const body of bodies) {
			for (const token of tokensOf(highlight(body.code, body.lang))) {
				if (token.scope !== undefined) expect(SCOPES.has(token.scope)).toBe(true);
				swept += 1;
			}
		}
		// A sweep that examined nothing is a pass that means nothing.
		expect(swept).toBeGreaterThan(500);
	});

	test('each grammar emits exactly the scopes it declares', () => {
		expect(Object.keys(GRAMMAR_CASES).sort()).toEqual(Object.keys(GRAMMARS).sort());

		for (const [lang, grammar] of Object.entries(GRAMMARS)) {
			const seen = new Set<CodeScope>();
			for (const unit of GRAMMAR_CASES[lang] ?? []) {
				for (const token of tokensOf(highlight(unit.code, lang))) {
					if (token.scope !== undefined) seen.add(token.scope);
				}
			}
			// Both directions. A scope declared and never produced is a rule that has
			// stopped firing; a scope produced and never declared is a colour the CSS in
			// this package may not have.
			expect([...seen].sort(), lang).toEqual([...grammar.scopes].sort());
			expect([...grammar.scopes].sort(), lang).toEqual([...grammar.scopes]);
		}
	});

	test('the scopes no grammar here claims are the ones no grammar here covers', () => {
		const claimed = new Set<CodeScope>(Object.values(GRAMMARS).flatMap((g) => [...g.scopes]));
		const unclaimed = CODE_SCOPES.filter((scope) => !claimed.has(scope));
		// Markup, regex-carrying languages and diffs. Nothing here has a grammar for any
		// of the three, and this row is what makes that a decision rather than an
		// oversight: adding one of those grammars has to change this list.
		expect(unclaimed).toEqual(['tag', 'regexp', 'deleted', 'inserted', 'invalid']);
		expect(claimed.size + unclaimed.length).toBe(CODE_SCOPES.length);
	});
});

// ---------------------------------------------------------------------------
// The four language cases
// ---------------------------------------------------------------------------

describe('the four language cases', () => {
	const code = 'let count = 42\n';

	test('no language is unstyled, unhighlighted and unlabelled', () => {
		const result = highlight(code, undefined);
		expect(result.highlighted).toBe(false);
		expect(result.lines).toEqual([{ tokens: [{ text: 'let count = 42' }] }]);
		expect(result.label).toBeUndefined();
		expect('label' in result).toBe(false);
	});

	test('text is unstyled, unhighlighted and unlabelled', () => {
		const result = highlight(code, PLAIN_CODE_LANGUAGE);
		expect(result.highlighted).toBe(false);
		expect(result.lines).toEqual([{ tokens: [{ text: 'let count = 42' }] }]);
		// Absent rather than empty. A chip reading "Text" over the corpus directory tree
		// is noise, and that is the whole difference between this case and metal.
		expect('label' in result).toBe(false);
	});

	test('a language with a grammar is highlighted and labelled', () => {
		const result = highlight(code, 'swift');
		expect(result.highlighted).toBe(true);
		expect(result.label).toBe('Swift');
		expect(tokensOf(result).some((token) => token.scope === 'keyword')).toBe(true);
	});

	test('a language with no grammar is unstyled, unhighlighted and still labelled', () => {
		const result = highlight(code, 'metal');
		expect(result.highlighted).toBe(false);
		expect(result.lines).toEqual([{ tokens: [{ text: 'let count = 42' }] }]);
		// The label is the point. Without it an unknown language and an unlabelled fence
		// would be the same thing to a reader and to llms.txt.
		expect(result.label).toBe('Metal');
	});

	test('the corpus fences land in the case each one is', () => {
		expect(CORPUS_FENCES.map((fence) => fence.lang ?? '(none)')).toEqual([
			'swift',
			'json',
			'(none)',
			'metal',
			'text',
			'swift',
		]);
		expect(
			CORPUS_FENCES.map((fence) => {
				const result = highlight(fence.body, fence.lang);
				return [result.highlighted, result.label ?? '(none)'];
			}),
		).toEqual([
			[true, 'Swift'],
			[true, 'JSON'],
			[false, '(none)'],
			[false, 'Metal'],
			[false, '(none)'],
			[true, 'Swift'],
		]);
	});
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe('languageLabel', () => {
	test('known ids get their display spelling', () => {
		expect(languageLabel('swift')).toBe('Swift');
		expect(languageLabel('json')).toBe('JSON');
		expect(languageLabel('metal')).toBe('Metal');
		expect(languageLabel('sh')).toBe('Shell');
	});

	test('the plain language has no label at all', () => {
		expect(languageLabel(PLAIN_CODE_LANGUAGE)).toBeUndefined();
		expect(languageLabel('TEXT')).toBeUndefined();
		expect(PLAIN_CODE_LANGUAGE in LANGUAGE_LABELS).toBe(false);
	});

	test('an unknown id falls back to the spelling the author typed', () => {
		expect(languageLabel('kotlin')).toBe('kotlin');
		expect(languageLabel('Objective-C')).toBe('Objective-C');
	});

	test('the id is matched case-insensitively', () => {
		expect(languageLabel('Swift')).toBe('Swift');
		expect(highlight('let a = 1', 'SWIFT').highlighted).toBe(true);
	});

	test('every grammar has a label, so no grammar prints a raw id', () => {
		expect(Object.keys(GRAMMARS).length).toBeGreaterThan(0);
		for (const lang of Object.keys(GRAMMARS)) {
			expect(LANGUAGE_LABELS[lang], lang).toBeDefined();
		}
	});
});

// ---------------------------------------------------------------------------
// Spans to lines
// ---------------------------------------------------------------------------

describe('linesFrom', () => {
	test('adjacent slices with the same scope become one token', () => {
		expect(
			linesFrom('abc', [
				{ end: 1, scope: 'keyword' },
				{ end: 2, scope: 'keyword' },
			]),
		).toEqual([{ tokens: [{ text: 'ab', scope: 'keyword' }, { text: 'c' }] }]);
	});

	test('a span list that stops short leaves the tail unstyled', () => {
		const lines = linesFrom('let a', [{ end: 3, scope: 'keyword' }]);
		expect(lines).toEqual([{ tokens: [{ text: 'let', scope: 'keyword' }, { text: ' a' }] }]);
	});

	test('a span that does not advance loses its scope and nothing else', () => {
		const lines = linesFrom('abc', [
			{ end: 2, scope: 'keyword' },
			{ end: 1, scope: 'string' },
			{ end: 3, scope: 'number' },
		]);
		expect(lines).toEqual([
			{
				tokens: [
					{ text: 'ab', scope: 'keyword' },
					{ text: 'c', scope: 'number' },
				],
			},
		]);
		expect(lines[0]?.tokens.map((token) => token.text).join('')).toBe('abc');
	});

	test('a scope may cross a line boundary', () => {
		expect(linesFrom('a\nb', [{ end: 3, scope: 'comment' }])).toEqual([
			{ tokens: [{ text: 'a', scope: 'comment' }] },
			{ tokens: [{ text: 'b', scope: 'comment' }] },
		]);
	});

	test('no spans at all is the unhighlighted path', () => {
		expect(linesFrom('a\n\nb', [])).toEqual([
			{ tokens: [{ text: 'a' }] },
			{ tokens: [] },
			{ tokens: [{ text: 'b' }] },
		]);
	});
});

describe('the span contract each grammar owes', () => {
	test('spans advance, do not overlap and cover the whole body', () => {
		let swept = 0;
		for (const [lang, cases] of Object.entries(GRAMMAR_CASES)) {
			const grammar = GRAMMARS[lang];
			expect(grammar, lang).toBeDefined();
			for (const unit of cases) {
				const spans = grammar?.scan(unit.code) ?? [];
				let previous = 0;
				for (const span of spans) {
					expect(span.end, `${lang}: ${unit.name}`).toBeGreaterThan(previous);
					previous = span.end;
				}
				expect(previous, `${lang}: ${unit.name}`).toBe(unit.code.length);
				swept += 1;
			}
		}
		expect(swept).toBe(51);
	});
});

// ---------------------------------------------------------------------------
// Swift
// ---------------------------------------------------------------------------

describe('the Swift lexer', () => {
	test('the keyword set is sorted and holds no literal', () => {
		const keywords = [...SWIFT_KEYWORDS];
		expect(keywords.length).toBeGreaterThan(50);
		expect(keywords).toEqual([...keywords].sort());
		// They are keywords in the language and `boolean` and `constant` in the highlight
		// vocabulary. Colouring a default value the same as `guard` throws away the one
		// distinction a reader scanning a signature wants.
		for (const literal of ['true', 'false', 'nil']) {
			expect(SWIFT_KEYWORDS.has(literal), literal).toBe(false);
		}
	});

	test('a declaration', () => {
		expect(pairs('let count = 42', 'swift')).toEqual([
			['let', 'keyword'],
			[' count ', undefined],
			['=', 'operator'],
			[' ', undefined],
			['42', 'number'],
		]);
	});

	test('a member, a call and a line comment', () => {
		expect(pairs('session.begin() // fire and forget', 'swift')).toEqual([
			['session', undefined],
			['.', 'punctuation'],
			['begin', 'function'],
			['()', 'punctuation'],
			[' ', undefined],
			['// fire and forget', 'comment'],
		]);
	});

	test('attributes, modifiers and a type', () => {
		expect(pairs('@objc @MainActor final class TagSession {}', 'swift')).toEqual([
			['@objc', 'attribute'],
			[' ', undefined],
			['@MainActor', 'attribute'],
			[' ', undefined],
			['final', 'keyword'],
			[' ', undefined],
			['class', 'keyword'],
			[' ', undefined],
			['TagSession', 'type'],
			[' ', undefined],
			['{}', 'punctuation'],
		]);
	});

	test('closure shorthand arguments are variables', () => {
		expect(pairs('items.sorted { $0.createdAt > $1.id }', 'swift')).toEqual([
			['items', undefined],
			['.', 'punctuation'],
			['sorted', 'property'],
			[' ', undefined],
			['{', 'punctuation'],
			[' ', undefined],
			['$0', 'variable'],
			['.', 'punctuation'],
			['createdAt', 'property'],
			[' ', undefined],
			['>', 'operator'],
			[' ', undefined],
			['$1', 'variable'],
			['.', 'punctuation'],
			['id', 'property'],
			[' ', undefined],
			['}', 'punctuation'],
		]);
	});

	test('escapes break a string into runs', () => {
		expect(pairs('let gap = "\\n\\t"', 'swift')).toEqual([
			['let', 'keyword'],
			[' gap ', undefined],
			['=', 'operator'],
			[' ', undefined],
			['"', 'string'],
			['\\n\\t', 'escape'],
			['"', 'string'],
		]);
	});

	test('a unicode escape is taken whole', () => {
		expect(pairs('"\\u{2714}"', 'swift')).toEqual([
			['"', 'string'],
			['\\u{2714}', 'escape'],
			['"', 'string'],
		]);
		// Unclosed, so the brace is not part of anything and the escape is two characters.
		expect(pairs('"\\u{2714"', 'swift')).toEqual([
			['"', 'string'],
			['\\u', 'escape'],
			['{2714"', 'string'],
		]);
	});

	test('literals and comment kinds', () => {
		const scopes = (code: string, text: string): CodeScope | undefined =>
			pairs(code, 'swift').find((pair) => pair[0] === text)?.[1];
		expect(scopes('if ready == true { return nil }', 'true')).toBe('boolean');
		expect(scopes('if ready == false { return nil }', 'false')).toBe('boolean');
		expect(scopes('if ready == true { return nil }', 'nil')).toBe('constant');
		expect(scopes('/// A doc line.', '/// A doc line.')).toBe('doc');
		expect(scopes('/** A doc block. */', '/** A doc block. */')).toBe('doc');
		expect(scopes('/* plain */', '/* plain */')).toBe('comment');
	});

	test('a nested block comment ends where the outer one does', () => {
		expect(pairs('/* outer /* inner */ still outer */ let a = 1', 'swift')[0]).toEqual([
			'/* outer /* inner */ still outer */',
			'comment',
		]);
	});

	test('an unterminated string stops at the end of its line', () => {
		const lines = highlight('let a = "open\nlet b = 1', 'swift').lines;
		expect(lines).toHaveLength(2);
		expect(lines[0]?.tokens.at(-1)).toEqual({ text: '"open', scope: 'string' });
		expect(lines[1]?.tokens[0]).toEqual({ text: 'let', scope: 'keyword' });
	});

	test('a multi-line string crosses lines and a triple quote closes it', () => {
		const result = highlight('let body = """\nplain\n"""', 'swift');
		expect(result.lines).toHaveLength(3);
		expect(result.lines[1]?.tokens).toEqual([{ text: 'plain', scope: 'string' }]);
	});

	test('numbers in every radix the language writes', () => {
		const numbers = (code: string): string[] =>
			pairs(code, 'swift')
				.filter((pair) => pair[1] === 'number')
				.map((pair) => pair[0]);
		expect(numbers('[0xFF, 0b1010, 0o755, 1_000, 1.5, 2e10, 1e-3, 0]')).toEqual([
			'0xFF',
			'0b1010',
			'0o755',
			'1_000',
			'1.5',
			'2e10',
			'1e-3',
			'0',
		]);
		// A prefix with nothing valid after it is a zero and then an identifier, which is
		// what the compiler would say too.
		expect(numbers('0xZZ')).toEqual(['0']);
		expect(numbers('12e')).toEqual(['12']);
	});
});

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

describe('the JSON lexer', () => {
	test('a key is a string followed by a colon', () => {
		expect(pairs('{"v": 2}', 'json')).toEqual([
			['{', 'punctuation'],
			['"v"', 'property'],
			[':', 'punctuation'],
			[' ', undefined],
			['2', 'number'],
			['}', 'punctuation'],
		]);
	});

	test('a value that is a string is not a key', () => {
		expect(pairs('{"kind": "route"}', 'json')).toEqual([
			['{', 'punctuation'],
			['"kind"', 'property'],
			[':', 'punctuation'],
			[' ', undefined],
			['"route"', 'string'],
			['}', 'punctuation'],
		]);
	});

	test('the colon may be on the next line', () => {
		expect(pairs('{"key"\n: 1}', 'json')[1]).toEqual(['"key"', 'property']);
	});

	test('literals', () => {
		expect(pairs('[true, false, null]', 'json')).toEqual([
			['[', 'punctuation'],
			['true', 'boolean'],
			[',', 'punctuation'],
			[' ', undefined],
			['false', 'boolean'],
			[',', 'punctuation'],
			[' ', undefined],
			['null', 'constant'],
			[']', 'punctuation'],
		]);
	});

	test('numbers, including the ones with a sign and an exponent', () => {
		const numbers = pairs('[0, -2.5, 3e4, 1E+2]', 'json')
			.filter((pair) => pair[1] === 'number')
			.map((pair) => pair[0]);
		expect(numbers).toEqual(['0', '-2.5', '3e4', '1E+2']);
	});

	test('a minus with no digits after it is not a number', () => {
		expect(pairs('[-]', 'json')).toEqual([
			['[', 'punctuation'],
			['-', undefined],
			[']', 'punctuation'],
		]);
	});

	test('an escape inside a key keeps its own scope', () => {
		expect(pairs('{"a\\tb": 1}', 'json')).toEqual([
			['{', 'punctuation'],
			['"a', 'property'],
			['\\t', 'escape'],
			['b"', 'property'],
			[':', 'punctuation'],
			[' ', undefined],
			['1', 'number'],
			['}', 'punctuation'],
		]);
	});

	test('a four digit unicode escape is taken whole and a short one is not', () => {
		expect(pairs('"\\u00e9"', 'json')).toEqual([
			['"', 'string'],
			['\\u00e9', 'escape'],
			['"', 'string'],
		]);
		expect(pairs('"\\u12"', 'json')).toEqual([
			['"', 'string'],
			['\\u', 'escape'],
			['12"', 'string'],
		]);
		expect(pairs('"\\uZZZZ"', 'json')).toEqual([
			['"', 'string'],
			['\\u', 'escape'],
			['ZZZZ"', 'string'],
		]);
	});

	test('what is not JSON stays unstyled rather than refused', () => {
		// The word and the spaces around it are all unstyled, so they arrive as one token:
		// merging is by scope, and an unrecognised word has no scope to keep it apart.
		expect(pairs('{ oops }', 'json')).toEqual([
			['{', 'punctuation'],
			[' oops ', undefined],
			['}', 'punctuation'],
		]);
		// An excerpt with an ellipsis in it still highlights, and the ellipsis survives as
		// itself. Refusing to colour a snippet because it would not parse would take the
		// highlighting away from the pages that most need it.
		const excerpt = highlight('{\n  "v": 2,\n  ...\n}', 'json');
		expect(excerpt.lines[2]?.tokens).toEqual([{ text: '  ...' }]);
		expect(rebuild(excerpt)).toBe('{\n  "v": 2,\n  ...\n}');
	});
});
