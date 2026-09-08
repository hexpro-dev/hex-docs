import { describe, expect, test } from 'vitest';

import { CALLOUT_KINDS, STATUS_VALUES } from '../../src/contracts/ast.js';
import { BANNED_CHARACTERS } from '../../src/contracts/lint.js';
import { SLUG_SEGMENT_PATTERN } from '../../src/contracts/slug.js';
import {
	CALLOUT_ALERT_PATTERN,
	CONTAINER_DIRECTIVE_NAMES,
	CONTAINER_DIRECTIVE_PATTERN,
	DIRECTIVE_CLOSE_PATTERN,
	EXPLICIT_HEADING_ID_PATTERN,
	FENCE_OPTIONS,
	LEAF_DIRECTIVE_PATTERN,
	RAW_HTML_PATTERN,
	RESERVED_MATH_PATTERN,
	SECTION_NUMBER_PATTERN,
	SNIPPET_ID_PATTERN,
	SNIPPET_INCLUDE_NAME,
	STATUS_GLYPHS,
	calloutKindOf,
	isContainerDirective,
	parseFenceInfo,
	parseHighlightLines,
	sectionNumberAnchor,
	statusAt,
	statusGlyphText,
	statusOf,
} from '../../src/contracts/source.js';

/*
 * Every glyph in this file is written as an escape, never as the character. The house
 * lint scans this repository's own source for exactly these code points, and a literal
 * would flag the test that pins the rule. See BANNED_CHARACTERS in lint.ts for the same
 * trick from the other side.
 */
const TICK = '\u2705';
const WARN = '\u26a0\ufe0f';
const BARE_WARN = '\u26a0';
const CROSS = '\u274c';
const EM_DASH = '\u2014';

describe('status glyphs', () => {
	test('every declared spelling renders to the character it claims', () => {
		expect(STATUS_GLYPHS.map(statusGlyphText)).toEqual([TICK, WARN, BARE_WARN, CROSS, EM_DASH]);
	});

	test('every status value the AST declares has at least one spelling', () => {
		const covered = new Set(STATUS_GLYPHS.map((spelling) => spelling.value));
		expect([...STATUS_VALUES].filter((value) => !covered.has(value))).toEqual([]);
	});

	test('three of the four spellings are characters this repository bans outright', () => {
		// This overlap is the entire reason the module exists. If it ever became empty,
		// a status glyph would be an ordinary character, the compiler would not need to
		// recognise it before the prose rules run, and `no-decorative-unicode` would be
		// free of the exception it cannot express. Naming the overlap here is what makes
		// a future change to either list visible in this suite rather than in a report.
		const banned = new Set(BANNED_CHARACTERS.map((entry) => String.fromCodePoint(entry.codePoint)));
		const overlap = STATUS_GLYPHS.map(statusGlyphText).filter((glyph) =>
			banned.has(String.fromCodePoint(glyph.codePointAt(0) as number)),
		);
		expect(overlap).toEqual([TICK, CROSS, EM_DASH]);
	});

	test('an inline-scoped glyph is recognised in a cell and outside one', () => {
		expect(statusOf(TICK, 'inline')).toBe('yes');
		expect(statusOf(TICK, 'cell')).toBe('yes');
		expect(statusOf(CROSS, 'inline')).toBe('no');
	});

	test('the em dash means "not applicable" only as a whole cell', () => {
		// The loophole this closes: recognising it anywhere would hand every author a
		// one-character way to write an em dash that no prose rule can see, in a package
		// whose own house rules ban the character outright.
		expect(statusOf(EM_DASH, 'cell')).toBe('na');
		expect(statusOf(EM_DASH, 'inline')).toBeUndefined();
	});

	test('surrounding whitespace does not stop a cell being a status', () => {
		expect(statusOf(`  ${TICK} `, 'cell')).toBe('yes');
	});

	test('a glyph with anything else beside it is text, not a status', () => {
		expect(statusOf(`${TICK} yes`, 'cell')).toBeUndefined();
		expect(statusOf('', 'cell')).toBeUndefined();
	});

	test('both spellings of the warning sign mean the same thing', () => {
		expect(statusOf(WARN, 'cell')).toBe('partial');
		expect(statusOf(BARE_WARN, 'cell')).toBe('partial');
	});
});

describe('scanning for a status glyph', () => {
	test('a glyph is found where it starts, and reports what it consumed', () => {
		const found = statusAt(`A ${WARN} in the Write column`, 2, 'inline');
		expect(found?.value).toBe('partial');
		expect(found?.name).toBe('warning sign');
	});

	test('the emoji-presentation pair consumes both code points', () => {
		// This is what the longest-first ordering buys, and the only assertion that
		// notices when it goes. Matched bare-first, the pair reports a length of 1 and
		// the variation selector is left behind as a one-character text node beside the
		// status, which is how a matrix cell renders an invisible artefact. Reversing the
		// comparator in `source.ts` fails exactly this line.
		expect(statusAt(WARN, 0, 'inline')?.length).toBe(2);
		expect(statusAt(BARE_WARN, 0, 'inline')?.length).toBe(1);
		expect(statusAt(`${WARN} and more`, 0, 'inline')?.length).toBe(2);
	});

	test('nothing is found where nothing starts', () => {
		expect(statusAt(`A ${WARN} here`, 0, 'inline')).toBeUndefined();
		expect(statusAt('plain text', 0, 'cell')).toBeUndefined();
	});

	test('a cell-scoped glyph is found only as the whole of what it was handed', () => {
		// The loophole this closes: recognising the em dash mid-cell would hand every
		// author a one-character way to write an em dash that no prose rule can see.
		expect(statusAt(EM_DASH, 0, 'cell')?.value).toBe('na');
		expect(statusAt(`${EM_DASH} not applicable`, 0, 'cell')).toBeUndefined();
		expect(statusAt(`x ${EM_DASH}`, 2, 'cell')).toBeUndefined();
		expect(statusAt(EM_DASH, 0, 'inline')).toBeUndefined();
	});

	test('statusOf and statusAt cannot disagree about a spelling', () => {
		for (const spelling of STATUS_GLYPHS) {
			const glyph = statusGlyphText(spelling);
			expect(statusOf(glyph, 'cell'), glyph).toBe(statusAt(glyph, 0, 'cell')?.value);
		}
	});
});

describe('snippets', () => {
	test('a snippet id is one slug segment, so it is safe as a filename', () => {
		expect(SNIPPET_ID_PATTERN).toBe(SLUG_SEGMENT_PATTERN);
		expect(SNIPPET_ID_PATTERN.test('safety-note')).toBe(true);
		expect(SNIPPET_ID_PATTERN.test('safety/note')).toBe(false);
		expect(SNIPPET_ID_PATTERN.test('Safety')).toBe(false);
	});

	test('transclusion is the only leaf directive', () => {
		const match = LEAF_DIRECTIVE_PATTERN.exec('::include[safety-note]');
		expect(match?.[1]).toBe(SNIPPET_INCLUDE_NAME);
		expect(match?.[2]).toBe('safety-note');
	});

	test('a leaf directive must be alone on its line', () => {
		expect(LEAF_DIRECTIVE_PATTERN.test('text ::include[safety-note]')).toBe(false);
		expect(LEAF_DIRECTIVE_PATTERN.test('::include[safety-note] text')).toBe(false);
	});

	test('a three-colon include is not a leaf directive, so a typo fails loudly', () => {
		expect(LEAF_DIRECTIVE_PATTERN.test(':::include[safety-note]')).toBe(false);
	});
});

describe('headings', () => {
	test('an explicit id is read off the end of the heading text', () => {
		expect(EXPLICIT_HEADING_ID_PATTERN.exec('Module graph {#module-graph}')?.[1]).toBe(
			'module-graph',
		);
	});

	test('an id anywhere but the end is not an explicit id', () => {
		expect(EXPLICIT_HEADING_ID_PATTERN.test('{#module-graph} Module graph')).toBe(false);
	});

	test('a section number becomes an anchor that is identical in every language', () => {
		expect(SECTION_NUMBER_PATTERN.exec('4. Termination')?.[1]).toBe('4');
		expect(SECTION_NUMBER_PATTERN.exec('4.2 Refunds')?.[1]).toBe('4.2');
		expect(sectionNumberAnchor('4')).toBe('section-4');
		expect(sectionNumberAnchor('4.2')).toBe('section-4-2');
	});

	test('a heading that is only a number is not a numbered section', () => {
		// It would get an anchor and an empty table of contents entry, which is worse
		// than leaving the digits as heading text.
		expect(SECTION_NUMBER_PATTERN.test('4.')).toBe(false);
		expect(SECTION_NUMBER_PATTERN.test('4. ')).toBe(false);
	});

	test('a version number in a heading is not a section number', () => {
		expect(SECTION_NUMBER_PATTERN.test('Release notes for 1.2.0')).toBe(false);
	});
});

describe('directives', () => {
	test('a container opens with a name and closes with the same colon count', () => {
		const open = CONTAINER_DIRECTIVE_PATTERN.exec(':::warning[Read this first]');
		expect(open?.[1]).toBe(':::');
		expect(open?.[2]).toBe('warning');
		expect(open?.[3]).toBe('Read this first');
		expect(DIRECTIVE_CLOSE_PATTERN.exec(':::')?.[1]).toBe(':::');
	});

	test('a bare space-separated argument is not the grammar, and is refused', () => {
		// remark-directive has no bare-argument container form: to it, `:::note Background`
		// is a paragraph. The pattern accepted it for a while, with a comment claiming the
		// grammar was borrowed rather than invented, so every titled container in the
		// corpus would have compiled to nothing under the extension being cited.
		expect(CONTAINER_DIRECTIVE_PATTERN.test(':::note Background scanning')).toBe(false);
		expect(CONTAINER_DIRECTIVE_PATTERN.exec(':::note[Background scanning]')?.[3]).toBe(
			'Background scanning',
		);
	});

	test('the label is optional, and absent means the default label', () => {
		const open = CONTAINER_DIRECTIVE_PATTERN.exec(':::tip');
		expect(open?.[2]).toBe('tip');
		expect(open?.[3]).toBeUndefined();
	});

	test('nesting adds a colon to the outer marker, which is what makes the close unambiguous', () => {
		expect(CONTAINER_DIRECTIVE_PATTERN.exec('::::steps')?.[1]).toBe('::::');
		expect(CONTAINER_DIRECTIVE_PATTERN.exec(':::step[Open the Scan sheet]')?.[1]).toBe(':::');
		expect(DIRECTIVE_CLOSE_PATTERN.exec('::::')?.[1]).toBe('::::');
	});

	test('a close is not an open, and an open is not a close', () => {
		expect(CONTAINER_DIRECTIVE_PATTERN.test(':::')).toBe(false);
		expect(DIRECTIVE_CLOSE_PATTERN.test(':::warning')).toBe(false);
	});

	test('every callout kind is a container name, so a kind cannot be added and go unparsed', () => {
		for (const kind of CALLOUT_KINDS) expect(isContainerDirective(kind)).toBe(true);
		expect(CONTAINER_DIRECTIVE_NAMES).toContain('steps');
		expect(CONTAINER_DIRECTIVE_NAMES).toContain('step');
		expect(CONTAINER_DIRECTIVE_NAMES).toContain('figure');
		expect(CONTAINER_DIRECTIVE_NAMES).toContain('table');
	});

	test('an unknown container name is refused rather than dropped', () => {
		expect(isContainerDirective('aside')).toBe(false);
		expect(isContainerDirective('include')).toBe(false);
	});

	test("GitHub's alert form is recognised for every kind, in upper case only", () => {
		for (const kind of CALLOUT_KINDS) {
			expect(CALLOUT_ALERT_PATTERN.test(`[!${kind.toUpperCase()}]`)).toBe(true);
		}
		expect(CALLOUT_ALERT_PATTERN.test('[!warning]')).toBe(false);
		expect(CALLOUT_ALERT_PATTERN.test('[!ADVICE]')).toBe(false);
	});

	test('both spellings resolve to the same kind', () => {
		expect(calloutKindOf('WARNING')).toBe('warning');
		expect(calloutKindOf('warning')).toBe('warning');
		expect(calloutKindOf('steps')).toBeUndefined();
	});
});

describe('code fences', () => {
	test('an unlabelled fence has no language, which is different from an unknown one', () => {
		expect(parseFenceInfo('')).toEqual({ options: {}, problems: [] });
		expect(parseFenceInfo('   ')).toEqual({ options: {}, problems: [] });
	});

	test('a bare language carries no options', () => {
		expect(parseFenceInfo('swift')).toEqual({ lang: 'swift', options: {}, problems: [] });
	});

	test('the full option set parses', () => {
		expect(
			parseFenceInfo('swift title="TagSession.swift" lineNumbers start=12 highlight="2,5-7"'),
		).toEqual({
			lang: 'swift',
			options: {
				title: 'TagSession.swift',
				lineNumbers: true,
				start: '12',
				highlight: '2,5-7',
			},
			problems: [],
		});
	});

	test('a quoted value may contain spaces, which a filename usually does not and sometimes does', () => {
		expect(parseFenceInfo('text title="Scan sheet output.txt"').options.title).toBe(
			'Scan sheet output.txt',
		);
	});

	test('an unknown option is reported rather than ignored', () => {
		// Ignoring it is the failure that sends the author to the renderer: a misspelled
		// `linenumbers` would silently do nothing and look exactly like a bug in this
		// package.
		const parsed = parseFenceInfo('swift linenumbers copyable');
		expect(parsed.problems).toHaveLength(2);
		expect(parsed.problems[0]).toContain('"linenumbers" is not an option');
		expect(parsed.options).toEqual({});
	});

	test('text no option match consumes is residue, and residue is reported', () => {
		// The hole this closes. Scanned with a global regex, anything that did not look
		// like an option name was skipped over: it was not consumed, not reported and
		// absent from every field of the result, so a fence written in another
		// toolchain's spelling parsed as a fence with no options at all.
		const parsed = parseFenceInfo('swift 2,5-7 {highlight: [2]}');
		expect(parsed.options).toEqual({});
		expect(parsed.problems.some((problem) => problem.includes('"2,5-7"'))).toBe(true);
		expect(parsed.problems.some((problem) => problem.includes('{highlight:'))).toBe(true);
	});

	test('a value option written as a flag is refused, naming it', () => {
		const parsed = parseFenceInfo('swift title');
		expect(parsed.options.title).toBeUndefined();
		expect(parsed.problems[0]).toContain('"title" needs a value');
	});

	test('a flag written with a value is refused, naming it', () => {
		// `wrap=false` reads as "do not wrap" and would have set wrap to the string
		// "false", which is truthy, so the fence would have wrapped.
		const parsed = parseFenceInfo('swift wrap=false');
		expect(parsed.options.wrap).toBeUndefined();
		expect(parsed.problems[0]).toContain('is a flag and takes no value');
	});

	test('a hyphenated near-miss does not silently set the option it resembles', () => {
		const parsed = parseFenceInfo('swift no-wrap');
		expect(parsed.options).toEqual({});
		expect(parsed.problems).not.toHaveLength(0);
	});

	test('every option name maps to a field on the code node and states its arity', () => {
		expect(Object.keys(FENCE_OPTIONS).sort()).toEqual([
			'highlight',
			'lineNumbers',
			'start',
			'title',
			'wrap',
		]);
		for (const [name, spec] of Object.entries(FENCE_OPTIONS)) {
			expect(['flag', 'value'], name).toContain(spec.arity);
			expect(spec.field.length, name).toBeGreaterThan(3);
		}
	});

	test('the parser is reusable, so a second fence sees the same options as the first', () => {
		const first = parseFenceInfo('swift title="A.swift" wrap');
		const second = parseFenceInfo('swift title="A.swift" wrap');
		expect(second).toEqual(first);
	});

	test('highlight lines expand, sort and deduplicate', () => {
		expect(parseHighlightLines('2,5-7')).toEqual([2, 5, 6, 7]);
		expect(parseHighlightLines('7,2,2')).toEqual([2, 7]);
		expect(parseHighlightLines(' 3 ')).toEqual([3]);
	});

	test('a reversed or zero range is a mistake rather than something to fix silently', () => {
		expect(parseHighlightLines('7-5')).toBeUndefined();
		expect(parseHighlightLines('0-2')).toBeUndefined();
		expect(parseHighlightLines('two')).toBeUndefined();
		expect(parseHighlightLines('')).toBeUndefined();
	});
});

describe('what the compiler refuses', () => {
	test('the reserved math delimiter is recognised so it can be refused', () => {
		expect(RESERVED_MATH_PATTERN.test('$$x^2$$')).toBe(true);
		// The two live false positives in already-published copy, neither of which is
		// maths and both of which must keep compiling.
		expect(RESERVED_MATH_PATTERN.test('A$9.99 per month or A$6.99')).toBe(false);
		expect(RESERVED_MATH_PATTERN.test('$0.createdAt > $1')).toBe(false);
	});

	test('a raw HTML tag is recognised', () => {
		expect(RAW_HTML_PATTERN.test('<div class="x">')).toBe(true);
		expect(RAW_HTML_PATTERN.test('</span>')).toBe(true);
		expect(RAW_HTML_PATTERN.test('<br />')).toBe(true);
	});

	test('a suppression comment is not raw HTML, because that is how suppressions are written', () => {
		expect(
			RAW_HTML_PATTERN.test('<!-- hexdocs-disable-next-line no-em-dash: quoting a filename -->'),
		).toBe(false);
	});

	test('prose that merely contains angle brackets is not raw HTML', () => {
		expect(RAW_HTML_PATTERN.test('a < b and b > c')).toBe(false);
		expect(RAW_HTML_PATTERN.test('the 1 < 2 case')).toBe(false);
	});
});
