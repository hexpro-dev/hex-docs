/**
 * The generated `scripts/check-docs.mjs`, and the one property it exists to have.
 *
 * Row 2 of the failure catalogue is "verify-install and the MCP tool disagree", and the
 * shim is the third front door onto the same run: it is what a consumer's `prebuild`
 * executes, on a repository with no CI, where it is the only thing that always runs. The
 * structure that answers the row is that the shim holds **no copy of what is checked**. It
 * spawns the CLI, renders the JSON, and passes the exit code through. A shim with its own
 * list of rows goes stale the first time a check is added, and it goes stale in the
 * reassuring direction: the row nobody ported is the row nobody sees fail.
 *
 * So the first assertion here is a sweep over both id spaces against the template text. It
 * is deliberately blunt: a special case for one row cannot be added without turning it red,
 * whatever the special case is spelled like, because the id has to appear somewhere for the
 * special case to name it.
 *
 * The rest is behavioural and runs the generated file. A template asserted by reading is a
 * template asserted against what it looks like; the exit mapping is a contract
 * (`VerifyInstallReport.exitCode` states it at its declaration) and the only honest proof
 * is spawning the thing against a launcher that returns each shape.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { CHECK_IDS, LINT_RULE_IDS } from '../../../src/contracts/lint.js';
import { CHECK_STATES } from '../../../src/contracts/diagnostics.js';
import { detectSite, memoryFiles } from '../../src/wiring/detect.js';
import { checkDocsShim } from '../../src/wiring/templates.js';
import type { SiteDescriptor } from '../../src/wiring/site.js';

const SITE = 'apps/front';
const MOUNT = 'common/docs';

function descriptor(root: string): SiteDescriptor {
	return detectSite({ repoRoot: root, site: SITE, mount: MOUNT, files: memoryFiles({}) });
}

const TEMPLATE = checkDocsShim(descriptor('/nowhere'));

// ---------------------------------------------------------------------------
// The shim holds no copy of what is checked
// ---------------------------------------------------------------------------

describe('the template names nothing it would have to be kept up to date with', () => {
	test('no CheckId appears anywhere in it', () => {
		const found = CHECK_IDS.filter((id) => TEMPLATE.includes(id));
		expect(
			found,
			'a check id in the shim is a second list of what is checked, and it goes stale in the reassuring direction',
		).toEqual([]);
		// Not vacuous: there are ids to look for, and the sweep really does look at the text.
		expect(CHECK_IDS.length).toBeGreaterThan(10);
		expect(TEMPLATE.includes(CHECK_IDS[0] as string)).toBe(false);
	});

	test('no LintRuleId appears anywhere in it either', () => {
		// The rule ids cannot reach a wiring report today, and the sweep runs over them
		// anyway: the shim renders `finding.message`, `finding.remediation` and
		// `finding.consequence` from whatever comes back, so the day a rule id does reach it
		// the renderer must still be printing the JSON rather than a table of its own.
		expect(LINT_RULE_IDS.filter((id) => TEMPLATE.includes(id))).toEqual([]);
		expect(LINT_RULE_IDS.length).toBeGreaterThan(30);
	});

	test('the only strings it does hold are the four row states and the site it was written for', () => {
		// The states are a rendering concern: the shim turns `not-run` into `NOT RUN` for a
		// person to read. That is layout, which is the shim's job, and it is bounded by the
		// contract rather than by what any probe emits. Asserted in both directions so the
		// table cannot silently lose a state and print a raw one.
		for (const state of CHECK_STATES) expect(TEMPLATE).toContain(`"${state}"`);
		const labels = /const LABELS = \{([^}]*)\}/.exec(TEMPLATE)?.[1] ?? '';
		const named = [...labels.matchAll(/"?([a-z-]+)"?:/g)].map((match) => match[1]);
		expect([...named].sort()).toEqual([...CHECK_STATES].sort());

		expect(TEMPLATE).toContain(`const SITE = "${SITE}";`);
	});

	test('it imports node builtins and nothing else', () => {
		const specifiers = [...TEMPLATE.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
		expect(specifiers.length).toBeGreaterThan(0);
		expect(specifiers.filter((name) => !(name ?? '').startsWith('node:'))).toEqual([]);
	});

	test('it spawns the CLI with the argv the command declares', () => {
		expect(TEMPLATE).toContain(
			'execFileSync(LAUNCHER, ["verify-install", "--site", SITE, "--json"]',
		);
		expect(TEMPLATE).toContain('JSON.parse(stdout)');
		expect(TEMPLATE).toContain('report.exitCode');
	});

	test('it is pure ASCII', () => {
		// It ships into somebody else's repository and is read by that repository's own
		// tooling. An escape or a curly quote arriving through a template is the kind of thing
		// that shows up as a lint failure in a repo this package does not own.
		expect(TEMPLATE.replace(/[\t\n\x20-\x7e]/g, '')).toBe('');
	});

	test('the paths it resolves come from the descriptor and not from a guess', () => {
		const other = detectSite({
			repoRoot: '/nowhere',
			site: 'web/front',
			mount: 'web/docs',
			files: memoryFiles({}),
		});
		const text = checkDocsShim(other);
		expect(text).toContain('const SITE = "web/front";');
		expect(text).toContain('resolve(FRONT, "../..")');
		expect(text).toContain('resolve(FRONT, "../docs/kit/bin/hexdocs")');
		expect(TEMPLATE).toContain('resolve(FRONT, "../../common/docs/kit/bin/hexdocs")');
	});
});

// ---------------------------------------------------------------------------
// It is a program
// ---------------------------------------------------------------------------

let scratch: string;
let runs = 0;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'hexdocs-shim-'));
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

test('the generated file parses as an ES module', () => {
	// `node --check` rather than a regex or a `new Function`, which cannot see an import
	// statement at all. A shim that does not parse fails `prebuild` with a syntax error in a
	// file this package wrote, on a repository with no CI to have caught it.
	const path = join(scratch, 'parse-check.mjs');
	writeFileSync(path, TEMPLATE, 'utf8');
	expect(() => execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })).not.toThrow();
});

// ---------------------------------------------------------------------------
// The exit mapping, proved by running it
// ---------------------------------------------------------------------------

interface Run {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Lays out a consumer around the shim and runs it against a launcher that returns `body`.
 *
 * The layout matters: the shim resolves the launcher and the repository root relative to
 * its own file, so a flat directory would prove the exit mapping and nothing about the
 * paths. `launcher === null` deletes the launcher entirely, which is the spawn-failure arm.
 */
function runShim(body: string | null, exitCode: number): Run {
	runs += 1;
	const root = join(scratch, `run-${runs}`);
	const shim = join(root, SITE, 'scripts', 'check-docs.mjs');
	mkdirSync(dirname(shim), { recursive: true });
	writeFileSync(shim, checkDocsShim(descriptor(root)), 'utf8');

	if (body !== null) {
		const launcher = join(root, MOUNT, 'kit', 'bin', 'hexdocs');
		mkdirSync(dirname(launcher), { recursive: true });
		// A shell script rather than a node one, because what is under test is the spawn and
		// its exit code. The heredoc is quoted so nothing in the JSON is expanded.
		writeFileSync(
			launcher,
			`#!/bin/sh\ncat <<'HEXDOCS_JSON'\n${body}\nHEXDOCS_JSON\nexit ${exitCode}\n`,
			'utf8',
		);
		chmodSync(launcher, 0o755);
	}

	const result = spawnSync(process.execPath, [shim], { encoding: 'utf8', cwd: root });
	return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function report(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		kitVersion: '@hex-pro/docs-kit@0.0.0-test',
		site: SITE,
		rows: [
			{
				id: 'a-row-id-no-contract-knows',
				status: 'pass',
				examined: 4,
				unit: 'invented units',
				findings: [],
				note: 'a note the shim has never heard of',
			},
		],
		summary: { errors: 0, warnings: 0, infos: 0, passing: 1 },
		notCheckedHere: ['a closing paragraph line that lives only in the JSON'],
		nextAction: { kind: 'none', why: 'nothing to do here' },
		exitCode: 0,
		...overrides,
	});
}

describe('the exit mapping', () => {
	test('a clean report exits 0', () => {
		const run = runShim(report(), 0);
		expect([run.status, run.stderr]).toEqual([0, '']);
	});

	test('a report with problems passes hexdocs own code through rather than remapping it', () => {
		// 3, not 1. `VerifyInstallReport.exitCode` is a documented contract field, and a shim
		// that remapped it would be carrying its own table of what hexdocs codes mean, in the
		// file whose whole design principle is that it holds none.
		const body = report({
			exitCode: 3,
			rows: [
				{
					id: 'a-failing-row',
					status: 'fail',
					examined: 2,
					unit: 'things',
					findings: [
						{
							rule: 'a-rule-nobody-declared',
							severity: 'error',
							category: 'wiring',
							location: { kind: 'project' },
							locale: null,
							message: 'a message that exists only in this JSON',
							consequence: 'a consequence that exists only in this JSON',
							remediation: 'a remediation that exists only in this JSON',
							suggestion: null,
							excerpt: null,
						},
					],
					note: null,
				},
			],
		});
		const run = runShim(body, 3);
		expect(run.status).toBe(3);
		expect(run.stdout).toContain('a-failing-row');
		expect(run.stdout).toContain('a message that exists only in this JSON');
		expect(run.stdout).toContain('a remediation that exists only in this JSON');
		expect(run.stdout).toContain('a consequence that exists only in this JSON');
	});

	test('a non-zero launcher exit with a report on stdout is the ordinary case, not a shim failure', () => {
		// The launcher exits 3 and the report is still on stdout. `execFileSync` throws on a
		// non-zero exit, so the catch has to read the stdout off the error rather than treat
		// the throw as "could not run".
		const run = runShim(report({ exitCode: 3 }), 3);
		expect(run.status).toBe(3);
		expect(run.stderr).toBe('');
		expect(run.stdout).toContain('a-row-id-no-contract-knows');
	});

	test('a launcher that cannot be spawned exits 1, distinctly, and says nothing was cleared', () => {
		const run = runShim(null, 0);
		expect(run.status).toBe(1);
		expect(run.status).not.toBe(3);
		expect(run.stderr).toContain('could not run');
		expect(run.stderr).toContain('nothing was checked, so nothing was cleared');
	});

	test('output that does not parse exits 1 and prints what it got', () => {
		const run = runShim('this is not json', 0);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain('did not parse as JSON');
		expect(run.stderr).toContain('this is not json');
	});

	test('a report with no rows exits 1 rather than reporting a clean sweep of nothing', () => {
		// The house rule the whole suite is built on, applied at the last renderer: a check
		// that examined nothing has not passed, and an empty row list is that from one step
		// further out.
		expect(runShim(report({ rows: [] }), 0).status).toBe(1);
		expect(runShim(report({ rows: null }), 0).status).toBe(1);
		expect(runShim(report({ rows: [] }), 0).stderr).toContain('returned no rows');
	});

	test('a report whose exitCode is missing or not a number exits 3, never 0', () => {
		// The direction that matters. A shim defaulting to 0 on a field it could not read
		// would print a pass forever the day the field is renamed.
		expect(runShim(report({ exitCode: undefined }), 0).status).toBe(3);
		expect(runShim(report({ exitCode: 'clean' }), 0).status).toBe(3);
	});
});

describe('everything it prints comes out of the JSON', () => {
	test('an invented row, unit, note and closing line all reach stdout', () => {
		const run = runShim(report(), 0);
		expect(run.stdout).toContain('a-row-id-no-contract-knows');
		expect(run.stdout).toContain('4 invented units');
		expect(run.stdout).toContain('a note the shim has never heard of');
		expect(run.stdout).toContain('a closing paragraph line that lives only in the JSON');
		expect(run.stdout).toContain('nothing to do here');
		expect(run.stdout).toContain('@hex-pro/docs-kit@0.0.0-test');
	});

	test('a skipped row is called out as not a pass, with its reason', () => {
		const body = report({
			rows: [
				{
					id: 'a-skipped-row',
					status: 'skipped',
					examined: 0,
					unit: 'things',
					findings: [],
					note: 'the reason this one did not run',
				},
			],
		});
		const run = runShim(body, 0);
		expect(run.stdout).toContain('SKIPPED');
		expect(run.stdout).toContain('A skipped check did not run. It is not a pass');
		expect(run.stdout).toContain('the reason this one did not run');
		expect(run.stdout).toContain('0 failed, 0 did not run, 1 skipped, 0 passed');
	});

	test('a status the shim has no label for is printed as itself rather than as blank', () => {
		// The renderer must not swallow a state it does not know. A blank column reads as a
		// row that passed, which is the failure mode the four-state table exists against.
		const body = report({
			rows: [
				{
					id: 'a-row',
					status: 'a-state-from-the-future',
					examined: 0,
					unit: 'things',
					findings: [],
					note: 'a note',
				},
			],
		});
		const run = runShim(body, 0);
		expect(run.stdout).toContain('a-state-from-the-future');
	});
});
