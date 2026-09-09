#!/usr/bin/env node
/**
 * The applied stack, read back out of the account.
 *
 * `infra/` states what the bundle store should be, and `pnpm check:infra` proves the
 * stack is well formed and says what its policies mean without touching an account at
 * all. Neither of them knows whether the thing in the account still matches. That gap is
 * where a hand edit lives: the recovery in `infra/README.md` is a `delete-bucket-policy`,
 * the work, and a `put-bucket-policy` back, and a run that stops after the second step
 * leaves a store whose Terraform reads correct and whose published bundles are deletable by
 * anybody in the account.
 *
 * A plan is not that gap and this file used to claim it was. Measured against the applied
 * stack: the provider does read the live policy, so a bucket policy that has been deleted is
 * one it drops from state and proposes to create again, which is the loudest thing a plan can
 * say. What a plan cannot say is what the two documents together permit, and only
 * `iam:SimulatePrincipalPolicy` answers whether the publisher can still delete a published
 * object. A plan also needs the state backend, the state lock and the deploy identity, and is
 * one flag from an apply, where this is eight read operations that cannot become a write.
 * That is why `infra/README.md` names this, and not a plan, as the last step of the recovery.
 *
 * So this is the live half, run by hand as `pnpm check:stack` after every apply.
 *
 * ## Why this is deliberately not a row in `pnpm verify`
 *
 * A row that cannot run reports NOT RUN, and NOT RUN fails the run. A credentialled row
 * on the ladder would therefore fail `pnpm verify` on every machine with no AWS profile,
 * which is most of them and all of CI. The alternative, letting it pass in that state, is
 * a row reporting success having examined nothing, which is the single thing
 * `scripts/lib/report.mjs` exists to refuse. `infra/README.md` states the same decision
 * from the other side.
 *
 * ## Every call is a read
 *
 * The whole value of this script is that an operator can run it at any time without
 * thinking about it, so it must never be capable of changing anything. Eight operations,
 * and nothing else:
 *
 *   s3:GetPublicAccessBlock          HTTP GET
 *   s3:GetBucketVersioning           HTTP GET
 *   s3:GetBucketEncryption           HTTP GET
 *   s3:GetBucketOwnershipControls    HTTP GET
 *   s3:GetBucketPolicy               HTTP GET
 *   access-analyzer:ValidatePolicy   flagged `readonly` in the service model
 *   iam:SimulatePrincipalPolicy      "The simulation does not perform the API operations;
 *                                     it only checks the authorization"
 *   sts:GetCallerIdentity            returns who is signing and nothing else
 *
 * The publisher boundary is proved by simulation rather than by attempting a write. A
 * probe upload would be a real object at a real key in a write-once store, which nothing
 * in this account can then delete without lifting the bucket policy first.
 *
 * ## Two absences, told apart
 *
 * No terraform on the PATH, or a stack with no state, is NOT RUN: the check should have
 * run, and the fix is to apply the stack. No credentials is SKIPPED: the run has not
 * looked rather than found something wrong, and a laptop without a profile has broken
 * nothing. `scripts/check-paint.mjs` draws the same line for a missing browser.
 *
 * ## Nothing here prints an estate identifier
 *
 * This repository is public and `infra/outputs.tf` says in its header that this script
 * reads the outputs and prints none of them. Two AWS outputs carry the account id and one
 * carries the bucket name, and an AWS error message can quote either back. So every problem
 * line produced after the outputs are read goes through `redact`, and the identity row prints
 * the resource half of the caller ARN rather than the ARN.
 *
 * `readOutputs` is the exception, and the reason is structural rather than an oversight:
 * `redact` is built out of the outputs, so on the one path where reading them is what failed
 * it does not exist yet. The two places in `run` that print one of its reasons use
 * `scrubIdentifiers` instead, which knows no values and takes out an `arn:aws` span and a
 * twelve digit run by shape. What that costs is
 * worth knowing before an operator pastes a failure anywhere: with the s3 backend a state read
 * that fails on anything other than credentials quotes the state bucket back, in messages such
 * as `Unable to list objects in S3 bucket "..."`, and the state bucket is a name this script
 * never learns, because `infra/versions.tf` keeps every backend value out of this repository
 * and passes them at init instead. A name has no shape, so nothing here can remove it.
 *
 * ## What is not in this file
 *
 * Everything underneath the calls is in `scripts/lib/policy-diff.mjs`: the comparison of the
 * applied bucket policy against the rendered one, the two redactions, the reading of what a
 * tool printed and the reading of what the simulator answered. That module's header says why
 * the split is there rather than here, and the short version is that the comparison is the one
 * piece of this guard a bug can make silently wrong, and that everything on that side is a
 * piece a suite with no AWS account can hold. What is left in this file is the calls and the
 * assembly of the four rows, and the only part of it a suite reaches is the handful of states
 * that end the run before the first call.
 *
 * Zero dependencies, plain `.mjs`, node 22, like every other guard here.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	IAM_POLICY_SOURCE,
	NO_CREDENTIALS,
	comparePolicy,
	contextEntries,
	credentialsReason,
	formatPath,
	readDecisions,
	redactor,
	scrubIdentifiers,
	tail,
} from './lib/policy-diff.mjs';
import { check, notRun, render, skipped } from './lib/report.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * The four rows, named once.
 *
 * Shared with the credentials path, so a skipped run reports the same four names in the
 * same order as a real one. A report that changes shape depending on why it could not run
 * is a report nobody can compare against the last one.
 */
const ROWS = [
	{ name: 'bucket hardening', unit: 'settings' },
	{ name: 'policy validation', unit: 'documents' },
	{ name: 'publisher boundary', unit: 'simulations' },
	{ name: 'identity', unit: 'callers' },
];

/** The outputs this script reads, and what each has to be. */
const REQUIRED_OUTPUTS = {
	bucket_name: 'string',
	bucket_arn: 'string',
	bucket_policy_json: 'string',
	reader_policy_json: 'string',
	publisher_role_arns: 'object',
	publisher_projects: 'object',
	publisher_policy_json: 'object',
	publisher_trust_policy_json: 'object',
};

/**
 * The key every simulation is run against.
 *
 * No object needs to exist: `simulate-principal-policy` evaluates an ARN against the
 * policies and never touches S3. Only the first segment is scoped by anything, so the
 * commit and the AST major below are shape rather than data, matching what
 * `bundlePrefix()` writes in `src/contracts/manifest.ts`.
 *
 * The commit is written as a repeat rather than as forty typed characters, so that it
 * reads at a glance as a placeholder rather than as a sha somebody once used and left
 * behind.
 */
const SIMULATED_COMMIT = '0'.repeat(40);
const SIMULATED_AST = 'ast-1';

/**
 * A project prefix no publisher may own, for the third half of the boundary proof.
 *
 * Cross-checked against the real project list below rather than trusted, because the day
 * somebody names a project this the row would quietly start asserting that a publisher
 * cannot write where it can.
 */
const UNOWNED_PROJECT = 'owned-by-no-publisher';

/** Read-only, and always JSON, whatever the operator's CLI is configured to print. */
const JSON_OUTPUT = ['--output', 'json', '--no-cli-pager'];

/**
 * The four Block Public Access settings, all of which have to be on.
 *
 * Listed rather than counted from the response. `aws_s3_bucket_public_access_block`
 * defaults every argument to false in the provider, so a bucket carrying three of the
 * four is not a partial pin, it is one setting actively off, and a check that iterated
 * whatever the API returned would examine three things and pass.
 */
const PUBLIC_ACCESS_SETTINGS = [
	'BlockPublicAcls',
	'BlockPublicPolicy',
	'IgnorePublicAcls',
	'RestrictPublicBuckets',
];

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

/**
 * The two states that end the whole run rather than one row.
 *
 * Thrown rather than returned, because either one is true of every remaining call and a
 * report that carried three real rows and one credentials failure would be claiming
 * coverage the run does not have.
 */
class Unavailable extends Error {
	/**
	 * @param {'credentials' | 'tool'} kind
	 * @param {string} why
	 */
	constructor(kind, why) {
		super(why);
		this.kind = kind;
	}
}

/**
 * One AWS call, as JSON.
 *
 * `--output json` is not decoration. The CLI honours an `output = text` or `output = yaml`
 * in the operator's config, and this whole script parses what it gets back, so without the
 * flag a perfectly correct stack reports every row red on one machine and green on the
 * next. `--no-cli-pager` is the same argument for `cli_pager`.
 *
 * No `--region` and no `--profile`. Neither is a stack output, so inventing one here would
 * mean this script could sign off a bucket in an account or a region the operator did not
 * mean. `infra/README.md`'s flow exports both, and the CLI's own message when they are
 * missing names the thing to set.
 *
 * @param {string[]} argv
 * @returns {{ ok: true, value: any } | { ok: false, why: string }}
 */
function aws(argv) {
	const spawned = spawnSync('aws', [...argv, ...JSON_OUTPUT], {
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
	});

	if (spawned.error !== undefined) {
		throw new Unavailable(
			'tool',
			`The AWS CLI could not be started (${spawned.error.code ?? spawned.error.message}). Install it, or put it on the PATH, and run this again.`,
		);
	}

	const stderr = spawned.stderr ?? '';
	if (spawned.status !== 0) {
		if (NO_CREDENTIALS.test(stderr))
			throw new Unavailable('credentials', credentialsReason(stderr));
		return { ok: false, why: tail(stderr) || `the call exited ${spawned.status} with no output` };
	}

	try {
		return { ok: true, value: JSON.parse(spawned.stdout) };
	} catch (error) {
		return {
			ok: false,
			why: `the call succeeded and its output is not JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

// ---------------------------------------------------------------------------
// The stack's own outputs
// ---------------------------------------------------------------------------

/**
 * What the stack says about itself.
 *
 * Read rather than re-derived. Every name this script needs is already an output, and a
 * second copy of the bucket name or of the prefix scoping, written here to save a
 * subprocess, is a copy that agrees with the stack until somebody changes one of them.
 * `infra/outputs.tf` renders the three policy documents for exactly this reason: the
 * validator then reads the document the resources apply rather than a second one written
 * for the validator.
 *
 * @param {string} root
 * @returns {{ kind: 'ok', outputs: Record<string, any> } | { kind: 'not-run', why: string } | { kind: 'no-credentials', why: string }}
 */
function readOutputs(root) {
	const apply =
		'Run `terraform -chdir=infra apply` first; `infra/README.md` has the whole sequence.';
	const spawned = spawnSync(
		'terraform',
		[`-chdir=${join(root, 'infra')}`, 'output', '-json', '-no-color'],
		{ cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
	);

	if (spawned.error !== undefined) {
		return {
			kind: 'not-run',
			why: `terraform could not be started (${spawned.error.code ?? spawned.error.message}). ${apply}`,
		};
	}

	if (spawned.status !== 0) {
		const stderr = spawned.stderr ?? '';
		// Ordered this way round on purpose. With the s3 backend, `terraform output` reads
		// remote state, so no credentials is the commonest reason this command fails and it
		// is not the same answer as an unapplied stack.
		if (NO_CREDENTIALS.test(stderr))
			return { kind: 'no-credentials', why: credentialsReason(stderr) };
		return { kind: 'not-run', why: `${tail(stderr)} ${apply}` };
	}

	/** @type {Record<string, any>} */
	let document;
	try {
		document = JSON.parse(spawned.stdout);
	} catch (error) {
		return {
			kind: 'not-run',
			why: `terraform output -json did not print JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	// An initialised backend holding no state answers `{}` and exits 0, which is the state
	// of every machine between `terraform init` and the first apply. Without this it reads
	// as a stack whose every output has gone missing.
	if (Object.keys(document).length === 0) {
		return {
			kind: 'not-run',
			why: `The stack has no outputs, so it has not been applied. ${apply}`,
		};
	}

	/** @type {Record<string, any>} */
	const outputs = {};
	/** @type {string[]} */
	const missing = [];
	for (const [name, kind] of Object.entries(REQUIRED_OUTPUTS)) {
		const value = document[name]?.value;
		if (value === undefined || value === null || typeof value !== kind) missing.push(name);
		else outputs[name] = value;
	}
	if (missing.length > 0) {
		return {
			kind: 'not-run',
			why: `The state is missing ${missing.join(', ')}, so it was written by a different version of infra/. Apply the current stack and run this again.`,
		};
	}

	return { kind: 'ok', outputs };
}

// ---------------------------------------------------------------------------
// Row 1: bucket hardening
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, any>} outputs
 * @param {(text: unknown) => string} redact
 */
function bucketHardening(outputs, redact) {
	const bucket = outputs.bucket_name;
	/** @type {string[]} */
	const problems = [];
	let examined = 0;
	let compared = 0;

	const access = aws(['s3api', 'get-public-access-block', '--bucket', bucket]);
	if (!access.ok) {
		problems.push(`get-public-access-block: ${access.why}`);
	} else {
		const config = access.value?.PublicAccessBlockConfiguration ?? {};
		for (const setting of PUBLIC_ACCESS_SETTINGS) {
			examined += 1;
			if (config[setting] !== true) {
				problems.push(
					`Block Public Access setting ${setting} is ${String(config[setting])} rather than true. All four are pinned by the stack, and each defaults to false in the provider, so one that is off is off on purpose.`,
				);
			}
		}
	}

	const versioning = aws(['s3api', 'get-bucket-versioning', '--bucket', bucket]);
	if (!versioning.ok) {
		problems.push(`get-bucket-versioning: ${versioning.why}`);
	} else {
		examined += 1;
		const status = versioning.value?.Status;
		if (status !== 'Enabled') {
			problems.push(
				`Versioning reports ${String(status ?? 'nothing at all')} rather than Enabled. Versioning is what makes a deletion recoverable, and suspending it is one of the five actions the reconfiguration deny exists to refuse.`,
			);
		}
	}

	const encryption = aws(['s3api', 'get-bucket-encryption', '--bucket', bucket]);
	if (!encryption.ok) {
		problems.push(`get-bucket-encryption: ${encryption.why}`);
	} else {
		examined += 1;
		const rules = encryption.value?.ServerSideEncryptionConfiguration?.Rules ?? [];
		const algorithms = rules.map(
			(/** @type {any} */ rule) => rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
		);
		if (algorithms.length !== 1 || algorithms[0] !== 'AES256') {
			problems.push(
				`Default encryption is ${algorithms.join(', ') || 'unset'} rather than exactly one AES256 rule. SSE-S3 is what keeps the publisher policy three statements: under SSE-KMS the publish preflight additionally needs kms:Decrypt, and fails on a permission that names neither S3 nor this stack.`,
			);
		}
	}

	const ownership = aws(['s3api', 'get-bucket-ownership-controls', '--bucket', bucket]);
	if (!ownership.ok) {
		problems.push(`get-bucket-ownership-controls: ${ownership.why}`);
	} else {
		examined += 1;
		const rules = ownership.value?.OwnershipControls?.Rules ?? [];
		const owners = rules.map((/** @type {any} */ rule) => rule?.ObjectOwnership);
		if (owners.length !== 1 || owners[0] !== 'BucketOwnerEnforced') {
			problems.push(
				`Object ownership is ${owners.join(', ') || 'unset'} rather than BucketOwnerEnforced. With ACLs back on, a PUT carrying one changes who owns the object instead of failing with a 400.`,
			);
		}
	}

	const policy = aws(['s3api', 'get-bucket-policy', '--bucket', bucket]);
	if (!policy.ok) {
		problems.push(
			`get-bucket-policy: ${policy.why} A bucket with no policy at all is the state the documented recovery leaves behind when it is interrupted, and it is the state in which anybody in this account can delete a published bundle.`,
		);
	} else {
		const result = comparePolicy(String(policy.value?.Policy ?? ''), outputs.bucket_policy_json);
		compared = result.compared;
		examined += compared;
		problems.push(...result.problems);
	}

	return check('bucket hardening', examined, 'settings', problems.map(redact), {
		note: `${compared} bucket policy statements compared Sid for Sid`,
	});
}

// ---------------------------------------------------------------------------
// Row 2: policy validation
// ---------------------------------------------------------------------------

/**
 * Every rendered document, through IAM Access Analyzer.
 *
 * The documents come out of `terraform output` rather than out of the account, and that is
 * the point of `infra/outputs.tf` rendering them: they are the same
 * `aws_iam_policy_document` values the resources apply, so this validates what is deployed
 * rather than a second copy written for the validator.
 *
 * ERROR and SECURITY_WARNING fail the row. SUGGESTION and WARNING are reported as a note:
 * they are real advice and none of them is a reason to refuse a stack whose shape was
 * argued out in `infra/`, and a row that failed on a suggestion would be turned off inside
 * a month.
 *
 * **A green row here says nothing about the OIDC claims.** Access Analyzer does not check
 * claim names in a provider-prefixed namespace at all: `infra/publishers.tf` records the
 * measurement, which is that a trust policy carrying a deliberately misspelled claim
 * returned one finding, about something else. What covers a misspelling is that no
 * condition in that file uses an `...IfExists` operator, so a typo denies rather than
 * grants, and the first real workflow run is the only end to end proof.
 *
 * The bucket policy is validated as a plain RESOURCE_POLICY with no
 * `--validate-policy-resource-type`. `AWS::S3::Bucket` is a legal value and would run the
 * S3-specific checks as well; it is not passed because what those checks say about a
 * policy of four denies with a `Principal` of `*` has not been measured against a real
 * account here, and a row that goes red on a correct stack is worse than a row that checks
 * slightly less.
 *
 * @param {Record<string, any>} outputs
 * @param {(text: unknown) => string} redact
 */
function policyValidation(outputs, redact) {
	/** @type {{ label: string, document: string, type: string, resourceType: string | null }[]} */
	const documents = [
		{
			label: 'bucket policy',
			document: outputs.bucket_policy_json,
			type: 'RESOURCE_POLICY',
			resourceType: null,
		},
		{
			label: 'reader policy',
			document: outputs.reader_policy_json,
			type: 'IDENTITY_POLICY',
			resourceType: null,
		},
	];
	for (const [key, document] of Object.entries(outputs.publisher_policy_json)) {
		documents.push({
			label: `publisher policy (${key})`,
			document: String(document),
			type: 'IDENTITY_POLICY',
			resourceType: null,
		});
	}
	for (const [key, document] of Object.entries(outputs.publisher_trust_policy_json)) {
		documents.push({
			label: `publisher trust policy (${key})`,
			document: String(document),
			// A trust policy is a resource policy attached to a role, and naming the resource
			// type is what turns on the checks that only apply to one: without it Access
			// Analyzer runs the generic resource-policy checks and says nothing about the
			// principal or the action being wrong for an assume-role document.
			type: 'RESOURCE_POLICY',
			resourceType: 'AWS::IAM::AssumeRolePolicyDocument',
		});
	}

	/** @type {string[]} */
	const problems = [];
	/** @type {string[]} */
	const advisory = [];
	let examined = 0;

	for (const entry of documents) {
		const argv = [
			'accessanalyzer',
			'validate-policy',
			'--policy-document',
			entry.document,
			'--policy-type',
			entry.type,
		];
		if (entry.resourceType !== null) {
			argv.push('--validate-policy-resource-type', entry.resourceType);
		}

		const result = aws(argv);
		if (!result.ok) {
			problems.push(`validate-policy on the ${entry.label}: ${result.why}`);
			continue;
		}

		examined += 1;
		for (const finding of result.value?.findings ?? []) {
			const type = String(finding?.findingType ?? 'UNKNOWN');
			const where = (finding?.locations ?? [])
				.map((/** @type {any} */ location) => formatPath(location?.path))
				.join(', ');
			// `findingDetails` is deliberately not printed. It is a sentence about the policy
			// and it quotes the policy, which means it can carry the bucket name; the issue
			// code and the path say what and where, and the link says why.
			const line = `${entry.label}: ${type} ${String(finding?.issueCode ?? 'no issue code')} at ${where || '(no location)'}`;
			if (type === 'ERROR' || type === 'SECURITY_WARNING') {
				problems.push(`${line}. ${String(finding?.learnMoreLink ?? '')}`.trim());
			} else {
				advisory.push(line);
			}
		}
	}

	const note =
		advisory.length === 0
			? 'no findings of any kind'
			: `${advisory.length} advisory findings, none of them failures: ${advisory.slice(0, 4).join('; ')}${advisory.length > 4 ? ', and more' : ''}`;

	return check('policy validation', examined, 'documents', problems.map(redact), {
		note: redact(note),
	});
}

// ---------------------------------------------------------------------------
// Row 3: the publisher boundary
// ---------------------------------------------------------------------------

/**
 * One simulation, as a decision per action and resource.
 *
 * Everything below the call is `readDecisions` in `scripts/lib/policy-diff.mjs`, which is
 * where the reading of a malformed answer can be driven by a suite with no account. Its
 * header says what an absent or empty decision means and why neither is defaulted: this row's
 * negative claims read anything that is not `allowed` as a denial, so a decision defaulted to
 * the empty string is a broken simulation that looks like a proved boundary.
 *
 * @param {{ roleArn: string, actions: string[], resources: string[], prefix: string, bucketPolicy: string, owner: string }} request
 * @returns {{ ok: true, decision: Map<string, string>, missing: Map<string, string[]>, sources: Map<string, string[]> } | { ok: false, why: string }}
 */
function simulate(request) {
	const result = aws([
		'iam',
		'simulate-principal-policy',
		'--policy-source-arn',
		request.roleArn,
		'--action-names',
		...request.actions,
		'--resource-arns',
		...request.resources,
		'--resource-policy',
		request.bucketPolicy,
		'--resource-owner',
		request.owner,
		'--context-entries',
		contextEntries(request.prefix),
	]);
	if (!result.ok) return { ok: false, why: result.why };
	return { ok: true, ...readDecisions(result.value) };
}

/**
 * The publisher boundary, proved without attempting a single write.
 *
 * Four claims per publisher, and each is a different failure if it is wrong: it can write
 * and read inside its own project prefixes, it cannot write inside anybody else's, it
 * cannot delete inside its own, and it can list the bucket under its own prefix. The
 * deletion claim is the one that asks for `explicitDeny` rather than merely denied.
 * Everything in `DenyEverythingElse` is already denied implicitly, so an implicit answer
 * there would mean the statement had been removed and nothing would look different.
 *
 * The decision alone does not say that, and this row asked for nothing else until it was
 * measured. Both documents deny object deletion, the simulator evaluates both of them, and it
 * names the document behind every statement it matched. The mutation itself needs no write,
 * because `iam:SimulateCustomPolicy` takes the document as an argument. Measured against this
 * account on 2026-09-09: the role policy as applied answers a deletion `explicitDeny` with
 * `IAM Policy` and `Resource Policy` both matched, and the same document with
 * `DenyEverythingElse` deleted answers `explicitDeny` with `Resource Policy` alone. The
 * decision does not move, so this row was green over a role that had lost the statement the
 * paragraph above is about. The claim therefore also requires the role's own policy to be
 * among the statements that matched, and `expect` applies that to every `explicitDeny` claim
 * rather than to these two by name.
 *
 * ## What the simulator does not model, stated because a green row is not a green account
 *
 * **The trust policy.** `simulate-principal-policy` starts from a principal that is
 * already the role. Whether GitHub Actions can become it, which is every condition in
 * `infra/publishers.tf`'s trust document, is not touched here and is not touched by the
 * validator either. The first workflow run is the only proof of that.
 *
 * **Block Public Access.** It is an account and bucket setting rather than a policy, so it
 * is invisible to the simulator; row one is what reads it.
 *
 * **The bucket policy.** It is passed in with `--resource-policy` and the resource owner so
 * the two documents are evaluated together. AWS's own service model says, twice, that
 * "Simulation of resource-based policies isn't supported for IAM roles"; measured against this
 * account on 2026-09-09, that is not what happens. The simulator does evaluate the document
 * and names `Resource Policy` in `MatchedStatements`, which is how the deletion claim above
 * can tell one document's deny from the other's.
 *
 * This row still proves nothing about the bucket policy, and the reason is this row rather
 * than the API. `contextEntries` sends `aws:SecureTransport` true, `s3:if-none-match` present
 * and `s3:ObjectCreationOperation` true, which is the exact context in which every conditional
 * statement in that document stands down, so the row never asks a question the bucket policy
 * can answer. Measured on the same day: every decision this row asserts, all six of them on
 * the stack as it stands, is identical with and without `--resource-policy`. What proves the bucket policy is on the bucket and says
 * what the stack says is the Sid for Sid comparison in row one, which reads it back from S3
 * directly.
 *
 * @param {Record<string, any>} outputs
 * @param {(text: unknown) => string} redact
 */
function publisherBoundary(outputs, redact) {
	/** @type {string[]} */
	const problems = [];
	let examined = 0;
	let calls = 0;

	/** @type {Record<string, string>} */
	const roles = outputs.publisher_role_arns;
	/** @type {Record<string, string[]>} */
	const projects = outputs.publisher_projects;
	const bucketArn = String(outputs.bucket_arn);
	const bucketPolicy = String(outputs.bucket_policy_json);

	for (const key of Object.keys(roles)) {
		if (!Array.isArray(projects[key])) {
			problems.push(
				`Publisher "${key}" has a role and no project list, so nothing knows which prefixes it is meant to own.`,
			);
		}
	}
	for (const key of Object.keys(projects)) {
		if (typeof roles[key] !== 'string') {
			problems.push(`Publisher "${key}" owns project prefixes and has no role.`);
		}
	}

	const owned = Object.values(projects).flat().map(String);
	if (owned.includes(UNOWNED_PROJECT)) {
		// The negative case has to be negative. If a real project is ever named this, the
		// third claim below would be asserting that a publisher cannot write where it can,
		// and it would pass for one publisher and fail for its owner.
		problems.push(
			`A publisher owns the project prefix "${UNOWNED_PROJECT}", which this check uses as the prefix nobody owns. Rename the constant in scripts/check-stack.mjs.`,
		);
		return check('publisher boundary', 0, 'simulations', problems.map(redact));
	}

	// The account that owns the bucket, taken from a role ARN rather than from
	// `sts get-caller-identity`. They are the same account whenever anything works at all,
	// and this one is the account the stack was applied to by construction, so the answer
	// does not change if somebody runs this with a profile pointing somewhere else: the run
	// fails on the calls instead of quietly simulating against the wrong owner.
	//
	// `--resource-owner` wants an ARN and not the bare id, which is what the first live run
	// of this row found: IAM answers a bare account id with `InvalidInput: '<id>' is not a
	// valid as a Resource Owner`, and the row went red on a stack that was correct. The
	// account root ARN is the spelling the API documents, and it is a value rather than a
	// principal anybody signs as.
	const account = String(Object.values(roles)[0] ?? '').split(':')[4] ?? '';
	if (account === '') {
		problems.push('No publisher role ARN carries an account id, so the resource owner is unknown.');
		return check('publisher boundary', 0, 'simulations', problems.map(redact));
	}
	const owner = `arn:aws:iam::${account}:root`;

	/**
	 * @param {string} project
	 */
	const objectArn = (project) =>
		`${bucketArn}/${project}/${SIMULATED_COMMIT}/${SIMULATED_AST}/manifest.json`;

	/**
	 * One claim, checked against one decision.
	 *
	 * `where` is the publisher and the project rather than the resource ARN, and it is on
	 * every line for a reason: a stack with two publishers and four project prefixes asks
	 * the same four questions twenty times, so a problem naming only the action produces a
	 * column of identical sentences and nobody can tell which prefix is wrong.
	 *
	 * `explicitDeny` means more here than the API's own value of that name: it is an explicit
	 * denial in which one of the statements that matched belongs to the role's own policies. Two
	 * documents are evaluated together and both deny deletion, so the value alone is green over a
	 * role that has lost its deny. A future claim that wants a resource policy deny needs a want
	 * of its own rather than this one.
	 *
	 * @param {ReturnType<typeof simulate> & { ok: true }} answer
	 * @param {string} action
	 * @param {string} resource
	 * @param {string} where
	 * @param {'allowed' | 'explicitDeny' | 'denied'} want
	 * @param {string} why
	 */
	const expect = (answer, action, resource, where, want, why) => {
		examined += 1;
		const at = `${action} ${resource}`;
		const got = answer.decision.get(at);
		if (got === undefined) {
			problems.push(`The simulator returned no decision for ${action} on ${where}. ${why}`);
			return;
		}
		const missing = answer.missing.get(at);
		if (missing !== undefined) {
			problems.push(
				`The simulation of ${action} on ${where} needed context keys this check does not supply (${missing.join(', ')}), so its answer of ${got} is not evidence either way. A condition has been added that this row does not model.`,
			);
			return;
		}
		const held = want === 'denied' ? got !== 'allowed' : got === want;
		if (!held) {
			problems.push(`${action} on ${where} simulated as ${got} and should be ${want}. ${why}`);
			return;
		}
		if (want !== 'explicitDeny') return;
		const from = answer.sources.get(at) ?? [];
		if (!from.includes(IAM_POLICY_SOURCE)) {
			problems.push(
				`${action} on ${where} simulated as explicitDeny and nothing in the role's own policy is what denied it. The statements that matched came from ${from.join(' and ') || 'no document the simulator named'}. ${why}`,
			);
		}
	};

	for (const [key, roleArn] of Object.entries(roles)) {
		for (const project of projects[key] ?? []) {
			const resource = objectArn(String(project));
			const where = `${key}'s own project ${project}`;

			const own = simulate({
				roleArn,
				actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
				resources: [resource],
				prefix: `${project}/`,
				bucketPolicy,
				owner,
			});
			calls += 1;
			if (!own.ok) {
				problems.push(`simulate-principal-policy for ${key} on ${project}: ${own.why}`);
			} else {
				expect(
					own,
					's3:PutObject',
					resource,
					where,
					'allowed',
					`Publishing into its own project is the one thing this role exists to do.`,
				);
				expect(
					own,
					's3:GetObject',
					resource,
					where,
					'allowed',
					`Without it the publish preflight head and the reconcile both fail.`,
				);
				expect(
					own,
					's3:DeleteObject',
					resource,
					where,
					'explicitDeny',
					`DenyEverythingElse is what makes deletion a decision rather than an omission. An implicit denial here means the statement has gone, and so does an explicit one the bucket policy produced on its own. Nothing else in this stack would show either.`,
				);
				expect(
					own,
					's3:DeleteObjectVersion',
					resource,
					where,
					'explicitDeny',
					`Without this the versions that make a deletion recoverable can be purged one at a time.`,
				);
			}

			const listing = simulate({
				roleArn,
				actions: ['s3:ListBucket'],
				resources: [bucketArn],
				prefix: `${project}/`,
				bucketPolicy,
				owner,
			});
			calls += 1;
			if (!listing.ok) {
				problems.push(`simulate-principal-policy listing for ${key} on ${project}: ${listing.why}`);
			} else {
				expect(
					listing,
					's3:ListBucket',
					bucketArn,
					where,
					'allowed',
					`publish and prefetch both open with list-objects-v2 under this prefix, so without it every publish stops at its own preflight. The prefix is supplied here because the real request carries one: that is what makes the StringLike condition on s3:prefix apply at all.`,
				);
			}
		}

		// One call for every prefix this publisher must not reach: every other publisher's
		// projects, and one prefix nobody owns. A single-publisher stack still gets the
		// second, which is the case that matters on day one.
		const foreign = [
			...Object.entries(projects)
				.filter(([other]) => other !== key)
				.flatMap(([, list]) => (list ?? []).map(String)),
			UNOWNED_PROJECT,
		];
		const outside = simulate({
			roleArn,
			actions: ['s3:PutObject'],
			resources: foreign.map(objectArn),
			prefix: `${(projects[key] ?? [])[0] ?? UNOWNED_PROJECT}/`,
			bucketPolicy,
			owner,
		});
		calls += 1;
		if (!outside.ok) {
			problems.push(`simulate-principal-policy outside ${key}'s prefixes: ${outside.why}`);
		} else {
			for (const project of foreign) {
				expect(
					outside,
					's3:PutObject',
					objectArn(project),
					`${key} writing into ${project}`,
					'denied',
					`A prefix belongs to exactly one repository. Write-once turns a crossing into a refusal rather than corruption, and the refusal lands in the wrong repository's CI, where it reads as a publish that inexplicably stopped working.`,
				);
			}
		}
	}

	return check('publisher boundary', examined, 'simulations', problems.map(redact), {
		note: `${calls} simulate-principal-policy calls, no write attempted`,
	});
}

// ---------------------------------------------------------------------------
// Row 4: who is signing
// ---------------------------------------------------------------------------

/**
 * Who signed for everything above.
 *
 * A root ARN is a SKIPPED row rather than a failure, and it is the same decision the
 * `check` block in `infra/providers.tf` makes for the same reason: root is the only
 * identity this estate has today, so refusing here would mean the operator who applied the
 * stack can never get a green run out of the thing that verifies it, and the report would
 * be read as broken rather than as a warning. A `check` block cannot fail a plan, and
 * SKIPPED cannot fail a run, so both state the fact every time and go quiet on their own
 * the day it stops being true.
 *
 * What would make it a failure is step 5 of the migration in `infra/README.md`. Once the
 * root access key is deleted, a root signature is a regression rather than the state of
 * the estate, and this row should become a plain failure at that point. There is
 * deliberately no flag or environment variable to flip early: a switch nobody has thrown
 * is indistinguishable from a check nobody wrote.
 *
 * The ARN is never printed. Everything after the fifth colon is the resource half, which
 * carries no account id, and that is what says whether the caller is `root`, a user or an
 * assumed role.
 *
 * @param {(text: unknown) => string} redact
 */
function identity(redact) {
	const caller = aws(['sts', 'get-caller-identity']);
	if (!caller.ok) {
		return check('identity', 0, 'callers', [redact(`sts get-caller-identity: ${caller.why}`)]);
	}

	const arn = String(caller.value?.Arn ?? '');
	const resource = arn.split(':').slice(5).join(':');
	if (resource === '') {
		return check('identity', 0, 'callers', [
			'sts get-caller-identity returned no ARN, so who signed for every row above is unknown.',
		]);
	}

	if (arn.endsWith(':root')) {
		return skipped(
			'identity',
			'callers',
			'signing as the account root user, which is the only identity this estate has. See the migration in infra/README.md.',
		);
	}

	return check('identity', 1, 'callers', [], { note: redact(`signing as ${resource}`) });
}

// ---------------------------------------------------------------------------

/**
 * @param {string} [root] The repository to read `infra/` from. A parameter so a test can
 *   point it at a copy with no stack, the way `scripts/check-cli.mjs` and
 *   `scripts/check-paint.mjs` both take one.
 * @returns {import('./lib/report.mjs').CheckResult[]}
 */
export function run(root = ROOT) {
	// Both of these go through `scrubIdentifiers` and not through `redact`, and the header says
	// why: the redactor is built out of the outputs, and this is the path on which reading the
	// outputs is what failed. One of the two carries terraform's own stderr, which against the
	// s3 backend can be an authorisation denial naming the calling principal and its account.
	const found = readOutputs(root);
	if (found.kind === 'no-credentials') {
		return ROWS.map((row) =>
			skipped(row.name, row.unit, scrubIdentifiers(`no AWS credentials in scope: ${found.why}`)),
		);
	}
	if (found.kind === 'not-run') {
		// One row rather than four. There is nothing to name four rows about: without the
		// outputs this script does not know the bucket, the roles or the prefixes, so it has
		// no verdict to give rather than four bad ones. `scripts/check-cli.mjs` collapses the
		// same way when the catalogue is missing.
		return [notRun('applied stack', 'outputs', scrubIdentifiers(found.why))];
	}

	const outputs = found.outputs;
	// Built before the first AWS call, from the outputs alone. The account id is taken out
	// of a publisher role ARN rather than out of `sts get-caller-identity`, because the
	// identity row runs last and a redactor assembled after the calls it is meant to censor
	// is not a redactor. Everything that can carry an estate identifier is in here: the
	// bucket by name and by ARN, every role ARN, and the account.
	const redact = redactor([
		{ label: '<bucket>', value: outputs.bucket_name },
		{ label: '<bucket arn>', value: outputs.bucket_arn },
		...Object.entries(outputs.publisher_role_arns).map(([key, arn]) => ({
			label: `<role:${key}>`,
			value: arn,
		})),
		{
			label: '<account>',
			value: String(Object.values(outputs.publisher_role_arns)[0] ?? '').split(':')[4],
		},
	]);

	try {
		return [
			bucketHardening(outputs, redact),
			policyValidation(outputs, redact),
			publisherBoundary(outputs, redact),
			identity(redact),
		];
	} catch (error) {
		// Through `redact` like every problem line, and for the same reason. The header says
		// nothing here prints an estate identifier, and a note is printed exactly as loudly as
		// a problem. The realistic case is a credentials message that quotes the request it
		// failed on, which for `get-bucket-policy` names the bucket.
		if (error instanceof Unavailable && error.kind === 'credentials') {
			return ROWS.map((row) =>
				skipped(row.name, row.unit, redact(`no AWS credentials in scope: ${error.message}`)),
			);
		}
		if (error instanceof Unavailable) {
			return [notRun('applied stack', 'calls', redact(error.message))];
		}
		throw error;
	}
}

/**
 * Whether this file is the program, by real path.
 *
 * Not the text comparison of `import.meta.url` against `process.argv[1]` that the older
 * guards here use. Through any symlink, and pnpm's store is nothing but symlinks, the two
 * strings differ, the guard is false, and the script prints nothing and exits 0. A check
 * that silently does nothing and reports success is the exact failure the four-state
 * report exists to refuse, so it must not be reachable from the way the file is invoked.
 */
function isProgram() {
	const argv = process.argv[1];
	if (argv === undefined) return false;
	try {
		return realpathSync(argv) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isProgram()) {
	const { ok } = render('hex-docs applied stack', run());
	process.exit(ok ? 0 : 1);
}
