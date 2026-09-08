import { describe, expect, test } from 'vitest';

import { CALLOUT_KINDS, CODE_SCOPES, STATUS_VALUES } from '../../src/contracts/ast.js';
import {
	CALLOUT_COLOUR,
	DIFF_GUTTER,
	PALETTE,
	PALETTE_NAMES,
	SCOPE_COLOUR,
	STATUS_COLOUR,
	STATUS_SHAPE,
	STATUS_SHAPES,
	paletteValue,
	scopeClass,
} from '../../src/contracts/palette.js';
import { THEME_TOKENS } from '../../src/contracts/theme.js';
import { contrast, stated } from '../support/contrast.js';

const surfaceOf = (name: string): string => {
	const token = THEME_TOKENS.find((entry) => entry.name === name);
	if (token === undefined) throw new Error(`no theme token named ${name}`);
	return token.fallback;
};

const SURFACES: Readonly<Record<string, string>> = {
	ground: surfaceOf('ground'),
	surface: surfaceOf('surface'),
	raised: surfaceOf('raised'),
};

const fallbackOf = (name: string): string => {
	const colour = PALETTE.find((entry) => entry.name === name);
	if (colour === undefined) throw new Error(`no palette colour named ${name}`);
	return colour.fallback;
};

describe('the palette table', () => {
	test('every name is unique and spelled the way the CSS spells it', () => {
		expect(new Set(PALETTE_NAMES).size).toBe(PALETTE_NAMES.length);
		for (const name of PALETTE_NAMES) expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
	});

	test('every colour is a six-digit hex, because every one of them is measured', () => {
		// `transparent` and a keyword are legitimate theme token values and are not
		// legitimate here: a colour with no luminance cannot state a ratio, and an entry
		// that could not be measured would drop silently out of the sweep below.
		for (const colour of PALETTE) expect(colour.fallback).toMatch(/^#[0-9a-f]{6}$/);
	});

	test('no role is empty, because the table is the documentation', () => {
		for (const colour of PALETTE) {
			expect(colour.role.trim().length).toBeGreaterThan(5);
			expect(colour.role.endsWith('.')).toBe(true);
		}
	});

	test('the surfaces named are surfaces the theme table actually ships', () => {
		for (const colour of PALETTE) expect(SURFACES[colour.against]).toBeDefined();
		// Both directions: the three names are the three package surfaces, so a fourth
		// arriving in `PaintedOn` without a token behind it fails here rather than
		// measuring against `undefined`.
		expect(Object.keys(SURFACES).sort()).toEqual(['ground', 'raised', 'surface']);
	});
});

describe('the value chain', () => {
	test('is the token contract chain, with no host link', () => {
		const key = PALETTE.find((colour) => colour.name === 'code-key');
		expect(key).toBeDefined();
		expect(paletteValue(key as never)).toBe('var(--hx-code-key, #f0a8c0)');
	});

	test('never declares the package name it reads, which is the bug that shipped once', () => {
		for (const colour of PALETTE) {
			expect(paletteValue(colour).startsWith(`var(--hx-${colour.name},`)).toBe(true);
		}
	});
});

/**
 * Contrast, measured against the surface each colour is actually painted on.
 *
 * This is the whole reason the palette is a separate table. `theme.test.ts` measures its
 * tokens against the ground and the surface, which is right for page furniture and wrong
 * for a highlight scope: a fence sits on `--hx-raised`, which is lighter than both, so a
 * scope measured against the ground reads better than it looks.
 */
describe('the contrast the palette promises', () => {
	test('the measurement agrees with a known pair, so a broken formula fails here first', () => {
		expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 1);
	});

	test.each(PALETTE)('$name clears $minimum:1 against the $against', (colour) => {
		expect(contrast(colour.fallback, SURFACES[colour.against] as string)).toBeGreaterThanOrEqual(
			colour.minimum,
		);
	});

	test.each(PALETTE)('$name really measures $measures:1 against the $against', (colour) => {
		// The floor above is satisfied by a very wide range of colours, so it says almost
		// nothing about the one that shipped. This is the number that moves when a value
		// is retuned, which is what makes a retune a decision rather than a diff nobody
		// reads.
		expect(stated(contrast(colour.fallback, SURFACES[colour.against] as string))).toBe(
			colour.measures,
		);
	});

	test('text scopes are held to 4.5:1 and marks to 3:1, and nothing is held to less', () => {
		// A minimum somebody could lower to make a colour fit is not a minimum. Both
		// values are the WCAG figures and neither is a preference.
		for (const colour of PALETTE) {
			expect([3, 4.5]).toContain(colour.minimum);
			if (colour.name.startsWith('code-')) expect(colour.minimum).toBe(4.5);
		}
	});
});

describe('meaning never rests on colour alone', () => {
	test('the two diff colours cannot be told apart by contrast, which is why the gutter exists', () => {
		// Measured 1.29:1. Any two colours that both clear 4.5:1 against the same dark
		// ground are close to each other by construction, so this is a property of the
		// problem rather than of these two values. If a future palette ever separated
		// them this fails, and whoever changed it decides whether the gutter character
		// is still earning its place.
		const separation = contrast(fallbackOf('code-good'), fallbackOf('code-bad'));
		expect(separation).toBeLessThan(3);
		expect(stated(separation)).toBe(1.29);
		expect(DIFF_GUTTER.inserted).not.toBe(DIFF_GUTTER.deleted);
	});

	test('every diff gutter character is ASCII, because the banned glyphs are the readable ones', () => {
		for (const character of Object.values(DIFF_GUTTER)) {
			expect(character).toMatch(/^[\x20-\x7e]$/);
		}
	});

	test('the four status values have four distinct shapes as well as four colours', () => {
		const shapes = STATUS_VALUES.map((value) => STATUS_SHAPE[value]);
		expect(new Set(shapes).size).toBe(STATUS_VALUES.length);
		for (const shape of shapes) expect(STATUS_SHAPES).toContain(shape);

		const colours = STATUS_VALUES.map((value) => STATUS_COLOUR[value]);
		expect(new Set(colours).size).toBe(STATUS_VALUES.length);
	});
});

describe('the maps from the AST', () => {
	test('every code scope has a colour and every colour named exists', () => {
		expect(Object.keys(SCOPE_COLOUR).sort()).toEqual([...CODE_SCOPES].sort());
		for (const scope of CODE_SCOPES) expect(PALETTE_NAMES).toContain(SCOPE_COLOUR[scope]);
	});

	test('every callout kind and status value has a colour and every colour named exists', () => {
		expect(Object.keys(CALLOUT_COLOUR).sort()).toEqual([...CALLOUT_KINDS].sort());
		expect(Object.keys(STATUS_COLOUR).sort()).toEqual([...STATUS_VALUES].sort());
		for (const kind of CALLOUT_KINDS) expect(PALETTE_NAMES).toContain(CALLOUT_COLOUR[kind]);
		for (const value of STATUS_VALUES) expect(PALETTE_NAMES).toContain(STATUS_COLOUR[value]);
	});

	test('every palette colour is reached by something, so a dead one fails rather than lingering', () => {
		// The other direction, and the one that matters. A colour nothing maps to is a
		// rule in the generated stylesheet that nothing can ever paint, which is exactly
		// the state `scripts/check-render.mjs` would otherwise have to find later.
		const reached = new Set([
			...Object.values(SCOPE_COLOUR),
			...Object.values(CALLOUT_COLOUR),
			...Object.values(STATUS_COLOUR),
		]);
		expect([...PALETTE_NAMES].filter((name) => !reached.has(name))).toEqual([]);
		expect(reached.size).toBe(PALETTE_NAMES.length);
	});

	test('the scope class is derived from the scope, not from the colour it happens to share', () => {
		// Three scopes share `code-ink` and three share `code-string`. Naming the class
		// after the colour would collapse them, and a claim in the render suite could
		// then no longer tell a `regexp` span from a `string` one.
		expect(scopeClass('regexp')).toBe('hx-s-regexp');
		expect(new Set(CODE_SCOPES.map(scopeClass)).size).toBe(CODE_SCOPES.length);
	});
});
