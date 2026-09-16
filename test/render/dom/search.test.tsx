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
import type { Locale } from '../../../src/contracts/locales.js';
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

function mount(locales: { locale?: Locale; searchLocale?: Locale } = {}): void {
	const locale = locales.locale ?? 'en';
	render(
		<DocsSearch
			locale={locale}
			searchLocale={locales.searchLocale ?? locale}
			address={{ basePath: '/fixture-app/docs', locale }}
			bundleBase="/_docs/fixture-app/1.1.0"
			Link={PlainLink}
			emit={emit}
		/>,
	);
}

const trigger = (): HTMLButtonElement => screen.getByRole('button', { name: /search/i });
/** The same control by id, for the two tests whose reader does not read English. */
const triggerById = (): HTMLButtonElement =>
	document.getElementById(IDS.searchTrigger) as HTMLButtonElement;
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

	/**
	 * The backdrop, which is the dialog's own pseudo-element and has no node to aim at.
	 *
	 * happy-dom performs no layout, so every box it hands back is all zeros and a click
	 * "outside" the dialog would be true of every point on the page. The box is stubbed here
	 * for that reason and for no other: what is under test is which pairs of press and click
	 * the handler dismisses on, and the geometry is the input to that question rather than
	 * part of it. Where the box really falls is measured in a browser instead.
	 */
	describe('the backdrop', () => {
		const BOX = { left: 100, top: 100, right: 300, bottom: 200 };
		const INSIDE = { clientX: 200, clientY: 150 };
		const OUTSIDE = { clientX: 20, clientY: 400 };

		const dialog = (): HTMLDialogElement => {
			const element = document.getElementById(IDS.searchDialog) as HTMLDialogElement;
			element.getBoundingClientRect = (() => ({
				...BOX,
				width: BOX.right - BOX.left,
				height: BOX.bottom - BOX.top,
				x: BOX.left,
				y: BOX.top,
				toJSON: () => BOX,
			})) as HTMLDialogElement['getBoundingClientRect'];
			return element;
		};

		const opened = async (): Promise<HTMLDialogElement> => {
			mount();
			fireEvent.click(trigger());
			await waitFor(() => expect(document.activeElement).toBe(input()));
			return dialog();
		};

		const closes = (): number =>
			events.filter((event) => event.name === 'hexdocs:search-close').length;

		test('a press and a click on it close the dialog once, and focus goes back to the trigger', async () => {
			const element = await opened();
			fireEvent.pointerDown(element, OUTSIDE);
			fireEvent.click(element, OUTSIDE);
			await waitFor(() => expect(document.activeElement).toBe(trigger()));
			expect(element.open).toBe(false);
			// One event, because this path calls `close()` and lets the browser's own `close`
			// event do the reporting, the same as Escape and the close button.
			expect(closes()).toBe(1);
			expect(events.find((event) => event.name === 'hexdocs:search-close')?.detail).toEqual({
				query: '',
				chose: null,
			});
		});

		test("a click on the dialog's own padding leaves it open", async () => {
			// The target is the dialog here too, which is why the target alone cannot decide
			// this: a reader who clicks the gap beside the input has not asked to leave.
			const element = await opened();
			fireEvent.pointerDown(element, INSIDE);
			fireEvent.click(element, INSIDE);
			expect(element.open).toBe(true);
			expect(closes()).toBe(0);
		});

		test('a selection dragged out of the dialog leaves it open', async () => {
			// The case that makes this a pair of events rather than one. A click is dispatched
			// at the common ancestor of the press and the release, so releasing on the backdrop
			// after pressing on a result produces a click on the dialog, outside its box: the
			// same event a dismissal produces, and the press is the only thing that differs.
			const element = await opened();
			fireEvent.pointerDown(input(), INSIDE);
			fireEvent.click(element, OUTSIDE);
			expect(element.open).toBe(true);
			expect(closes()).toBe(0);
		});

		test('a click on something inside leaves it open', async () => {
			const element = await opened();
			fireEvent.pointerDown(input(), INSIDE);
			fireEvent.click(input(), INSIDE);
			expect(element.open).toBe(true);
			expect(closes()).toBe(0);
		});

		test('a click with no press before it leaves it open', async () => {
			// A click carrying no pointer press is how a keyboard activation arrives, and its
			// coordinates are zero, which is outside the dialog's box on any real page. Nothing
			// can focus the dialog element itself to activate it, so this is a guard rather than
			// a path, and it is the guard that keeps a stale flag from dismissing later.
			const element = await opened();
			fireEvent.click(element, { clientX: 0, clientY: 0, detail: 0 });
			expect(element.open).toBe(true);
			expect(closes()).toBe(0);
		});

		test('a press on the backdrop that is released inside leaves it open', async () => {
			// The mirror of the dragged selection: the press was on the backdrop, the release
			// was on a result, and the click that reaches the dialog is at a point inside it.
			const element = await opened();
			fireEvent.pointerDown(element, OUTSIDE);
			fireEvent.click(element, INSIDE);
			expect(element.open).toBe(true);
			expect(closes()).toBe(0);
		});
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

	test('the results carry the language of the index they came from', async () => {
		// `docsRoute` falls back to the source locale when the bundle has no index for the
		// language asked for, which is the day-one state of every project: hex-nfc's first
		// bundle is English-only, so an Arabic reader's dialog scores English titles.
		//
		// The list and not each row. Every row comes out of one index, so the box is what has
		// to mirror: `.hx-search-results` is where the depth of the list is drawn and the
		// selected row's bar sits on the inline start, and both belong on the side these words
		// are read from. Measured at 1280px on hex-web's Arabic docs home before this: an
		// English result heading was laid out right to left with 435px of empty space before
		// its first character.
		mount({ locale: 'ar', searchLocale: 'en' });
		fireEvent.click(triggerById());
		fireEvent.change(input(), { target: { value: 'ndef' } });
		await waitFor(() => expect(screen.getAllByRole('option').length).toBe(1));
		const results = document.getElementById(IDS.searchResults) as HTMLElement;
		expect([results.getAttribute('lang'), results.getAttribute('dir')]).toEqual(['en', 'ltr']);
		// And the dialog's own furniture stays in the reader's, which is what would be lost by
		// marking the dialog rather than the list.
		const dialog = document.getElementById(IDS.searchDialog) as HTMLElement;
		expect(dialog.getAttribute('lang')).toBe(null);
		expect(results.closest('[lang="en"]')).toBe(results);
	});

	test('a dialog reading its own language marks nothing', async () => {
		// The other half of the condition every mark in this package shares. Repeating an
		// attribute an element already inherits makes a screen reader announce a language
		// change into the language it is already reading, on every result in the list.
		mount({ locale: 'ar', searchLocale: 'ar' });
		fireEvent.click(triggerById());
		const results = document.getElementById(IDS.searchResults) as HTMLElement;
		expect(results.getAttribute('lang')).toBe(null);
		expect(results.getAttribute('dir')).toBe(null);
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

describe('the slash shortcut', () => {
	const opens = (): number => events.filter((event) => event.name === 'hexdocs:search-open').length;
	/** Long enough for a dispatched open to have reached the effect that reports it. */
	const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

	test('opens the dialog from anywhere on the page, with Shift held as AZERTY types it', async () => {
		// The hint on the trigger promises this. On a French AZERTY keyboard `/` is Shift and
		// the colon key, and on a Spanish one it is Shift and 7, so the event arrives with
		// `shiftKey` true and a handler that counted Shift as a modifier would do nothing.
		mount();
		const allowed = fireEvent.keyDown(document.body, { key: '/', shiftKey: true });
		await waitFor(() => expect(document.activeElement).toBe(input()));
		expect(opens()).toBe(1);
		// Default prevented, or the slash would be typed into the input it just focused.
		expect(allowed).toBe(false);
		expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
	});

	test('does nothing with Command, Control or Alt held, or mid-composition', async () => {
		mount();
		for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) {
			fireEvent.keyDown(document.body, { key: '/', [modifier]: true });
		}
		fireEvent.keyDown(document.body, { key: '/', isComposing: true });
		await settle();
		expect(opens()).toBe(0);
	});

	test('does nothing while focus is somewhere the reader types', async () => {
		mount();
		const field = document.createElement('div');
		field.innerHTML =
			'<input id="i"><textarea id="t"></textarea><select id="s"></select><div contenteditable="true"><span id="c">x</span></div>';
		document.body.append(field);
		for (const id of ['i', 't', 's', 'c']) {
			fireEvent.keyDown(document.getElementById(id) as HTMLElement, { key: '/' });
		}
		await settle();
		expect(opens()).toBe(0);
		field.remove();
	});

	test('does not open a second time while the dialog is already open', async () => {
		// One open is one `hexdocs:search-open`. A slash pressed with focus on the close button
		// would otherwise report a second open for a dialog that never closed.
		mount();
		fireEvent.click(trigger());
		await waitFor(() => expect(document.activeElement).toBe(input()));
		fireEvent.keyDown(screen.getByRole('button', { name: /close/i }), { key: '/' });
		await settle();
		expect(opens()).toBe(1);
	});

	test('stops listening once the search is unmounted', async () => {
		mount();
		cleanup();
		fireEvent.keyDown(document.body, { key: '/' });
		await settle();
		expect(opens()).toBe(0);
	});
});
