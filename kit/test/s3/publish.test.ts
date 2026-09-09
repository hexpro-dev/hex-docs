/**
 * `hexdocs publish`, driven against a recording fake `Exec`. Nothing here reaches a
 * network, and nothing here needs credentials.
 *
 * **What that does and does not prove.** The fake fills the same recipe templates
 * `runRecipe` fills, from `kit/src/exec/recipes.ts`, so every argv asserted below is the
 * argv `spawnSync` would have been handed: a flag deleted from a template fails here. What
 * the fake supplies in return is my reading of the AWS CLI, taken from its error strings
 * and its `s3api` output shapes, and a fake that agrees with my reading of a tool is not
 * that tool.
 *
 * **Three claims that were unproved here are now measured, and step 6 measured them
 * against the real bucket.** S3 answers a second write to an existing key under
 * `--if-none-match '*'` with `An error occurred (PreconditionFailed) ... At least one of
 * the pre-conditions you specified did not hold`, which is what `PRECONDITION_FAILED`
 * matches. `head-object` returns the same base64 the put sent, so a re-publish of an
 * unchanged commit reconciles to zero uploads. And the bucket policy's own deny answers an
 * unconditional put with `AccessDenied ... with an explicit deny in a resource-based
 * policy`, to the account root user, which is the write-once guarantee holding against the
 * strongest principal in the account.
 *
 * One claim from that list is still open, and it is worth keeping open: whether
 * `--checksum-sha256` is compared server side against the body rather than stored as a
 * label. Proving it needs a deliberately wrong digest, and the run that would prove it
 * writes an object at a real key in a store where nothing can then delete it.
 *
 * Step 6 also found what a fake cannot: every test here injects an `Exec` and none of them
 * reaches `runRecipe`, which refused `text/plain; charset=utf-8` outright. See the comment
 * on `REFUSED_IN_ARGV` in `kit/src/exec/run.ts`.
 *
 * This is row 7 of the failure catalogue: a publish overwriting a labelled bundle. The
 * mutation that must turn it red is dropping `--if-none-match` from the put recipe, and
 * the pinned argv below is what catches it.
 *
 * The bundle is the fixture corpus compiled once and written once. A hand-built manifest
 * would have made every count here a literal, and the two properties worth the most,
 * the manifest going last and a second run writing nothing, are only visible against a
 * bundle with enough objects for "last" to mean something.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus } from '../../../fixtures/index.js';
import type { CheckRow } from '../../../src/contracts/diagnostics.js';
import {
	MANIFEST_KEY,
	bundlePrefix,
	type BundleManifest,
} from '../../../src/contracts/manifest.js';
import { buildBundle, type WrittenObject } from '../../src/compile/build.js';
import { verifyBundle, writeBundle } from '../../src/compile/bundle.js';
import { sha256Hex } from '../../src/compile/serialise.js';
import { ALL_RECIPES, HOLE, type Recipe, type RecipeId } from '../../src/exec/recipes.js';
import { ExecRefusal, type Exec, type RunResult } from '../../src/exec/run.js';
import { exitCodeFor, invoke, type Ctx } from '../../src/registry/command.js';
import { LIST_PAGE_SIZE, base64ToHex, hexToBase64, s3Client } from '../../src/s3/client.js';
import { publish } from '../../src/commands/publish.js';

const BUCKET = 'hexdocs-fixture-bucket';
const REGION = 'ap-southeast-2';
const PROFILE = 'hexdocs-fixture-profile';
const KIT_VERSION = '@hex-pro/docs-kit@0.0.0';

// ---------------------------------------------------------------------------
// The recording fake
// ---------------------------------------------------------------------------

interface Recorded {
	readonly id: RecipeId;
	readonly holes: readonly string[];
	/** Exactly what `runRecipe` would hand `spawnSync`, with the binary first. */
	readonly argv: readonly string[];
	/** What `withAuth` had in the environment at the moment of the call. */
	readonly env: { region: string | undefined; profile: string | undefined };
}

/**
 * Fills a recipe the way `runRecipe` does, and refuses the same arity mismatch.
 *
 * Written against `ALL_RECIPES` rather than against a copy of the argv, which is the
 * whole point: the assertions below pin the filled result, so a template that loses a
 * flag produces a different array here and the diff names the flag.
 *
 * The one thing it does not model is `runRecipe`'s own refusal. No hole in this
 * file carries one, and the arm that turns an `ExecRefusal` into a row is exercised
 * separately by the client's own caller.
 */
function fill(id: RecipeId, holes: readonly string[]): string[] {
	const recipe = ALL_RECIPES[id] as Recipe;
	const argv: string[] = [recipe.bin];
	let next = 0;
	for (const slot of recipe.argv) {
		if (slot !== HOLE) {
			argv.push(slot);
			continue;
		}
		const value = holes[next];
		next += 1;
		if (value === undefined) throw new Error(`recipe "${id}" was given too few values`);
		argv.push(value);
	}
	if (next !== holes.length) throw new Error(`recipe "${id}" was given too many values`);
	return argv;
}

const NOT_FOUND_STDERR = 'An error occurred (404) when calling the HeadObject operation: Not Found';
const PRECONDITION_STDERR =
	'An error occurred (PreconditionFailed) when calling the PutObject operation: At least one of the pre-conditions you specified did not hold';
const CONFLICT_STDERR =
	'An error occurred (ConditionalRequestConflict) when calling the PutObject operation: A conflicting conditional operation is currently in progress';

/** What S3 stores for one key: the bytes, and the checksum the writer sent with them. */
interface StoredObject {
	bytes: Buffer;
	checksum: string | null;
}

class FakeS3 {
	readonly calls: Recorded[] = [];
	readonly objects = new Map<string, StoredObject>();
	/** Present in the store and withheld from `list-objects-v2`: written since the reconcile. */
	readonly hiddenFromList = new Set<string>();
	/** Keys whose put answers 412, whatever the listing said. */
	readonly refusePut = new Set<string>();
	/** Keys whose first put answers 409 and whose second succeeds. */
	readonly conflictOnce = new Set<string>();
	/** When set, the listing answers in pages of this size. */
	pageSize: number | null = null;
	/** Which continuation field the listing answers with. */
	tokenField: 'NextToken' | 'NextContinuationToken' = 'NextToken';
	/** Truncate and report no token: the unpaginated call, reproduced. */
	dropToken = false;
	/** Every call fails with this on stderr. Used for the credentials arm. */
	failWith: string | null = null;

	put(key: string, bytes: Buffer): void {
		// Base64 of the raw digest, computed here rather than through `hexToBase64`: this
		// stands in for S3, which has never heard of that helper, and a fake that reused it
		// would agree with a broken conversion in both directions.
		const checksum = Buffer.from(sha256Hex(bytes), 'hex').toString('base64');
		this.objects.set(key, { bytes, checksum });
	}

	of(id: RecipeId): Recorded[] {
		return this.calls.filter((call) => call.id === id);
	}

	puts(): Recorded[] {
		return [...this.of('aws.put-object'), ...this.of('aws.put-object-gzip')];
	}

	/** Put keys in call order, which is what "the manifest goes last" is a statement about. */
	putKeys(): string[] {
		return this.calls
			.filter((call) => call.id === 'aws.put-object' || call.id === 'aws.put-object-gzip')
			.map((call) => call.holes[1] ?? '');
	}

	readonly exec: Exec = (id, holes) => {
		this.calls.push({
			id,
			holes: [...holes],
			argv: fill(id, holes),
			env: { region: process.env['AWS_REGION'], profile: process.env['AWS_PROFILE'] },
		});
		if (this.failWith !== null) return { status: 255, stdout: '', stderr: this.failWith };
		return this.answer(id, holes);
	};

	private answer(id: RecipeId, holes: readonly string[]): RunResult {
		const key = holes[1] ?? '';
		if (id === 'aws.head-object') {
			const found = this.objects.get(key);
			if (found === undefined) return { status: 255, stdout: '', stderr: NOT_FOUND_STDERR };
			return {
				status: 0,
				stdout: JSON.stringify({
					ChecksumSHA256: found.checksum,
					ContentLength: found.bytes.length,
				}),
				stderr: '',
			};
		}
		if (id === 'aws.list-objects' || id === 'aws.list-objects-page') {
			return this.list(holes);
		}
		if (id === 'aws.get-object') {
			const found = this.objects.get(key);
			if (found === undefined) return { status: 255, stdout: '', stderr: NOT_FOUND_STDERR };
			const out = holes[2] ?? '';
			mkdirSync(join(out, '..'), { recursive: true });
			writeFileSync(out, found.bytes);
			return { status: 0, stdout: '{}', stderr: '' };
		}
		// A put, of one shape or the other.
		if (this.refusePut.has(key)) return { status: 255, stdout: '', stderr: PRECONDITION_STDERR };
		if (this.conflictOnce.has(key)) {
			this.conflictOnce.delete(key);
			return { status: 255, stdout: '', stderr: CONFLICT_STDERR };
		}
		const body = readFileSync(holes[2] ?? '');
		this.objects.set(key, { bytes: body, checksum: holes[4] ?? null });
		return { status: 0, stdout: '{}', stderr: '' };
	}

	private list(holes: readonly string[]): RunResult {
		const prefix = holes[1] ?? '';
		const token = holes[3];
		const keys = [...this.objects.keys()]
			.filter((key) => key.startsWith(prefix) && !this.hiddenFromList.has(key))
			.sort();
		const from = token === undefined ? 0 : Number(token);
		const size = this.pageSize ?? keys.length;
		const slice = keys.slice(from, from + size);
		const more = from + size < keys.length;
		const body: Record<string, unknown> = { Contents: slice.map((key) => ({ Key: key })) };
		if (more && !this.dropToken) body[this.tokenField] = String(from + size);
		return { status: 0, stdout: JSON.stringify(body), stderr: '' };
	}
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

let root: string;
let bundleOut: string;
let directory: string;
let manifest: BundleManifest;
let objects: WrittenObject[];
let prefix: string;
let manifestDigest: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'hexdocs-publish-'));
	const corpus = materialiseCorpus(join(root, 'repo'));
	const built = buildBundle(corpus.root, { generator: KIT_VERSION });
	expect(built.manifestProblems).toEqual([]);
	manifest = built.manifest;
	objects = built.objects;
	bundleOut = join(root, 'out');
	mkdirSync(bundleOut, { recursive: true });
	directory = writeBundle(bundleOut, manifest, objects).prefix;
	prefix = bundlePrefix(manifest.project, manifest.commit, manifest.ast);
	manifestDigest = sha256Hex(readFileSync(join(directory, MANIFEST_KEY)));
	// Below the pagination page size on purpose: every list test here sets its own smaller
	// page size, because a corpus large enough to need two real pages would take minutes to
	// compile. What is being proved is that the loop follows a token, not that S3 emits one.
	expect(manifest.objects.length).toBeGreaterThan(50);
	expect(manifest.objects.length).toBeLessThan(LIST_PAGE_SIZE);
}, 120_000);

afterAll(() => {
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function context(fake: FakeS3, logged: string[]): Ctx {
	return {
		cwd: root,
		kitVersion: KIT_VERSION,
		exec: fake.exec,
		// `publish` is CLI only and reaches no `Writer`: the bundle it uploads was written by
		// `build`, and `s3api get-object` writes its own file. `null` is what the MCP context
		// carries, and this command cannot be reached from there at all.
		write: null,
		now: () => new Date('2026-05-01T00:00:00Z'),
		log: (line) => logged.push(line),
	};
}

interface Outcome {
	rows: readonly CheckRow[];
	data: Record<string, unknown>;
	code: number;
	lines: readonly string[];
	/** Everything the run put on stderr, so progress is measured rather than assumed. */
	logged: readonly string[];
}

async function run(fake: FakeS3): Promise<Outcome> {
	const logged: string[] = [];
	const output = await invoke(
		publish,
		{ bundle: directory, bucket: BUCKET, profile: PROFILE },
		context(fake, logged),
	);
	return {
		rows: output.rows,
		data: output.data as Record<string, unknown>,
		code: exitCodeFor(output),
		lines: output.lines,
		logged,
	};
}

function row(outcome: Outcome, id: string): CheckRow {
	const found = outcome.rows.find((entry) => entry.id === id);
	if (found === undefined) {
		throw new Error(`no ${id} row in [${outcome.rows.map((entry) => entry.id).join(', ')}]`);
	}
	return found;
}

/**
 * Every object of this bundle already stored, and no manifest.
 *
 * The manifest is deliberately absent: with it present and matching, the preflight short
 * circuits and nothing is listed at all, which is right and is the wrong starting state
 * for any test about the listing or the reconcile.
 */
function seedObjects(fake: FakeS3): void {
	for (const object of manifest.objects) {
		fake.put(`${prefix}/${object.key}`, readFileSync(join(directory, ...object.key.split('/'))));
	}
}

/** The same bytes with one bit different, so length is identical and the digest is not. */
function flipped(key: string): Buffer {
	const bytes = Buffer.from(readFileSync(join(directory, ...key.split('/'))));
	const last = bytes.length - 1;
	bytes[last] = (bytes[last] ?? 0) ^ 0x01;
	return bytes;
}

// ---------------------------------------------------------------------------
// The argv
// ---------------------------------------------------------------------------

describe('the exact argv of a first publish', () => {
	let fake: FakeS3;
	let outcome: Outcome;

	beforeAll(async () => {
		fake = new FakeS3();
		outcome = await run(fake);
	});

	test('it publishes, and the report says how much went up', () => {
		expect(outcome.code).toBe(0);
		expect(outcome.data['published']).toBe(true);
		expect(outcome.data['written']).toBe(manifest.objects.length + 1);
		expect(outcome.data['unchanged']).toBe(0);
		expect(outcome.rows.every((entry) => entry.status === 'pass')).toBe(true);
	});

	test('the preflight is a listing, and it is the first call', () => {
		// Everything after it costs a call against a store that will never let the bytes be
		// replaced, so the cheap question has to come first. That it is a listing rather
		// than a head is the load-bearing half: the publisher role holds `s3:ListBucket`
		// only under a `StringLike` on `s3:prefix`, a HeadObject request carries no value
		// for that key, and S3 answers a head on an absent key with 403 rather than 404 for
		// a caller without ListBucket. Heading first therefore refused the role its own
		// empty prefix on a first publish, and on a first publish only, which is the shape
		// of defect a second run would have hidden for good.
		expect(fake.calls[0]?.argv).toEqual([
			'aws',
			's3api',
			'list-objects-v2',
			'--bucket',
			BUCKET,
			'--prefix',
			`${prefix}/`,
			'--max-items',
			String(LIST_PAGE_SIZE),
			'--output',
			'json',
		]);
	});

	test('one listing, one page, and not a single head, because the prefix is empty', () => {
		expect(fake.of('aws.list-objects')).toHaveLength(1);
		expect(fake.of('aws.list-objects-page')).toHaveLength(0);
		// Zero heads, and the number is the point. The manifest head is skipped because the
		// listing did not name it, and the per-object heads are skipped because a digest
		// comparison against an empty prefix is ninety-two calls answering a question the
		// listing already settled. A first publish now asks S3 exactly one thing before it
		// starts writing.
		expect(fake.of('aws.head-object')).toHaveLength(0);
	});

	test('a gzipped page carries its type, its encoding, its checksum and the precondition', () => {
		const key = 'pages/en/index.json.gz';
		const record = manifest.objects.find((object) => object.key === key);
		if (record === undefined) throw new Error(`the corpus has no ${key}`);
		const call = fake.puts().find((entry) => entry.holes[1] === `${prefix}/${key}`);

		expect(call?.id).toBe('aws.put-object-gzip');
		expect(call?.argv).toEqual([
			'aws',
			's3api',
			'put-object',
			'--bucket',
			BUCKET,
			'--key',
			`${prefix}/${key}`,
			'--body',
			join(directory, 'pages', 'en', 'index.json.gz'),
			'--content-type',
			'application/json',
			'--content-encoding',
			'gzip',
			'--cache-control',
			'public, max-age=31536000, immutable',
			'--checksum-sha256',
			// Spelled out rather than taken from `hexToBase64`, which is the function under
			// test here: an expectation built by the code it checks agrees with itself, and
			// this one caught a `hexToBase64` rewritten to encode the ascii of the hex.
			Buffer.from(record.digest, 'hex').toString('base64'),
			'--if-none-match',
			'*',
			'--output',
			'json',
		]);
	});

	test('the checksum is base64 of the manifest hex, converted rather than passed through', () => {
		// The two spellings are the same bytes and no string comparison relates them, so the
		// conversion is the whole of the correctness here. A publisher that sent the hex would
		// have S3 reject every object with a message about base64, which is loud; one that
		// sent base64 of the *ascii* hex would be accepted and would never match again.
		const key = 'pages/en/index.json.gz';
		const record = manifest.objects.find((object) => object.key === key);
		const call = fake.puts().find((entry) => entry.holes[1] === `${prefix}/${key}`);
		const sent = call?.holes[4] ?? '';

		expect(record?.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(sent).not.toBe(record?.digest);
		expect(Buffer.from(sent, 'base64')).toHaveLength(32);
		expect(base64ToHex(sent)).toBe(record?.digest);
		expect(sent).not.toBe(Buffer.from(record?.digest ?? '', 'utf8').toString('base64'));
	});

	test('an uncompressed text object uses the plain put and no content encoding', () => {
		const key = 'llms/en.txt';
		const record = manifest.objects.find((object) => object.key === key);
		if (record === undefined) throw new Error(`the corpus has no ${key}`);
		const call = fake.puts().find((entry) => entry.holes[1] === `${prefix}/${key}`);

		expect(call?.id).toBe('aws.put-object');
		expect(call?.argv).toEqual([
			'aws',
			's3api',
			'put-object',
			'--bucket',
			BUCKET,
			'--key',
			`${prefix}/${key}`,
			'--body',
			join(directory, 'llms', 'en.txt'),
			'--content-type',
			'text/plain; charset=utf-8',
			'--cache-control',
			'public, max-age=31536000, immutable',
			'--checksum-sha256',
			Buffer.from(record.digest, 'hex').toString('base64'),
			'--if-none-match',
			'*',
			'--output',
			'json',
		]);
		expect(call?.argv).not.toContain('--content-encoding');
	});

	test('an image carries the type sniffed from its bytes and is not labelled gzip', () => {
		const asset = manifest.assets.find((entry) => entry.ext === 'png');
		if (asset === undefined) throw new Error('the corpus has no png asset');
		const key = `assets/${asset.sha256}.png`;
		const call = fake.puts().find((entry) => entry.holes[1] === `${prefix}/${key}`);

		expect(call?.id).toBe('aws.put-object');
		expect(call?.holes[3]).toBe('image/png');
		expect(call?.argv).not.toContain('--content-encoding');
		expect(call?.argv).toContain('--if-none-match');
	});

	test('every object in the manifest was put exactly once, and nothing else was', () => {
		const expected = [
			...manifest.objects.map((object) => `${prefix}/${object.key}`),
			`${prefix}/${MANIFEST_KEY}`,
		];
		expect([...fake.putKeys()].sort()).toEqual([...expected].sort());
		expect(fake.putKeys()).toHaveLength(expected.length);
	});

	test('every put carries the precondition, in the recipe rather than at the call site', () => {
		// Row 7 of the failure catalogue. `--if-none-match '*'` inside the template is what
		// makes a publish without server-side write-once unrepresentable, so the assertion is
		// over every put rather than over the one spelled out above.
		let checked = 0;
		for (const call of fake.puts()) {
			const at = call.argv.indexOf('--if-none-match');
			expect([call.holes[1], at >= 0, call.argv[at + 1]]).toEqual([call.holes[1], true, '*']);
			expect(call.argv).toContain('--checksum-sha256');
			expect(call.argv).toContain('--cache-control');
			checked += 1;
		}
		expect(checked).toBe(manifest.objects.length + 1);
	});

	test('the manifest is the last put and nothing follows it', () => {
		// A partial upload is then invisible rather than half-visible, and it is what makes
		// the preflight sound: a matching manifest checksum means every object preceded it.
		const keys = fake.putKeys();
		expect(keys[keys.length - 1]).toBe(`${prefix}/${MANIFEST_KEY}`);
		expect(keys.indexOf(`${prefix}/${MANIFEST_KEY}`)).toBe(keys.length - 1);
		const lastCall = fake.calls[fake.calls.length - 1];
		expect(lastCall?.holes[1]).toBe(`${prefix}/${MANIFEST_KEY}`);
	});

	test('the region and the profile were in the environment of every call, and are gone after', () => {
		// `withAuth` is the one thing not carried by a recipe, because no template has a hole
		// for `--profile`. It is safe only because `Exec` is synchronous and the restore is in
		// a `finally`, so both halves are worth measuring: set during, absent after.
		for (const call of fake.calls) {
			expect([call.id, call.env]).toEqual([call.id, { region: REGION, profile: PROFILE }]);
		}
		expect(process.env['AWS_PROFILE']).toBeUndefined();
	});

	test('the serial upload says something on the way, so a two-minute job is not silent', () => {
		expect(outcome.logged.length).toBeGreaterThan(0);
		expect(outcome.logged[0]).toMatch(/object\(s\) uploaded/);
	});
});

// ---------------------------------------------------------------------------
// Running it twice
// ---------------------------------------------------------------------------

describe('a second run over a bundle that is already there', () => {
	test('issues zero puts and asks exactly two questions', async () => {
		const fake = new FakeS3();
		const first = await run(fake);
		expect(first.data['published']).toBe(true);
		const after = fake.calls.length;

		const second = await run(fake);
		const calls = fake.calls.slice(after);

		expect(second.code).toBe(0);
		expect(second.data).toMatchObject({ published: true, skipped: true, written: 0 });
		expect(calls.map((call) => call.id)).toEqual(['aws.list-objects', 'aws.head-object']);
		expect(calls[0]?.holes[1]).toBe(`${prefix}/`);
		expect(calls[1]?.holes[1]).toBe(`${prefix}/${MANIFEST_KEY}`);
		// The head runs here and not on a first publish, and the difference is the listing:
		// it named the manifest, so the key is known to be there and 404 cannot arise.
		// The reconcile and the upload are `skipped`, not `pass`. A pass would be a row
		// claiming to have examined objects it never listed.
		expect(row(second, 'publish-reconcile').status).toBe('skipped');
		expect(row(second, 'publish-upload').status).toBe('skipped');
		expect(row(second, 'publish-preflight').status).toBe('pass');
	});

	test('the short circuit is the stored manifest digest, not the fact that a key exists', () => {
		// The idempotent path rests on one comparison. A preflight that returned early on
		// "something is at this key" would call a prefix holding a different bundle published.
		expect(manifestDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(hexToBase64(manifestDigest)).toBe(Buffer.from(manifestDigest, 'hex').toString('base64'));
		expect(base64ToHex(hexToBase64(manifestDigest))).toBe(manifestDigest);
	});

	test('a stored manifest with different bytes is not the short circuit', async () => {
		const fake = new FakeS3();
		seedObjects(fake);
		fake.put(`${prefix}/${MANIFEST_KEY}`, flipped(MANIFEST_KEY));

		const outcome = await run(fake);

		// Every object matches and only the manifest differs, which is the shape the command
		// names rather than reporting as a bare digest mismatch.
		expect(outcome.code).toBe(3);
		expect(outcome.data['published']).toBe(false);
		expect(row(outcome, 'publish-reconcile').status).toBe('fail');
		expect(String(row(outcome, 'publish-reconcile').note)).toContain(MANIFEST_KEY);
		expect(fake.puts()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Digest, never size
// ---------------------------------------------------------------------------

describe('what is already stored is compared by digest and never by size', () => {
	test('objects of identical length and different bytes are not treated as present', async () => {
		// The AWS CLI's own sync strategy compares size and last-modified and never content,
		// which is exactly wrong for a write-once commit-addressed store. Two gzip members of
		// the same length differing in every byte is not a hypothetical: it is what a
		// recompile at a different zlib produces.
		const fake = new FakeS3();
		for (const object of manifest.objects) fake.put(`${prefix}/${object.key}`, flipped(object.key));

		const outcome = await run(fake);

		// The lengths really were identical, which is the half of this test that could rot
		// silently: a flip that changed the length would make the assertion below pass for
		// the wrong reason.
		const sample = manifest.objects[0];
		if (sample === undefined) throw new Error('no objects');
		expect(fake.objects.get(`${prefix}/${sample.key}`)?.bytes.length).toBe(sample.bytes);

		const reconcile = row(outcome, 'publish-reconcile');
		expect(reconcile.status).toBe('fail');
		expect(reconcile.examined).toBe(manifest.objects.length);
		expect(reconcile.findings).toHaveLength(manifest.objects.length);
		expect(new Set(reconcile.findings.map((finding) => finding.rule))).toEqual(
			new Set(['bundle-digest-mismatch']),
		);
		expect(fake.puts()).toHaveLength(0);
		expect(outcome.code).toBe(3);
		expect(row(outcome, 'publish-upload').status).toBe('not-run');
	});

	test('the same objects with the right bytes are matched, so the sweep above is not vacuous', async () => {
		const fake = new FakeS3();
		for (const object of manifest.objects) {
			fake.put(`${prefix}/${object.key}`, readFileSync(join(directory, ...object.key.split('/'))));
		}

		const outcome = await run(fake);

		expect(outcome.code).toBe(0);
		expect(row(outcome, 'publish-reconcile').status).toBe('pass');
		// Only the manifest was missing, so only the manifest went up.
		expect(fake.putKeys()).toEqual([`${prefix}/${MANIFEST_KEY}`]);
		expect(outcome.data['unchanged']).toBe(manifest.objects.length);
	});

	test('an object S3 holds no checksum for is a mismatch, not a match', async () => {
		// `null` is a comparison that could not be made. Treating it as equal would let an
		// object written by something other than this publisher stand in for the bundle's.
		const fake = new FakeS3();
		const sample = manifest.objects[0];
		if (sample === undefined) throw new Error('no objects');
		const key = `${prefix}/${sample.key}`;
		fake.put(key, readFileSync(join(directory, ...sample.key.split('/'))));
		const stored = fake.objects.get(key);
		if (stored === undefined) throw new Error('seed failed');
		stored.checksum = null;

		const outcome = await run(fake);

		const findings = row(outcome, 'publish-reconcile').findings;
		expect(findings.map((finding) => finding.message)).toContainEqual(
			expect.stringContaining('holds no SHA-256 checksum'),
		);
		expect(outcome.code).toBe(3);
		expect(fake.puts()).toHaveLength(0);
	});

	test('an object under the prefix that the manifest does not name is reported', async () => {
		const fake = new FakeS3();
		fake.put(`${prefix}/pages/en/not-a-page.json.gz`, Buffer.from('stray'));

		const outcome = await run(fake);

		expect(row(outcome, 'publish-reconcile').status).toBe('fail');
		expect(row(outcome, 'publish-reconcile').findings.map((finding) => finding.rule)).toContain(
			'bundle-missing-object',
		);
		expect(fake.puts()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// The precondition, once it actually fires
// ---------------------------------------------------------------------------

describe('a 412 from the precondition', () => {
	/** A key the listing does not show and the store already holds: written since the reconcile. */
	function raced(fake: FakeS3, key: string, bytes: Buffer): void {
		const full = `${prefix}/${key}`;
		fake.put(full, bytes);
		fake.hiddenFromList.add(full);
		fake.refusePut.add(full);
	}

	test('whose stored checksum matches is a no-op, and the publish still exits 0', async () => {
		const key = 'llms/en.txt';
		const fake = new FakeS3();
		raced(fake, key, readFileSync(join(directory, 'llms', 'en.txt')));

		const outcome = await run(fake);

		expect(outcome.code).toBe(0);
		expect(outcome.data['published']).toBe(true);
		expect(outcome.rows.every((entry) => entry.status === 'pass')).toBe(true);
		// One put, refused, then one head to find out whose bytes are there. No retry: a 412
		// is a settled answer, unlike a 409.
		expect(fake.puts().filter((call) => call.holes[1] === `${prefix}/${key}`)).toHaveLength(1);
		expect(
			fake.of('aws.head-object').filter((call) => call.holes[1] === `${prefix}/${key}`),
		).toHaveLength(1);
		// And it still finished the job: the manifest went up last.
		expect(fake.putKeys()[fake.putKeys().length - 1]).toBe(`${prefix}/${MANIFEST_KEY}`);
	});

	test('whose stored checksum differs is a refusal naming the key, and no manifest goes up', async () => {
		const key = 'llms/en.txt';
		const fake = new FakeS3();
		raced(fake, key, flipped(key));

		const outcome = await run(fake);

		expect(outcome.code).toBe(3);
		expect(outcome.data['published']).toBe(false);
		const upload = row(outcome, 'publish-upload');
		expect(upload.status).toBe('fail');
		expect(String(upload.note)).toContain(key);
		expect(String(upload.note)).toContain('written by something else during this publish');
		// The one that matters: a prefix with no manifest holds no bundle, so a reader is
		// told nothing rather than being told something wrong.
		expect(fake.putKeys()).not.toContain(`${prefix}/${MANIFEST_KEY}`);
		expect(outcome.lines[0]).toContain('The manifest was not');
	});

	test('a 409 is retried once, because S3 says a conditional conflict is a race', async () => {
		const key = 'llms/en.txt';
		const fake = new FakeS3();
		fake.conflictOnce.add(`${prefix}/${key}`);

		const outcome = await run(fake);

		expect(outcome.code).toBe(0);
		expect(fake.puts().filter((call) => call.holes[1] === `${prefix}/${key}`)).toHaveLength(2);
		expect(fake.putKeys()).toHaveLength(manifest.objects.length + 2);
	});
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('list-objects-v2 follows the continuation token', () => {
	const PAGE = 40;

	test('a truncated first page produces a second call carrying --starting-token', async () => {
		const fake = new FakeS3();
		seedObjects(fake);
		fake.pageSize = PAGE;

		const outcome = await run(fake);

		const first = fake.of('aws.list-objects');
		const rest = fake.of('aws.list-objects-page');
		expect(first).toHaveLength(1);
		expect(rest.length).toBeGreaterThanOrEqual(1);
		expect(rest[0]?.argv).toEqual([
			'aws',
			's3api',
			'list-objects-v2',
			'--bucket',
			BUCKET,
			'--prefix',
			`${prefix}/`,
			'--max-items',
			String(LIST_PAGE_SIZE),
			'--starting-token',
			String(PAGE),
			'--output',
			'json',
		]);
		// The whole bundle was seen across the pages, so nothing was re-uploaded and the only
		// put is the manifest that was genuinely absent.
		expect(outcome.code).toBe(0);
		expect(fake.putKeys()).toEqual([`${prefix}/${MANIFEST_KEY}`]);
		expect(outcome.data['unchanged']).toBe(manifest.objects.length);
	});

	test('an unpaginated answer reports the tail absent, which is the bug the loop closes', async () => {
		// The same bucket, with the token withheld. Nothing errors: the run reports the tail
		// as missing and re-uploads objects that were already correct, which against a real
		// bucket is where the precondition fires on bytes nobody needed to send.
		const fake = new FakeS3();
		seedObjects(fake);
		fake.pageSize = PAGE;
		fake.dropToken = true;

		await run(fake);

		expect(fake.of('aws.list-objects-page')).toHaveLength(0);
		// Everything past the first page looked absent. The count is derived rather than
		// written down, because it moves with the corpus.
		expect(fake.putKeys().length).toBe(manifest.objects.length - PAGE + 1);
	});

	test('NextContinuationToken is accepted as well, because the CLI answers with either', async () => {
		// `--max-items` turns on botocore's own paginator, which injects `NextToken`. The
		// service field is what the same call returns if that flag is ever dropped from the
		// recipe, and taking either is correct where taking neither is the defect.
		const fake = new FakeS3();
		seedObjects(fake);
		fake.pageSize = PAGE;
		fake.tokenField = 'NextContinuationToken';

		const outcome = await run(fake);

		expect(fake.of('aws.list-objects-page').length).toBeGreaterThanOrEqual(1);
		expect(outcome.code).toBe(0);
		expect(fake.putKeys()).toEqual([`${prefix}/${MANIFEST_KEY}`]);
	});
});

// ---------------------------------------------------------------------------
// Refusals that are not failures
// ---------------------------------------------------------------------------

describe('a call that could not be made', () => {
	test('missing credentials are a not-run row naming them, never a fail and never a pass', async () => {
		// A build host with no AWS profile has not found a broken bundle; it has not looked.
		const fake = new FakeS3();
		fake.failWith =
			'Unable to locate credentials. You can configure credentials by running "aws configure".';

		const outcome = await run(fake);

		const preflight = row(outcome, 'publish-preflight');
		expect(preflight.status).toBe('not-run');
		expect(String(preflight.note)).toContain('Unable to locate credentials');
		expect(outcome.code).toBe(3);
		expect(fake.puts()).toHaveLength(0);
	});

	test('a bucket that does not exist is a failure rather than an empty prefix', async () => {
		// A missing bucket answers a head with a 404-shaped message too. Reading that as "the
		// object is not there yet" would upload the whole bundle one refusal at a time.
		const fake = new FakeS3();
		fake.failWith =
			'An error occurred (NoSuchBucket) when calling the HeadObject operation: The specified bucket does not exist';

		const outcome = await run(fake);

		expect(row(outcome, 'publish-preflight').status).toBe('fail');
		expect(outcome.code).toBe(3);
		expect(fake.puts()).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// The client's own answers, driven directly
// ---------------------------------------------------------------------------

/**
 * `s3Client` on its own, for the answers no publish of a good bundle reaches.
 *
 * Every one of these is a message an operator reads at the moment something has gone
 * wrong, and each is a different place to send them: a binary that is not installed, a
 * bucket that is not there, output that is not what the CLI documents. Reached through
 * `publish` they are all one refusal string, so they are exercised here instead.
 */
describe('the client, on the answers a good publish never produces', () => {
	const AUTH = { bucket: BUCKET, region: REGION, profile: PROFILE };
	const client = (answer: (id: RecipeId) => RunResult): ReturnType<typeof s3Client> =>
		s3Client((id) => answer(id), AUTH, root);

	test('a binary that never started is named as not starting, not as saying no', () => {
		// `runRecipe` answers a missing `aws` with a null status. "aws is not installed" and
		// "aws said no" send an operator to different places.
		const result = client(() => ({
			status: null,
			stdout: '',
			stderr: 'spawnSync aws ENOENT',
		})).head('k');
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') throw new Error('expected a refusal');
		expect(result.why).toContain('could not start');
		expect(result.credentials).toBe(false);
	});

	test('a missing bucket is not read as a missing object, however 404-shaped it is', () => {
		// The one ordering that matters in the whole module: the message carries both, and
		// reading it as absent would make `publish` upload the bundle into a bucket that does
		// not exist, one refusal at a time.
		const stderr =
			'An error occurred (NoSuchBucket) when calling the HeadObject operation: Not Found';
		expect(client(() => ({ status: 255, stdout: '', stderr })).head('k').kind).toBe('refused');
		const plain = 'An error occurred (404) when calling the HeadObject operation: Not Found';
		expect(client(() => ({ status: 255, stdout: '', stderr: plain })).head('k').kind).toBe(
			'absent',
		);
	});

	test('output that is not JSON is a refusal quoting the parse, not an exception', () => {
		const head = client(() => ({ status: 0, stdout: 'not json at all', stderr: '' })).head('k');
		expect(head.kind).toBe('refused');
		const listed = client(() => ({ status: 0, stdout: '{ oh dear', stderr: '' })).list('p/');
		expect(listed.kind).toBe('refused');
	});

	test('an empty listing is an empty prefix, which every first publish meets', () => {
		// Some CLI versions answer an empty prefix with no output at all rather than with an
		// empty document. Treating either as a failure would make a first publish impossible.
		for (const stdout of ['', '{}', '{"Contents": []}']) {
			const listed = client(() => ({ status: 0, stdout, stderr: '' })).list('p/');
			expect([stdout, listed]).toEqual([stdout, { kind: 'ok', keys: [], pages: 1 }]);
		}
	});

	test('a head with no checksum field is present with null, which is not a mismatch', () => {
		// `null` is a comparison that could not be made. A client that returned an empty string
		// here would make it compare unequal to every digest, which is the same outcome by
		// accident and the wrong message.
		const head = client(() => ({ status: 0, stdout: '{"ContentLength": 12}', stderr: '' })).head(
			'k',
		);
		expect(head).toEqual({ kind: 'present', checksumSha256: null, bytes: 12 });
	});

	test('an ExecRefusal becomes a refusal row rather than a stack trace out of a prebuild', () => {
		// Thrown for exactly two things, an arity mismatch and a hole carrying a NUL. Whatever
		// the reason, the honest report from a `prebuild` hook is a row naming the value, not a
		// stack trace out of somebody's deploy.
		const refusing = s3Client(
			() => {
				throw new ExecRefusal('a value contains a NUL, which cannot be passed in an argv');
			},
			AUTH,
			root,
		);
		const result = refusing.get('k', '/Users/A B/cache/k');
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') throw new Error('expected a refusal');
		expect(result.why).toContain('NUL');
	});

	test('anything else thrown by the exec is not swallowed', () => {
		// The catch is narrow on purpose: a bug in this package must not be reported as a
		// bucket that would not answer.
		const throwing = s3Client(
			() => {
				throw new TypeError('a real defect');
			},
			AUTH,
			root,
		);
		expect(() => throwing.head('k')).toThrow(TypeError);
	});

	test('a 403 naming AccessDenied says both things it can mean, because S3 will not say which', () => {
		// The commonest real failure on the read side, and the one whose raw message sends an
		// operator to the wrong place. S3 answers a GetObject on a missing key with 403 rather
		// than 404 for a caller without `s3:ListBucket`, so `AccessDenied` means either the
		// object is absent or this identity may not know. Quoting the CLI verbatim names only
		// the second.
		//
		// The operation in the fixture is GetObject and it used to be HeadObject, which cannot
		// produce this string: a HEAD response has no body, so botocore has no code to print.
		// That case is the test below, and attributing this message to a head made the arm that
		// actually fires in production look covered when it never was.
		const denied = client(() => ({
			status: 255,
			stdout: '',
			stderr:
				'\nAn error occurred (AccessDenied) when calling the GetObject operation: Access Denied\n',
		}));

		const got = denied.get('hex-nfc/abc/ast-1/manifest.json', join(root, 'out.json'));
		expect(got.kind).toBe('refused');
		if (got.kind !== 'refused') throw new Error('expected a refusal');
		expect(got.why).toContain('missing object or a missing permission');
		expect(got.why).toContain('s3:ListBucket');
		// Not a credentials refusal. A credentials refusal becomes a `not-run` row naming the
		// missing profile, and a policy that is present and too narrow is not that: the run
		// did look, and what it found is a boundary.
		expect(got.credentials).toBe(false);
	});

	test('a bare 403 on a head names the third state, because HeadObject cannot tell them apart', () => {
		// Measured on aws-cli 2.36.19, byte for byte, from two different causes: a deactivated
		// access key against a bucket that exists, and an unsigned head against a bucket that
		// grants no anonymous access. A HEAD response has no body, so botocore synthesises the
		// code from the status and every identity failure and every policy boundary prints this
		// one line. `publish` heads the manifest before it does anything else, so this is where
		// a rotated key lands, and the two-state sentence sent that operator to check the bundle
		// and then the policy, neither of which is the problem.
		const forbidden = client(() => ({
			status: 255,
			stdout: '',
			stderr: '\nAn error occurred (403) when calling the HeadObject operation: Forbidden\n',
		}));

		const head = forbidden.head('hex-nfc/abc/ast-1/manifest.json');
		expect(head.kind).toBe('refused');
		if (head.kind !== 'refused') throw new Error('expected a refusal');
		expect(head.why).toContain('credential this account no longer accepts');
		// The masking guidance stays, because a narrow policy is still the commonest cause, and
		// so does the one call that separates the three: `get-object` has a body.
		expect(head.why).toContain('s3:ListBucket');
		expect(head.why).toContain('get-object');
		// Still not a credentials refusal, deliberately. Flipping this would turn a publisher
		// role that is merely too narrow into a `not-run` row saying the machine is
		// unconfigured, which is the same misreport in the other direction.
		expect(head.credentials).toBe(false);
	});

	test('a dead access key is a credentials refusal wherever the CLI names it', () => {
		// `InvalidAccessKeyId` and `InvalidToken` are what S3 prints for a deleted or
		// deactivated key and for a malformed session token, and they arrive only where the
		// response carries a body: on `get-object` and `list-objects-v2`, never on a head.
		// Without them in `NO_CREDENTIALS` a rotated key is a plain FAIL row saying the bundle
		// is wrong, and `publish`'s reconcile reads exactly this flag to choose between a
		// `not-run` row and a failure.
		const dead = client(() => ({
			status: 255,
			stdout: '',
			stderr:
				'\nAn error occurred (InvalidAccessKeyId) when calling the GetObject operation: The AWS Access Key Id you provided does not exist in our records.\n',
		}));
		const got = dead.get('hex-nfc/abc/ast-1/manifest.json', join(root, 'out.json'));
		expect(got.kind).toBe('refused');
		if (got.kind !== 'refused') throw new Error('expected a refusal');
		expect(got.credentials).toBe(true);

		const bogusToken = client(() => ({
			status: 255,
			stdout: '',
			stderr:
				'\nAn error occurred (InvalidToken) when calling the ListObjectsV2 operation: The provided token is malformed or otherwise invalid.\n',
		}));
		const listed = bogusToken.list('hex-nfc/abc/');
		expect(listed.kind).toBe('refused');
		if (listed.kind !== 'refused') throw new Error('expected a refusal');
		expect(listed.credentials).toBe(true);
	});

	test('a 404 is still absence, and does not pick up the denial sentence', () => {
		// The pair to the case above. Folding the two would make a first publish, whose
		// preflight heads a manifest that is not there yet, report a permissions problem on
		// every run.
		const missing = client(() => ({ status: 255, stdout: '', stderr: NOT_FOUND_STDERR }));
		expect(missing.head('k')).toEqual({ kind: 'absent' });
	});

	test('calls counts processes, which is what a row examined column reports', () => {
		const counting = client(() => ({ status: 0, stdout: '{}', stderr: '' }));
		expect(counting.calls).toBe(0);
		counting.head('a');
		counting.list('p/');
		expect(counting.calls).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// what `build` reports and what `publish` accepts
// ---------------------------------------------------------------------------

/**
 * The seam the generated workflow crosses, asserted from this side.
 *
 * `kit/test/templates/workflow.test.ts` proves the publish step is not handed `build`'s
 * `--out` value. This proves why that matters: the `--out` directory is not a bundle and
 * the prefix reported by the same call is, so the two spellings are not interchangeable
 * and never were. Nothing in the suite compared them until the generated workflow shipped
 * a publish step that could not have worked, green in three thousand tests, because each
 * command was asserted against a literal and the pair against nothing.
 */
describe('the directory build reports is the directory publish accepts', () => {
	test('the reported prefix verifies as a bundle', () => {
		const rows = verifyBundle(directory);
		expect(rows.every((entry) => entry.status === 'pass')).toBe(true);
	});

	test('the --out directory does not, and says so by name', () => {
		const rows = verifyBundle(bundleOut);
		const manifestRow = rows.find((entry) => entry.id === 'bundle-manifest');
		expect(manifestRow?.status).toBe('fail');
		expect(manifestRow?.findings[0]?.message ?? '').toContain('has no manifest.json');
		// The remediation already named the mistake the generated workflow was making,
		// word for word, and no run ever reached it.
		expect(manifestRow?.findings[0]?.remediation ?? '').toContain(
			'Point at the ast-N directory of one bundle, not at the root of an output tree.',
		);
	});

	test('the prefix is below the --out directory, by the project, commit and AST major', () => {
		expect(directory).toBe(join(bundleOut, prefix));
		expect(directory).not.toBe(bundleOut);
	});
});
