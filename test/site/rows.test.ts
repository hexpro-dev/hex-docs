/**
 * The route rows, as data: which rows exist, what they are called, and which carry ids.
 *
 * What a row matches is `router.test.ts`, through the installed React Router, and that is
 * the test that would have caught step 5's `*.md` rows. This file pins the set in both
 * directions, so a row that stops being emitted, or one nobody expected, fails naming it.
 *
 * Every row is static now. There is no dynamic pattern left to tie with a static one, so
 * there is no ordering rule to test, and the step 5 tests that asserted one were deleted
 * rather than rewritten: a rule that can never fire is a green row over nothing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { CONSUMER_ROOT } from '../../fixtures/index.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import {
	DOCS_MACHINE_MODULE,
	DOCS_PAGE_MODULE,
	docsHref,
	docsRouteRows,
} from '../../src/site/address.js';
import { createStaticHandler, dataRoutes, hexWebRoutes } from '../support/router.js';

const COMMITTED = JSON.parse(
	readFileSync(join(CONSUMER_ROOT, 'fixture-app.docs.json'), 'utf8'),
) as DocsSiteConfig;

/** The fixture config with the redirect `hexdocs sync` writes from the fixture manifest. */
const SITE: DocsSiteConfig = { ...COMMITTED, redirects: { 'first-tag': 'guide/first-tag' } };

/**
 * A second mount, so the multi-site shape is exercised rather than assumed. Both consumers
 * glob `app/docs/*.docs.json`, so a second documented project is one JSON file and no code
 * edit, and a function that only ever saw one config would be wrong about the second one.
 */
const SECOND: DocsSiteConfig = {
	...COMMITTED,
	project: 'second-app',
	basePath: '/second-app/docs',
	pages: ['index', 'guide/index', 'guide/first-tag'],
	hidden: ['guide/first-tag'],
};

const rows = docsRouteRows([SITE]);

describe('the machine rows', () => {
	const machine = rows.filter((row) => row.kind === 'machine');

	test('are llms.txt, llms-full.txt and one raw address per page, each at both mounts, and nothing else', () => {
		const expected = [
			'/fixture-app/docs/llms.txt',
			'/fixture-app/docs/llms-full.txt',
			...SITE.pages.map((slug) => `/fixture-app/docs/${slug}.md`),
		].flatMap((path) => [path, `/:lang${path}`]);
		expect(machine.map((row) => row.path).sort()).toEqual([...expected].sort());
	});

	test('carry no pattern of any kind beyond the language segment', () => {
		// A splat swallows mistyped page URLs into the machine module, and a `*` anywhere else
		// is escaped by React Router and matches only its own literal spelling.
		for (const row of rows) {
			const rest = row.path.replace(/^\/:lang\//, '/');
			expect({ path: row.path, pattern: /[*:]/.test(rest) }).toEqual({
				path: row.path,
				pattern: false,
			});
		}
		expect(rows.some((row) => row.path.endsWith('search.json'))).toBe(false);
	});

	test('each carry the id docs:<path>, because they all share one module file', () => {
		for (const row of machine) {
			expect({ path: row.path, file: row.file, id: row.id }).toEqual({
				path: row.path,
				file: DOCS_MACHINE_MODULE,
				id: `docs:${row.path}`,
			});
		}
	});
});

describe('the page rows', () => {
	const pages = rows.filter((row) => row.kind === 'page');

	test('are one per page and one per redirect source, at the English address, with no slash at the end', () => {
		const expected = [...SITE.pages, 'first-tag'].map((slug) =>
			docsHref({ basePath: SITE.basePath, locale: 'en', slug }),
		);
		expect(pages.map((row) => row.path).sort()).toEqual([...expected].sort());
		expect(pages.filter((row) => row.path.endsWith('/'))).toEqual([]);
		expect(pages.map((row) => row.path)).toContain('/fixture-app/docs');
	});

	test('carry no id, because a consumer mounts each twice under its own prefixes', () => {
		// Measured against hex-web's table: a per-row page id spread into both mounts collides
		// with itself and React Router refuses the whole config.
		for (const row of pages) {
			expect({ path: row.path, file: row.file, hasId: 'id' in row }).toEqual({
				path: row.path,
				file: DOCS_PAGE_MODULE,
				hasId: false,
			});
		}
	});

	test('carry no :lang variant, because a page mounts under the parent', () => {
		// A page route has a default export, so it is matched through the `:lang` parent and
		// that parent's loader validates the language. A machine leaf has none, runs no
		// parent loader, and so is declared at both mounts itself.
		expect(pages.filter((row) => row.path.startsWith('/:lang'))).toEqual([]);
	});

	test('a config with no redirects contributes page rows for its pages alone', () => {
		const plain = docsRouteRows([COMMITTED]).filter((row) => row.kind === 'page');
		expect(plain.length).toBe(COMMITTED.pages.length);
	});
});

describe('two sites', () => {
	const two = docsRouteRows([SITE, SECOND]);

	test('emit no path and no id twice, and exactly the rows each would emit alone', () => {
		const paths = two.map((row) => row.path);
		expect(paths.filter((path, at) => paths.indexOf(path) !== at)).toEqual([]);
		const ids = two.flatMap((row) => (row.id === undefined ? [] : [row.id]));
		expect(new Set(ids).size).toBe(ids.length);
		expect(two.length).toBe(docsRouteRows([SITE]).length + docsRouteRows([SECOND]).length);
	});

	test('each contribute their own mount, hidden pages included, because hidden is not unpublished', () => {
		const paths = two.map((row) => row.path);
		expect(paths).toContain('/second-app/docs/guide/first-tag');
		expect(paths).toContain('/fixture-app/docs/reference/api');
		expect(paths).toContain('/:lang/second-app/docs/llms.txt');
	});

	test('at one basePath are not deduplicated, so the router refuses the config naming the id', () => {
		// Two sites sharing a mount is a configuration error. Emitting it twice lets React
		// Router's duplicate-id refusal name it during the build, which a silent dedupe would
		// have hidden until one project's pages were found missing.
		const twice = docsRouteRows([SITE, { ...SITE }]);
		expect(twice.length).toBe(2 * rows.length);
		expect(() => createStaticHandler(dataRoutes(hexWebRoutes(twice), {}))).toThrow(
			/route id collision on id "en\/fixture-app\/docs"/,
		);
	});
});
