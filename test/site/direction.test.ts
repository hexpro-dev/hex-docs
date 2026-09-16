import { describe, expect, test } from 'vitest';

import { LOCALES, RTL_LOCALES } from '../../src/contracts/locales.js';
import { CODE_DIRECTION, contentMark, interfaceMark, langAttrs } from '../../src/site/direction.js';
import { goldenPage } from '../support/golden.js';

describe('the language and direction pair', () => {
	test('every locale gets its own tag, spelled as the tag and not as a slug', () => {
		for (const locale of LOCALES) expect(langAttrs(locale).lang).toBe(locale);
		expect(langAttrs('pt-BR').lang).toBe('pt-BR');
	});

	test('Arabic is right to left and nothing else is, in both directions', () => {
		const rtl = LOCALES.filter((locale) => langAttrs(locale).dir === 'rtl');
		expect(rtl).toEqual([...RTL_LOCALES]);
		expect(rtl.length).toBe(1);
	});
});

describe('the article carries the locale it is actually in', () => {
	test('a page in the language that was asked for says nothing', () => {
		const page = goldenPage('ja', 'guide/index').page;
		expect(contentMark('ja', page.locale)).toEqual({});
	});

	test('an English fallback is labelled English, not the language that was asked for', () => {
		// The whole reason this takes both. Marking an English article `lang="ja"` tells a
		// screen reader to read English words with Japanese phonetics and a translation
		// tool that the text is already translated.
		const page = goldenPage('en', 'developer/architecture').page;
		expect(contentMark('ja', page.locale)).toEqual({ lang: 'en', dir: 'ltr' });
	});

	test('an Arabic fallback of an English page is laid out left to right', () => {
		// The direction follows the text, not the reader. An English paragraph in an
		// Arabic-reading session is still an English paragraph, and mirroring it would put
		// its full stop on the wrong side.
		const page = goldenPage('en', 'reference/api').page;
		expect(contentMark('ar', page.locale)).toEqual({ lang: 'en', dir: 'ltr' });
		// And the shell's own words inside that article are the reader's, which is the half
		// the article's attribute cannot cover.
		expect(interfaceMark('ar', page.locale)).toEqual({ lang: 'ar', dir: 'rtl' });
	});

	test('a real Arabic page is right to left at the root and marks nothing below it', () => {
		const page = goldenPage('ar', 'reference/index').page;
		expect(langAttrs(page.locale)).toEqual({ lang: 'ar', dir: 'rtl' });
		expect(contentMark('ar', page.locale)).toEqual({});
		expect(interfaceMark('ar', page.locale)).toEqual({});
	});
});

describe('the two marks', () => {
	test('answer opposite sides of the same question, on the same condition', () => {
		// The pair, on an Arabic reader looking at an English page. The article's own words are
		// English and every piece of furniture the shell puts inside it is Arabic, so one mark
		// says English and the other says Arabic about the same page.
		expect(contentMark('ar', 'en')).toEqual({ lang: 'en', dir: 'ltr' });
		expect(interfaceMark('ar', 'en')).toEqual({ lang: 'ar', dir: 'rtl' });
	});

	test('say nothing when the page is in the language that was asked for', () => {
		// Not an optimisation. An element that repeats the language it already inherits makes
		// a screen reader announce a language change into the language it is already reading,
		// on every banner, every pager and every copy button on the page.
		for (const locale of LOCALES) {
			expect(contentMark(locale, locale)).toEqual({});
			expect(interfaceMark(locale, locale)).toEqual({});
		}
	});

	test('a fallback in a left-to-right language still marks both, because the language differs', () => {
		// Direction is the visible half and it is not the only half. French and English are
		// both left to right, so nothing moves, and a screen reader still needs to be told
		// which voice to read each part in.
		expect(contentMark('fr', 'en')).toEqual({ lang: 'en', dir: 'ltr' });
		expect(interfaceMark('fr', 'en')).toEqual({ lang: 'fr', dir: 'ltr' });
	});
});

describe('code direction', () => {
	test('is left to right, with no input that could change it', () => {
		// A right-aligned fence with its indentation on the wrong side is unreadable to
		// everyone, Arabic readers included, and a bidirectional reorder inside an
		// identifier changes what the identifier says.
		expect(CODE_DIRECTION).toBe('ltr');
	});
});
