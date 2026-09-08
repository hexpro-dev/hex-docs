/**
 * The route table a consuming site declares, and the two lists derived beside it.
 *
 * **Order is the contract here, not a rendering detail.** React Router scores
 * `:slug.json` as a static segment, because it fails the `/^:[\w-]+$/` test, so it ties
 * with a real static segment and the tie breaks on declaration order. Probed against the
 * installed 7.12: declaring the dynamic pattern first makes `/.../search.json` resolve to
 * it with `{slug: "search"}`, which is a machine endpoint answering the search index's
 * address with a page of markdown. That decision is made once, in `docsRouteRows`, for
 * every consumer, and this file is what stops it being made again by accident.
 *
 * The `:lang` half is the other verified fact. A leaf match with no default export goes to
 * `queryRoute`, which runs that one route's loader and no parent's, so a machine endpoint
 * mounted under a `:lang` parent answers `GET /banana/hex-nfc/docs/llms.txt` with a 200.
 * The routes are therefore top level and carry the language as a segment they validate
 * themselves, which is why both spellings of every machine path have to be present: the
 * bare one and the `/:lang` one.
 *
 * `hidden` is read in exactly one place, `docsSitemapRows`, and the fixture config marks
 * `reference/api` hidden so the exclusion has something to exclude. A hidden page is still
 * published and addressable, so it stays in `docsLocalisedPathsFor`: a config that dropped
 * it from both would ship a page with no canonical and eight alternates pointing nowhere,
 * which renders perfectly.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { CONSUMER_ROOT } from '../../fixtures/index.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import {
	docsHref,
	docsLocalisedPathsFor,
	docsRouteRows,
	docsSitemapRows,
	type DocsRouteRow,
} from '../../src/site/address.js';

const SITE = JSON.parse(
	readFileSync(join(CONSUMER_ROOT, 'fixture-app.docs.json'), 'utf8'),
) as DocsSiteConfig;

/**
 * A second mount, so the multi-site shape is exercised rather than assumed.
 *
 * Both consumers glob `app/docs/*.docs.json`, so a second documented project is one JSON
 * file and no code edit. A function that only ever saw one config would be correct about
 * the repository it was written in and wrong about the second install.
 */
const SECOND: DocsSiteConfig = {
	...SITE,
	project: 'second-app',
	basePath: '/second-app/docs',
	pages: ['index', 'guide/index', 'guide/first-tag'],
	hidden: ['guide/first-tag'],
};

const rows = docsRouteRows([SITE]);

/** Where a row sits in the table, by path, so an ordering failure names the pattern. */
function indexOf(table: readonly DocsRouteRow[], path: string): number {
	return table.findIndex((row) => row.path === path);
}

/**
 * True when the last segment of a path is matched dynamically.
 *
 * A splat and a `:param` are the two spellings, and both are what a static suffix has to
 * be declared before. Written as a predicate over the emitted table rather than as a list
 * of the patterns this version happens to emit, so adding `:slug.json` later is covered by
 * the same assertion instead of slipping past a hard-coded set.
 */
function hasDynamicTail(path: string): boolean {
	const last = path.split('/').at(-1) ?? '';
	return last.includes('*') || last.startsWith(':');
}

describe('docsRouteRows order', () => {
	test('machine rows come first, then the dynamic markdown route, then the pages', () => {
		const kinds = rows.map((row) => `${row.kind}:${row.file}`);
		const firstPage = kinds.findIndex((kind) => kind === 'page:routes/docs.tsx');
		const lastMachineLeaf = kinds.lastIndexOf('machine:routes/docs.machine.tsx');
		const firstRaw = kinds.indexOf('machine:routes/docs.raw.tsx');
		const lastRaw = kinds.lastIndexOf('machine:routes/docs.raw.tsx');

		expect(firstPage, 'no page rows were emitted at all').toBeGreaterThan(-1);
		expect(firstRaw, 'no raw markdown route was emitted').toBeGreaterThan(-1);
		expect(lastMachineLeaf).toBeLessThan(firstRaw);
		expect(lastRaw).toBeLessThan(firstPage);
	});

	test('every static-suffix machine pattern is declared before any dynamically matched one', () => {
		// The assertion the tie is actually about. `search.json` and a dynamic pattern in the
		// same position score the same, so the one declared first wins, and the wrong winner
		// serves the search index's address from the markdown route.
		const machine = rows.filter((row) => row.kind === 'machine');
		const lastStatic = machine.reduce(
			(last, row, at) => (hasDynamicTail(row.path) ? last : at),
			-1,
		);
		const firstDynamic = machine.findIndex((row) => hasDynamicTail(row.path));
		expect(
			firstDynamic,
			'no dynamic machine pattern in the table, so this test proves nothing',
		).toBeGreaterThan(-1);
		expect(
			lastStatic,
			'no static machine pattern in the table, so this test proves nothing',
		).toBeGreaterThan(-1);
		expect(lastStatic).toBeLessThan(firstDynamic);
	});

	test('the page rows are static and sit behind the splat without tying with it', () => {
		// Page rows come last and are static, which looks like the ordering rule inverted and
		// is not: the splat is `*.md` and a page path never ends in `.md`, so the two cannot
		// score against each other. That is a property of the page addresses rather than of
		// the order, so it is asserted here rather than assumed by the test above.
		const pages = rows.filter((row) => row.kind === 'page').map((row) => row.path);
		expect(pages.filter((path) => path.endsWith('.md'))).toEqual([]);
		expect(pages.filter((path) => hasDynamicTail(path))).toEqual([]);
		const machineLeaves = new Set(
			rows
				.filter((row) => row.kind === 'machine' && !hasDynamicTail(row.path))
				.map((row) => row.path),
		);
		expect(pages.filter((path) => machineLeaves.has(path))).toEqual([]);
	});

	test('search.json is declared before the markdown splat that would swallow it', () => {
		expect(indexOf(rows, '/fixture-app/docs/search.json')).toBeLessThan(
			indexOf(rows, '/fixture-app/docs/*.md'),
		);
		expect(indexOf(rows, '/:lang/fixture-app/docs/search.json')).toBeLessThan(
			indexOf(rows, '/:lang/fixture-app/docs/*.md'),
		);
	});
});

describe('the :lang variants', () => {
	test('every machine path exists in both spellings, and the set is exactly that', () => {
		// Both directions. A missing `/:lang` row is a machine endpoint that 404s in six of
		// the seven languages; an extra row nobody expected is a route file that has to
		// validate an address nothing documents.
		const machine = rows.filter((row) => row.kind === 'machine').map((row) => row.path);
		const expected = [
			'/fixture-app/docs/llms.txt',
			'/:lang/fixture-app/docs/llms.txt',
			'/fixture-app/docs/llms-full.txt',
			'/:lang/fixture-app/docs/llms-full.txt',
			'/fixture-app/docs/search.json',
			'/:lang/fixture-app/docs/search.json',
			'/fixture-app/docs/*.md',
			'/:lang/fixture-app/docs/*.md',
		];
		expect([...machine].sort()).toEqual([...expected].sort());

		for (const path of machine.filter((one) => !one.startsWith('/:lang'))) {
			expect(machine, `${path} has no /:lang variant`).toContain(`/:lang${path}`);
		}
	});

	test('page rows carry no :lang variant, because a page mounts under the parent', () => {
		// The asymmetry is the point of the machine routes existing at all. A page route has
		// a default export, so it is matched through its parent and the parent's loader runs
		// and validates the language; a machine leaf has none and is dispatched to
		// `queryRoute`, which runs no parent loader.
		const pages = rows.filter((row) => row.kind === 'page');
		expect(pages.length).toBe(SITE.pages.length);
		expect(pages.filter((row) => row.path.startsWith('/:lang'))).toEqual([]);
	});

	test('there is one page row per declared slug, at the address docsHref gives', () => {
		const paths = rows.filter((row) => row.kind === 'page').map((row) => row.path);
		const expected = SITE.pages.map((slug) =>
			docsHref({ basePath: SITE.basePath, locale: 'en', slug }),
		);
		expect(paths).toEqual(expected);
	});
});

describe('the sitemap and the localised path list disagree about hidden pages, on purpose', () => {
	const hidden = SITE.hidden ?? [];
	const hiddenPaths = hidden.map((slug) =>
		docsHref({ basePath: SITE.basePath, locale: 'en', slug }),
	);

	test('the fixture actually marks something hidden, or this proves nothing', () => {
		expect(hidden).toContain('reference/api');
		expect(SITE.pages, 'a hidden page has to be a published one').toContain('reference/api');
	});

	test('docsSitemapRows drops every hidden page and keeps every other one', () => {
		const sitemap = docsSitemapRows([SITE]).map((row) => row.path);
		for (const path of hiddenPaths) {
			expect(sitemap, `${path} is hidden and is in the sitemap`).not.toContain(path);
		}
		// The other direction, so an exclusion that dropped too much fails as well: what is
		// left is every page except the hidden ones, and nothing else.
		const expected = SITE.pages
			.filter((slug) => !hidden.includes(slug))
			.map((slug) => docsHref({ basePath: SITE.basePath, locale: 'en', slug }))
			.sort();
		expect([...sitemap].sort()).toEqual(expected);
	});

	test('docsLocalisedPathsFor keeps hidden pages, because they are still addressable', () => {
		const localised = docsLocalisedPathsFor([SITE]);
		for (const path of hiddenPaths) {
			expect(localised, `${path} is published and is not a localised path`).toContain(path);
		}
		// And the two lists differ by exactly the hidden set, which is the whole relationship.
		const sitemap = new Set(docsSitemapRows([SITE]).map((row) => row.path));
		const onlyLocalised = localised.filter((path) => !sitemap.has(path));
		expect([...onlyLocalised].sort()).toEqual([...hiddenPaths].sort());
	});
});

describe('two sites', () => {
	const two = [SITE, SECOND];

	test('no route path is emitted twice', () => {
		const paths = docsRouteRows(two).map((row) => row.path);
		const duplicates = paths.filter((path, at) => paths.indexOf(path) !== at);
		expect(duplicates).toEqual([]);
		expect(paths.length).toBe(docsRouteRows([SITE]).length + docsRouteRows([SECOND]).length);
	});

	test('no localised path and no sitemap path is emitted twice', () => {
		const localised = docsLocalisedPathsFor(two);
		expect(new Set(localised).size).toBe(localised.length);

		const sitemap = docsSitemapRows(two).map((row) => row.path);
		expect(new Set(sitemap).size).toBe(sitemap.length);
	});

	test('each site contributes its own mount and both are present', () => {
		// A pair that merged into one, or a loop that kept only the last config, would leave
		// one mount with no routes at all and every one of its pages 404ing.
		const paths = docsRouteRows(two).map((row) => row.path);
		expect(paths.some((path) => path.startsWith('/fixture-app/docs'))).toBe(true);
		expect(paths.some((path) => path.startsWith('/second-app/docs'))).toBe(true);
		expect(docsLocalisedPathsFor(two)).toContain('/second-app/docs/guide/first-tag');
	});

	test('the second site hides its own page, and only its own', () => {
		const sitemap = docsSitemapRows(two).map((row) => row.path);
		expect(sitemap).not.toContain('/second-app/docs/guide/first-tag');
		expect(sitemap).toContain('/fixture-app/docs/guide/first-tag');
	});

	test('two configs at one basePath are deduplicated rather than refused', () => {
		// Documented behaviour rather than an accident: two sites sharing a mount is a
		// configuration error, and it is one `install` and `verify-install` report on with
		// the file names in hand. A throw from an address builder during a consumer's build
		// would name neither file.
		expect(docsLocalisedPathsFor([SITE, { ...SITE }])).toEqual(docsLocalisedPathsFor([SITE]));
	});
});
