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

import type { Locale } from '../../../src/contracts/locales.js';
import type { CompiledPage } from '../../../src/contracts/page.js';
import type { DocsSiteConfig } from '../../../src/contracts/site.js';
import { PREVIEW_CLOSE_DELAY, PREVIEW_OPEN_DELAY } from '../../../src/render/client.js';
import { DocsPage } from '../../../src/render/page.js';
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

	test('closes on a scroll of the page, and not on a scroll inside itself', async () => {
		vi.useFakeTimers();
		render(<DocsPage {...await data('en', CHIPS)} />);
		const { wrapper, body } = firstMore();
		fireEvent.pointerEnter(wrapper, { pointerType: 'mouse' });
		act(() => vi.advanceTimersByTime(PREVIEW_OPEN_DELAY));
		fireEvent.scroll(body);
		expect(hidden).toEqual([]);
		fireEvent.scroll(window);
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
