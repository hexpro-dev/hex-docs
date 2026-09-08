import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { AST_VERSION } from '../../../src/contracts/ast.js';
import type { CheckRow } from '../../../src/contracts/diagnostics.js';
import { MANIFEST_KEY, bundlePrefix } from '../../../src/contracts/manifest.js';
import type { BundleManifest } from '../../../src/contracts/manifest.js';

import { materialiseCorpus } from '../../../fixtures/index.js';
import { buildBundle, type WrittenObject } from '../../src/compile/build.js';
import { verifyBundle, writeBundle } from '../../src/compile/bundle.js';
import { canonicalJson, gzipMember, sha256Hex, utf8Bytes } from '../../src/compile/serialise.js';

/**
 * The writer and the verifier, driven against a real bundle rather than a hand-built one.
 *
 * The corpus is compiled once and written many times, because both halves of this module
 * are about what is on disk. A hand-written manifest would test the reader against a
 * shape nothing produces, and the two properties that matter most here, the manifest
 * being last and identical bytes being a no-op, are only visible against a bundle with
 * enough objects for "last" to mean something.
 *
 * Every expected count is read off the manifest. A literal would go stale the first time
 * a page is added to the corpus, and a stale count is how a check quietly starts
 * examining less than it says it does.
 */

let root: string;
let manifest: BundleManifest;
let objects: WrittenObject[];

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'hexdocs-bundle-'));
	const corpus = materialiseCorpus(join(root, 'repo'));
	const built = buildBundle(corpus.root, { generator: '@hex-pro/docs-kit@0.0.0' });
	manifest = built.manifest;
	objects = built.objects;
	// A build whose own manifest invariants complain would make every row below meaningless.
	expect(built.manifestProblems).toEqual([]);
	expect(objects.length).toBeGreaterThan(1);
}, 60_000);

afterAll(() => {
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

let counter = 0;

/** A fresh output root, so no test can see another test's bytes. */
function outputRoot(): string {
	counter += 1;
	const out = join(root, `out-${counter}`);
	mkdirSync(out, { recursive: true });
	return out;
}

function prefixIn(out: string): string {
	return join(out, bundlePrefix(manifest.project, manifest.commit, manifest.ast));
}

/** A written bundle, checked to have actually written something. */
function written(): { out: string; prefix: string } {
	const out = outputRoot();
	const result = writeBundle(out, manifest, objects);
	expect(result.written).toHaveLength(objects.length + 1);
	return { out, prefix: result.prefix };
}

function plant(prefix: string, key: string, bytes: Buffer): void {
	const path = join(prefix, key);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
}

function row(rows: CheckRow[], id: string): CheckRow {
	const found = rows.find((entry) => entry.id === id);
	if (found === undefined) throw new Error(`no ${id} row in [${rows.map((r) => r.id).join(', ')}]`);
	return found;
}

function messages(rows: CheckRow[], id: string): string[] {
	return row(rows, id).findings.map((finding) => finding.message);
}

function keyOf(object: WrittenObject): string {
	return object.key;
}

const ROW_IDS = [
	'bundle-manifest',
	'bundle-ast-major',
	'bundle-objects',
	'bundle-digests',
	'bundle-payloads',
];

// ---------------------------------------------------------------------------
// The manifest is written last
// ---------------------------------------------------------------------------

describe('the manifest is written last', () => {
	test('a completed write leaves the manifest beside every object it names', () => {
		// The control for the two tests below. Their assertion is that the manifest is
		// absent, which proves nothing unless a finished write puts one there.
		const { prefix } = written();
		expect(existsSync(join(prefix, MANIFEST_KEY))).toBe(true);
		const present = objects.filter((object) => existsSync(join(prefix, object.key)));
		expect(present).toHaveLength(objects.length);
	});

	test('a write that fails on the second object leaves no manifest', () => {
		// A partial upload has to be invisible rather than half-visible. A reader that finds
		// no manifest knows there is no bundle here; one that finds a manifest naming objects
		// that were never written would mount a bundle with holes in it and report nothing.
		const out = outputRoot();
		const prefix = prefixIn(out);
		const first = objects[0];
		const second = objects[1];
		if (first === undefined || second === undefined) throw new Error('too few objects');
		plant(prefix, second.key, utf8Bytes('bytes that are not what this build produced'));

		expect(() => writeBundle(out, manifest, objects)).toThrow(/write-once/);

		expect(existsSync(join(prefix, first.key))).toBe(true);
		expect(existsSync(join(prefix, MANIFEST_KEY))).toBe(false);
	});

	test('a write that fails on the last object leaves no manifest either', () => {
		// The stronger half of the same property: every object precedes the manifest, not
		// merely the first one. A writer that put the manifest in the middle of the loop
		// would pass the test above and fail this one.
		const out = outputRoot();
		const prefix = prefixIn(out);
		const last = objects[objects.length - 1];
		if (last === undefined) throw new Error('no objects');
		plant(prefix, last.key, utf8Bytes('bytes that are not what this build produced'));

		expect(() => writeBundle(out, manifest, objects)).toThrow(/write-once/);

		const present = objects.filter((object) => existsSync(join(prefix, object.key)));
		expect(present.map(keyOf)).toEqual(objects.map(keyOf));
		expect(existsSync(join(prefix, MANIFEST_KEY))).toBe(false);
	});

	test('the prefix is project, commit and ast major, which is the layout in the bucket', () => {
		const { out, prefix } = written();
		expect(prefix).toBe(join(out, manifest.project, manifest.commit, `ast-${AST_VERSION}`));
		expect(manifest.ast).toBe(AST_VERSION);
	});
});

// ---------------------------------------------------------------------------
// Write-once
// ---------------------------------------------------------------------------

describe('write-once', () => {
	test('re-running with identical bytes writes nothing and reports every key unchanged', () => {
		// This is what makes re-publishing the same commit safe. A writer that rewrote the
		// same bytes would be harmless on a filesystem and a new object version in S3.
		const { out, prefix } = written();
		const again = writeBundle(out, manifest, objects);

		expect(again.prefix).toBe(prefix);
		expect(again.written).toEqual([]);
		expect(again.unchanged).toHaveLength(objects.length + 1);
		expect(again.unchanged).toEqual([...objects.map(keyOf), MANIFEST_KEY]);
		expect(verifyBundle(prefix).every((entry) => entry.status === 'pass')).toBe(true);
	});

	test('re-running with different bytes for one object throws and says why', () => {
		const { out, prefix } = written();
		const target = objects[Math.floor(objects.length / 2)];
		if (target === undefined) throw new Error('no object');
		const altered = objects.map((object) =>
			object.key === target.key
				? { key: object.key, bytes: Buffer.concat([object.bytes, utf8Bytes('x')]) }
				: object,
		);

		let message = '';
		try {
			writeBundle(out, manifest, altered);
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toContain(join(prefix, target.key));
		expect(message).toContain('write-once');
		// The reason is carried in the message rather than left to the reader. The two states
		// it can mean, a toolchain change under a published sha and a compile that is not
		// deterministic, are the two things worth looking at, and neither is guessable from
		// "file exists".
		expect(message).toContain('the same commit has to compile to the same bytes');
		expect(message).toContain('not deterministic');
	});

	test('the manifest is write-once as well as the objects', () => {
		const { out, prefix } = written();
		const moved: BundleManifest = { ...manifest, generator: '@hex-pro/docs-kit@9.9.9' };
		expect(() => writeBundle(out, moved, objects)).toThrow(
			new RegExp(`${MANIFEST_KEY.replace('.', '\\.')} already exists with different bytes`),
		);
		expect(readFileSync(join(prefix, MANIFEST_KEY), 'utf8')).toBe(`${canonicalJson(manifest)}\n`);
	});
});

// ---------------------------------------------------------------------------
// verifyBundle on a bundle that is intact
// ---------------------------------------------------------------------------

describe('verifyBundle on a freshly written bundle', () => {
	test('every row passes and every row examined something', () => {
		const { prefix } = written();
		const rows = verifyBundle(prefix);

		expect(rows.map((entry) => entry.id)).toEqual(ROW_IDS);
		for (const entry of rows) {
			expect([entry.id, entry.status, entry.findings, entry.note]).toEqual([
				entry.id,
				'pass',
				[],
				null,
			]);
			expect([entry.id, entry.examined > 0]).toEqual([entry.id, true]);
		}
		expect(rows).toHaveLength(ROW_IDS.length);
	});

	test('the counts are the manifest own counts, not a number the checker chose', () => {
		const { prefix } = written();
		const rows = verifyBundle(prefix);
		const payloadKeys = manifest.objects.filter(
			(object) => object.key.startsWith('pages/') || object.key.startsWith('search/'),
		);

		expect(row(rows, 'bundle-objects').examined).toBe(manifest.objects.length);
		expect(row(rows, 'bundle-digests').examined).toBe(manifest.objects.length);
		expect(row(rows, 'bundle-payloads').examined).toBe(payloadKeys.length);
		// A payload count equal to the object count would mean the two loops are the same
		// loop, and a payload count of zero would mean the prefixes stopped matching.
		expect(payloadKeys.length).toBeGreaterThan(0);
		expect(payloadKeys.length).toBeLessThan(manifest.objects.length);
	});
});

// ---------------------------------------------------------------------------
// verifyBundle on a bundle that is not intact
// ---------------------------------------------------------------------------

describe('verifyBundle on a damaged bundle', () => {
	test('an object the manifest names and the directory does not have fails bundle-objects', () => {
		const { prefix } = written();
		const target = manifest.objects.find((object) => object.key.startsWith('pages/'));
		if (target === undefined) throw new Error('no page object');
		rmSync(join(prefix, target.key));

		const rows = verifyBundle(prefix);
		expect(row(rows, 'bundle-objects').status).toBe('fail');
		expect(messages(rows, 'bundle-objects')).toEqual([
			`The manifest names "${target.key}" and it is not here.`,
		]);
		expect(row(rows, 'bundle-objects').findings[0]?.location).toEqual({
			kind: 'file',
			file: target.key,
		});
		// The digest and payload rows examine what is present, so a missing object drops each
		// of their counts by one rather than being counted as checked and passing.
		expect(row(rows, 'bundle-digests').examined).toBe(manifest.objects.length - 1);
		expect(row(rows, 'bundle-digests').status).toBe('pass');
	});

	test('an object whose bytes were altered fails bundle-digests, and the reader does not throw', () => {
		const { prefix } = written();
		const target = manifest.objects.find((object) => object.key.startsWith('pages/'));
		if (target === undefined) throw new Error('no page object');
		const path = join(prefix, target.key);
		const bytes = readFileSync(path);
		const middle = Math.floor(bytes.length / 2);
		bytes[middle] = (bytes[middle] ?? 0) ^ 0xff;
		writeFileSync(path, bytes);

		const rows = verifyBundle(prefix);
		expect(bytes.length).toBe(target.bytes);
		expect(row(rows, 'bundle-digests').status).toBe('fail');
		expect(messages(rows, 'bundle-digests')).toEqual([
			'The stored bytes do not match the digest in the manifest.',
		]);
		// A corrupt gzip member throws out of zlib, and this report is the only place the
		// operator is told which object is wrong. It has to come back as a row.
		expect(row(rows, 'bundle-payloads').status).toBe('fail');
		expect(messages(rows, 'bundle-payloads')).toEqual([
			'Could not be read back: incorrect data check',
		]);
		expect(row(rows, 'bundle-payloads').findings[0]?.location).toEqual({
			kind: 'file',
			file: target.key,
		});
	});

	test('an object of the wrong length is named with both lengths, before any digest is taken', () => {
		const { prefix } = written();
		const target = manifest.objects.find((object) => object.key.startsWith('llms/'));
		if (target === undefined) throw new Error('no llms object');
		const bytes = readFileSync(join(prefix, target.key));
		writeFileSync(join(prefix, target.key), Buffer.concat([bytes, utf8Bytes('   ')]));

		const rows = verifyBundle(prefix);
		expect(messages(rows, 'bundle-digests')).toEqual([
			`Stored ${target.bytes + 3} bytes; the manifest says ${target.bytes}.`,
		]);
	});

	test('a stray object the manifest does not name fails bundle-objects', () => {
		const { prefix } = written();
		plant(prefix, 'pages/en/left-over-from-a-branch.json.gz', gzipMember(utf8Bytes('{}')));

		const rows = verifyBundle(prefix);
		expect(row(rows, 'bundle-objects').status).toBe('fail');
		expect(messages(rows, 'bundle-objects')).toHaveLength(1);
		expect(messages(rows, 'bundle-objects')[0]).toContain(
			'"pages/en/left-over-from-a-branch.json.gz" is here and the manifest does not name it.',
		);
		// The stray is invisible to the digest and payload rows, which walk the manifest. That
		// is the whole reason the key set is compared in both directions rather than the
		// manifest being taken as the list of what is here.
		expect(row(rows, 'bundle-digests').examined).toBe(manifest.objects.length);
		expect(row(rows, 'bundle-digests').status).toBe('pass');
	});

	test('a payload that is valid gzip and not a compiled page fails bundle-payloads alone', () => {
		// Written with the manifest updated to match, so the digest row passes and the schema
		// row is the only thing standing between these bytes and a published bundle.
		const { prefix } = written();
		const target = manifest.objects.find((object) => object.key.startsWith('pages/'));
		if (target === undefined) throw new Error('no page object');
		const replacement = gzipMember(utf8Bytes('{"ast":1,"slug":"guide/first-tag"}'));
		writeFileSync(join(prefix, target.key), replacement);
		const patched: BundleManifest = {
			...manifest,
			objects: manifest.objects.map((object) =>
				object.key === target.key
					? {
							...object,
							bytes: replacement.length,
							digest: sha256Hex(replacement),
						}
					: object,
			),
		};
		writeFileSync(join(prefix, MANIFEST_KEY), `${canonicalJson(patched)}\n`);

		const rows = verifyBundle(prefix);
		expect(row(rows, 'bundle-digests').status).toBe('pass');
		expect(row(rows, 'bundle-payloads').status).toBe('fail');
		expect(messages(rows, 'bundle-payloads')).toHaveLength(1);
		expect(messages(rows, 'bundle-payloads')[0]).toMatch(/^Not a compiled page: /);
	});

	test('a manifest declaring an AST major this toolchain does not know fails on that', () => {
		// The ast-N namespace exists so a bundle from a newer kit sits beside this one rather
		// than over it, so meeting one is an ordinary state with an ordinary answer: bump the
		// submodule. Reported as a malformed manifest instead, it reads as a corrupt bundle
		// and the operator recompiles a commit that was never wrong.
		const { prefix } = written();
		const future = { ...manifest, ast: AST_VERSION + 1 };
		writeFileSync(join(prefix, MANIFEST_KEY), `${canonicalJson(future)}\n`);

		const rows = verifyBundle(prefix);
		expect(rows.map((entry) => entry.id)).toEqual(['bundle-ast-major']);
		expect(row(rows, 'bundle-ast-major').status).toBe('fail');
		expect(row(rows, 'bundle-ast-major').examined).toBe(1);
		expect(row(rows, 'bundle-ast-major').unit).toBe('majors');
		expect(messages(rows, 'bundle-ast-major')).toEqual([
			`This bundle declares AST major ${AST_VERSION + 1} and this toolchain is ${AST_VERSION}.`,
		]);
		expect(row(rows, 'bundle-ast-major').findings[0]?.rule).toBe('bundle-ast-major');
	});

	test('a manifest that is not JSON is reported rather than thrown', () => {
		const { prefix } = written();
		writeFileSync(join(prefix, MANIFEST_KEY), '{"manifest": 1,');

		const rows = verifyBundle(prefix);
		expect(rows.map((entry) => entry.id)).toEqual(['bundle-manifest']);
		expect(row(rows, 'bundle-manifest').status).toBe('fail');
		expect(messages(rows, 'bundle-manifest')[0]).toContain('manifest.json is not JSON');
	});

	test('a manifest that parses and does not validate is reported against its own pointer', () => {
		const { prefix } = written();
		const broken = { ...manifest, sourceLocale: 'hi' };
		writeFileSync(join(prefix, MANIFEST_KEY), `${canonicalJson(broken)}\n`);

		const rows = verifyBundle(prefix);
		expect(rows.map((entry) => entry.id)).toEqual(['bundle-manifest']);
		expect(row(rows, 'bundle-manifest').status).toBe('fail');
		expect(row(rows, 'bundle-manifest').findings[0]?.location).toEqual({
			kind: 'pointer',
			file: MANIFEST_KEY,
			pointer: '/sourceLocale',
		});
	});
});

// ---------------------------------------------------------------------------
// A directory that is not a bundle
// ---------------------------------------------------------------------------

describe('a directory with no manifest', () => {
	test('fails with a row rather than throwing, and examined is zero', () => {
		// The absence of a manifest is the same signal a partial upload gives, so the reader
		// has to be able to say so. Throwing here would make `hexdocs verify` exit on a stack
		// trace at exactly the moment somebody is trying to find out what is in the bucket.
		const empty = join(outputRoot(), 'nothing-here');
		mkdirSync(empty, { recursive: true });

		const rows = verifyBundle(empty);
		expect(rows).toHaveLength(1);
		const only = row(rows, 'bundle-manifest');
		expect([only.status, only.examined, only.unit]).toEqual(['fail', 0, 'manifests']);
		expect(only.findings).toHaveLength(1);
		expect(only.findings[0]?.rule).toBe('bundle-missing-object');
		expect(only.findings[0]?.message).toBe(`${empty} has no manifest.json.`);
		expect(only.findings[0]?.remediation).toContain('The manifest is written last');
	});

	test('the root of an output tree is not a bundle prefix', () => {
		// The mistake this catches is pointing at `out/` rather than at `out/<project>/<sha>/
		// ast-N/`, which is one directory level and produces an empty report otherwise.
		const { out } = written();
		const rows = verifyBundle(out);
		expect(rows.map((entry) => entry.id)).toEqual(['bundle-manifest']);
		expect(row(rows, 'bundle-manifest').status).toBe('fail');
		expect(row(rows, 'bundle-manifest').examined).toBe(0);
	});
});
