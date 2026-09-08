import { describe, expect, test } from 'vitest';

import { LOCALES } from '../../src/contracts/locales.js';
import {
	MAX_NAV_DEPTH,
	NAV_GROUP_ID_PATTERN,
	NAV_VERSION,
	navDepth,
	navDocs,
	navGroupIds,
	isNavDoc,
	isNavGroup,
	isNavLink,
	type NavTree,
} from '../../src/contracts/nav.js';
import type { LocalisedLabel } from '../../src/contracts/frontmatter.js';

const label = (text: string): LocalisedLabel =>
	Object.fromEntries(LOCALES.map((locale) => [locale, `${text} ${locale}`])) as LocalisedLabel;

const TREE: NavTree = {
	nav: NAV_VERSION,
	items: [
		{ doc: 'index' },
		{
			group: 'guide',
			label: label('Guide'),
			items: [
				{ doc: 'guide/index' },
				{ doc: 'guide/first-tag' },
				{ doc: 'guide/internal-note', hidden: 'Support reference, linked from replies only.' },
				{
					group: 'advanced',
					label: label('Advanced'),
					collapsed: true,
					items: [{ doc: 'guide/advanced/keys' }],
				},
			],
		},
		{ link: 'https://hex.pro', label: label('Site'), external: true },
	],
};

describe('traversal', () => {
	test('navDocs returns every page in reading order, which is what prev and next use', () => {
		expect(navDocs(TREE).map((entry) => entry.slug)).toEqual([
			'index',
			'guide/index',
			'guide/first-tag',
			'guide/internal-note',
			'guide/advanced/keys',
		]);
	});

	test('each entry carries the group path from the root down to its parent', () => {
		const entries = navDocs(TREE);
		expect(entries[0]?.path).toEqual([]);
		expect(entries[1]?.path).toEqual(['guide']);
		expect(entries[4]?.path).toEqual(['guide', 'advanced']);
	});

	test('a hidden page keeps its reason, so somebody can explain it a year later', () => {
		const hidden = navDocs(TREE).find((entry) => entry.slug === 'guide/internal-note');
		expect(hidden?.hidden).toMatch(/Support reference/);
		expect(navDocs(TREE)[0]?.hidden).toBeUndefined();
	});

	test('external links are not pages', () => {
		expect(navDocs(TREE).some((entry) => entry.slug.startsWith('http'))).toBe(false);
	});
});

describe('invariant inputs', () => {
	test('navGroupIds lists every group so uniqueness can be checked', () => {
		expect(navGroupIds(TREE)).toEqual(['guide', 'advanced']);
	});

	test('navDepth measures group nesting, and this tree is inside the limit', () => {
		expect(navDepth(TREE)).toBe(2);
		expect(navDepth(TREE)).toBeLessThanOrEqual(MAX_NAV_DEPTH);
	});

	test('a flat tree has depth zero', () => {
		expect(navDepth({ nav: NAV_VERSION, items: [{ doc: 'index' }] })).toBe(0);
	});

	test('group ids are DOM-safe', () => {
		for (const id of navGroupIds(TREE)) expect(id).toMatch(NAV_GROUP_ID_PATTERN);
		expect(NAV_GROUP_ID_PATTERN.test('Guide')).toBe(false);
		expect(NAV_GROUP_ID_PATTERN.test('1guide')).toBe(false);
	});
});

describe('the three item shapes are told apart by key, not by guess', () => {
	test.each([
		[{ doc: 'index' }, 'doc'],
		[{ group: 'g', label: label('G'), items: [{ doc: 'index' }] }, 'group'],
		[{ link: 'https://x.dev', label: label('X'), external: true as const }, 'link'],
	])('%o is a %s', (item, kind) => {
		expect(isNavDoc(item as never)).toBe(kind === 'doc');
		expect(isNavGroup(item as never)).toBe(kind === 'group');
		expect(isNavLink(item as never)).toBe(kind === 'link');
	});
});
