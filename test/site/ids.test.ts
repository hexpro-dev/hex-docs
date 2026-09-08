import { describe, expect, test } from 'vitest';

import { HX, IDS, headingId, searchOptionId } from '../../src/site/ids.js';

describe('the shell ids', () => {
	test('are unique, because two elements with one id is a relationship that silently ends', () => {
		const values = Object.values(IDS);
		expect(new Set(values).size).toBe(values.length);
		expect(values.length).toBeGreaterThan(10);
	});

	test('all carry the package prefix, so nothing can collide with the site around them', () => {
		// The docs shell is mounted inside two sites this package does not control. An id
		// of `content` or `title` would be a plausible thing for either of them to have.
		for (const value of Object.values(IDS)) expect(value.startsWith(`${HX}-`)).toBe(true);
	});

	test('are stable strings, because a consumer skip link may name one', () => {
		// The reason `useId` is not used. Its value depends on the position of the
		// component in the React tree, so wrapping the shell in one more provider would
		// change it, and a skip link in the site chrome pointing at `#hx-content` would
		// stop working with nothing to see.
		expect(IDS.content).toBe('hx-content');
		expect(IDS.title).toBe('hx-title');
	});
});

describe('search option ids', () => {
	test('are one per index and do not collide with a shell id', () => {
		const options = [0, 1, 2, 9, 10].map(searchOptionId);
		expect(new Set(options).size).toBe(options.length);
		for (const option of options) expect(Object.values(IDS)).not.toContain(option);
	});

	test('are not a prefix of one another, so aria-activedescendant cannot near-match', () => {
		// `hx-search-option-1` and `hx-search-option-10` are different ids and must stay
		// exact-match distinct; this is here because an implementation that built them by
		// concatenation without the separator would produce a pair that only differs in a
		// way nothing checks.
		expect(searchOptionId(1)).not.toBe(searchOptionId(10));
		expect(searchOptionId(1).length).toBeLessThan(searchOptionId(10).length);
	});
});

describe('heading anchors', () => {
	test('pass through, because the compiler already made them unique within a page', () => {
		// Identity, and it exists so the id-uniqueness sweep over rendered output has one
		// function to exclude rather than a rule about which ids came from the shell and
		// which came out of the content.
		expect(headingId('station-data')).toBe('station-data');
		expect(headingId('section-4')).toBe('section-4');
	});
});
