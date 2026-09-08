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

// @ts-expect-error -- a zero-dependency guard, written as .mjs like the others
import { run_ as runSurface } from '../scripts/check-cli.mjs';
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

/** Linked: large, on no argv path, and nothing here mutates them. */
const LINKED = ['kit/node_modules', 'src', 'fixtures'] as const;

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
