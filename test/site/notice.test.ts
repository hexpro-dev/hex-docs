import { describe, expect, test } from 'vitest';

import { LOCALES, SOURCE_LOCALE } from '../../src/contracts/locales.js';
import type { CompiledPage } from '../../src/contracts/page.js';
import { seoFor, translationNotice } from '../../src/site/notice.js';
import { goldenPage, goldenPages } from '../support/golden.js';

const withState = (page: CompiledPage, state: CompiledPage['translation']['state']) =>
	({ ...page, translation: { ...page.translation, state } }) as CompiledPage;

describe('the notice a reader sees', () => {
	test('a page in the language that was asked for, and current, says nothing', () => {
		const english = goldenPage('en', 'guide/first-tag').page;
		expect(translationNotice(english, 'en')).toEqual({ state: 'current' });

		// `guide/index`, not `guide/first-tag`: the corpus makes the latter stale in all
		// six translations on purpose, which is what the state above it is for.
		const japanese = goldenPage('ja', 'guide/index').page;
		expect(japanese.translation.state).toBe('current');
		expect(translationNotice(japanese, 'ja')).toEqual({ state: 'current' });
	});

	test('the English payload served for a language with no translation is a fallback', () => {
		// The corpus has no French developer page, so this is the shape the route hands
		// the renderer on day one: hex-nfc's first bundle is English-only.
		const english = goldenPage('en', 'developer/architecture').page;
		expect(translationNotice(english, 'fr')).toEqual({ state: 'fallback', requested: 'fr' });
	});

	test('a stale translation says so, and carries the date the English page moved', () => {
		const stale = goldenPages().find(
			(entry) => entry.locale !== SOURCE_LOCALE && entry.page.translation.state === 'stale',
		);
		expect(stale).toBeDefined();
		const notice = translationNotice(
			(stale as { page: CompiledPage }).page,
			stale?.locale as never,
		);
		expect(notice.state).toBe('stale');
		expect(notice).toHaveProperty(
			'sourceUpdated',
			(stale as { page: CompiledPage }).page.translation.sourceUpdated,
		);
	});

	test('a scaffolded page folds to fallback, because the reader is looking at English', () => {
		// Two independent things set `scaffolded` and the corpus carries both. The file
		// exists, the URL exists and the words are still English, which is the same thing
		// a fallback is to a reader. `kit/src/compile/search.ts` folds it the same way.
		const scaffolded = goldenPage('es', 'reference/chip-support').page;
		expect(scaffolded.translation.state).toBe('scaffolded');
		expect(translationNotice(scaffolded, 'es')).toEqual({ state: 'fallback', requested: 'es' });
	});

	test('the fallback is decided by the payload locale, not by the state', () => {
		// The distinction that makes the signature take a page. An English page is the
		// source when English was asked for and a fallback when it was not, and the state
		// is `source` in both cases.
		const english = goldenPage('en', 'index').page;
		expect(english.translation.state).toBe('source');
		expect(translationNotice(english, 'en')).toEqual({ state: 'current' });
		for (const locale of LOCALES.filter((entry) => entry !== 'en')) {
			expect(translationNotice(english, locale)).toEqual({ state: 'fallback', requested: locale });
		}
	});

	test('a state this runtime does not expect is folded, not thrown', () => {
		// `missing` describes a locale with no file, so nothing should ever have produced
		// a payload carrying it. A bundle is compiled somewhere else, possibly by a newer
		// toolchain, and taking a page to a 500 over a notice is the wrong trade.
		const page = withState(goldenPage('ja', 'index').page, 'missing');
		expect(() => translationNotice(page, 'ja')).not.toThrow();
		expect(translationNotice(page, 'ja')).toEqual({ state: 'fallback', requested: 'ja' });
	});
});

describe('whether the page may be indexed', () => {
	test('a current page at the default version is indexable', () => {
		expect(seoFor({ state: 'current' }, false)).toEqual({ indexable: true });
	});

	test('a stale translation stays indexable, because it is still that language', () => {
		// The design pass asserted the opposite and `site.ts` names only two causes. A
		// stale Japanese page is the right result for somebody searching in Japanese; an
		// English page at a Japanese address is not.
		expect(seoFor({ state: 'stale', sourceUpdated: '2026-02-05T00:00:00Z' }, false)).toEqual({
			indexable: true,
		});
	});

	test('a fallback is not indexable, whatever the version', () => {
		expect(seoFor({ state: 'fallback', requested: 'ja' }, false)).toEqual({ indexable: false });
		expect(seoFor({ state: 'fallback', requested: 'ja' }, true)).toEqual({ indexable: false });
	});

	test('a pinned version is not indexable, whatever the notice', () => {
		expect(seoFor({ state: 'current' }, true)).toEqual({ indexable: false });
	});

	test('both causes are reachable and neither alone explains the other', () => {
		// Four combinations, three of them false. Written out because a single boolean
		// expression is exactly the kind of thing that gets simplified to one of its two
		// terms with every other assertion in this file still passing.
		const cases: [boolean, boolean, boolean][] = [
			[false, false, true],
			[false, true, false],
			[true, false, false],
			[true, true, false],
		];
		for (const [pinned, fallback, indexable] of cases) {
			const notice = fallback
				? ({ state: 'fallback', requested: 'ja' } as const)
				: ({ state: 'current' } as const);
			expect(seoFor(notice, pinned).indexable).toBe(indexable);
		}
	});
});
