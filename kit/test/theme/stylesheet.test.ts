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

describe('the rules a generator cannot enforce', () => {
	test('no physical property, anywhere', () => {
		// They look right in six languages and wrong in Arabic, and the build that shows it
		// is the one nobody runs.
		const physical =
			/(?:^|[^-\w])(?:margin|padding|border|inset)-(?:left|right|top|bottom)\b|text-align:\s*(?:left|right)\b|(?:^|[^-\w])(?:left|right|top|bottom)\s*:/g;
		const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
		expect(withoutComments.match(physical) ?? []).toEqual([]);
	});

	test('the physical-property scan can see one', () => {
		const physical =
			/(?:^|[^-\w])(?:margin|padding|border|inset)-(?:left|right|top|bottom)\b|text-align:\s*(?:left|right)\b|(?:^|[^-\w])(?:left|right|top|bottom)\s*:/g;
		expect('.x { margin-left: 1rem; }'.match(physical) ?? []).not.toEqual([]);
		expect('.x { text-align: left; }'.match(physical) ?? []).not.toEqual([]);
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
		expect([...CSS.matchAll(/scroll-margin-block-start/g)].length).toBeGreaterThanOrEqual(2);
	});

	test('the tree and table of contents links meet the minimum target size', () => {
		expect(CSS).toContain('min-block-size: 24px');
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
