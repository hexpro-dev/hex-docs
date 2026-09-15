/**
 * The generated stylesheet.
 *
 * Everything here is a property of the text, and none of it is a property a browser can
 * tell you about, which is the division of labour: this file says the CSS is written the
 * way the contract requires, and `scripts/check-paint.mjs` says a browser agrees about
 * what it paints.
 *
 * The most valuable assertion is the one that looks least interesting. "Zero colour
 * literals outside a token chain" is what makes a hard-coded `#f2ede6` a failure, and it
 * only means anything because the generator has no way to produce one: `t()` expands a
 * name through `tokenValue` and throws on a name the tables do not carry, so the defect is
 * unwriteable rather than merely detectable.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { CALLOUT_KINDS, CODE_SCOPES, STATUS_VALUES } from '../../../src/contracts/ast.js';
import {
	PALETTE,
	PALETTE_NAMES,
	SCOPE_COLOUR,
	paletteValue,
	scopeClass,
} from '../../../src/contracts/palette.js';
import { THEME_TOKENS, tokenName, tokenValue } from '../../../src/contracts/theme.js';
import { STYLESHEET_PATH, emitStylesheet, t } from '../../src/theme/stylesheet.js';
import { emitAll, emitStylesheetFile } from '../../src/contracts/emit-json-schemas.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CSS = emitStylesheet();

describe('the checked-in file', () => {
	test('is byte for byte what the generator produces', () => {
		// The same gate the JSON Schemas and the house rule pack have, and it is tested here
		// rather than only asserted by a `git diff` in CI, because a CI-only gate is a gate
		// with no failure path anybody has ever driven.
		expect(readFileSync(join(ROOT, STYLESHEET_PATH), 'utf8')).toBe(CSS);
	});

	test('says it is generated, in the first thing a person opening it reads', () => {
		expect(CSS.startsWith('/*\n * GENERATED FILE. Do not edit.')).toBe(true);
	});
});

describe('the generator refuses to name a value the contract does not declare', () => {
	test('an unknown name is an error rather than an empty rule', () => {
		// The guarantee the rest of this file rests on, driven. A hard-coded colour is not
		// detected here, it is unwriteable: the only thing in the generator that can produce
		// a colour is this function, and it has nothing to return for a name the tables do
		// not carry.
		expect(() => t('accent-lite')).toThrow(/No theme token or palette colour named/);
		expect(() => t('')).toThrow();
	});

	test('a real name from either table resolves to the contract own chain', () => {
		expect(t('ink')).toBe(tokenValue(THEME_TOKENS.find((token) => token.name === 'ink') as never));
		expect(t('code-key')).toBe(
			paletteValue(PALETTE.find((colour) => colour.name === 'code-key') as never),
		);
	});
});

describe('every value is read at its point of use', () => {
	test('every var() reference is a complete chain the contract generated', () => {
		// The whole theme contract in one assertion. A chain written by hand, or shortened
		// because it was long, resolves against a different thing than the table says and
		// nothing else in the repository would notice.
		const chains = new Set([...THEME_TOKENS.map(tokenValue), ...PALETTE.map(paletteValue)]);
		const references = [...CSS.matchAll(/var\(--hx-[^;\n]*/g)].map((match) => match[0]);
		expect(references.length).toBeGreaterThan(80);
		for (const reference of references) {
			const chain = [...chains].find((candidate) => reference.startsWith(candidate));
			expect({ reference, matched: chain !== undefined }).toEqual({ reference, matched: true });
		}
	});

	test('no --hx- name is ever declared, which is the bug that shipped once', () => {
		// A custom property is substituted where it is declared, so an alias at `:root` or
		// on the docs root resolves once and a rebinding below it can never take effect.
		// Measured this session: moving the alias from `:root` to the docs root fixes the
		// case the prescribed browser check exercises and leaves the two it does not.
		expect(CSS).not.toMatch(/--hx-[a-z0-9-]+\s*:/);
	});

	test('the sweep can see a declaration, so the absence means something', () => {
		expect(`${CSS}\n:root { --hx-ink: red; }`).toMatch(/--hx-[a-z0-9-]+\s*:/);
	});

	test('no colour literal appears outside a chain', () => {
		// Stripping the chains first and then looking for a hex value is what makes this
		// different from "the tokens are used somewhere": a rule that hard-codes `#f2ede6`
		// while four other rules still read `ink` through the chain passes every other
		// assertion in this file.
		let stripped = CSS;
		for (const chain of [...THEME_TOKENS.map(tokenValue), ...PALETTE.map(paletteValue)]) {
			stripped = stripped.split(chain).join('');
		}
		// The comment block names colours as prose, so it is removed before the scan.
		stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, '');
		expect(stripped.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
	});
});

describe('every declared value is used, and every used value is declared', () => {
	test('every theme token appears in the stylesheet', () => {
		const unused = THEME_TOKENS.filter((token) => !CSS.includes(tokenName(token)));
		expect(unused.map((token) => token.name)).toEqual([]);
	});

	test('every palette colour appears in the stylesheet', () => {
		const unused = PALETTE_NAMES.filter((name) => !CSS.includes(`--hx-${name}`));
		expect(unused).toEqual([]);
	});

	test('every name the stylesheet reads is one of the two tables', () => {
		const declared = new Set([...THEME_TOKENS.map((token) => token.name), ...PALETTE_NAMES]);
		const used = new Set(
			[...CSS.matchAll(/var\(--hx-([a-z0-9-]+)/g)].map((match) => match[1] as string),
		);
		expect([...used].filter((name) => !declared.has(name))).toEqual([]);
		expect(used.size).toBe(declared.size);
	});

	test('every code scope, callout kind and status value has a rule', () => {
		for (const scope of CODE_SCOPES) expect(CSS).toContain(`.${scopeClass(scope)}`);
		for (const kind of CALLOUT_KINDS) expect(CSS).toContain(`[data-callout='${kind}']`);
		for (const value of STATUS_VALUES) expect(CSS).toContain(`[data-status='${value}']`);
		expect(Object.keys(SCOPE_COLOUR).length).toBe(CODE_SCOPES.length);
	});
});

/**
 * The house rule "no physical properties", as a scan over declarations.
 *
 * It used to be one regular expression over the text, which knew a side in a margin,
 * padding, border or inset name, `text-align`, and a bare offset property. Two defects went
 * through it in the same stylesheet. The current tree link, the current table of contents
 * link and the selected search result drew their bar with `box-shadow: inset 2px 0 0`, a
 * physical offset that stays on the left in Arabic, and nothing in the pattern could see a
 * shadow. The partial status mark used `linear-gradient(to inline-end, ...)`, which no engine
 * parses, so it was dropped rather than wrong in one direction; that one is caught in the
 * browser by the `declarations` probe in `scripts/check-paint.mjs`, not here.
 */

/**
 * One declaration, with the one selector and the at-rule context it applies under, and its
 * ordinal in the stylesheet.
 *
 * A rule with a selector list contributes one entry per selector, because a mirror has to
 * exist for each of them: `.a, .b` mirrored by `.a:dir(rtl)` alone leaves `.b` wrong in
 * Arabic. `at` is shared by those entries, so counting distinct values counts declarations.
 */
interface Declaration {
	at: number;
	context: string;
	selector: string;
	property: string;
	value: string;
}

/** Splits on a separator character outside every pair of parentheses and brackets. */
function splitTopLevel(text: string, separator: RegExp): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const char of text) {
		if (char === '(' || char === '[') depth += 1;
		if (char === ')' || char === ']') depth -= 1;
		if (depth === 0 && separator.test(char)) {
			if (current.trim() !== '') parts.push(current.trim());
			current = '';
		} else current += char;
	}
	if (current.trim() !== '') parts.push(current.trim());
	return parts;
}

/**
 * Every declaration in a stylesheet. Strings are not special-cased, because the generator
 * writes none containing a brace or a semicolon; `the physical-property scan reads every
 * declaration` below is what would notice one that did.
 */
function declarationsOf(css: string): Declaration[] {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const found: Declaration[] = [];
	const preludes: string[] = [];
	let buffer = '';
	let depth = 0;
	let at = 0;
	for (const char of text) {
		if (char === '(') depth += 1;
		if (char === ')') depth -= 1;
		if (depth === 0 && char === '{') {
			preludes.push(buffer.trim().replace(/\s+/g, ' '));
			buffer = '';
		} else if (depth === 0 && (char === ';' || char === '}')) {
			const declaration = buffer.trim();
			const colon = declaration.indexOf(':');
			const prelude = preludes[preludes.length - 1];
			if (colon > 0 && prelude !== undefined && !prelude.startsWith('@')) {
				at += 1;
				const context = preludes.filter((entry) => entry.startsWith('@')).join(' ');
				for (const selector of splitTopLevel(prelude, /,/)) {
					found.push({
						at,
						context,
						selector,
						property: declaration.slice(0, colon).trim(),
						value: declaration.slice(colon + 1).trim(),
					});
				}
			}
			buffer = '';
			if (char === '}') preludes.pop();
		} else buffer += char;
	}
	return found;
}

const SIDE_IN_NAME = /(?:^|-)(?:left|right|top|bottom)(?:-|$)/;
const SIDE_KEYWORD = /(?<![\w-])(?:left|right)(?![\w-])/g;
const LENGTH = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[a-z]+|%)?$/i;
const MATH = /^(?:calc|min|max|clamp)\(/i;
const ZERO = /^[+-]?(?:0+\.?0*|\.0+)(?:[a-z]+|%)?$/i;
const GRADIENT_ANGLE =
	/(?<![\w-])((?:repeating-)?linear-gradient\(\s*)([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)/gi;
const TRANSLATE = /(?<![\w-])(translate(?:X|3d)?\(\s*)([^,)\s]+)/gi;
const BOX_SHORTHANDS = new Set([
	'margin',
	'padding',
	'inset',
	'border-width',
	'border-style',
	'border-color',
	'scroll-margin',
	'scroll-padding',
]);
const PER_TURN: Record<string, number> = { deg: 360, grad: 400, rad: 2 * Math.PI, turn: 1 };

const tokensOf = (value: string): string[] => splitTopLevel(value, /\s/);
const isOffset = (token: string): boolean => LENGTH.test(token) || MATH.test(token);
const turnsOf = (number: string, unit: string): number =>
	(((Number(number) / (PER_TURN[unit.toLowerCase()] ?? 1)) % 1) + 1) % 1;
const negate = (token: string): string =>
	ZERO.test(token)
		? token
		: MATH.test(token)
			? `calc(-1 * ${token})`
			: token.startsWith('-')
				? token.slice(1)
				: `-${token.replace(/^\+/, '')}`;

/**
 * The physical forms one declaration writes, in two kinds.
 *
 * `fixed` has a logical spelling and is never exempt: a side in a property name, a
 * four-value box shorthand whose right and left differ, and a border radius whose corners
 * differ across the inline axis. Its mirror would be a different property or a different
 * token order rather than a different value, and the logical longhand is simpler than either.
 *
 * `mirrorable` has no logical spelling that works everywhere, and is exempt when the same
 * selector with `:dir(rtl)` declares the mirrored value: a `left` or `right` keyword (a float,
 * a clear, a text alignment, a gradient direction, a background or transform origin
 * position), a linear-gradient angle with a horizontal component, a shadow with a non-zero
 * horizontal offset, and a horizontal translation.
 *
 * What it does not read, so nobody trusts it for these: a horizontal position written as a
 * percentage or a length, a conic gradient's angle, and a shadow offset held in a `var()`,
 * which cannot be told from a colour without resolving it. Axis properties such as
 * `overflow-x` and `translateY` are out of scope rather than missed: they do not change with
 * direction, only with a vertical writing mode, which none of the seven languages uses.
 */
function physicalForms(property: string, value: string): { fixed: string[]; mirrorable: string[] } {
	const fixed: string[] = [];
	const mirrorable: string[] = [];
	if (property.startsWith('--')) return { fixed, mirrorable };
	const bare = value
		.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "''")
		.replace(/url\([^)]*\)/gi, 'url()');
	const tokens = tokensOf(bare);
	if (SIDE_IN_NAME.test(property)) fixed.push('a side in the property name');
	if (BOX_SHORTHANDS.has(property) && tokens.length === 4 && tokens[1] !== tokens[3]) {
		fixed.push('a box shorthand whose right and left values differ');
	}
	if (property === 'border-radius') {
		for (const axis of splitTopLevel(bare, /\//)) {
			const [start, end = start, lower = start, lowerEnd = end] = tokensOf(axis);
			if (start !== end || lower !== lowerEnd) {
				fixed.push('a border radius whose corners differ across the inline axis');
			}
		}
	}
	if ([...bare.matchAll(SIDE_KEYWORD)].length > 0) mirrorable.push('a left or right keyword');
	for (const [, , number = '0', unit = 'deg'] of bare.matchAll(GRADIENT_ANGLE)) {
		const half = (turnsOf(number, unit) * 2) % 1;
		if (half > 1e-9 && half < 1 - 1e-9) {
			mirrorable.push('a gradient angle with a horizontal component');
		}
	}
	if (property === 'box-shadow' || property === 'text-shadow') {
		for (const layer of splitTopLevel(bare, /,/)) {
			const offset = tokensOf(layer).find(isOffset);
			if (offset !== undefined && !ZERO.test(offset)) {
				mirrorable.push('a shadow with a horizontal offset');
			}
		}
	}
	for (const [, , x = '0'] of bare.matchAll(TRANSLATE)) {
		if (!ZERO.test(x)) mirrorable.push('a horizontal translation');
	}
	if (property === 'translate' && tokens[0] !== undefined && !ZERO.test(tokens[0])) {
		mirrorable.push('a horizontal translation');
	}
	return { fixed, mirrorable };
}

/** The value a right-to-left counterpart has to declare for this declaration's mirrorable forms. */
function mirrorOf(property: string, value: string): string {
	let result = value
		.replace(SIDE_KEYWORD, (side) => (side === 'left' ? 'right' : 'left'))
		.replace(
			GRADIENT_ANGLE,
			(_, head: string, number: string, unit: string) => `${head}${-Number(number)}${unit}`,
		)
		.replace(TRANSLATE, (_, head: string, x: string) => `${head}${negate(x)}`);
	if (property === 'box-shadow' || property === 'text-shadow') {
		result = splitTopLevel(result, /,/)
			.map((layer) => {
				const tokens = tokensOf(layer);
				const offset = tokens.findIndex(isOffset);
				if (offset !== -1) tokens[offset] = negate(tokens[offset] as string);
				return tokens.join(' ');
			})
			.join(', ');
	}
	if (property === 'translate') {
		const tokens = tokensOf(result);
		if (tokens[0] !== undefined) tokens[0] = negate(tokens[0]);
		result = tokens.join(' ');
	}
	return result;
}

/** Spacing normalised, and a gradient angle as a fraction of a turn, so `-90deg` and `270deg` agree. */
const canonical = (value: string): string =>
	value
		.replace(
			GRADIENT_ANGLE,
			(_, head: string, number: string, unit: string) =>
				`${head}${turnsOf(number, unit).toFixed(6)}turn`,
		)
		.replace(/\s+/g, ' ')
		.replace(/\s*([(),])\s*/g, '$1')
		.trim();

const PSEUDO_ELEMENT = /::[\w-]+(?:\([^)]*\))?$/;
const RTL = ':dir(rtl)';

/**
 * The selector's counterpart: `:dir(rtl)` added to its subject, or taken off it.
 *
 * On the subject and nowhere else. `.hx-root:dir(rtl) .hx-status-half` is not a counterpart
 * of `.hx-root .hx-status-half`, because it reads the direction of the docs root, and an
 * Arabic page serving the English fallback has a left-to-right article inside that root.
 */
function counterpartOf(selector: string): string {
	const pseudo = PSEUDO_ELEMENT.exec(selector);
	const subject = pseudo === null ? selector : selector.slice(0, pseudo.index);
	const tail = pseudo === null ? '' : pseudo[0];
	return subject.endsWith(RTL)
		? `${subject.slice(0, -RTL.length)}${tail}`
		: `${subject}${RTL}${tail}`;
}

/**
 * Every physical form in a stylesheet that is not exempt, one line each.
 *
 * The exemption is checked, not assumed. The counterpart has to be the same selector with
 * `:dir(rtl)` on its subject, inside the same at-rule, declaring the same property, and its
 * value has to be the mirror of this one. A `:dir(rtl)` rule that repeats the value, mirrors
 * it under a different property, sits in a different media query or keys on an ancestor
 * exempts nothing. The pairing is looked up from both sides, so a right-to-left rule with no
 * left-to-right one is reported too. What it cannot know is which of the pair is the right
 * way round; `sides-ltr` and `sides-rtl` in the paint row measure that.
 */
function physicalIn(css: string): string[] {
	const declarations = declarationsOf(css);
	const key = (context: string, selector: string, property: string): string =>
		JSON.stringify([context, selector, property]);
	const values = new Map(
		declarations.map((entry) => [key(entry.context, entry.selector, entry.property), entry.value]),
	);
	const reported: string[] = [];
	for (const entry of declarations) {
		const { fixed, mirrorable } = physicalForms(entry.property, entry.value);
		if (fixed.length === 0 && mirrorable.length === 0) continue;
		const partner = values.get(key(entry.context, counterpartOf(entry.selector), entry.property));
		const mirrored =
			fixed.length === 0 &&
			partner !== undefined &&
			canonical(mirrorOf(entry.property, entry.value)) === canonical(partner);
		if (!mirrored) {
			reported.push(
				`${entry.selector} { ${entry.property}: ${entry.value} } has ${[...fixed, ...mirrorable].join(' and ')}`,
			);
		}
	}
	return reported;
}

describe('the rules a generator cannot enforce', () => {
	test('no physical property, anywhere, unless its right-to-left mirror is beside it', () => {
		// They look right in six languages and wrong in Arabic, and the build that shows it
		// is the one nobody runs.
		expect(physicalIn(CSS)).toEqual([]);
	});

	test('the physical-property scan reads every declaration', () => {
		// A scan that stopped at the first media query, or lost its place after a string,
		// would report nothing for the declarations it never reached. The generator ends
		// every declaration with a semicolon, so counting them is a second way to the same
		// number that shares no code with the walker.
		const semicolons = (
			CSS.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/'[^']*'/g, '')
				.replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '')
				.match(/;/g) ?? []
		).length;
		expect(semicolons).toBeGreaterThan(300);
		expect(new Set(declarationsOf(CSS).map((entry) => entry.at)).size).toBe(semicolons);
	});

	// Each control names the selectors it must report, not only that it reports something. A
	// scan that wrongly accepted `.r:dir(rtl) .x` as the counterpart of `.x` would still
	// report the ancestor rule itself, and a bare "not empty" would pass it.
	test.each<[string, string[]]>([
		['.x { margin-left: 1rem; }', ['.x']],
		['.x { text-align: left; }', ['.x']],
		['.x { right: 0; }', ['.x']],
		['.x { border-top-left-radius: 4px; }', ['.x']],
		['.x { margin: 0 1rem 0 2rem; }', ['.x']],
		['.x { border-radius: 4px 0 0 4px; }', ['.x']],
		['.x { box-shadow: inset 2px 0 0 red; }', ['.x']],
		['.x { box-shadow: 0 1px 2px black, -3px 0 0 var(--hx-accent, #0b76d9); }', ['.x']],
		['.x { text-shadow: 1px 1px 0 black; }', ['.x']],
		['.x { float: left; }', ['.x']],
		['.x { clear: right; }', ['.x']],
		['.x { background: linear-gradient(to right, red 50%, blue 50%); }', ['.x']],
		['.x { background-image: linear-gradient(90deg, red, blue); }', ['.x']],
		['.x { background-position: right 1rem center; }', ['.x']],
		['.x { transform-origin: left top; }', ['.x']],
		['.x { transform: translateX(-50%); }', ['.x']],
		['.x { transform: translate(4px, 0); }', ['.x']],
		['.x { translate: 4px 0; }', ['.x']],
		// A counterpart that repeats the value rather than mirroring it.
		[
			'.x { box-shadow: inset 2px 0 0 red; }\n.x:dir(rtl) { box-shadow: inset 2px 0 0 red; }',
			['.x', '.x:dir(rtl)'],
		],
		// A counterpart keyed on an ancestor, which reads the root's direction and not the element's.
		['.x { float: left; }\n.r:dir(rtl) .x { float: right; }', ['.x', '.r:dir(rtl) .x']],
		// A counterpart inside a media query the physical rule is not in.
		[
			'.x { float: left; }\n@media (min-width: 1px) { .x:dir(rtl) { float: right; } }',
			['.x', '.x:dir(rtl)'],
		],
		// One selector of a list mirrored and the other not.
		[
			'.x, .y { transform: translateX(1px); }\n.x:dir(rtl) { transform: translateX(-1px); }',
			['.y'],
		],
		// A right-to-left rule with nothing to mirror.
		['.x:dir(rtl) { box-shadow: inset -2px 0 0 red; }', ['.x:dir(rtl)']],
		// A logical spelling exists, so a mirror does not excuse it.
		['.x { margin-left: 1rem; }\n.x:dir(rtl) { margin-right: 1rem; }', ['.x', '.x:dir(rtl)']],
	])('the physical-property scan sees %s', (css, selectors) => {
		expect(physicalIn(css).map((line) => line.slice(0, line.indexOf(' { ')))).toEqual(selectors);
	});

	test.each([
		'.x { margin-inline-start: 1rem; inset-inline-end: 0; text-align: end; }',
		'.x { margin: 0 1rem 2rem; padding: 0.5rem 1rem; border-radius: 6px; }',
		'.x { box-shadow: inset 0 2px 0 red, 0 0 0 1px blue; }',
		'.x { transform: translateY(-0.5rem); }',
		'.x { background: linear-gradient(to bottom, red, blue), linear-gradient(180deg, red, blue); }',
		'.x { overflow-x: auto; }',
		".x { content: 'left'; }",
		'.x { box-shadow: inset 2px 0 0 var(--hx-accent, #0b76d9); }\n.x:dir(rtl) { box-shadow: inset -2px 0 0 var(--hx-accent, #0b76d9); }',
		'.x { background: linear-gradient(to right, transparent 50%, currentColor 50%); }\n.x:dir(rtl) { background: linear-gradient(to left, transparent 50%, currentColor 50%); }',
		'.x { background: linear-gradient(90deg, red, blue); }\n.x:dir(rtl) { background: linear-gradient(270deg, red, blue); }',
		'.x::before { transform: translateX(1px); }\n.x:dir(rtl)::before { transform: translateX(-1px); }',
		'@media (min-width: 1px) { .x { float: left; } .x:dir(rtl) { float: right; } }',
	])('the physical-property scan accepts %s', (css) => {
		expect(physicalIn(css)).toEqual([]);
	});

	test('no cascade layer', () => {
		// Measured against both consumers: hex-web declares no layer and has no bare-element
		// selectors, and kcalc has an `@layer base` that restyles `p` and `h4`. Any unlayered
		// rule beats every layered one, so a layered docs stylesheet would lose to kcalc's
		// base and win nothing anywhere.
		expect(CSS).not.toContain('@layer');
	});

	test('no rule selects on the reduced-motion attribute', () => {
		// The attribute is rendered `false` for the whole first paint and flips in an
		// effect, so a rule keyed off it is wrong for exactly the readers it is for. The
		// media query needs no JavaScript and is the gate.
		expect(CSS).not.toContain('[data-reduced');
		expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
	});

	test('every rule is scoped, so nothing leaks into the site around it', () => {
		// One exception, stated: the search dialog is a top-layer element, so it is not a
		// descendant of the docs root in the rendered tree and cannot be selected through it.
		const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
		const selectors = [...withoutComments.matchAll(/([^{}]+)\{/g)]
			.map((match) => (match[1] as string).trim())
			.filter((selector) => selector !== '' && !selector.startsWith('@'));
		expect(selectors.length).toBeGreaterThan(40);
		const unscoped = selectors.filter(
			(selector) =>
				!selector.split(',').every((part) => /^\s*\.hx-(root|search)\b/.test(part.trim())),
		);
		expect(unscoped).toEqual([]);
	});

	test('the isolation that keeps an identifier readable inside Arabic prose is present', () => {
		expect(CSS).toContain('unicode-bidi: isolate');
	});

	test('every scrollable rail and heading clears the sticky header', () => {
		// A heading, a step and, on a phone, the page tree the bar's Pages link jumps to. An
		// exact count, so a jump target that lost its margin is a failure rather than a smaller
		// number over a floor.
		expect([...CSS.matchAll(/scroll-margin-block-start/g)].length).toBe(3);
	});

	test('the tree and table of contents links meet the minimum target size', () => {
		expect(CSS).toContain('min-block-size: 24px');
	});
});

/**
 * The body of the one rule whose selector text is exactly `selector`.
 *
 * Exact and unique, so an assertion about a rule cannot be satisfied by a different rule
 * that happens to contain the same declaration.
 */
function rule(selector: string): string {
	const head = `\n${selector} {\n`;
	const parts = CSS.split(head);
	expect({ selector, rules: parts.length - 1 }).toEqual({ selector, rules: 1 });
	return (parts[1] as string).slice(0, (parts[1] as string).indexOf('\n}'));
}

describe('the layout a host cannot take away', () => {
	// What is asserted here is that each rule is present and says what it has to. What it
	// does in a page is `scripts/check-paint.mjs`, which renders it under a sticky header and
	// a preflight at two widths, and `test/paint.test.ts` deletes each of these rules in turn
	// and watches the probe for it fail.

	test('the skip link is clipped until focused, and nothing about hiding it rests on a transform', () => {
		// Moved above the docs root with a transform, it was off-screen only when the root
		// started at the top of the page, and in hex-web it sat on the site logo.
		const hidden = rule('.hx-root .hx-sr,\n.hx-root .hx-skip:not(:focus)');
		expect(hidden).toContain('clip-path: inset(50%)');
		expect(hidden).toContain('inline-size: 1px');
		expect(CSS).not.toContain('translateY(-120%)');
		// The slide is the only transitioned property, and it is not the one that hides.
		expect(rule('.hx-root .hx-skip')).toContain('transition: transform');
		expect(hidden).not.toContain('transform');
	});

	test('a task item text flows on the marker line, and keeps a plain item spacing', () => {
		expect(rule('.hx-root .hx-task + p')).toContain('display: inline');
		expect(rule('.hx-root .hx-task + p + *')).toContain('margin-block-start: 1rem');
		expect(rule('.hx-root li.hx-task-item')).toContain('margin-block-end: 1rem');
		// It ties with the tight-list reset on specificity, so it has to come later.
		expect(CSS.indexOf('\n.hx-root li.hx-task-item {')).toBeGreaterThan(
			CSS.indexOf('\n.hx-root .hx-tight li {'),
		);
	});

	test('an image states its display, inline in prose and a block in a figure', () => {
		expect(rule('.hx-root .hx-image')).toContain('display: inline-block');
		expect(rule('.hx-root .hx-image')).toContain('vertical-align: middle');
		expect(rule('.hx-root .hx-figure .hx-image')).toContain('display: block');
	});

	test('the shell pads itself from the declared token and caps its own width', () => {
		const layout = rule('.hx-root .hx-layout');
		expect(layout).toContain(`padding-inline: ${t('shell-inset')}`);
		expect(layout).toContain('margin-inline: auto');
		expect(layout).toContain(
			`max-inline-size: calc(${t('tree-size')} + ${t('measure')} + ${t('toc-size')} + 2 * ${t('gutter')} + 2 * ${t('shell-inset')})`,
		);
	});

	test('every property the preflight resets and the docs depend on is stated', () => {
		// One line each for what Tailwind's preflight, or kcalc-web's own base layer, would
		// otherwise decide: the list markers, the heading weight and colour, the link colour
		// and underline, the block margins of a quote and a figure, the font of the code in a
		// fence and the margin that centres the search dialog.
		expect(rule('.hx-root ul.hx-list')).toContain('list-style-type: disc');
		expect(rule('.hx-root li ul.hx-list')).toContain('list-style-type: circle');
		expect(rule('.hx-root ol.hx-list')).toContain('list-style-type: decimal');
		for (const selector of ['.hx-root .hx-title', '.hx-root .hx-heading']) {
			expect(rule(selector)).toContain('font-weight: 600');
			expect(rule(selector)).toContain(`color: ${t('ink')}`);
		}
		expect(rule('.hx-root .hx-prose a,\n.hx-root .hx-banner a')).toContain(
			'text-decoration: underline',
		);
		expect(rule('.hx-root .hx-meta a')).toContain('text-decoration: underline');
		expect(rule('.hx-root .hx-breadcrumb a')).toContain('color: inherit');
		expect(rule('.hx-root .hx-skip')).toContain('text-decoration: underline');
		expect(rule('.hx-root blockquote')).toContain('margin-block: 0 1rem');
		expect(rule('.hx-root .hx-figure')).toContain('margin-block: 0 1rem');
		expect(rule('.hx-root .hx-pre code')).toContain('font: inherit');
		expect(rule('.hx-search')).toContain('margin: auto');
		// The phone controls, in their desktop state. The preflight sets a summary to
		// `display: list-item` and zeroes margins, padding and borders, and the two new
		// wrappers must generate nothing a desktop grid can see.
		const summaries = rule('.hx-root .hx-tree-summary,\n.hx-root .hx-toc-summary');
		for (const declaration of [
			'display: none',
			'list-style: none',
			'margin: 0',
			'padding: 0',
			'border: 0',
		]) {
			expect(summaries).toContain(declaration);
		}
		expect(rule('.hx-root .hx-foot')).toContain('display: contents');
		expect(rule('.hx-root .hx-foot-pages')).toContain('display: none');
		// The two details elements generate no box at all on a desktop, because a displayed
		// one, however empty, is an unnamed group in the accessibility tree. A browser gives a
		// details element no margin, padding or border and the preflight zeroes them anyway, so
		// no probe can see those three go, and they are held here as text.
		const disclosures = rule('.hx-root .hx-tree-disclosure,\n.hx-root .hx-toc-disclosure');
		for (const declaration of ['display: none', 'margin: 0', 'padding: 0', 'border: 0']) {
			expect(disclosures).toContain(declaration);
		}
	});
});

/** The body of the one phone media query, and a failure if there is not exactly one. */
function phoneBlock(): string {
	const head = '\n@media (max-width: 60rem) {\n';
	const parts = CSS.split(head);
	expect({ phoneBlocks: parts.length - 1 }).toEqual({ phoneBlocks: 1 });
	const body = parts[1] as string;
	return body.slice(0, body.indexOf('\n}\n'));
}

describe('the phone layout', () => {
	// What the text has to say. Whether a phone reader gets a bar at the bottom of the screen,
	// rows a thumb can hit and an article on the first screen is `scripts/check-paint.mjs`,
	// whose phone probes `test/paint.test.ts` breaks one rule at a time.
	//
	// Not every phone declaration is held by either. Measured by deleting each declaration and
	// rule in turn, 52 of 122 changed nothing any test reads: the look of the Pages chip and the
	// tree panel (ground, border, radius, text colour, padding), the size and weight of the
	// bar's link, the bar's top rule and stacking order, the alignment and padding inside a row,
	// the chevrons' turn when a disclosure opens, the hidden `/` hint, Safari's marker reset,
	// and declarations another rule already makes true in the hosts the probes reproduce. A
	// change to any of those needs a look in a browser at 390px and 768px, in English and in
	// Arabic, with each disclosure open and closed.

	test('is one media query, after every rule it overrides', () => {
		// The phone rules for the rows and the search dialog tie with rules in CHROME and
		// SEARCH on specificity, and a tie goes to the later rule. Above them, every row is a
		// 24px desktop target again and the dialog is centred.
		expect(CSS.indexOf('\n@media (max-width: 60rem) {')).toBeGreaterThan(
			CSS.indexOf('\n.hx-search .hx-search-heading {'),
		);
		expect(CSS.indexOf('\n@media (max-width: 60rem) {')).toBeGreaterThan(
			CSS.indexOf('\n.hx-root .hx-tree-link,\n.hx-root .hx-tree-section,\n.hx-root .hx-toc-link {'),
		);
		phoneBlock();
	});

	test('paints the chevrons in the text colour of a forced palette, after the rule it overrides', () => {
		// The same tie on specificity, with the phone block's chevron rule. Whether the chevron
		// is then visible is the `phone-forced` probe's to say.
		const forced = '\n@media (forced-colors: active) {\n';
		expect(CSS.split(forced).length - 1).toBe(1);
		expect(CSS.indexOf(forced)).toBeGreaterThan(CSS.indexOf('\n@media (max-width: 60rem) {'));
		expect(CSS.split(forced)[1]?.slice(0, CSS.split(forced)[1]?.indexOf('\n}\n'))).toBe(
			'\t.hx-root .hx-tree-summary::after,\n\t.hx-root .hx-toc-summary::after {\n\t\tbackground: CanvasText;\n\t}',
		);
	});

	test('says what the layout depends on', () => {
		const phone = phoneBlock();
		for (const text of [
			// A block container, so the centred rows fill the column rather than shrinking to their
			// content, and a flow root, so the tree's margin stays inside the docs root.
			'\t.hx-root .hx-layout {\n\t\tdisplay: flow-root;',
			// The disclosures a desktop does not display at all.
			'\t.hx-root .hx-tree-disclosure,\n\t.hx-root .hx-toc-disclosure {\n\t\tdisplay: block;',
			// The panels are hidden while their disclosure is closed, and only then.
			'\t.hx-root .hx-tree-disclosure:not([open]) + .hx-tree-list {\n\t\tdisplay: none;',
			'\t.hx-root .hx-toc-disclosure:not([open]) + .hx-toc-list {\n\t\tdisplay: none;',
			// The bar sticks to the bottom of the viewport.
			'\t\tposition: sticky;\n\t\tinset-block-end: 0;',
			'env(safe-area-inset-bottom, 0px)',
			'min-block-size: 2.75rem',
		]) {
			expect(phone).toContain(text);
		}
		expect(phone.match(/overscroll-behavior: contain;/g)?.length).toBe(2);
	});

	test('the page tree clears the host header when the bar link jumps to it', () => {
		const tree = /\t\.hx-root \.hx-tree \{\n([\s\S]*?)\n\t\}/.exec(phoneBlock())?.[1] ?? '';
		expect(tree).toContain(`\t\tscroll-margin-block-start: ${t('sticky-offset')};`);
		expect(tree).toContain('\t\tposition: static;');
	});

	test('sizes nothing by the viewport height, which a phone toolbar changes under it', () => {
		// `vh` on a phone is the large viewport, measured with the toolbar hidden, so a panel
		// sized by it is taller than the space it opens into while the toolbar shows. `svh` is
		// the small viewport. A digit directly before `vh` is the large unit and nothing else,
		// since `60svh` and `100dvh` have a letter there. The last line runs the same matcher
		// over both spellings, which proves it finds the large unit and passes the small one.
		const largeViewport = /\dvh\b/g;
		const phone = phoneBlock();
		expect(phone.match(largeViewport)).toBeNull();
		expect(phone.match(/\b60svh\b/g)?.length).toBe(2);
		expect(phone.match(/\b80svh\b/g)?.length).toBe(1);
		expect('\t\tmax-block-size: 60svh;\n\t\tmax-block-size: 60vh;'.match(largeViewport)).toEqual([
			'0vh',
		]);
	});

	test('caps both panels at a scroll container of their own', () => {
		// Each panel's height cap and its scrolling come as a pair: a cap with no scrolling
		// leaves the rows past it unreachable, and scrolling with no cap never scrolls. The paint
		// probes open a tall outline and a tall tree and read both halves of each.
		expect(phoneBlock().match(/max-block-size: 60svh;\n\t\toverflow-y: auto;/g)?.length).toBe(2);
	});
});

describe('the generated-artifact script', () => {
	test('writes the stylesheet where the contract says it goes', () => {
		const target = mkdtempSync(join(tmpdir(), 'hexdocs-css-'));
		try {
			const written = emitStylesheetFile(target);
			expect(written).toBe(join(target, STYLESHEET_PATH));
			expect(readFileSync(written, 'utf8')).toBe(CSS);
		} finally {
			rmSync(target, { recursive: true, force: true });
		}
	});

	test('the stylesheet is one of the artifacts one command regenerates', () => {
		// It joins this script rather than getting one of its own, because a second script
		// is a second thing to remember and the one nobody runs is the one that goes stale.
		const written = emitAll();
		expect(written.some((path) => path.endsWith(STYLESHEET_PATH))).toBe(true);
		expect(written.length).toBeGreaterThan(5);
	});
});
