import { describe, expect, test } from 'vitest';

import { INITIAL_SEARCH, type SearchState } from '../../src/site/search-state.js';
import { activeHeading, aliasTarget } from '../../src/render/client.js';
import { statusText } from '../../src/render/search.js';
import { UI_STRINGS } from '../../src/ui/strings.js';
import { goldenPage } from '../support/golden.js';

describe('which heading the reader is in', () => {
	test('is the first in document order among the ones whose tops have passed', () => {
		// Not the topmost visible heading. On a page of short sections several are visible
		// at once, and the one the reader means is the one they have scrolled past.
		const order = ['a', 'b', 'c'];
		expect(activeHeading(order, new Set(['b', 'c']))).toBe('b');
		expect(activeHeading(order, new Set(['c']))).toBe('c');
	});

	test('follows the document order, not the order the observer reported', () => {
		// `IntersectionObserver` batches entries and the order it delivers them in is not
		// the document's. Reading the observer's order would make the active heading flicker
		// between two while scrolling.
		expect(activeHeading(['a', 'b', 'c'], new Set(['c', 'a', 'b']))).toBe('a');
	});

	test('is nothing before the reader has passed any heading', () => {
		expect(activeHeading(['a', 'b'], new Set())).toBeUndefined();
		expect(activeHeading([], new Set(['a']))).toBeUndefined();
	});
});

describe('which element a hash scrolls to', () => {
	const aliases = { 'what-you-need': 'necessario', 'old-name': 'new-name' };

	test('is nothing when the hash names a real element, because the browser already did it', () => {
		expect(aliasTarget('necessario', aliases, (id) => id === 'necessario')).toBeUndefined();
	});

	test('is the alias target when the hash names no element', () => {
		// The case this exists for. A deep link written against the English page carries an
		// English slug, and the Japanese page's own heading id is Japanese.
		expect(aliasTarget('what-you-need', aliases, () => false)).toBe('necessario');
	});

	test('prefers a real id over an alias entry that shares its name', () => {
		// The order, stated. A well-formed payload cannot produce this, because ids and
		// aliases are unique within a page across both, but the renderer builds a live
		// lookup over a bundle it did not compile.
		const shared = { collision: 'somewhere-else' };
		expect(aliasTarget('collision', shared, (id) => id === 'collision')).toBeUndefined();
	});

	test('is nothing for an empty hash or an unknown one', () => {
		expect(aliasTarget('', aliases, () => false)).toBeUndefined();
		expect(aliasTarget('nobody', aliases, () => false)).toBeUndefined();
	});

	test('resolves a real alias from the corpus', () => {
		// Driven from the compiled page rather than from a literal, so a corpus edit that
		// removed the alias fails here rather than leaving the test passing about nothing.
		const page = goldenPage('ja', 'index').page;
		const heading = page.body.find(
			(node) => node.type === 'heading' && (node.aliases ?? []).includes('what-you-need'),
		);
		expect(heading?.type).toBe('heading');
		if (heading?.type !== 'heading') return;
		expect(aliasTarget('what-you-need', { 'what-you-need': heading.id }, () => false)).toBe(
			heading.id,
		);
	});
});

describe('what the search live region says', () => {
	const withQuery = (query: string, results: number): SearchState => ({
		...INITIAL_SEARCH,
		open: true,
		status: 'ready',
		query,
		results: Array.from({ length: results }, () => ({
			doc: {
				slug: 'x',
				anchor: '_top',
				title: 'x',
				heading: '',
				depth: 1,
				audience: 3,
				translated: 'current' as const,
			},
			score: 1,
			terms: [],
		})),
	});

	test('says nothing before anything is typed', () => {
		expect(statusText(INITIAL_SEARCH, 'en')).toBe('');
		expect(statusText(withQuery('   ', 0), 'en')).toBe('');
	});

	test('announces the index is loading', () => {
		expect(statusText({ ...INITIAL_SEARCH, status: 'loading' }, 'ja')).toBe(
			UI_STRINGS.ja.searchLoading,
		);
	});

	test('names the query when nothing matched', () => {
		expect(statusText(withQuery('ndef', 0), 'en')).toBe('No results for ndef.');
	});

	test('counts results in the form the language needs', () => {
		// A `length === 1 ? a : b` in the component would be wrong in five of the seven
		// languages, and in Arabic it would be wrong in five of six ranges.
		expect(statusText(withQuery('tag', 1), 'en')).toBe('1 result');
		expect(statusText(withQuery('tag', 4), 'en')).toBe('4 results');
		expect(statusText(withQuery('tag', 2), 'ar')).not.toContain('2');
		expect(statusText(withQuery('tag', 1), 'ja')).toContain('1');
	});
});
