/**
 * A stand-in for `react-router routes --json`, for tests that have no React Router.
 *
 * `wiring-routes` runs the consuming site's own CLI, and neither this package nor the
 * fixture consumers have one installed. So the fixture tests inject an `Exec` that answers
 * that recipe from this model instead, and the model is only worth anything if it fails the
 * way the real loader fails. What it copies, and where from:
 *
 *   * `app/routes.ts` is evaluated as code, through TypeScript's own transpiler, with
 *     `route`, `index` and `layout` taking the arguments `@react-router/dev/routes` takes.
 *     A spread placed in the wrong array lands in the wrong array, and an instruction
 *     constant pasted with a typo throws, which no text match could reproduce.
 *   * The ids are defaulted and refused exactly as `configRoutesToRouteManifest` does in
 *     @react-router/dev 7.13: a route with no id takes its file path less the extension,
 *     and a second route with an id already taken throws "Unable to define routes with
 *     duplicate route id". Measured against the real CLI on both consumers' real
 *     `routes.ts`: the step-5 machine spread with no ids fails with that message, naming
 *     `routes/docs.machine`.
 *   * A specifier the plugin-less loader cannot resolve throws "Cannot find package", which
 *     is the real message for `@hex-pro/docs` imported from the server module, measured on
 *     both consumers.
 *   * The output is `formatRoutesAsJson`'s shape: a `root` route whose children are the
 *     top-level routes, with `undefined` fields dropped by `JSON.stringify`.
 *
 * What it does not copy is stated so nobody leans on it: Vite's own resolution, the site's
 * `react-router.config.ts`, and any module `routes.ts` imports other than the server module
 * and the handful of site registries stubbed below. The real CLI was run over both
 * consumers' real route configs with the templates and instructions in place, and it is the
 * reason the model's messages are the ones it prints.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';

import ts from 'typescript';

import type { DocsRouteRow } from '../../../src/site/address.js';
import { runRecipe, type Exec, type RunResult } from '../../src/exec/run.js';
import { valueImportSpecifiers } from '../../src/wiring/needles.js';
import { rowId } from '../../src/wiring/route-table.js';

interface Entry {
	id?: string;
	path?: string;
	index?: boolean;
	caseSensitive?: boolean;
	file: string;
	children?: Entry[];
}

type Options = { id?: string; caseSensitive?: boolean };

function isChildren(value: unknown): value is Entry[] {
	return Array.isArray(value);
}

/** `@react-router/dev/routes`, as far as a route config calls it. */
const ROUTES_MODULE = {
	route(path: string, file: string, second?: Options | Entry[], third?: Entry[]): Entry {
		const options = isChildren(second) ? {} : (second ?? {});
		const children = isChildren(second) ? second : third;
		return { path, file, ...options, ...(children === undefined ? {} : { children }) };
	},
	index(file: string, options: Options = {}): Entry {
		return { index: true, file, ...options };
	},
	layout(file: string, second?: Options | Entry[], third?: Entry[]): Entry {
		const options = isChildren(second) ? {} : (second ?? {});
		const children = isChildren(second) ? second : third;
		return { file, ...options, ...(children === undefined ? {} : { children }) };
	},
};

/**
 * The site registries `routes.ts` imports, reduced to what it reads.
 *
 * hex-web's route table spreads four registries into `PAGES` and kcalc's maps one. Their
 * contents are the site's business and not what a docs row is compared against, so each is
 * the smallest value the real file's use of it accepts.
 */
const SITE_MODULES: Readonly<Record<string, Record<string, unknown>>> = {
	'lib/conversions': { CONVERSION_PATHS: [], CONVERTER: { file: 'routes/tools.convert.tsx' } },
	'lib/legal': { LEGAL_PATHS: ['/hex-nfc/privacy'] },
	'lib/redirects': { REDIRECT_PATHS: [] },
	'lib/tools': { TOOLS: [], TOOLS_PATH: '/tools', toolPath: () => '' },
	'lib/pages': {
		PAGES: [
			{ path: '/', file: 'routes/home.tsx' },
			{ path: '/pricing', file: 'routes/pricing.tsx' },
		],
	},
};

const INVALID = '\u001b[31mRoute config in "routes.ts" is invalid.\u001b[39m';

function refused(message: string): RunResult {
	return {
		status: 1,
		stdout: '',
		stderr: `${INVALID}\n\nError: ${message}\n    at ViteNodeRunner.runModule (vite-node/dist/client.mjs:397:4)\n`,
	};
}

/** Evaluates `app/routes.ts` under a site directory and prints what the CLI would print. */
export function loadRouteTable(siteRoot: string, rows: readonly DocsRouteRow[]): RunResult {
	const app = join(siteRoot, 'app');
	const routesFile = join(app, 'routes.ts');

	const require = (specifier: string): unknown => {
		if (specifier === '@react-router/dev/routes') return ROUTES_MODULE;
		if (!specifier.startsWith('./')) {
			throw new Error(`Cannot find package '${specifier}' imported from '${routesFile}'`);
		}
		const target = specifier.slice(2);
		if (target === 'lib/docs.server') {
			const serverFile = join(app, 'lib/docs.server.ts');
			if (!existsSync(serverFile)) {
				throw new Error(`Failed to load url ./lib/docs.server (resolved id: ./lib/docs.server)`);
			}
			const alias = valueImportSpecifiers(readFileSync(serverFile, 'utf8')).find(
				(value) => !value.startsWith('.'),
			);
			if (alias !== undefined) {
				throw new Error(`Cannot find package '${alias}' imported from '${serverFile}'`);
			}
			return { DOCS_ROUTES: rows };
		}
		const stub = SITE_MODULES[target];
		if (stub === undefined) throw new Error(`Failed to load url ${specifier}`);
		return stub;
	};

	let config: unknown;
	try {
		const code = ts.transpileModule(readFileSync(routesFile, 'utf8'), {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		}).outputText;
		const module = { exports: {} as Record<string, unknown> };
		new Function('require', 'module', 'exports', code)(require, module, module.exports);
		config = module.exports['default'];
	} catch (error) {
		return refused(error instanceof Error ? error.message : String(error));
	}
	// `configRoutesToRouteManifest`, including where it throws.
	const seen = new Set<string>();
	const walk = (entry: Entry): Record<string, unknown> => {
		const id = entry.id ?? normalize(entry.file.replace(/\.[a-z0-9]+$/i, ''));
		if (seen.has(id)) throw new Error(`Unable to define routes with duplicate route id: "${id}"`);
		seen.add(id);
		const children = (entry.children ?? []).map(walk);
		return {
			id,
			index: entry.index,
			path: entry.path,
			caseSensitive: entry.caseSensitive,
			file: entry.file,
			children: children.length > 0 ? children : undefined,
		};
	};
	try {
		const root = walk({ id: 'root', path: '', file: 'root.tsx', children: config as Entry[] });
		return { status: 0, stdout: `${JSON.stringify([root], null, 2)}\n`, stderr: '' };
	} catch (error) {
		return refused(error instanceof Error ? error.message : String(error));
	}
}

/**
 * The route rows with the machine ids the row contract names, where a row lacks one.
 *
 * Temporary, and marked so it cannot outlive its reason. `DocsRouteRow.id` is added by the
 * runtime half in the same step as this wiring, and until it lands every machine row names
 * one module with no id, so the model refuses the table exactly as the real loader would.
 * That would leave the wired baseline red and every mutation below it unable to show a row
 * moving. `route-table.test.ts` carries a `test.fails` asserting the rows already carry these
 * ids; the day they do, it turns red and names this function to delete.
 */
export function withContractIds(rows: readonly DocsRouteRow[]): DocsRouteRow[] {
	return rows.map((row) =>
		row.kind === 'machine' && rowId(row) === undefined
			? ({ ...row, id: `docs:${row.path}` } as DocsRouteRow)
			: row,
	);
}

/**
 * An `Exec` that answers the route recipe from the model and runs every other recipe.
 *
 * `rows` is a function rather than a value so a mutation that changes the site config
 * changes what `DOCS_ROUTES` holds, as it would in the site.
 */
export function modelExec(rows: (siteRoot: string) => readonly DocsRouteRow[]): Exec {
	return (id, holes, options) =>
		id === 'react-router.routes'
			? loadRouteTable(options.cwd, rows(options.cwd))
			: runRecipe(id, holes, options);
}
