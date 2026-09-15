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
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
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

/**
 * A stand-in `IntersectionObserver` and a way to hand it entries.
 *
 * `top` is the heading's distance from the top of the viewport. A heading at or above the
 * line intersects the spy's root, which reaches far above the screen; one that does not
 * intersect with a positive top is below the line, which is the only state the spy forgets a
 * heading in. This hands over exactly the entries a test writes, so it shows what the spy does
 * with an entry and never which entries a browser would send: `layoutObserver` is for that.
 */
function stubObserver(): {
	ready: () => Promise<void>;
	report: (id: string, isIntersecting: boolean, top: number) => void;
} {
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
	return {
		ready: () => waitFor(() => expect(observers.length).toBeGreaterThan(0)),
		report: (id, isIntersecting, top) => {
			act(() => {
				observers.at(-1)?.callback(
					[
						{
							target: { id } as Element,
							isIntersecting,
							boundingClientRect: { top } as DOMRectReadOnly,
						} as IntersectionObserverEntry,
					],
					{} as IntersectionObserver,
				);
			});
		},
	};
}

/** How tall a heading is in `layoutObserver`'s page. Any positive height gives the same answers. */
const HEADING_HEIGHT = 32;

/**
 * An `IntersectionObserver` that decides which entries to send, the way a browser's does.
 *
 * It reads the root margin the spy asked for, places each heading at a top in a page whose
 * viewport is `viewport` tall, and on every scroll queues an entry only for a heading whose
 * intersection with the root changed, plus one for each heading when it is first observed. That
 * is the rule a browser follows and the whole of the jump defect: a heading carried across the
 * line without ever being inside the root changes nothing and reports nothing. Only the top and
 * bottom margins are read, in `px` or in `%` of the viewport height, because those are the only
 * two that move the line or the root's far edge; anything else is refused by name.
 */
function layoutObserver(viewport: number): {
	place: (tops: ReadonlyMap<string, number>) => void;
	ready: (count: number) => Promise<void>;
	scroll: (y: number) => void;
	passed: (order: readonly string[]) => string | undefined;
} {
	const page = new Map<string, number>();
	let scrollY = 0;
	const records: {
		callback: IntersectionObserverCallback;
		top: number;
		bottom: number;
		state: Map<Element, boolean | undefined>;
	}[] = [];
	const margin = (token: string | undefined): number => {
		const match = /^(-?\d+(?:\.\d+)?)(px|%)$/.exec(token ?? '');
		if (match === null) throw new Error(`A root margin this observer cannot read: ${token}`);
		return match[2] === '%' ? (Number(match[1]) / 100) * viewport : Number(match[1]);
	};
	vi.stubGlobal(
		'IntersectionObserver',
		class {
			private readonly record: (typeof records)[number];
			constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
				// The shorthand's order is top, right, bottom, left, and bottom falls back to top.
				const tokens = (options?.rootMargin ?? '0px').trim().split(/\s+/);
				this.record = {
					callback,
					top: margin(tokens[0]),
					bottom: margin(tokens[2] ?? tokens[0]),
					state: new Map(),
				};
				records.push(this.record);
			}
			observe(target: Element): void {
				this.record.state.set(target, undefined);
			}
			disconnect(): void {
				this.record.state.clear();
			}
		},
	);
	const deliver = (): void => {
		for (const record of records) {
			const entries: IntersectionObserverEntry[] = [];
			for (const [target, was] of record.state) {
				const top = (page.get(target.id) ?? Number.POSITIVE_INFINITY) - scrollY;
				const now = top < viewport + record.bottom && top + HEADING_HEIGHT > -record.top;
				if (now === was) continue;
				record.state.set(target, now);
				entries.push({
					target,
					isIntersecting: now,
					boundingClientRect: { top } as DOMRectReadOnly,
				} as IntersectionObserverEntry);
			}
			if (entries.length > 0) {
				act(() => record.callback(entries, {} as IntersectionObserver));
			}
		}
	};
	return {
		place: (tops) => {
			for (const [id, top] of tops) page.set(id, top);
		},
		ready: async (count) => {
			await waitFor(() => expect(records.at(-1)?.state.size).toBe(count));
			deliver();
		},
		scroll: (y) => {
			scrollY = y;
			deliver();
		},
		// The spy's own definition, read off the page rather than off the entries: the last
		// heading whose top is above the line 30% down the viewport.
		passed: (order) => order.filter((id) => (page.get(id) ?? 0) - scrollY < viewport * 0.3).at(-1),
	};
}

const currentTocHref = (): string | null | undefined =>
	document.querySelector('.hx-toc-link[aria-current]')?.getAttribute('href');

/** The heading the phone's bar names, which is empty until the spy answers. */
const barText = (): string | null | undefined =>
	document.querySelector('.hx-toc-here')?.textContent;

describe('the heading the table of contents marks', () => {
	test('is the last one the reader has passed, and goes back when they scroll up', async () => {
		// Two entries, so accumulation is what is under test. The observer keeps every
		// heading that has passed, and a spy that named the first of them marked the page's
		// first heading for the whole read, which one entry at a time can never show. The
		// bar reads the same answer, so it is asserted beside the mark at every step.
		const observer = stubObserver();
		const page = await data('en', 'guide/troubleshooting');
		render(<DocsPage {...page} />);
		await observer.ready();
		const [first, second] = page.page.headings;
		expect(second).toBeDefined();
		if (first === undefined || second === undefined) return;

		expect(currentTocHref()).toBeUndefined();
		expect(barText()).toBe('');
		observer.report(first.id, true, -40);
		await waitFor(() => expect(currentTocHref()).toBe(`#${first.id}`));
		expect(barText()).toBe(first.text);
		observer.report(second.id, true, 60);
		await waitFor(() => expect(currentTocHref()).toBe(`#${second.id}`));
		expect(barText()).toBe(second.text);
		// Back below the band: the spy forgets it, and the reader is in the first section again.
		observer.report(second.id, false, 800);
		await waitFor(() => expect(currentTocHref()).toBe(`#${first.id}`));
		expect(barText()).toBe(first.text);
		expect(document.querySelectorAll('.hx-toc-link[aria-current]').length).toBe(1);
	});

	/** Asserts the bar and the outline both name the heading the page's geometry says. */
	const expectNamed = (
		where: string,
		headings: readonly { id: string; text: string }[],
		id: string | undefined,
	): void => {
		const heading = headings.find((candidate) => candidate.id === id);
		expect({ where, bar: barText(), current: currentTocHref() }).toEqual({
			where,
			bar: heading?.text ?? '',
			current: heading === undefined ? undefined : `#${heading.id}`,
		});
	};

	test('is still right after a jump that carries headings past the line in one step', async () => {
		// The bar's Pages link from the end of a page, an outline pick upwards and a jump to the
		// end each move the page thousands of pixels in one frame. An observer whose root ended at
		// the top of the screen sent no entry for the headings in between, because each was
		// outside the root before and after, and the bar went on naming a heading the reader had
		// left. Reading down in small steps is right either way, which is why the jumps are here.
		const viewport = 844;
		const layout = layoutObserver(viewport);
		const page = await data('en', 'guide/troubleshooting');
		const headings = page.page.headings;
		const order = headings.map((heading) => heading.id);
		expect(headings.length).toBeGreaterThanOrEqual(4);
		// Two thousand pixels a section, which is a long manual page on a phone.
		layout.place(new Map(order.map((id, index) => [id, 2000 * (index + 1)])));
		render(<DocsPage {...page} />);
		await layout.ready(headings.length);
		const end = 2000 * headings.length + 1000;

		expectNamed('at the top', headings, layout.passed(order));
		for (let y = 100; y <= end; y += 100) {
			layout.scroll(y);
			expectNamed(`reading down at ${y}px`, headings, layout.passed(order));
		}
		expect(layout.passed(order)).toBe(order.at(-1));

		layout.scroll(0);
		expectNamed('jumped from the end to the top', headings, undefined);
		layout.scroll(end);
		expectNamed('jumped from the top to the end', headings, order.at(-1));
		// The second heading lands just under the host's header.
		layout.scroll(2000 * 2 - 80);
		expectNamed('jumped up to the second heading', headings, order[1]);
		expect(document.querySelectorAll('.hx-toc-link[aria-current]').length).toBe(1);
	});

	test('still names the heading of a section longer than the root reaches above the screen', async () => {
		// Past the root's far edge a heading stops intersecting, and its entry has a negative
		// top. A callback that kept only intersecting headings would empty the bar there, a
		// hundred screens into one long section, with the reader still inside it.
		const viewport = 844;
		const layout = layoutObserver(viewport);
		const page = await data('en', 'guide/troubleshooting');
		const headings = page.page.headings;
		const order = headings.map((heading) => heading.id);
		layout.place(
			new Map(order.map((id, index) => [id, index === 0 ? 2000 : 400_000 + 2000 * index])),
		);
		render(<DocsPage {...page} />);
		await layout.ready(headings.length);
		for (let y = 20_000; y <= 380_000; y += 20_000) {
			layout.scroll(y);
			expectNamed(`${y}px into the first section`, headings, order[0]);
		}
	});
});

describe('hydrating over a disclosure the reader already opened', () => {
	test('keeps it open, and React says nothing about it', async () => {
		// Both disclosures work before the script arrives, so a reader on a slow connection
		// can open one before hydration. React never passes `open`, so it has nothing to
		// reconcile, and the navigation effect does nothing on the first commit, so nothing
		// closes it either. Rendered to a string and hydrated, which is the real sequence.
		const page = await data('en', 'guide/troubleshooting');
		const container = document.createElement('div');
		container.innerHTML = renderToString(<DocsPage {...page} />);
		document.body.appendChild(container);
		const tree = container.querySelector('.hx-tree-disclosure') as HTMLDetailsElement;
		const toc = container.querySelector('.hx-toc-disclosure') as HTMLDetailsElement;
		tree.open = true;

		// Every console.error is recorded, not only hydration's: a mismatch React reports about
		// `open` is the defect, and it arrives through this call in development builds.
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		let root: Root | undefined;
		try {
			await act(async () => {
				root = hydrateRoot(container, <DocsPage {...page} />);
			});
			await waitFor(() =>
				expect((container.querySelector('.hx-search-trigger') as HTMLButtonElement).disabled).toBe(
					false,
				),
			);
			expect(container.querySelector('.hx-tree-disclosure')).toBe(tree);
			expect([tree.open, toc.open]).toEqual([true, false]);
			expect(errors.mock.calls.map((call) => String(call[0]).slice(0, 80))).toEqual([]);
		} finally {
			act(() => root?.unmount());
			container.remove();
		}
	});
});

describe('the phone disclosures', () => {
	const disclosure = (name: 'tree' | 'toc'): HTMLDetailsElement =>
		document.querySelector(`.hx-${name}-disclosure`) as HTMLDetailsElement;

	test('following a row in the outline closes it on the next frame, and leaves the jump alone', async () => {
		// Deferred, because closing inside the click hides the link before its default action
		// runs, and never prevented, because the fragment navigation, its history entry and the
		// focus starting point all belong to the browser.
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			frames.push(callback);
			return frames.length;
		});
		render(<DocsPage {...await data('en', 'guide/troubleshooting')} />);
		const toc = disclosure('toc');
		toc.open = true;

		const link = document.querySelector('.hx-toc-link') as HTMLAnchorElement;
		expect(fireEvent.click(link)).toBe(true);
		expect(toc.open).toBe(true);
		expect(frames.length).toBe(1);
		act(() => frames.forEach((frame) => frame(0)));
		expect(toc.open).toBe(false);

		// A click on the list that is not on a link, and a link outside it, schedule nothing.
		toc.open = true;
		fireEvent.click(document.querySelector('.hx-toc-item') as HTMLElement);
		fireEvent.click(document.querySelector('.hx-foot-pages') as HTMLElement);
		expect(frames.length).toBe(1);
	});

	test('a frame that runs after the shell has gone closes nothing and throws nothing', async () => {
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			frames.push(callback);
			return frames.length;
		});
		const { unmount } = render(<DocsPage {...await data('en', 'guide/troubleshooting')} />);
		disclosure('toc').open = true;
		fireEvent.click(document.querySelector('.hx-toc-link') as HTMLAnchorElement);
		// The shell is gone by the time the frame runs, so there is nothing left to close.
		unmount();
		expect(() => frames.forEach((frame) => frame(0))).not.toThrow();
	});

	test('Escape inside an open disclosure closes it and puts focus on its summary', async () => {
		render(<DocsPage {...await data('en', 'guide/troubleshooting')} />);
		for (const name of ['tree', 'toc'] as const) {
			const details = disclosure(name);
			details.open = true;
			const row = document.querySelector(`.hx-${name}-link`) as HTMLAnchorElement;
			row.focus();
			fireEvent.keyDown(row, { key: 'Escape' });
			expect({ name, open: details.open }).toEqual({ name, open: false });
			expect(document.activeElement).toBe(details.querySelector('summary'));
		}
	});

	test('any other key, or Escape on a closed disclosure, changes nothing', async () => {
		render(<DocsPage {...await data('en', 'guide/troubleshooting')} />);
		const tree = disclosure('tree');
		const row = document.querySelector('.hx-tree-link') as HTMLAnchorElement;
		tree.open = true;
		fireEvent.keyDown(row, { key: 'Enter' });
		expect(tree.open).toBe(true);
		tree.open = false;
		row.focus();
		fireEvent.keyDown(row, { key: 'Escape' });
		expect(document.activeElement).toBe(row);
	});

	test('Escape inside the search dialog belongs to the dialog, and leaves the tree open', async () => {
		// The dialog is rendered inside the tree's landmark, so its Escape bubbles through the
		// tree's handler on the way out. Closing the tree as well would take the reader
		// somewhere they did not ask to go.
		render(<DocsPage {...await data('en', 'guide/troubleshooting')} />);
		const tree = disclosure('tree');
		tree.open = true;
		const input = document.getElementById(IDS.searchInput) as HTMLInputElement;
		expect(input.closest(`#${IDS.searchDialog}`)).not.toBeNull();
		fireEvent.keyDown(input, { key: 'Escape' });
		expect(tree.open).toBe(true);
	});

	test('the bar Pages link opens the tree, closes the outline, and still jumps', async () => {
		render(<DocsPage {...await data('en', 'guide/troubleshooting')} />);
		const tree = disclosure('tree');
		const toc = disclosure('toc');
		toc.open = true;
		const link = document.querySelector('.hx-foot-pages') as HTMLAnchorElement;
		expect(link.getAttribute('href')).toBe(`#${IDS.tree}`);
		expect(fireEvent.click(link)).toBe(true);
		expect(tree.open).toBe(true);
		expect(toc.open).toBe(false);
	});

	test('the bar Pages link works on a page with no outline', async () => {
		render(<DocsPage {...await data('ja', 'reference/chip-support')} />);
		expect(document.querySelector('.hx-toc-disclosure')).toBeNull();
		const link = document.querySelector('.hx-foot-pages') as HTMLAnchorElement;
		expect(fireEvent.click(link)).toBe(true);
		expect(disclosure('tree').open).toBe(true);
	});

	test('opening a panel scrolls it so the current row sits two fifths down', async () => {
		// Arithmetic on the panel's own scrollTop, because scrollIntoView would move the
		// document under the reader as well. happy-dom has no layout, so the two lengths the
		// arithmetic reads are given to it.
		render(<DocsPage {...await data('en', 'guide/troubleshooting')} />);
		const tree = disclosure('tree');
		const panel = tree.nextElementSibling as HTMLElement;
		const current = panel.querySelector('[aria-current]') as HTMLElement;
		expect(current).not.toBeNull();
		Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 500 });
		Object.defineProperty(current, 'offsetTop', { configurable: true, value: 900 });

		tree.open = true;
		expect(panel.scrollTop).toBe(900 - 0.4 * 500);

		// Closing does not scroll, and a row near the top never asks for a negative position.
		panel.scrollTop = 12;
		tree.open = false;
		expect(panel.scrollTop).toBe(12);
		Object.defineProperty(current, 'offsetTop', { configurable: true, value: 40 });
		tree.open = true;
		expect(panel.scrollTop).toBe(0);
	});

	test('a panel with no current row opens where it is, and nothing throws', async () => {
		// The outline before the spy has named a heading: there is no row to scroll to.
		render(<DocsPage {...await data('en', 'guide/troubleshooting')} />);
		const toc = disclosure('toc');
		const panel = toc.nextElementSibling as HTMLElement;
		expect(panel.querySelector('[aria-current]')).toBeNull();
		expect(() => {
			toc.open = true;
		}).not.toThrow();
		expect(panel.scrollTop).toBe(0);
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
