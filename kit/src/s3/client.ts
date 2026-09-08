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
 */
const NO_CREDENTIALS =
	/Unable to locate credentials|ExpiredToken|InvalidClientTokenId|SignatureDoesNotMatch|security token included in the request is (?:expired|invalid)|The SSO session|Error when retrieving token|The config profile \(.*\) could not be found|UnrecognizedClientException/i;

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
	 * It is thrown for a hole carrying a shell metacharacter, and the values here are a
	 * bucket name from a flag, a key from a manifest and an output path built from a
	 * cache directory. A cache directory under a home directory with a space in it is
	 * the realistic one, and the honest report for it is a row naming the path, not a
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
		// A 404 from `head-object` means "not there" or "not permitted to know", because
		// S3 answers a caller without `s3:ListBucket` with a 404 rather than a 403. The
		// publisher's next step is the same either way: it puts the object with
		// `--if-none-match '*'`, which fails with a 412 if something is in fact there. So
		// this reads as absent and the precondition is what makes that safe.
		if (!NO_BUCKET.test(result.stderr) && NOT_FOUND.test(result.stderr)) return { kind: 'absent' };
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
