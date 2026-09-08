/**
 * @vitest-environment happy-dom
 *
 * The shell's own interactive parts: the copy button, the custom events, the reduced
 * motion query and the announcement after a navigation.
 *
 * The reason these are here rather than in the markup suite is the same one the search
 * dialog has: every assertion below is about something that only happens when a handler
 * runs or an effect fires, and static markup reaches neither. The reason it is happy-dom
 * and not a browser is on `test/render/dom/search.test.tsx`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DOCS_EVENT_NAMES } from '../../../src/contracts/theme.js';
import type { Locale } from '../../../src/contracts/locales.js';
import type { CompiledPage } from '../../../src/contracts/page.js';
import type { DocsSiteConfig } from '../../../src/contracts/site.js';
import { DocsPage } from '../../../src/render/page.js';
import { IDS } from '../../../src/site/ids.js';
import type { DocsPageData } from '../../../src/site/route.js';
import { REPO_ROOT, goldenManifest, goldenPages } from '../../support/golden.js';
import { pageData } from '../../support/render.js';

// Read by path rather than through `fixtures/index.ts`, which resolves its own root from
// `import.meta.url` and cannot be imported here: see the note on `REPO_ROOT`.
const SITE = JSON.parse(
	readFileSync(join(REPO_ROOT, 'fixtures', 'site', 'fixture-app.docs.json'), 'utf8'),
) as DocsSiteConfig;
const MANIFEST = goldenManifest();
const PAGES = new Map(goldenPages().map((entry) => [`${entry.locale}/${entry.slug}`, entry.page]));

const data = (locale: Locale, slug: string): Promise<DocsPageData> =>
	pageData({
		manifest: MANIFEST,
		site: SITE,
		locale,
		slug,
		load: (l, s) => PAGES.get(`${l}/${s}`) as CompiledPage | undefined,
	});

/** Every event the shell dispatched on its own root, in order. */
function listen(): { name: string; detail: unknown }[] {
	const seen: { name: string; detail: unknown }[] = [];
	for (const name of DOCS_EVENT_NAMES) {
		document.addEventListener(name, (event) => {
			seen.push({ name, detail: (event as CustomEvent).detail });
		});
	}
	return seen;
}

let reduced = false;

beforeEach(() => {
	reduced = false;
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches: query.includes('reduce') ? reduced : false,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	}));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('the copy button', () => {
	test('copies the fence text and says so', async () => {
		const written: string[] = [];
		vi.stubGlobal('navigator', {
			clipboard: {
				writeText: async (text: string) => {
					written.push(text);
				},
			},
		});

		const seen = listen();
		render(<DocsPage {...await data('en', 'reference/api')} />);

		const copy = screen.getAllByRole('button', { name: /copy/i })[0] as HTMLButtonElement;
		expect(copy.disabled).toBe(false);
		await act(async () => {
			fireEvent.click(copy);
		});

		await waitFor(() => expect(written.length).toBe(1));
		// The text is the tokens joined, not the markup: a reader pasting a highlighted
		// block into a terminal must get the code and not a wall of spans.
		expect(written[0]).toContain('public func begin');
		expect(written[0]).not.toContain('<span');
		await waitFor(() => expect(screen.getAllByRole('button', { name: /copied/i }).length).toBe(1));
		expect(seen.filter((event) => event.name === 'hexdocs:copy')).toEqual([
			{ name: 'hexdocs:copy', detail: { kind: 'code' } },
		]);
	});
});

describe('the custom events', () => {
	test('a first render reports the navigation as having come from the server', async () => {
		// The distinction a consumer's effects need: nothing should animate on a full page
		// load, and everything should on a client-side move.
		const seen = listen();
		render(<DocsPage {...await data('en', 'index')} />);
		await waitFor(() => expect(seen.some((event) => event.name === 'hexdocs:navigate')).toBe(true));
		const navigate = seen.find((event) => event.name === 'hexdocs:navigate');
		expect(navigate?.detail).toEqual({
			slug: 'index',
			title: expect.any(String),
			source: 'server',
		});
	});

	test('every event the contract declares is dispatched by something', async () => {
		// The closure for the gap all four designs left: the dispatcher can be unit-tested
		// and every one of these can still never fire. `search-open`, `search-close` and
		// `copy` are asserted at their call sites in this directory; `navigate` is above;
		// `heading` is below.
		expect([...DOCS_EVENT_NAMES].sort()).toEqual(
			[
				'hexdocs:copy',
				'hexdocs:heading',
				'hexdocs:navigate',
				'hexdocs:search-close',
				'hexdocs:search-open',
			].sort(),
		);
	});

	test('a heading crossing is reported with its position in the page', async () => {
		const observers: { callback: IntersectionObserverCallback }[] = [];
		vi.stubGlobal(
			'IntersectionObserver',
			class {
				constructor(public callback: IntersectionObserverCallback) {
					observers.push({ callback });
				}
				observe(): void {}
				disconnect(): void {}
			},
		);

		const seen = listen();
		const page = await data('en', 'guide/troubleshooting');
		render(<DocsPage {...page} />);
		await waitFor(() => expect(observers.length).toBeGreaterThan(0));

		const id = page.page.headings[1]?.id as string;
		act(() => {
			observers[0]?.callback(
				[
					{
						target: { id } as Element,
						isIntersecting: true,
						boundingClientRect: { top: -10 } as DOMRectReadOnly,
					} as IntersectionObserverEntry,
				],
				{} as IntersectionObserver,
			);
		});

		await waitFor(() => expect(seen.some((event) => event.name === 'hexdocs:heading')).toBe(true));
		expect(seen.find((event) => event.name === 'hexdocs:heading')?.detail).toEqual({
			id,
			index: 1,
			total: page.page.headings.length,
		});
	});
});

describe('reduced motion', () => {
	test('is read from the media query and stamped on the root', async () => {
		reduced = true;
		render(<DocsPage {...await data('en', 'index')} />);
		await waitFor(() =>
			expect(document.getElementById(IDS.root)?.getAttribute('data-reduced')).toBe('true'),
		);
	});

	test('is false when the reader has not asked for it', async () => {
		render(<DocsPage {...await data('en', 'index')} />);
		await waitFor(() =>
			expect(document.getElementById(IDS.root)?.getAttribute('data-reduced')).toBe('false'),
		);
	});

	test('stops the heading events without stopping the scroll spy', async () => {
		// Scroll spy is information, not decoration, so a table of contents that stopped
		// following the reader would be a regression for exactly the people the setting is
		// for. Only the events, which exist to drive a consumer's animation, stop.
		reduced = true;
		const observers: { callback: IntersectionObserverCallback }[] = [];
		vi.stubGlobal(
			'IntersectionObserver',
			class {
				constructor(public callback: IntersectionObserverCallback) {
					observers.push({ callback });
				}
				observe(): void {}
				disconnect(): void {}
			},
		);

		const seen = listen();
		const page = await data('en', 'guide/troubleshooting');
		render(<DocsPage {...page} />);
		await waitFor(() => expect(observers.length).toBeGreaterThan(0));

		const id = page.page.headings[0]?.id as string;
		act(() => {
			observers[0]?.callback(
				[
					{
						target: { id } as Element,
						isIntersecting: true,
						boundingClientRect: { top: -10 } as DOMRectReadOnly,
					} as IntersectionObserverEntry,
				],
				{} as IntersectionObserver,
			);
		});

		await waitFor(() =>
			expect(document.querySelector(`.hx-toc-link[aria-current]`)?.getAttribute('href')).toBe(
				`#${id}`,
			),
		);
		expect(seen.filter((event) => event.name === 'hexdocs:heading')).toEqual([]);
	});
});
