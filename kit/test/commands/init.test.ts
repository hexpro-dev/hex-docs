/**
 * `hexdocs init`, driven against a real filesystem.
 *
 * The half worth testing hardest is the second one: `init` is the only command in this
 * package that edits a file it did not write, and the file it edits is the public-mirror
 * allowlist. `kit/test/source/allow-paths.test.ts` pins the parser and the messages; this
 * pins what the command does with them, which is a different property and fails
 * differently. A refusal that produced the right words and wrote the files anyway would
 * pass every assertion in that file.
 *
 * So every refusing case here asserts three things together: the row is `not-run`, the
 * exit code is 3, and **the repository is byte for byte what it was**, scaffold files
 * included. That last one is the assertion the design turns on. An allowlist refusal stops
 * the whole run rather than only the allowlist edit, because somebody whose mirror already
 * copies its internal documentation tree needs to fix that before anything else, not
 * receive a half-finished setup and a warning they can scroll past.
 *
 * The idempotency claim is measured rather than asserted, the way `io/write.ts` says: a
 * second run gets a fresh writer and `written` is the list of paths that actually changed,
 * so "running it twice writes nothing" is an assertion about a length.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeEach, describe, expect, test } from 'vitest';

import { SITE_ROOT_RELATIVE } from '../../../src/contracts/project.js';
import { UsageError } from '../../src/cli/args.js';
import { init } from '../../src/commands/init.js';
import { fileWriter } from '../../src/io/write.js';
import { exitCodeFor, invoke, type Ctx } from '../../src/registry/command.js';
import { NO_EXEC } from '../../src/exec/run.js';
import {
	ALLOW_PATHS_REFUSAL_IDS,
	MIRROR_SCRIPT_RELATIVE,
	PUBLISH_WORKFLOW_RELATIVE,
	parseAllowPaths,
	type AllowPathsRefusalId,
} from '../../src/source/allow-paths.js';
import { sourceScaffold } from '../../src/templates/source.js';

const INDENT = '    ';

/**
 * The real allowlist shape, shortened to the entries the behaviour under test turns on.
 *
 * The full twenty-one-entry array is the fixture in `allow-paths.test.ts`, where the shape
 * itself is what is being pinned. Here the array only has to be readable, have an anchor
 * in the middle of it, and carry the two `.github` entries that must survive the edit, so
 * the file stays short enough to be compared byte for byte in an assertion message.
 */
const ENTRIES: readonly string[] = [
	'app',
	'LICENSE',
	'docs/public',
	'.github/workflows/ci.yml',
	'.github/scripts',
];

function mirror(entries: readonly string[] = ENTRIES): string {
	return [
		'#!/usr/bin/env bash',
		'set -euo pipefail',
		'',
		'readonly ALLOW_PATHS=(',
		...entries.map((entry) => `${INDENT}"${entry}"`),
		')',
		'',
		'copy_allowed_paths',
		'prune_internal_files',
		'',
	].join('\n');
}

const roots: string[] = [];

function repository(mirrorText: string | null): string {
	const root = mkdtempSync(join(tmpdir(), 'hexdocs-init-'));
	roots.push(root);
	if (mirrorText !== null) write(root, MIRROR_SCRIPT_RELATIVE, mirrorText);
	return root;
}

function write(root: string, relative: string, contents: string): void {
	const path = join(root, ...relative.split('/'));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, 'utf8');
}

function read(root: string, relative: string): string | null {
	const path = join(root, ...relative.split('/'));
	return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Run {
	root: string;
	writer: ReturnType<typeof fileWriter>;
}

function context(run: Run): Ctx {
	return {
		cwd: run.root,
		kitVersion: '@hex-pro/docs-kit@0.0.0-test',
		exec: NO_EXEC,
		write: run.writer,
		now: () => new Date('2026-06-01T00:00:00Z'),
		log: () => undefined,
	};
}

const ARGS = {
	project: 'fixture-app',
	'product-name': 'Fixture App',
	repo: 'hexpro-dev/fixture-app',
};

async function run(root: string, extra: Record<string, unknown> = {}) {
	const writer = fileWriter();
	const output = await invoke(init, { root, ...ARGS, ...extra }, context({ root, writer }));
	const data = output.data as {
		created: string[];
		unchanged: string[];
		refused: { path: string; why: string }[];
		allowPaths: string;
		allowPathsLine: string | null;
		write: boolean;
	};
	return { output, data, writer, exit: exitCodeFor(output) };
}

/** Every path the scaffold creates, which is what "nothing was written" is measured over. */
const PLAN = sourceScaffold({
	project: ARGS.project,
	productName: ARGS['product-name'],
	repo: ARGS.repo,
	locales: ['en'],
});
const CREATED_PATHS = PLAN.files
	.filter((file) => file.action === 'create')
	.map((file) => file.path);

// ---------------------------------------------------------------------------
// the ordinary run
// ---------------------------------------------------------------------------

describe('a repository with a readable allowlist', () => {
	test('writes every scaffolded file and adds exactly one allowlist line', async () => {
		const root = repository(mirror());
		const before = read(root, MIRROR_SCRIPT_RELATIVE) as string;
		const { data, writer, exit, output } = await run(root, { write: true });

		expect(exit).toBe(0);
		expect(data.write).toBe(true);
		expect(data.refused).toEqual([]);
		// Both directions over the scaffold's own list, so a file added to the template and
		// not written fails here, and a file written that the template does not name fails
		// too.
		expect([...data.created].sort()).toEqual([...CREATED_PATHS].sort());
		expect(CREATED_PATHS.length).toBeGreaterThan(0);
		for (const path of CREATED_PATHS) expect(read(root, path)).not.toBeNull();

		expect(data.allowPaths).toBe('added');
		expect(data.allowPathsLine).toBe(`${INDENT}"${SITE_ROOT_RELATIVE}"`);

		const after = read(root, MIRROR_SCRIPT_RELATIVE) as string;
		const lines = after.split('\n');
		const anchor = lines.indexOf(`${INDENT}"docs/public"`);
		expect(lines[anchor + 1]).toBe(`${INDENT}"${SITE_ROOT_RELATIVE}"`);
		// One line added and nothing else in the file touched.
		expect(lines.filter((_, index) => index !== anchor + 1).join('\n')).toBe(before);

		// The writer's own record, which is what makes idempotency measurable below.
		expect(writer.written).toHaveLength(CREATED_PATHS.length + 1);
		expect(output.rows.every((row) => row.status === 'pass')).toBe(true);
	});

	test('a second run writes nothing and exits 0', async () => {
		const root = repository(mirror());
		await run(root, { write: true });
		const mirrorAfterFirst = read(root, MIRROR_SCRIPT_RELATIVE);

		const second = await run(root, { write: true });
		expect(second.exit).toBe(0);
		// A fresh writer, so this is a count of paths that actually changed rather than a
		// diff nobody took.
		expect(second.writer.written).toEqual([]);
		expect(second.data.created).toEqual([]);
		expect([...second.data.unchanged].sort()).toEqual([...CREATED_PATHS].sort());
		expect(second.data.allowPaths).toBe('present');
		expect(read(root, MIRROR_SCRIPT_RELATIVE)).toBe(mirrorAfterFirst);

		const row = second.output.rows.find((entry) => entry.id === 'init-allow-paths');
		expect(row?.status).toBe('pass');
		// The already-present note says why it is a whole-entry match. `"docs/public"`
		// contains the word docs and is not the publishable root.
		expect(row?.note).toContain('not as a substring');
	});

	test('without --write nothing reaches the disk, and the plan is the run that would', async () => {
		const root = repository(mirror());
		const before = read(root, MIRROR_SCRIPT_RELATIVE);
		const { data, writer, exit, output } = await run(root);

		expect(exit).toBe(0);
		expect(data.write).toBe(false);
		expect(writer.written).toEqual([]);
		for (const path of CREATED_PATHS) expect(read(root, path)).toBeNull();
		expect(read(root, MIRROR_SCRIPT_RELATIVE)).toBe(before);

		// The dry run goes through the same code path, so it reports the same outcome and the
		// same file list as the run that would apply it.
		expect(data.allowPaths).toBe('added');
		expect([...data.created].sort()).toEqual([...CREATED_PATHS].sort());
		expect(output.lines.join('\n')).toContain('would create');
		expect(output.lines.join('\n')).toContain('would edit');
		expect(output.lines.join('\n')).toContain('Run this again with --write');
	});

	test('the publish workflow is written and deliberately not allowlisted', async () => {
		const root = repository(mirror());
		await run(root, { write: true });

		// Written: it is what turns a commit into a bundle.
		expect(read(root, PUBLISH_WORKFLOW_RELATIVE)).not.toBeNull();
		// And absent from the array, which is the only thing withholding it. It names the
		// bucket and the publishing role.
		const block = parseAllowPaths(read(root, MIRROR_SCRIPT_RELATIVE) as string);
		expect(block).not.toBeNull();
		const values = block?.entries.map((entry) => entry.value) ?? [];
		expect(values).toContain(SITE_ROOT_RELATIVE);
		expect(values).not.toContain(PUBLISH_WORKFLOW_RELATIVE);
		expect(values).not.toContain('.github/workflows');
		expect(values).not.toContain('.github');
		// The two `.github` entries that were there before survive, so the edit is an
		// insertion rather than a rewrite of the array.
		expect(values).toContain('.github/workflows/ci.yml');
		expect(values).toContain('.github/scripts');

		// And the assertion the command makes about itself: the path the scaffold writes is
		// the path the allowlist assertion names. Two constants that drifted would leave the
		// assertion checking a file nobody writes.
		const workflows = PLAN.files.filter((file) => file.path.startsWith('.github/workflows/'));
		expect(workflows.map((file) => file.path)).toEqual([PUBLISH_WORKFLOW_RELATIVE]);
	});
});

// ---------------------------------------------------------------------------
// no mirror script at all
// ---------------------------------------------------------------------------

describe('a repository with no public mirror', () => {
	test('is a skipped row rather than a pass or a failure, and the files are still written', async () => {
		const root = repository(null);
		const { data, exit, output } = await run(root, { write: true });

		expect(exit).toBe(0);
		expect(data.allowPaths).toBe('absent-file');
		const row = output.rows.find((entry) => entry.id === 'init-allow-paths');
		expect(row?.status).toBe('skipped');
		expect(row?.status).not.toBe('pass');
		expect(row?.note).toContain(MIRROR_SCRIPT_RELATIVE);
		for (const path of CREATED_PATHS) expect(read(root, path)).not.toBeNull();

		// The mirror-script patch entry is printed by hand in this case rather than silently
		// dropped, so nobody is told to edit a file that is not there.
		expect(output.lines.join('\n')).not.toContain('would edit');
	});
});

// ---------------------------------------------------------------------------
// the refusals, each stopping the whole run
// ---------------------------------------------------------------------------

/**
 * One repository per refusal, claiming the id it must produce.
 *
 * Checked against `ALLOW_PATHS_REFUSAL_IDS` in both directions below, so a refusal added
 * to the contract with no arm in `init` fails naming it, and an arm deleted fails naming
 * it too.
 */
const REFUSING: readonly { name: string; mirror: string; id: AllowPathsRefusalId }[] = [
	{
		name: 'an unquoted line',
		mirror: mirror().replace(`${INDENT}"docs/public"`, `${INDENT}docs`),
		id: 'unreadable-block',
	},
	{ name: 'an empty array', mirror: mirror([]), id: 'empty-block' },
	{ name: 'a bare docs entry', mirror: mirror([...ENTRIES, 'docs']), id: 'bare-docs' },
	{
		name: 'the internal tree by name',
		mirror: mirror([...ENTRIES, 'docs/internal']),
		id: 'forbidden-entry',
	},
	{
		name: 'the whole workflows directory',
		mirror: mirror([...ENTRIES, '.github/workflows']),
		id: 'publish-workflow',
	},
];

describe('an allowlist init must not touch', () => {
	for (const entry of REFUSING) {
		test(`${entry.name} stops the run, and writes nothing at all`, async () => {
			const root = repository(entry.mirror);
			const { data, writer, exit, output } = await run(root, { write: true });

			expect(exit).toBe(3);
			expect(data.allowPaths).toBe('refused');

			const row = output.rows.find((candidate) => candidate.id === `init-allow-paths-${entry.id}`);
			expect(row?.status).toBe('not-run');
			expect(row?.status).not.toBe('pass');
			expect(row?.note ?? '').not.toBe('');

			// The whole run, not only the allowlist edit. Nothing was written, and the file the
			// refusal is about is byte for byte what it was.
			expect(writer.written).toEqual([]);
			for (const path of CREATED_PATHS) expect(read(root, path)).toBeNull();
			expect(read(root, MIRROR_SCRIPT_RELATIVE)).toBe(entry.mirror);
			expect(output.lines.join('\n')).toContain('Nothing was written');
		});
	}

	test('every refusal id is exercised, and none of these fires an undeclared one', async () => {
		const claimed = new Set(REFUSING.map((entry) => entry.id));
		expect([...claimed].sort()).toEqual([...ALLOW_PATHS_REFUSAL_IDS].sort());

		// The other direction, measured rather than declared: the rows a run really emits.
		const emitted = new Set<string>();
		for (const entry of REFUSING) {
			const { output } = await run(repository(entry.mirror), { write: true });
			for (const row of output.rows) {
				if (row.id.startsWith('init-allow-paths-')) {
					emitted.add(row.id.slice('init-allow-paths-'.length));
				}
			}
		}
		expect([...emitted].sort()).toEqual([...ALLOW_PATHS_REFUSAL_IDS].sort());
	});

	test('a refusal names the leak, not only that the edit did not happen', async () => {
		const root = repository(mirror([...ENTRIES, 'docs']));
		const { output } = await run(root, { write: true });
		const row = output.rows.find((entry) => entry.id === 'init-allow-paths-bare-docs');
		const note = row?.note ?? '';
		expect(note).toContain('every documentation directory');
		expect(note).toContain('export-compliance');
		expect(note).toContain('device identifier');
		expect(note).toContain('nothing to prune');
		expect(note).toContain('public repository');
	});
});

// ---------------------------------------------------------------------------
// a file that is already there
// ---------------------------------------------------------------------------

describe('a file that already exists with different contents', () => {
	test('refuses only itself, and the allowlist edit still happens', async () => {
		const root = repository(mirror());
		const victim = CREATED_PATHS[0] as string;
		write(root, victim, 'somebody else wrote this\n');

		const { data, exit, output } = await run(root, { write: true });

		expect(exit).toBe(3);
		expect(data.refused.map((file) => file.path)).toEqual([victim]);
		expect(data.refused[0]?.why).toContain('never overwrites');
		expect(read(root, victim)).toBe('somebody else wrote this\n');
		// The other files were written, because that is a fact about one file.
		expect(data.created.length).toBe(CREATED_PATHS.length - 1);
		// And the allowlist entry is still the right thing to add.
		expect(data.allowPaths).toBe('added');
		expect(read(root, MIRROR_SCRIPT_RELATIVE)).toContain(`${INDENT}"${SITE_ROOT_RELATIVE}"`);

		expect(output.rows.find((row) => row.id === 'init-files')?.status).toBe('fail');
	});
});

// ---------------------------------------------------------------------------
// shape failures, which are usage errors
// ---------------------------------------------------------------------------

describe('arguments that are not what they claim to be', () => {
	let root: string;
	beforeEach(() => {
		root = repository(mirror());
	});

	test('a project id that is not a URL segment and an object key prefix', async () => {
		await expect(run(root, { project: 'Fixture_App' })).rejects.toBeInstanceOf(UsageError);
	});

	test('a repository that is not owner/name', async () => {
		await expect(run(root, { repo: 'fixture-app' })).rejects.toBeInstanceOf(UsageError);
	});

	test('a blank product name', async () => {
		await expect(run(root, { 'product-name': '   ' })).rejects.toBeInstanceOf(UsageError);
	});

	test('and nothing is written when one of them fires', async () => {
		await expect(run(root, { project: 'Fixture_App', write: true })).rejects.toThrow();
		for (const path of CREATED_PATHS) expect(read(root, path)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// no writer
// ---------------------------------------------------------------------------

test('a context with no writer is a not-run row, never a silent success', async () => {
	const root = repository(mirror());
	const output = await invoke(
		init,
		{ root, ...ARGS, write: true },
		{
			cwd: root,
			kitVersion: '@hex-pro/docs-kit@0.0.0-test',
			exec: NO_EXEC,
			write: null,
			now: () => new Date('2026-06-01T00:00:00Z'),
			log: () => undefined,
		},
	);
	expect(exitCodeFor(output)).toBe(3);
	expect(output.rows.map((row) => row.status)).toEqual(['not-run']);
	for (const path of CREATED_PATHS) expect(read(root, path)).toBeNull();
});
