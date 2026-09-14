/**
 * The guard that drives the real launcher, driven.
 *
 * `scripts/check-cli.mjs` is the one row in the ladder that spawns `kit/bin/hexdocs`
 * rather than importing a module, so it is the only thing covering the shell script, tsx
 * resolution, the process exit code and whether stdout stays clean while the same
 * launcher is serving a protocol. A guard with that job and no test of its own is the
 * shape this repository refuses everywhere else, so it gets one here, exactly as
 * `test/paint.test.ts` does for the browser row.
 *
 * The failure paths are what matter. A green run of the guard proves the surface is
 * right; it does not prove the guard could have said otherwise. Each case below breaks
 * one thing in a throwaway copy of the repository and asserts that exactly the row which
 * claims to watch it goes red.
 */

import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

// A zero-dependency guard, written as .mjs like the others, typed by its own JSDoc:
// `tsconfig.test.json` sets `allowJs` so the compiler reads it, and leaves `checkJs` off
// so nothing in it is held to the compiler. Turn that flag off and this import is an
// implicit `any` and the row assertions below stop being checked against anything.
import { checkFirstRun, run_ as runSurface } from '../scripts/check-cli.mjs';
import type { CheckResult } from '../scripts/lib/report.mjs';
import { REPO_ROOT } from './support/golden.js';

/**
 * A throwaway repository the guard can be pointed at.
 *
 * Only the four files a mutation here changes are copied. Everything else is symlinked to
 * the real tree, and that is not an optimisation: `kit/node_modules` is a pnpm store full
 * of symlinks, and copying it produces a directory where `tsx` resolves nothing, so the
 * launcher starts and the MCP server answers no frames. The first version of this helper
 * did copy it, and the resulting failure looked exactly like a broken server rather than
 * like a broken fixture, which is the reason this comment is here.
 */
const MUTABLE = [
	'kit/schema/tools-1.json',
	'kit/bin/hexdocs',
	'kit/start.sh',
	'kit/package.json',
] as const;

/**
 * Copied, because a symlink here stops the CLI running at all.
 *
 * `main.ts`'s run-as-main guard compares `import.meta.url` against
 * `pathToFileURL(process.argv[1])`. The launcher execs `$KIT_DIR/src/cli/main.ts`, so
 * argv carries the path it was given while `import.meta.url` carries the resolved real
 * one, and through a symlink those differ: the guard is false, `main()` never runs, and
 * the process exits 0 having printed nothing. The first version of this helper symlinked
 * it and the failure read as an MCP server answering no frames, which is why the guard
 * now captures the child's stderr and why this is written down. It is a property of the
 * fixture rather than of production, where a consumer mounts a real submodule directory.
 */
const COPIED_TREES = ['kit/src'] as const;

/**
 * Linked: large, on no argv path, and nothing here mutates them.
 *
 * The kit's lockfile is here because the first-run row copies the kit out of this tree and
 * installs it with `--frozen-lockfile`, which refuses outright without one. That row copies
 * with links dereferenced, so it reads these files and never writes through them.
 */
const LINKED = ['kit/node_modules', 'kit/pnpm-lock.yaml', 'src', 'fixtures'] as const;

const temporaries: string[] = [];

function copyRepo(): string {
	const root = mkdtempSync(join(tmpdir(), 'hexdocs-surface-'));
	temporaries.push(root);
	for (const relative of MUTABLE) {
		const target = join(root, relative);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(join(REPO_ROOT, relative), target);
	}
	for (const relative of COPIED_TREES) {
		cpSync(join(REPO_ROOT, relative), join(root, relative), { recursive: true });
	}
	for (const relative of LINKED) {
		const target = join(root, relative);
		mkdirSync(dirname(target), { recursive: true });
		symlinkSync(join(REPO_ROOT, relative), target);
	}
	cpSync(join(REPO_ROOT, 'package.json'), join(root, 'package.json'));
	return root;
}

afterAll(() => {
	for (const root of temporaries) rmSync(root, { recursive: true, force: true });
});

function rowsBy(rows: CheckResult[]): Map<string, CheckResult> {
	return new Map(rows.map((row) => [row.name, row]));
}

describe('against this repository', () => {
	test('every row passes and reports what it examined', async () => {
		const rows = (await runSurface()) as CheckResult[];
		expect(rows.map((row) => row.name)).toEqual([
			'help',
			'json output',
			'mcp handshake',
			'launchers',
			'first run',
		]);
		for (const row of rows) {
			expect(row.state, `${row.name}: ${(row.problems ?? []).join('; ')}`).toBe('PASS');
			// Every row measures rather than asserts. A row here that examined nothing would
			// already be a failure by `check`'s own coercion, so this is about the guard
			// counting the right thing rather than about the count being non-zero.
			expect(row.examined, row.name).toBeGreaterThan(0);
		}
	}, 120_000);
});

describe('when the catalogue is gone', () => {
	test('there is no verdict rather than a bad one', async () => {
		const root = copyRepo();
		rmSync(join(root, 'kit', 'schema', 'tools-1.json'));

		const rows = (await runSurface(root)) as CheckResult[];
		// One row, and it is NOT RUN. The catalogue is what says how many commands and
		// tools there should be, so without it the guard cannot report a shortfall, and a
		// guard that cannot report a shortfall must not report a pass.
		expect(rows.length).toBe(1);
		expect(rows[0]?.state).toBe('NOT RUN');
		expect(rows[0]?.note ?? '').toContain('pnpm schemas');
	}, 120_000);
});

describe('when the surface and the registry disagree', () => {
	/** Rewrites the copied catalogue, which is what the guard compares against. */
	function doctorCatalogue(
		root: string,
		change: (document: Record<string, unknown>) => void,
	): void {
		const path = join(root, 'kit', 'schema', 'tools-1.json');
		const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		change(document);
		writeFileSync(path, `${JSON.stringify(document, null, '\t')}\n`, 'utf8');
	}

	test('a command the catalogue has and --help does not is named', async () => {
		const root = copyRepo();
		doctorCatalogue(root, (document) => {
			(document['commands'] as Record<string, unknown>[]).push({
				name: 'invented',
				tool: null,
				writes: 'nothing',
				summary: 'A command nothing implements.',
				positionals: [],
				flags: [],
				taughtBy: ['docs-diagnose'],
			});
		});

		const rows = rowsBy((await runSurface(root)) as CheckResult[]);
		const help = rows.get('help');
		expect(help?.state).toBe('FAIL');
		expect((help?.problems ?? []).join(' ')).toContain('invented');
		// And only that row. A mutation that reddened everything would say nothing about
		// which check watches what.
		expect(rows.get('launchers')?.state).toBe('PASS');
		expect(
			rows.get('mcp handshake')?.state,
			(rows.get('mcp handshake')?.problems ?? []).join(' | '),
		).toBe('PASS');
	}, 120_000);

	test('a tool the catalogue has and the server does not advertise is named', async () => {
		const root = copyRepo();
		doctorCatalogue(root, (document) => {
			const commands = document['commands'] as Record<string, unknown>[];
			const target = commands.find((command) => command['name'] === 'init');
			if (target !== undefined) target['tool'] = 'docs_init';
		});

		const rows = rowsBy((await runSurface(root)) as CheckResult[]);
		const mcp = rows.get('mcp handshake');
		expect(mcp?.state).toBe('FAIL');
		expect((mcp?.problems ?? []).join(' ')).toContain('docs_init');
	}, 120_000);
});

describe('when the first-run install is wrong for a consuming workspace', () => {
	/** Rewrites one line of the copied launcher, asserting the line was really there. */
	function editLauncher(root: string, from: string, to: string): void {
		const path = join(root, 'kit', 'bin', 'hexdocs');
		const text = readFileSync(path, 'utf8');
		expect(text.split(from).length, `the launcher no longer contains ${from}`).toBe(2);
		writeFileSync(path, text.replace(from, to), 'utf8');
	}

	test('without --ignore-workspace it installs the workspace instead, and the row says so', async () => {
		// The step 8 defect, reproduced. pnpm walks up from the kit to the workspace the site
		// belongs to, installs that, and leaves the kit with no tsx to exec.
		const root = copyRepo();
		editLauncher(
			root,
			'pnpm install --ignore-workspace --frozen-lockfile --prod',
			'pnpm install --frozen-lockfile --prod',
		);

		const rows = rowsBy((await runSurface(root)) as CheckResult[]);
		const first = rows.get('first run');
		expect(first?.state).toBe('FAIL');
		const said = (first?.problems ?? []).join(' ');
		expect(said).toContain('node_modules at the workspace root');
		expect(said).toContain('no node_modules/.bin/tsx');
		// And only that row: the others run a kit whose install already exists.
		expect(rows.get('help')?.state).toBe('PASS');
		expect(rows.get('launchers')?.state).toBe('PASS');
	}, 180_000);

	test('an install that announces itself on stderr is named, with what it added', async () => {
		// The deploy's failure message is the tail of stderr. A first build after a submodule
		// bump that printed install output there would bury the row that says why it failed.
		const root = copyRepo();
		editLauncher(
			root,
			'if [ ! -x "$KIT_DIR/node_modules/.bin/tsx" ]; then\n',
			'if [ ! -x "$KIT_DIR/node_modules/.bin/tsx" ]; then\n\techo "hexdocs: installing" >&2\n',
		);

		const rows = rowsBy((await runSurface(root)) as CheckResult[]);
		const first = rows.get('first run');
		expect(first?.state).toBe('FAIL');
		expect((first?.problems ?? []).join(' ')).toContain('more characters to stderr');
		expect((first?.problems ?? []).join(' ')).toContain('hexdocs: installing');
	}, 180_000);
});

describe('when the first run cannot be exercised on this machine', () => {
	/**
	 * Runs the row with some environment variables replaced, and puts them back.
	 *
	 * The row reads `CI` and hands its own environment to pnpm, so these are the two knobs a
	 * machine without pnpm, or with a store that lacks the kit's packages, actually turns.
	 */
	function withEnv(
		changes: Record<string, string | undefined>,
		body: () => CheckResult,
	): CheckResult {
		const saved = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
		const apply = (values: Record<string, string | undefined>): void => {
			for (const [key, value] of Object.entries(values)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		};
		apply(changes);
		try {
			return body();
		} finally {
			apply(saved);
		}
	}

	test('no pnpm is a skip naming it, and the same state under CI is a failure', () => {
		// Called directly rather than through the whole guard, because every other row needs
		// node on PATH and this one is being handed a PATH with nothing on it.
		const skipped = withEnv({ PATH: '/nonexistent', CI: undefined }, () =>
			checkFirstRun(REPO_ROOT),
		);
		expect(skipped.state).toBe('SKIPPED');
		expect(skipped.note ?? '').toContain('pnpm is not on PATH');

		const failed = withEnv({ PATH: '/nonexistent', CI: 'true' }, () => checkFirstRun(REPO_ROOT));
		expect(failed.state).toBe('FAIL');
		expect((failed.problems ?? []).join(' ')).toContain('broken environment rather than a skip');
	});

	test('a store without the kit packages is a skip naming the command that fills it', () => {
		// The install runs offline, so an empty store is the state a fresh machine is in. It is
		// not the launcher's fault, and reporting it as one would send somebody into a shell
		// script that is working.
		const store = mkdtempSync(join(tmpdir(), 'hexdocs-empty-store-'));
		temporaries.push(store);
		const row = withEnv({ npm_config_store_dir: store, CI: undefined }, () =>
			checkFirstRun(REPO_ROOT),
		);
		expect(row.state).toBe('SKIPPED');
		expect(row.note ?? '').toContain('does not hold the kit dependencies');
		expect(row.note ?? '').toContain('pnpm --dir kit install');
	}, 180_000);
});

describe('when the launcher is not executable', () => {
	test('the row says so rather than the run dying', async () => {
		const root = copyRepo();
		// The state a fresh clone reaches on a filesystem that drops the bit, which is what
		// makes a submodule unusable with no message naming the cause.
		chmodSync(join(root, 'kit', 'start.sh'), 0o644);

		const rows = rowsBy((await runSurface(root)) as CheckResult[]);
		const launchers = rows.get('launchers');
		expect(launchers?.state).toBe('FAIL');
		expect((launchers?.problems ?? []).join(' ')).toContain('not executable');
		expect(launchers?.examined).toBe(2);
	}, 120_000);
});
