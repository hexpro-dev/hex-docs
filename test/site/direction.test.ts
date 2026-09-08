import { describe, expect, test } from 'vitest';

import { LOCALES, RTL_LOCALES } from '../../src/contracts/locales.js';
import { CODE_DIRECTION, contentAttrs, langAttrs } from '../../src/site/direction.js';
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
	test('a page in the language that was asked for does not differ', () => {
		const page = goldenPage('ja', 'guide/index').page;
		expect(contentAttrs(page, 'ja')).toEqual({ lang: 'ja', dir: 'ltr', differs: false });
	});

	test('an English fallback is labelled English, not the language that was asked for', () => {
		// The whole reason this takes both. Marking an English article `lang="ja"` tells a
		// screen reader to read English words with Japanese phonetics and a translation
		// tool that the text is already translated.
		const page = goldenPage('en', 'developer/architecture').page;
		expect(contentAttrs(page, 'ja')).toEqual({ lang: 'en', dir: 'ltr', differs: true });
	});

	test('an Arabic fallback of an English page is laid out left to right', () => {
		// The direction follows the text, not the reader. An English paragraph in an
		// Arabic-reading session is still an English paragraph, and mirroring it would put
		// its full stop on the wrong side.
		const page = goldenPage('en', 'reference/api').page;
		expect(contentAttrs(page, 'ar')).toEqual({ lang: 'en', dir: 'ltr', differs: true });
	});

	test('a real Arabic page is right to left', () => {
		const page = goldenPage('ar', 'reference/index').page;
		expect(contentAttrs(page, 'ar')).toEqual({ lang: 'ar', dir: 'rtl', differs: false });
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
