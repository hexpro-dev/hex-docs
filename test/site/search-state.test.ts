import { describe, expect, test } from 'vitest';

import type { SearchDoc } from '../../src/contracts/search.js';
import type { SearchHit } from '../../src/search/query.js';
import {
	INITIAL_SEARCH,
	activeOptionId,
	opensSearch,
	searchReducer,
	type SearchState,
} from '../../src/site/search-state.js';
import { searchOptionId } from '../../src/site/ids.js';

const hit = (slug: string): SearchHit => ({
	doc: {
		slug,
		anchor: '_top',
		title: slug,
		heading: '',
		depth: 1,
		audience: 3,
		translated: 'current',
	} as SearchDoc,
	score: 1,
	terms: [],
});

const run = (state: SearchState, ...actions: Parameters<typeof searchReducer>[1][]): SearchState =>
	actions.reduce(searchReducer, state);

const withResults = (count: number): SearchState =>
	run(
		INITIAL_SEARCH,
		{ type: 'open' },
		{ type: 'results', hits: Array.from({ length: count }, (_, i) => hit(`p${i}`)) },
	);

describe('opening and closing', () => {
	test('opening focuses the input and clears any highlight', () => {
		const state = searchReducer(INITIAL_SEARCH, { type: 'open' });
		expect(state.open).toBe(true);
		expect(state.focus).toBe('input');
		expect(state.active).toBe(-1);
	});

	test('closing returns focus to the trigger, always', () => {
		// The regression this file exists for. Leaving focus where it was drops the reader
		// to the top of the document, because the dialog they were in has gone, and it is
		// invisible in every screenshot and every golden.
		const state = run(withResults(3), { type: 'move', delta: 1 }, { type: 'close', chose: null });
		expect(state.open).toBe(false);
		expect(state.focus).toBe('trigger');
	});

	test('the component acknowledges the move, so focus is not stolen twice', () => {
		const asked = searchReducer(INITIAL_SEARCH, { type: 'open' });
		const done = searchReducer(asked, { type: 'focused' });
		expect(done.focus).toBeNull();
		expect(done.open).toBe(true);
	});

	test('reopening does not restore a highlight from the previous list', () => {
		// The second regression: `aria-activedescendant` naming a row that is no longer in
		// the results reports as nothing at all to assistive technology, and the reader is
		// simply told less than they were before.
		const state = run(
			withResults(3),
			{ type: 'move', delta: 1 },
			{ type: 'close', chose: null },
			{ type: 'open' },
		);
		expect(state.active).toBe(-1);
		expect(activeOptionId(state, searchOptionId)).toBeUndefined();
	});

	test('reopening keeps the query, because the reader typed it', () => {
		const state = run(
			INITIAL_SEARCH,
			{ type: 'open' },
			{ type: 'query', value: 'ndef' },
			{ type: 'close', chose: null },
			{ type: 'open' },
		);
		expect(state.query).toBe('ndef');
	});
});

describe('the active option', () => {
	test('down from nothing goes to the first row and up goes to the last', () => {
		const base = withResults(3);
		expect(searchReducer(base, { type: 'move', delta: 1 }).active).toBe(0);
		expect(searchReducer(base, { type: 'move', delta: -1 }).active).toBe(2);
	});

	test('wraps at both ends rather than sticking', () => {
		const base = withResults(3);
		const last = run(
			base,
			{ type: 'move', delta: 1 },
			{ type: 'move', delta: 1 },
			{ type: 'move', delta: 1 },
		);
		expect(last.active).toBe(2);
		expect(searchReducer(last, { type: 'move', delta: 1 }).active).toBe(0);
		expect(searchReducer(base, { type: 'move', delta: -1 }).active).toBe(2);
	});

	test('does nothing when there is nothing to move through', () => {
		const empty = searchReducer(INITIAL_SEARCH, { type: 'open' });
		expect(searchReducer(empty, { type: 'move', delta: 1 })).toBe(empty);
	});

	test('is dropped when a new query arrives', () => {
		const state = run(withResults(3), { type: 'move', delta: 1 }, { type: 'query', value: 'x' });
		expect(state.active).toBe(-1);
	});

	test('is dropped when the list shrinks under it', () => {
		// Two rows, highlight the second, then a query that returns one. Keeping index 1
		// would name an option that is no longer in the DOM.
		const state = run(
			withResults(2),
			{ type: 'move', delta: -1 },
			{ type: 'results', hits: [hit('p0')] },
		);
		expect(state.active).toBe(-1);
	});

	test('survives a list that is still long enough', () => {
		const state = run(
			withResults(3),
			{ type: 'move', delta: 1 },
			{ type: 'results', hits: [hit('a'), hit('b')] },
		);
		expect(state.active).toBe(0);
		expect(activeOptionId(state, searchOptionId)).toBe('hx-search-option-0');
	});

	test('names no option when there is no highlight', () => {
		expect(activeOptionId(INITIAL_SEARCH, searchOptionId)).toBeUndefined();
	});
});

describe('loading', () => {
	test('a failure clears the results rather than leaving stale ones', () => {
		const state = run(withResults(3), { type: 'failed' });
		expect(state.status).toBe('failed');
		expect(state.results).toEqual([]);
		expect(state.active).toBe(-1);
	});

	test('loading is a state of its own, so the reader can be told', () => {
		expect(searchReducer(INITIAL_SEARCH, { type: 'loading' }).status).toBe('loading');
	});
});

describe('the slash shortcut', () => {
	test('opens search from an ordinary element', () => {
		expect(opensSearch('/', { tagName: 'DIV' })).toBe(true);
		expect(opensSearch('/', {})).toBe(true);
	});

	test('does not steal the character from anything the reader types into', () => {
		// Without this a reader writing a support reply in a comment box on the same page
		// loses the character and gets a dialog.
		for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input', 'textarea']) {
			expect(opensSearch('/', { tagName })).toBe(false);
		}
		expect(opensSearch('/', { tagName: 'DIV', isContentEditable: true })).toBe(false);
	});

	test('ignores every other key', () => {
		for (const key of ['k', 'Escape', 'Enter', '?', 'F']) {
			expect(opensSearch(key, { tagName: 'DIV' })).toBe(false);
		}
	});
});
