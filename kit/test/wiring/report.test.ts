/**
 * The report `hexdocs verify-install --json` prints, and the two invariants a schema cannot
 * express.
 *
 * Row 9 of the failure catalogue is "a report that examined nothing and exited 0", and the
 * structure that answers it is three deep: `checkRow` coerces a zero-examined pass into a
 * failure at construction, `zeroExaminedPasses` catches a hand-assembled one on the way
 * out, and `rowsWithoutReason` catches the same problem from the other end, which is a red
 * or skipped row a reader cannot act on. All three are asserted here, and the first of them
 * is asserted through a real probe rather than by calling `checkRow` with a zero, because a
 * coercion nothing reaches is a coercion nobody tests.
 *
 * The report is the only thing three renderers share. The CLI prints the table, the MCP
 * tool returns the same object and the consumer's generated `scripts/check-docs.mjs`
 * parses this JSON from `prebuild`, so a field that quietly changed shape would reach a
 * consumer as a shim that renders nothing and exits on a number it did not find.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import {
	CONSUMER_SHAPES,
	materialiseConsumerWithConfig,
	removeConsumer,
	type ConsumerShape,
} from '../../../fixtures/consumers.js';
import { CONSUMER_ROOT } from '../../../fixtures/index.js';
import {
	checkRow,
	failedRow,
	notRunRow,
	skippedRow,
	type CheckRow,
	type VerifyInstallReport,
} from '../../../src/contracts/diagnostics.js';
import {
	rowsWithoutReason,
	verifyInstallReportSchema,
	examinedNothing,
	zeroExaminedPasses,
} from '../../src/contracts/diagnostics.schema.js';
import { install } from '../../src/commands/install.js';
import { NOT_CHECKED_HERE, verifyInstall } from '../../src/commands/verify-install.js';
import { runRecipe } from '../../src/exec/run.js';
import { fileWriter } from '../../src/io/write.js';
import { exitCodeFor, invoke, type Ctx } from '../../src/registry/command.js';
import { CONSUMER_CHECK_IDS, PROBES } from '../../src/wiring/checks.js';
import { parseJsonc } from '../../src/wiring/needles.js';

const SITE_CONFIG = join(CONSUMER_ROOT, 'fixture-app.docs.json');
const KIT_VERSION = '@hex-pro/docs-kit@0.0.0-test';

const MOUNT_OF: Record<ConsumerShape, string> = {
	'glob-workspace': 'common/docs',
	'literal-workspace': 'web/docs',
};

const SITE_OF: Record<ConsumerShape, string> = {
	'glob-workspace': 'apps/front',
	'literal-workspace': 'web/front',
};

interface Repo {
	readonly shape: ConsumerShape;
	readonly root: string;
	readonly site: string;
	readonly mount: string;
}

function write(repo: Repo, path: string, text: string): void {
	const target = join(repo.root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, text, 'utf8');
}

function context(repo: Repo): Ctx {
	return {
		cwd: repo.root,
		kitVersion: KIT_VERSION,
		exec: runRecipe,
		write: fileWriter(),
		now: () => new Date(0),
		log: () => {},
	};
}

async function reportFor(
	repo: Repo,
): Promise<{ report: VerifyInstallReport; rows: readonly CheckRow[] }> {
	const output = await invoke(
		verifyInstall,
		{ root: repo.root, site: repo.site, mount: repo.mount },
		{ ...context(repo), write: null },
	);
	return { report: output.data as unknown as VerifyInstallReport, rows: output.rows };
}

let scratch: string;
const TEMPLATES = new Map<ConsumerShape, string>();
let copies = 0;

/**
 * A consumer with `install`'s mechanical half applied and its by-hand half not.
 *
 * A deliberately mixed state rather than a fully wired one, and it is the state the report
 * is most often read in: three rows pass, one is skipped once the workspace file is
 * removed, and the rest fail with findings. A report where every row said the same thing
 * would not distinguish the per-state rules `rowsWithoutReason` applies.
 *
 * The `sites` block is not docs wiring. `projectTypeOf` matches the site path against
 * `sites.*.projects.*.path` and both fixtures carry only a `hash` key, so without it the
 * deploy row is a failure about a missing project rather than about the mount.
 */
async function prepare(shape: ConsumerShape, into: string): Promise<void> {
	const consumer = materialiseConsumerWithConfig(shape, SITE_CONFIG);
	const repo: Repo = { shape, root: consumer.root, site: consumer.site, mount: MOUNT_OF[shape] };
	const deploy = parseJsonc(readFileSync(join(repo.root, 'deploy.config.json'), 'utf8')) as Record<
		string,
		unknown
	>;
	deploy['sites'] = { main: { projects: { front: { path: repo.site } } } };
	write(repo, 'deploy.config.json', `${JSON.stringify(deploy, null, '\t')}\n`);
	await invoke(
		install,
		{ root: repo.root, site: repo.site, mount: repo.mount, write: true },
		context(repo),
	);
	cpSync(repo.root, into, { recursive: true, verbatimSymlinks: true });
	removeConsumer(consumer);
}

function copy(shape: ConsumerShape): Repo {
	copies += 1;
	const root = join(scratch, `copy-${copies}`);
	cpSync(TEMPLATES.get(shape) as string, root, { recursive: true, verbatimSymlinks: true });
	return { shape, root, site: SITE_OF[shape], mount: MOUNT_OF[shape] };
}

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), 'hexdocs-report-'));
	for (const shape of CONSUMER_SHAPES) {
		const template = join(scratch, `template-${shape}`);
		await prepare(shape, template);
		TEMPLATES.set(shape, template);
	}
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A real report
// ---------------------------------------------------------------------------

describe('a report from a real repository', () => {
	test.each(CONSUMER_SHAPES)('%s: validates and carries no invariant violation', async (shape) => {
		const repo = copy(shape);
		// Removing the workspace file adds a `skipped` row, which is the state
		// `rowsWithoutReason` is most easily wrong about: the schema permits `note: null` on
		// every state, so the rule is per state and cannot live in the schema.
		rmSync(join(repo.root, 'pnpm-workspace.yaml'));
		const { report } = await reportFor(repo);

		const parsed = verifyInstallReportSchema.safeParse(report);
		expect(
			parsed.success
				? []
				: parsed.error.issues.map(
						(issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
					),
		).toEqual([]);
		expect(zeroExaminedPasses(report)).toEqual([]);
		expect(rowsWithoutReason(report)).toEqual([]);

		// The mixed state the fixture exists to produce, so the assertions above are not
		// three statements about a report of nine identical rows.
		const states = new Set(report.rows.map((row) => row.status));
		expect([...states].sort()).toEqual(['fail', 'pass', 'skipped']);
	});

	test.each(CONSUMER_SHAPES)(
		'%s: the emitted row ids are exactly the probe keys',
		async (shape) => {
			const { report } = await reportFor(copy(shape));
			// Both directions, and against the probe table rather than against a list written
			// here: `PROBES` is `satisfies Record<ConsumerCheckId, WiringProbe>`, so a deleted
			// probe fails the typecheck by name, and this catches the half the type cannot see,
			// which is a probe that runs and returns a row with somebody else's id on it.
			const emitted = report.rows.map((row) => row.id);
			expect(emitted).toEqual([...CONSUMER_CHECK_IDS]);
			expect(Object.keys(PROBES).sort()).toEqual([...CONSUMER_CHECK_IDS].sort());
			for (const id of CONSUMER_CHECK_IDS) expect(PROBES[id].id).toBe(id);
			expect(report.rows.some((row) => row.id === 'verify-install-coverage')).toBe(false);
		},
	);

	test.each(CONSUMER_SHAPES)(
		'%s: the exit code is decided by exitCodeFor and not by the command',
		async (shape) => {
			const { report, rows } = await reportFor(copy(shape));
			// A command that could set its own code could report a clean run over a failing
			// envelope. Recomputed here over the rows the command returned, which is the only way
			// to see that the field and the rows are the same fact.
			expect(report.exitCode).toBe(exitCodeFor({ data: null, lines: [], envelope: null, rows }));
			expect(report.exitCode).toBe(3);
			expect(report.rows.some((row) => row.status === 'fail')).toBe(true);
		},
	);

	test('the closing paragraph is data and is carried verbatim', async () => {
		// The shim prints this list and holds no copy of it. A renderer with its own copy of
		// what happened goes stale the first time a check is added, and it goes stale in the
		// reassuring direction.
		const { report } = await reportFor(copy('glob-workspace'));
		expect(report.notCheckedHere).toEqual([...NOT_CHECKED_HERE]);
		expect(report.notCheckedHere.length).toBeGreaterThan(0);
		expect(report.notCheckedHere).not.toBe(NOT_CHECKED_HERE);
	});

	test('nextAction names the first row a reader should open', async () => {
		const { report } = await reportFor(copy('glob-workspace'));
		expect(report.nextAction.kind).toBe('command');
		if (report.nextAction.kind !== 'command') throw new Error('expected a command');
		expect(report.nextAction.argv).toEqual(['hexdocs', 'install', '--site', 'apps/front']);
		const firstFailing = report.rows.find(
			(row) => row.status === 'fail' || row.status === 'not-run',
		);
		expect(report.nextAction.why).toContain(firstFailing?.id ?? 'nothing failed');
	});

	test('summary.passing counts rows with no finding, which is not a coverage measure', async () => {
		// `diagnostics.ts` says so at the declaration and this report inherits it: a skipped
		// row has no finding and is counted here having examined nothing. The coverage
		// statement is the `examined` column, which is why it is asserted separately.
		const repo = copy('glob-workspace');
		rmSync(join(repo.root, 'pnpm-workspace.yaml'));
		const { report } = await reportFor(repo);
		expect(report.summary.passing).toBe(
			report.rows.filter((row) => row.findings.length === 0).length,
		);
		const skipped = report.rows.filter((row) => row.status === 'skipped');
		expect(skipped.length).toBeGreaterThan(0);
		expect(skipped.every((row) => row.examined === 0)).toBe(true);
		expect(report.summary.errors).toBe(
			report.rows.flatMap((row) => row.findings).filter((f) => f.severity === 'error').length,
		);
	});
});

// ---------------------------------------------------------------------------
// The zero-examined coercion, reached through a probe rather than called directly
// ---------------------------------------------------------------------------

describe('a check that examined nothing has not passed', () => {
	test('a probe with a satisfied needle and nothing to count comes back as a failure', async () => {
		// The state that produces it: the sitemap file derives DOCS_SITEMAP correctly, so the
		// needle is satisfied and there is no finding, and there is no site config, so there
		// are no rows to count. Every ingredient of a green row is present except something
		// to have looked at. `checkRow` is what turns it red, and the note it writes replaces
		// the probe's own.
		const repo = copy('glob-workspace');
		rmSync(join(repo.root, repo.site, 'app', 'docs'), { recursive: true, force: true });
		write(
			repo,
			`${repo.site}/app/routes/sitemap[.]xml.tsx`,
			"import { DOCS_SITEMAP } from '~/lib/docs';\n\nconst entries = [...DOCS_SITEMAP];\n\nexport function loader() {\n\treturn new Response(render(entries));\n}\n",
		);
		const { report } = await reportFor(repo);
		const row = report.rows.find((candidate) => candidate.id === 'wiring-sitemap');
		expect([row?.status, row?.examined, row?.findings.length]).toEqual(['fail', 0, 0]);
		expect(row?.note ?? '').toMatch(/Examined zero sitemap sources/);
		// And the report still validates: a coerced row is an ordinary row.
		expect(verifyInstallReportSchema.safeParse(report).success).toBe(true);
		expect(zeroExaminedPasses(report)).toEqual([]);
		expect(rowsWithoutReason(report)).toEqual([]);
	});

	test('checkRow coerces at construction, and the note says what happened', () => {
		const coerced = checkRow('probe', 0, 'files', []);
		expect([coerced.status, coerced.note]).toEqual([
			'fail',
			'Examined zero files. A check that looked at nothing has not passed.',
		]);
		// The control: the same call with something examined is a pass, so the coercion is
		// about the count rather than about the constructor.
		expect(checkRow('probe', 1, 'files', []).status).toBe('pass');
	});
});

// ---------------------------------------------------------------------------
// The two validators, against reports assembled by hand
// ---------------------------------------------------------------------------

function reportOf(rows: CheckRow[]): VerifyInstallReport {
	return {
		kitVersion: KIT_VERSION,
		site: 'apps/front',
		rows,
		summary: {
			errors: 0,
			warnings: 0,
			infos: 0,
			passing: rows.filter((row) => row.findings.length === 0).length,
		},
		notCheckedHere: [...NOT_CHECKED_HERE],
		nextAction: { kind: 'none', why: 'Nothing to do.' },
		exitCode: exitCodeFor({ data: null, lines: [], envelope: null, rows }),
	};
}

describe('the invariants the schema cannot express', () => {
	test('a zero-examined pass is caught, and the message names the row and the unit', () => {
		// `checkRow` cannot produce this, which is the point: a violation means a report was
		// assembled by hand somewhere, and this is the only place that is caught.
		const report = reportOf([
			{
				id: 'wiring-mcp',
				status: 'pass',
				examined: 0,
				unit: 'server entries',
				findings: [],
				note: null,
			},
		]);
		expect(verifyInstallReportSchema.safeParse(report).success).toBe(true);
		const problems = zeroExaminedPasses(report);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('wiring-mcp');
		expect(problems[0]).toContain('server entries');
		expect(rowsWithoutReason(report)).toEqual([]);
	});

	test('a skipped row with no note is caught, and one with a reason is not', () => {
		// A skip whose reason is absent is indistinguishable from a check somebody switched
		// off, which is the opposite of what that state means.
		const silent = reportOf([
			{
				id: 'wiring-workspace-exclusion',
				status: 'skipped',
				examined: 0,
				unit: 'workspace entries',
				findings: [],
				note: null,
			},
		]);
		expect(rowsWithoutReason(silent)).toHaveLength(1);
		expect(rowsWithoutReason(silent)[0]).toContain('wiring-workspace-exclusion');

		const explained = reportOf([
			skippedRow(
				'wiring-workspace-exclusion',
				'workspace entries',
				'there is no pnpm-workspace.yaml here',
			),
		]);
		expect(rowsWithoutReason(explained)).toEqual([]);
	});

	test('a whitespace-only note is not a reason', () => {
		const report = reportOf([
			{
				id: 'wiring-routes',
				status: 'fail',
				examined: 3,
				unit: 'route declarations',
				findings: [],
				note: '   ',
			},
		]);
		expect(rowsWithoutReason(report)).toHaveLength(1);
	});

	test('a fail and a not-run with neither a finding nor a note are both caught', () => {
		const report = reportOf([
			{
				id: 'wiring-routes',
				status: 'fail',
				examined: 3,
				unit: 'route declarations',
				findings: [],
				note: null,
			},
			{
				id: 'wiring-sitemap',
				status: 'not-run',
				examined: 0,
				unit: 'sitemap sources',
				findings: [],
				note: null,
			},
		]);
		expect(rowsWithoutReason(report)).toHaveLength(2);
		// And the constructors that exist for those states cannot produce the violation,
		// because both take the reason as a required parameter.
		const built = reportOf([
			failedRow('wiring-routes', 3, 'route declarations', 'routes.ts did not parse'),
			notRunRow('wiring-sitemap', 'sitemap sources', 'the routes row failed first'),
		]);
		expect(rowsWithoutReason(built)).toEqual([]);
	});

	test('a passing row with findings below the error threshold needs no note', () => {
		// The reason the rule is per state rather than in the schema. `checkRowSchema` permits
		// `note: null` on every state and it has to: the findings are the reason here.
		const report = reportOf([
			checkRow('wiring-mcp', 2, 'server entries', [
				{
					rule: 'wiring-mcp',
					severity: 'warning',
					category: 'wiring',
					location: { kind: 'file', file: '.mcp.json' },
					locale: null,
					message: 'A server is declared and not enabled.',
					consequence: 'It never starts.',
					remediation: null,
					suggestion: null,
					excerpt: null,
				},
			]),
		]);
		expect(report.rows[0]?.status).toBe('pass');
		expect(rowsWithoutReason(report)).toEqual([]);
		expect(zeroExaminedPasses(report)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The row-set assertion inside the command
// ---------------------------------------------------------------------------

describe('the rows emitted have to match the probe table', () => {
	test('a row filtered out of the returned array is reported as a coverage failure', async () => {
		// The one place in this file that reaches for a mock, and it is because the mutation
		// the failure catalogue names for row 1 is "filter a row out of the returned array".
		// There is no consumer state that produces that: a probe either runs or the typecheck
		// refuses the table. Scoped with `doMock` and a module reset rather than a file-level
		// `vi.mock`, so every other test here runs against the real module.
		vi.resetModules();
		vi.doMock('../../src/wiring/checks.js', async () => {
			const actual = await vi.importActual<typeof import('../../src/wiring/checks.js')>(
				'../../src/wiring/checks.js',
			);
			return {
				...actual,
				runConsumerChecks: (...args: Parameters<typeof actual.runConsumerChecks>) =>
					actual.runConsumerChecks(...args).filter((row) => row.id !== 'wiring-sitemap'),
			};
		});
		try {
			const command = (await import('../../src/commands/verify-install.js')).verifyInstall;
			const repo = copy('glob-workspace');
			const output = await invoke(
				command,
				{ root: repo.root, site: repo.site, mount: repo.mount },
				{ ...context(repo), write: null },
			);
			const report = output.data as unknown as VerifyInstallReport;
			const coverage = report.rows.find((row) => row.id === 'verify-install-coverage');
			expect(coverage?.status).toBe('fail');
			expect(coverage?.note ?? '').toContain('wiring-sitemap');
			expect(coverage?.note ?? '').toContain('Missing');
			expect(report.exitCode).toBe(3);
			// A missing row would otherwise be a check that quietly stopped running with every
			// remaining row green, which is what the whole row exists against.
			expect(report.rows.some((row) => row.id === 'wiring-sitemap')).toBe(false);
			expect(rowsWithoutReason(report)).toEqual([]);
		} finally {
			vi.doUnmock('../../src/wiring/checks.js');
			vi.resetModules();
		}
	});
});

// ---------------------------------------------------------------------------
// The report-level property no design covered
// ---------------------------------------------------------------------------

describe('a report that examined nothing at all', () => {
	// This is a gap rather than a bug in any one function, and it is written as a failing
	// test so that it cannot be forgotten and cannot be mistaken for a passing guarantee.
	//
	// Both validators are per row. `zeroExaminedPasses` looks only at rows whose status is
	// `pass`, and a `skipped` row is exempt from it by design, because a skip examines
	// nothing on purpose. `rowsWithoutReason` is satisfied by a note. `exitCodeFor` returns
	// 0 unless some row is `fail` or `not-run`. So a report in which every row is `skipped`
	// with a good reason validates, passes both invariant checks, and exits 0 having looked
	// at nothing, and the generated shim then prints "A skipped check did not run. It is
	// not a pass" immediately above an exit code that says it was.
	//
	// `verify-install` cannot emit that report today: only two of its nine rows have a skip
	// arm at all. The property is about the contract rather than about today's probe table,
	// and the contract is what the shim and the MCP tool both read.
	test('is refused by something before it can exit 0', () => {
		const rows = CONSUMER_CHECK_IDS.map((id) =>
			skippedRow(id, 'things', 'nothing here to look at, and here is a sentence saying why'),
		);
		const report = reportOf(rows);

		expect(verifyInstallReportSchema.safeParse(report).success).toBe(true);
		expect(report.rows.reduce((total, row) => total + row.examined, 0)).toBe(0);
		expect(report.exitCode).toBe(0);

		// Neither per-row validator catches it, and both are right not to: a `skipped` row
		// examines nothing on purpose, so it is exempt from the passing-row rule by design.
		expect([...zeroExaminedPasses(report), ...rowsWithoutReason(report)]).toEqual([]);

		// `examinedNothing` is the report-level form of the same rule, and it is what
		// closes this. It is scoped to a report that would otherwise pass, because a report
		// already carrying a failing or non-running row has reported failure and a second
		// sentence saying it examined nothing adds nothing; without that scope it fires on
		// its own remedy, since a `not-run` row examines nothing by definition.
		expect(examinedNothing(report)).not.toEqual([]);
		expect(examinedNothing(report)[0]).toContain('has not verified anything');
		expect(examinedNothing({ ...report, exitCode: 3 })).toEqual([]);
	});

	test('the states that do fail a run are the ones the contract names', () => {
		// The control for the case above, so it is a statement about the all-skipped report
		// rather than about `exitCodeFor` ignoring its input.
		const base = { examined: 1, unit: 'things', findings: [], note: 'a reason' };
		const codeFor = (status: CheckRow['status']): 0 | 3 =>
			exitCodeFor({
				data: null,
				lines: [],
				envelope: null,
				rows: [{ id: 'row', status, ...base }],
			});
		expect([codeFor('pass'), codeFor('skipped'), codeFor('fail'), codeFor('not-run')]).toEqual([
			0, 0, 3, 3,
		]);
	});
});
