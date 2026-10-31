/**
 * @vitest-environment happy-dom
 *
 * `:more[...]`: the preview a resting pointer opens, and the reveal a click makes.
 *
 * Here rather than in the markup suite because every assertion is about a handler or an
 * effect, which static markup never runs. happy-dom has the `popover` attribute and none of
 * the Popover API, so `showPopover` and `hidePopover` are stubbed on the prototype and
 * recorded: what is under test is when the component asks for the top layer, not what the
 * top layer does, which `scripts/check-paint.mjs` measures in a real browser. Nothing about
 * CSS belongs in this file, for the reason `test/render/dom/search.test.tsx` gives.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { Fragment, createElement } from 'react';

import type { Locale } from '../../../src/contracts/locales.js';
import type { CompiledPage } from '../../../src/contracts/page.js';
import type { DocsSiteConfig } from '../../../src/contracts/site.js';
import { PREVIEW_CLOSE_DELAY, PREVIEW_OPEN_DELAY } from '../../../src/render/client.js';
import { DocsPage } from '../../../src/render/page.js';
import { PlainLink, renderBlocks } from '../../../src/render/nodes.js';
import type { DocsPageData } from '../../../src/site/route.js';
import { REPO_ROOT, goldenManifest, goldenPages } from '../../support/golden.js';
import { pageData } from '../../support/render.js';

const SITE = JSON.parse(
	readFileSync(join(REPO_ROOT, 'fixtures', 'site', 'fixture-app.docs.json'), 'utf8'),
) as DocsSiteConfig;
const MANIFEST = goldenManifest();
const PAGES = new Map(goldenPages().map((entry) => [`${entry.locale}/${entry.slug}`, entry.page]));
const CHIPS = 'reference/chip-support';

const data = (locale: Locale, slug: string): Promise<DocsPageData> =>
	pageData({
		manifest: MANIFEST,
		site: SITE,
		locale,
		slug,
		load: (l, s) => PAGES.get(`${l}/${s}`) as CompiledPage | undefined,
	});

let shown: HTMLElement[];
let hidden: HTMLElement[];
const prototype = HTMLElement.prototype as unknown as Record<string, unknown>;

beforeEach(() => {
	shown = [];
	hidden = [];
	prototype['showPopover'] = function showPopover(this: HTMLElement) {
		shown.push(this);
	};
	prototype['hidePopover'] = function hidePopover(this: HTMLElement) {
		hidden.push(this);
	};
	vi.stubGlobal('matchMedia', () => ({
		matches: false,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	}));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	delete prototype['showPopover'];
	delete prototype['hidePopover'];
});

/** The first `:more` on the page: its wrapper, its mark and its body. */
function firstMore(): { wrapper: HTMLElement; mark: HTMLButtonElement; body: HTMLElement } {
	const wrapper = document.querySelector('.hx-more') as HTMLElement | null;
	expect(wrapper, 'the chip support page has a :more').not.toBeNull();
	return {
		wrapper: wrapper as HTMLElement,
		mark: wrapper?.querySelector('.hx-more-mark') as HTMLButtonElement,
		body: wrapper?.querySelector('.hx-more-body') as HTMLElement,
	};
}

describe('before the script runs', () => {
	test('the mark is disabled and the text carries no popover attribute', async () => {
		// The user agent hides an element with `popover` and no `:popover-open`, and no media
		// query reaches that rule. In the server's markup it would hide the words from the one
		// reader who has no other way to get them.
		const html = renderToStaticMarkup(<DocsPage {...await data('en', CHIPS)} />);
		const more = /<span class="hx-more">[\s\S]*?<\/span><\/span>/.exec(html)?.[0] ?? '';
		expect(more).toContain('class="hx-more-mark"');
		expect(more).toContain('disabled=""');
		expect(more).toContain('aria-label="Show details"');
		expect(more).not.toContain('popover');
		expect(more).toContain('ChangeFileSettings');
	});

	test('hydrates with no mismatch, and then the text becomes a popover', async () => {
		const props = await data('en', CHIPS);
		const container = document.createElement('div');
		container.innerHTML = renderToString(<DocsPage {...props} />);
		document.body.append(container);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		let root: Root | undefined;
		await act(async () => {
			root = hydrateRoot(container, <DocsPage {...props} />);
		});
		expect(errors).not.toHaveBeenCalled();
		const { mark, body } = firstMore();
		expect(mark.disabled).toBe(false);
		expect(body.getAttribute('popover')).toBe('manual');
		// What shows the mark in an engine that has the Popover API and not the scripting query.
		expect(firstMore().wrapper.hasAttribute('data-ready')).toBe(true);
		act(() => root?.unmount());
		container.remove();
		errors.mockRestore();
	});
});

describe('the preview', () => {
	test('opens after a resting mouse, beside the mark, and closes when it leaves', async () => {
		vi.useFakeTimers();
		render(<DocsPage {...await data('en', CHIPS)} />);
		const { wrapper, body } = firstMore();

		fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
		expect(shown).toEqual([]);
		act(() => vi.advanceTimersByTime(PREVIEW_OPEN_DELAY));
		expect(shown).toEqual([body]);
		// Written by the placement, which happy-dom measures as zero-sized: below the mark by
		// the gap, and pinned to the margin.
		expect(body.style.top).toBe('6px');
		expect(body.style.left).toBe('8px');

		fireEvent.pointerLeave(wrapper, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_CLOSE_DELAY - 1));
		expect(hidden).toEqual([]);
		act(() => vi.advanceTimersByTime(1));
		expect(hidden).toEqual([body]);
	});

	test('survives the pointer crossing the gap onto it', async () => {
		vi.useFakeTimers();
		render(<DocsPage {...await data('en', CHIPS)} />);
		const { wrapper } = firstMore();
		fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_OPEN_DELAY));
		// Leaving the mark and arriving on the preview, which is the wrapper's descendant.
		fireEvent.pointerLeave(wrapper, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_CLOSE_DELAY / 2));
		fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_CLOSE_DELAY * 2));
		expect(hidden).toEqual([]);
		expect(shown).toHaveLength(1);
	});

	test('never opens for touch, where a tap is a click', async () => {
		vi.useFakeTimers();
		render(<DocsPage {...await data('en', CHIPS)} />);
		fireEvent.pointerEnter(firstMore().wrapper, { pointerType: 'touch' });
		act(() => vi.advanceTimersByTime(PREVIEW_OPEN_DELAY * 5));
		expect(shown).toEqual([]);
	});

	test('closes on Escape, and marks the key as taken', async () => {
		vi.useFakeTimers();
		render(<DocsPage {...await data('en', CHIPS)} />);
		const { wrapper, body } = firstMore();
		fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_OPEN_DELAY));
		const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		act(() => {
			document.dispatchEvent(escape);
		});
		expect(hidden).toEqual([body]);
		expect(escape.defaultPrevented).toBe(true);

		// And only once: the listener went with it.
		const again = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		act(() => {
			document.dispatchEvent(again);
		});
		expect(again.defaultPrevented).toBe(false);
	});

	test('closes on a scroll that takes the mark off screen, and not on a scroll inside itself', async () => {
		vi.useFakeTimers();
		render(<DocsPage {...await data('en', CHIPS)} />);
		const { wrapper, body } = firstMore();
		fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_OPEN_DELAY));
		fireEvent.scroll(body);
		expect(hidden).toEqual([]);
		// happy-dom measures every box as zero-sized at the origin, which is off screen.
		fireEvent.scroll(window);
		expect(hidden).toEqual([body]);
		// And the lengths it was placed with go with it, because a closed preview is laid out
		// as text in print, where a left-over max-height would cut it short.
		expect([body.style.top, body.style.left, body.style.maxHeight]).toEqual(['', '', '']);
	});

	test('is placed again, not closed, on a scroll that leaves the mark on screen', async () => {
		// The browser scrolls a focused mark into view, so closing on every scroll closed the
		// preview a keyboard had just opened.
		vi.useFakeTimers();
		render(<DocsPage {...await data('en', CHIPS)} />);
		const { wrapper, mark, body } = firstMore();
		// happy-dom lays out no viewport, so the root measures zero by zero.
		const root = document.documentElement;
		Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });
		Object.defineProperty(root, 'clientWidth', { value: 1280, configurable: true });
		let top = 100;
		mark.getBoundingClientRect = () =>
			({ top, bottom: top + 16, left: 40, right: 56, width: 16, height: 16 }) as DOMRect;
		fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_OPEN_DELAY));
		expect(body.style.top).toBe('122px');
		top = 300;
		fireEvent.scroll(window);
		expect(hidden).toEqual([]);
		expect(body.style.top).toBe('322px');
		delete (root as unknown as Record<string, unknown>)['clientHeight'];
		delete (root as unknown as Record<string, unknown>)['clientWidth'];
	});

	test('stays open while focus is inside it, whatever the pointer does', async () => {
		vi.useFakeTimers();
		render(<DocsPage {...await data('en', CHIPS)} />);
		const { wrapper, mark, body } = firstMore();
		fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_OPEN_DELAY));
		const link = body.querySelector('a') as HTMLAnchorElement;
		// From the mark into the link: a blur whose next target is still inside the wrapper.
		act(() => mark.focus());
		act(() => link.focus());
		fireEvent.pointerLeave(wrapper, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_CLOSE_DELAY * 4));
		expect(hidden).toEqual([]);
		expect(document.activeElement).toBe(link);
		// Focus leaving with the pointer already gone closes it.
		act(() => link.blur());
		expect(hidden).toEqual([body]);
	});

	test('is the only one open: opening another closes it first', () => {
		vi.useFakeTimers();
		const context = {
			locale: 'en' as const,
			contentLocale: 'en' as const,
			address: { basePath: '/docs', locale: 'en' as const },
			bundleBase: '/_docs',
			Link: PlainLink,
			emit: () => undefined,
		};
		const fold = (value: string) => ({
			type: 'more' as const,
			children: [{ type: 'text' as const, value }],
		});
		render(
			createElement(
				Fragment,
				null,
				renderBlocks([{ type: 'paragraph', children: [fold('One.'), fold('Two.')] }], context),
			),
		);
		const [first, second] = [...document.querySelectorAll('.hx-more')] as HTMLElement[];
		const [one, two] = [...document.querySelectorAll('.hx-more-body')] as HTMLElement[];
		fireEvent.pointerEnter(first as HTMLElement, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_OPEN_DELAY));
		fireEvent.pointerLeave(first as HTMLElement, { pointerType: 'mouse' });
		fireEvent.pointerEnter(second as HTMLElement, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_OPEN_DELAY));
		// The second opened at 100 ms, before the first's 150 ms close, and closed it.
		expect(shown).toEqual([one, two]);
		expect(hidden).toEqual([one]);
	});
});

describe('the preview from the keyboard', () => {
	/** Answers `:focus-visible` as told, which happy-dom cannot. */
	function visibleFocus(element: Element, visible: boolean): void {
		const matches = element.matches.bind(element);
		element.matches = (selector: string) =>
			selector === ':focus-visible' ? visible : matches(selector);
	}

	test('opens when the keyboard arrives on the mark, and not for a focus the reader did not see', async () => {
		render(<DocsPage {...await data('en', CHIPS)} />);
		const { mark, body } = firstMore();
		visibleFocus(mark, false);
		act(() => mark.focus());
		expect(shown).toEqual([]);
		act(() => mark.blur());
		visibleFocus(mark, true);
		act(() => mark.focus());
		expect(shown).toEqual([body]);
	});

	test('leaves an Escape another handler already took alone', async () => {
		vi.useFakeTimers();
		render(<DocsPage {...await data('en', CHIPS)} />);
		const { wrapper } = firstMore();
		fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_OPEN_DELAY));
		const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		taken.preventDefault();
		act(() => {
			document.dispatchEvent(taken);
		});
		expect(hidden).toEqual([]);
	});

	test('starts at the right-hand edge of the mark in a right-to-left page', async () => {
		vi.useFakeTimers();
		render(<DocsPage {...await data('en', CHIPS)} />);
		const { wrapper, mark, body } = firstMore();
		const root = document.documentElement;
		Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });
		Object.defineProperty(root, 'clientWidth', { value: 1280, configurable: true });
		mark.getBoundingClientRect = () =>
			({ top: 100, bottom: 116, left: 600, right: 616, width: 16, height: 16 }) as DOMRect;
		body.getBoundingClientRect = () =>
			({ top: 0, bottom: 80, left: 0, right: 200, width: 200, height: 80 }) as DOMRect;
		const computed = window.getComputedStyle.bind(window);
		vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) =>
			element === mark ? ({ direction: 'rtl' } as CSSStyleDeclaration) : computed(element, pseudo),
		);
		fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_OPEN_DELAY));
		expect(body.style.left).toBe('416px');
		delete (root as unknown as Record<string, unknown>)['clientHeight'];
		delete (root as unknown as Record<string, unknown>)['clientWidth'];
	});

	test('closes on a resize that leaves the mark off screen', async () => {
		vi.useFakeTimers();
		render(<DocsPage {...await data('en', CHIPS)} />);
		const { wrapper, body } = firstMore();
		fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_OPEN_DELAY));
		fireEvent(window, new Event('resize'));
		expect(hidden).toEqual([body]);
	});
});

describe('the reveal', () => {
	test('replaces the mark with the text, inline, and moves focus to it', async () => {
		render(<DocsPage {...await data('en', CHIPS)} />);
		const { wrapper, mark } = firstMore();
		await act(async () => {
			fireEvent.click(mark);
		});
		expect(wrapper.querySelector('.hx-more-mark')).toBeNull();
		expect(wrapper.hasAttribute('data-open')).toBe(true);
		const body = wrapper.querySelector('.hx-more-body') as HTMLElement;
		expect(body.hasAttribute('popover')).toBe(false);
		expect(body.textContent).toContain('ChangeFileSettings');
		// The control the reader was on is gone, so focus goes to what it revealed rather
		// than falling to the document.
		expect(document.activeElement).toBe(body);
	});

	test('does not follow the reader to another page', async () => {
		// React reuses the component at the same position in the next page's tree. Keyed to
		// the node, the reveal belongs to one payload, and a new page is folded again.
		const { rerender } = render(<DocsPage {...await data('en', CHIPS)} />);
		await act(async () => {
			fireEvent.click(firstMore().mark);
		});
		expect(document.querySelector('.hx-more[data-open]')).not.toBeNull();
		rerender(<DocsPage {...await data('ja', CHIPS)} />);
		expect(document.querySelector('.hx-more[data-open]')).toBeNull();
		expect(firstMore().mark.disabled).toBe(false);
	});
});
