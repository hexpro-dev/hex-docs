import { describe, expect, test } from 'vitest';

import {
	directionOf,
	isLocale,
	LOCALES,
	matchLocale,
	normaliseLocale,
	requireLocale,
	RTL_LOCALES,
	SOURCE_LOCALE,
	sortLocales,
} from '../../src/contracts/locales.js';

describe('the locale set', () => {
	test('is exactly the seven the estate ships, in the order @hex-pro/i18n declares them', () => {
		expect([...LOCALES]).toEqual(['en', 'zh', 'ar', 'es', 'ja', 'fr', 'pt-BR']);
		expect(SOURCE_LOCALE).toBe('en');
		expect([...RTL_LOCALES]).toEqual(['ar']);
	});

	test('every member round-trips through matchLocale as already canonical', () => {
		for (const locale of LOCALES) {
			const match = matchLocale(locale);
			expect(match.ok).toBe(true);
			if (match.ok) {
				expect(match.locale).toBe(locale);
				expect(match.canonical).toBe(true);
			}
		}
	});

	test('directionOf is rtl for Arabic and ltr for everything else', () => {
		expect(directionOf('ar')).toBe('rtl');
		for (const locale of LOCALES.filter((l) => l !== 'ar')) {
			expect(directionOf(locale)).toBe('ltr');
		}
	});
});

describe('normalisation at the boundary', () => {
	test.each([
		['zh-Hans', 'zh', 'the Xcode string catalogue spelling'],
		['zh_Hans', 'zh', 'underscore separator'],
		['ZH-HANS', 'zh', 'case insensitive'],
		['pt_BR', 'pt-BR', 'Xcode and Android resource spelling'],
		['pt-br', 'pt-BR', 'a lower-cased URL segment'],
		['PT-BR', 'pt-BR', 'shouting'],
		['EN', 'en', 'case only'],
		['  fr  ', 'fr', 'surrounding whitespace'],
	])('%s becomes %s (%s)', (input, expected) => {
		expect(normaliseLocale(input)).toBe(expected);
		const match = matchLocale(input);
		expect(match.ok && match.canonical).toBe(false);
	});
});

describe('loud rejections', () => {
	test('hi is refused by name, not dropped', () => {
		const match = matchLocale('hi');
		expect(match.ok).toBe(false);
		if (!match.ok) {
			expect(match.reason).toBe('unsupported-language');
			expect(match.message).toContain('Hindi');
			expect(match.message).toContain('App Store');
		}
	});

	test.each(['zh-Hant', 'zh_Hant', 'zh-TW', 'zh-Hant-TW'])(
		'%s is refused rather than folded into zh',
		(input) => {
			const match = matchLocale(input);
			expect(match.ok).toBe(false);
			if (!match.ok) {
				expect(match.reason).toBe('wrong-script');
				expect(match.message).toContain('Simplified');
			}
		},
	);

	test('regional variants we do not publish are not silently aliased', () => {
		// pt-PT folding to pt-BR would be the same undetectable substitution as
		// zh-Hant folding to zh. A route may offer the nearest published language;
		// this contract may not decide it silently.
		expect(normaliseLocale('pt-PT')).toBeUndefined();
		expect(normaliseLocale('zh-CN')).toBeUndefined();
	});

	test.each(['', '   ', '!!', 'a', 'this-is-not-a-tag!'])('%p is not a language tag', (input) => {
		const match = matchLocale(input);
		expect(match.ok).toBe(false);
		if (!match.ok) expect(match.reason).toBe('not-a-language-tag');
	});

	test('a well-formed tag for a language we do not publish says so', () => {
		const match = matchLocale('de');
		expect(match.ok).toBe(false);
		if (!match.ok) expect(match.reason).toBe('unsupported-language');
	});

	test('requireLocale throws with the caller context and the reason', () => {
		expect(() => requireLocale('hi', 'docs/site/content/hi')).toThrowError(
			/docs\/site\/content\/hi: Hindi/,
		);
		expect(requireLocale('pt_BR', 'x')).toBe('pt-BR');
	});
});

describe('isLocale', () => {
	test('accepts only the canonical spellings', () => {
		expect(isLocale('pt-BR')).toBe(true);
		expect(isLocale('pt-br')).toBe(false);
		expect(isLocale(undefined)).toBe(false);
		expect(isLocale(7)).toBe(false);
	});
});

describe('sortLocales', () => {
	test('puts any collection into tuple order, not alphabetical order', () => {
		// Determinism: a manifest built from a readdir and one built from a config
		// must produce identical bytes, and readdir order is not stable.
		expect(sortLocales(['ja', 'ar', 'en'])).toEqual(['en', 'ar', 'ja']);
		expect(sortLocales(['pt-BR', 'zh'])).toEqual(['zh', 'pt-BR']);
	});

	test('de-duplicates and drops nothing that is present', () => {
		expect(sortLocales(['en', 'en', 'fr'])).toEqual(['en', 'fr']);
		expect(sortLocales([...LOCALES].reverse())).toEqual([...LOCALES]);
	});

	test('is stable across repeated calls with different input order', () => {
		const a = sortLocales(['fr', 'en', 'ja']);
		const b = sortLocales(['ja', 'fr', 'en']);
		expect(a).toEqual(b);
	});
});
