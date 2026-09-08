/**
 * The two foldings a term goes through before it is either indexed or looked up.
 *
 * They are in one module, exported, because the builder in `kit/` and the query in the
 * browser have to fold identically. A term folded one way at build time and another at
 * query time is not an error anyone sees: the lookup misses, the page says there are no
 * results, and it does that in one language on somebody else's machine.
 *
 * `normaliseText` is applied to tokeniser input only. Displayed text is never
 * normalised: the corpus carries U+200F and U+FE0F that are load-bearing on the page,
 * and NFKC would also rewrite the fullwidth forms a Japanese legal document uses on
 * purpose.
 */

import { INDEX_NORMALISATION } from '../contracts/search.js';

/**
 * The normalisation the index header records, applied to text on its way into the
 * tokeniser.
 *
 * The form is read from the contract rather than written here, so an index built under
 * a different form is refused by `assertIndexCompatible` instead of being queried with
 * a folding it was not built with.
 */
export function normaliseText(text: string): string {
	return text.normalize(INDEX_NORMALISATION);
}

/** One character the Arabic folding rewrites, and what it becomes. */
export interface ArabicFold {
	codePoint: number;
	name: string;
	/** The code point it folds to, or null when the character is removed outright. */
	to: number | null;
}

/**
 * The Arabic folding, as a table of code points.
 *
 * Declared this way for the reason `BANNED_CHARACTERS` in `src/contracts/lint.ts` is:
 * the pattern is derived from the table below, so the set of characters the folding
 * recognises and the set it rewrites cannot drift apart, and no line of this file
 * contains a literal Arabic diacritic that a reviewer cannot see.
 *
 * Every entry is here because neither NFC nor NFKC touches it, which
 * `fixtures/text.ts` measures rather than claims. Arabic writers omit the hamza above
 * an alef constantly, alef maksura and yeh are interchanged as often, tatweel is
 * justification with no meaning at all, and the short-vowel marks are optional in
 * almost every register. Without this table a reader who types the plain spelling of a
 * word finds nothing, and the index looks correct to anyone who cannot read it.
 *
 * The diacritics are also why the folding runs before the tokeniser's walk rather than
 * only on a finished term: they are combining marks, which are not word characters, so
 * left in place they end a run and split one Arabic word into two terms that no later
 * folding can put back together.
 */
export const ARABIC_FOLDS: readonly ArabicFold[] = [
	{ codePoint: 0x0623, name: 'alef with hamza above', to: 0x0627 },
	{ codePoint: 0x0625, name: 'alef with hamza below', to: 0x0627 },
	{ codePoint: 0x0622, name: 'alef with madda above', to: 0x0627 },
	{ codePoint: 0x0671, name: 'alef wasla', to: 0x0627 },
	{ codePoint: 0x0649, name: 'alef maksura', to: 0x064a },
	{ codePoint: 0x0629, name: 'teh marbuta', to: 0x0647 },
	{ codePoint: 0x0640, name: 'tatweel', to: null },
	{ codePoint: 0x064b, name: 'fathatan', to: null },
	{ codePoint: 0x064c, name: 'dammatan', to: null },
	{ codePoint: 0x064d, name: 'kasratan', to: null },
	{ codePoint: 0x064e, name: 'fatha', to: null },
	{ codePoint: 0x064f, name: 'damma', to: null },
	{ codePoint: 0x0650, name: 'kasra', to: null },
	{ codePoint: 0x0651, name: 'shadda', to: null },
	{ codePoint: 0x0652, name: 'sukun', to: null },
	{ codePoint: 0x0670, name: 'superscript alef', to: null },
];

function characterClass(codePoints: readonly number[]): string {
	return `[${codePoints.map((point) => `\\u{${point.toString(16)}}`).join('')}]`;
}

/** Derived, so the pattern and the table cannot disagree about what is folded. */
const ARABIC_FOLD_PATTERN = new RegExp(
	characterClass(ARABIC_FOLDS.map((entry) => entry.codePoint)),
	'gu',
);

const ARABIC_REPLACEMENTS: Readonly<Record<string, string>> = Object.fromEntries(
	ARABIC_FOLDS.map((entry) => [
		String.fromCodePoint(entry.codePoint),
		entry.to === null ? '' : String.fromCodePoint(entry.to),
	]),
);

/**
 * The folding neither normalisation form does.
 *
 * Idempotent by construction: no character the table produces is a character the table
 * matches, so folding folded text changes nothing. That is what lets it be applied to a
 * whole string on the way into the tokeniser and again to each term on the way out
 * without the second pass meaning anything.
 */
export function foldArabic(text: string): string {
	// The pattern is built from the same table as the replacements, so every match has
	// an entry. The assertion is what keeps that fact from turning into a fallback arm
	// that reads as a case somebody considered and that no test can reach.
	return text.replace(ARABIC_FOLD_PATTERN, (character) => ARABIC_REPLACEMENTS[character] as string);
}

/**
 * The exact folding a single term gets before it enters the dictionary.
 *
 * One exported function rather than two call sites doing the same two steps, because
 * the builder and the query have to agree character for character and a divergence here
 * produces no error at all, only a search that quietly stops matching.
 *
 * `toLowerCase` and not `toLocaleLowerCase`: the latter reads the host's locale, so a
 * Turkish build machine would lower-case a capital I to a dotless one and the index
 * would stop matching the same word typed in a browser anywhere else.
 */
export function foldTerm(term: string): string {
	return foldArabic(term.toLowerCase());
}
