/**
 * Reading a consuming site's route table through its own React Router.
 *
 * Three states, and they are three because they fail a run for three different reasons. A
 * table that loaded is compared row by row. A table the loader refused is a fact about the
 * site, so the row fails with the loader's own message. A table nothing could read, because
 * the site's dependencies are not installed or the output held no table, is a check that did
 * not run, and `not-run` fails the run as well, for the reason `diagnostics.ts` gives.
 *
 * The table shapes here are written the way `formatRoutesAsJson` in @react-router/dev 7.13
 * prints them, which was read from the installed source and then watched: `react-router
 * routes --json` run over both consumers' real route configs, with the templates and the
 * printed instructions applied, loaded in 0.4 to 1.6 seconds, wrote nothing to either tree,
 * and produced a table these functions found no problem with. Dropping the machine route ids
 * produced exactly the refusal quoted below.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { CONSUMER_ROOT } from '../../../fixtures/index.js';
import type { DocsSiteConfig } from '../../../src/contracts/site.js';
import { docsRouteRows, type DocsRouteRow } from '../../../src/site/address.js';
import { runRecipe, type Exec, type RunResult } from '../../src/exec/run.js';
import { detectSite, memoryFiles } from '../../src/wiring/detect.js';
import {
	loaderMessage,
	parseRouteTable,
	readRouteTable,
	routeTableProblems,
	type RouteNode,
} from '../../src/wiring/route-table.js';

const SITE = detectSite({
	repoRoot: '/nowhere',
	site: 'apps/front',
	mount: 'common/docs',
	files: memoryFiles({ 'apps/front/node_modules/.bin/react-router': '#!/bin/sh\n' }),
});

const PAGES: DocsRouteRow[] = [
	{ path: '/app/docs', file: 'routes/docs.tsx', kind: 'page' },
	{ path: '/app/docs/guide', file: 'routes/docs.tsx', kind: 'page' },
];

/**
 * A machine row carrying the id the row contract names. Built through a spread rather than
 * written as a literal, so it compiles against a row type that has not grown `id` yet.
 */
function machine(path: string): DocsRouteRow {
	const id = { id: `docs:${path}` };
	return { path, file: 'routes/docs.machine.tsx', kind: 'machine', ...id };
}

const MACHINES: DocsRouteRow[] = [
	machine('/app/docs/llms.txt'),
	machine('/:lang/app/docs/llms.txt'),
];

const ROWS = [...PAGES, ...MACHINES];

function page(prefix: string, path: string): RouteNode {
	return { id: `${prefix}${path}`, path, file: 'routes/docs.tsx' };
}

/** A table the way the site's loader prints one when every row is where it belongs. */
function wiredTable(): RouteNode[] {
	return [
		{ id: 'en/home', index: true, file: 'routes/home.tsx' },
		page('en/', 'app/docs'),
		page('en/', 'app/docs/guide'),
		{ id: 'routes/robots[.]txt', path: 'robots.txt', file: 'routes/robots[.]txt.tsx' },
		{ id: 'docs:/app/docs/llms.txt', path: 'app/docs/llms.txt', file: 'routes/docs.machine.tsx' },
		{
			id: 'docs:/:lang/app/docs/llms.txt',
			path: ':lang/app/docs/llms.txt',
			file: 'routes/docs.machine.tsx',
		},
		{
			id: 'routes/lang',
			path: ':lang',
			file: 'routes/lang.tsx',
			children: [page('lang/', 'app/docs'), page('lang/', 'app/docs/guide')],
		},
	];
}

function printed(routes: RouteNode[]): RunResult {
	return {
		status: 0,
		stdout: JSON.stringify([{ id: 'root', path: '', file: 'root.tsx', children: routes }], null, 2),
		stderr: '',
	};
}

describe('parseRouteTable', () => {
	test('a table is the children of root', () => {
		const table = parseRouteTable(printed(wiredTable()), SITE);
		expect(table.kind).toBe('loaded');
		expect(table.kind === 'loaded' ? table.routes.map((node) => node.id) : []).toEqual(
			wiredTable().map((node) => node.id),
		);
	});

	test('a root with no children is a loaded table with nothing in it', () => {
		const result = { status: 0, stdout: '[{"id":"root","path":"","file":"root.tsx"}]', stderr: '' };
		expect(parseRouteTable(result, SITE)).toEqual({ kind: 'loaded', routes: [] });
	});

	test('a binary that never started is unread, naming the binary', () => {
		const table = parseRouteTable({ status: null, stdout: '', stderr: 'spawn ENOENT' }, SITE);
		expect(table.kind).toBe('unread');
		expect(table.kind === 'unread' ? table.why : '').toContain(
			'apps/front/node_modules/.bin/react-router',
		);
		expect(table.kind === 'unread' ? table.why : '').toContain('spawn ENOENT');
		const silent = parseRouteTable({ status: null, stdout: '', stderr: '' }, SITE);
		expect(silent.kind === 'unread' ? silent.why : '').toContain('no reason given');
	});

	test('a non-zero exit is the loader refusing the config, in its own words', () => {
		const table = parseRouteTable(
			{
				status: 1,
				stdout: '',
				stderr:
					'\u001b[31mRoute config in "routes.ts" is invalid.\u001b[39m\n\nError: Unable to define routes with duplicate route id: "routes/docs.machine"\n    at walk (dist/cli/index.js:245:15)\n',
			},
			SITE,
		);
		expect(table).toEqual({
			kind: 'refused',
			message:
				'Route config in "routes.ts" is invalid. Error: Unable to define routes with duplicate route id: "routes/docs.machine"',
		});
		expect(parseRouteTable({ status: 2, stdout: '', stderr: '' }, SITE)).toEqual({
			kind: 'refused',
			message: '`react-router routes --json` exited 2 and printed no reason.',
		});
	});

	test('output that is not JSON, or not a route tree, is unread rather than an empty table', () => {
		// An empty table would have every docs row missing and fail loudly for the wrong
		// reason; unread says the table was not seen at all.
		const notJson = parseRouteTable({ status: 0, stdout: 'Using config at ...', stderr: '' }, SITE);
		expect(notJson.kind === 'unread' ? notJson.why : '').toContain('did not parse as JSON');
		for (const stdout of [
			'{}',
			'[{"id":"nope","file":"x"}]',
			'[{"id":"root"}]',
			'null',
			'[{"id":"root","file":"root.tsx","children":[{"path":1}]}]',
		]) {
			const table = parseRouteTable({ status: 0, stdout, stderr: '' }, SITE);
			expect([stdout, table.kind]).toEqual([stdout, 'unread']);
		}
		const badIndex =
			'[{"id":"root","file":"root.tsx","children":[{"id":"a","file":"a","index":"yes"}]}]';
		expect(parseRouteTable({ status: 0, stdout: badIndex, stderr: '' }, SITE).kind).toBe('unread');
		const badChildren = '[{"id":"root","file":"root.tsx","children":{}}]';
		expect(parseRouteTable({ status: 0, stdout: badChildren, stderr: '' }, SITE).kind).toBe(
			'unread',
		);
	});
});

describe('loaderMessage', () => {
	test('keeps three lines at most and stops at the first stack frame', () => {
		expect(loaderMessage('one\n\ntwo\nthree\nfour\n')).toBe('one two three');
		expect(loaderMessage('one\n    at somewhere (file.js:1:1)\ntwo\n')).toBe('one');
		expect(loaderMessage('\u001b[1m\u001b[31mred\u001b[39m\u001b[22m')).toBe('red');
		expect(loaderMessage('')).toBe('');
	});
});

describe('routeTableProblems', () => {
	test('a table with every row in place has no problems', () => {
		expect(routeTableProblems(wiredTable(), ROWS)).toEqual([]);
	});

	test('no rows at all has no problems, however the table looks', () => {
		expect(routeTableProblems([], [])).toEqual([]);
	});

	test('page rows missing at the bare mount are counted, naming the first', () => {
		const table = wiredTable().filter((node) => node.id !== 'en/app/docs/guide');
		expect(routeTableProblems(table, ROWS)).toEqual([
			'1 of 2 docs page route(s) are not declared at the bare mount, starting with `/app/docs/guide`.',
		]);
	});

	test('a page row declared twice at a mount is its own problem', () => {
		const table = [...wiredTable(), page('again/', 'app/docs')];
		expect(routeTableProblems(table, ROWS)).toEqual([
			'`/app/docs` is declared 2 times at the bare mount, and 1 docs page route(s) are repeated there.',
		]);
	});

	test('a page with the right path and the wrong module is not declared', () => {
		const table = wiredTable().map((node) =>
			node.id === 'en/app/docs' ? { ...node, file: 'routes/home.tsx' } : node,
		);
		expect(routeTableProblems(table, ROWS)[0]).toMatch(
			/not declared at the bare mount, starting with `\/app\/docs`/,
		);
	});

	test('page rows missing under :lang, and no :lang route at all', () => {
		const withoutLangChildren = wiredTable().map((node) =>
			node.path === ':lang' ? { ...node, children: [] } : node,
		);
		expect(routeTableProblems(withoutLangChildren, ROWS)).toEqual([
			'2 of 2 docs page route(s) are not declared under `:lang`, starting with `/app/docs`.',
		]);
		const noChildrenKey = wiredTable().map((node) => {
			if (node.path !== ':lang') return node;
			const { children: _children, ...rest } = node;
			return rest;
		});
		expect(routeTableProblems(noChildrenKey, ROWS)[0]).toMatch(/not declared under `:lang`/);
		const noLang = wiredTable().filter((node) => node.path !== ':lang');
		expect(routeTableProblems(noLang, ROWS)).toEqual([
			"This site's route table has no top-level `:lang` route, so it does not have the seven-language URL scheme this package installs into.",
		]);
		// With no page rows there is nothing to mount under `:lang`, so its absence says nothing.
		expect(routeTableProblems(noLang, MACHINES)).toEqual([]);
	});

	test('machine rows nested under :lang are not declared at the top level', () => {
		const table = wiredTable()
			.filter((node) => node.file !== 'routes/docs.machine.tsx')
			.map((node) =>
				node.path === ':lang'
					? {
							...node,
							children: [
								...(node.children ?? []),
								{
									id: 'docs:/app/docs/llms.txt',
									path: 'app/docs/llms.txt',
									file: 'routes/docs.machine.tsx',
								},
							],
						}
					: node,
			);
		expect(routeTableProblems(table, ROWS)).toEqual([
			'2 of 2 machine route(s) are not declared at the top level, starting with `/app/docs/llms.txt`.',
		]);
	});

	test('a machine route with an id other than its row names', () => {
		const table = wiredTable().map((node) =>
			node.id === 'docs:/app/docs/llms.txt' ? { ...node, id: 'my-llms' } : node,
		);
		expect(routeTableProblems(table, ROWS)).toEqual([
			'1 machine route(s) carry an id other than the one their row names, starting with `/app/docs/llms.txt` declared as `my-llms` where the row names `docs:/app/docs/llms.txt`.',
		]);
		// A row with no id to compare says nothing about the node's id.
		const idless = MACHINES.map(
			(row) => ({ path: row.path, file: row.file, kind: row.kind }) as DocsRouteRow,
		);
		expect(routeTableProblems(table, [...PAGES, ...idless])).toEqual([]);
	});
});

describe('readRouteTable', () => {
	const scratch = mkdtempSync(join(tmpdir(), 'hexdocs-route-table-'));
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	test('a site with no binary is unread without spawning anything', () => {
		let calls = 0;
		const exec: Exec = () => {
			calls += 1;
			return printed(wiredTable());
		};
		const bare = detectSite({
			repoRoot: '/nowhere',
			site: 'apps/front',
			mount: 'common/docs',
			files: memoryFiles({}),
		});
		const table = readRouteTable(bare, exec);
		expect(calls).toBe(0);
		expect(table.kind === 'unread' ? table.why : '').toContain(
			'apps/front/node_modules/.bin/react-router is not there',
		);
		// The same answer twice, from the memo, and still no spawn.
		expect(readRouteTable(bare, exec)).toBe(table);
		expect(calls).toBe(0);
	});

	test('one read per descriptor and exec, with the site directory as cwd', () => {
		const seen: { id: string; holes: readonly string[]; cwd: string }[] = [];
		const exec: Exec = (id, holes, options) => {
			seen.push({ id, holes, cwd: options.cwd });
			return printed(wiredTable());
		};
		const site = detectSite({
			repoRoot: '/repo',
			site: 'apps/front',
			mount: 'common/docs',
			files: memoryFiles({ 'apps/front/node_modules/.bin/react-router': '' }),
		});
		const first = readRouteTable(site, exec);
		expect(readRouteTable(site, exec)).toBe(first);
		expect(seen).toEqual([{ id: 'react-router.routes', holes: [], cwd: '/repo/apps/front' }]);
		// A different exec is a different question, so it asks again.
		readRouteTable(site, (id, holes, options) => exec(id, holes, options));
		expect(seen).toHaveLength(2);
	});

	test('an exec that refuses the recipe is unread, not a thrown tool call', () => {
		// The MCP server's exec throws for a recipe it does not list.
		const table = readRouteTable(SITE, () => {
			throw new Error('The MCP server does not run "react-router.routes".');
		});
		expect(table.kind === 'unread' ? table.why : '').toContain('does not run');
		const odd = readRouteTable(
			detectSite({ repoRoot: '/x', site: 'apps/front', mount: 'common/docs', files: SITE.files }),
			() => {
				throw 'a string';
			},
		);
		expect(odd.kind === 'unread' ? odd.why : '').toContain('a string');
	});

	test('the relative binary is the site own, resolved against the cwd', () => {
		// The one real spawn in this file, of a shell script standing in for the binary, and it
		// proves the thing a fake cannot: `spawnSync('./node_modules/.bin/react-router')` runs
		// the copy under the cwd it was given, not one found on PATH.
		const site = join(scratch, 'apps', 'front');
		const binary = join(site, 'node_modules', '.bin', 'react-router');
		mkdirSync(join(binary, '..'), { recursive: true });
		const json = JSON.stringify([
			{
				id: 'root',
				path: '',
				file: 'root.tsx',
				children: [{ id: 'here', path: 'here', file: 'x.tsx' }],
			},
		]);
		writeFileSync(
			binary,
			`#!/bin/sh\n[ "$1 $2" = "routes --json" ] || exit 9\nprintf '%s' '${json}'\n`,
			'utf8',
		);
		chmodSync(binary, 0o755);
		const descriptor = detectSite({ repoRoot: scratch, site: 'apps/front', mount: 'common/docs' });
		expect(readRouteTable(descriptor, runRecipe)).toEqual({
			kind: 'loaded',
			routes: [{ id: 'here', path: 'here', file: 'x.tsx' }],
		});
	});
});

describe('the rows the wiring compares against', () => {
	const config = JSON.parse(
		readFileSync(join(CONSUMER_ROOT, 'fixture-app.docs.json'), 'utf8'),
	) as DocsSiteConfig;

	// The contract the loader model and the check both lean on: a machine row names the id
	// it is declared under, so the printed spread passes it through and two rows sharing one
	// module never collide. Drop it from `docsRouteRows` and this is the test that says so.
	test('every machine row carries docs:<path> as its id', () => {
		const machines = docsRouteRows([config]).filter((row) => row.kind === 'machine');
		expect(machines.length).toBeGreaterThan(0);
		expect(machines.map((row) => row.id)).toEqual(machines.map((row) => `docs:${row.path}`));
	});
});
