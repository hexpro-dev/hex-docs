/**
 * Row 11: a labelled sha with no bundle, and the shape of the answer when nothing can say.
 *
 * Labelling is the throttle. Every commit on main has a bundle and none of them is visible
 * until a version entry names one, so this is the command that decides what the public
 * sees, and the two ways it can be wrong are opposites. It can refuse a label over a
 * machine's configuration, and it can pass one because nothing was able to answer.
 *
 * The second is the one the catalogue names, and it is why the assertions on the ancestry
 * arm are always **two**: the row is `skipped`, and the row is not `pass`. `CHECK_STATES`
 * has four members and only two of them are reachable from `checkRow`, so a version of
 * this command that returned a pass over an unreachable bucket or an unreachable remote
 * would look exactly like a version that had checked.
 *
 * Every `git`, `gh` and `aws` call goes through an injected `Exec` that records the recipe
 * id and the holes and answers from a table. Nothing here runs a process, and the exact
 * recipe ids and holes are asserted, because a hole in the wrong position is a request
 * about a different commit that comes back as a perfectly ordinary answer.
 *
 * `awsConfigured` and `bucketOf` read `process.env` directly, so every case stubs all
 * seven variables rather than assuming the machine running the suite has none of them set.
 *
 * One thing is deliberately not here, said plainly rather than left to be looked for.
 * `label` has no digest arm: the entry it hands back carries no `digest` and says so in a
 * note, because a manifest cannot carry its own digest and `hexdocs sync` is what writes
 * one. The arm the fixture's deliberately-wrong `1.1.0` digest exercises is sync's re-pin,
 * and it is covered in `kit/test/commands/sync.test.ts`. `prefetch` carries the other one,
 * `bundle-digest-mismatch`, and neither is this command's.
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { APP_ROOT, CONSUMER_ROOT } from '../../../fixtures/index.js';
import type { CheckRow, Finding } from '../../../src/contracts/diagnostics.js';
import { MANIFEST_KEY, bundlePrefix } from '../../../src/contracts/manifest.js';
import { label, patchFor } from '../../src/commands/label.js';
import type { Exec, RunResult } from '../../src/exec/run.js';
import type { RecipeId } from '../../src/exec/recipes.js';
import { exitCodeFor, invoke, type CommandOutput, type Ctx } from '../../src/registry/command.js';

const PROJECT = 'fixture-app';
const KIT_VERSION = '@hex-pro/docs-kit@0.0.1';
const BUCKET = 'a-bucket-that-is-not-real';

/** A sha that is in the fixture's version table, and one that is not. */
const LABELLED_COMMIT = '67a7f22c66619693ab861f82cd1cc5fb2f1788a6';
const NEW_COMMIT = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c';

/** Every environment variable `awsConfigured` and `bucketOf` read, cleared by default. */
const AWS_VARIABLES = [
	'AWS_PROFILE',
	'AWS_DEFAULT_PROFILE',
	'AWS_ACCESS_KEY_ID',
	'AWS_WEB_IDENTITY_TOKEN_FILE',
	'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
	'AWS_CONTAINER_CREDENTIALS_FULL_URI',
] as const;

let scratch: string;
let repos = 0;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'hexdocs-label-'));
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
	for (const name of AWS_VARIABLES) vi.stubEnv(name, '');
	vi.stubEnv('HEXDOCS_BUCKET', '');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

function ok(stdout = ''): RunResult {
	return { status: 0, stdout, stderr: '' };
}

function fail(status: number, stderr: string, stdout = ''): RunResult {
	return { status, stdout, stderr };
}

interface Call {
	id: RecipeId;
	holes: string[];
	cwd: string;
}

/**
 * An `Exec` that answers from a table and records everything.
 *
 * A recipe with no answer throws rather than returning a default, so a command that
 * started calling something new fails naming it instead of silently taking a zero exit.
 */
function fakeExec(answers: Partial<Record<RecipeId, (holes: readonly string[]) => RunResult>>) {
	const calls: Call[] = [];
	const exec: Exec = (id, holes, options) => {
		calls.push({ id, holes: [...holes], cwd: options.cwd });
		const answer = answers[id];
		if (answer === undefined) throw new Error(`the fake exec has no answer for "${id}"`);
		return answer(holes);
	};
	return { exec, calls };
}

/** A web repository holding one site config, or none, or two. */
function webRepo(sites: readonly string[] = ['apps/front']): string {
	repos += 1;
	const root = join(scratch, `web-${repos}`);
	for (const site of sites) {
		const path = join(root, ...site.split('/'), 'app', 'docs', `${PROJECT}.docs.json`);
		mkdirSync(dirname(path), { recursive: true });
		cpSync(join(CONSUMER_ROOT, `${PROJECT}.docs.json`), path);
	}
	if (sites.length === 0) mkdirSync(root, { recursive: true });
	return root;
}

/** A clone of the app repository, with or without the config that names it on GitHub. */
function clone(named: boolean): string {
	repos += 1;
	const root = join(scratch, `clone-${repos}`);
	mkdirSync(root, { recursive: true });
	if (named) {
		const path = join(root, 'docs', 'site', 'docs.json');
		mkdirSync(dirname(path), { recursive: true });
		cpSync(join(APP_ROOT, 'docs', 'site', 'docs.json'), path);
	}
	return root;
}

/** A prefetch cache, optionally already holding the manifest for a commit. */
function cache(commit?: string): string {
	repos += 1;
	const root = join(scratch, `cache-${repos}`);
	mkdirSync(root, { recursive: true });
	if (commit !== undefined) {
		const path = join(root, bundlePrefix(PROJECT, commit), MANIFEST_KEY);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, '{}\n', 'utf8');
	}
	return root;
}

interface RunOptions {
	root?: string;
	commit?: string;
	version?: string;
	released?: string;
	sourceRepo?: string;
	cache?: string;
	answers?: Partial<Record<RecipeId, (holes: readonly string[]) => RunResult>>;
}

async function runLabel(options: RunOptions = {}) {
	const root = options.root ?? webRepo();
	const { exec, calls } = fakeExec(options.answers ?? {});
	const ctx: Ctx = {
		cwd: root,
		kitVersion: KIT_VERSION,
		exec,
		write: null,
		now: () => new Date('2026-06-01T00:00:00Z'),
		log: () => undefined,
	};
	const output: CommandOutput = await invoke(
		label,
		{
			root,
			project: PROJECT,
			commit: options.commit ?? NEW_COMMIT,
			version: options.version ?? '2.0.0',
			...(options.released === undefined ? {} : { released: options.released }),
			...(options.sourceRepo === undefined ? {} : { 'source-repo': options.sourceRepo }),
			cache: options.cache ?? cache(),
		},
		ctx,
	);
	const row = (id: string): CheckRow | undefined => output.rows.find((entry) => entry.id === id);
	return { output, calls, row, exit: exitCodeFor(output), root };
}

// ---------------------------------------------------------------------------
// label-shape
// ---------------------------------------------------------------------------

/**
 * The five assertions the shape row makes, each with the phrase only it produces.
 *
 * Checked against the row's own count in both directions below, so an assertion added to
 * the command without a case here, or a case whose phrase stops being produced, fails
 * naming it. Each case also asserts that the other four phrases are absent, which is what
 * makes "each fails individually" a claim rather than a hope.
 */
const SHAPE_CASES = [
	{
		name: 'an abbreviated sha',
		phrase: 'is not a commit sha',
		options: { commit: '67a7f22' },
	},
	{
		name: 'a label that is not a URL segment',
		phrase: 'is not a version label',
		options: { version: 'two point oh' },
	},
	{
		name: 'a date that is not YYYY-MM-DD',
		phrase: 'is not a release date',
		options: { released: '8 April 2026' },
	},
	{
		name: 'a label the table already carries',
		phrase: 'already labels',
		options: { version: '1.1.0' },
	},
	{
		name: 'a commit the table already labels',
		phrase: 'is already labelled',
		options: { commit: LABELLED_COMMIT },
	},
] as const;

describe('label-shape', () => {
	test('a clean label passes, and the count is the assertions rather than the problems', async () => {
		const { row, exit } = await runLabel();
		expect(row('label-shape')?.status).toBe('pass');
		expect(row('label-shape')?.examined).toBe(5);
		expect(row('label-shape')?.unit).toBe('assertions');
		expect(row('label-shape')?.note).toBeNull();
		// The bundle row is what fails a default run: nothing is cached and the bucket was
		// not asked, so there is no verdict on whether the bundle exists.
		expect(exit).toBe(3);
	});

	for (const entry of SHAPE_CASES) {
		test(`${entry.name} fails on its own`, async () => {
			const { row } = await runLabel(entry.options);
			const shape = row('label-shape');
			expect(shape?.status).toBe('fail');
			// Still five assertions examined. A failing row that counted the problems would
			// report a smaller number the worse the input got.
			expect(shape?.examined).toBe(5);
			expect(shape?.note).toContain(entry.phrase);
			for (const other of SHAPE_CASES) {
				if (other.phrase === entry.phrase) continue;
				expect(shape?.note).not.toContain(other.phrase);
			}
		});
	}

	test('the five cases are the five assertions, in both directions', async () => {
		// One direction: the count the row reports.
		const { row } = await runLabel();
		expect(SHAPE_CASES).toHaveLength(row('label-shape')?.examined ?? 0);
		// The other: every phrase is distinct, so no two cases are the same assertion wearing
		// two names.
		const phrases = SHAPE_CASES.map((entry) => entry.phrase);
		expect(new Set(phrases).size).toBe(phrases.length);
	});

	test('several at once come back on one row rather than one at a time', async () => {
		// Three of the five, which is the most that can hold together: an abbreviated sha
		// cannot also be a sha the table already carries, and a label that is not a URL
		// segment cannot also be one the table already uses.
		const { row } = await runLabel({
			commit: LABELLED_COMMIT,
			version: '1.1.0',
			released: 'yesterday',
		});
		const note = row('label-shape')?.note ?? '';
		expect(note).toContain('is not a release date');
		expect(note).toContain('already labels');
		expect(note).toContain('is already labelled');
		expect(note).not.toContain('is not a commit sha');
		expect(note).not.toContain('is not a version label');
	});

	test('the release date defaults to today in UTC, not to the local date', async () => {
		const { output } = await runLabel();
		const data = output.data as { entry: { released: string } };
		// `ctx.now` is injected precisely so this is testable without the clock.
		expect(data.entry.released).toBe('2026-06-01');
	});
});

// ---------------------------------------------------------------------------
// label-bundle-exists
// ---------------------------------------------------------------------------

/** The one finding a row carries, so a row carrying two fails rather than passing. */
function onlyFinding(row: CheckRow | undefined): Finding {
	expect(row?.findings).toHaveLength(1);
	const finding = row?.findings[0];
	if (finding === undefined) throw new Error('the row carries no finding');
	return finding;
}

describe('label-bundle-exists', () => {
	test('a 404 from the bucket is the finding, through the real runLint', async () => {
		vi.stubEnv('AWS_PROFILE', 'a-profile');
		vi.stubEnv('HEXDOCS_BUCKET', BUCKET);
		const { row, calls, exit } = await runLabel({
			answers: {
				'aws.head-object': () =>
					fail(255, 'An error occurred (404) when calling the HeadObject operation: Not Found'),
			},
		});

		const bundle = row('label-bundle-exists');
		expect(bundle?.status).toBe('fail');
		// Both arms answered: the cache said no and the bucket said no.
		expect(bundle?.examined).toBe(2);

		const finding = onlyFinding(bundle);
		expect(finding.rule).toBe('bundle-label-unknown-sha');
		// `category` and `consequence` exist only on a `Finding`, so their presence is the
		// proof that this went through `runLint` rather than being assembled here. A
		// hand-built finding would be a second definition of what a report is.
		expect(finding.severity).toBe('error');
		expect(finding.category).toBe('bundle');
		expect(finding.consequence).toContain('whose every page 404s');
		expect(finding.message).toContain(NEW_COMMIT.slice(0, 8));
		expect(finding.message).toContain(`${bundlePrefix(PROJECT, NEW_COMMIT)}/${MANIFEST_KEY}`);
		expect(finding.remediation).toContain('hexdocs bundle');
		expect(exit).toBe(3);

		// One call, and the holes in the order the template chose. `aws.head-object` fills
		// `--bucket` and then `--key`, so a pair swapped here is a request about an object
		// named after the bucket, which comes back as an ordinary 404.
		const heads = calls.filter((call) => call.id === 'aws.head-object');
		expect(heads).toHaveLength(1);
		expect(heads[0]?.holes).toEqual([
			BUCKET,
			`${bundlePrefix(PROJECT, NEW_COMMIT)}/${MANIFEST_KEY}`,
		]);
	});

	test('cached locally and absent from the bucket is the case that must refuse', async () => {
		vi.stubEnv('AWS_PROFILE', 'a-profile');
		vi.stubEnv('HEXDOCS_BUCKET', BUCKET);
		const { row } = await runLabel({
			cache: cache(NEW_COMMIT),
			answers: { 'aws.head-object': () => fail(255, 'An error occurred (404) ...') },
		});
		const bundle = row('label-bundle-exists');
		expect(bundle?.status).toBe('fail');
		expect(bundle?.note).toContain('built locally and never published');
	});

	test('cached locally with the bucket unreachable is a pass, with the reason recorded', async () => {
		// No credentials, so the bucket is not asked at all. The cache is a copy of what the
		// bucket holds, and a prefetch that has run is evidence enough to let a label through.
		const { row, calls } = await runLabel({ cache: cache(NEW_COMMIT) });
		const bundle = row('label-bundle-exists');
		expect(bundle?.status).toBe('pass');
		// One arm, and the row says so rather than claiming two.
		expect(bundle?.examined).toBe(1);
		expect(bundle?.note).toContain('bucket not asked');
		expect(bundle?.note).toContain('no AWS credentials are configured');
		expect(calls.filter((call) => call.id === 'aws.head-object')).toEqual([]);
	});

	test('nothing cached and the bucket unreachable is a finding, not a pass', async () => {
		const { row } = await runLabel();
		const bundle = row('label-bundle-exists');
		expect(bundle?.status).toBe('fail');
		const finding = onlyFinding(bundle);
		expect(finding.rule).toBe('bundle-label-unknown-sha');
		expect(finding.message).toContain('does not exist, and the bucket could not be asked');
		expect(finding.remediation).toContain('hexdocs prefetch');
	});

	test('in the bucket and not in the cache is a pass that says prefetch will fetch it', async () => {
		vi.stubEnv('AWS_PROFILE', 'a-profile');
		vi.stubEnv('HEXDOCS_BUCKET', BUCKET);
		const { row } = await runLabel({ answers: { 'aws.head-object': () => ok('{}') } });
		const bundle = row('label-bundle-exists');
		expect(bundle?.status).toBe('pass');
		expect(bundle?.examined).toBe(2);
		expect(bundle?.note).toContain('hexdocs prefetch');
	});

	test('an exit that is not a 404 is an unanswered question, never an absent bundle', async () => {
		vi.stubEnv('AWS_PROFILE', 'an-expired-profile');
		vi.stubEnv('HEXDOCS_BUCKET', BUCKET);
		const { row } = await runLabel({
			cache: cache(NEW_COMMIT),
			answers: {
				'aws.head-object': () => fail(255, 'ExpiredToken: The provided token has expired'),
			},
		});
		const bundle = row('label-bundle-exists');
		// A cache hit and no answer from the bucket. Classifying the expired session as "no
		// bundle" would block a label over somebody's SSO session.
		expect(bundle?.status).toBe('pass');
		expect(bundle?.note).toContain('exited 255');
		expect(bundle?.note).toContain('ExpiredToken');
	});

	test('a missing aws binary is also an unanswered question', async () => {
		vi.stubEnv('AWS_PROFILE', 'a-profile');
		vi.stubEnv('HEXDOCS_BUCKET', BUCKET);
		const { row } = await runLabel({
			cache: cache(NEW_COMMIT),
			answers: {
				'aws.head-object': () => ({ status: null, stdout: '', stderr: 'spawn aws ENOENT' }),
			},
		});
		expect(row('label-bundle-exists')?.note).toContain('could not be run');
	});

	test('credentials configured with no bucket named is the bucket not asked', async () => {
		vi.stubEnv('AWS_PROFILE', 'a-profile');
		const { row, calls } = await runLabel({ cache: cache(NEW_COMMIT) });
		expect(row('label-bundle-exists')?.note).toContain('There is no default');
		expect(calls).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// label-ancestry
// ---------------------------------------------------------------------------

const REPO_HOLE = 'repos/hexpro-dev/fixture-app';

function ghAnswers(
	branch: string | null,
	compare: (holes: readonly string[]) => RunResult,
): Partial<Record<RecipeId, (holes: readonly string[]) => RunResult>> {
	return {
		'gh.api': (holes) => {
			if (holes[0] === REPO_HOLE) {
				return branch === null
					? fail(1, 'gh: Not Found (HTTP 404)')
					: ok(JSON.stringify({ default_branch: branch }));
			}
			return compare(holes);
		},
	};
}

describe('label-ancestry', () => {
	test('no --source-repo is skipped, and skipped is not passing', async () => {
		const { row, calls } = await runLabel();
		const ancestry = row('label-ancestry');
		expect(ancestry?.status).toBe('skipped');
		// The assertion the catalogue names. `checkRow` cannot produce `skipped`, so a
		// version of this arm that used it would land on `pass` and read as a check.
		expect(ancestry?.status).not.toBe('pass');
		expect(ancestry?.examined).toBe(0);
		expect(ancestry?.note).toContain('--source-repo');
		expect(ancestry?.note).toContain('Nothing in a site config names the app repository');
		// And nothing was run, which is what "neither route was available" means.
		expect(calls.filter((call) => call.id === 'gh.api')).toEqual([]);
		expect(calls.filter((call) => call.id === 'git.merge-base-is-ancestor')).toEqual([]);
	});

	test('a --source-repo that is not a directory is skipped, naming both routes', async () => {
		const missing = join(scratch, 'not-a-clone');
		expect(existsSync(missing)).toBe(false);
		const { row } = await runLabel({ sourceRepo: missing });
		expect(row('label-ancestry')?.status).toBe('skipped');
		expect(row('label-ancestry')?.note).toContain('is not a directory');
		expect(row('label-ancestry')?.note).toContain('merge-base --is-ancestor');
	});

	test('neither route able to answer is skipped, carrying both reasons', async () => {
		const { row, calls } = await runLabel({
			sourceRepo: clone(true),
			answers: {
				...ghAnswers(null, () => fail(1, 'unreachable')),
				'git.merge-base-is-ancestor': () => fail(128, "fatal: ambiguous argument 'origin/HEAD'"),
			},
		});
		const ancestry = row('label-ancestry');
		expect(ancestry?.status).toBe('skipped');
		expect(ancestry?.status).not.toBe('pass');
		// Both reasons, not the first. A row naming only the GitHub failure would send
		// somebody to check their gh login when the clone was the thing that could not
		// answer.
		expect(ancestry?.note).toContain('HTTP 404');
		expect(ancestry?.note).toContain('exited 128');
		expect(ancestry?.note).toContain('; and ');

		// Both routes really were tried, in that order.
		expect(calls.map((call) => call.id)).toEqual(['gh.api', 'git.merge-base-is-ancestor']);
		expect(calls[1]?.holes).toEqual([NEW_COMMIT, 'origin/HEAD']);
	});

	test('git exit 128 is no answer, and only exit 1 is the answer "no"', async () => {
		const source = clone(false);
		const unknownRef = await runLabel({
			sourceRepo: source,
			answers: { 'git.merge-base-is-ancestor': () => fail(128, 'fatal: bad object') },
		});
		expect(unknownRef.row('label-ancestry')?.status).toBe('skipped');

		const notAncestor = await runLabel({
			sourceRepo: source,
			answers: { 'git.merge-base-is-ancestor': () => fail(1, '') },
		});
		expect(notAncestor.row('label-ancestry')?.status).toBe('fail');
		expect(notAncestor.row('label-ancestry')?.note).toContain('is not an ancestor of origin/HEAD');
		expect(notAncestor.row('label-ancestry')?.note).toContain('code nobody has merged');
	});

	test('a clone that names no repository uses the local route only', async () => {
		const { row, calls } = await runLabel({
			sourceRepo: clone(false),
			answers: { 'git.merge-base-is-ancestor': () => ok() },
		});
		expect(row('label-ancestry')?.status).toBe('pass');
		expect(calls.map((call) => call.id)).toEqual(['git.merge-base-is-ancestor']);
		expect(row('label-ancestry')?.note).toContain('does not exist, so nothing names');
	});

	test('the default branch is read from the API rather than assumed to be main', async () => {
		const { row, calls } = await runLabel({
			sourceRepo: clone(true),
			answers: ghAnswers('trunk', () => ok(JSON.stringify({ status: 'behind' }))),
		});
		expect(row('label-ancestry')?.status).toBe('pass');
		// A repository on `trunk` compared against `main` comes back 404 from the compare
		// endpoint and would be reported as an unknown sha, which is a wrong answer that
		// reads as a real finding.
		expect(calls.map((call) => call.holes[0])).toEqual([
			REPO_HOLE,
			`${REPO_HOLE}/compare/trunk...${NEW_COMMIT}`,
		]);
	});

	const COMPARE_STATES = [
		{ status: 'identical', expected: 'pass' },
		{ status: 'behind', expected: 'pass' },
		{ status: 'ahead', expected: 'fail' },
		{ status: 'diverged', expected: 'fail' },
	] as const;

	for (const entry of COMPARE_STATES) {
		test(`a commit reported "${entry.status}" is ${entry.expected}`, async () => {
			const { row } = await runLabel({
				sourceRepo: clone(true),
				answers: ghAnswers('main', () => ok(JSON.stringify({ status: entry.status }))),
			});
			expect(row('label-ancestry')?.status).toBe(entry.expected);
			expect(row('label-ancestry')?.examined).toBe(1);
		});
	}

	test('a compare status this does not understand is no answer, not a guess', async () => {
		// It falls through to the clone, which is the right shape: an unrecognised status is
		// an unavailable remote rather than a verdict. With the clone unable to answer either,
		// the row is skipped and names both.
		const { row } = await runLabel({
			sourceRepo: clone(true),
			answers: {
				...ghAnswers('main', () => ok(JSON.stringify({ status: 'something-new' }))),
				'git.merge-base-is-ancestor': () => fail(128, 'fatal: bad object'),
			},
		});
		expect(row('label-ancestry')?.status).toBe('skipped');
		expect(row('label-ancestry')?.status).not.toBe('pass');
		expect(row('label-ancestry')?.note).toContain('something-new');
	});

	test('a 404 from compare is a commit the repository has never seen', async () => {
		const { row } = await runLabel({
			sourceRepo: clone(true),
			answers: ghAnswers('main', () => fail(1, 'gh: Not Found (HTTP 404)')),
		});
		const ancestry = row('label-ancestry');
		expect(ancestry?.status).toBe('fail');
		const finding = onlyFinding(ancestry);
		expect(finding.rule).toBe('bundle-label-unknown-sha');
		expect(finding.category).toBe('bundle');
		expect(finding.message).toContain('does not know the commit');
		expect(finding.remediation).toContain('force push');
	});

	test('the remote failing and the clone answering names both in the route', async () => {
		const source = clone(true);
		const { row, calls } = await runLabel({
			sourceRepo: source,
			answers: {
				...ghAnswers(null, () => fail(1, 'unreachable')),
				'git.merge-base-is-ancestor': () => ok(),
			},
		});
		expect(row('label-ancestry')?.status).toBe('pass');
		expect(row('label-ancestry')?.note).toContain('merge-base --is-ancestor');
		expect(row('label-ancestry')?.note).toContain('after ');
		// The clone is asked in its own directory, not in the web repository.
		expect(calls[1]?.cwd).toBe(source);
	});
});

// ---------------------------------------------------------------------------
// nothing to label into
// ---------------------------------------------------------------------------

describe('the file the label goes into', () => {
	test('no site config is three not-run rows, not one', async () => {
		const { output, exit } = await runLabel({ root: webRepo([]) });
		expect(output.rows.map((row) => row.id)).toEqual([
			'label-shape',
			'label-bundle-exists',
			'label-ancestry',
		]);
		// All three. A report carrying one leaves a reader unable to say whether the other
		// two passed or never ran, and dark is indistinguishable from green to an exit code.
		expect(output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run', 'not-run']);
		expect((output.data as { checked: boolean }).checked).toBe(false);
		expect(output.rows[0]?.note).toContain('hexdocs install');
		expect(exit).toBe(3);
	});

	test('two site configs name both rather than labelling one of them', async () => {
		const { output, exit } = await runLabel({ root: webRepo(['apps/front', 'apps/admin']) });
		expect(output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run', 'not-run']);
		const note = output.rows[0]?.note ?? '';
		expect(note).toContain('apps/front');
		expect(note).toContain('apps/admin');
		expect(note).toContain('the others serving the old version list');
		expect(exit).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// the edit it hands back
// ---------------------------------------------------------------------------

describe('the patch', () => {
	test('is anchored on the versions line and indented from it', async () => {
		const { output } = await runLabel({ cache: cache(NEW_COMMIT) });
		const data = output.data as {
			entry: { label: string; commit: string; released: string };
			patch: { path: string; anchor: string; insert: string } | null;
			notes: string[];
		};
		expect(data.patch).not.toBeNull();
		expect(data.patch?.anchor).toBe('\t"versions": [');
		// One level in from the key, derived from the key's own indent rather than hard
		// coded, so a file somebody's editor wrote with spaces does not come back with a
		// reformatted block in the diff.
		expect(data.patch?.insert).toBe(
			[
				'\t\t{',
				`\t\t\t"label": "2.0.0",`,
				`\t\t\t"commit": "${NEW_COMMIT}",`,
				`\t\t\t"released": "2026-06-01"`,
				'\t\t},',
			].join('\n'),
		);
		expect(data.entry).toEqual({
			label: '2.0.0',
			commit: NEW_COMMIT,
			released: '2026-06-01',
		});
	});

	test('carries no default and no digest, and says why for each', async () => {
		const { output } = await runLabel({ cache: cache(NEW_COMMIT) });
		const data = output.data as { patch: { insert: string } | null; notes: string[] };
		expect(data.patch?.insert).not.toContain('default');
		expect(data.patch?.insert).not.toContain('digest');
		const notes = data.notes.join('\n');
		expect(notes).toContain('no `"default": true`');
		expect(notes).toContain('which pages are in the sitemap');
		expect(notes).toContain('`hexdocs sync` writes that');
	});

	test('patchFor takes the file indent, and returns null where there is no anchor', () => {
		// The unit, so the two shapes are covered without building a repository for each.
		const spaces = patchFor('{\n  "versions": [\n  ]\n}', {
			label: 'v1',
			commit: 'a'.repeat(40),
			released: '2026-06-01',
		});
		expect(spaces?.anchor).toBe('  "versions": [');
		expect(spaces?.insert.split('\n')[0]).toBe('    {');
		expect(spaces?.insert.split('\n')[1]).toBe('      "label": "v1",');
		expect(
			patchFor('{ "versions": [] }', {
				label: 'v1',
				commit: 'a'.repeat(40),
				released: '2026-06-01',
			}),
		).toBeNull();
	});

	test('a file with no versions line is a note rather than a silent absence', async () => {
		const root = webRepo();
		const path = join(root, 'apps', 'front', 'app', 'docs', `${PROJECT}.docs.json`);
		// Rewritten packed, so the `"versions": [` line is gone while the document stays
		// valid. That is the state the anchor search has to survive.
		const config = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		writeFileSync(path, JSON.stringify(config), 'utf8');

		const { output } = await runLabel({ root, cache: cache(NEW_COMMIT) });
		const data = output.data as { patch: unknown; notes: string[] };
		expect(data.patch).toBeNull();
		expect(data.notes.join('\n')).toContain('no anchored patch');
	});
});
