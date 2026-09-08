/**
 * The search dialog's keyboard and focus model, as a reducer over plain data.
 *
 * It is here rather than inside the component, and it is a reducer rather than five
 * `useState` calls, for one reason: the two regressions most likely to ship on this surface
 * are transitions rather than renders. Escape dropping focus to the body instead of the
 * trigger, and `aria-activedescendant` still naming a result that is no longer in the list
 * after a reopen, are both invisible in a screenshot, both fine in a golden, and both
 * caught by `expect(searchReducer(before, action)).toEqual(after)` in an ordinary node
 * test. Putting them behind a browser-only check would mean they are only caught where
 * Chrome starts, which is not the machine where the search UI is being edited.
 *
 * Focus is state rather than an effect the component decides on its own. `focus` says
 * where focus should go next and the component moves it and then acknowledges, which is
 * what makes "Escape returns focus to the trigger" a value this file can assert.
 */

import type { SearchHit } from '../search/query.js';

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** Where focus should be moved next, or `null` when it should be left alone. */
export type FocusTarget = 'input' | 'trigger' | null;

export interface SearchState {
	open: boolean;
	query: string;
	/** Index into `results`, or -1 for no active option. */
	active: number;
	results: readonly SearchHit[];
	status: SearchStatus;
	focus: FocusTarget;
}

export const INITIAL_SEARCH: SearchState = {
	open: false,
	query: '',
	active: -1,
	results: [],
	status: 'idle',
	focus: null,
};

export type SearchAction =
	| { type: 'open' }
	/** `chose` is the slug the reader picked, or null if they dismissed. */
	| { type: 'close'; chose: string | null }
	| { type: 'query'; value: string }
	| { type: 'loading' }
	| { type: 'results'; hits: readonly SearchHit[] }
	| { type: 'failed' }
	/** Arrow keys. `delta` is -1 or 1 and the list wraps at both ends. */
	| { type: 'move'; delta: number }
	/** The component has moved focus where the state asked. */
	| { type: 'focused' };

export function searchReducer(state: SearchState, action: SearchAction): SearchState {
	switch (action.type) {
		case 'open':
			// Opening resets the active option and keeps the query. A reader who reopens
			// after dismissing expects their words back; they do not expect the highlight
			// to still be on a row that may not be in the new results.
			return { ...state, open: true, active: -1, focus: 'input' };

		case 'close':
			// Focus goes back to the trigger, always. Leaving it where it was drops the
			// reader to the top of the document, because the dialog they were in has gone.
			return { ...state, open: false, active: -1, focus: 'trigger' };

		case 'query':
			// A new query invalidates the highlight for the same reason a reopen does: the
			// index it referred to belongs to the previous result list.
			return { ...state, query: action.value, active: -1 };

		case 'loading':
			return { ...state, status: 'loading' };

		case 'results':
			// The active option is clamped rather than kept: a list that shrank under a
			// highlight leaves `aria-activedescendant` naming an element that is no longer
			// in the DOM, which assistive technology reports as nothing at all.
			return {
				...state,
				status: 'ready',
				results: action.hits,
				active: state.active >= action.hits.length ? -1 : state.active,
			};

		case 'failed':
			return { ...state, status: 'failed', results: [], active: -1 };

		case 'move': {
			const count = state.results.length;
			if (count === 0) return state;
			// From nothing, down goes to the first and up goes to the last. Then it wraps.
			const from = state.active < 0 ? (action.delta > 0 ? -1 : 0) : state.active;
			const next = (((from + action.delta) % count) + count) % count;
			return { ...state, active: next };
		}

		case 'focused':
			return { ...state, focus: null };
	}
}

/** The id of the active option, or undefined. `aria-activedescendant` takes one or neither. */
export function activeOptionId(
	state: SearchState,
	optionId: (index: number) => string,
): string | undefined {
	return state.active < 0 || state.active >= state.results.length
		? undefined
		: optionId(state.active);
}

/**
 * Whether a keystroke should open search.
 *
 * `/` is the shortcut, and it must not fire while the reader is typing into something.
 * Without the guard, a reader writing a support reply in a comment box on the same page
 * loses the character and gets a dialog. The check is on the element rather than on a
 * modifier because a text field is the whole class of thing this must not steal from.
 */
export function opensSearch(
	key: string,
	target: { tagName?: string; isContentEditable?: boolean },
): boolean {
	if (key !== '/') return false;
	const tag = (target.tagName ?? '').toUpperCase();
	if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
	return target.isContentEditable !== true;
}
