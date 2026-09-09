/**
 * Four S3 operations, over the recipe table, with the exec injected.
 *
 * There is no AWS SDK here and there is not going to be one. `kit/` has two
 * dependencies, `@aws-sdk/client-s3` lands roughly forty transitive packages, and every
 * app repository mounts this submodule: hex-nfc is a Swift repository whose first
 * `hexdocs` run would pay that install. The estate's convention for toolchain code is
 * unanimous in the other direction anyway, `hex-terraform/mcp` and `hex-terraform/deploy`
 * both shell out to `aws`, and the SDK appears only in runtime application code.
 *
 * The exec is a parameter rather than an import so a test drives `publish` and
 * `prefetch` against a recording fake and asserts the exact argv, and so nothing here
 * can reach a process except through `runRecipe`, which is the package's one spawn site.
 *
 * **Everything here is synchronous**, because `Exec` is: `runRecipe` uses `spawnSync`.
 * That is what makes the environment handling in `withAuth` safe, and it is also why
 * `publish` uploads serially. Bounded concurrency would need an async `Exec`, which is a
 * change to `kit/src/exec/run.ts` and not to this file.
 */

import type { Finding } from '../../../src/contracts/diagnostics.js';
import { CHECK_IDS } from '../../../src/contracts/lint.js';
import { DEFAULT_AUDIENCE } from '../../../src/contracts/frontmatter.js';
import {
	DEFAULT_BUDGETS,
	DOCS_CONFIG_VERSION,
	PLAIN_CODE_LANGUAGE,
	type DocsProjectConfig,
} from '../../../src/contracts/project.js';
import { runLint } from '../compile/lint/run.js';
import type { RawFinding } from '../compile/types.js';
import type { Exec, RunResult } from '../exec/run.js';
import { ExecRefusal } from '../exec/run.js';

import type { ObjectMedia } from './keys.js';

/**
 * One page of a `list-objects-v2` call.
 *
 * A thousand is the service's own maximum per response and the AWS CLI's default page
 * size, so this is the largest page that costs one request.
 */
export const LIST_PAGE_SIZE = 1000;

/** Where the objects are, and who signs for them. */
export interface S3Auth {
	readonly bucket: string;
	readonly region: string;
	/** Absent means whatever the ambient environment already resolves to. */
	readonly profile: string | undefined;
}

/**
 * Why a call did not answer, split so a caller can choose the right row.
 *
 * `credentials` is separate from every other failure because it is the one that must
 * become a `not-run` row naming the missing credential rather than a `fail`. A build
 * host with no AWS profile has not found a broken bundle; it has not looked.
 */
export interface Refusal {
	readonly kind: 'refused';
	readonly why: string;
	readonly credentials: boolean;
}

export type HeadResult =
	/**
	 * `checksumSha256` is base64 of the raw digest, which is the spelling S3 stores and
	 * returns. It is `null` for an object uploaded without a checksum, which is not the
	 * same as a mismatch and must not be treated as one.
	 */
	{ kind: 'present'; checksumSha256: string | null; bytes: number } | { kind: 'absent' } | Refusal;

export type ListResult = { kind: 'ok'; keys: string[]; pages: number } | Refusal;

export type GetResult = { kind: 'ok' } | { kind: 'absent' } | Refusal;

export type PutResult =
	/** The `--if-none-match '*'` precondition failed: something is already at this key. */
	| { kind: 'ok' }
	| { kind: 'exists' }
	/** S3's 409, which its own documentation says to retry. */
	| { kind: 'conflict' }
	| Refusal;

export interface S3Client {
	head(key: string): HeadResult;
	/** Every key under the prefix, following the continuation token to the end. */
	list(prefix: string): ListResult;
	/** Writes the raw stored bytes to `outPath`. No `Content-Encoding` is decoded. */
	get(key: string, outPath: string): GetResult;
	/** `digestHex` is the manifest's spelling; the conversion to base64 happens here. */
	put(key: string, bodyPath: string, media: ObjectMedia, digestHex: string): PutResult;
	/** How many processes this client has started. What a row's `examined` counts. */
	readonly calls: number;
}

// ---------------------------------------------------------------------------
// Reading what the CLI said
// ---------------------------------------------------------------------------

/**
 * The error shapes worth telling apart, matched against stderr.
 *
 * The AWS CLI prints `An error occurred (<Code>) when calling the <Op> operation:
 * <message>` and exits non-zero, so the code is in the text and nowhere else: there is
 * no machine readable failure channel to read instead. These patterns are deliberately
 * narrow, and anything they do not match stays an ordinary refusal carrying the whole
 * stderr, because a refusal that guessed wrong about which failure it met is worse than
 * one that quotes the tool.
 */
const NOT_FOUND = /\(404\)|Not Found|NoSuchKey/;

/**
 * Never folded into `NOT_FOUND`.
 *
 * A missing bucket answers a `head-object` with a 404 shaped message too, and reading it
 * as "the object is not there yet" would make `publish` upload nine hundred objects into
 * a bucket that does not exist, one refusal at a time.
 */
const NO_BUCKET = /NoSuchBucket|AllAccessDisabled|InvalidBucketName/;

/**
 * Missing, expired or unusable credentials.
 *
 * The list is longer than "Unable to locate credentials" because the common case on a
 * developer's laptop is an expired SSO session, and the common case in a container is no
 * credential source at all. Both are the same answer to the caller: this run did not
 * look.
 *
 * `InvalidAccessKeyId` and `InvalidToken` are the codes S3 itself returns for a key that
 * has been deleted or deactivated and for a malformed session token, and they arrive only
 * where the response carries a body. Measured on aws-cli 2.36.19 against a dead key: a
 * `get-object` prints `An error occurred (InvalidAccessKeyId) ...` and so does a
 * `list-objects-v2`, while the same request as `head-object` prints
 * `An error occurred (403) when calling the HeadObject operation: Forbidden` and names
 * nothing, because a HEAD response has no body and botocore synthesises the code from the
 * status. So these two fix `get` and `list`, where a rotated key used to read as a plain
 * failure, and they cannot fix `head`, where the text they would match is never printed.
 * What `head` does instead is at `denial()`.
 */
const NO_CREDENTIALS =
	/Unable to locate credentials|ExpiredToken|InvalidClientTokenId|InvalidAccessKeyId|InvalidToken|SignatureDoesNotMatch|security token included in the request is (?:expired|invalid)|The SSO session|Error when retrieving token|The config profile \(.*\) could not be found|UnrecognizedClientException/i;

/**
 * Denied, which on a read is not the same answer as absent and must not be folded into
 * one.
 *
 * S3 masks a missing object as a 403 for a caller that cannot list the bucket: with
 * `s3:ListBucket` a `head-object` on a key that is not there answers 404, and without it
 * the same call answers 403, so the two states are indistinguishable from the message
 * alone. Measured against two public buckets, one granting anonymous list and one not, on
 * the same missing key.
 *
 * It is matched only so the refusal can say what a 403 can mean, which on a `head-object`
 * is three things rather than two: see `denial()`. Reading a 403 as absent would be worse
 * than the raw stderr: `publish` would upload nine hundred objects one denial at a time,
 * and `prefetch` would report a bundle missing when what is missing is a permission.
 */
const ACCESS_DENIED = /AccessDenied|\(403\)|Forbidden/;

const PRECONDITION_FAILED = /PreconditionFailed|\(412\)/;

const CONFLICT = /ConditionalRequestConflict|\(409\)/;

function refusal(what: string, result: RunResult): Refusal {
	// `status === null` is `runRecipe`'s answer for a binary that never started, and its
	// message is on stderr already. Naming it separately matters: "aws is not installed"
	// and "aws said no" send an operator to different places.
	const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-3).join(' ');
	const prefix = result.status === null ? `${what} could not start` : `${what} failed`;
	return {
		kind: 'refused',
		why: `${prefix}: ${detail || 'no output'}`,
		credentials: result.status === null ? false : NO_CREDENTIALS.test(result.stderr),
	};
}

/**
 * The same refusal, with the sentence a 403 needs and an ordinary one cannot carry.
 *
 * A reader whose credentials are fine and whose bundle is missing gets `AccessDenied`
 * from S3 and nothing else, because of the masking rule above. Quoting that verbatim
 * sends an operator to IAM, which is the wrong half of the answer roughly half the time.
 * Naming the states costs one sentence and is the difference between a fifteen minute
 * search and a one minute one.
 *
 * How many states there are depends on whether the service named a code, which is why
 * this branches rather than printing the shorter list both times. A HeadObject error has
 * no body, so botocore synthesises the code from the status and the CLI prints
 * `An error occurred (403) when calling the HeadObject operation: Forbidden` and nothing
 * else. Measured on aws-cli 2.36.19: a deactivated access key and a policy that simply
 * says no print that line byte for byte, while the same request as `get-object` does
 * carry a body and names `InvalidAccessKeyId` in the first case and `AccessDenied` in the
 * second. So a 403 naming `AccessDenied` is the two-state answer this used to assert
 * everywhere, and a 403 naming no code at all is a three-state one.
 *
 * `credentials` stays false on both, deliberately, and the sentence is the whole fix. A
 * bare 403 read as a credentials refusal would become a `not-run` row saying the run
 * never looked, which is the same error the other way round and worse: a publisher role
 * that is merely too narrow would be reported as an unconfigured machine.
 */
function denial(what: string, result: RunResult): Refusal {
	const base = refusal(what, result);
	const named = /AccessDenied/.test(result.stderr);
	const sentence = named
		? 'That is either a missing object or a missing permission: S3 answers a caller without s3:ListBucket with 403 rather than 404, so the two look identical here. Check the labelled commit has a published bundle, then check the policy grants s3:GetObject on the object prefix and s3:ListBucket on the bucket.'
		: 'That is a missing object, a missing permission, or a credential this account no longer accepts. S3 answers a caller without s3:ListBucket with 403 rather than 404, and an error with no code named in it is a HeadObject failure, which has no body for the CLI to read, so all three read the same here. Re-run the same key as `aws s3api get-object`, which does carry a body and does name the code, then check the labelled commit has a published bundle and that the policy grants s3:GetObject on the object prefix and s3:ListBucket on the bucket.';
	return { ...base, why: `${base.why} ${sentence}` };
}

/**
 * Hex to base64, which is the conversion `--checksum-sha256` needs.
 *
 * The manifest stores every digest as lower case hex and S3 stores and returns the same
 * bytes as base64, so a comparison in either direction has to convert rather than
 * compare strings. This one is exported and named so the direction is visible at the
 * call site: everything in a manifest is hex, everything from S3 is base64.
 */
export function hexToBase64(hex: string): string {
	return Buffer.from(hex, 'hex').toString('base64');
}

/** Base64 to hex. The inverse, for turning a `head-object` answer back into manifest spelling. */
export function base64ToHex(value: string): string {
	return Buffer.from(value, 'base64').toString('hex');
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * Runs one call with the region and the profile in the environment.
 *
 * This is the one thing in this module that is not carried by the recipe, and it is
 * worth saying plainly what it does and does not cover. `kit/src/exec/recipes.ts`
 * declares every argv as a literal template with typed holes, and none of the four AWS
 * templates has a hole for `--profile` or `--region`; `RunOptions` carries `cwd`,
 * `timeoutMs` and `maxBuffer` and no environment. So the only route from a `--profile`
 * flag to the CLI that does not edit a file this module does not own is the ambient
 * environment, which `spawnSync` inherits.
 *
 * It is safe here for one specific reason and it would not be in general: `Exec` is
 * synchronous, so no other code can run between the assignment and the restore, and the
 * restore is in a `finally`. It is still weaker than an argv flag, because anything else
 * spawned inside the same call would inherit the same variables. Nothing is: the call is
 * one `spawnSync`.
 *
 * The right fix is two more holes in the recipe templates. That is noted rather than
 * done, because a recipe is a closed literal and widening one belongs with the file that
 * owns them.
 */
function withAuth<T>(auth: S3Auth, run: () => T): T {
	const previousProfile = process.env['AWS_PROFILE'];
	const previousRegion = process.env['AWS_REGION'];
	if (auth.profile !== undefined) process.env['AWS_PROFILE'] = auth.profile;
	process.env['AWS_REGION'] = auth.region;
	try {
		return run();
	} finally {
		if (previousProfile === undefined) delete process.env['AWS_PROFILE'];
		else process.env['AWS_PROFILE'] = previousProfile;
		if (previousRegion === undefined) delete process.env['AWS_REGION'];
		else process.env['AWS_REGION'] = previousRegion;
	}
}

export function s3Client(exec: Exec, auth: S3Auth, cwd: string): S3Client {
	let calls = 0;

	/**
	 * `ExecRefusal` is turned into a refusal rather than allowed to escape.
	 *
	 * It is thrown for exactly two things, an arity mismatch and a hole carrying a NUL, so
	 * it is a programming error or a config value with a NUL in it rather than a state an
	 * operator reaches. The values passed here are a bucket name from a flag, a key from a
	 * manifest, an output path built from a cache directory and a content type from
	 * `s3/keys.ts`. That last one is why the shell metacharacter class this comment used to
	 * name is gone: `text/plain; charset=utf-8` was refused by it, on this code path, in
	 * production. Whatever the reason, the honest report is a row naming the value, not a
	 * stack trace out of a prebuild hook.
	 */
	const call = (id: Parameters<Exec>[0], holes: readonly string[]): RunResult => {
		calls += 1;
		try {
			return withAuth(auth, () => exec(id, holes, { cwd }));
		} catch (error) {
			if (error instanceof ExecRefusal) {
				return { status: 1, stdout: '', stderr: error.message };
			}
			throw error;
		}
	};

	const head = (key: string): HeadResult => {
		const result = call('aws.head-object', [auth.bucket, key]);
		if (result.status === 0) {
			let parsed: { ChecksumSHA256?: unknown; ContentLength?: unknown };
			try {
				parsed = JSON.parse(result.stdout) as typeof parsed;
			} catch (error) {
				return {
					kind: 'refused',
					why: `head-object on ${key} returned output that is not JSON: ${(error as Error).message}`,
					credentials: false,
				};
			}
			return {
				kind: 'present',
				checksumSha256: typeof parsed.ChecksumSHA256 === 'string' ? parsed.ChecksumSHA256 : null,
				bytes: typeof parsed.ContentLength === 'number' ? parsed.ContentLength : -1,
			};
		}
		// A 404 from `head-object` means the object is not there, and it means that only
		// because the caller can list the bucket. S3's rule is the opposite way round from
		// what an earlier version of this comment claimed: with `s3:ListBucket` a missing
		// key answers 404, and without it the same key answers 403, so an identity granted
		// only `s3:GetObject` cannot tell the two apart. That is why the 403 below is
		// reported rather than read as absence.
		//
		// It is not why the publisher's policy grants `s3:ListBucket`, which is what this
		// comment used to say next. That grant carries a `StringLike` on `s3:prefix`, a
		// HeadObject supplies no value for that key, and an absent key makes the condition
		// false, so it does nothing for the call described above. `publish` never makes that
		// call blind now: its preflight is a listing, and the head that follows runs only on a
		// key the listing named. The reader policy is the one that keeps this paragraph as its
		// reason, because `reader.tf` grants ListBucket with no condition at all.
		//
		// Reading 404 as absent is safe on its own account: the publisher's next step is a
		// put carrying `--if-none-match '*'`, which fails with a 412 if something is in
		// fact there.
		if (!NO_BUCKET.test(result.stderr) && NOT_FOUND.test(result.stderr)) return { kind: 'absent' };
		if (ACCESS_DENIED.test(result.stderr)) return denial(`head-object on ${key}`, result);
		return refusal(`head-object on ${key}`, result);
	};

	/**
	 * Every key under a prefix, following the continuation token.
	 *
	 * Pagination is not an edge case here and skipping it is not a slow bug, it is a
	 * wrong answer: a sixty page manual in seven locales is roughly 850 objects before
	 * assets, and one more section takes it past a thousand. An unpaginated call reports
	 * the tail absent, which `prefetch` reads as a missing object and `publish` reads as
	 * a key to upload, and that upload then fails the `--if-none-match` precondition on
	 * bytes that were already correct.
	 *
	 * The continuation field is `NextToken`, not `NextContinuationToken`, and the
	 * difference is decided by the recipe rather than by S3. Both `aws.list-objects` and
	 * `aws.list-objects-page` carry `--max-items`, which turns on the CLI's own client
	 * side paginator; botocore's `build_full_result` aggregates `Contents`, drops the
	 * service's output token (`NextContinuationToken` is the `output_token` in the
	 * ListObjectsV2 paginator config and is therefore not a non-aggregate key), and
	 * injects its own `NextToken` when it truncated. `NextContinuationToken` is read as a
	 * fallback because it is what the same call returns if `--max-items` is ever dropped
	 * from the recipe, and taking either is correct where taking neither is the bug.
	 */
	const list = (prefix: string): ListResult => {
		const keys: string[] = [];
		let token: string | undefined;
		let pages = 0;

		for (;;) {
			const result =
				token === undefined
					? call('aws.list-objects', [auth.bucket, prefix, String(LIST_PAGE_SIZE)])
					: call('aws.list-objects-page', [auth.bucket, prefix, String(LIST_PAGE_SIZE), token]);
			if (result.status !== 0) return refusal(`list-objects-v2 on ${prefix}`, result);

			// An empty prefix answers with an empty document rather than with no output on
			// some CLI versions, so both are the same "nothing there yet" answer and
			// neither is a failure: a first publish lists a prefix that does not exist.
			const body = result.stdout.trim();
			let parsed: { Contents?: unknown; NextToken?: unknown; NextContinuationToken?: unknown };
			if (body === '') parsed = {};
			else {
				try {
					parsed = JSON.parse(body) as typeof parsed;
				} catch (error) {
					return {
						kind: 'refused',
						why: `list-objects-v2 on ${prefix} returned output that is not JSON: ${(error as Error).message}`,
						credentials: false,
					};
				}
			}

			pages += 1;
			if (Array.isArray(parsed.Contents)) {
				for (const entry of parsed.Contents) {
					const key = (entry as { Key?: unknown }).Key;
					if (typeof key === 'string') keys.push(key);
				}
			}

			const next =
				typeof parsed.NextToken === 'string'
					? parsed.NextToken
					: typeof parsed.NextContinuationToken === 'string'
						? parsed.NextContinuationToken
						: undefined;
			if (next === undefined) return { kind: 'ok', keys, pages };
			token = next;
		}
	};

	const get = (key: string, outPath: string): GetResult => {
		const result = call('aws.get-object', [auth.bucket, key, outPath]);
		if (result.status === 0) return { kind: 'ok' };
		if (!NO_BUCKET.test(result.stderr) && NOT_FOUND.test(result.stderr)) return { kind: 'absent' };
		if (ACCESS_DENIED.test(result.stderr)) return denial(`get-object on ${key}`, result);
		return refusal(`get-object on ${key}`, result);
	};

	/**
	 * One object, with its type, its encoding and its checksum, and never over anything.
	 *
	 * `--if-none-match '*'` is inside the recipe template rather than assembled here, so
	 * a publish without server side write-once does not typecheck into existence. The
	 * checksum is sent as well as compared, which means S3 verifies the bytes it received
	 * against the manifest's digest and rejects the upload itself if the body was
	 * truncated in transit.
	 */
	const put = (key: string, bodyPath: string, media: ObjectMedia, digestHex: string): PutResult => {
		const result = call(media.gzipped ? 'aws.put-object-gzip' : 'aws.put-object', [
			auth.bucket,
			key,
			bodyPath,
			media.contentType,
			hexToBase64(digestHex),
		]);
		if (result.status === 0) return { kind: 'ok' };
		if (PRECONDITION_FAILED.test(result.stderr)) return { kind: 'exists' };
		if (CONFLICT.test(result.stderr)) return { kind: 'conflict' };
		return refusal(`put-object on ${key}`, result);
	};

	return {
		head,
		list,
		get,
		put,
		get calls(): number {
			return calls;
		},
	};
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * The project config `runLint` is given when there is no project to read one from.
 *
 * `publish` is handed a compiled bundle directory and `prefetch` is handed a consuming
 * website: neither contains a `docs/site/docs.json`, and neither should, because the
 * thing they are reporting on is a bucket. Every value below is a placeholder, and
 * `checkFindings` is what makes that safe: `severityFor` in `runLint` pins a `CheckId`
 * to `error` before it reads the config at all, so a config that decides nothing cannot
 * decide anything wrongly.
 */
const NO_PROJECT_CONFIG: DocsProjectConfig = {
	docs: DOCS_CONFIG_VERSION,
	project: 'unknown',
	productName: 'unknown',
	repo: 'unknown/unknown',
	defaultAudience: DEFAULT_AUDIENCE,
	headingIds: 'slug',
	sections: [],
	i18n: { locales: ['en'], sourceLocale: 'en', parity: 'graceful' },
	budgets: DEFAULT_BUDGETS,
	code: { languages: [PLAIN_CODE_LANGUAGE] },
	toc: { enabled: true, maxDepth: 3, minHeadings: 3 },
	lint: { extends: 'house', maxDisables: 0 },
};

/**
 * Raw findings to reportable ones, for the two commands that talk to a bucket.
 *
 * It exists so nothing here hand assembles a `Finding`. Severity, category and
 * consequence are the registry's to decide, and a literal written at a call site is how
 * a check ends up with a consequence sentence nobody wrote and a category nothing groups
 * by. `kit/src/compile/bundle.ts` still builds two of them by hand, which predates this
 * and is the shape not to copy.
 *
 * The refusal is the load-bearing half. This function must only ever be handed a
 * `CheckId`, because a `LintRuleId` would resolve its severity against
 * `NO_PROJECT_CONFIG`, which is a config nobody wrote, and the answer would be that
 * rule's house default presented as if a project had chosen it. Refusing by name is
 * cheap and the alternative is silent.
 *
 * It lives in this module because `publish` and `prefetch` are its only two callers and
 * they have no other module in common. It is not an S3 concern; a third caller is the
 * signal to move it.
 */
export function checkFindings(entries: readonly RawFinding[], kitVersion: string): Finding[] {
	const checks = new Set<string>(CHECK_IDS);
	for (const entry of entries) {
		if (!checks.has(entry.rule)) {
			throw new Error(
				`checkFindings was given "${entry.rule}", which is not a CheckId. Its severity would ` +
					`be resolved against a placeholder project config, so the report would state a ` +
					`severity no project chose.`,
			);
		}
	}
	return runLint(entries, { config: NO_PROJECT_CONFIG, disables: [], kitVersion }).envelope
		.findings;
}
