/**
 * @vitest-environment happy-dom
 *
 * Who scrolls after a client-side navigation between two docs pages.
 *
 * Both consumers render React Router's `<ScrollRestoration />` in their root layout. It
 * scrolls in a layout effect when the location changes: to the saved position on a back
 * or forward navigation, to the element a hash names, or to the top. The shell's own
 * navigation effect is a passive effect, and passive effects run after every layout effect
 * in the same commit, so anything the shell scrolls there has the last word.
 *
 * Framework mode matters to the setup, and it is reproduced rather than assumed. The Vite
 * plugin wraps a route module's default export once, at module level, so every page row
 * that names `routes/docs.tsx` renders the same component function. React Router renders a
 * leaf with no key, so moving from one docs page to another keeps the shell mounted and its
 * effect sees a changed slug rather than a first commit. Two routes sharing one `Component`
 * here are that shape.
 *
 * What this cannot say is where the page ends up. happy-dom has no layout, so a scroll call
 * moves nothing; the assertion is on the order of the calls, which is the whole of the
 * question, because the last call a browser receives is the position the reader is left at.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import {
	createMemoryRouter,
	Link,
	Outlet,
	RouterProvider,
	ScrollRestoration,
	useLoaderData,
} from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Locale } from '../../../src/contracts/locales.js';
import type { CompiledPage } from '../../../src/contracts/page.js';
import type { DocsSiteConfig } from '../../../src/contracts/site.js';
import { DocsPage } from '../../../src/render/page.js';
import type { DocsPageData } from '../../../src/site/route.js';
import { REPO_ROOT, goldenManifest, goldenPages } from '../../support/golden.js';
import { pageData } from '../../support/render.js';

const SITE = JSON.parse(
	readFileSync(join(REPO_ROOT, 'fixtures', 'site', 'fixture-app.docs.json'), 'utf8'),
) as DocsSiteConfig;
const MANIFEST = goldenManifest();
const PAGES = new Map(goldenPages().map((entry) => [`${entry.locale}/${entry.slug}`, entry.page]));

const data = (slug: string): Promise<DocsPageData> =>
	pageData({
		manifest: MANIFEST,
		site: SITE,
		locale: 'en',
		slug,
		load: (l, s) => PAGES.get(`${l}/${s}`) as CompiledPage | undefined,
	});

/** One component function for both rows, as the Vite plugin produces for one module. */
function DocsRoute() {
	return <DocsPage {...(useLoaderData() as DocsPageData)} Link={Link} />;
}

/** Every scroll the page asked the browser for, in order. */
const scrolls: string[] = [];
const scrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
	scrolls.length = 0;
	vi.stubGlobal('matchMedia', () => ({
		matches: false,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	}));
	vi.spyOn(window, 'scrollTo').mockImplementation(((...args: unknown[]) => {
		const first = args[0];
		scrolls.push(
			typeof first === 'object' && first !== null
				? `to top from the shell`
				: `to ${String(args[1])} from the router`,
		);
	}) as typeof window.scrollTo);
	Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
		scrolls.push(`into #${this.id}`);
	};
});

afterEach(() => {
	cleanup();
	Element.prototype.scrollIntoView = scrollIntoView;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function mountRouter(): Promise<ReturnType<typeof createMemoryRouter>> {
	const first = await data('guide/first-tag');
	const second = await data('guide/troubleshooting');
	const router = createMemoryRouter(
		[
			{
				id: 'root',
				path: '/',
				element: (
					<>
						<Outlet />
						<ScrollRestoration />
					</>
				),
				children: [
					{
						id: 'first',
						path: 'fixture-app/docs/guide/first-tag',
						loader: () => first,
						Component: DocsRoute,
					},
					{
						id: 'second',
						path: 'fixture-app/docs/guide/troubleshooting',
						loader: () => second,
						Component: DocsRoute,
					},
				],
			},
		],
		{ initialEntries: ['/fixture-app/docs/guide/first-tag'] },
	);
	render(<RouterProvider router={router} />);
	await waitFor(() =>
		expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(first.page.title),
	);
	scrolls.length = 0;
	return router;
}

describe('a client-side navigation between docs pages', () => {
	test('to an address with a hash leaves the reader at the heading the hash names', async () => {
		// The case search results produce: every hit below a page's top is a link to another
		// page with an anchor. Scrolling to the top afterwards sends the reader to the start of
		// a page they asked to see the middle of.
		const router = await mountRouter();
		const second = await data('guide/troubleshooting');
		const target = second.page.headings[1]?.id as string;

		await act(async () => {
			await router.navigate(`/fixture-app/docs/guide/troubleshooting#${target}`);
		});
		await waitFor(() =>
			expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(second.page.title),
		);

		expect(scrolls.at(-1), `scrolls in order: ${scrolls.join(', ')}`).toBe(`into #${target}`);
	});

	test('back to a page leaves the reader where the router restored them', async () => {
		const router = await mountRouter();
		await act(async () => {
			await router.navigate('/fixture-app/docs/guide/troubleshooting');
		});
		await act(async () => {
			await router.navigate(-1);
		});
		await waitFor(() =>
			expect(router.state.location.pathname).toBe('/fixture-app/docs/guide/first-tag'),
		);

		expect(scrolls.at(-1), `scrolls in order: ${scrolls.join(', ')}`).toMatch(/from the router$/);
		expect(scrolls).not.toContain('to top from the shell');
	});

	test('still moves focus into the article, without scrolling to do it', async () => {
		// The half of the effect that stays. React Router does not move focus on a navigation,
		// and a keyboard reader left on the link they activated is on a page that no longer
		// contains it.
		const router = await mountRouter();
		const focus = vi.spyOn(HTMLElement.prototype, 'focus');
		await act(async () => {
			await router.navigate('/fixture-app/docs/guide/troubleshooting');
		});
		await waitFor(() => expect(focus).toHaveBeenCalledWith({ preventScroll: true }));
		expect(focus.mock.contexts.at(-1)).toBe(document.getElementById('hx-content'));
	});

	test('closes the phone disclosures a reader opened to get there, and focus is on the article', async () => {
		// A client-side navigation does not reload the document, so the tree the reader opened
		// to pick a page would otherwise still be open over the page they picked.
		const router = await mountRouter();
		const tree = document.querySelector('.hx-tree-disclosure') as HTMLDetailsElement;
		const toc = document.querySelector('.hx-toc-disclosure') as HTMLDetailsElement;
		// Focus first, then open: focus landing outside the bar closes the outline by itself, and
		// what is under test here is the navigation closing it.
		(document.querySelector('.hx-tree-link') as HTMLElement).focus();
		tree.open = true;
		toc.open = true;

		await act(async () => {
			await router.navigate('/fixture-app/docs/guide/troubleshooting');
		});
		await waitFor(() => expect(document.activeElement).toBe(document.getElementById('hx-content')));

		// The same two elements, kept by React across the navigation, now closed.
		expect(document.querySelector('.hx-tree-disclosure')).toBe(tree);
		expect(document.querySelector('.hx-toc-disclosure')).toBe(toc);
		expect([tree.open, toc.open]).toEqual([false, false]);
	});

	test('closes them when only the language changes, which keeps the same page mounted', async () => {
		// The consumers' shape: a `:lang` layout route with the page row under it, loading by the
		// parameter. A host's language picker moves between two of its addresses, so the slug is
		// the same, the shell stays mounted, and the page it shows is a different one.
		const load = (locale: Locale): Promise<DocsPageData> =>
			pageData({
				manifest: MANIFEST,
				site: SITE,
				locale,
				slug: 'guide/first-tag',
				load: (l, s) => PAGES.get(`${l}/${s}`) as CompiledPage | undefined,
			});
		const pages = { fr: await load('fr'), ja: await load('ja') };
		const router = createMemoryRouter(
			[
				{
					id: 'lang',
					path: '/:lang',
					element: <Outlet />,
					children: [
						{
							id: 'page',
							path: 'fixture-app/docs/guide/first-tag',
							loader: ({ params }) => pages[params.lang as keyof typeof pages],
							Component: DocsRoute,
						},
					],
				},
			],
			{ initialEntries: ['/fr/fixture-app/docs/guide/first-tag'] },
		);
		render(<RouterProvider router={router} />);
		await waitFor(() =>
			expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(pages.fr.page.title),
		);
		const tree = document.querySelector('.hx-tree-disclosure') as HTMLDetailsElement;
		const toc = document.querySelector('.hx-toc-disclosure') as HTMLDetailsElement;
		tree.open = true;
		toc.open = true;

		await act(async () => {
			await router.navigate('/ja/fixture-app/docs/guide/first-tag');
		});
		await waitFor(() =>
			expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(pages.ja.page.title),
		);
		await waitFor(() => expect(document.activeElement).toBe(document.getElementById('hx-content')));
		expect(document.querySelector('.hx-tree-disclosure')).toBe(tree);
		expect([tree.open, toc.open]).toEqual([false, false]);
	});

	test('closes them on a move between two projects that share a slug, which keeps the page mounted', async () => {
		// One route module serves every project on a site, so two mounts render the same component
		// function, and every scaffolded home is `index`. A key of the locale and the slug alone
		// saw no navigation here and left both disclosures open above and over the other project's
		// home, while focus moved into its article.
		const first = await data('index');
		const other = await pageData({
			manifest: MANIFEST,
			site: { ...SITE, basePath: '/other-app/docs' },
			locale: 'en',
			slug: 'index',
			load: (l, s) => PAGES.get(`${l}/${s}`) as CompiledPage | undefined,
		});
		const second: DocsPageData = {
			...other,
			page: { ...other.page, title: 'Other app documentation' },
		};
		const router = createMemoryRouter(
			[
				{
					id: 'root',
					path: '/',
					element: <Outlet />,
					children: [
						{ id: 'first', path: 'fixture-app/docs', loader: () => first, Component: DocsRoute },
						{ id: 'second', path: 'other-app/docs', loader: () => second, Component: DocsRoute },
					],
				},
			],
			{ initialEntries: ['/fixture-app/docs'] },
		);
		render(<RouterProvider router={router} />);
		await waitFor(() =>
			expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(first.page.title),
		);
		const tree = document.querySelector('.hx-tree-disclosure') as HTMLDetailsElement;
		const toc = document.querySelector('.hx-toc-disclosure') as HTMLDetailsElement;
		expect(toc).not.toBeNull();
		tree.open = true;
		toc.open = true;

		await act(async () => {
			await router.navigate('/other-app/docs');
		});
		await waitFor(() =>
			expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(second.page.title),
		);
		await waitFor(() => expect(document.activeElement).toBe(document.getElementById('hx-content')));
		expect(document.querySelector('.hx-tree-disclosure')).toBe(tree);
		expect([tree.open, toc.open]).toEqual([false, false]);
	});

	test('leaves a disclosure the reader opened alone when nothing navigated', async () => {
		// A re-render on the same page is not a navigation, and neither is the first commit:
		// closing on either would shut a tree the reader opened before hydration finished.
		const router = await mountRouter();
		const tree = document.querySelector('.hx-tree-disclosure') as HTMLDetailsElement;
		tree.open = true;
		await act(async () => {
			await router.navigate('/fixture-app/docs/guide/first-tag#before-you-start');
		});
		expect(tree.open).toBe(true);
	});
});
