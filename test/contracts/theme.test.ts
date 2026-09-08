import { describe, expect, test } from 'vitest';

import {
	DOCS_EVENT_NAMES,
	THEME_TOKENS,
	TOKEN_PREFIX,
	tokenName,
	tokenValue,
} from '../../src/contracts/theme.js';

describe('the token table', () => {
	test('every name is unique, so no rule silently shadows another', () => {
		const names = THEME_TOKENS.map((token) => token.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names.length).toBeGreaterThan(20);
	});

	test('names are lower case and hyphenated, matching the CSS they generate', () => {
		for (const token of THEME_TOKENS) expect(token.name).toMatch(/^[a-z][a-z0-9-]*$/);
	});

	test('every host token is a custom property', () => {
		for (const token of THEME_TOKENS) {
			if (token.host !== null) expect(token.host).toMatch(/^--[a-z][a-z0-9-]*$/);
		}
	});

	test('every token has a literal fallback, so a consumer with no design system still gets a page', () => {
		for (const token of THEME_TOKENS) expect(token.fallback.length).toBeGreaterThan(0);
	});

	test('no token has an empty role, because the table is the documentation', () => {
		for (const token of THEME_TOKENS) {
			expect(token.role.trim().length).toBeGreaterThan(5);
			expect(token.role.endsWith('.')).toBe(true);
		}
	});
});

describe('the value chain', () => {
	test('reads the package token first, then the host token, then a literal', () => {
		const accent = THEME_TOKENS.find((token) => token.name === 'accent');
		expect(accent).toBeDefined();
		expect(tokenValue(accent as never)).toBe('var(--hx-accent, var(--color-accent, #0b76d9))');
	});

	test('drops the host link when there is none', () => {
		const measure = THEME_TOKENS.find((token) => token.name === 'measure');
		expect(tokenValue(measure as never)).toBe('var(--hx-measure, 42rem)');
	});

	test('the prefix is --hx- everywhere', () => {
		expect(TOKEN_PREFIX).toBe('--hx-');
		for (const token of THEME_TOKENS) expect(tokenName(token).startsWith(TOKEN_PREFIX)).toBe(true);
	});

	test('no chain aliases a package token at the root, which is the bug that shipped once', () => {
		// A custom property is substituted where it is declared, not where it is used.
		// `:root { --hx-accent: var(--color-accent) }` resolves against the base accent
		// once, and an .app-sol override further down can never take effect. Every
		// chain must therefore be a use-site read, and none may be a declaration.
		for (const token of THEME_TOKENS) {
			const value = tokenValue(token);
			expect(value.startsWith(`var(${tokenName(token)},`)).toBe(true);
			expect(value).not.toMatch(/^--/);
		}
	});
});

describe('the link accent is a separate token', () => {
	test('because the furniture accent fails contrast for inline body text', () => {
		// #0b76d9 on the void ground measures 4.23:1: enough for a large control, not
		// enough for a link in a paragraph. One token would ship failing contrast on
		// every page in seven languages.
		const furniture = THEME_TOKENS.find((token) => token.name === 'accent');
		const link = THEME_TOKENS.find((token) => token.name === 'accent-link');
		expect(link).toBeDefined();
		expect(link?.host).not.toBe(furniture?.host);
		expect(link?.fallback).not.toBe(furniture?.fallback);
	});
});

/**
 * Contrast, measured rather than asserted in prose.
 *
 * Scoped to the fallback pairs only. The host chain resolves against the consuming
 * site's own tokens, which are not this package's to measure; the fallbacks are what a
 * consumer with no design system gets, which the token table calls the case that has
 * to work for this to be reusable at all.
 *
 * `--hx-control` shipped with a role string promising 3:1 and a value measuring
 * 2.00:1, and nothing anywhere checked a single number in the table.
 */
describe('the contrast the roles promise', () => {
	const channel = (value: number) =>
		value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);

	const luminance = (hex: string) => {
		const [r, g, b] = [1, 3, 5].map((i) => channel(Number.parseInt(hex.slice(i, i + 2), 16) / 255));
		return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
	};

	const contrast = (a: string, b: string) => {
		const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return ((lighter as number) + 0.05) / ((darker as number) + 0.05);
	};

	const fallbackOf = (name: string) => {
		const token = THEME_TOKENS.find((entry) => entry.name === name);
		if (token === undefined) throw new Error(`no token named ${name}`);
		return token.fallback;
	};

	const GROUND = fallbackOf('ground');
	const SURFACE = fallbackOf('surface');

	test('the measurement agrees with a known pair, so a broken formula fails here first', () => {
		expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 1);
		expect(contrast('#0f0e0d', '#0f0e0d')).toBeCloseTo(1, 5);
	});

	/**
	 * Every token whose role states a ratio, read out of the role rather than listed.
	 *
	 * The previous version of this block was a four-entry literal table, and the comment
	 * on the `control` token claimed it "checks every token whose role states a ratio".
	 * It did not: a token added with a role promising 4.5:1 and a fallback measuring
	 * 1.69:1 passed, which is exactly the drift the comment said could not happen.
	 */
	const themeContrast = THEME_TOKENS.flatMap((token) => {
		const stated = /Held to ([\d.]+):1/.exec(token.role);
		return stated === null ? [] : [{ name: token.name, minimum: Number(stated[1]) }];
	});

	test('the sweep found the tokens that state a ratio, and would fail if one stopped', () => {
		// Both directions. A new token promising a ratio has to be added here, which is
		// one line and makes the addition deliberate; a token quietly losing the promise
		// from its role fails rather than dropping out of the sweep unnoticed.
		expect(themeContrast.map((entry) => entry.name)).toEqual([
			'control',
			'ink',
			'dim',
			'accent-link',
		]);
		expect(themeContrast.length).toBeGreaterThan(0);
	});

	test.each(themeContrast)('$name clears $minimum:1 against both grounds', ({ name, minimum }) => {
		const value = fallbackOf(name);
		// A role that promises a ratio against a colour it cannot be measured against is
		// a promise nothing can check, so it fails here rather than being skipped.
		expect(value).toMatch(/^#[0-9a-f]{6}$/);
		expect(contrast(value, GROUND)).toBeGreaterThanOrEqual(minimum);
		expect(contrast(value, SURFACE)).toBeGreaterThanOrEqual(minimum);
	});

	test('the furniture accent is not held to the body-text ratio, and is why the link token exists', () => {
		const accent = contrast(fallbackOf('accent'), GROUND);
		expect(accent).toBeGreaterThanOrEqual(3);
		expect(accent).toBeLessThan(4.5);
	});
});

describe('the custom events', () => {
	test('every name is namespaced, so a consumer listener cannot collide with its own', () => {
		for (const name of DOCS_EVENT_NAMES) expect(name.startsWith('hexdocs:')).toBe(true);
		expect(new Set(DOCS_EVENT_NAMES).size).toBe(DOCS_EVENT_NAMES.length);
	});
});
