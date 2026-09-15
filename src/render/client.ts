/**
 * Everything in this package that touches the browser.
 *
 * Nothing else reads `window`, `document`, `navigator` or `matchMedia`, which is what
 * makes the rest of the renderer a pure function of its props and testable by calling it.
 * It is also what makes the hydration story reviewable in one file rather than in nine.
 *
 * ## The rule these all follow
 *
 * The server renders the state a reader with no JavaScript would see, and an effect moves
 * to the state a reader with JavaScript gets. That is the only ordering that is honest in
 * both directions: a control that is announced as available and does nothing is worse than
 * one that says it is not ready yet, and a first paint that assumes the script ran is a
 * hydration mismatch on every one of these.
 *
 * `useSyncExternalStore` rather than `useState` plus `useEffect`, because it is the API
 * that takes a server snapshot as a separate argument. The effect form renders the client
 * value on the first client pass and mismatches; this one cannot.
 */

import {
	useCallback,
	useEffect,
	useRef,
	useSyncExternalStore,
	type KeyboardEvent,
	type MouseEvent,
	type RefObject,
	type SyntheticEvent,
} from 'react';

import type { PageHeading } from '../contracts/page.js';
import type { DocsEventMap } from '../contracts/theme.js';
import type { EmitFn } from './context.js';

/**
 * A store whose value is "the client is running", which is false on the server and true
 * from the first client render onwards.
 *
 * The subscribe function never calls back, because the value never changes within a
 * session: React reads `getSnapshot` on the client and `getServerSnapshot` on the server,
 * and the difference between the two is exactly the state change we want.
 */
const noSubscribe = (): (() => void) => () => undefined;
const clientTrue = (): boolean => true;
const serverFalse = (): boolean => false;

/** Whether the page is interactive. False in the server's markup, true after hydration. */
export function useHydrated(): boolean {
	return useSyncExternalStore(noSubscribe, clientTrue, serverFalse);
}

/**
 * Whether the reader has asked for reduced motion.
 *
 * `false` on the server, because a media query has no answer there and guessing `true`
 * would send a still first paint to every reader. The stylesheet does not depend on this:
 * `@media (prefers-reduced-motion: reduce)` needs no JavaScript and is the real gate. This
 * value exists for the two decisions CSS cannot make, which are whether a scroll is smooth
 * and whether the `hexdocs:heading` events fire at all.
 */
export function useReducedMotion(): boolean {
	const subscribe = useCallback((onChange: () => void) => {
		const query = window.matchMedia('(prefers-reduced-motion: reduce)');
		query.addEventListener('change', onChange);
		return () => query.removeEventListener('change', onChange);
	}, []);
	return useSyncExternalStore(
		subscribe,
		() => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
		() => false,
	);
}

/**
 * The typed dispatcher, bound to the docs root element.
 *
 * Events go on the package's own root rather than on `window`, so a consumer listens to
 * the element it mounted and two docs instances on one site could never be confused for
 * each other. Before the ref is attached, dispatching is a no-op rather than an error:
 * an event fired during the first commit has nothing to reach.
 */
export function useDocsEvents(root: RefObject<HTMLElement | null>): EmitFn {
	return useCallback(
		<K extends keyof DocsEventMap>(name: K, detail: DocsEventMap[K]) => {
			root.current?.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
		},
		[root],
	);
}

/**
 * Announces a client-side navigation and moves focus into the article.
 *
 * Focus moves with `preventScroll`, because focusing a `tabindex="-1"` element otherwise
 * scrolls it under the site's sticky header and the reader lands mid-paragraph. The
 * announcement goes into a polite live region and is cleared afterwards so it does not
 * read itself out again when something unrelated updates the region.
 *
 * **It does not scroll.** Scrolling is React Router's `<ScrollRestoration />`, which both
 * consumers render in their root layout: to the saved position on back and forward, to the
 * element a hash names, and to the top otherwise. That runs in a layout effect and this in a
 * passive one, so any scroll here lands last. Step 4 scrolled to the top here, and
 * `test/render/dom/scroll.test.tsx` measured what that did: every search result with an
 * anchor landed at the top of its page, and every back-button restore was undone. A heading
 * alias the router cannot find by id is `useAliasScroll`'s, the one scroll the router cannot
 * make, and it runs after the router's for the same reason.
 *
 * It deliberately does nothing on the first commit. React Router does not move focus on a
 * navigation, which is why this exists, but it also does not re-mount the shell on
 * hydration, and stealing focus from wherever the reader already is on a full page load is
 * the opposite of the fix.
 */
export function useNavigationAnnounce(
	slug: string,
	title: string,
	announcement: string,
	emit: EmitFn,
	article: RefObject<HTMLElement | null>,
	live: RefObject<HTMLElement | null>,
): void {
	const first = useRef(true);
	useEffect(() => {
		if (first.current) {
			first.current = false;
			emit('hexdocs:navigate', { slug, title, source: 'server' });
			return;
		}
		article.current?.focus({ preventScroll: true });
		const region = live.current;
		if (region !== null) {
			region.textContent = announcement;
			const timer = setTimeout(() => {
				region.textContent = '';
			}, 1000);
			emit('hexdocs:navigate', { slug, title, source: 'client' });
			return () => clearTimeout(timer);
		}
		emit('hexdocs:navigate', { slug, title, source: 'client' });
		return undefined;
	}, [slug, title, announcement, emit, article, live]);
}

/**
 * Which heading counts as current, given the ids whose tops have passed.
 *
 * Separated from the observer because it is the only part of scroll spy that can be
 * wrong: the observer reports intersections and the decision is which of them the reader
 * means by "where I am", which is the last heading whose top has gone past rather than the
 * topmost visible one. On a page of short sections those are different headings, and the
 * difference is invisible in a screenshot.
 *
 * The last, in document order. `useHeadingSpy` keeps every heading that has passed, so
 * `passed` is a prefix of the page, and this used to return the first match: the page's
 * first heading, marked current for the whole read on every page with more than one.
 */
export function activeHeading(
	order: readonly string[],
	passed: ReadonlySet<string>,
): string | undefined {
	let current: string | undefined;
	for (const id of order) if (passed.has(id)) current = id;
	return current;
}

/**
 * The element a hash should scroll to, or nothing.
 *
 * `getElementById` first, the alias map second, and the order is stated rather than left
 * to be discovered. `ast.ts` says ids and aliases are unique within a page across both, so
 * the two cannot both match a well-formed payload, but the renderer builds a live lookup
 * over a bundle it did not compile and an implementation that checked the map first would
 * resolve a real id through an alias entry that happened to share it.
 */
export function aliasTarget(
	hash: string,
	aliases: Readonly<Record<string, string>>,
	exists: (id: string) => boolean,
): string | undefined {
	if (hash === '') return undefined;
	if (exists(hash)) return undefined;
	return aliases[hash];
}

/**
 * The heading the reader is currently in, for the table of contents.
 *
 * An `IntersectionObserver` rather than a scroll listener, so the work is the browser's
 * and there is nothing to throttle. The heading counted as current is the last one whose
 * top has passed the sticky offset, which is what a reader means by "where I am" and is
 * not what "the topmost visible heading" gives on a page of short sections.
 *
 * It keeps running under reduced motion. Scroll spy is information, not decoration, and a
 * table of contents that stopped following the reader would be a regression for exactly
 * the people the setting is for. Only the `hexdocs:heading` events stop, because those
 * exist to drive a consumer's animation.
 */
export function useHeadingSpy(
	headings: readonly PageHeading[],
	emit: EmitFn,
	reduced: boolean,
): string | undefined {
	const active = useRef<string | undefined>(undefined);
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (headings.length === 0) return () => undefined;
			const seen = new Map<string, number>();
			const observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						seen.set(entry.target.id, entry.boundingClientRect.top);
						if (!entry.isIntersecting && entry.boundingClientRect.top > 0) {
							seen.delete(entry.target.id);
						}
					}
					const current = activeHeading(
						headings.map((heading) => heading.id),
						new Set(seen.keys()),
					);
					if (current === active.current) return;
					active.current = current;
					onChange();
					if (current !== undefined && !reduced) {
						const index = headings.findIndex((heading) => heading.id === current);
						emit('hexdocs:heading', { id: current, index, total: headings.length });
					}
				},
				{ rootMargin: '0px 0px -70% 0px' },
			);
			for (const heading of headings) {
				const element = document.getElementById(heading.id);
				if (element !== null) observer.observe(element);
			}
			return () => observer.disconnect();
		},
		[headings, emit, reduced],
	);
	return useSyncExternalStore(
		subscribe,
		() => active.current,
		() => undefined,
	);
}

/**
 * Scrolls to the element a URL hash names, including when the hash is an alias.
 *
 * `getElementById` first, then the alias map. That order is stated rather than left to be
 * discovered: `ast.ts` says ids and aliases are unique within a page across both, so the
 * two cannot both match, but the renderer builds a live lookup and an implementation that
 * checked the map first would resolve a real id through an alias entry that happened to
 * share it in a bundle the compiler did not produce.
 *
 * The browser has already tried and failed to find an alias by the time this runs, which
 * is why the scroll has to be explicit rather than left to the default behaviour.
 */
export function useAliasScroll(aliases: Readonly<Record<string, string>>, reduced: boolean): void {
	useEffect(() => {
		const target = aliasTarget(
			window.location.hash.slice(1),
			aliases,
			(id) => document.getElementById(id) !== null,
		);
		if (target === undefined) return;
		document
			.getElementById(target)
			?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
	}, [aliases, reduced]);
}

/**
 * The two phone disclosures, the page tree and the outline, as the handlers need them.
 *
 * Both are native `<details>`, closed in the server's markup, and React never passes `open`,
 * so a reader who opened one before hydration keeps it open; `src/render/page.tsx` says why
 * each still carries `suppressHydrationWarning`. Everything below is what script adds on top
 * of a control that already works without it, and each degrades to nothing when no script
 * runs.
 */
export type DisclosureRef = RefObject<HTMLDetailsElement | null>;

/**
 * Closes both disclosures when the page changes under a mounted shell.
 *
 * A client-side navigation does not reload the document, so a tree the reader opened to pick
 * a page would otherwise still be open over the page they picked. It has to run before
 * `useNavigationAnnounce`, which is a later effect in the same commit: that one moves focus
 * into the article, and focus left on a row in a list that is about to be hidden falls to the
 * body when the list goes.
 *
 * Nothing happens on the first commit, which is why the slug is compared rather than the
 * effect simply running. Closing on mount would shut a disclosure the reader opened before
 * hydration finished, which is the one state the native control is there to keep. The refs
 * are not dependencies: a ref object is stable for the life of the component, and the array
 * holding them is a new one on every render, so listing it would re-run the effect for nothing.
 */
export function useCloseOnNavigate(slug: string, disclosures: readonly DisclosureRef[]): void {
	const previous = useRef(slug);
	useEffect(() => {
		if (previous.current === slug) return;
		previous.current = slug;
		for (const disclosure of disclosures) {
			if (disclosure.current !== null) disclosure.current.open = false;
		}
	}, [slug]);
}

/**
 * Scrolls an opened panel so its current row sits two fifths of the way down.
 *
 * The panel is the element after the `<details>`, which is where both lists sit so that
 * desktop, where no disclosure is ever shown, keeps today's markup behaviour. The section
 * above the current row stays in view and its neighbours below it, which is what a reader
 * looking for the next page wants to see. At fifty pages the current row is otherwise
 * several screens down a list that opened at its top.
 *
 * Arithmetic on `scrollTop` and not `scrollIntoView`, which scrolls every scrollable ancestor
 * and would move the document under the reader as well as the panel. `offsetTop` is measured
 * from the panel itself because the stylesheet positions both panels, which makes each the
 * offset parent of its rows.
 */
export function revealCurrent(event: SyntheticEvent<HTMLDetailsElement>): void {
	const details = event.currentTarget;
	if (!details.open) return;
	const panel = details.nextElementSibling;
	const current = panel?.querySelector('[aria-current]');
	if (!(panel instanceof HTMLElement) || !(current instanceof HTMLElement)) return;
	panel.scrollTop = Math.max(0, current.offsetTop - panel.clientHeight * 0.4);
}

/**
 * Closes the outline once a row in it has been followed.
 *
 * On the next frame, and never with `preventDefault`. The browser's fragment navigation, the
 * history entry it pushes and the focus starting point it sets all belong to the click, and
 * closing the panel inside the handler hides the link before its default action runs.
 */
export function closeOnLink(disclosure: DisclosureRef): (event: MouseEvent<HTMLElement>) => void {
	return (event) => {
		if (!(event.target instanceof Element) || event.target.closest('a') === null) return;
		requestAnimationFrame(() => {
			if (disclosure.current !== null) disclosure.current.open = false;
		});
	};
}

/**
 * The bar's Pages link: closes the outline and opens the tree, then lets the link jump.
 *
 * The link is `href="#hx-tree"` and works with no script at all, landing on a closed tree
 * one tap from open. With script the same tap lands on an open tree, and opening it fires
 * the tree's own `toggle`, which scrolls its current row into view. The jump is left to the
 * browser, so the history entry and the focus starting point are the ones any in-page link
 * gets.
 */
export function openTree(
	tree: DisclosureRef,
	toc: DisclosureRef,
): (event: MouseEvent<HTMLAnchorElement>) => void {
	return () => {
		if (toc.current !== null) toc.current.open = false;
		if (tree.current !== null) tree.current.open = true;
	};
}

/**
 * Escape inside an open disclosure closes it and puts focus back on its summary.
 *
 * Not when the key was pressed inside a `<dialog>`. The search dialog is rendered inside the
 * tree's landmark, so its Escape bubbles through this handler on the way out, and the dialog
 * closing is all that key press means: the tree behind it closing too would take the reader
 * somewhere they did not ask to go.
 */
export function escapeCloses(
	disclosure: DisclosureRef,
): (event: KeyboardEvent<HTMLElement>) => void {
	return (event) => {
		const details = disclosure.current;
		if (event.key !== 'Escape' || details === null || !details.open) return;
		if (event.target instanceof Element && event.target.closest('dialog') !== null) return;
		details.open = false;
		details.querySelector('summary')?.focus();
	};
}
