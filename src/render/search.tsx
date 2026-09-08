/**
 * The search trigger and the search dialog.
 *
 * The keyboard and focus model lives in `src/site/search-state.ts` and is asserted there;
 * this file is the markup, the effects that carry the reducer's decisions out, and the one
 * fetch. Splitting it that way is what makes "Escape returns focus to the trigger" a
 * transition a node test can check rather than something only a browser can see.
 *
 * ## The combobox pattern, spelled out
 *
 * `role="combobox"` on the input with `aria-expanded`, `aria-controls` and
 * `aria-activedescendant`; `role="listbox"` on the results and `role="option"` on each
 * row. Arrow keys move `aria-activedescendant`, never DOM focus, because focus leaving the
 * input would stop the reader typing, and a listbox the reader has to tab into is not a
 * combobox.
 *
 * ## Why a native `<dialog>`
 *
 * It gives the focus trap, the inert background and the Escape key without a line of code,
 * and every one of those written by hand is a place to get it wrong. The cost is that the
 * dialog's own Escape closes it without telling React, which is why `onClose` dispatches
 * the same action the close button does.
 *
 * ## When the index is fetched
 *
 * On the first sign the reader intends to search: a pointer entering the trigger, focus
 * reaching it, or the shortcut. Never on page load. The index is the largest thing in the
 * bundle and most readers never search, so fetching it eagerly would be the biggest number
 * on the page for a feature most visits do not use.
 */

import { useCallback, useEffect, useReducer, useRef, type ReactElement } from 'react';

import type { Locale } from '../contracts/locales.js';
import { searchKey } from '../contracts/manifest.js';
import { PAGE_ROOT_ANCHOR, type SearchIndex } from '../contracts/search.js';
import { assertIndexCompatible, searchIndex } from '../search/query.js';
import { bundleUrl, docsHref, type DocsAddress } from '../site/address.js';
import { IDS, searchOptionId } from '../site/ids.js';
import {
	INITIAL_SEARCH,
	activeOptionId,
	searchReducer,
	type SearchState,
} from '../site/search-state.js';
import { uiPlural, uiString } from '../ui/strings.js';
import { useHydrated } from './client.js';
import type { DocsLinkComponent, EmitFn } from './context.js';

export interface SearchProps {
	/** The reader's interface language, which every string here is read in. */
	locale: Locale;
	/** The locale whose index to fetch, which the route resolves against the manifest. */
	searchLocale: Locale;
	address: DocsAddress;
	bundleBase: string;
	Link: DocsLinkComponent;
	emit: EmitFn;
}

/** The number of results scored. Beyond this a reader refines the query rather than scrolls. */
const RESULT_LIMIT = 20;

export function DocsSearch(props: SearchProps): ReactElement {
	const Link = props.Link;
	const hydrated = useHydrated();
	const [state, dispatch] = useReducer(searchReducer, INITIAL_SEARCH);
	const dialog = useRef<HTMLDialogElement | null>(null);
	const input = useRef<HTMLInputElement | null>(null);
	const trigger = useRef<HTMLButtonElement | null>(null);
	const index = useRef<SearchIndex | null>(null);
	const loading = useRef(false);
	const options = useRef<(HTMLAnchorElement | null)[]>([]);
	/**
	 * What the reader picked, read once by `onClose`.
	 *
	 * There is exactly one exit from this dialog and it is the browser's `close` event.
	 * Every other path calls `close()` and lets that event do the work, because a dialog
	 * dismissed with Escape fires it whether we like it or not: a component that also
	 * dispatched on its own button would emit two `hexdocs:search-close` events for one
	 * close, and a consumer counting them would be counting wrong.
	 */
	const chose = useRef<string | null>(null);

	const load = useCallback(() => {
		if (index.current !== null || loading.current) return;
		loading.current = true;
		dispatch({ type: 'loading' });
		void fetch(bundleUrl(props.bundleBase, searchKey(props.searchLocale)))
			.then((response) => (response.ok ? response.json() : Promise.reject(new Error('no index'))))
			.then((payload: SearchIndex) => {
				// Refused loudly rather than queried optimistically. Every failure in search
				// is silent: an index built with one tokeniser and scored with another
				// returns nothing, with no error, in one language.
				assertIndexCompatible(payload);
				index.current = payload;
				dispatch({ type: 'results', hits: [] });
			})
			.catch(() => dispatch({ type: 'failed' }));
	}, [props.bundleBase, props.searchLocale]);

	// The reducer says where focus should be; this carries it out and acknowledges, so the
	// decision stays in a pure function and the DOM call stays here.
	useEffect(() => {
		if (state.focus === 'input') input.current?.focus();
		if (state.focus === 'trigger') trigger.current?.focus();
		if (state.focus !== null) dispatch({ type: 'focused' });
	}, [state.focus]);

	useEffect(() => {
		const element = dialog.current;
		if (element === null) return;
		if (state.open && !element.open) element.showModal();
		if (!state.open && element.open) element.close();
	}, [state.open]);

	useEffect(() => {
		if (!state.open) return;
		const current = index.current;
		if (current === null) return;
		const hits =
			state.query.trim() === '' ? [] : searchIndex(current, state.query, { limit: RESULT_LIMIT });
		dispatch({ type: 'results', hits });
	}, [state.open, state.query, state.status]);

	const dismiss = (slug: string | null): void => {
		chose.current = slug;
		dialog.current?.close();
	};

	return (
		<>
			<button
				ref={trigger}
				id={IDS.searchTrigger}
				type="button"
				className="hx-search-trigger"
				disabled={!hydrated}
				aria-haspopup="dialog"
				onPointerEnter={load}
				onFocus={load}
				onClick={() => {
					load();
					props.emit('hexdocs:search-open', {});
					dispatch({ type: 'open' });
				}}
			>
				{uiString(props.locale, 'searchOpen')}
				<span className="hx-search-hint" aria-hidden="true">
					{uiString(props.locale, 'searchHint')}
				</span>
			</button>

			<dialog
				ref={dialog}
				id={IDS.searchDialog}
				className="hx-search"
				aria-label={uiString(props.locale, 'searchPlaceholder')}
				onClose={() => {
					// The single exit. Escape, the backdrop, the close button and choosing a
					// result all arrive here, so there is one event per close and one place
					// that decides what `chose` was.
					const picked = chose.current;
					chose.current = null;
					props.emit('hexdocs:search-close', { query: state.query, chose: picked });
					dispatch({ type: 'close', chose: picked });
				}}
			>
				<div className="hx-search-bar">
					<input
						ref={input}
						id={IDS.searchInput}
						type="text"
						className="hx-search-input"
						role="combobox"
						autoComplete="off"
						aria-expanded={state.results.length > 0}
						aria-controls={IDS.searchResults}
						aria-activedescendant={activeOptionId(state, searchOptionId)}
						aria-label={uiString(props.locale, 'searchPlaceholder')}
						placeholder={uiString(props.locale, 'searchPlaceholder')}
						value={state.query}
						onChange={(event) => dispatch({ type: 'query', value: event.target.value })}
						onKeyDown={(event) => {
							if (event.key === 'ArrowDown') {
								event.preventDefault();
								dispatch({ type: 'move', delta: 1 });
							}
							if (event.key === 'ArrowUp') {
								event.preventDefault();
								dispatch({ type: 'move', delta: -1 });
							}
							if (event.key === 'Enter') {
								const hit = state.results[state.active];
								if (hit !== undefined) {
									event.preventDefault();
									chose.current = hit.doc.slug;
									// Click the row's own link rather than navigating here. The
									// consumer's router owns navigation and this package cannot
									// import it, so the only honest way to follow a result is to
									// activate the element that already knows how.
									options.current[state.active]?.click();
								}
							}
						}}
					/>
					<button type="button" className="hx-search-close" onClick={() => dismiss(null)}>
						{uiString(props.locale, 'searchClose')}
					</button>
				</div>

				<p id={IDS.searchStatus} className="hx-sr" role="status">
					{statusText(state, props.locale)}
				</p>

				<ul id={IDS.searchResults} className="hx-search-results" role="listbox">
					{state.results.map((hit, position) => (
						<li
							key={`${hit.doc.slug}#${hit.doc.anchor}`}
							id={searchOptionId(position)}
							role="option"
							aria-selected={position === state.active}
							className="hx-search-result"
						>
							<Link
								ref={(element: HTMLAnchorElement | null) => {
									options.current[position] = element;
								}}
								to={docsHref({
									...props.address,
									slug: hit.doc.slug,
									anchor: hit.doc.anchor === PAGE_ROOT_ANCHOR ? undefined : hit.doc.anchor,
								})}
								className="hx-search-link"
								onClick={() => dismiss(hit.doc.slug)}
							>
								<span className="hx-search-title">{hit.doc.title}</span>
								{hit.doc.heading === '' ? null : (
									<span className="hx-search-heading">{hit.doc.heading}</span>
								)}
							</Link>
						</li>
					))}
				</ul>
			</dialog>
		</>
	);
}

/**
 * What the live region says.
 *
 * A count rather than a list, because the list is already in the DOM and reading it out
 * would announce every result twice. `uiPlural` is what makes the Arabic form right, which
 * is the case a `results.length === 1 ? a : b` in the component would get wrong in five
 * languages.
 */
export function statusText(state: SearchState, locale: Locale): string {
	if (state.status === 'loading') return uiString(locale, 'searchLoading');
	if (state.query.trim() === '') return '';
	if (state.results.length === 0)
		return uiString(locale, 'searchNoResults', { query: state.query });
	return uiPlural(locale, 'resultCount', state.results.length);
}
