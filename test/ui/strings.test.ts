import { describe, expect, test } from 'vitest';

import { CALLOUT_KINDS } from '../../src/contracts/ast.js';
import { BANNED_CHARACTERS, BANNED_CHARS } from '../../src/contracts/lint.js';
import { LOCALES, SOURCE_LOCALE } from '../../src/contracts/locales.js';
import { PLURAL_CATEGORIES, pluralCategory } from '../../src/ui/plural.js';
import {
	CALLOUT_LABELS,
	LANGUAGE_NAMES,
	PLURAL_KEYS,
	PLURAL_STRINGS,
	TOKENLESS_PLURAL_FORMS,
	UI_KEYS,
	UI_STRINGS,
	calloutLabel,
	interpolate,
	languageName,
	uiPlural,
	uiString,
} from '../../src/ui/strings.js';

const tokensIn = (text: string): string[] =>
	[...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();

/** Every string this package ships, with a path that names it in a failure. */
function everyString(): { where: string; text: string }[] {
	const found: { where: string; text: string }[] = [];
	for (const locale of LOCALES) {
		for (const key of UI_KEYS)
			found.push({ where: `${locale}.${key}`, text: UI_STRINGS[locale][key] });
		for (const kind of CALLOUT_KINDS) {
			found.push({ where: `${locale}.callout.${kind}`, text: CALLOUT_LABELS[locale][kind] });
		}
		for (const named of LOCALES) {
			found.push({ where: `${locale}.language.${named}`, text: LANGUAGE_NAMES[locale][named] });
		}
	}
	for (const key of PLURAL_KEYS) {
		for (const locale of LOCALES) {
			for (const [category, text] of Object.entries(PLURAL_STRINGS[key][locale])) {
				found.push({ where: `${locale}.${key}.${category}`, text: text as string });
			}
		}
	}
	return found;
}

describe('the key set', () => {
	test('every locale carries exactly the same keys, in both directions', () => {
		expect(new Set(UI_KEYS).size).toBe(UI_KEYS.length);
		for (const locale of LOCALES) {
			expect(Object.keys(UI_STRINGS[locale]).sort()).toEqual([...UI_KEYS].sort());
		}
		expect(Object.keys(UI_STRINGS).sort()).toEqual([...LOCALES].sort());
	});

	test('every callout kind and every language is named in every locale', () => {
		for (const locale of LOCALES) {
			expect(Object.keys(CALLOUT_LABELS[locale]).sort()).toEqual([...CALLOUT_KINDS].sort());
			expect(Object.keys(LANGUAGE_NAMES[locale]).sort()).toEqual([...LOCALES].sort());
		}
		expect(Object.keys(CALLOUT_LABELS).sort()).toEqual([...LOCALES].sort());
		expect(Object.keys(LANGUAGE_NAMES).sort()).toEqual([...LOCALES].sort());
	});

	test('nothing is blank', () => {
		const blank = everyString().filter((entry) => entry.text.trim().length === 0);
		expect(blank).toEqual([]);
		// A count, because a sweep over an empty list satisfies every assertion above it.
		expect(everyString().length).toBe(
			LOCALES.length * (UI_KEYS.length + CALLOUT_KINDS.length + LOCALES.length) +
				PLURAL_KEYS.length * LOCALES.reduce((n, l) => n + categoriesUsedBy(l).length, 0),
		);
	});
});

function categoriesUsedBy(locale: (typeof LOCALES)[number]): string[] {
	const seen = new Set<string>();
	for (let n = 0; n <= 200; n += 1) seen.add(pluralCategory(locale, n));
	return [...seen];
}

describe('interpolation parity', () => {
	test('every translation carries exactly the tokens the English carries', () => {
		// Both directions and by multiplicity, because the failures are different: a
		// dropped token is a sentence missing its subject, and an invented one renders a
		// literal brace on a page in a language nobody here reads.
		let compared = 0;
		for (const locale of LOCALES.filter((entry) => entry !== SOURCE_LOCALE)) {
			for (const key of UI_KEYS) {
				expect({ key, locale, tokens: tokensIn(UI_STRINGS[locale][key]) }).toEqual({
					key,
					locale,
					tokens: tokensIn(UI_STRINGS[SOURCE_LOCALE][key]),
				});
				compared += 1;
			}
		}
		expect(compared).toBe((LOCALES.length - 1) * UI_KEYS.length);
	});

	test('a token with no value survives, so a missing value is visible rather than silent', () => {
		expect(interpolate('Step {number}', {})).toBe('Step {number}');
		expect(interpolate('Step {number}', { number: '3' })).toBe('Step 3');
		expect(interpolate('{a} and {a}', { a: 'x' })).toBe('x and x');
		expect(interpolate('{a} and {b}', { a: 'x' })).toBe('x and {b}');
	});

	test('substitution does not reach into a value, so a value containing a brace is inert', () => {
		// A page title really can contain braces: the corpus has headings that are
		// entirely inline code. A second pass over the result would substitute inside it.
		expect(interpolate('{title} loaded', { title: '{next}' })).toBe('{next} loaded');
	});
});

describe('shipped content obeys the house rules', () => {
	test('no banned character appears in any string, in any language', () => {
		// These are product strings on a public website, so the global rule applies to
		// them exactly as it applies to a locale file. The pattern is derived from the
		// code point list rather than written out, so this cannot fall out of step with
		// what the linter refuses.
		const hits = everyString().filter((entry) => BANNED_CHARS.test(entry.text));
		expect(hits).toEqual([]);
		expect(BANNED_CHARACTERS.length).toBeGreaterThan(10);
	});

	test('the sweep can see a banned character, so a passing run means something', () => {
		// The positive control. Every assertion of the form "no string contains X" is
		// satisfied by a broken pattern and by an empty list, and neither of those is
		// distinguishable from a clean table without this.
		const planted = String.fromCodePoint(BANNED_CHARACTERS[1]?.codePoint as number);
		expect(BANNED_CHARS.test(`before ${planted} after`)).toBe(true);
	});

	test('apostrophes are straight everywhere, so the file has one convention', () => {
		const curly = everyString().filter((entry) => /[‘’]/.test(entry.text));
		expect(curly).toEqual([]);
	});
});

describe('plurals', () => {
	test('each locale declares exactly the categories its rules can produce', () => {
		// Derived from `pluralCategory` rather than listed, so the table and the rules
		// cannot disagree. Arabic is the case that makes this worth doing: six forms,
		// turning on the value modulo one hundred.
		for (const key of PLURAL_KEYS) {
			for (const locale of LOCALES) {
				expect({
					key,
					locale,
					categories: Object.keys(PLURAL_STRINGS[key][locale]).sort(),
				}).toEqual({ key, locale, categories: categoriesUsedBy(locale).sort() });
			}
		}
		expect(categoriesUsedBy('ar').length).toBe(6);
		expect(categoriesUsedBy('ja')).toEqual(['other']);
	});

	test('every form carries the count once, except the forms that declare they do not', () => {
		const declared = new Set(
			TOKENLESS_PLURAL_FORMS.map((entry) => `${entry.locale}.${entry.category}`),
		);
		const without: string[] = [];
		for (const key of PLURAL_KEYS) {
			for (const locale of LOCALES) {
				for (const [category, text] of Object.entries(PLURAL_STRINGS[key][locale])) {
					const count = tokensIn(text as string).filter((token) => token === 'count').length;
					if (count === 1) continue;
					expect(count).toBe(0);
					without.push(`${locale}.${category}`);
				}
			}
		}
		// Both directions. A declared exemption whose form has quietly regained the token
		// is an exemption nobody decided on, which is the shape this repository refuses
		// everywhere else.
		expect([...new Set(without)].sort()).toEqual([...declared].sort());
		for (const entry of TOKENLESS_PLURAL_FORMS) {
			expect(entry.why.length).toBeGreaterThan(30);
		}
	});

	test('Arabic really changes form across its six ranges', () => {
		const forms = [0, 1, 2, 3, 11, 100].map((n) => uiPlural('ar', 'resultCount', n));
		// Six distinct strings from six numbers. Three of the six share a noun form and
		// are separated only by the numeral the interpolation supplies, which is why this
		// asserts the rendered strings rather than the categories: a table that collapsed
		// two forms would still declare six categories.
		expect(new Set(forms).size).toBe(6);
		expect(uiPlural('ar', 'resultCount', 2)).not.toContain('2');
	});

	test('French and Portuguese put zero in the singular, which English does not', () => {
		expect(pluralCategory('fr', 0)).toBe('one');
		expect(pluralCategory('pt-BR', 0)).toBe('one');
		expect(pluralCategory('en', 0)).toBe('other');
		expect(uiPlural('en', 'resultCount', 0)).toBe('0 results');
	});

	test('a non-integer is refused rather than guessed at', () => {
		expect(() => pluralCategory('en', 1.5)).toThrow(/not an integer/);
	});

	test('every category the module declares is one a language actually uses', () => {
		const used = new Set(LOCALES.flatMap(categoriesUsedBy));
		expect([...used].sort()).toEqual([...PLURAL_CATEGORIES].sort());
	});
});

describe('the accessors', () => {
	test('read the active language and interpolate', () => {
		expect(uiString('ja', 'previous')).toBe('前へ');
		expect(uiString('en', 'stepLabel', { number: '2' })).toBe('Step 2');
		expect(calloutLabel('fr', 'warning')).toBe('Avertissement');
	});

	test('name a language in the language the reader is reading', () => {
		// The diagonal is what the fallback notice needs: a Japanese reader is told the
		// page is not in 日本語, not that it is not in Japanese.
		expect(languageName('ja', 'ja')).toBe('日本語');
		expect(languageName('en', 'ja')).toBe('Japanese');
		expect(languageName('ar', 'fr')).toBe('الفرنسية');
	});

	test("the notice reads as a whole sentence in the reader's own language", () => {
		expect(uiString('ja', 'noticeFallback', { language: languageName('ja', 'ja') })).toBe(
			'このページはまだ日本語に翻訳されていません。',
		);
	});
});
