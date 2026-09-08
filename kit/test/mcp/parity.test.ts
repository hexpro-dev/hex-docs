/**
 * The two front doors answer with the same bytes.
 *
 * Row 2 of the failure catalogue is "`verify-install` and the MCP tool disagree", and the
 * structure that answers it is that there is one implementation: the CLI dispatches on
 * `name`, the MCP server on `tool`, and both go through `invoke` on the same object.
 * `src/contracts/diagnostics.ts` opens by saying why that matters, and it would be
 * embarrassing to reintroduce in the tool that reports on documentation drift the exact
 * drift it exists to stop.
 *
 * Two things are checked here and they are not the same check. The first is identity:
 * `BY_TOOL.get(tool)` and `BY_NAME.get(name)` are the same object, by reference, so there
 * is nothing that could hold a second copy. The second is behaviour: for every tool, the
 * `data` a `tools/call` returns is byte for byte what `hexdocs <name> --json` puts on
 * stdout for the same input, under two different contexts. The identity check alone would
 * pass if a handler branched on whether it had a writer; the behaviour check alone would
 * pass over two implementations that happen to agree on this corpus today.
 *
 * All nine tools are covered rather than the two the task names, because the failure is
 * not specific to a command and a table with two rows in it is a table that stays at two.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus } from '../../../fixtures/index.js';
import { run } from '../../src/cli/main.js';
import { buildBundle } from '../../src/compile/build.js';
import { writeBundle } from '../../src/compile/bundle.js';
import { runRecipe } from '../../src/exec/run.js';
import { recordingWriter } from '../../src/io/write.js';
import { callTool, serverContext } from '../../src/mcp/server.js';
import { BY_NAME, BY_TOOL, TOOLS } from '../../src/registry/index.js';
import type { Ctx } from '../../src/registry/command.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const KIT_VERSION = '@hex-pro/docs-kit@0.1.0';
/** Fixed, so a command that stamps a date cannot make the two runs differ by a clock tick. */
const NOW = new Date('2026-06-01T00:00:00.000Z');

let scratch: string;
let corpus: string;
let bundlePath: string;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'hexdocs-parity-'));
	corpus = materialiseCorpus(join(scratch, 'app')).root;
	const built = buildBundle(corpus, { generator: KIT_VERSION });
	bundlePath = writeBundle(join(scratch, 'bundle'), built.manifest, built.objects).prefix;
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

/**
 * The context the CLI builds, minus the real filesystem writer.
 *
 * `recordingWriter` rather than `fileWriter` because none of these nine commands writes
 * and the test should fail loudly rather than quietly if that stops being true: a
 * recording writer keeps the paths it was asked for, and the assertion below reads them.
 */
function cliContext(): Ctx & { written: readonly string[] } {
	const writer = recordingWriter();
	return {
		cwd: corpus,
		kitVersion: KIT_VERSION,
		exec: runRecipe,
		write: writer,
		now: () => NOW,
		log: () => {},
		written: writer.written,
	};
}

/** The context `hexdocs mcp` hands a tool call, with the clock pinned the same way. */
function mcpContext(): Ctx {
	return { ...serverContext(corpus, KIT_VERSION), now: () => NOW };
}

interface Case {
	/** Everything after `hexdocs`, without `--json`, which is added by the runner. */
	argv: readonly string[];
	/** The same call as a tool would receive it. */
	args: Record<string, unknown>;
}

/**
 * One row per tool, and the argument sets are the same call written twice.
 *
 * They have to be written twice: that is the whole point. A CLI invocation is positional
 * and hyphenated, a tool call is a JSON object keyed by parameter name, and the claim is
 * that the two arrive at the same input. `kit/test/cli/` is where the binder itself is
 * checked; here it is one half of a comparison.
 *
 * `docs_label` and `docs_verify_install` answer with `not-run` rows against this corpus,
 * because it is an application repository with no site config and no consuming site. That
 * is a real answer and it is one the two doors have to agree about, which is why they are
 * in the table rather than left out for being uninteresting.
 */
function cases(): Record<string, Case> {
	return {
		docs_doctor: { argv: ['doctor', corpus], args: { root: corpus } },
		docs_check: { argv: ['check', corpus], args: { root: corpus } },
		docs_pages: { argv: ['pages', corpus], args: { root: corpus } },
		docs_page: {
			argv: ['page', 'index', corpus],
			args: { slug: 'index', root: corpus },
		},
		docs_bundle: { argv: ['bundle', bundlePath], args: { path: bundlePath } },
		docs_label: {
			argv: [
				'label',
				'--root',
				corpus,
				'--project',
				'fixture-app',
				'--commit',
				'a'.repeat(40),
				'--version',
				'1.2.0',
			],
			args: { root: corpus, project: 'fixture-app', commit: 'a'.repeat(40), version: '1.2.0' },
		},
		docs_scaffold: {
			argv: ['scaffold', 'page', '--root', corpus, '--slug', 'guide/new-page', '--locale', 'en'],
			args: { kind: 'page', root: corpus, slug: 'guide/new-page', locale: ['en'] },
		},
		docs_skills: { argv: ['skills', 'docs-diagnose'], args: { id: 'docs-diagnose' } },
		docs_verify_install: {
			argv: ['verify-install', corpus, '--site', 'apps/front'],
			args: { root: corpus, site: 'apps/front' },
		},
	};
}

describe('the two doors are one implementation', () => {
	test('every tool is the same object as its command, by reference', () => {
		// Identity, not equality. A copy taken at module load would satisfy a deep comparison
		// and would then be a second place a handler could be replaced.
		for (const command of TOOLS) {
			expect(BY_TOOL.get(command.tool as string)).toBe(BY_NAME.get(command.name));
			expect(BY_TOOL.get(command.tool as string)).toBe(command);
		}
	});

	test('there is a case for every tool and a tool for every case, in both directions', () => {
		expect(Object.keys(cases()).sort()).toEqual(
			TOOLS.map((command) => command.tool as string).sort(),
		);
	});
});

describe('the data is identical over both doors', () => {
	for (const command of TOOLS) {
		const tool = command.tool as string;

		test(`${tool} and hexdocs ${command.name} --json agree`, async () => {
			const testCase = cases()[tool] as Case;

			const cli = cliContext();
			const result = await run([...testCase.argv, '--json'], cli);
			expect(result.stdout, `hexdocs ${command.name} printed nothing on stdout`).not.toBe('');
			const fromCli: unknown = JSON.parse(result.stdout);

			const text = await callTool(tool, testCase.args, mcpContext());
			const fromTool: unknown = JSON.parse(text);

			// Deep equality first, because it is the assertion that produces a readable diff.
			expect(fromTool).toEqual(fromCli);
			// Then the bytes. `--json` and `callTool` both render `CommandOutput.data` with
			// `JSON.stringify(data, null, 2)`, so the strings match too, and a difference in key
			// order between the two doors would survive the deep comparison above.
			expect(`${text}\n`).toBe(result.stdout);

			// The other half of row 10, measured here rather than assumed: none of these nine
			// asked the writer for anything, so the MCP context having no writer changes nothing
			// about the answer.
			expect(cli.written, `hexdocs ${command.name} wrote something`).toEqual([]);
		});
	}
});

describe('the shim reads the same JSON', () => {
	test('verify-install answers with the report the generated shim renders', async () => {
		// The pair row 2 names. `scripts/check-docs.mjs` in a consuming site prints this
		// document and holds no copy of what is checked, which is what
		// `kit/test/wiring/shim.test.ts` asserts from the other side. This is the assertion
		// that the document the shim reads is the same one the tool returns.
		const cli = cliContext();
		const result = await run(['verify-install', corpus, '--site', 'apps/front', '--json'], cli);
		const report = JSON.parse(result.stdout) as { rows?: unknown[] };
		const fromTool = JSON.parse(
			await callTool('docs_verify_install', { root: corpus, site: 'apps/front' }, mcpContext()),
		) as { rows?: unknown[] };
		expect(fromTool).toEqual(report);
		// Not vacuous: the report really does carry rows, so the equality above is over
		// something rather than over two empty objects.
		expect(Array.isArray(fromTool.rows) ? fromTool.rows.length : 0).toBeGreaterThan(0);
	});
});
