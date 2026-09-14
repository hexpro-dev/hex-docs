/**
 * The consuming site's route table, as its own React Router evaluates it.
 *
 * Step 5 read `routes.ts` as text: a `DOCS_ROUTES` token somewhere, and one between the bare
 * mount and the `:lang` mount. Against the real hex-web that passed over a table that could
 * not load at all, twice over. The generated module imported `@hex-pro/docs`, which React
 * Router's plugin-less config loader cannot resolve, and the printed machine spread passed no
 * route id, which that loader refuses as a duplicate. It also passed a table with the machine
 * spread and no page spread, because the import line alone satisfied the token test. And no
 * single needle fitted the second consumer, whose page rows are declared in a helper above the
 * default export.
 *
 * So there is no needle. `react-router routes --json`, run with the site's own binary in the
 * site's own directory, prints the table the build will use, and the assertions here are about
 * structure: every page row once at the top level and once under `:lang`, every machine row at
 * the top level with the id its row names. A table that does not load is the loader's own
 * message, which names the file and the id. Measured with each consumer's installed CLI over
 * its real route config and the step 8 templates: 0.3 to 0.5 seconds on hex-web and 0.8 to
 * 1.6 on kcalc, and a before-and-after listing of both trees showed nothing written.
 */

import { resolve } from 'node:path';

import type { DocsRouteRow } from '../../../src/site/address.js';
import type { Exec, RunResult } from '../exec/run.js';

import { joinPosix, type SiteDescriptor } from './site.js';

/** One route as `react-router routes --json` prints it. */
export interface RouteNode {
	readonly id: string;
	readonly path?: string;
	readonly index?: boolean;
	/** Relative to the site's `app/` directory. */
	readonly file: string;
	readonly children?: readonly RouteNode[];
}

export type RouteTable =
	/** The children of `root`, which is to say the routes `routes.ts` declares at top level. */
	| { readonly kind: 'loaded'; readonly routes: readonly RouteNode[] }
	/** The loader ran and refused the config. A fact about the site, so the row fails. */
	| { readonly kind: 'refused'; readonly message: string }
	/** Nothing could be read: no binary, or output with no table in it. The row did not run. */
	| { readonly kind: 'unread'; readonly why: string };

// The escape character written as an escape, for the reason `exec/run.ts` gives about the NUL.
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The part of the loader's stderr a person needs.
 *
 * Colour codes are stripped because picocolors turns them on whenever `CI` is set, which is
 * exactly where this runs unattended. The stack frames are dropped because the first frame
 * names vite-node's runner rather than the consumer's file, and the two lines above them are
 * the ones that say which file and which id.
 */
export function loaderMessage(stderr: string): string {
	const lines: string[] = [];
	for (const line of stderr.replace(ANSI, '').split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		if (trimmed.startsWith('at ')) break;
		lines.push(trimmed);
		if (lines.length === 3) break;
	}
	return lines.join(' ');
}

function isNode(value: unknown): value is RouteNode {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const node = value as Record<string, unknown>;
	if (typeof node['id'] !== 'string' || typeof node['file'] !== 'string') return false;
	if (node['path'] !== undefined && typeof node['path'] !== 'string') return false;
	if (node['index'] !== undefined && typeof node['index'] !== 'boolean') return false;
	const children = node['children'];
	return children === undefined || (Array.isArray(children) && children.every(isNode));
}

/** What one run of the recipe says, as one of the three states. */
export function parseRouteTable(result: RunResult, site: SiteDescriptor): RouteTable {
	const binary = joinPosix(site.site, 'node_modules/.bin/react-router');
	if (result.status === null) {
		return {
			kind: 'unread',
			why: `\`react-router routes --json\` did not start: ${result.stderr.trim() || 'no reason given'}. It runs ${binary}, so this site's dependencies are not installed here, and nothing about its route table was read.`,
		};
	}
	if (result.status !== 0) {
		return {
			kind: 'refused',
			message:
				loaderMessage(result.stderr) ||
				`\`react-router routes --json\` exited ${result.status} and printed no reason.`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return {
			kind: 'unread',
			why: `\`react-router routes --json\` exited 0 and its output did not parse as JSON, so nothing about the route table was read. It began: ${JSON.stringify(result.stdout.slice(0, 120))}.`,
		};
	}
	const root = Array.isArray(parsed)
		? parsed.find((node: unknown) => isNode(node) && node.id === 'root')
		: undefined;
	if (root === undefined) {
		return {
			kind: 'unread',
			why: '`react-router routes --json` exited 0 and printed something other than a route tree with a `root` route, so nothing about the route table was read.',
		};
	}
	return { kind: 'loaded', routes: (root as RouteNode).children ?? [] };
}

/**
 * One read per descriptor and exec, because two readers need it in one run.
 *
 * `PRESENT.routes` and the `wiring-routes` probe both ask, and the probe also wants the
 * detail, so without this `verify-install` would evaluate the site's route config twice.
 * Keyed on the descriptor object rather than a path, so a second `detectSite` reads again:
 * this is a memo within one run and never a cache of a consumer's source.
 *
 * An exec that throws is `unread`, not a crash. The MCP server's exec refuses any recipe it
 * does not list, and a refusal there is "this context cannot read the route table", which is
 * a row that did not run rather than a tool call that failed.
 */
const TABLES = new WeakMap<SiteDescriptor, WeakMap<Exec, RouteTable>>();

export function readRouteTable(site: SiteDescriptor, exec: Exec): RouteTable {
	const forSite = TABLES.get(site) ?? new WeakMap<Exec, RouteTable>();
	TABLES.set(site, forSite);
	const cached = forSite.get(exec);
	if (cached !== undefined) return cached;

	// Looked for before anything is spawned. A site whose dependencies are not installed is
	// the ordinary state on a fresh clone, and answering it from the file rather than from a
	// spawn error makes the reason the same sentence in every context: the CLI's exec would
	// report ENOENT and the MCP server's would report a refusal, and one row would carry two
	// different notes for one fact.
	const binary = joinPosix(site.site, 'node_modules/.bin/react-router');
	if (!site.files.exists(binary)) {
		const missing: RouteTable = {
			kind: 'unread',
			why: `${binary} is not there, so this site's dependencies are not installed here and its route table was not read. Install them in ${site.site} and run this again.`,
		};
		forSite.set(exec, missing);
		return missing;
	}

	let table: RouteTable;
	try {
		table = parseRouteTable(
			exec('react-router.routes', [], {
				cwd: resolve(site.repoRoot, site.site),
				timeoutMs: 60_000,
			}),
			site,
		);
	} catch (error) {
		table = {
			kind: 'unread',
			why: `\`react-router routes --json\` could not be run here: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	forSite.set(exec, table);
	return table;
}

function declared(nodes: readonly RouteNode[], row: DocsRouteRow): RouteNode[] {
	const path = row.path.slice(1);
	return nodes.filter((node) => node.path === path && node.file === row.file);
}

/**
 * What is wrong with a loaded table, as sentences. Empty exactly when every row is routed.
 *
 * Counted per arm rather than listed per row, because a missing spread is every row at once
 * and a report of sixty identical lines is a report nobody reads to the end.
 */
export function routeTableProblems(
	routes: readonly RouteNode[],
	rows: readonly DocsRouteRow[],
): string[] {
	const problems: string[] = [];
	const pages = rows.filter((row) => row.kind === 'page');
	const machines = rows.filter((row) => row.kind === 'machine');

	const arm = (where: string, nodes: readonly RouteNode[], expected: readonly DocsRouteRow[]) => {
		const missing = expected.filter((row) => declared(nodes, row).length === 0);
		const repeated = expected.filter((row) => declared(nodes, row).length > 1);
		const first = missing[0];
		if (first !== undefined) {
			problems.push(
				`${missing.length} of ${expected.length} docs page route(s) are not declared ${where}, starting with \`${first.path}\`.`,
			);
		}
		const again = repeated[0];
		if (again !== undefined) {
			problems.push(
				`\`${again.path}\` is declared ${declared(nodes, again).length} times ${where}, and ${repeated.length} docs page route(s) are repeated there.`,
			);
		}
	};

	if (pages.length > 0) {
		arm('at the bare mount', routes, pages);
		const lang = routes.find((node) => node.path === ':lang');
		if (lang === undefined) {
			problems.push(
				"This site's route table has no top-level `:lang` route, so it does not have the seven-language URL scheme this package installs into.",
			);
		} else {
			arm('under `:lang`', lang.children ?? [], pages);
		}
	}

	const unmounted = machines.filter((row) => declared(routes, row).length === 0);
	const firstUnmounted = unmounted[0];
	if (firstUnmounted !== undefined) {
		problems.push(
			`${unmounted.length} of ${machines.length} machine route(s) are not declared at the top level, starting with \`${firstUnmounted.path}\`.`,
		);
	}
	const renamed = machines.filter((row) => {
		const id = row.id;
		const node = declared(routes, row)[0];
		return id !== undefined && node !== undefined && node.id !== id;
	});
	const firstRenamed = renamed[0];
	if (firstRenamed !== undefined) {
		problems.push(
			`${renamed.length} machine route(s) carry an id other than the one their row names, starting with \`${firstRenamed.path}\` declared as \`${declared(routes, firstRenamed)[0]?.id ?? ''}\` where the row names \`${firstRenamed.id ?? ''}\`.`,
		);
	}
	return problems;
}
