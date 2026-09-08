/**
 * Cardinal plural categories for the seven languages.
 *
 * Two strings the package says carry a number: the reading estimate and the search result
 * count. Both appear on every page, in every language, so getting this wrong is wrong
 * everywhere at once and visible to nobody who can read the English page.
 *
 * ## Why this is a table and not `Intl.PluralRules`
 *
 * The same reason the language names are a table. `Intl` answers from whatever ICU the
 * runtime was built with, so a server on one Node and a browser on another can disagree,
 * and a category that differs between the two is a hydration mismatch on a string a
 * reader sees. It is also unavailable to the compiler when it wants the same answer at
 * publish time. A hand-written table is fourteen lines, is the same everywhere, and can
 * be tested against the cases that actually differ.
 *
 * ## The rules, from CLDR, narrowed to integers
 *
 * Every count this package pluralises is an integer: minutes, rounded up with a floor of
 * one, and a result count. So the fractional arms of the CLDR rules are deliberately not
 * implemented, and `pluralCategory` refuses a non-integer rather than guessing, because a
 * silent wrong category is the failure this table exists to prevent.
 *
 * Arabic is the one that earns the table. It takes six categories and turns on the value
 * modulo one hundred, so a language with two forms and a language with six cannot share a
 * `count === 1` test, and the wrong noun form is not something anyone here can see.
 */

import type { Locale } from '../contracts/locales.js';

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

/**
 * A string in every form its language needs.
 *
 * `other` is required and every other category is optional, which is what makes a
 * Japanese entry one key and an Arabic entry six without either being able to omit the
 * form its language falls back to.
 */
export type PluralForms = Partial<Record<PluralCategory, string>> & { other: string };

export function pluralCategory(locale: Locale, count: number): PluralCategory {
	if (!Number.isInteger(count)) {
		throw new Error(
			`pluralCategory received ${count}, which is not an integer. Every count this package pluralises is one, and the fractional CLDR arms are deliberately not implemented.`,
		);
	}
	const n = Math.abs(count);

	switch (locale) {
		// Two categories, `one` at exactly 1.
		case 'en':
		case 'es':
			return n === 1 ? 'one' : 'other';

		// French and Brazilian Portuguese both put zero in `one`. "0 minute de lecture",
		// not "0 minutes", and the same in Portuguese. This is the arm an English speaker
		// writes wrong, because in English zero is plural.
		case 'fr':
		case 'pt-BR':
			return n === 0 || n === 1 ? 'one' : 'other';

		// One category. Japanese and Chinese do not inflect a noun for number, so a
		// translator has one form to write and any attempt at two is an English shape
		// pressed onto a language that does not have it.
		case 'ja':
		case 'zh':
			return 'other';

		case 'ar': {
			if (n === 0) return 'zero';
			if (n === 1) return 'one';
			if (n === 2) return 'two';
			const hundred = n % 100;
			if (hundred >= 3 && hundred <= 10) return 'few';
			if (hundred >= 11 && hundred <= 99) return 'many';
			return 'other';
		}
	}
}

/**
 * The form for a count, falling back to `other`.
 *
 * The fallback is reachable only when a table omits a category its own language uses,
 * which the parity test refuses, so it exists to keep the return type a string rather
 * than to be relied on.
 */
export function pluralForm(locale: Locale, forms: PluralForms, count: number): string {
	return forms[pluralCategory(locale, count)] ?? forms.other;
}
