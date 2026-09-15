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
	type FocusEvent,
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
 * The last, in document order. This used to return the first match, which was the page's
 * first heading, marked current for the whole read on every page with more than one.
 *
 * Taking the last is only right because `passed` holds every heading above the line and none
 * below it, and that is a property of the observer's root rather than of this function. The
 * root reaches 100000px above the viewport, so a heading changes state whenever it crosses the
 * line in a scroll shorter than that; `useHeadingSpy` says what a longer jump leaves behind.
 * With the root ending at the top of the viewport even a short jump did not: an instant jump
 * carries headings from above the viewport to below the line, or back, without either position
 * intersecting, no entry arrives for them, and the set keeps a heading the reader has left.
 * `useHeadingSpy` says what that looked like.
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
 * An `IntersectionObserver` rather than a scroll listener measuring every heading, so the work
 * is the browser's and there is nothing to throttle; the one scroll listener here asks only
 * whether the page has reached its end. The heading counted as current is the last one whose
 * top has passed the line, which is what a reader means by "where I am" and is not what "the
 * topmost visible heading" gives on a page of short sections.
 *
 * The line is 30% down the viewport, and the root's top edge is 100000px above the viewport's,
 * so intersecting means at or above the line and no more than 100000px above the viewport, and
 * a heading crossing the line from anywhere inside that reach sends an entry. An observer only
 * reports a change of state, and with the root's top at the viewport's own top a heading
 * carried from above the screen to below the line in one scroll never changed state. Measured
 * in Chrome at 390 by 844 on a 13000px page: a tap on the bar's Pages link from the end of the
 * page, an outline pick upwards and a jump to the end each delivered no entry for the headings
 * they skipped, and the bar and `aria-current` went on naming a heading the reader had left,
 * while continuous scrolling was right at every step.
 *
 * The root is the headings' own document, named, and not left implicit. The implicit root is
 * the top-level viewport, so in a frame the margin measures the host's screen: a same-origin
 * frame's own viewport still clips a heading above it, so the reach above the screen never
 * counts, and a cross-origin frame ignores `rootMargin` altogether. Either way a jump in the
 * frame reported nothing again. Measured in Chrome with a frame at the top of its host, a frame
 * lower down it and a cross-site frame: all three named stale headings after jumps without the
 * named root, and matched the page after every jump with it. WebKit was not measured. A
 * `Document` root needs Chrome 81, Firefox 76 or Safari 14.
 *
 * A heading more than 100000px above the viewport stops intersecting. Its entry has a negative
 * top, which the callback keeps as passed, so a long section scrolled through still names its
 * heading. The margin is a distance, not a guarantee: on a page taller than it, one scroll
 * longer than it can leave the set wrong in either direction, and such a jump can deliver no
 * entry at all, so the callback has nothing to correct it with. Downwards, a heading carried
 * from below the line to more than 100000px above never intersects and is never added, which
 * shows only when it is the heading the reader lands in, more than a hundred phone screens into
 * one section. Upwards, a heading already more than 100000px above is carried below the line
 * without intersecting either, so it stays in the set and is named until the reader scrolls
 * back past it, in sections of any length. Measured in Chrome at 390 by 844 on a page of six
 * 40000px sections, a jump from the end to the top left a heading named that the reader had not
 * reached. Neither can happen on a page shorter than the margin.
 *
 * The last heading counts as passed once the document is scrolled as far as it goes, whether or
 * not it reached the line. A heading closer to the end of the page than 70% of the viewport can
 * never reach it, and nothing crosses the line once scrolling stops, so no entry would ever name
 * it: at the end of such a page, and right after an outline pick of that heading, the bar and
 * `aria-current` named the heading before it. Measured in Chrome on the compiled pages with a
 * 64px host header and no host footer: 11 of 26 missed the last heading at 390 by 844, and all
 * 26 at 768 by 1024. The observer still does every crossing; a scroll listener only asks
 * whether any scroll is left, reading three numbers an event, which needs no throttle. The
 * price is on a host with no footer, where an outline pick of a short second-to-last section
 * lands at the end of the page and names the last heading. A host that scrolls an inner element
 * rather than the window never reports an end, and gets the observer's answer alone.
 *
 * Not a sentinel element after the layout. On a host with a real footer the layout's end is on
 * screen while the reader can still scroll, so a sentinel named the last heading early and kept
 * naming it after a scroll back up: measured with a 450px footer, 25 of 26 pages at 1280 by 800.
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
			let atEnd = false;
			const decide = (): void => {
				const current = atEnd
					? headings.at(-1)?.id
					: activeHeading(
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
			};
			const measureEnd = (): void => {
				// Scrolled at all, and to within a pixel of the end. A page that does not scroll is
				// never at its end, so its headings keep the line's answer.
				const now =
					window.scrollY > 0 &&
					window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
				if (now === atEnd) return;
				atEnd = now;
				decide();
			};
			const observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						// Not intersecting with a positive top is below the line. With a negative top
						// it is past the root's far edge, which is still a heading the reader passed.
						seen.set(entry.target.id, entry.boundingClientRect.top);
						if (!entry.isIntersecting && entry.boundingClientRect.top > 0) {
							seen.delete(entry.target.id);
						}
					}
					decide();
				},
				{ root: document, rootMargin: '100000px 0px -70% 0px' },
			);
			for (const heading of headings) {
				const element = document.getElementById(heading.id);
				if (element !== null) observer.observe(element);
			}
			window.addEventListener('scroll', measureEnd, { passive: true });
			window.addEventListener('resize', measureEnd);
			// A load that lands on a hash at the end of the page is already there.
			measureEnd();
			return () => {
				observer.disconnect();
				window.removeEventListener('scroll', measureEnd);
				window.removeEventListener('resize', measureEnd);
			};
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
 * Closes both disclosures when the reader's address changes under a mounted shell.
 *
 * A client-side navigation does not reload the document, so a tree the reader opened to pick
 * a page would otherwise still be open over the page they picked. The key is the address, the
 * reader's locale and the slug together, and not the slug alone. Changing language on one page
 * is the same route with a different `:lang`, which is what a host's language picker and the
 * translation notice's English link both do: the shell stays mounted, `useNavigationAnnounce`
 * moves focus into the article and announces the page, and a slug-only key left the tree open
 * in flow above it and the outline open over the bar.
 *
 * Its order against `useNavigationAnnounce` does not matter. Both run in the same passive flush
 * after the commit that changed the address, with nothing rendered between them, so either
 * order leaves the disclosures closed and focus on the article. What keeps focus out of a list
 * that is being hidden is that other hook moving focus into the article; without it, focus left
 * on a row would fall to the body when the row stopped being displayed.
 *
 * Nothing happens on the first commit, which is why the address is compared rather than the
 * effect simply running. Closing on mount would shut a disclosure the reader opened before
 * hydration finished, which is the one state the native control is there to keep. The refs
 * are not dependencies: a ref object is stable for the life of the component, and the array
 * holding them is a new one on every render, so listing it would re-run the effect for nothing.
 */
export function useCloseOnNavigate(address: string, disclosures: readonly DisclosureRef[]): void {
	const previous = useRef(address);
	useEffect(() => {
		if (previous.current === address) return;
		previous.current = address;
		for (const disclosure of disclosures) {
			if (disclosure.current !== null) disclosure.current.open = false;
		}
	}, [address]);
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
 * Closes the outline when focus leaves the bar for somewhere else on the page.
 *
 * The open outline is drawn over the article, above the bar, so the pager at the end of the
 * article can sit entirely under it. Measured at 390px: Shift+Tab from the bar's summary landed
 * focus on the pager's Next link with none of it visible and nothing that would dismiss the panel
 * from there, which fails WCAG 2.2's 2.4.11, whose exception for content the reader opened needs
 * a way to close it without moving focus. Moving between the summary, the rows and the Pages
 * link stays inside the bar and keeps the outline open.
 *
 * Not when focus goes nowhere. A click on the panel's own padding or on its scrollbar blurs to
 * the body with no `relatedTarget`, and closing then would shut the panel under the pointer that
 * is scrolling it.
 */
export function closeOnLeave(disclosure: DisclosureRef): (event: FocusEvent<HTMLElement>) => void {
	return (event) => {
		const next = event.relatedTarget;
		if (next === null || event.currentTarget.contains(next)) return;
		if (disclosure.current !== null) disclosure.current.open = false;
	};
}

/**
 * Escape closes an open disclosure and puts focus back on its summary, when the key was pressed
 * where the disclosure is.
 *
 * `within` says where that is. `'disclosure'` is the `<details>` and the list after it, and the
 * tree takes it because its landmark also holds the search trigger, the search dialog and
 * whatever a consumer put in `treeTop` and `treeBottom`. None of those is the tree. Measured with
 * the whole landmark counting: a reader who pressed Escape once to close search and once more on
 * the trigger closed the tree they had open, with focus pulled onto its summary.
 *
 * `'container'` is the whole element the handler is on, and the bar takes it. The outline is
 * drawn over the article above the bar, so a reader anywhere in the bar with it open, the Pages
 * link included, is looking at a panel that covers the page, and Escape there has nothing else to
 * mean. Bound to the outline's landmark alone, Escape on the Pages link left the panel open.
 *
 * Nothing happens for a key another handler already took. A consumer's widget in `treeTop` that
 * closes its own popup on Escape calls `preventDefault`, and the key press was that widget's.
 */
export function escapeCloses(
	disclosure: DisclosureRef,
	within: 'disclosure' | 'container' = 'disclosure',
): (event: KeyboardEvent<HTMLElement>) => void {
	return (event) => {
		const details = disclosure.current;
		if (event.key !== 'Escape' || event.defaultPrevented || details === null || !details.open) {
			return;
		}
		const target = event.target;
		if (!(target instanceof Node)) return;
		const inside =
			within === 'container'
				? event.currentTarget.contains(target)
				: details.contains(target) || details.nextElementSibling?.contains(target) === true;
		if (!inside) return;
		details.open = false;
		details.querySelector('summary')?.focus();
	};
}
