/**
 * `hexdocs publish`: a compiled bundle directory into a bucket, once, or not at all.
 *
 * CLI only, and the type is what enforces it: a command that declares `writes` cannot
 * carry a tool name, so there is no MCP surface here and the server needs no story about
 * undoing an upload.
 *
 * Three things make this different from `aws s3 sync`, and each of them is a defect the
 * sync would have shipped silently.
 *
 * **Every object carries a content type this repository decided, and the gzipped ones
 * carry `Content-Encoding`.** `s3 cp` takes index zero of `mimetypes.guess_type` and
 * throws the encoding half away, so a compressed page uploads undecodable and raw
 * markdown uploads as `binary/octet-stream`. `s3/keys.ts` holds the table and says what
 * a wrong header does to a reader.
 *
 * **Nothing is compared by size.** The AWS CLI's own sync strategy compares size and
 * last-modified and never content, which is exactly wrong for a write-once
 * commit-addressed store: a gzip member of identical length with different bytes would
 * then never be re-put and never be checked. Everything here compares
 * `head-object`'s `ChecksumSHA256`, which is base64 of the raw digest, against
 * `objects[].digest`, which is the same digest in hex. The conversion is explicit and
 * one-directional at each site, so the two spellings cannot be compared as strings.
 *
 * **The manifest goes last.** `bundle.ts` states the reason for the local writer and it
 * is the same here: a partial upload is then invisible rather than half-visible. A
 * reader that finds no manifest knows there is no bundle; a reader that finds one can
 * rely on every object it names being there. That ordering is also what makes the
 * preflight sound, because a matching manifest checksum means every object preceded it.
 *
 * Uploads are serial. `Exec` is synchronous by construction, one `spawnSync` at the
 * package's single spawn site, so roughly nine hundred objects at eighty to a hundred
 * and fifty milliseconds each is one to two minutes. Bounded concurrency would need an
 * async exec, which is a change to `kit/src/exec/run.ts` rather than to this file, and
 * it would buy a minute on a job that runs once per release.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
	checkRow,
	failedRow,
	notRunRow,
	skippedRow,
	type CheckRow,
} from '../../../src/contracts/diagnostics.js';
import {
	MANIFEST_KEY,
	bundlePrefix,
	type BundleManifest,
} from '../../../src/contracts/manifest.js';
import { verifyBundle } from '../compile/bundle.js';
import { sha256Hex, type JsonValue } from '../compile/serialise.js';
import { raw } from '../compile/types.js';
import type { RawFinding } from '../compile/types.js';
import { bundleManifestSchema } from '../contracts/bundle.schema.js';
import { defineCommand } from '../registry/command.js';
import {
	base64ToHex,
	checkFindings,
	s3Client,
	type HeadResult,
	type Refusal,
	type S3Client,
} from '../s3/client.js';
import { mediaFor, type ObjectMedia } from '../s3/keys.js';

import { BUCKET, bucketOf, PROFILE, REGION, regionOf } from './common.js';

/** How often the serial upload says something, so a two-minute job is not silent. */
const PROGRESS_EVERY = 50;

interface Mismatch {
	key: string;
	/** Hex, from the manifest. */
	expected: string;
	/** Hex, converted from what S3 returned, or `null` when S3 stored no checksum. */
	found: string | null;
}

interface Reconciliation {
	/** Manifest objects already present with exactly the digest the manifest records. */
	matched: string[];
	/** Manifest objects present with different bytes, or with no checksum to compare. */
	mismatched: Mismatch[];
	/** Manifest objects not under the prefix at all. */
	missing: string[];
	/** Objects under the prefix the manifest does not name. */
	stray: string[];
	refusal: Refusal | null;
}

/**
 * A listing's absolute keys, reduced to the bundle-relative spelling the manifest uses.
 *
 * The prefix filter is redundant against the one call that makes this listing, which
 * asks for `${prefix}/` and can return nothing else. It is here because the trailing
 * slash is what makes that true: S3 matches a list prefix as a string, so dropping it
 * would return `<prefix>-old/manifest.json` as well, and this function would then hand
 * back a key with a leading fragment of another bundle's name.
 */
function storedKeys(keys: readonly string[], prefix: string): Set<string> {
	return new Set(
		keys.filter((key) => key.startsWith(`${prefix}/`)).map((key) => key.slice(prefix.length + 1)),
	);
}

/**
 * What is already there, compared object by object.
 *
 * `present` is the single `list-objects-v2` walk this command makes, already reduced to
 * bundle-relative keys, and it is handed in rather than taken here because the preflight
 * needs the same answer. Two walks would be two ideas of what is under the prefix, and
 * the case where they disagree is the one nobody would think to write a test for.
 *
 * The digest comparison costs one `head-object` per key that does exist, and only for
 * those: a first publish into an empty prefix makes zero head calls. A re-publish of the
 * same sha is where the cost lands, and that is the case the preflight short circuits
 * before this function is ever called.
 */
function reconcile(
	client: S3Client,
	prefix: string,
	manifest: BundleManifest,
	present: ReadonlySet<string>,
): Reconciliation {
	const named = new Set(manifest.objects.map((object) => object.key));
	const stray = [...present].filter((key) => key !== MANIFEST_KEY && !named.has(key)).sort();

	const matched: string[] = [];
	const mismatched: Mismatch[] = [];
	const missing: string[] = [];

	for (const object of manifest.objects) {
		if (!present.has(object.key)) {
			missing.push(object.key);
			continue;
		}
		const head = client.head(`${prefix}/${object.key}`);
		if (head.kind === 'refused') {
			return { matched, mismatched, missing, stray, refusal: head };
		}
		if (head.kind === 'absent') {
			// The listing said it was there and the head says it is not. Treat it as
			// missing rather than as an error: the put that follows carries
			// `--if-none-match '*'`, so if something is in fact there it fails the
			// precondition rather than overwriting.
			missing.push(object.key);
			continue;
		}
		const found = head.checksumSha256 === null ? null : base64ToHex(head.checksumSha256);
		if (found === object.digest) matched.push(object.key);
		else mismatched.push({ key: object.key, expected: object.digest, found });
	}

	return { matched, mismatched, missing, stray, refusal: null };
}

/** A mismatch, as the finding a report carries. */
function mismatchFinding(entry: Mismatch): RawFinding {
	return entry.found === null
		? raw(
				'bundle-digest-mismatch',
				{ kind: 'file', file: entry.key },
				null,
				`${entry.key} is already stored, and S3 holds no SHA-256 checksum for it, so its bytes cannot be compared with the ${entry.expected.slice(0, 12)} the manifest records.`,
				{
					remediation:
						'Something other than this publisher wrote that key. Delete it, or publish this commit under a fresh prefix by recompiling at a new AST major. Nothing here compares sizes as a fallback, because two gzip members of the same length can differ in every byte.',
				},
			)
		: raw(
				'bundle-digest-mismatch',
				{ kind: 'file', file: entry.key },
				null,
				`${entry.key} is already stored with digest ${entry.found.slice(0, 12)} and this bundle expects ${entry.expected.slice(0, 12)}.`,
				{
					remediation:
						'A bundle is a product of a commit and nothing else, so the same sha must compile to the same bytes. Recompile the commit and compare, rather than repairing the object in place.',
				},
			);
}

/**
 * The remote manifest's `generator`, fetched into a throwaway directory.
 *
 * Called on exactly one path: every object under the prefix is already present with the
 * digest this bundle expects, and only `manifest.json` differs. That shape has one
 * ordinary cause. `manifest.generator` is the kit version and it lives inside the
 * manifest bytes, so republishing an old sha after a submodule bump finds every object
 * identical and the manifest different, and a bare digest mismatch sends an operator
 * looking for a non-deterministic compile that is not there.
 *
 * The temporary directory is written directly rather than through `Ctx.write` because
 * `s3api get-object` writes the file itself and takes the path as an argument. It is
 * removed in a `finally`. `publish` is CLI only, so there is no context here in which
 * writing to a temporary directory is a boundary violation.
 *
 * The digest comes back as well as the generator, and it is not redundant. The preflight
 * can also reach this path because S3 held **no** checksum for the stored manifest, which
 * is a comparison that could not be made rather than one that failed, and the digest is
 * the only thing that tells those two apart.
 *
 * Returns `null` when the fetch or the parse failed, and the caller then reports the
 * shape without naming a version, which is the honest fallback.
 */
function remoteManifest(
	client: S3Client,
	prefix: string,
): { generator: string | null; digest: string } | null {
	const directory = mkdtempSync(join(tmpdir(), 'hexdocs-publish-'));
	try {
		const path = join(directory, MANIFEST_KEY);
		if (client.get(`${prefix}/${MANIFEST_KEY}`, path).kind !== 'ok') return null;
		const bytes = readFileSync(path);
		const parsed = JSON.parse(bytes.toString('utf8')) as { generator?: unknown };
		return {
			generator: typeof parsed.generator === 'string' ? parsed.generator : null,
			digest: sha256Hex(bytes),
		};
	} catch {
		return null;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export const publish = defineCommand({
	name: 'publish',
	tool: null,
	writes: 'network',
	summary: 'Upload a compiled bundle to its commit-addressed prefix, once.',
	detail:
		'Verifies the local bundle first and refuses on any failing row, then compares every object against what the bucket already holds by SHA-256 digest and never by size, then uploads what is missing with the right content type and encoding, manifest last. A re-run on the same commit writes nothing and exits 0. Every key is uploaded with --if-none-match, so an object that already exists with different bytes is refused by S3 as well as here.',
	params: {
		bundle: {
			help: 'the compiled bundle directory: the ast-N directory hexdocs build wrote',
			type: 'string',
			required: true,
		},
		bucket: BUCKET,
		region: REGION,
		profile: PROFILE,
	},
	positionals: ['bundle'],
	taughtBy: ['docs-publish-version'],
	// `async` because `Command.run` is, and nothing here awaits: `Exec` is synchronous, so
	// the whole publish is one straight line of `spawnSync` calls.
	async run(input, ctx) {
		const directory = resolve(ctx.cwd, input.bundle);

		// The local gate comes first and it is unconditional. Everything after this point
		// costs network calls against a store that will never let the bytes be replaced,
		// so a bundle that does not match its own manifest must never reach it.
		const verified = verifyBundle(directory);
		if (verified.some((row) => row.status === 'fail' || row.status === 'not-run')) {
			return {
				data: { directory, published: false, why: 'the local bundle did not verify' },
				lines: [`${directory} did not verify. Nothing was uploaded.`],
				envelope: null,
				rows: verified,
			};
		}

		const manifestPath = join(directory, MANIFEST_KEY);
		const parsed = bundleManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, 'utf8')));
		if (!parsed.success) {
			// Unreachable while `verifyBundle` passes, since it parses the same file with the
			// same schema. It is here rather than as a non-null assertion because the two
			// reads are separate and a future change to either could part them.
			return {
				data: { directory, published: false, why: 'the manifest did not parse' },
				lines: [],
				envelope: null,
				rows: [
					...verified,
					failedRow(
						'publish-preflight',
						1,
						'manifests',
						`${MANIFEST_KEY} verified and then failed to parse, which means verifyBundle and this command disagree about the same file.`,
					),
				],
			};
		}
		const manifest: BundleManifest = parsed.data;
		const manifestDigest = sha256Hex(readFileSync(manifestPath));
		const prefix = bundlePrefix(manifest.project, manifest.commit, manifest.ast);

		// Every key resolved to a content type before anything is uploaded, so an
		// unrecognised key shape is a refusal rather than an object served as something
		// the browser cannot use. `mediaFor` returns null rather than guessing, which is
		// the whole reason it exists.
		const media = new Map<string, ObjectMedia>();
		const unresolved: string[] = [];
		for (const key of [...manifest.objects.map((object) => object.key), MANIFEST_KEY]) {
			const resolved = mediaFor(key);
			if (resolved === null) unresolved.push(key);
			else media.set(key, resolved);
		}
		const mediaRow: CheckRow =
			unresolved.length > 0
				? failedRow(
						'publish-media',
						media.size,
						'object keys',
						`No content type is declared for ${unresolved.length} key(s), starting with ${unresolved[0] ?? ''}. Uploading one with a guessed type is the AWS CLI defect this publisher exists to avoid, so nothing was uploaded.`,
					)
				: checkRow('publish-media', media.size, 'object keys', []);
		if (mediaRow.status !== 'pass') {
			return {
				data: { prefix, published: false, unresolved: unresolved.length },
				lines: [],
				envelope: null,
				rows: [...verified, mediaRow],
			};
		}

		const resolvedBucket = bucketOf(input.bucket);
		if ('why' in resolvedBucket) {
			return {
				data: { prefix, published: false, why: resolvedBucket.why },
				lines: [],
				envelope: null,
				rows: [
					...verified,
					mediaRow,
					notRunRow('publish-preflight', 'manifests', resolvedBucket.why),
				],
			};
		}

		const client = s3Client(
			ctx.exec,
			{ bucket: resolvedBucket.bucket, region: regionOf(input.region), profile: input.profile },
			ctx.cwd,
		);

		const stop = (rows: readonly CheckRow[], why: string): ReturnType<typeof output> =>
			output([...verified, mediaRow, ...rows], { prefix, published: false, why }, [why]);

		// ---- preflight ------------------------------------------------------
		//
		// The listing comes first, and that ordering is the whole of this block.
		//
		// S3 answers a head on a key that is not there with 404 rather than 403 only for a
		// caller holding `s3:ListBucket`, and the publisher role grants that under a
		// `StringLike` on `s3:prefix`. A HeadObject request carries no value for that key, an
		// absent key makes the condition false, and a statement whose condition is false does
		// not apply. So heading first meant the role that exists to publish would read its own
		// empty prefix as an access denial, on its first run and only on its first run.
		//
		// That last clause is why this is not a thing to leave and see. Publish the manifest
		// once by any other route, including a laptop signing as somebody else, and the head
		// answers 200 on `s3:GetObject` alone: the permission the publisher actually depends
		// on is never exercised again, and the run that proves the wiring proves it for the
		// wrong reason.
		//
		// `list-objects-v2` sends the prefix as a request parameter, so it is the one call
		// here whose request context carries the key the policy conditions on, and it answers
		// the only question the preflight was asking: is a manifest already stored here. The
		// head that follows runs only on a key the listing named, where 404 cannot arise and
		// `s3:GetObject` is the whole permission.
		const listed = client.list(`${prefix}/`);
		if (listed.kind === 'refused') {
			return stop(
				[
					listed.credentials
						? notRunRow('publish-preflight', 'manifests', listed.why)
						: failedRow('publish-preflight', 0, 'manifests', listed.why),
				],
				listed.why,
			);
		}
		const present = storedKeys(listed.keys, prefix);

		const preflight: HeadResult = present.has(MANIFEST_KEY)
			? client.head(`${prefix}/${MANIFEST_KEY}`)
			: { kind: 'absent' };
		if (preflight.kind === 'refused') {
			return stop(
				[
					preflight.credentials
						? notRunRow('publish-preflight', 'manifests', preflight.why)
						: failedRow('publish-preflight', 0, 'manifests', preflight.why),
				],
				preflight.why,
			);
		}

		// Both calls answered, so the row is reported on every path below rather than only on
		// the one that short circuits. A report whose row set changes with the answer is one
		// nobody can compare two runs of.
		const preflightRow = checkRow('publish-preflight', 1, 'manifests', []);

		if (preflight.kind === 'present') {
			const found =
				preflight.checksumSha256 === null ? null : base64ToHex(preflight.checksumSha256);
			if (found === manifestDigest) {
				// The idempotent path, and the only one that needs no further calls. The
				// manifest is written last, so a manifest with these bytes means every object
				// it names went up before it.
				const reason =
					'The manifest is already stored with identical bytes. It is uploaded last, so every object it names was published before it.';
				return output(
					[
						...verified,
						mediaRow,
						preflightRow,
						skippedRow('publish-reconcile', 'objects', reason),
						skippedRow('publish-upload', 'objects', reason),
					],
					{ prefix, published: true, skipped: true, written: 0, unchanged: 0, reason },
					[`${prefix} is already published. Nothing was uploaded.`],
				);
			}
		}

		// ---- reconcile ------------------------------------------------------

		const state = reconcile(client, prefix, manifest, present);
		if (state.refusal !== null) {
			return stop(
				[
					preflightRow,
					state.refusal.credentials
						? notRunRow('publish-reconcile', 'objects', state.refusal.why)
						: failedRow('publish-reconcile', state.matched.length, 'objects', state.refusal.why),
				],
				state.refusal.why,
			);
		}

		const problems: RawFinding[] = state.mismatched.map(mismatchFinding);
		for (const key of state.stray) {
			problems.push(
				raw(
					'bundle-missing-object',
					{ kind: 'file', file: key },
					null,
					`${key} is stored under this prefix and the manifest does not name it.`,
					{
						remediation:
							'A prefix holds one bundle and the manifest is the authority on what is in it. A stray object is the trace of an abandoned upload of different content, so establish which commit wrote it before deleting it.',
					},
				),
			);
		}

		// The manifest differs and every object it names is already correct. Naming that
		// shape is the difference between an actionable message and a digest an operator
		// has to go looking for.
		const contentIdentical =
			state.mismatched.length === 0 && state.missing.length === 0 && state.stray.length === 0;
		if (preflight.kind === 'present' && contentIdentical) {
			const published = remoteManifest(client, prefix);
			const why =
				published === null
					? `Every object under ${prefix} is already stored with the digest this bundle expects, and only ${MANIFEST_KEY} differs. The manifest carries the toolchain version, so this is a toolchain change rather than a content change; the stored manifest could not be read to name which one.`
					: published.digest === manifestDigest
						? `${prefix} is already published with exactly these bytes, and S3 holds no SHA-256 checksum for the stored ${MANIFEST_KEY}, so the preflight had nothing to compare. Something other than this publisher wrote that key: every put here sends a checksum.`
						: published.generator === manifest.generator
							? `Every object under ${prefix} is already stored with the digest this bundle expects, and only ${MANIFEST_KEY} differs, with the same toolchain (${manifest.generator}) on both sides. That is a manifest field derived from something outside the objects, such as nav order, changing under a published sha.`
							: `The toolchain changed, not the content: kit ${published.generator ?? 'of an unrecorded version'} published this sha, this is kit ${manifest.generator}. Every object is byte identical and only ${MANIFEST_KEY} differs, because the manifest records the toolchain that wrote it.`;
			return stop(
				[preflightRow, failedRow('publish-reconcile', manifest.objects.length, 'objects', why)],
				why,
			);
		}

		const reconcileRow = checkRow(
			'publish-reconcile',
			manifest.objects.length,
			'objects',
			checkFindings(problems, ctx.kitVersion),
			`${state.matched.length} already stored, ${state.missing.length} to upload.`,
		);
		if (reconcileRow.status !== 'pass') {
			return output(
				[
					...verified,
					mediaRow,
					preflightRow,
					reconcileRow,
					notRunRow(
						'publish-upload',
						'objects',
						'The prefix already holds content this bundle disagrees with, so nothing was uploaded.',
					),
				],
				{
					prefix,
					published: false,
					mismatched: state.mismatched.length,
					stray: state.stray.length,
				},
				[`${prefix} already holds content this bundle disagrees with. Nothing was uploaded.`],
			);
		}

		// ---- upload ---------------------------------------------------------

		const written: string[] = [];
		// A list rather than a nullable, because the assignment happens inside `upload` and
		// TypeScript does not track a `let` written from a closure: a `Refusal | null` read
		// after the loop narrows to `null` and every field access on it is an error about a
		// type of `never`. One entry is all this ever holds; the loop stops at the first.
		const failures: Refusal[] = [];
		// Iterated from `manifest.objects` rather than from the key list, so the digest
		// travels with the key it belongs to. A separate lookup would need a fallback for
		// a key with no record, and the only fallback available is an empty digest, which
		// S3 would reject with a message about base64 rather than about the bundle.
		const missing = new Set(state.missing);
		const queue = manifest.objects.filter((object) => missing.has(object.key));

		const upload = (key: string, digest: string): boolean => {
			const local = join(directory, ...key.split('/'));
			if (!existsSync(local)) {
				failures.push({
					kind: 'refused',
					why: `${key} is named by the manifest and is not in ${directory}.`,
					credentials: false,
				});
				return false;
			}
			const resolved = media.get(key);
			if (resolved === undefined) return false;

			let result = client.put(`${prefix}/${key}`, local, resolved, digest);
			// S3's own guidance for a 409 on a conditional write is to retry, because it
			// means two writers raced on the same key rather than that the key is taken.
			// One retry, so a genuine conflict surfaces instead of looping.
			if (result.kind === 'conflict')
				result = client.put(`${prefix}/${key}`, local, resolved, digest);

			if (result.kind === 'ok') {
				written.push(key);
				return true;
			}
			if (result.kind === 'exists') {
				// The listing said this key was free and the precondition says it is not, so
				// something wrote it since the reconcile. Comparing digests is the only safe
				// answer: identical bytes are a no-op, and anything else is the refusal.
				const head = client.head(`${prefix}/${key}`);
				if (head.kind === 'present') {
					const found = head.checksumSha256 === null ? null : base64ToHex(head.checksumSha256);
					if (found === digest) return true;
					failures.push({
						kind: 'refused',
						why: `${key} was written by something else during this publish, with ${found ?? 'no stored checksum'} where this bundle expects ${digest.slice(0, 12)}.`,
						credentials: false,
					});
					return false;
				}
			}
			failures.push(
				result.kind === 'refused'
					? result
					: {
							kind: 'refused',
							why: `put-object on ${key} answered ${result.kind}.`,
							credentials: false,
						},
			);
			return false;
		};

		let done = 0;
		for (const object of queue) {
			if (!upload(object.key, object.digest)) break;
			done += 1;
			if (done % PROGRESS_EVERY === 0) ctx.log(`  ${done} of ${queue.length} object(s) uploaded`);
		}

		// The manifest goes last and only if every object went up, which is what makes a
		// partial upload invisible: a reader that finds no manifest knows there is no
		// bundle here.
		if (failures.length === 0 && done === queue.length) upload(MANIFEST_KEY, manifestDigest);

		const failure = failures[0];
		if (failure !== undefined) {
			const row = failure.credentials
				? notRunRow('publish-upload', 'objects', failure.why)
				: failedRow('publish-upload', written.length, 'objects', failure.why);
			return output(
				[...verified, mediaRow, preflightRow, reconcileRow, row],
				{ prefix, published: false, written: written.length, why: failure.why },
				[
					`${written.length} object(s) were uploaded before this stopped. The manifest was not, so the prefix holds no bundle.`,
				],
			);
		}

		return output(
			[
				...verified,
				mediaRow,
				preflightRow,
				reconcileRow,
				checkRow(
					'publish-upload',
					written.length + state.matched.length,
					'objects',
					[],
					`${written.length} uploaded, ${state.matched.length} already stored.`,
				),
			],
			{
				prefix,
				published: true,
				skipped: false,
				written: written.length,
				unchanged: state.matched.length,
				calls: client.calls,
			},
			[
				`${prefix}: ${written.length} object(s) uploaded, ${state.matched.length} already stored, ` +
					`${client.calls} AWS call(s).`,
			],
		);
	},
});

/** The one shape every return above takes, so a field cannot be forgotten on one path. */
function output(
	rows: readonly CheckRow[],
	data: JsonValue,
	lines: readonly string[],
): { data: JsonValue; lines: readonly string[]; envelope: null; rows: readonly CheckRow[] } {
	return { data, lines, envelope: null, rows };
}
