/**
 * The MCP server mutates nothing, proved three ways.
 *
 * Row 10 of the failure catalogue names three structures: the `Command` union has no shape
 * for a writer with a tool name, `Ctx.write` is `null` over MCP, and the import graph
 * reaches no writer. The first is a typecheck and belongs to `kit/test/registry/`. This
 * file holds the other two, plus the one thing neither of them says: that every tool
 * really does run to completion with no writer, over a real corpus, leaving the tree byte
 * for byte as it found it.
 *
 * The graph walk is rooted at the tool handlers rather than at `kit/src/mcp/server.ts`,
 * and that is a correction to the claim rather than a convenience. `server.ts` imports
 * `TOOLS` from `kit/src/registry/index.ts`, and the registry is one flat array that
 * imports all sixteen commands, writers included. So the walk from `server.ts` reaches
 * `commands/publish.ts` in two hops and always will, unless the registry grows a second
 * array, which is the drift the registry exists to remove. That fact is pinned below
 * rather than left for somebody to trip over, and the assertion that carries the guarantee
 * is rooted where the dispatch actually goes: `BY_TOOL` can only reach a command that
 * declares a tool name, and the union refuses a tool name to a writer.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus } from '../../../fixtures/index.js';
import { buildBundle } from '../../src/compile/build.js';
import { writeBundle } from '../../src/compile/bundle.js';
import { READ_RECIPES, WRITE_RECIPES, holeCount, type RecipeId } from '../../src/exec/recipes.js';
import { ExecRefusal } from '../../src/exec/run.js';
import { callTool, serverContext } from '../../src/mcp/server.js';
import { COMMANDS, TOOLS } from '../../src/registry/index.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const KIT_SRC = join(REPO_ROOT, 'kit', 'src');
const COMMANDS_DIR = join(KIT_SRC, 'commands');
const KIT_VERSION = '@hex-pro/docs-kit@0.1.0';

/* -------------------------------------------------------------------------- */
/* the graph                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Comments removed, and optionally literal bodies as well, with every offset preserved.
 *
 * `scripts/lib/scan-imports.mjs` does the first half and is deliberately not used here:
 * `kit/tsconfig.json` is NodeNext with no `allowJs`, so a `.mjs` helper carrying only
 * JSDoc types is not importable from a file this configuration typechecks. The same
 * function appears in `kit/test/exec/one-spawn-site.test.ts`, which is the cost of that.
 *
 * Preserving offsets is what makes the two views comparable: an `import` keyword that
 * survives into the literal-stripped view at the same index is a real import statement,
 * and one that does not is the same words inside generated source. That distinction is
 * load-bearing here, because `kit/src/wiring/edits.ts` and `kit/src/wiring/templates.ts`
 * both build a consumer's source file as a template literal, imports and all.
 */
function strip(source: string, literals: boolean): string {
	const identEnd = /[A-Za-z0-9_$)\]}'"`]/;
	const out = source.split('');
	let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex' = 'code';
	let last = '';

	for (let i = 0; i < source.length; i += 1) {
		const char = source[i] as string;
		const next = source[i + 1];

		if (state === 'code') {
			if (char === '/' && next === '/') {
				state = 'line';
				out[i] = ' ';
				out[i + 1] = ' ';
				i += 1;
			} else if (char === '/' && next === '*') {
				state = 'block';
				out[i] = ' ';
				out[i + 1] = ' ';
				i += 1;
			} else if (char === "'") state = 'single';
			else if (char === '"') state = 'double';
			else if (char === '`') state = 'template';
			else if (char === '/' && !identEnd.test(last)) state = 'regex';
			if (char.trim() !== '') last = char;
			continue;
		}

		if (state === 'line') {
			if (char === '\n') state = 'code';
			else out[i] = ' ';
			continue;
		}

		if (state === 'block') {
			if (char === '*' && next === '/') {
				out[i] = ' ';
				out[i + 1] = ' ';
				i += 1;
				state = 'code';
			} else if (char !== '\n') out[i] = ' ';
			continue;
		}

		const closer =
			state === 'single' ? "'" : state === 'double' ? '"' : state === 'template' ? '`' : '/';
		if (char === '\\') {
			if (literals) {
				out[i] = ' ';
				if (next !== undefined && next !== '\n') out[i + 1] = ' ';
			}
			i += 1;
			continue;
		}
		if (char === closer) {
			state = 'code';
			last = char === '/' ? ')' : char;
			continue;
		}
		if (char === '\n' && state !== 'template') {
			state = 'code';
			continue;
		}
		if (literals && char !== '\n') out[i] = ' ';
	}

	return out.join('');
}

const IMPORT_STATEMENT =
	/import\s+(?:type\s+)?(?:\{([^}]*)\}|[\w$*\s,]+)\s*from\s*['"]([^'"]+)['"]/g;

/**
 * Every real import statement in a file, with the names it takes.
 *
 * "Real" is the whole job. `kit/src/wiring/templates.ts` contains
 * `import { execFileSync } from "node:child_process";` inside a template literal, and
 * `kit/src/wiring/edits.ts` contains half a dozen more, all of them imports in a
 * consumer's repository rather than in this one. The match runs over the comment-stripped
 * view, because the specifier it needs is itself a literal, and is kept only when the
 * `import` keyword survives at the same offset into the literal-stripped view.
 */
const IMPORT_CACHE = new Map<string, { specifier: string; names: string[] }[]>();

function importsOf(file: string): { specifier: string; names: string[] }[] {
	const cached = IMPORT_CACHE.get(file);
	// Memoised because the graph is walked once per tool handler and the same hundred files
	// are stripped every time. Measured: thirty-four seconds without it, four with.
	if (cached !== undefined) return cached;
	const source = readFileSync(join(REPO_ROOT, file), 'utf8');
	const text = strip(source, false);
	const code = strip(source, true);
	const found: { specifier: string; names: string[] }[] = [];
	IMPORT_STATEMENT.lastIndex = 0;
	let match;
	while ((match = IMPORT_STATEMENT.exec(text)) !== null) {
		if (!code.startsWith('import', match.index)) continue;
		const names = (match[1] ?? '')
			.split(',')
			.map(
				(name) =>
					name
						.trim()
						.replace(/^type\s+/, '')
						.split(/\s+as\s+/)[0]
						?.trim() ?? '',
			)
			.filter((name) => name !== '');
		found.push({ specifier: match[2] as string, names });
	}
	IMPORT_CACHE.set(file, found);
	return found;
}

/**
 * One relative specifier to a file on disk.
 *
 * Specifiers carry a `.js` extension by house rule and the file behind them is `.ts`,
 * which is the same resolution `test/render/entrypoints.test.ts` does for the runtime
 * half. Anything that resolves to nothing is reported rather than dropped, because a
 * specifier that resolves to nothing prunes the graph below it and every assertion over
 * the graph is then satisfied by a walk that stopped early.
 */
function resolveSpecifier(from: string, specifier: string): string | undefined {
	const base = resolve(dirname(from), specifier);
	for (const candidate of [base.replace(/\.js$/, '.ts'), base, `${base}.ts`]) {
		if (existsSync(candidate) && !candidate.endsWith('/')) return candidate;
	}
	return undefined;
}

interface Graph {
	/** Every file reachable from the entry point, repository-relative and sorted. */
	files: string[];
	unresolved: string[];
}

function graphFrom(entry: string): Graph {
	const seen = new Set<string>();
	const unresolved: string[] = [];
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		if (!/\.tsx?$/.test(file)) continue;
		for (const { specifier } of importsOf(relative(REPO_ROOT, file))) {
			if (!specifier.startsWith('.')) continue;
			// `.js` and nothing else. `kit/tsconfig.json` is NodeNext with
			// `verbatimModuleSyntax`, so every real relative import in this half carries the
			// extension and `tsc --noEmit` refuses one that does not.
			if (!specifier.endsWith('.js')) continue;
			const resolved = resolveSpecifier(file, specifier);
			if (resolved === undefined) {
				unresolved.push(`${relative(REPO_ROOT, file)} imports "${specifier}"`);
				continue;
			}
			queue.push(resolved);
		}
	}
	return { files: [...seen].map((file) => relative(REPO_ROOT, file)).sort(), unresolved };
}

const moduleOf = (name: string): string => `kit/src/commands/${name}.ts`;

const TOOL_MODULES = TOOLS.map((command) => moduleOf(command.name)).sort();
const WRITER_MODULES = COMMANDS.filter((command) => command.writes !== 'nothing')
	.map((command) => moduleOf(command.name))
	.sort();

/** Every file any tool handler can reach, which is the graph the guarantee is about. */
const TOOL_GRAPH = (() => {
	const files = new Set<string>();
	const unresolved: string[] = [];
	for (const module of TOOL_MODULES) {
		const graph = graphFrom(join(REPO_ROOT, module));
		for (const file of graph.files) files.add(file);
		unresolved.push(...graph.unresolved);
	}
	return { files: [...files].sort(), unresolved };
})();

describe('the registry decides which modules are writers', () => {
	test('every command has a module, and every module is a command, in both directions', () => {
		// `common.ts` is the shared parameter table and defines no command. It is named here
		// rather than filtered by a pattern, so a second non-command file added to this
		// directory fails until somebody says what it is.
		const onDisk = readdirSync(COMMANDS_DIR)
			.filter((name) => name.endsWith('.ts'))
			.sort();
		const expected = [...COMMANDS.map((command) => `${command.name}.ts`), 'common.ts'].sort();
		expect(onDisk).toEqual(expected);
	});

	test('the writers are exactly the commands with no tool name', () => {
		// Derived from the registry in both directions rather than listed, so a command that
		// gained a `writes` value or lost a tool name changes what this file guards without an
		// edit here. The `Command` union makes one direction a typecheck; this is the other.
		const writers = COMMANDS.filter((command) => command.writes !== 'nothing').map(
			(command) => command.name,
		);
		const toolless = COMMANDS.filter((command) => command.tool === null).map(
			(command) => command.name,
		);
		expect(writers.sort()).toEqual(['build', 'init', 'install', 'prefetch', 'publish', 'sync']);
		// `mcp` is the one tool-less command that writes nothing: a tool that starts the
		// server would be a server calling itself, which is a reason about the surface rather
		// than about `writes`.
		expect(toolless.sort()).toEqual([...writers, 'mcp'].sort());
	});

	test('the tool modules are the nine commands with a tool name', () => {
		expect(TOOL_MODULES.length).toBe(9);
		expect(TOOLS.every((command) => command.tool !== null)).toBe(true);
	});
});

describe('the tool graph reaches no writer', () => {
	test('the walk resolved every relative import it followed', () => {
		// A specifier that resolves to nothing prunes the graph below it, and every assertion
		// in this describe block is satisfied by a graph that stopped early.
		expect(TOOL_GRAPH.unresolved).toEqual([]);
		expect(TOOL_GRAPH.files.length).toBeGreaterThan(60);
	});

	test('no writer module is reachable from any tool handler', () => {
		const reached = WRITER_MODULES.filter((module) => TOOL_GRAPH.files.includes(module));
		expect(reached).toEqual([]);
		// Not vacuous: the writers exist and are real modules. A `WRITER_MODULES` that had
		// gone empty would satisfy the assertion above in silence.
		expect(WRITER_MODULES.length).toBe(6);
		for (const module of WRITER_MODULES) {
			expect(existsSync(join(REPO_ROOT, module)), `${module} is not on disk`).toBe(true);
		}
	});

	test('nothing in the tool graph imports WRITE_RECIPES', () => {
		// The binding, not the module. `kit/src/exec/recipes.ts` is reachable and has to be:
		// `exec/run.ts` reads `ALL_RECIPES` out of it to fill a template. What must not be
		// reachable is the write half by name, which is why `recipes.ts` splits the two tables
		// into two exported constants rather than carrying one table with a `mutates` flag.
		const importers: string[] = [];
		for (const file of TOOL_GRAPH.files) {
			for (const { names } of importsOf(file)) {
				if (names.includes('WRITE_RECIPES')) importers.push(file);
			}
		}
		expect(importers).toEqual([]);
		// The control: `recipes.ts` is in the graph, so the scan above looked at the file that
		// exports the binding it is looking for.
		expect(TOOL_GRAPH.files).toContain('kit/src/exec/recipes.ts');
	});

	test('nothing in the tool graph imports the s3 client or the file writer', () => {
		// Two modules whose whole purpose is to change something outside this process. Neither
		// is a command, so the writer assertion above does not cover them.
		for (const module of ['kit/src/s3/client.ts', 'kit/src/io/write.ts']) {
			expect(TOOL_GRAPH.files, `${module} is reachable from a tool`).not.toContain(module);
			expect(existsSync(join(REPO_ROOT, module))).toBe(true);
		}
	});

	test('the direct runRecipe callers are exactly these three, in both directions', () => {
		// `serverContext.exec` refuses a write recipe by name, and that refusal only covers a
		// caller that goes through `Ctx.exec`. `kit/src/compile/git.ts` does not: it imports
		// `runRecipe` and calls it, so the compiler's git reads never pass the server's gate.
		// What closes that instead is its own signature, `git(root, id: ReadRecipeId, ...)`,
		// which makes a write recipe a typecheck failure at the call site rather than a
		// refusal at runtime. That is sound and it is worth being able to see: a fourth module
		// reaching straight for `runRecipe` fails here, and the reviewer then has to say which
		// of the two guards covers it.
		const callers: string[] = [];
		const walk = (directory: string): void => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (entry.name.endsWith('.ts')) {
					const file = relative(REPO_ROOT, path);
					if (file === 'kit/src/exec/run.ts') continue;
					for (const { names } of importsOf(file)) {
						if (names.includes('runRecipe')) callers.push(file);
					}
				}
			}
		};
		walk(KIT_SRC);
		expect(callers.sort()).toEqual([
			// The CLI context's `exec`, which is the unrestricted one on purpose.
			'kit/src/cli/main.ts',
			// The git walk, held by `ReadRecipeId` rather than by the server's set.
			'kit/src/compile/git.ts',
			// The server context's `exec`, which wraps it in the read-recipe refusal.
			'kit/src/mcp/server.ts',
		]);
	});
});

/**
 * Modules in the tool graph that import a filesystem write function.
 *
 * Declared with a reason and checked in both directions. This is not an exemption: the
 * test below it closes the hole the declaration opens, by asserting that the writing
 * function this module exports is imported by exactly one module in the package and that
 * that module is a writer with no tool name. A declaration on its own would be the kind of
 * list that grows a second entry nobody argues about.
 */
const FS_WRITERS_IN_GRAPH: readonly { path: string; names: readonly string[]; why: string }[] = [
	{
		path: 'kit/src/compile/bundle.ts',
		names: ['mkdirSync', 'writeFileSync'],
		why: 'writeBundle and verifyBundle share this module, and the tool graph reaches it for verifyBundle, which docs_bundle needs. The write-once refusal writeBundle implements is a stronger guarantee than the Writer interface can express, which is why it goes to the filesystem directly, and commands/build.ts says so where it calls it.',
	},
];

/** Every `node:fs` export that changes something. */
const FS_WRITE_NAMES = [
	'appendFile',
	'appendFileSync',
	'chmodSync',
	'chownSync',
	'copyFile',
	'copyFileSync',
	'cp',
	'cpSync',
	'createWriteStream',
	'linkSync',
	'mkdir',
	'mkdirSync',
	'mkdtemp',
	'mkdtempSync',
	'open',
	'openSync',
	'rename',
	'renameSync',
	'rm',
	'rmSync',
	'rmdirSync',
	'symlinkSync',
	'truncateSync',
	'unlink',
	'unlinkSync',
	'utimesSync',
	'writeFile',
	'writeFileSync',
	'writeSync',
];

describe('filesystem writes in the tool graph', () => {
	const found = TOOL_GRAPH.files
		.map((file) => ({
			path: file,
			names: importsOf(file)
				.filter(({ specifier }) => /^node:fs(\/promises)?$/.test(specifier))
				.flatMap(({ names }) => names)
				.filter((name) => FS_WRITE_NAMES.includes(name))
				.sort(),
		}))
		.filter((file) => file.names.length > 0);

	test('the modules importing one are exactly the declared ones, in both directions', () => {
		expect(found.map((file) => file.path).sort()).toEqual(
			FS_WRITERS_IN_GRAPH.map((entry) => entry.path).sort(),
		);
		for (const entry of FS_WRITERS_IN_GRAPH) {
			const file = found.find((candidate) => candidate.path === entry.path);
			expect(file?.names, `${entry.path} no longer imports what it was declared for`).toEqual(
				[...entry.names].sort(),
			);
			expect(
				entry.why.length,
				`${entry.path} has a reason too short to be a decision`,
			).toBeGreaterThan(80);
		}
	});

	test('the one writing function in that module is called from one writer only', () => {
		// This is what turns the declaration above into a proof. `writeBundle` is the only
		// export of `compile/bundle.ts` that writes, and if the single module importing it is
		// a command with no tool name, then no tool can reach a write however the imports are
		// arranged. Both directions: an importer added anywhere fails, and an empty result
		// fails too.
		const importers: string[] = [];
		const walk = (directory: string): void => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (entry.name.endsWith('.ts')) {
					const file = relative(REPO_ROOT, path);
					for (const { specifier, names } of importsOf(file)) {
						if (!specifier.endsWith('compile/bundle.js') && !specifier.endsWith('./bundle.js')) {
							continue;
						}
						if (names.includes('writeBundle')) importers.push(file);
					}
				}
			}
		};
		walk(KIT_SRC);
		expect(importers).toEqual(['kit/src/commands/build.ts']);
		expect(WRITER_MODULES).toContain('kit/src/commands/build.ts');
	});
});

describe('what the walk from mcp/server.ts actually reaches', () => {
	const server = graphFrom(join(REPO_ROOT, 'kit', 'src', 'mcp', 'server.ts'));

	/**
	 * The claim in `kit/src/README.md` row 10, taken literally, is not true.
	 *
	 * `mcp/server.ts` imports the registry, the registry is one flat array of all sixteen
	 * commands, and so the import graph from the server reaches `commands/publish.ts`,
	 * `install.ts`, `init.ts`, `sync.ts`, `prefetch.ts` and `build.ts`. That is a property
	 * of the registry being one list, which is the whole point of the registry, so it is a
	 * documentation defect rather than a code one and it is marked rather than fixed.
	 *
	 * The guarantee is not weakened by it: dispatch goes through `BY_TOOL`, which is built
	 * from `COMMANDS.filter(c => c.tool !== null)`, and the `Command` union refuses a tool
	 * name to a writer. The assertions rooted at the tool handlers above are what prove it.
	 *
	 * This turns red the day the server stops reaching a writer, which is the signal to
	 * delete the `.fails` and keep the assertion.
	 */
	test.fails('no writer module is reachable from mcp/server.ts', () => {
		expect(WRITER_MODULES.filter((module) => server.files.includes(module))).toEqual([]);
	});

	test('the server reaches every writer, through the registry barrel', () => {
		// The other half, so the state is pinned rather than described. The edge is named:
		// server.ts imports the registry index, and the registry index imports every command.
		expect(WRITER_MODULES.filter((module) => server.files.includes(module))).toEqual(
			WRITER_MODULES,
		);
		expect(
			importsOf('kit/src/mcp/server.ts').some(({ specifier }) =>
				specifier.endsWith('registry/index.js'),
			),
		).toBe(true);
		expect(
			importsOf('kit/src/registry/index.ts').some(({ specifier }) =>
				specifier.endsWith('commands/publish.js'),
			),
		).toBe(true);
		expect(server.unresolved).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */
/* the runtime half                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The exec the MCP context carries, refusing by name.
 *
 * `serverContext` does not use `NO_EXEC`: two read-only tools genuinely need git, and
 * refusing those would make the server answer differently from the CLI about the same
 * tree. What it does instead is a set of read recipe ids, and the two assertions below are
 * the both-directions check on that set. Neither spawns anything: a read id is driven with
 * a deliberately wrong arity, so it reaches `runRecipe` and is refused there for the
 * arity rather than for the id, which is what says it got past the gate.
 */
function wrongArity(id: RecipeId): string[] {
	return holeCount(id) === 0 ? ['extra'] : Array(holeCount(id) - 1).fill('value');
}

describe('the MCP context refuses the write recipes by name', () => {
	const ctx = serverContext(REPO_ROOT, KIT_VERSION);

	for (const id of Object.keys(WRITE_RECIPES) as RecipeId[]) {
		test(`${id} is refused`, () => {
			let thrown: unknown;
			try {
				ctx.exec(id, Array(holeCount(id)).fill('value'), { cwd: REPO_ROOT });
			} catch (error) {
				thrown = error;
			}
			expect((thrown as Error | undefined)?.message).toContain('does not run');
			expect((thrown as Error).message).toContain(id);
		});
	}

	for (const id of Object.keys(READ_RECIPES) as RecipeId[]) {
		test(`${id} gets past the gate`, () => {
			let thrown: unknown;
			try {
				ctx.exec(id, wrongArity(id), { cwd: REPO_ROOT });
			} catch (error) {
				thrown = error;
			}
			// It reached `runRecipe` and was refused there for the arity, which is what says
			// the id is in the safe set. A read recipe dropped from that set would fail here
			// with "does not run" instead.
			expect(thrown).toBeInstanceOf(ExecRefusal);
			expect((thrown as Error).message).not.toContain('does not run');
		});
	}

	test('an id in neither table is refused', () => {
		expect(() => ctx.exec('aws.delete-object' as RecipeId, [], { cwd: REPO_ROOT })).toThrow(
			/does not run/,
		);
	});
});

describe('every tool runs to completion with no writer', () => {
	let scratch: string;
	let corpus: string;
	let bundlePath: string;
	let before: string;

	/**
	 * The tree, hashed.
	 *
	 * `.git` is included. A read command that refreshed the index or wrote a reflog would
	 * show up here, and it should: the corpus is materialised into a throwaway repository
	 * precisely so that a command touching git is visible rather than hidden behind a
	 * shared checkout.
	 */
	function fingerprint(root: string): string {
		const hash = createHash('sha256');
		const walk = (directory: string): void => {
			for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
				a.name.localeCompare(b.name),
			)) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) {
					walk(path);
					continue;
				}
				if (!entry.isFile()) continue;
				hash.update(relative(root, path));
				hash.update(readFileSync(path));
			}
		};
		walk(root);
		return hash.digest('hex');
	}

	beforeAll(() => {
		scratch = mkdtempSync(join(tmpdir(), 'hexdocs-no-write-'));
		corpus = materialiseCorpus(join(scratch, 'app')).root;
		// Written outside the corpus, so building something for `docs_bundle` to read does not
		// itself change the tree this test is watching.
		const built = buildBundle(corpus, { generator: KIT_VERSION });
		bundlePath = writeBundle(join(scratch, 'bundle'), built.manifest, built.objects).prefix;
		before = fingerprint(corpus);
	});

	afterAll(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	/**
	 * One argument set per tool, chosen so the call does real work rather than refusing at
	 * the door.
	 *
	 * `docs_label` and `docs_verify_install` are the two that answer with `not-run` rows
	 * against this corpus, because it is an application repository and neither a site config
	 * nor a consuming site exists in it. That is the honest answer and it is still a
	 * completed run, which is what this block is about.
	 */
	const argumentsFor = (name: string): Record<string, unknown> => {
		switch (name) {
			case 'docs_page':
				return { slug: 'index', root: corpus };
			case 'docs_bundle':
				return { path: bundlePath };
			case 'docs_label':
				return {
					root: corpus,
					project: 'fixture-app',
					commit: 'a'.repeat(40),
					version: '1.2.0',
				};
			case 'docs_scaffold':
				return { kind: 'page', root: corpus, slug: 'guide/new-page', locale: ['en'] };
			case 'docs_skills':
				return {};
			case 'docs_verify_install':
				return { root: corpus, site: 'apps/front' };
			default:
				return { root: corpus };
		}
	};

	test('the context the server hands a command has no writer', () => {
		expect(serverContext(corpus, KIT_VERSION).write).toBeNull();
	});

	/** Which tools actually ran, so the sweep below cannot pass over an empty session. */
	const ran = new Set<string>();

	for (const command of TOOLS) {
		const name = command.tool as string;
		test(`${name} answers`, async () => {
			const ctx = serverContext(corpus, KIT_VERSION);
			const text = await callTool(name, argumentsFor(name), ctx);
			// Parseable JSON, because that is what the client receives and what an agent reads.
			// A tool that threw would never reach here: `callTool` does not catch.
			const data: unknown = JSON.parse(text);
			expect(data, `${name} answered with no data`).not.toBeUndefined();
			expect(text.length).toBeGreaterThan(1);
			ran.add(name);
		});
	}

	test('the corpus is byte for byte what it was', () => {
		// Ordered after the calls above, which vitest runs in declaration order within a file.
		// The set is what makes that dependency checked rather than assumed: a run where the
		// tool tests were skipped or reordered fails here naming the count instead of
		// reporting a clean tree nothing touched.
		expect(ran.size, 'the tools did not run before this sweep').toBe(TOOLS.length);
		// This is the assertion `Ctx.write === null` cannot make on its own:
		// `compile/bundle.ts` is in the tool graph and goes to the filesystem directly, so no
		// writer in the context is a claim about one code path and this is a measurement over
		// all of them.
		expect(fingerprint(corpus)).toBe(before);
	});
});
