/**
 * @vitest-environment happy-dom
 *
 * The search dialog, driven.
 *
 * Everything asserted here lives in an event handler or an effect, which is exactly what
 * `renderToStaticMarkup` cannot reach: it produces the markup an `onClick` is attached to
 * and never calls it. The decisions those handlers make are pure and are covered in
 * `test/site/search-state.test.ts`; this is about the wiring between them and the DOM.
 *
 * happy-dom and not a browser, and the boundary is worth stating. It has `showModal`,
 * `matchMedia`, `IntersectionObserver`, `fetch` and a clipboard, which is everything these
 * tests touch. What it is measurably wrong about is CSS custom property resolution, which
 * it performs at the point of use rather than at the point of declaration, so a theme test
 * written here would pass on the exact stylesheet bug the token contract exists to
 * prevent. That check belongs to `scripts/check-paint.mjs` and a real browser.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AST_VERSION } from '../../../src/contracts/ast.js';
import {
	DEFAULT_B,
	DEFAULT_FIELD_WEIGHTS,
	DEFAULT_K1,
	INDEX_NORMALISATION,
	SEARCH_INDEX_KIND,
	SEARCH_INDEX_VERSION,
	TOKENISER_VERSION,
	type SearchIndex,
} from '../../../src/contracts/search.js';
import type { DocsEventMap } from '../../../src/contracts/theme.js';
import { DocsSearch } from '../../../src/render/search.js';
import { PlainLink } from '../../../src/render/nodes.js';
import { IDS, searchOptionId } from '../../../src/site/ids.js';

/**
 * The smallest index a query can score against.
 *
 * One term, one section, one posting in the title field. Built here rather than imported
 * because the point of these tests is the wiring: `test/search/query.test.ts` owns the
 * scoring and has a far richer fixture, and a large one here would make a wiring failure
 * read as a scoring failure.
 */
const INDEX: SearchIndex = {
	kind: SEARCH_INDEX_KIND,
	v: SEARCH_INDEX_VERSION,
	ast: AST_VERSION,
	tokeniser: TOKENISER_VERSION,
	norm: INDEX_NORMALISATION,
	stem: false,
	match: 'or-coord',
	locale: 'en',
	bundle: 'a'.repeat(40),
	n: 1,
	terms: 'ndef',
	df: [1],
	f: {
		title: { cnt: [1], post: [0, 1] },
		heading: { cnt: [0], post: [] },
		body: { cnt: [0], post: [] },
	},
	len: { title: [1], heading: [0], body: [0] },
	totalLen: { title: 1, heading: 0, body: 0 },
	w: DEFAULT_FIELD_WEIGHTS,
	k1: DEFAULT_K1,
	b: DEFAULT_B,
	docs: [
		{
			slug: 'guide/first-tag',
			anchor: '_top',
			title: 'NDEF',
			heading: '',
			depth: 1,
			audience: 3,
			translated: 'current',
		},
	],
};

const events: { name: string; detail: unknown }[] = [];

const emit = <K extends keyof DocsEventMap>(name: K, detail: DocsEventMap[K]): void => {
	events.push({ name, detail });
};

function mount(): void {
	render(
		<DocsSearch
			locale="en"
			searchLocale="en"
			address={{ basePath: '/fixture-app/docs', locale: 'en' }}
			bundleBase="/_docs/fixture-app/1.1.0"
			Link={PlainLink}
			emit={emit}
		/>,
	);
}

const trigger = (): HTMLButtonElement => screen.getByRole('button', { name: /search/i });
const input = (): HTMLInputElement => document.getElementById(IDS.searchInput) as HTMLInputElement;

beforeEach(() => {
	events.length = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({ ok: true, json: async () => INDEX })),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('the trigger', () => {
	test('is enabled once the page is interactive', () => {
		// The server sends it disabled, because a button announced as available that does
		// nothing is worse than no button. Hydration is what turns it on.
		mount();
		expect(trigger().disabled).toBe(false);
	});

	test('fetches the index on the first sign of intent, and only once', async () => {
		mount();
		fireEvent.pointerEnter(trigger());
		fireEvent.focus(trigger());
		fireEvent.click(trigger());
		await waitFor(() => expect(document.getElementById(IDS.searchDialog)).toBeTruthy());
		// Never on page load, and never again once it is in hand. The index is the largest
		// thing in the bundle and most visits never search.
		expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
		expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
			'/_docs/fixture-app/1.1.0/search/en.idx.json',
		);
	});

	test('opening announces itself and moves focus into the input', async () => {
		mount();
		fireEvent.click(trigger());
		await waitFor(() => expect(document.activeElement).toBe(input()));
		expect(events.map((event) => event.name)).toContain('hexdocs:search-open');
	});
});

describe('the dialog', () => {
	test('scores a query and renders the hit as a link to its address', async () => {
		mount();
		fireEvent.click(trigger());
		fireEvent.change(input(), { target: { value: 'ndef' } });
		await waitFor(() => expect(screen.getAllByRole('option').length).toBe(1));
		const link = screen.getByRole('link');
		expect(link.getAttribute('href')).toBe('/fixture-app/docs/guide/first-tag');
	});

	test('an anchor other than the page root becomes a fragment', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					...INDEX,
					docs: [{ ...INDEX.docs[0], anchor: 'reading-a-tag', heading: 'Reading a tag' }],
				}),
			})),
		);
		mount();
		fireEvent.click(trigger());
		fireEvent.change(input(), { target: { value: 'ndef' } });
		await waitFor(() => expect(screen.getAllByRole('option').length).toBe(1));
		expect(screen.getByRole('link').getAttribute('href')).toBe(
			'/fixture-app/docs/guide/first-tag#reading-a-tag',
		);
	});

	test('the arrow keys move the active descendant rather than focus', async () => {
		// The combobox rule. Focus leaving the input would stop the reader typing, and a
		// listbox they have to tab into is not a combobox.
		mount();
		fireEvent.click(trigger());
		fireEvent.change(input(), { target: { value: 'ndef' } });
		await waitFor(() => expect(screen.getAllByRole('option').length).toBe(1));

		fireEvent.keyDown(input(), { key: 'ArrowDown' });
		await waitFor(() =>
			expect(input().getAttribute('aria-activedescendant')).toBe(searchOptionId(0)),
		);
		expect(document.activeElement).toBe(input());
	});

	test('closing returns focus to the trigger and reports the query once', async () => {
		// One event per close. Every exit goes through the browser's own `close` event, so
		// the close button, Escape and choosing a result cannot each emit their own.
		mount();
		fireEvent.click(trigger());
		fireEvent.change(input(), { target: { value: 'ndef' } });
		await waitFor(() => expect(screen.getAllByRole('option').length).toBe(1));

		fireEvent.click(screen.getByRole('button', { name: /close/i }));
		await waitFor(() => expect(document.activeElement).toBe(trigger()));

		const closes = events.filter((event) => event.name === 'hexdocs:search-close');
		expect(closes.length).toBe(1);
		expect(closes[0]?.detail).toEqual({ query: 'ndef', chose: null });
	});

	test('choosing a result reports which one', async () => {
		mount();
		fireEvent.click(trigger());
		fireEvent.change(input(), { target: { value: 'ndef' } });
		await waitFor(() => expect(screen.getAllByRole('option').length).toBe(1));

		fireEvent.click(screen.getByRole('link'));
		await waitFor(() =>
			expect(events.some((event) => event.name === 'hexdocs:search-close')).toBe(true),
		);
		const close = events.find((event) => event.name === 'hexdocs:search-close');
		expect(close?.detail).toEqual({ query: 'ndef', chose: 'guide/first-tag' });
	});

	test('an index this runtime cannot query is refused rather than scored', async () => {
		// Every failure in search is silent: an index built with one tokeniser and scored
		// with another returns nothing, with no error, in one language.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, json: async () => ({ ...INDEX, tokeniser: 99 }) })),
		);
		mount();
		fireEvent.click(trigger());
		fireEvent.change(input(), { target: { value: 'ndef' } });
		await waitFor(() => expect(screen.queryAllByRole('option').length).toBe(0));
	});

	test('a fetch that fails leaves the dialog usable and empty', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, json: async () => ({}) })),
		);
		mount();
		fireEvent.click(trigger());
		fireEvent.change(input(), { target: { value: 'ndef' } });
		await waitFor(() => expect(screen.queryAllByRole('option').length).toBe(0));
		expect(document.getElementById(IDS.searchInput)).toBeTruthy();
	});
});
