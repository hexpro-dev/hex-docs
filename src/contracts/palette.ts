/**
 * The colours the renderer paints that are not page furniture.
 *
 * Twenty highlight scopes, five callout kinds and four status values. They are here
 * rather than in `THEME_TOKENS` for one reason, and it is a testing reason rather than a
 * tidiness one: `test/contracts/theme.test.ts` measures every token stating a ratio
 * against the ground and the surface, and pins the covered set in both directions. A
 * scope colour joining that sweep would be held to the wrong ground, because a fence sits
 * on `--hx-raised` and a callout sits on `--hx-surface`. So each entry here names the
 * surface it is painted on, and the sweep in `test/contracts/palette.test.ts` measures it
 * against that one.
 *
 * Everything else about them matches the token contract exactly. Each is a `--hx-*` name
 * with a literal fallback and no host link, generated through the same `tokenValue`, so a
 * consumer overrides one scope colour the same way it overrides the accent, and the
 * measured reason no colour reads a consumer's palette is the one in `theme.ts`.
 *
 * ## Why the scopes share ten colours rather than having twenty
 *
 * Twenty distinguishable hues on one dark ground is a claim nothing can check, and a
 * reader does not need `constant` to look different from `number`. The map below is data,
 * pinned to `CODE_SCOPES` by `AssertCovers`, so a scope added to the AST without a colour
 * fails the typecheck by name rather than rendering unstyled.
 *
 * ## Why colour is never the only channel
 *
 * `inserted` and `deleted` measure 1.29:1 against each other, which is what a diff
 * encoding its meaning in hue alone gives a reader who cannot separate the two hues. So
 * the renderer emits a gutter character as well, and that is a markup decision rather
 * than a palette one.
 *
 * The four status values have the same problem and one more: `lint.ts` bans U+2705 and
 * U+274C from anything this package emits, and no glyph that survives that ban is covered
 * by every font in seven languages. So a status mark is a CSS shape with a localised
 * accessible name, and the colour is the third channel rather than the first.
 */

import { CALLOUT_KINDS, CODE_SCOPES, STATUS_VALUES } from './ast.js';
import type { CalloutKind, CodeScope, StatusValue } from './ast.js';
import type { AssertCovers, Expect } from './exact.js';
import { tokenValue } from './theme.js';

/** Which of the three package surfaces a colour is painted on. */
export type PaintedOn = 'ground' | 'surface' | 'raised';

export interface PaletteColour {
	/** Without the prefix, and namespaced by what it is for. `code-key` is `--hx-code-key`. */
	name: string;
	fallback: string;
	/** The surface it sits on, which is what its ratio is measured against. */
	against: PaintedOn;
	/**
	 * The ratio it must clear. 4.5 for anything that is text, 3 for a border, a mark or a
	 * shape, per WCAG 2.2 SC 1.4.3 and 1.4.11.
	 */
	minimum: number;
	/**
	 * What it actually measures, checked against the value rather than believed.
	 *
	 * A floor says what a colour may not fall below and leaves the whole range above it
	 * unrecorded, so a colour can be retuned a long way without any number moving. This is
	 * the number that moves. `theme.ts` learned the same lesson from the other end: two of
	 * its roles stated measurements that were wrong and unreachable from any pairing,
	 * because the only thing parsed out of a role was the floor.
	 */
	measures: number;
	role: string;
}

/**
 * The palette, in paint order: the code surface, then callouts, then status marks.
 *
 * Ten colours carry twenty scopes. `code-ink` and `code-dim` deliberately repeat the
 * values of `--hx-ink` and `--hx-dim` rather than reading those tokens, because a
 * consumer retuning body text should not silently retune a highlighter, and because the
 * ratio a scope is held to is measured against `raised` while the token's is measured
 * against the ground.
 */
export const PALETTE: readonly PaletteColour[] = [
	{
		name: 'code-ink',
		fallback: '#f2ede6',
		against: 'raised',
		minimum: 4.5,
		measures: 14.57,
		role: 'Unscoped code, variables, punctuation and operators.',
	},
	{
		name: 'code-dim',
		fallback: '#a89f93',
		against: 'raised',
		minimum: 4.5,
		measures: 6.5,
		role: 'Comments and documentation comments.',
	},
	{
		name: 'code-key',
		fallback: '#f0a8c0',
		against: 'raised',
		minimum: 4.5,
		measures: 8.94,
		role: 'Keywords, booleans and tags.',
	},
	{
		name: 'code-string',
		fallback: '#9fd88a',
		against: 'raised',
		minimum: 4.5,
		measures: 10.23,
		role: 'Strings, regular expressions and escapes.',
	},
	{
		name: 'code-number',
		fallback: '#f0c47a',
		against: 'raised',
		minimum: 4.5,
		measures: 10.41,
		role: 'Numbers, constants and attributes.',
	},
	{
		name: 'code-func',
		fallback: '#8fc7f5',
		against: 'raised',
		minimum: 4.5,
		measures: 9.42,
		role: 'Function and method names.',
	},
	{
		name: 'code-type',
		fallback: '#7fd9c8',
		against: 'raised',
		minimum: 4.5,
		measures: 10.23,
		role: 'Type names.',
	},
	{
		name: 'code-prop',
		fallback: '#d9c6f0',
		against: 'raised',
		minimum: 4.5,
		measures: 10.74,
		role: 'Property and field names.',
	},
	{
		name: 'code-bad',
		fallback: '#f5a3a3',
		against: 'raised',
		minimum: 4.5,
		measures: 8.61,
		role: 'Deleted diff lines and invalid tokens.',
	},
	{
		name: 'code-good',
		fallback: '#a3e0a3',
		against: 'raised',
		minimum: 4.5,
		measures: 11.11,
		role: 'Inserted diff lines.',
	},

	{
		name: 'callout-note',
		fallback: '#8fc7f5',
		against: 'surface',
		minimum: 3,
		measures: 10.11,
		role: 'The note callout rule and mark.',
	},
	{
		name: 'callout-tip',
		fallback: '#9fd88a',
		against: 'surface',
		minimum: 3,
		measures: 10.99,
		role: 'The tip callout rule and mark.',
	},
	{
		name: 'callout-important',
		fallback: '#d9c6f0',
		against: 'surface',
		minimum: 3,
		measures: 11.53,
		role: 'The important callout rule and mark.',
	},
	{
		name: 'callout-warning',
		fallback: '#f0c47a',
		against: 'surface',
		minimum: 3,
		measures: 11.18,
		role: 'The warning callout rule and mark.',
	},
	{
		name: 'callout-caution',
		fallback: '#f5a3a3',
		against: 'surface',
		minimum: 3,
		measures: 9.24,
		role: 'The caution callout rule and mark.',
	},

	{
		name: 'status-yes',
		fallback: '#a3e0a3',
		against: 'surface',
		minimum: 3,
		measures: 11.93,
		role: 'The supported status shape.',
	},
	{
		name: 'status-partial',
		fallback: '#f0c47a',
		against: 'surface',
		minimum: 3,
		measures: 11.18,
		role: 'The partial status shape.',
	},
	{
		name: 'status-no',
		fallback: '#f5a3a3',
		against: 'surface',
		minimum: 3,
		measures: 9.24,
		role: 'The unsupported status shape.',
	},
	{
		name: 'status-na',
		fallback: '#a89f93',
		against: 'surface',
		minimum: 3,
		measures: 6.98,
		role: 'The not-applicable status shape.',
	},
];

/** Palette names, for the both-directions checks and the stylesheet generator. */
export const PALETTE_NAMES: readonly string[] = PALETTE.map((colour) => colour.name);

/**
 * The full `var()` chain for a palette colour, generated through the token contract's
 * own function so there is one spelling of the chain in the package rather than two.
 */
export function paletteValue(colour: PaletteColour): string {
	return tokenValue({
		name: colour.name,
		host: null,
		fallback: colour.fallback,
		role: colour.role,
	});
}

/** The class the renderer puts on a token span: `code-key` becomes `hx-s-key`. */
export function scopeClass(scope: CodeScope): string {
	return `hx-s-${scope}`;
}

/**
 * Which colour paints which scope.
 *
 * `variable`, `punctuation` and `operator` map to `code-ink`, which is the same value the
 * unscoped text already has. That is deliberate rather than an oversight: `highlighted`
 * is false for an unlabelled fence and for a language with no grammar, and a scope that
 * looked different from unscoped text would make a highlighted Swift block and an
 * unhighlighted Metal one disagree about what a bare identifier looks like.
 */
export const SCOPE_COLOUR: Record<CodeScope, string> = {
	keyword: 'code-key',
	string: 'code-string',
	number: 'code-number',
	boolean: 'code-key',
	comment: 'code-dim',
	doc: 'code-dim',
	function: 'code-func',
	type: 'code-type',
	variable: 'code-ink',
	property: 'code-prop',
	constant: 'code-number',
	operator: 'code-ink',
	punctuation: 'code-ink',
	tag: 'code-key',
	attribute: 'code-number',
	regexp: 'code-string',
	escape: 'code-string',
	deleted: 'code-bad',
	inserted: 'code-good',
	invalid: 'code-bad',
};

export const CALLOUT_COLOUR: Record<CalloutKind, string> = {
	note: 'callout-note',
	tip: 'callout-tip',
	important: 'callout-important',
	warning: 'callout-warning',
	caution: 'callout-caution',
};

export const STATUS_COLOUR: Record<StatusValue, string> = {
	yes: 'status-yes',
	partial: 'status-partial',
	no: 'status-no',
	na: 'status-na',
};

/**
 * The second channel, so meaning never rests on hue alone.
 *
 * A diff gutter character for the two diff scopes, and a shape name per status value that
 * the stylesheet draws. Both are ASCII or CSS: `lint.ts` bans the two glyphs an author
 * would reach for, and no glyph that survives the ban is covered by every font the seven
 * languages fall back to.
 */
export const DIFF_GUTTER: Readonly<Record<'inserted' | 'deleted', string>> = {
	inserted: '+',
	deleted: '-',
};

export const STATUS_SHAPES = ['disc', 'half', 'ring', 'bar'] as const;

export type StatusShape = (typeof STATUS_SHAPES)[number];

export const STATUS_SHAPE: Record<StatusValue, StatusShape> = {
	yes: 'disc',
	partial: 'half',
	no: 'ring',
	na: 'bar',
};

/*
 * The pins. Adding a scope, a callout kind or a status value to the AST without giving it
 * a colour fails the typecheck naming the member, and a colour naming a palette entry
 * that no longer exists is caught at runtime by `test/contracts/palette.test.ts`, which
 * checks both maps against `PALETTE_NAMES` in both directions.
 */
type _scopesCovered = Expect<AssertCovers<typeof CODE_SCOPES, keyof typeof SCOPE_COLOUR>>;
type _calloutsCovered = Expect<AssertCovers<typeof CALLOUT_KINDS, keyof typeof CALLOUT_COLOUR>>;
type _statusCovered = Expect<AssertCovers<typeof STATUS_VALUES, keyof typeof STATUS_COLOUR>>;
type _shapesCovered = Expect<AssertCovers<typeof STATUS_VALUES, keyof typeof STATUS_SHAPE>>;
