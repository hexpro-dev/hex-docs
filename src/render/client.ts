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

import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';

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
 * Three things happen in this order and the order is the whole content of the function.
 * Focus moves first with `preventScroll`, because focusing a `tabindex="-1"` element
 * otherwise scrolls it under the site's sticky header and the reader lands mid-paragraph.
 * The scroll is then explicit, and instant under reduced motion. The announcement goes
 * last, into a polite live region, and is cleared afterwards so it does not read itself
 * out again when something unrelated updates the region.
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
	reduced: boolean,
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
		window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
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
	}, [slug, title, announcement, emit, reduced, article, live]);
}

/**
 * Which heading counts as current, given the ids whose tops have passed.
 *
 * Separated from the observer because it is the only part of scroll spy that can be
 * wrong: the observer reports intersections and the decision is which of them the reader
 * means by "where I am", which is the last heading whose top has gone past rather than the
 * topmost visible one. On a page of short sections those are different headings, and the
 * difference is invisible in a screenshot.
 */
export function activeHeading(
	order: readonly string[],
	passed: ReadonlySet<string>,
): string | undefined {
	return order.find((id) => passed.has(id));
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
