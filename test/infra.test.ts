/**
 * The two Terraform guards, driven red, and the library underneath one of them.
 *
 * `scripts/check-infra.mjs` and `scripts/check-stack.mjs` are the newest members of the set
 * this repository holds to one rule: a green run of a guard proves the thing it watches is
 * right, and it proves nothing at all about whether the guard could have said otherwise.
 * `test/paint.test.ts` closes that gap for the browser row and `test/cli-surface.test.ts`
 * closes it for the launcher row. This closes it for the stack, in the same shape: one
 * mutation per describe block, in a throwaway copy, asserting that the row which claims to
 * watch that thing is the row that goes red.
 *
 * ## Nothing here reaches AWS
 *
 * `terraform fmt`, `validate` and `test` need no credentials and no network. The stack's test
 * file configures the provider from static rubbish with every skip flag set, and the fixture
 * borrows the provider cache `infra/.terraform` already holds through a symlink, so no `init`
 * runs either.
 *
 * `check-stack.mjs` is the credentialled guard and only three of its states are reachable
 * without an account, all of them before the first call: an `infra/` with no state, a copy
 * that has never been initialised, and no terraform binary at all.
 *
 * Everything underneath its calls is `scripts/lib/policy-diff.mjs`, and the second half of
 * this file drives that directly. It is tested here rather than in a file of its own because
 * it is the stack guard's own half and reads as one subject with the cases above it. It is not
 * decoration either: a bug in `comparePolicy` reports no drift on a bucket policy that has
 * actually changed, and the bucket policy is the one control in the stack that binds the
 * account root user, so the failure mode is a green row over a store whose published bundles
 * anybody in the account can delete.
 *
 * What stays unproved here is every row that makes a call. `pnpm check:stack` against a real
 * account is what proves those, which is the same split `kit/test/s3/` already carries.
 *
 * ## Why the fixture is a real git repository
 *
 * Four of the invariants row's assertions and both directions of the fmt row's cross-check
 * read `git ls-files`. In a temporary directory that is not a repository git answers nothing,
 * both of those rows are red before any mutation lands, and no case below could say which
 * change reddened what. So the fixture gets an index of its own: `git init` then `git add`,
 * which is the pattern `materialiseCorpus()` in `fixtures/` already established one directory
 * over for the same reason, that a property of history cannot be tested against a tree with no
 * history.
 *
 * ## Why the mutation runs before the index is built
 *
 * A file moved or added after `git add` is a file git neither tracks nor ignores, which the
 * fmt row reports on its own. Mutating first means the fixture is internally consistent and
 * each case reddens one row rather than two. The one case that deliberately writes after the
 * index exists is the tracked tfvars, because `git add -f` is exactly how that file arrives.
 */

import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

// @ts-expect-error -- a zero-dependency guard, written as .mjs like the others
import { findTerraform, run as runInfra } from '../scripts/check-infra.mjs';
// @ts-expect-error -- see above.
import { run as runStack } from '../scripts/check-stack.mjs';
// @ts-expect-error -- a zero-dependency library, written as .mjs like the guards it serves.
import {
	IAM_POLICY_SOURCE,
	NO_CREDENTIALS,
	STATEMENT_FIELDS,
	asList,
	canonicalCondition,
	canonicalPrincipal,
	canonicalStatement,
	cleanLines,
	comparePolicy,
	conditionPairs,
	contextEntries,
	credentialsReason,
	diffStatement,
	formatPath,
	readDecisions,
	redactor,
	scrubIdentifiers,
	stable,
	statementsOf,
	tail,
} from '../scripts/lib/policy-diff.mjs';
import type { CheckResult } from '../scripts/lib/report.mjs';
import { REPO_ROOT } from './support/golden.js';

/** The template the branch cross-check reads, at the path the guard names. */
const WORKFLOW_TEMPLATE = 'kit/src/templates/workflow.ts';

const TEST_FILE = 'infra/tests/policies.tftest.hcl';

/** The four rows, in the order the guard returns them. */
const ROW_NAMES = ['stack invariants', 'terraform fmt', 'terraform validate', 'terraform test'];

const TERRAFORM = findTerraform() as string | undefined;

/**
 * Whether the terraform rows can produce a real answer on this machine.
 *
 * `validate` and `test` both refuse without a provider, and this guard deliberately never runs
 * an `init` of its own, so a machine with the binary and no `infra/.terraform` reports those
 * two rows NOT RUN. The fixture borrows the real cache, so what gates the cases below is the
 * same pair of facts the guard itself checks.
 */
const INITIALISED = TERRAFORM !== undefined && existsSync(join(REPO_ROOT, 'infra', '.terraform'));

/**
 * The rows that are NOT RUN in this environment whatever the fixture says.
 *
 * NOT RUN is a failing state, so `soleFailure` below has to know the difference between a row
 * this environment could never run and a row a mutation broke. With no binary at all the three
 * terraform rows are SKIPPED rather than NOT RUN, which is the guard's own distinction.
 */
const ENVIRONMENT_NOT_RUN =
	TERRAFORM !== undefined && !INITIALISED ? ['terraform validate', 'terraform test'] : [];

const temporaries: string[] = [];

interface StackOptions {
	/**
	 * Runs against the copied tree before the git index is built. Every mutation that adds,
	 * moves or removes a file belongs here rather than in the test body.
	 */
	mutate?: (root: string) => void;
	/**
	 * `false` writes a `.git` file git refuses to read rather than leaving the directory
	 * plainly outside a repository. `git ls-files` walks up through parent directories, so a
	 * bare temporary directory is only outside a repository as long as nothing above the
	 * system temp directory is one. The unreadable gitfile fails the same way wherever the
	 * fixture lands, and the arm under test is the one where git could not answer.
	 */
	git?: boolean;
	/** `false` leaves the fixture uninitialised, which is what `check-stack.mjs` is driven with. */
	providerCache?: boolean;
}

/**
 * A throwaway repository holding a copy of the stack.
 *
 * Copied rather than symlinked, unlike the large trees in `test/cli-surface.test.ts`, because
 * every case here writes to one of these files and the whole point of the fixture is that the
 * real `infra/` is not the thing being mutated.
 *
 * Two things are deliberately left out of the copy. `.terraform` is the aws provider, which is
 * hundreds of megabytes and identical for every fixture, so it arrives as a symlink; `rmSync`
 * unlinks a symlink rather than descending into it, and the cleanup below unlinks it by hand
 * first anyway. Any `*.tfvars` is left behind because an operator who has applied this stack
 * has a real one on disk carrying the account id and the bucket name, and a fixture that
 * copied it would put those into a git index for no gain. Leaving it out is also the state a
 * fresh checkout and CI are in.
 */
function copyStack(options: StackOptions = {}): string {
	const root = mkdtempSync(join(tmpdir(), 'hexdocs-infra-'));
	temporaries.push(root);

	cpSync(join(REPO_ROOT, 'infra'), join(root, 'infra'), {
		recursive: true,
		filter: (source) => basename(source) !== '.terraform' && !source.endsWith('.tfvars'),
	});
	// The ignore rules are what tell the fmt row that a local tfvars is deliberate rather than
	// a file CI is missing, so the fixture needs the real ones and not an invented set.
	cpSync(join(REPO_ROOT, '.gitignore'), join(root, '.gitignore'));
	mkdirSync(join(root, 'kit', 'src', 'templates'), { recursive: true });
	cpSync(join(REPO_ROOT, WORKFLOW_TEMPLATE), join(root, WORKFLOW_TEMPLATE));

	options.mutate?.(root);

	if (options.git === false) {
		writeFileSync(join(root, '.git'), 'not a repository\n', 'utf8');
	} else {
		fixtureGit(root, 'init', '-q');
		fixtureGit(root, 'add', '-A');
	}

	if (options.providerCache !== false) {
		symlinkSync(join(REPO_ROOT, 'infra', '.terraform'), join(root, 'infra', '.terraform'));
	}

	return root;
}

function fixtureGit(root: string, ...args: string[]): void {
	const spawned = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
	if (spawned.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed in the fixture: ${spawned.stderr}`);
	}
}

/**
 * Rewrites one file in the fixture, refusing an edit that changed nothing.
 *
 * The refusal is the part worth having. Every mutation below anchors on real text, and a
 * mutation whose anchor has moved leaves the fixture byte for byte identical to the stack:
 * the guard then reports green, the assertion that it went red fails, and the reason reads as
 * a broken guard rather than as a broken test. This names the file instead.
 */
function edit(root: string, relative: string, change: (text: string) => string): void {
	const path = join(root, relative);
	const before = readFileSync(path, 'utf8');
	const after = change(before);
	if (after === before) {
		throw new Error(
			`The mutation of ${relative} changed nothing, so the fixture is the real stack and this case proves nothing. The anchor it looks for has moved.`,
		);
	}
	writeFileSync(path, after, 'utf8');
}

function rowsBy(rows: CheckResult[]): Map<string, CheckResult> {
	return new Map(rows.map((row) => [row.name, row]));
}

/**
 * Asserts that exactly one row is red, and returns it.
 *
 * Both failing states are checked, because a mutation that turned a row NOT RUN instead would
 * otherwise read here as a run in which one row failed and everything else was fine.
 */
function soleFailure(rows: CheckResult[], name: string): CheckResult {
	expect(rows.filter((row) => row.state === 'NOT RUN').map((row) => row.name)).toEqual(
		ENVIRONMENT_NOT_RUN,
	);
	const red = rows.filter((row) => row.state === 'FAIL');
	expect(
		red.map((row) => `${row.name}: ${(row.problems ?? []).join('; ')}`),
		'exactly one row should have gone red',
	).toHaveLength(1);
	expect(red[0]?.name).toBe(name);
	return red[0] as CheckResult;
}

function problemsOf(row: CheckResult | undefined): string {
	return (row?.problems ?? []).join(' | ');
}

/** How many `run` blocks the real test file declares, so the counts below are relative. */
function declaredRunBlocks(): number {
	const text = readFileSync(join(REPO_ROOT, TEST_FILE), 'utf8');
	return [...text.matchAll(/^run\s+"[^"]*"\s*\{/gm)].length;
}

/**
 * The first executable file of that name on the current PATH.
 *
 * The same predicate `findTerraform` uses, for the same reason: a directory or a stray text
 * file of the right name is not the binary.
 */
function onPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? '').split(delimiter)) {
		if (dir === '') continue;
		const candidate = join(dir, name);
		try {
			const stats = statSync(candidate);
			if (stats.isFile() && (stats.mode & 0o111) !== 0) return candidate;
		} catch {
			continue;
		}
	}
	return undefined;
}

let shim: string | undefined;

/**
 * A PATH holding git and nothing else.
 *
 * Filtering terraform's own directory out of the real PATH was the other option and it is not
 * safe: on a runner image git and terraform can sit in the same directory, and removing it
 * would take git with it. Four of the invariants row's assertions read `git ls-files`, so a
 * case about a missing terraform that also loses git would redden the row it is asserting
 * still passes, for a reason that has nothing to do with terraform.
 */
function pathWithGitOnly(): string {
	if (shim !== undefined) return shim;
	const git = onPath('git');
	if (git === undefined) {
		throw new Error('No git on PATH, so the fixture cannot be given an index at all.');
	}
	shim = mkdtempSync(join(tmpdir(), 'hexdocs-path-'));
	temporaries.push(shim);
	symlinkSync(git, join(shim, 'git'));
	return shim;
}

/**
 * Runs `body` with no terraform reachable and `CI` set to `ci`.
 *
 * `HEXDOCS_TERRAFORM` is cleared as well as PATH being replaced, because it wins over the PATH
 * walk and a developer who has one set would otherwise get a case that quietly measured the
 * opposite of what it says.
 */
function withoutTerraform<T>(ci: string | undefined, body: () => T): T {
	const saved = {
		PATH: process.env.PATH,
		CI: process.env.CI,
		HEXDOCS_TERRAFORM: process.env.HEXDOCS_TERRAFORM,
	};
	process.env.PATH = pathWithGitOnly();
	delete process.env.HEXDOCS_TERRAFORM;
	if (ci === undefined) delete process.env.CI;
	else process.env.CI = ci;
	try {
		return body();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

afterAll(() => {
	for (const root of temporaries) {
		// The provider cache is a symlink to the real one. `rmSync` unlinks a symlink rather
		// than descending through it, so this is belt as well as braces, and it is here because
		// the thing on the other end is `infra/.terraform` in the working tree.
		try {
			unlinkSync(join(root, 'infra', '.terraform'));
		} catch {
			// Most fixtures have no such link, and a fixture that could not be tidied is not a
			// reason to fail a suite about guards.
		}
		rmSync(root, { recursive: true, force: true });
	}
});

describe('finding terraform', () => {
	test('honours an explicit path', () => {
		process.env.HEXDOCS_TERRAFORM = '/definitely/not/here';
		try {
			// An explicit path that does not exist is not a reason to go looking elsewhere.
			// Somebody who set the variable meant that binary, and silently formatting and
			// validating with a different one is exactly the difference the version in the row's
			// note exists to explain.
			expect(findTerraform()).toBeUndefined();
		} finally {
			delete process.env.HEXDOCS_TERRAFORM;
		}
	});

	test('a directory and a text file of the right name are walked past, and the binary after them is found', () => {
		// What this drives is `stats.isFile() && (stats.mode & 0o111) !== 0` in `findTerraform`.
		// The case it replaces asserted `TERRAFORM === undefined || TERRAFORM.length > 0`, which
		// is true of every answer the function can give and could not have reddened for any
		// change to the walk at all.
		//
		// Three entries, and the order is the design. A directory named `terraform` is mode
		// 0o755, so the mode test alone accepts it and only `isFile()` rejects it; a
		// non-executable file of the same name is the other way round, so between them the two
		// decoys cover each half of the predicate as well as its deletion. The real shim goes
		// last because without it a `findTerraform` that returned undefined unconditionally
		// would pass: the assertion has to be that the walk skipped two entries and kept going,
		// not merely that it declined to answer.
		const decoys = mkdtempSync(join(tmpdir(), 'hexdocs-decoy-'));
		temporaries.push(decoys);

		const asDirectory = join(decoys, 'directory');
		mkdirSync(join(asDirectory, 'terraform'), { recursive: true });

		const asText = join(decoys, 'text');
		mkdirSync(asText);
		writeFileSync(join(asText, 'terraform'), 'not a binary\n', 'utf8');
		// Set rather than passed to `writeFileSync`, whose mode argument is masked by the
		// process umask. A umask that cleared the executable bits would make the text decoy
		// pass for the wrong reason and a stricter one would make it fail for the wrong reason.
		chmodSync(join(asText, 'terraform'), 0o644);

		const real = join(decoys, 'real');
		mkdirSync(real);
		writeFileSync(join(real, 'terraform'), '#!/bin/sh\nexit 0\n', 'utf8');
		chmodSync(join(real, 'terraform'), 0o755);

		const saved = { PATH: process.env.PATH, HEXDOCS_TERRAFORM: process.env.HEXDOCS_TERRAFORM };
		process.env.PATH = [asDirectory, asText, real].join(delimiter);
		// It wins over the PATH walk, so a developer who has one set would otherwise get a case
		// that measured nothing this test is about.
		delete process.env.HEXDOCS_TERRAFORM;
		try {
			expect(findTerraform()).toBe(join(real, 'terraform'));
		} finally {
			if (saved.PATH === undefined) delete process.env.PATH;
			else process.env.PATH = saved.PATH;
			if (saved.HEXDOCS_TERRAFORM !== undefined) {
				process.env.HEXDOCS_TERRAFORM = saved.HEXDOCS_TERRAFORM;
			}
		}
	});
});

/**
 * The invariants row, with the ids of the assertions that produced its count.
 *
 * `stackInvariants` hangs the list off the row it returns rather than off a module-level
 * export, so what is read here is the run that produced it and not whichever run finished
 * last. Nothing in `scripts/lib/report.mjs` reads the field.
 */
type InvariantsRow = CheckResult & { arms: string[] };

/**
 * Every assertion in `stackInvariants`, by the id it tags itself with, and the mutation that
 * has to make it fail.
 *
 * ## Why the table replaced a floor
 *
 * The row was held to `examined > 20` while reporting 74. Fifty-odd of those evaluations could
 * therefore have stopped happening with the whole suite green, and a count cannot say which
 * ones: it is one number over every assertion in the function, and each of those is about a
 * policy statement, a lifecycle rule or a tracked secret that nothing else in this repository
 * has an opinion about. Deriving the expected total from a second parse of the
 * stack was the other option and it is worse than the floor: it is a copy of the guard, so it
 * agrees with the guard exactly when both are wrong.
 *
 * This is `kit/test/compile/rules-fire.test.ts`'s shape applied to a guard rather than to a
 * lint rule pack. The set of ids here is checked against the set the guard emitted, in both
 * directions, so an arm deleted from `stackInvariants` fails by name and a claim left behind
 * for an arm that no longer exists fails too.
 *
 * ## What it is and is not
 *
 * It is a claim, not a proof. No test asserts that the sentence beside an id is true. The arms
 * named in `DRIVEN_ARMS` below do have a case in this file that performs the mutation and
 * watches the row go red; for the rest, the guarantee is only that the assertion still runs
 * and that somebody wrote down what would break it.
 *
 * The residual gap, stated rather than papered over: the emitted set comes from a run over
 * this repository, where every arm is reached. An arm added inside a branch a healthy stack
 * never enters would be absent from both sides and pass unnoticed. That is exactly why
 * `document-declared` is asserted on every document rather than from inside the branch where
 * one is missing.
 */
const ARM_CLAIMS: Record<string, string> = {
	'blocks-closed':
		'Leave a top-level block unclosed, which gives the parse a truncated body it still asserts about.',
	'branches-agree':
		'Point the workflow template at one push branch and the publisher default in `infra/variables.tf` at another.',
	described: 'Delete the `description` from any variable or output block.',
	'document-declared':
		'Delete a whole `aws_iam_policy_document` block that `POLICY_DOCUMENT_SIDS` names.',
	'document-in-table':
		'Declare an `aws_iam_policy_document` under `infra/` that `POLICY_DOCUMENT_SIDS` does not name.',
	'document-sids': 'Delete one `sid` from a policy document, or swap two of them over.',
	'native-json':
		'Add an `infra/*.tf.json`, which terraform loads as configuration and every scan in this row reads past.',
	'no-destructive-lifecycle':
		'Add an `expiration` or a `transition`, in a plain lifecycle rule or inside a `dynamic` block.',
	'no-if-exists':
		'Change a trust policy condition operator in `infra/publishers.tf` to its `...IfExists` spelling.',
	'not-tracked':
		'Force-add a tfvars, a state file, a saved plan or anything under a `.terraform` directory to the index.',
	'outputs-parsed':
		'Break the top-level block parse for `output`, so the row reads zero outputs and asserts nothing about any of them.',
	'prevent-destroy': 'Remove `prevent_destroy = true` from the bucket or from the OIDC provider.',
	'protected-resource-count':
		'Declare a second `aws_s3_bucket`, or delete the one there is, so the prevent_destroy assertion has nothing to attach to.',
	'publishers-present':
		'Delete `infra/publishers.tf`, which is the only file the IfExists scan reads.',
	'sid-claimed-by-test':
		'Delete a Sid literal from `infra/tests/policies.tftest.hcl` so no test names that statement anywhere.',
	'sid-declared': 'Name a statement in the test file that no policy document declares.',
	'test-asserted-in-table':
		'Add a name to `TEST_ASSERTED_DOCUMENTS` that `POLICY_DOCUMENT_SIDS` has no entry for.',
	'test-sources-exist': 'Delete every `.tftest.hcl` under `infra/`.',
	'trust-one-branch':
		'Declare a second `branch = optional(string, ...)` default in `infra/variables.tf`.',
	'variables-parsed':
		'Break the top-level block parse for `variable`, so the row reads zero variables and asserts nothing about any of them.',
	'workflow-one-branch':
		"Give the workflow template's push trigger a second entry in its `branches` list.",
};

/**
 * The arms whose claim above is driven by a case in this file rather than only written down.
 *
 * Each has a case below that performs its mutation against a throwaway copy of the stack and
 * asserts that the invariants row goes red naming what changed. Most go through `soleFailure`,
 * which says as well that no other row moved; the unclosed block and the two directions of the
 * statement scan do not, because each of those mutations also changes what terraform itself
 * says about the file it edits, and those three cases run with no terraform on PATH for that
 * reason.
 *
 * The list is checked against `ARM_CLAIMS`, so a rename cannot leave it naming nothing. What
 * nothing checks is the other direction: an arm that is driven and missing from here reads as
 * undriven, which understates the coverage rather than overstating it.
 */
const DRIVEN_ARMS = [
	'blocks-closed',
	'branches-agree',
	'described',
	'document-in-table',
	'document-sids',
	'native-json',
	'no-destructive-lifecycle',
	'not-tracked',
	'sid-claimed-by-test',
	'sid-declared',
];

describe('against this repository', () => {
	test('the rows are named in order and the invariants row passes with no binary needed', () => {
		const rows = runInfra() as CheckResult[];
		expect(rows.map((row) => row.name)).toEqual(ROW_NAMES);

		const invariants = rows[0] as InvariantsRow;
		expect(invariants.state, problemsOf(invariants)).toBe('PASS');
		// The count is assertions evaluated, not files read, and it is deliberately no longer
		// what this suite holds the row to. `ARM_CLAIMS` is. What the number is still worth
		// saying is that every arm was evaluated at least once, which is what says no id
		// reached the list without an assertion behind it.
		expect(invariants.examined).toBeGreaterThanOrEqual(invariants.arms.length);
		expect(invariants.unit).toBe('assertions');
		expect(invariants.note ?? '').toContain('.tf files');
	}, 120_000);

	test('every assertion the row evaluated is claimed, and every claim names one it still has', () => {
		const invariants = (runInfra() as CheckResult[])[0] as InvariantsRow;
		const evaluated = [...new Set(invariants.arms)].sort();

		// Two directional comparisons rather than one equality over the sets. An equality prints
		// two long arrays and leaves the reader to diff them; these name the arm and say which
		// side of the pair went missing.
		expect(
			evaluated.filter((id) => !(id in ARM_CLAIMS)),
			'stackInvariants evaluated an assertion that ARM_CLAIMS does not claim',
		).toEqual([]);
		expect(
			Object.keys(ARM_CLAIMS).filter((id) => !evaluated.includes(id)),
			'ARM_CLAIMS claims an assertion stackInvariants no longer evaluates',
		).toEqual([]);
		expect(
			DRIVEN_ARMS.filter((id) => !(id in ARM_CLAIMS)),
			'DRIVEN_ARMS names an arm the table does not',
		).toEqual([]);
	}, 120_000);

	test.skipIf(!INITIALISED)(
		'every row passes and reports what it examined',
		() => {
			const rows = runInfra() as CheckResult[];
			for (const row of rows) {
				expect(row.state, `${row.name}: ${problemsOf(row)}`).toBe('PASS');
				// Every row measures rather than asserts. A row that examined nothing is already a
				// failure by `check`'s own coercion, so this is about the guard counting the right
				// thing rather than about the count being non-zero.
				expect(row.examined, row.name).toBeGreaterThan(0);
			}
			const rows_ = rowsBy(rows);
			expect(rows_.get('terraform test')?.examined).toBe(declaredRunBlocks());
		},
		120_000,
	);
});

describe('when a lifecycle rule that deletes things is planted', () => {
	/**
	 * A whole resource rather than a stray line, and written the way an author would write it.
	 *
	 * It is `terraform fmt` clean and it validates, which is the point: S3 Lifecycle is the one
	 * mechanism that ignores the bucket policy, so this is an edit that empties a write-once
	 * store while every other row in the report stays green. If the scan were not there,
	 * nothing in this repository would have an opinion about it.
	 */
	const PLANTED = `
resource "aws_s3_bucket_lifecycle_configuration" "planted_by_a_test" {
  bucket = "planted-by-a-test"

  rule {
    id     = "planted"
    status = "Enabled"

    filter {}

    expiration {
      days = 30
    }
  }
}
`;

	/**
	 * The same rule, written the way an author reaches for when it is conditional.
	 *
	 * `dynamic` writes the block name as a quoted label after a keyword, so the name is not the
	 * first token on its line and a scan anchored at the start of the line never sees it. This
	 * configuration is fmt clean and it validates, and before the pattern carried this spelling
	 * it gave four PASS rows. Made conditional on a variable is the commonest reason to reach
	 * for `dynamic` at all, so this is the ordinary way an expiration arrives rather than a way
	 * of hiding one.
	 */
	const PLANTED_DYNAMIC = `
resource "aws_s3_bucket_lifecycle_configuration" "planted_by_a_test_dynamically" {
  bucket = "planted-by-a-test"

  rule {
    id     = "planted"
    status = "Enabled"

    filter {}

    dynamic "expiration" {
      for_each = [1]

      content {
        days = 30
      }
    }
  }
}
`;

	/**
	 * And the same rule again, in terraform's JSON syntax.
	 *
	 * Terraform reads a `.tf.json` as native configuration and every scan in the invariants row
	 * reads HCL, so before the refusal existed this planted an expiration rule that four PASS
	 * rows had no opinion about, with the validate row's resource count short by one. It is not
	 * a format target either, which is why the refusal is in the invariants row rather than in
	 * `FMT_EXTENSIONS`: `terraform fmt` does not format JSON.
	 */
	const PLANTED_JSON = `{
  "resource": {
    "aws_s3_bucket_lifecycle_configuration": {
      "planted_by_a_test_in_json": {
        "bucket": "planted-by-a-test",
        "rule": {
          "id": "planted",
          "status": "Enabled",
          "filter": {},
          "expiration": { "days": 30 }
        }
      }
    }
  }
}
`;

	test('the invariants row names the file and the line, and no other row moves', () => {
		const root = copyStack({
			mutate: (where) => edit(where, 'infra/bucket.tf', (text) => `${text}${PLANTED}`),
		});

		const row = soleFailure(runInfra(root) as CheckResult[], 'stack invariants');
		expect(problemsOf(row)).toContain('infra/bucket.tf:');
		expect(problemsOf(row)).toContain('declares expiration');
	}, 120_000);

	test('a dynamic block is the same rule and the same row', () => {
		const root = copyStack({
			mutate: (where) => edit(where, 'infra/bucket.tf', (text) => `${text}${PLANTED_DYNAMIC}`),
		});

		const row = soleFailure(runInfra(root) as CheckResult[], 'stack invariants');
		expect(problemsOf(row)).toContain('infra/bucket.tf:');
		// The capture group is the block name rather than the whole line, so the sentence reads
		// the same for both spellings and names the action rather than the syntax.
		expect(problemsOf(row)).toContain('declares expiration');
	}, 120_000);

	test('the same rule in JSON syntax is refused rather than read', () => {
		const root = copyStack({
			mutate: (where) =>
				writeFileSync(join(where, 'infra', 'planted.tf.json'), PLANTED_JSON, 'utf8'),
		});

		const row = soleFailure(runInfra(root) as CheckResult[], 'stack invariants');
		expect(problemsOf(row)).toContain('infra/planted.tf.json');
		expect(problemsOf(row)).toContain('JSON syntax');
		// Not the lifecycle sentence. The refusal is that nothing here can read the file at all,
		// which is a wider claim than the one construct this case happens to plant in it.
		expect(problemsOf(row)).not.toContain('declares expiration');
	}, 120_000);
});

describe('when a variable loses its description', () => {
	// Rewritten as a block rather than deleted as a line. `terraform fmt` aligns the `=` signs
	// of consecutive arguments, so removing the longest key on its own leaves the other three
	// aligned to a width that no longer exists and the fmt row goes red as well. What is under
	// test is the invariants row, and a case that reddens two says nothing about either.
	const WITH = `variable "region" {
  description = "The region the bundle store lives in."
  type        = string
  default     = "ap-southeast-2"
  nullable    = false
}`;
	const WITHOUT = `variable "region" {
  type     = string
  default  = "ap-southeast-2"
  nullable = false
}`;

	test('the invariants row names the variable', () => {
		const root = copyStack({
			mutate: (where) => edit(where, 'infra/variables.tf', (text) => text.replace(WITH, WITHOUT)),
		});

		const row = soleFailure(runInfra(root) as CheckResult[], 'stack invariants');
		expect(problemsOf(row)).toContain('infra/variables.tf:');
		expect(problemsOf(row)).toContain('"region"');
		expect(problemsOf(row)).toContain('no description');
	}, 120_000);
});

describe('when a top-level block is never closed', () => {
	/**
	 * An indented closing brace rather than a missing one, because only the first is a state
	 * terraform itself accepts. A block with no brace at all is a parse error, so `fmt`,
	 * `validate` and `test` are all red and the invariants row's own behaviour is invisible
	 * underneath them. Indented, terraform reads the file happily and only `terraform fmt`
	 * has an opinion, which is why this runs with no terraform on PATH: that is the machine
	 * where this row is the only one running, and it is the machine the hole was dangerous on.
	 */
	const CLOSED = `variable "region" {
  description = "The region the bundle store lives in."
  type        = string
  default     = "ap-southeast-2"
  nullable    = false
}`;
	const MIS_CLOSED = `variable "region" {
  description = "The region the bundle store lives in."
  type        = string
  default     = "ap-southeast-2"
  nullable    = false
  }`;

	test('the row names it, and the blocks below it are still asserted about', () => {
		const pristine = copyStack();
		const mutated = copyStack({
			mutate: (where) =>
				edit(where, 'infra/variables.tf', (text) => text.replace(CLOSED, MIS_CLOSED)),
		});

		const [before, after] = withoutTerraform(undefined, () => [
			rowsBy(runInfra(pristine) as CheckResult[]).get('stack invariants') as CheckResult,
			rowsBy(runInfra(mutated) as CheckResult[]).get('stack invariants') as CheckResult,
		]);

		expect(problemsOf(after)).toContain('infra/variables.tf:');
		expect(problemsOf(after)).toContain('"region"');
		expect(problemsOf(after)).toContain('no closing brace at column 0');

		// The half that is not the message, and the half a body scan bounded only by the closing
		// brace got wrong. Without the second bound the mis-closed block swallows the rest of the
		// file: it passes its own assertions on a later block's description, every block below it
		// is skipped, and the count silently shrinks while the row stays green. Comparing against
		// the same fixture unmutated is what says nothing was dropped, without pinning a literal
		// that a seventh variable would falsify.
		expect(after.examined).toBe(before.examined);
	}, 120_000);
});

describe('when a policy document says something other than what the guard expects', () => {
	/**
	 * The reader document, which nothing else in the repository has an opinion about.
	 *
	 * It creates no resource and is attached to nothing, so there is no plan diff to read and
	 * `infra/tests/policies.tftest.hcl` never names it. Until it was added to the guard's table
	 * this whole statement could be deleted with four PASS rows, and `infra/reader.tf` says
	 * outright that the document exists to become a real policy later.
	 */
	const READ_BUNDLES = `
  statement {
    sid       = "ReadBundles"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = [local.objects_arn]
  }
`;

	/** A fifth document, which the one-directional loop over the table could not see. */
	const PLANTED_DOCUMENT = `
data "aws_iam_policy_document" "planted_by_a_test" {
  statement {
    sid       = "PlantedByATest"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = [local.objects_arn]
  }
}
`;

	test('a statement deleted from the reader document is named', () => {
		const root = copyStack({
			mutate: (where) => edit(where, 'infra/reader.tf', (text) => text.replace(READ_BUNDLES, '')),
		});

		const row = soleFailure(runInfra(root) as CheckResult[], 'stack invariants');
		expect(problemsOf(row)).toContain('aws_iam_policy_document."reader"');
		expect(problemsOf(row)).toContain('ReadBundles');
	}, 120_000);

	test('a document the table does not name is named, rather than being uncovered in silence', () => {
		const root = copyStack({
			mutate: (where) => edit(where, 'infra/reader.tf', (text) => `${text}${PLANTED_DOCUMENT}`),
		});

		const row = soleFailure(runInfra(root) as CheckResult[], 'stack invariants');
		expect(problemsOf(row)).toContain('aws_iam_policy_document."planted_by_a_test"');
		expect(problemsOf(row)).toContain('POLICY_DOCUMENT_SIDS');
	}, 120_000);

	/**
	 * The reverse direction, on the one statement it could not see.
	 *
	 * The scan reads Sid-shaped names out of the test text and asks whether any document is
	 * expected to declare them. Its pattern took `Deny...` and anything carrying `Own` or
	 * `GitHub` after a leading capital, and the trust policy's Sid begins with the word, so the
	 * one statement in the stack that grants rather than denies was outside it: a test asserting
	 * about a renamed or misspelled version of it passed forever.
	 *
	 * With no terraform, because this mutation also breaks the run block it edits and the point
	 * is what the text-level scan says about it.
	 */
	test('a test naming a statement no document declares is named', () => {
		const root = copyStack({
			mutate: (where) =>
				edit(where, TEST_FILE, (text) =>
					text.replaceAll(
						'"GitHubActionsOnOneBranchOfOneRepository"',
						'"GitHubActionsOnAnyBranch"',
					),
				),
		});

		const rows = withoutTerraform(undefined, () => rowsBy(runInfra(root) as CheckResult[]));
		const row = rows.get('stack invariants');
		expect(row?.state).toBe('FAIL');
		// Both directions fire, and they say different things. One is a statement no test
		// mentions any more; the other is a test asserting about a statement that does not exist.
		expect(problemsOf(row)).toContain('No test names the statement');
		expect(problemsOf(row)).toContain('A test names the statement "GitHubActionsOnAnyBranch"');
	}, 120_000);
});

describe('when the workflow and the trust policy disagree about the branch', () => {
	/**
	 * The template is the side that moves, and the asymmetry is deliberate.
	 *
	 * Changing the default in `infra/variables.tf` would make the two disagree just as well,
	 * and it would also change what `terraform test` asserts about `refs/heads/main`, so that
	 * row would go red for a second reason and the case would stop being about one thing. The
	 * assertion reads both sides, so mutating either proves it is not comparing against a hard
	 * coded "main".
	 */
	test('the invariants row names both files and both branches', () => {
		const root = copyStack({
			mutate: (where) =>
				edit(where, WORKFLOW_TEMPLATE, (text) =>
					text.replace("'    branches: [main]',", "'    branches: [release]',"),
				),
		});

		const row = soleFailure(runInfra(root) as CheckResult[], 'stack invariants');
		expect(problemsOf(row)).toContain(WORKFLOW_TEMPLATE);
		expect(problemsOf(row)).toContain('infra/variables.tf');
		expect(problemsOf(row)).toContain('"release"');
		expect(problemsOf(row)).toContain('"main"');
	}, 120_000);

	test('a template that cannot be read is three problems rather than a dropped comparison', () => {
		const root = copyStack({
			mutate: (where) => rmSync(join(where, WORKFLOW_TEMPLATE)),
		});

		const row = soleFailure(runInfra(root) as CheckResult[], 'stack invariants');
		const problems = row.problems ?? [];
		// The read failure, the branch count and the comparison, each said separately. A guard
		// that swallowed the missing file and compared nothing against nothing would print a
		// green row for a repository whose publish workflow no longer exists.
		expect(problems.length).toBe(3);
		expect(problemsOf(row)).toContain('could not be read');
		expect(problemsOf(row)).toContain('names 0 push branches');
	}, 120_000);
});

describe('when a tfvars is tracked under infra', () => {
	test('the invariants row names the file and says what it leaks', () => {
		const root = copyStack();
		// Written after the index exists and added with `-f`, because that is the only way this
		// file arrives: `infra/*.tfvars` is in `.gitignore`, so a tracked one is either a forced
		// add or a file that predates the rule. Nothing about the ignore rules would catch it.
		//
		// `planted.tfvars` and not `planted.auto.tfvars`. Terraform loads an `.auto.tfvars`
		// automatically, and a value for an undeclared variable is a validate warning, which the
		// validate row fails on: the case would then redden two rows and prove neither.
		writeFileSync(
			join(root, 'infra', 'planted.tfvars'),
			'bucket_name = "planted-by-a-test"\n',
			'utf8',
		);
		fixtureGit(root, 'add', '-f', 'infra/planted.tfvars');

		const rows = runInfra(root) as CheckResult[];
		const row = soleFailure(rows, 'stack invariants');
		expect(problemsOf(row)).toContain('infra/planted.tfvars');
		expect(problemsOf(row)).toContain('variable definitions file');
		// The fmt row counted it too, which is what says the walk and the git listing agree
		// about what a formattable file is rather than each having its own idea.
		expect(rowsBy(rows).get('terraform fmt')?.note ?? '').toContain('11 tracked by git');
	}, 120_000);
});

describe('when infra holds no configuration at all', () => {
	test('the invariants row refuses rather than passing on an empty walk', () => {
		const root = copyStack({
			mutate: (where) => {
				for (const name of ['bucket-policy.tf', 'bucket.tf', 'oidc.tf', 'outputs.tf']) {
					rmSync(join(where, 'infra', name));
				}
				for (const name of ['providers.tf', 'publishers.tf', 'reader.tf', 'variables.tf']) {
					rmSync(join(where, 'infra', name));
				}
				rmSync(join(where, 'infra', 'versions.tf'));
				rmSync(join(where, TEST_FILE));
			},
		});

		// Not `soleFailure`. Every other row examined nothing either, and `check` converts a
		// passing row with a count of zero into a failure, so the whole report is red. That is
		// the rule working rather than a mutation with a wide blast radius, and asserting one
		// red row here would be asserting the opposite of what the ladder is for.
		const rows = rowsBy(runInfra(root) as CheckResult[]);
		const row = rows.get('stack invariants');
		expect(row?.state).toBe('FAIL');
		expect(row?.examined).toBe(0);
		expect(problemsOf(row)).toContain('holds no .tf file');
	}, 120_000);

	test('and an infra/ with nothing in it at all is a red report that examined nothing', () => {
		// The case above empties the configuration and leaves the directory populated, which is
		// the shape a bad merge produces. This is the other one, and it is the state the
		// `terraform` step in `scripts/verify.mjs` names in the note explaining why that step
		// carries no `allowZero`: "the only way this step can reach zero is a checkout with
		// nothing under `infra/`, and `stackInvariants` answers that with a FAIL rather than an
		// empty pass". Nothing pinned it, so putting `allowZero: true` back on that step passed
		// the suite, and the flag would have converted the one state the note is about into a
		// green row.
		//
		// `providerCache: false` because a symlinked provider cache in an otherwise empty
		// directory is a state no checkout produces, and because it keeps the two rows that
		// would spawn terraform over an empty configuration out of the answer.
		const root = copyStack({
			mutate: (where) => {
				rmSync(join(where, 'infra'), { recursive: true });
				mkdirSync(join(where, 'infra'));
			},
			providerCache: false,
		});

		const rows = runInfra(root) as CheckResult[];
		// Both halves of the claim. The report examines nothing, so `countExamined` reads 0 out
		// of the guard's output and the ladder's own zero rule is what would have to catch it;
		// and no row is PASS, so the guard exits 1 and the ladder row is built from the exit
		// code before the count is consulted at all. Either one alone would leave the note half
		// true.
		expect(rows.reduce((total, row) => total + row.examined, 0)).toBe(0);
		expect(rows.filter((row) => row.state === 'PASS').map((row) => row.name)).toEqual([]);
		const invariants = rows[0] as CheckResult;
		expect(invariants.state).toBe('FAIL');
		expect(problemsOf(invariants)).toContain('holds no .tf file');
	}, 120_000);
});

describe('when git cannot answer', () => {
	test('the invariants row says so rather than dropping four assertions in silence', () => {
		const root = copyStack({ git: false });

		const rows = rowsBy(runInfra(root) as CheckResult[]);
		const row = rows.get('stack invariants');
		expect(row?.state).toBe('FAIL');
		// A problem rather than a quieter count. Four of this row's assertions are the ones
		// that keep a tfvars, a state file and the provider cache out of a public repository,
		// and a report that simply stopped making them would look exactly like a report that
		// made them and found nothing.
		expect(problemsOf(row)).toContain('git ls-files');
		expect(problemsOf(row)).toContain('public repository');
	}, 120_000);

	test.skipIf(!INITIALISED)(
		'and so does the fmt row, whose cross-check reads the same listing',
		() => {
			const root = copyStack({ git: false });

			const rows = rowsBy(runInfra(root) as CheckResult[]);
			const fmt = rows.get('terraform fmt');
			expect(fmt?.state).toBe('FAIL');
			expect(problemsOf(fmt)).toContain('compared against nothing');
			// The disk walk still ran and still counted, which is what says the two halves of the
			// row are independent: fmt itself had an opinion and only the cross-check went dark.
			expect(fmt?.examined).toBeGreaterThan(0);
			expect(rows.get('terraform validate')?.state).toBe('PASS');
			expect(rows.get('terraform test')?.state).toBe('PASS');
		},
		120_000,
	);
});

describe.skipIf(!INITIALISED)('the rows that need the binary', () => {
	test('a misformatted file reddens fmt and nothing else', () => {
		// `versions.tf` carries no variable, output, resource or data block, so an indentation
		// change there cannot reach the invariants row's parser by accident. What is under test
		// is that fmt has an opinion at all, and the narrowest file is the one that says so.
		const root = copyStack({
			mutate: (where) =>
				edit(where, 'infra/versions.tf', (text) =>
					text.replace('\n  required_version = ', '\n      required_version = '),
				),
		});

		const row = soleFailure(runInfra(root) as CheckResult[], 'terraform fmt');
		expect(problemsOf(row)).toContain('infra/versions.tf is not terraform fmt clean');
		expect(problemsOf(row)).toContain('fmt -recursive');
		// The count is files on disk, not files fmt complained about. A row reporting one would
		// be reporting the size of its own problem list.
		expect(row.examined).toBeGreaterThan(1);
	}, 120_000);

	test('a file git neither tracks nor ignores reddens fmt and nothing else', () => {
		const root = copyStack();
		// Written after the index is built, which is the state a branch leaves behind when one
		// side adds a file and the other checks out without it. CI plans what git tracks, so a
		// configuration file only on the laptop is a stack that is valid in one place and
		// something else in the other, and no terraform command has an opinion about it.
		writeFileSync(
			join(root, 'infra', 'extra.tf'),
			'output "planted_by_a_test" {\n' +
				'  description = "An output added after the index was built."\n' +
				'  value       = var.region\n' +
				'}\n',
			'utf8',
		);

		const row = soleFailure(runInfra(root) as CheckResult[], 'terraform fmt');
		expect(problemsOf(row)).toContain('infra/extra.tf is on disk and git neither tracks nor');
	}, 120_000);

	test('a file terraform cannot parse is reported as an error, not as a formatting difference', () => {
		// The distinction the fmt row's status handling exists for. `terraform fmt -check`
		// reserves 3 for "these files would change" and reports a parse failure with a different
		// status, so a guard treating any non-zero status as a formatting problem would print
		// "run terraform fmt" at somebody whose file does not parse. Measured here: this exits 2,
		// which is neither 0 nor 3, and the row says which of the two it was.
		const root = copyStack({
			mutate: (where) =>
				edit(
					where,
					'infra/reader.tf',
					(text) => `${text}\nresource "aws_iam_policy" "planted_by_a_test" {\n`,
				),
		});

		const rows = rowsBy(runInfra(root) as CheckResult[]);
		const fmt = rows.get('terraform fmt');
		expect(fmt?.state).toBe('FAIL');
		expect(problemsOf(fmt)).toContain('is an error rather than a formatting difference');
		expect(problemsOf(fmt)).toContain('no closing brace');

		// The test row's other arm, reached by the same break: terraform aborts before running
		// anything and prints no summary at all, so there is no pair of numbers to compare and
		// the row says that rather than reporting a clean run of nothing.
		const testRow = rows.get('terraform test');
		expect(testRow?.state).toBe('FAIL');
		expect(problemsOf(testRow)).toContain('printed no "N passed, N failed" summary');
		expect(rows.get('terraform validate')?.state).toBe('FAIL');
	}, 120_000);

	/**
	 * A reference to a resource nobody declared, which parses and does not resolve.
	 *
	 * A syntax error would be the obvious mutation and it is the wrong one, and the case above
	 * is what measures why: `terraform fmt` reports a file it cannot parse, so the fmt row goes
	 * red too and neither row is then saying anything about the other. This is fmt clean, it is
	 * a plausible edit, and only validate has an opinion about it.
	 */
	const INVALID = `
output "planted_by_a_test" {
  description = "Names a resource that does not exist, so terraform validate refuses it."
  value       = aws_s3_bucket.no_such_bucket.arn
}
`;

	test('an invalid configuration reddens validate, with the diagnostic and the line', () => {
		const root = copyStack({
			mutate: (where) => edit(where, 'infra/outputs.tf', (text) => `${text}${INVALID}`),
		});

		const rows = rowsBy(runInfra(root) as CheckResult[]);
		const validate = rows.get('terraform validate');
		expect(validate?.state).toBe('FAIL');
		expect(problemsOf(validate)).toContain('reports the configuration invalid');
		expect(problemsOf(validate)).toContain('outputs.tf:');
		expect(problemsOf(validate)).toContain('no_such_bucket');
		// The count is resource blocks read off the source rather than anything the command
		// printed, so it survives a run that produced nothing but diagnostics.
		expect(validate?.examined).toBeGreaterThan(0);

		// Not a sole failure, and this is worth naming rather than absorbing: `terraform test`
		// plans the same configuration, so it is red for the same cause. The two rows that stay
		// green are the two that read the files as text.
		expect(rows.get('terraform test')?.state).toBe('FAIL');
		expect(rows.get('stack invariants')?.state).toBe('PASS');
		expect(rows.get('terraform fmt')?.state).toBe('PASS');
	}, 120_000);

	test('a test file terraform stops collecting reddens the count cross-check', () => {
		// `terraform test` reads `tests/` and the stack root, and does not recurse. `walkInfra`
		// does recurse, so this is the state the two numbers exist to tell apart: the file is
		// present, tracked, formatted and full of run blocks, and none of them runs.
		const root = copyStack({
			mutate: (where) => {
				mkdirSync(join(where, 'infra', 'tests', 'nested'));
				renameSync(
					join(where, TEST_FILE),
					join(where, 'infra', 'tests', 'nested', 'policies.tftest.hcl'),
				);
			},
		});

		const row = soleFailure(runInfra(root) as CheckResult[], 'terraform test');
		// Terraform's own verdict was success. It printed "Success! 0 passed, 0 failed." and
		// exited 0, so a row that trusted the exit code, or that counted only what the command
		// reported, would be green here with every policy assertion in the stack unrun.
		expect(problemsOf(row)).toContain(`${declaredRunBlocks()} are declared`);
		expect(problemsOf(row)).toContain('nested/policies.tftest.hcl');
		expect(row.examined).toBe(0);
	}, 120_000);

	/**
	 * The case the row's own header claims and does not deliver.
	 *
	 * `terraformTest`'s comment reads "The number of run blocks that passed is compared against
	 * the number declared on disk, so a deleted test lowers nothing silently". Both numbers come
	 * off the same file. Deleting a run block lowers them together, they still match, and the row
	 * reports one fewer and stays green. A smaller count is not a failing count, which is the
	 * lesson `pnpm verify`'s typecheck row already carries from the other direction.
	 *
	 * This is measured rather than argued, and it is left as an assertion rather than repaired
	 * here, because repairing it is a change to the guard and this file is a test. What the
	 * cross-check does catch is the case above: a file the walk finds and terraform does not
	 * collect. That is real and it is not what the comment says.
	 */
	test('a deleted run block is not caught, which is a hole in that cross-check', () => {
		const root = copyStack({
			mutate: (where) =>
				edit(where, TEST_FILE, (text) => {
					const at = text.lastIndexOf('\nrun "');
					return `${text.slice(0, at).trimEnd()}\n`;
				}),
		});

		const rows = rowsBy(runInfra(root) as CheckResult[]);
		const row = rows.get('terraform test');
		expect(row?.state).toBe('PASS');
		expect(row?.examined).toBe(declaredRunBlocks() - 1);
		expect(row?.note ?? '').toContain(`${declaredRunBlocks() - 1} declared`);
	}, 120_000);
});

describe.skipIf(TERRAFORM === undefined)('when the stack has never been initialised', () => {
	test('validate and test are NOT RUN, which fails the run rather than skipping it', () => {
		const root = copyStack({ providerCache: false });

		const rows = rowsBy(runInfra(root) as CheckResult[]);
		// Not SKIPPED. The configuration might be perfect and nothing here knows, because both
		// commands refuse without a provider. NOT RUN is the state that fails the run, and it is
		// right: an uninitialised checkout is something to fix before the stack is checked at
		// all. This guard also never runs the `init` itself, which is what keeps it from
		// downloading a provider on a machine that did not ask for one.
		for (const name of ['terraform validate', 'terraform test']) {
			const row = rows.get(name);
			expect(row?.state, name).toBe('NOT RUN');
			expect(row?.note ?? '', name).toContain('init -backend=false');
			expect(row?.examined, name).toBe(0);
		}
		// The two rows that need no provider still ran, which is the whole reason the first row
		// is plain JavaScript and the fmt row needs no init.
		expect(rows.get('stack invariants')?.state).toBe('PASS');
		expect(rows.get('terraform fmt')?.state).toBe('PASS');
	}, 120_000);
});

describe('when there is no terraform', () => {
	test('the three rows that need it are skipped and the invariants row still runs', () => {
		const rows = withoutTerraform(undefined, () => rowsBy(runInfra() as CheckResult[]));

		const invariants = rows.get('stack invariants');
		expect(invariants?.state, problemsOf(invariants)).toBe('PASS');
		// The reason the first row is plain JavaScript. If all four could skip, a machine with no
		// binary would get a report in which nothing ran, and a run of nothing but SKIPPED rows
		// exits 0.
		expect(invariants?.examined).toBeGreaterThan(0);

		for (const name of ['terraform fmt', 'terraform validate', 'terraform test']) {
			const row = rows.get(name);
			expect(row?.state, name).toBe('SKIPPED');
			// A skip carries its reason in the note rather than in a problem, which is the
			// difference between the two states: a problem is something to fix.
			expect(row?.note ?? '', name).toContain('HEXDOCS_TERRAFORM');
			expect(row?.problems ?? [], name).toEqual([]);
		}
	}, 120_000);

	test('the same state in CI is a failure, because the workflow installs it', () => {
		const rows = withoutTerraform('true', () => rowsBy(runInfra() as CheckResult[]));

		expect(rows.get('stack invariants')?.state).toBe('PASS');
		for (const name of ['terraform fmt', 'terraform validate', 'terraform test']) {
			const row = rows.get(name);
			expect(row?.state, name).toBe('FAIL');
			expect((row?.problems ?? [])[0] ?? '', name).toContain('broken environment');
		}
	}, 120_000);
});

describe('the applied stack, with nothing applied', () => {
	test('a stack with no outputs is one NOT RUN row rather than four bad ones', () => {
		const root = mkdtempSync(join(tmpdir(), 'hexdocs-stack-'));
		temporaries.push(root);
		mkdirSync(join(root, 'infra'));

		// One row, and it is NOT RUN. Without the outputs this script does not know the bucket,
		// the roles or the prefixes, so it has no verdict to give: `scripts/check-cli.mjs`
		// collapses the same way when its catalogue is missing.
		const rows = runStack(root) as CheckResult[];
		expect(rows.length).toBe(1);
		expect(rows[0]?.name).toBe('applied stack');
		expect(rows[0]?.state).toBe('NOT RUN');
		expect(rows[0]?.note ?? '').toContain('has not been applied');
		expect(rows[0]?.note ?? '').toContain('terraform -chdir=infra apply');
	}, 120_000);

	test('a copy that has never been initialised is the same one row', () => {
		// The other arm: terraform exits non-zero rather than printing an empty output set. The
		// backend is declared and there is no `.terraform`, so terraform refuses before it reads
		// any state, which is what keeps this case away from the network as well as from AWS.
		const root = copyStack({ providerCache: false });

		const rows = runStack(root) as CheckResult[];
		expect(rows.length).toBe(1);
		expect(rows[0]?.state).toBe('NOT RUN');
		expect(rows[0]?.note ?? '').toContain('terraform -chdir=infra apply');
	}, 120_000);

	test('and with no terraform at all it names the tool rather than throwing', () => {
		const root = copyStack({ providerCache: false });

		const rows = withoutTerraform(undefined, () => runStack(root) as CheckResult[]);
		expect(rows.length).toBe(1);
		expect(rows[0]?.state).toBe('NOT RUN');
		// NOT RUN and not SKIPPED. A missing binary here is not the same absence as a missing
		// profile: the check should have run, and the fix is to install terraform and apply the
		// stack. The credentials branch is the one that skips, and nothing in this suite can
		// reach it without an account.
		expect(rows[0]?.note ?? '').toContain('terraform could not be started');
	}, 120_000);
});

/**
 * A PATH holding one terraform, which fails with the stderr the case is about.
 *
 * The fourth reachable state of `check-stack.mjs` is a terraform that started and exited
 * non-zero for a reason that is not an unapplied stack, and against the s3 backend that is a
 * failed state read. There is no way to reach it from a real terraform without an account to
 * be refused by, so the binary is the fixture. It is a shell script writing a quoted heredoc,
 * so the shell expands nothing and the stderr is data.
 *
 * `root` is a bare directory with an `infra/` in it, because `spawnSync` needs a cwd that
 * exists and the fake reads no arguments at all.
 *
 * The directory is prepended to the PATH rather than replacing it, which is the opposite of
 * what `withoutTerraform` above does and is right for the opposite reason: the fake is a shell
 * script, so the shell needs to find its own utilities to run it. Being first is what makes it
 * win over a real terraform.
 */
function withFailingTerraform<T>(stderr: string, body: (root: string) => T): T {
	const bin = mkdtempSync(join(tmpdir(), 'hexdocs-tf-'));
	temporaries.push(bin);
	writeFileSync(
		join(bin, 'terraform'),
		`#!/bin/sh\ncat >&2 <<'STDERR'\n${stderr}\nSTDERR\nexit 1\n`,
		{
			mode: 0o755,
		},
	);

	const root = mkdtempSync(join(tmpdir(), 'hexdocs-stack-'));
	temporaries.push(root);
	mkdirSync(join(root, 'infra'));

	const saved = process.env.PATH;
	process.env.PATH = [bin, saved]
		.filter((entry) => entry !== undefined && entry !== '')
		.join(delimiter);
	try {
		return body(root);
	} finally {
		if (saved === undefined) delete process.env.PATH;
		else process.env.PATH = saved;
	}
}

describe('the applied stack, when reading the outputs is what failed', () => {
	// A separate name from the bundle store's, and that is the point of it. The state bucket
	// arrives through `-backend-config` at init, so it is in no output and nowhere in this
	// repository, and `check-stack.mjs` never learns it.
	const STATE_BUCKET = 'hexdocs-state-fixture';

	// Built at call time rather than at collection time, because the identifiers below the
	// divider are not initialised while this file is still being read.
	const backend403 = () =>
		[
			`Error: Unable to list objects in S3 bucket "${STATE_BUCKET}" with prefix "env:/"`,
			'',
			`api error AccessDenied: User: arn:aws:iam::${ACCOUNT}:root is not authorized to perform`,
			`s3:ListBucket on resource: "arn:aws:s3:::${STATE_BUCKET}" in account ${ACCOUNT}`,
		].join('\n');

	test('the account and the ARNs are taken out of the row, by shape', () => {
		// `redact` cannot exist on this path: `check-stack.mjs` builds it out of the outputs and
		// reading the outputs is what failed. None of that is visible to whoever pastes the row
		// into an issue, so the guarantee has to hold anyway, and this is the only path in the
		// file where it is held by shape rather than by value.
		const rows = withFailingTerraform(backend403(), (root) => runStack(root) as CheckResult[]);

		expect(rows.length).toBe(1);
		expect(rows[0]?.state).toBe('NOT RUN');
		const note = rows[0]?.note ?? '';
		expect(note).not.toContain(ACCOUNT);
		expect(note).not.toContain('arn:aws');
		expect(note).toContain('terraform -chdir=infra apply');
	}, 120_000);

	test('and the state bucket survives, which is what the header says it costs', () => {
		// Pinned rather than left as prose. A name has no shape and this one is not a value this
		// script can hold, so the honest thing is to say so where an operator reads it. If it ever
		// stops being true, the paragraph in `scripts/check-stack.mjs` changes with this line.
		const rows = withFailingTerraform(backend403(), (root) => runStack(root) as CheckResult[]);

		expect(rows[0]?.note ?? '').toContain(STATE_BUCKET);
	}, 120_000);

	test('a profile that is named and is not in the config is SKIPPED, not NOT RUN', () => {
		// The two tools spell this differently and only the AWS CLI's spelling was covered, so the
		// same typo skipped when the CLI met it and failed when terraform met it first, with a
		// remedy telling the operator to apply a stack that is already applied.
		const rows = withFailingTerraform(
			'Error: failed to get shared config profile, review-no-such-profile',
			(root) => runStack(root) as CheckResult[],
		);

		expect(rows.map((row) => row.state)).toEqual(['SKIPPED', 'SKIPPED', 'SKIPPED', 'SKIPPED']);
		expect(rows[0]?.note ?? '').toContain('no AWS credentials in scope');
		expect(rows[0]?.note ?? '').not.toContain('terraform -chdir=infra apply');
	}, 120_000);

	test('and a credentials line that quotes the caller is scrubbed as well', () => {
		// The skipped path needs the scrub as much as the failing one, and it is not a
		// hypothetical shape: the AWS SDK for Go wraps the whole chain onto one line, so the line
		// `credentialsReason` picks out is the one carrying the assume-role refusal and the ARN it
		// was refused on. A note is printed exactly as loudly as a problem.
		const rows = withFailingTerraform(
			`Error: failed to refresh cached credentials, operation error STS: AssumeRole, api error AccessDenied: User: arn:aws:iam::${ACCOUNT}:root is not authorized to perform sts:AssumeRole on resource: arn:aws:iam::${ACCOUNT}:role/hexdocs-deploy`,
			(root) => runStack(root) as CheckResult[],
		);

		expect(rows.map((row) => row.state)).toEqual(['SKIPPED', 'SKIPPED', 'SKIPPED', 'SKIPPED']);
		for (const row of rows) {
			expect(row.note ?? '').not.toContain(ACCOUNT);
			expect(row.note ?? '').not.toContain('arn:aws');
		}
	}, 120_000);
});

// ---------------------------------------------------------------------------
// the library underneath the stack guard: scripts/lib/policy-diff.mjs
// ---------------------------------------------------------------------------

/**
 * The estate identifiers a fixture needs, assembled from parts.
 *
 * `scripts/lint.mjs` fails on a twelve digit run and on an IAM ARN carrying one, anywhere in
 * this repository and with no exemption reachable from `test/`. It is right to: this repository
 * is public. So the account id is written as two halves and the ARNs are built from it, which
 * is what `kit/test/templates/workflow.test.ts` already does for its positive control. Nothing
 * here is a real name.
 */
const ACCOUNT = `${'01234567'}${'8901'}`;
const BUCKET = 'hexdocs-bundles-fixture';
const BUCKET_ARN = `arn:aws:s3:::${BUCKET}`;
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/hexdocs-publish-fixture`;

describe('what a tool printed, read back', () => {
	// Written as code points, the way `check-stack.mjs` derives its own patterns from them and
	// for the same reason: an escape character written as itself is an invisible byte in a diff,
	// and this is the one file where a reviewer most needs to read the characters literally.
	const ESCAPE = String.fromCodePoint(0x1b);
	const BAR = String.fromCodePoint(0x2502);

	/**
	 * Terraform's own shape: a coloured box, the headline first, and the cause several lines
	 * below it. Measured against the s3 backend with no profile in scope, which is where the two
	 * AWS SDK for Go spellings in `NO_CREDENTIALS` came from in the first place.
	 */
	const TERRAFORM_ERROR = [
		'',
		`${ESCAPE}[31m${BAR} Error: error configuring S3 Backend${ESCAPE}[0m`,
		`${BAR}`,
		`${BAR}   no valid credential sources for S3 Backend found.`,
		`${BAR} `,
		`${BAR} No valid credential sources found`,
		`${BAR} operation error ec2imds: GetMetadata, request canceled`,
		'',
	].join('\n');

	test('the colour, the box and the blank lines come off and the indentation stays', () => {
		expect(cleanLines(TERRAFORM_ERROR)).toEqual([
			'Error: error configuring S3 Backend',
			// Two spaces, not none. The box rule takes the bar and one space after it, so the
			// author's own indentation survives and a wrapped diagnostic still reads as one.
			'  no valid credential sources for S3 Backend found.',
			'No valid credential sources found',
			'operation error ec2imds: GetMetadata, request canceled',
		]);
	});

	test('the tail is the last few meaningful lines, joined', () => {
		expect(tail(TERRAFORM_ERROR, 2)).toBe(
			'No valid credential sources found operation error ec2imds: GetMetadata, request canceled',
		);
		expect(tail(TERRAFORM_ERROR)).toContain('Error: error configuring S3 Backend');
	});

	test('credentialsReason names the cause rather than the last line', () => {
		// The whole reason the function exists. A plain tail of this output reports the ec2imds
		// request being cancelled, which is a symptom, and drops the sentence that says what is
		// actually wrong. An operator reading the symptom goes looking at the network.
		expect(credentialsReason(TERRAFORM_ERROR)).toBe('No valid credential sources found');
		expect(credentialsReason(TERRAFORM_ERROR)).not.toContain('ec2imds');
	});

	test('both spellings are recognised, because the two tools sign differently', () => {
		// The AWS CLI signs with botocore and Terraform with the AWS SDK for Go, and they say
		// entirely different things about the same absent profile. Without the second pair the
		// commonest state on a developer's laptop reports NOT RUN, which fails a run that never
		// looked.
		expect(NO_CREDENTIALS.test('Unable to locate credentials')).toBe(true);
		expect(NO_CREDENTIALS.test('No valid credential sources found')).toBe(true);
		expect(NO_CREDENTIALS.test('failed to refresh cached credentials, no EC2 IMDS role')).toBe(
			true,
		);
	});

	test('and both spellings of the other profile state, which is a typo rather than no profile', () => {
		// Asserted as a pair, because the asymmetry is what the defect was: the botocore half
		// carried the named-but-missing state from the day it was copied and the Terraform half
		// did not, so a stale pin skipped when the AWS CLI met it and failed when `terraform
		// output` met it first. Reverting either line here turns this red.
		expect(
			NO_CREDENTIALS.test('The config profile (review-no-such-profile) could not be found'),
		).toBe(true);
		expect(
			NO_CREDENTIALS.test('Error: failed to get shared config profile, review-no-such-profile'),
		).toBe(true);
		// Measured on this machine: the assume-role wrapping of the same failure, which is why the
		// pattern is a substring and is not anchored on the profile name.
		expect(
			NO_CREDENTIALS.test(
				'failed to load assume role for arn, of profile review-no-such-profile, failed to get shared config profile, review-no-such-profile',
			),
		).toBe(true);
	});

	test('an ordinary AccessDenied is not a credentials problem, because it is a different row', () => {
		// The distinction the two absences rest on. A denial is the account answering, which is
		// something to fix and belongs in a FAIL; no credentials is the run not having looked,
		// which is a SKIPPED. A pattern loose enough to catch the first would turn every real
		// permission failure into a green run.
		const denied =
			'An error occurred (AccessDenied) when calling the GetBucketPolicy operation: Access Denied';
		expect(NO_CREDENTIALS.test(denied)).toBe(false);
		// And the reason function falls back to the tail rather than inventing a credential line.
		expect(credentialsReason(denied)).toBe(denied);
	});
});

describe('redacting the estate out of a problem line', () => {
	const redact = redactor([
		{ label: '<bucket>', value: BUCKET },
		{ label: '<bucket arn>', value: BUCKET_ARN },
		{ label: '<role:hex-nfc>', value: ROLE_ARN },
		{ label: '<account>', value: ACCOUNT },
	]);

	test('every identifier goes and the sentence still reads', () => {
		const message =
			`An error occurred (AccessDenied) when calling PutObject: User ${ROLE_ARN} ` +
			`is not authorized to perform s3:PutObject on resource ${BUCKET_ARN}/hex-nfc/manifest.json ` +
			`in bucket ${BUCKET}, which belongs to account ${ACCOUNT}.`;

		expect(redact(message)).toBe(
			'An error occurred (AccessDenied) when calling PutObject: User <role:hex-nfc> ' +
				'is not authorized to perform s3:PutObject on resource <bucket arn>/hex-nfc/manifest.json ' +
				'in bucket <bucket>, which belongs to account <account>.',
		);
	});

	test('nothing of an identifier survives anywhere in the line', () => {
		const message = `${ROLE_ARN} ${BUCKET_ARN} ${BUCKET} ${ACCOUNT}`;
		const redacted = redact(message);
		for (const secret of [ROLE_ARN, BUCKET_ARN, BUCKET, ACCOUNT]) {
			expect(redacted).not.toContain(secret);
		}
	});

	test('the longest value is replaced first, which is what keeps a name out of an ARN', () => {
		// The sort is load-bearing rather than tidy. Replacing the bucket name first turns the
		// bucket ARN into `arn:aws:s3:::<bucket>`, which then matches no secret and ships the
		// ARN's own shape into a CI log, and the same happens to the account id inside a role
		// ARN. Longest first means the containing value goes before the contained one.
		expect(redact(BUCKET_ARN)).toBe('<bucket arn>');
		expect(redact(ROLE_ARN)).toBe('<role:hex-nfc>');
	});

	test('the shape based scrub takes out what the redactor cannot be built to hold', () => {
		// The other half of the same subject. `check-stack.mjs` builds the redactor above out of
		// the stack's outputs, so on the path where reading those outputs is what failed there is
		// nothing to build it from, and this is what that path uses instead: no values, two shapes.
		const message =
			`api error AccessDenied: User: ${ROLE_ARN} is not authorized to perform s3:ListBucket ` +
			`on resource: "${BUCKET_ARN}" in account ${ACCOUNT}.`;

		expect(scrubIdentifiers(message)).toBe(
			'api error AccessDenied: User: <arn> is not authorized to perform s3:ListBucket ' +
				'on resource: "<arn>" in account <account>.',
		);
	});

	test('the ARN goes before the account id that is inside it', () => {
		// The same ordering argument as the length sort above, reached from the other side. With
		// the twelve digit run replaced first the ARN keeps its own shape and ships a placeholder
		// inside it, which still names the partition, the service and the resource.
		expect(scrubIdentifiers(ROLE_ARN)).toBe('<arn>');
		expect(scrubIdentifiers(ACCOUNT)).toBe('<account>');
	});

	test('a name has no shape, so the scrub cannot take one out', () => {
		// Pinned rather than left as prose, because it is the cost `check-stack.mjs`'s header
		// states: a terraform backend failure quotes the state bucket, and the state bucket is in
		// no output and nowhere in this repository.
		expect(scrubIdentifiers(`bucket "${BUCKET}" could not be read`)).toBe(
			`bucket "${BUCKET}" could not be read`,
		);
	});

	test('a value too short to be an identifier is not replaced', () => {
		// A three character value would rewrite ordinary words out of every message. The guard
		// is a length floor rather than a pattern, because a bucket name has no shape.
		const short = redactor([
			{ label: '<empty>', value: '' },
			{ label: '<absent>', value: null },
			{ label: '<short>', value: 'arn' },
		]);
		expect(short('an arn is not a secret')).toBe('an arn is not a secret');
	});
});

describe('the one spelling of a policy statement', () => {
	test('an object key order is not a difference and an array order is', () => {
		expect(stable({ b: 1, a: 2 })).toBe(stable({ a: 2, b: 1 }));
		// Deliberately not sorted. A list of statements is ordered and a list of resources is
		// not, and `asList` is what decides which of the two a field is; folding order away here
		// would take that decision out of the one place it is written down.
		expect(stable([1, 2])).not.toBe(stable([2, 1]));
		expect(stable(null)).toBe('null');
		// An absent field and a null field are the same field, which is what makes the nulls
		// `canonicalStatement` writes work at all: `JSON.stringify(undefined)` is `undefined`
		// rather than a string, so without the fallback a field one side simply does not have
		// would compare against the literal text `undefined` and never match.
		expect(stable(undefined)).toBe(stable(null));
	});

	test('a field written as a string and as a one element list are the same field', () => {
		// S3 returns a list where the document was written with a bare string, and which one
		// comes back is a property of the service. A literal comparison would be red on every
		// correct stack forever.
		expect(asList('s3:PutObject')).toEqual(asList(['s3:PutObject']));
		expect(asList(['s3:PutObject', 's3:GetObject'])).toEqual(
			asList(['s3:GetObject', 's3:PutObject']),
		);
		expect(asList(undefined)).toBeNull();
		expect(asList(null)).toBeNull();
		// A JSON boolean in a condition value reads as the string IAM compares, which is what
		// makes `"false"` and `false` the same deny.
		expect(asList(false)).toEqual(['false']);
	});

	test('Principal "*" and Principal AWS "*" are the same principal', () => {
		// The case that would otherwise redden a bucket policy nobody has touched: S3 returns
		// the second spelling for a policy written as the first. A row that cried wolf here is
		// the row an operator scrolls past on the day it is right.
		expect(canonicalPrincipal('*')).toEqual(canonicalPrincipal({ AWS: '*' }));
		expect(canonicalPrincipal({ AWS: '*' })).toEqual({ AWS: ['*'] });
		expect(canonicalPrincipal({ AWS: [ROLE_ARN] })).toEqual(canonicalPrincipal({ AWS: ROLE_ARN }));
		expect(canonicalPrincipal(undefined)).toBeNull();
	});

	test('a condition is flattened operator by operator and key by key', () => {
		expect(canonicalCondition({ Bool: { 'aws:SecureTransport': false } })).toEqual(
			canonicalCondition({ Bool: { 'aws:SecureTransport': 'false' } }),
		);
		expect(canonicalCondition(undefined)).toBeNull();
		expect([
			...conditionPairs(
				canonicalCondition({
					StringEquals: { 's3:x-amz-acl': 'private', 'aws:PrincipalAccount': ['b', 'a'] },
				}),
			).keys(),
		]).toEqual(['StringEquals s3:x-amz-acl', 'StringEquals aws:PrincipalAccount']);
		expect([...conditionPairs(null).keys()]).toEqual([]);
	});

	test('an operator with no keys under it is a difference rather than an exception', () => {
		// A shape nothing correct produces, and the reason it is handled anyway is what happens
		// if it is not. This document is read back out of S3 rather than written here, so a
		// malformed condition would throw out of the comparison, out of the bucket hardening
		// row and out of `run`, and the operator would get a node stack trace in place of the
		// whole four row report rather than one red row naming one statement.
		expect(canonicalCondition({ Bool: null })).toEqual({ Bool: {} });
		expect([...conditionPairs(canonicalCondition({ Bool: null })).keys()]).toEqual([]);
	});
});

/**
 * The statement both sides of every field comparison start from.
 *
 * One deny, spelled the way `infra/bucket-policy.tf` renders one, so that a mutation of a
 * single field below is the only difference between the two.
 */
const BASE: Record<string, unknown> = {
	Sid: 'DenyInsecureTransport',
	Effect: 'Deny',
	Principal: '*',
	Action: 's3:PutObject',
	Resource: `${BUCKET_ARN}/*`,
	Condition: { Bool: { 'aws:SecureTransport': 'false' } },
};

interface FieldCase {
	field: string;
	applied: Record<string, unknown>;
	says: string;
}

/**
 * One mutation per field of a statement, and the sentence it has to produce.
 *
 * Cross-checked against `STATEMENT_FIELDS` in both directions below, which is the half that
 * matters: a ninth field added to the canonical form with no case here fails naming it, and a
 * case for a field that has gone fails too. Coverage of the type alone is satisfied by one
 * case, which is the lesson `fixtures/nodes.ts` already carries from the other side.
 *
 * A field dropped from `canonicalStatement` is the silent failure this closes. `diffStatement`
 * reads the same name off both sides, so two absent fields compare equal, the field stops being
 * watched, and every row stays green.
 */
const FIELD_CASES: FieldCase[] = [
	{ field: 'Effect', applied: { Effect: 'Allow' }, says: 'differs from the stack in its Effect' },
	{
		field: 'Action',
		applied: { Action: ['s3:PutObject', 's3:DeleteObject'] },
		says: 'On the bucket and not in the stack: s3:DeleteObject',
	},
	{
		field: 'NotAction',
		applied: { NotAction: 's3:GetObject' },
		says: 'differs from the stack in its NotAction',
	},
	{
		field: 'Resource',
		applied: { Resource: `${BUCKET_ARN}/somewhere/else/*` },
		says: 'differs from the stack in its Resource',
	},
	{
		field: 'NotResource',
		applied: { NotResource: `${BUCKET_ARN}/somewhere/else/*` },
		says: 'differs from the stack in its NotResource',
	},
	{
		field: 'Principal',
		applied: { Principal: { AWS: ROLE_ARN } },
		says: 'differs from the stack in its Principal',
	},
	{
		field: 'NotPrincipal',
		applied: { NotPrincipal: { AWS: ROLE_ARN } },
		says: 'differs from the stack in its NotPrincipal',
	},
	{
		field: 'Condition',
		applied: { Condition: { Bool: { 'aws:SecureTransport': 'true' } } },
		says: 'The operator and key pairs that differ: Bool aws:SecureTransport',
	},
];

describe('what differs between one applied statement and the one the stack renders', () => {
	test.each(FIELD_CASES)('a changed $field is one problem, and it names the field', (entry) => {
		const problems = diffStatement(
			BASE['Sid'],
			canonicalStatement({ ...BASE, ...entry.applied }),
			canonicalStatement(BASE),
		) as string[];

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(entry.says);
		// Whichever arm produced it, the field is in the sentence. That is the first thing an
		// operator reads, and the two arms that print a value never print one that can carry an
		// estate identifier.
		expect(String(problems[0]).toLowerCase()).toContain(entry.field.toLowerCase());
	});

	test('every field the canonical form carries has a case, and every case a field', () => {
		expect(new Set(Object.keys(canonicalStatement({})))).toEqual(new Set(STATEMENT_FIELDS));
		expect(new Set(FIELD_CASES.map((entry) => entry.field))).toEqual(new Set(STATEMENT_FIELDS));
		expect(FIELD_CASES).toHaveLength(STATEMENT_FIELDS.length);
	});

	test('an Action gone entirely names what went, from whichever side it went', () => {
		// The arm the eight cases above do not reach: they all change an action list, and this
		// removes one. It matters because a statement stripped of its Action grants or denies
		// nothing at all, and the sentence has to say which side lost what rather than printing
		// two empty lists. Both directions, because the two halves of the message read the two
		// fields in opposite orders and a wrong one is invisible in a diff.
		const gone: Record<string, unknown> = { ...BASE };
		delete gone['Action'];

		const fromBucket = diffStatement(
			BASE['Sid'],
			canonicalStatement(gone),
			canonicalStatement(BASE),
		) as string[];
		expect(fromBucket).toHaveLength(1);
		expect(fromBucket[0]).toContain('On the bucket and not in the stack: nothing');
		expect(fromBucket[0]).toContain('In the stack and not on the bucket: s3:PutObject');

		const fromStack = diffStatement(
			BASE['Sid'],
			canonicalStatement(BASE),
			canonicalStatement(gone),
		) as string[];
		expect(fromStack).toHaveLength(1);
		expect(fromStack[0]).toContain('On the bucket and not in the stack: s3:PutObject');
		expect(fromStack[0]).toContain('In the stack and not on the bucket: nothing');
	});

	test('two spellings of the same statement are not a difference', () => {
		expect(
			diffStatement(
				BASE['Sid'],
				canonicalStatement({ ...BASE, Principal: { AWS: '*' }, Action: ['s3:PutObject'] }),
				canonicalStatement(BASE),
			),
		).toEqual([]);
	});

	test('a value that can carry an estate identifier is named and not printed', () => {
		// The rule the whole row is written around: an action name and a condition operator name
		// can never carry the bucket or the account, and a resource, a principal and a condition
		// value all can. This asserts the second half rather than the first, because the first is
		// what the message says and the second is what a leak looks like.
		const problems = diffStatement(
			BASE['Sid'],
			canonicalStatement({ ...BASE, Resource: `${BUCKET_ARN}/somewhere/else/*` }),
			canonicalStatement(BASE),
		) as string[];
		expect(problems.join(' ')).not.toContain(BUCKET);
		expect(problems.join(' ')).toContain('get-bucket-policy command in infra/README.md');
	});
});

/**
 * A policy document, as S3 stores one.
 *
 * @param statements the statements, in the order the document carries them
 */
function policy(...statements: Record<string, unknown>[]): string {
	return JSON.stringify({ Version: '2012-10-17', Statement: statements });
}

const DENY_DELETE: Record<string, unknown> = {
	Sid: 'DenyDelete',
	Effect: 'Deny',
	Principal: '*',
	Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
	Resource: `${BUCKET_ARN}/*`,
};

const DENY_INSECURE: Record<string, unknown> = {
	Sid: 'DenyInsecureTransport',
	Effect: 'Deny',
	Principal: '*',
	Action: 's3:*',
	Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
	Condition: { Bool: { 'aws:SecureTransport': 'false' } },
};

describe('the applied bucket policy against the one the stack renders', () => {
	const RENDERED = policy(DENY_DELETE, DENY_INSECURE);

	test('a statement given as one object rather than a list is still a statement', () => {
		expect(statementsOf({ Statement: DENY_DELETE })).toEqual([DENY_DELETE]);
		expect(statementsOf({ Statement: [DENY_DELETE] })).toEqual([DENY_DELETE]);
		expect(statementsOf({})).toEqual([]);
		expect(statementsOf(undefined)).toEqual([]);
	});

	test('the same document compares clean and says how many it compared', () => {
		expect(comparePolicy(RENDERED, RENDERED)).toEqual({ problems: [], compared: 2 });
	});

	test('a different order is not statement drift, and the message says access is unchanged', () => {
		const problems = comparePolicy(policy(DENY_INSECURE, DENY_DELETE), RENDERED)
			.problems as string[];

		// One problem, and it is the ordering note. Nothing is reported missing, nothing is
		// reported added, and no field of either statement differs: the two documents are matched
		// Sid for Sid, so `DenyDelete` on the bucket is compared against `DenyDelete` in the stack
		// wherever each of them sits. A comparison that matched by position would report both
		// statements as differing in every field they do not share.
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('in a different order');
		expect(problems[0]).toContain('changes nothing about access');
		expect(problems.join(' ')).not.toContain('is in the stack and is not on the bucket');
		expect(problems.join(' ')).not.toContain('is on the bucket and is not in the stack');
		expect(problems.join(' ')).not.toContain('differs from the stack in its');
	});

	test('a missing statement is drift, and it is named', () => {
		const problems = comparePolicy(policy(DENY_DELETE), RENDERED).problems as string[];

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(
			'"DenyInsecureTransport" is in the stack and is not on the bucket',
		);
		// The half of the sentence that says why it matters. The documented recovery is a
		// `delete-bucket-policy`, the work, and a `put-bucket-policy` back, and a run interrupted
		// after the first step leaves a store whose Terraform reads correct and whose plan is
		// clean.
		expect(problems[0]).toContain('the account root user is what it binds');
	});

	test('a statement nobody rendered is drift, and it is named', () => {
		const added = { ...DENY_DELETE, Sid: 'AddedByHand' };
		const problems = comparePolicy(policy(DENY_DELETE, DENY_INSECURE, added), RENDERED)
			.problems as string[];

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('"AddedByHand" is on the bucket and is not in the stack');
		expect(problems[0]).toContain('nothing here reviewed it');
	});

	test('a changed condition value is drift, and the operator and key are named', () => {
		const weakened = {
			...DENY_INSECURE,
			Condition: { Bool: { 'aws:SecureTransport': 'true' } },
		};
		const problems = comparePolicy(policy(DENY_DELETE, weakened), RENDERED).problems as string[];

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('"DenyInsecureTransport"');
		expect(problems[0]).toContain(
			'The operator and key pairs that differ: Bool aws:SecureTransport',
		);
		expect(problems[0]).toContain('A condition removed from a deny is the deny no longer firing');
		// The value itself is never printed. A condition value is where a bucket ARN lives.
		expect(problems[0]).not.toContain(BUCKET);
	});

	test('a dropped condition operator is drift as well as a changed value', () => {
		const unconditional: Record<string, unknown> = { ...DENY_INSECURE };
		delete unconditional['Condition'];
		const problems = comparePolicy(policy(DENY_DELETE, unconditional), RENDERED)
			.problems as string[];

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('Bool aws:SecureTransport');
	});

	test('Principal "*" against Principal AWS "*" is not drift', () => {
		// S3 returns the second spelling for a policy written as the first, so this is the state
		// of every correct stack rather than an edge case. A comparison that called it drift
		// would be red on day one and every day after.
		const fromS3 = policy(
			{ ...DENY_DELETE, Principal: { AWS: '*' } },
			{ ...DENY_INSECURE, Principal: { AWS: '*' } },
		);
		expect(comparePolicy(fromS3, RENDERED)).toEqual({ problems: [], compared: 2 });
	});

	test('an action as a string against the same action as a one element list is not drift', () => {
		const asString = policy({ ...DENY_DELETE, Action: ['s3:DeleteObject'] }, DENY_INSECURE);
		const asList_ = policy({ ...DENY_DELETE, Action: 's3:DeleteObject' }, DENY_INSECURE);
		expect(comparePolicy(asString, asList_)).toEqual({ problems: [], compared: 2 });
	});

	test('the same Sid twice on the bucket stops the comparison rather than guessing', () => {
		const problems = comparePolicy(policy(DENY_DELETE, DENY_DELETE), RENDERED).problems as string[];

		// One problem and nothing else. With two statements of the same name there is no
		// answer to which of them the stack's `DenyDelete` should be compared against, and a
		// comparison that picked the first would report a hand-added second copy as clean.
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('carries the same Sid twice');
	});

	test('a statement with no Sid is compared by position and says so', () => {
		const problems = comparePolicy(
			JSON.stringify({ Statement: [{ Effect: 'Deny', Action: 's3:*' }] }),
			JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 's3:*' }] }),
		).problems as string[];

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('(statement 1, which carries no Sid)');
		expect(problems[0]).toContain('in its Effect');
	});

	test('either document failing to parse is one problem naming which one', () => {
		// The two are told apart because the fixes are different. A bucket policy that is not
		// JSON is something in the account; a `bucket_policy_json` output that is not JSON is
		// something in `infra/outputs.tf`, and pointing an operator at the wrong one of those
		// costs an afternoon.
		const bucketSide = comparePolicy('not json at all', RENDERED);
		expect(bucketSide.compared).toBe(0);
		expect(bucketSide.problems).toHaveLength(1);
		expect(bucketSide.problems[0]).toContain('The policy on the bucket is not JSON');

		const stackSide = comparePolicy(RENDERED, '{');
		expect(stackSide.compared).toBe(0);
		expect(stackSide.problems).toHaveLength(1);
		expect(stackSide.problems[0]).toContain('The bucket_policy_json output is not JSON');
	});
});

describe('the two strings the live rows hand to AWS and read back from it', () => {
	interface ContextEntry {
		ContextKeyName: string;
		ContextKeyValues: string[];
		ContextKeyType: string;
	}

	test('every context key the two policies name is supplied, and the prefix is the argument', () => {
		// A key the simulation leaves out is a red row on a correct stack: the bucket denies a
		// put carrying no If-None-Match and the role allows one only when it does, so an absent
		// `s3:if-none-match` simulates a correct stack as denying its own publisher every write.
		const entries = JSON.parse(contextEntries('hex-nfc/')) as ContextEntry[];
		expect(entries.map((entry) => entry.ContextKeyName)).toEqual([
			'aws:SecureTransport',
			'aws:PrincipalIsAWSService',
			's3:if-none-match',
			's3:ObjectCreationOperation',
			's3:prefix',
		]);
		expect(entries.at(-1)).toEqual({
			ContextKeyName: 's3:prefix',
			ContextKeyValues: ['hex-nfc/'],
			ContextKeyType: 'string',
		});
	});

	test('a finding location reads as a path into the document', () => {
		expect(
			formatPath([
				{ key: 'Statement' },
				{ index: 2 },
				{ key: 'Condition' },
				{ value: 'Bool' },
				{ substring: { start: 4, length: 9 } },
			]),
		).toBe('Statement[2].Condition.Bool[substring]');
		// An empty path is the document itself rather than an empty string, because a finding
		// reported at nowhere reads as a finding the row failed to place.
		expect(formatPath([])).toBe('(the whole document)');
		expect(formatPath(undefined)).toBe('(the whole document)');
	});
});

describe('what the simulator answered, read back', () => {
	const RESOURCE = `${BUCKET_ARN}/hex-nfc/${'0'.repeat(40)}/ast-1/manifest.json`;
	const AT = `s3:DeleteObject ${RESOURCE}`;

	/** One `ResourceSpecificResults` entry, in the shape `simulate-principal-policy` returns. */
	function answered(fields: Record<string, unknown>): unknown {
		return {
			EvaluationResults: [
				{
					EvalActionName: 's3:DeleteObject',
					ResourceSpecificResults: [{ EvalResourceName: RESOURCE, ...fields }],
				},
			],
		};
	}

	test('a well formed entry carries its decision and the documents that matched it', () => {
		// The shape measured against this account: a deletion is denied by the role's own policy
		// and by the bucket policy at the same time, and the simulator names both.
		const read = readDecisions(
			answered({
				EvalResourceDecision: 'explicitDeny',
				MatchedStatements: [
					{ SourcePolicyType: IAM_POLICY_SOURCE, SourcePolicyId: 'role_publisher_bundle-store' },
					{ SourcePolicyType: 'Resource Policy', SourcePolicyId: 'ResourcePolicy' },
				],
			}),
		);

		expect(read.decision.get(AT)).toBe('explicitDeny');
		expect(read.sources.get(AT)).toEqual([IAM_POLICY_SOURCE, 'Resource Policy']);
		expect(read.missing.has(AT)).toBe(false);
	});

	test('an entry whose decision is missing is absent rather than empty', () => {
		// The whole reason this is a function rather than four lines inside the guard. An empty
		// string is not `allowed`, and the negative claims in `check-stack.mjs` read anything that
		// is not `allowed` as a denial, so a defaulted decision satisfies a claim that a write is
		// refused with nothing having refused it: a broken simulation that reads as a proved
		// boundary. Absent lands in the arm that says the simulator returned no decision.
		for (const malformed of [{}, { EvalResourceDecision: '' }, { EvalResourceDecision: 7 }]) {
			expect(readDecisions(answered(malformed)).decision.has(AT), JSON.stringify(malformed)).toBe(
				false,
			);
		}
	});

	test('an implicit denial matched nothing, and says so', () => {
		// Empty rather than absent, which is the distinction the `explicitDeny` claims read: a pair
		// the answer carried always has a source list, and a pair it did not carry has none.
		const read = readDecisions(answered({ EvalResourceDecision: 'implicitDeny' }));

		expect(read.decision.get(AT)).toBe('implicitDeny');
		expect(read.sources.get(AT)).toEqual([]);
	});

	test('a context key the simulation did not supply is carried, because the answer is not evidence', () => {
		const read = readDecisions(
			answered({ EvalResourceDecision: 'allowed', MissingContextValues: ['s3:prefix'] }),
		);

		expect(read.missing.get(AT)).toEqual(['s3:prefix']);
	});

	test('every field the API leaves out reads as absent rather than as a throw', () => {
		// An evaluation with no results at all beside one with no action name and a matched
		// statement naming no document. None of these is a shape IAM's own model permits, which is
		// exactly why they are here: this row is unreachable without an account, so the arms that
		// answer a malformed response are only ever driven from a table.
		const read = readDecisions({
			EvaluationResults: [
				{ EvalActionName: 's3:PutObject' },
				{
					ResourceSpecificResults: [
						{ EvalResourceDecision: 'allowed', MatchedStatements: [{ SourcePolicyId: 'x' }] },
					],
				},
			],
		});

		expect(read.decision.get(' ')).toBe('allowed');
		expect(read.sources.get(' ')).toEqual(['']);
	});

	test('an answer with nothing in it is three empty maps', () => {
		for (const empty of [undefined, {}, { EvaluationResults: [] }]) {
			const read = readDecisions(empty);
			expect(read.decision.size + read.missing.size + read.sources.size).toBe(0);
		}
	});
});
