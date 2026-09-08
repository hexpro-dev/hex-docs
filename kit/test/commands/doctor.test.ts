/**
 * `hexdocs doctor`, which answers nothing itself.
 *
 * The claim doctor makes is that its rows are the rows the individual commands produce,
 * concatenated, with nothing added and nothing recomputed. That claim is exactly the kind
 * that goes stale in the reassuring direction: a doctor that grew one check of its own
 * would still print a table, and the row it added would be believed, because doctor is
 * what a person runs when they already suspect something is wrong.
 *
 * So it is checked by running both sides. `check`, `verify-install` and `bundle` are
 * invoked directly against the same root with the same context, and their rows are
 * concatenated and compared for deep equality against doctor's. A sentence asserting the
 * same thing would pass against any implementation.
 *
 * Two roots are needed for that, not one. Over a tree that compiles, `check` returns an
 * envelope and **no rows at all**, so a concatenation test on that root alone would be
 * comparing against nothing on one of the three sides. The second root is the same tree
 * with its history removed, where `check` returns one `not-run` row, and it is the case
 * that proves check's rows really do flow through.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus } from '../../../fixtures/index.js';
import {
	CONSUMER_SHAPES,
	materialiseConsumerWithConfig,
	removeConsumer,
	type Consumer,
} from '../../../fixtures/consumers.js';
import type { CheckRow, DiagnosticEnvelope } from '../../../src/contracts/diagnostics.js';
import { buildBundle } from '../../src/compile/build.js';
import { writeBundle } from '../../src/compile/bundle.js';
import { bundle } from '../../src/commands/bundle.js';
import { check } from '../../src/commands/check.js';
import { doctor } from '../../src/commands/doctor.js';
import { verifyInstall } from '../../src/commands/verify-install.js';
import { exitCodeFor, invoke, type Ctx } from '../../src/registry/command.js';

const KIT_VERSION = '@hex-pro/docs-kit@0.0.0';
const SITE_CONFIG = fileURLToPath(
	new URL('../../../fixtures/site/fixture-app.docs.json', import.meta.url),
);

let root: string;
/** An app repository and a consuming website in one tree, so every role is present. */
let both: string;
/** The same tree with `.git` removed, where `check` has a row instead of an envelope. */
let bothWithoutGit: string;
/** The site directory inside `both`, relative to it. */
let site: string;
/** The `ast-N` directory of a bundle built out of the corpus. */
let prefix: string;
/** An app repository and nothing else. */
let app: string;
/** An empty directory: no docs tree, no site config, no bundle. */
let nothing: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'hexdocs-doctor-'));

	app = materialiseCorpus(join(root, 'app')).root;
	const built = buildBundle(app, { generator: KIT_VERSION });
	expect(built.manifestProblems).toEqual([]);
	const out = join(root, 'out');
	mkdirSync(out, { recursive: true });
	prefix = writeBundle(out, built.manifest, built.objects).prefix;

	both = materialiseCorpus(join(root, 'both')).root;
	const consumer = materialiseConsumerWithConfig('glob-workspace', SITE_CONFIG);
	site = consumer.site;
	// The consumer's files are copied over the app repository rather than beside it,
	// because the role detection is about one root holding both halves. hex-web and
	// kcalc-ai are each one repository, and kcalc-ai is a content source as well as a
	// consumer.
	cpSync(consumer.root, both, { recursive: true });
	removeConsumer(consumer);

	bothWithoutGit = join(root, 'both-no-git');
	cpSync(both, bothWithoutGit, { recursive: true, dereference: false, verbatimSymlinks: true });
	rmSync(join(bothWithoutGit, '.git'), { recursive: true, force: true });

	nothing = join(root, 'nothing');
	mkdirSync(nothing, { recursive: true });
}, 120_000);

afterAll(() => {
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/**
 * One context, shared by every call in a comparison.
 *
 * `exec` answers as a repository with the gitlink recorded would. It has to be the same
 * function on both sides of the comparison: doctor's whole claim is that it runs the same
 * command a person would, and a sub-call given a different world would be a different run.
 */
function ctx(): Ctx {
	return {
		cwd: root,
		kitVersion: KIT_VERSION,
		exec: () => ({ status: 0, stdout: `160000 ${'a'.repeat(40)} 0\tcommon/docs\n`, stderr: '' }),
		write: null,
		now: () => new Date('2026-01-01T00:00:00Z'),
		log: () => {},
	};
}

interface DoctorData {
	root: string;
	roles: string[];
	rows: CheckRow[];
	envelope: DiagnosticEnvelope | null;
	nextAction: { kind: string; why: string; argv?: string[] };
}

async function runDoctor(input: Record<string, unknown>): Promise<{
	rows: readonly CheckRow[];
	data: DoctorData;
	envelope: DiagnosticEnvelope | null;
	code: number;
}> {
	const output = await invoke(doctor, input, ctx());
	return {
		rows: output.rows,
		data: output.data as unknown as DoctorData,
		envelope: output.envelope,
		code: exitCodeFor(output),
	};
}

describe('the rows are the sub-commands rows, concatenated', () => {
	test('over a root with all three roles', async () => {
		const checked = await invoke(check, { root: both }, ctx());
		const wiring = await invoke(verifyInstall, { root: both, site }, ctx());
		const verified = await invoke(bundle, { path: prefix }, ctx());
		const run = await runDoctor({ root: both, site, bundle: prefix });

		// `check` contributes exactly one row, the public mirror allowlist, and reports
		// everything about the compiled tree through the envelope instead. That is why the
		// second test exists, and saying so here stops this assertion reading as though it
		// covered all three.
		expect(checked.rows.map((row) => row.id)).toEqual(['wiring-allow-paths']);
		expect(wiring.rows.length).toBeGreaterThan(0);
		expect(verified.rows.length).toBeGreaterThan(0);

		expect(run.rows).toEqual([...checked.rows, ...wiring.rows, ...verified.rows]);
		expect(run.data.roles).toEqual(['app', 'site', 'bundle']);
	});

	test('over a root whose tree cannot be compiled, where check does have a row', async () => {
		const checked = await invoke(check, { root: bothWithoutGit }, ctx());
		const wiring = await invoke(verifyInstall, { root: bothWithoutGit, site }, ctx());
		const verified = await invoke(bundle, { path: prefix }, ctx());
		const run = await runDoctor({ root: bothWithoutGit, site, bundle: prefix });

		expect(checked.rows).toHaveLength(1);
		expect(checked.rows[0]?.status).toBe('not-run');

		expect(run.rows).toEqual([...checked.rows, ...wiring.rows, ...verified.rows]);
		expect(run.rows[0]).toEqual(checked.rows[0]);
		expect(run.data.roles).toEqual(['app', 'site', 'bundle']);
		expect(run.code).toBe(3);
	});

	test('the envelope is the one check produced, not a re-summarised copy', async () => {
		const checked = await invoke(check, { root: both }, ctx());
		const run = await runDoctor({ root: both, site, bundle: prefix });

		// `check` is the only sub-command with an envelope here, and doctor has to report it
		// as it was computed: a summary re-derived over a list doctor assembled is the same
		// defect `filterEnvelope` exists to stop one command down.
		//
		// The honest limit, measured: deleting the early return in `mergeEnvelopes` leaves
		// this test green, because over a single envelope the merge computes the same four
		// counts, the same `truncated` and the same `nextAction`. What this pins is the
		// values, which is what a reader sees, and not the identity of the object.
		expect(run.envelope).toEqual(checked.envelope);
		expect(run.envelope?.summary.errors).toBeGreaterThan(0);
	});
});

describe('a root with no recognisable role', () => {
	test('fails rather than printing a table of skips', async () => {
		const run = await runDoctor({ root: nothing });

		expect(run.data.roles).toEqual([]);
		// Every row is skipped except the one doctor originates, and `verdict` counts only
		// failures and non-runs, so without that row the renderer would print "all clear"
		// over a run that examined nothing.
		const originated = run.rows.filter((row) => row.id === 'doctor');
		expect(originated).toHaveLength(1);
		expect(originated[0]?.status).toBe('not-run');
		expect(run.rows.some((row) => row.status === 'pass')).toBe(false);
		expect(run.code).toBe(3);

		// The reason has to name what was looked for, or a reader cannot tell a missing
		// checkout from a mistyped path.
		expect(originated[0]?.note).toContain('docs/site/docs.json');
		expect(originated[0]?.note).toContain('.docs.json');
	});

	test('a bundle nobody asked for is skipped, and a skip is not a failure', async () => {
		const run = await runDoctor({ root: nothing });
		const skipped = run.rows.find((row) => row.id === 'bundle');

		expect(skipped?.status).toBe('skipped');
		// A bundle is build output and nothing in a repository says which directory it is
		// in, so guessing at one is the alternative this row refuses.
		expect(skipped?.note).toContain('--bundle');
		expect(skipped?.findings).toEqual([]);
	});
});

describe('the roles it detects', () => {
	test('an app repository alone is the app role, and the site half is not claimed', async () => {
		const run = await runDoctor({ root: app });

		expect(run.data.roles).toEqual(['app']);
		// The allowlist row comes from `check` because this root is an app repository, and
		// `bundle` from the bundle arm. What is absent is any `wiring-*` consumer row: no
		// site config exists under this root, and a skipped row for one would be doctor
		// inventing a consumer that does not exist.
		expect(run.rows.map((row) => row.id)).toEqual(['wiring-allow-paths', 'bundle']);
		expect(run.envelope?.summary.errors).toBeGreaterThan(0);
		expect(run.code).toBe(3);
	});

	for (const shape of CONSUMER_SHAPES) {
		test(`a ${shape} consumer with --site is the site role`, async () => {
			const consumer: Consumer = materialiseConsumerWithConfig(shape, SITE_CONFIG);
			try {
				const wiring = await invoke(
					verifyInstall,
					{ root: consumer.root, site: consumer.site },
					ctx(),
				);
				const run = await runDoctor({ root: consumer.root, site: consumer.site });

				expect(run.data.roles).toEqual(['site']);
				expect(run.rows.slice(0, wiring.rows.length)).toEqual([...wiring.rows]);
				// The two shapes put their site at different depths, `apps/front` against
				// `web/front`, which is what a probe tuned to one consumer gets wrong.
				expect(consumer.site).toContain('front');
			} finally {
				removeConsumer(consumer);
			}
		});

		test(`a ${shape} consumer with no --site says so and names the candidate`, async () => {
			const consumer: Consumer = materialiseConsumerWithConfig(shape, SITE_CONFIG);
			try {
				const run = await runDoctor({ root: consumer.root });

				expect(run.data.roles).toEqual([]);
				const skipped = run.rows.find((row) => row.id === 'verify-install');
				expect(skipped?.status).toBe('skipped');
				expect(skipped?.note).toContain(consumer.site);

				// Nothing ran, so this is still a failure, and the next action is the command
				// that would have run: the reason a skip is not enough on its own is that
				// nothing else here examined anything either.
				expect(run.code).toBe(3);
				expect(run.data.nextAction.kind).toBe('command');
				expect(run.data.nextAction.argv).toEqual([
					'hexdocs',
					'doctor',
					consumer.root,
					'--site',
					consumer.site,
				]);
			} finally {
				removeConsumer(consumer);
			}
		});
	}
});
