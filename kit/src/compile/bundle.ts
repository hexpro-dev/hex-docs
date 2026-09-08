/**
 * Writing a bundle out, and reading one back to check it.
 *
 * The layout on disk is the layout in the bucket, `<project>/<sha>/ast-<major>/`,
 * because the upload in step 6 is then a copy rather than a translation and because
 * `hexdocs verify` can run against either without knowing which it has.
 *
 * Write-once is enforced here rather than only in S3. Recompiling the same commit has
 * to produce the same bytes, so a key that already exists with different content means
 * either the toolchain changed under a published sha or the compile is not
 * deterministic, and both are worth refusing over. Identical bytes are a no-op, which is
 * what makes re-running a publish on the same commit safe.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import {
	MANIFEST_KEY,
	bundlePrefix,
	isGzipped,
	validateManifestShape,
	type BundleManifest,
} from '../../../src/contracts/manifest.js';
import { AST_VERSION } from '../../../src/contracts/ast.js';
import { checkRow, type CheckRow } from '../../../src/contracts/diagnostics.js';
import {
	bundleManifestSchema,
	compiledPageSchema,
	searchIndexSchema,
} from '../contracts/bundle.schema.js';

import { canonicalJson, gunzipMember, sha256Hex, utf8Bytes } from './serialise.js';
import { raw } from './types.js';
import type { WrittenObject } from './build.js';

export interface WriteResult {
	/** The `ast-N` directory everything was written under. */
	prefix: string;
	written: string[];
	/** Keys whose bytes were already there, byte for byte. A re-run writes nothing new. */
	unchanged: string[];
}

/**
 * Writes the manifest last.
 *
 * A partial upload is then invisible rather than half-visible: a reader that finds no
 * manifest knows there is no bundle, and one that finds a manifest can rely on every
 * object it names being there.
 */
export function writeBundle(
	out: string,
	manifest: BundleManifest,
	objects: readonly WrittenObject[],
): WriteResult {
	const prefix = join(out, bundlePrefix(manifest.project, manifest.commit, manifest.ast));
	const written: string[] = [];
	const unchanged: string[] = [];

	const put = (key: string, bytes: Buffer): void => {
		const path = join(prefix, key);
		if (existsSync(path)) {
			const existing = readFileSync(path);
			if (existing.equals(bytes)) {
				unchanged.push(key);
				return;
			}
			throw new Error(
				`${path} already exists with different bytes. Bundles are write-once: the same commit has to compile to the same bytes, so this is either a toolchain change under a published sha or a compile that is not deterministic. Recompiling at a new AST major writes beside this rather than over it.`,
			);
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, bytes);
		written.push(key);
	};

	for (const object of objects) put(object.key, object.bytes);
	put(MANIFEST_KEY, utf8Bytes(`${canonicalJson(manifest)}\n`));

	return { prefix, written, unchanged };
}

/** Every file under a bundle prefix, as keys relative to it. */
function keysUnder(prefix: string): string[] {
	const found: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const full = join(directory, entry.name);
			if (entry.isDirectory()) walk(full);
			else found.push(relative(prefix, full).split(sep).join('/'));
		}
	};
	walk(prefix);
	return found.sort();
}

/**
 * Reads a written bundle back and checks it against its own manifest.
 *
 * Four states, a count on every row, and a row that examined nothing is a failure
 * rather than a pass. That is the whole reason this exists as well as the schemas: a
 * checker that walked an empty directory and exited zero has not verified anything, it
 * has lost the directory.
 */
export function verifyBundle(directory: string): CheckRow[] {
	const rows: CheckRow[] = [];
	const manifestPath = join(directory, MANIFEST_KEY);
	if (!existsSync(manifestPath)) {
		return [
			{
				id: 'bundle-manifest',
				status: 'fail',
				examined: 0,
				unit: 'manifests',
				findings: [
					raw(
						'bundle-missing-object',
						{ kind: 'file', file: MANIFEST_KEY },
						null,
						`${directory} has no manifest.json.`,
						{
							remediation:
								'Point at the ast-N directory of one bundle, not at the root of an output tree. The manifest is written last, so its absence can also mean a partial upload.',
						},
					),
				].map((entry) => ({
					rule: entry.rule,
					severity: 'error' as const,
					category: 'bundle' as const,
					location: entry.location,
					locale: null,
					message: entry.message,
					consequence:
						'Nothing can be verified without the manifest that names what should be here.',
					remediation: entry.remediation,
					suggestion: null,
					excerpt: null,
				})),
				note: null,
			},
		];
	}

	let document: unknown;
	try {
		document = JSON.parse(readFileSync(manifestPath, 'utf8'));
	} catch (error) {
		// A manifest that is not JSON is the one state this function can meet that has no
		// row of its own, and letting the parse throw would replace the whole report with a
		// stack trace naming a byte offset. Every other failure below names an object.
		return [
			checkRow('bundle-manifest', 1, 'manifests', [
				bundleFinding(
					'bundle-digest-mismatch',
					MANIFEST_KEY,
					`manifest.json is not JSON: ${(error as Error).message}`,
				),
			]),
		];
	}

	// The AST major is read before the schema rather than after it, and this ordering is
	// the only thing that makes `bundle-ast-major` reachable. `bundleManifestSchema` pins
	// `ast` to this toolchain's major, so a bundle written by a newer kit fails the schema
	// and used to be reported as a malformed manifest at pointer /ast. The whole reason the
	// ast-N key namespace exists is that those bundles sit beside each other legitimately,
	// so the honest answer is that this is a major this toolchain does not know, and the
	// operator's next step is a submodule bump rather than a recompile.
	const declaredMajor = (document as { ast?: unknown }).ast;
	if (typeof declaredMajor === 'number' && declaredMajor !== AST_VERSION) {
		return [
			checkRow('bundle-ast-major', 1, 'majors', [
				bundleFinding(
					'bundle-ast-major',
					MANIFEST_KEY,
					`This bundle declares AST major ${declaredMajor} and this toolchain is ${AST_VERSION}.`,
				),
			]),
		];
	}

	const parsed = bundleManifestSchema.safeParse(document);
	if (!parsed.success) {
		return [
			checkRow(
				'bundle-manifest',
				1,
				'manifests',
				parsed.error.issues.map((issue) => ({
					rule: 'bundle-digest-mismatch',
					severity: 'error' as const,
					category: 'bundle' as const,
					location: {
						kind: 'pointer' as const,
						file: MANIFEST_KEY,
						pointer: `/${issue.path.join('/')}`,
					},
					locale: null,
					message: issue.message,
					consequence: 'A manifest the reader cannot parse is a bundle nothing can mount.',
					remediation: 'Recompile the commit. A hand-edited manifest is not a supported state.',
					suggestion: null,
					excerpt: null,
				})),
			),
		];
	}
	const manifest = parsed.data;

	rows.push(
		checkRow(
			'bundle-manifest',
			1,
			'manifests',
			validateManifestShape(manifest).map((problem) =>
				bundleFinding('bundle-digest-mismatch', MANIFEST_KEY, problem),
			),
		),
	);

	rows.push(
		checkRow(
			'bundle-ast-major',
			1,
			'majors',
			manifest.ast === AST_VERSION
				? []
				: [
						bundleFinding(
							'bundle-ast-major',
							MANIFEST_KEY,
							`This bundle declares AST major ${manifest.ast} and this toolchain is ${AST_VERSION}.`,
						),
					],
		),
	);

	const present = keysUnder(directory).filter((key) => key !== MANIFEST_KEY);
	const declared = manifest.objects.map((object) => object.key);
	const missing = declared.filter((key) => !present.includes(key));
	const extra = present.filter((key) => !declared.includes(key));

	rows.push(
		checkRow('bundle-objects', declared.length, 'objects', [
			...missing.map((key) =>
				bundleFinding(
					'bundle-missing-object',
					key,
					`The manifest names "${key}" and it is not here.`,
				),
			),
			...extra.map((key) =>
				bundleFinding(
					'bundle-missing-object',
					key,
					`"${key}" is here and the manifest does not name it. A stray object from an abandoned build is invisible from the page records, which is why the key set is compared rather than the page list.`,
				),
			),
		]),
	);

	const digestProblems = [];
	let checked = 0;
	for (const object of manifest.objects) {
		const path = join(directory, object.key);
		if (!existsSync(path)) continue;
		checked += 1;
		const bytes = readFileSync(path);
		if (bytes.length !== object.bytes) {
			digestProblems.push(
				bundleFinding(
					'bundle-digest-mismatch',
					object.key,
					`Stored ${bytes.length} bytes; the manifest says ${object.bytes}.`,
				),
			);
			continue;
		}
		if (sha256Hex(bytes) !== object.digest) {
			digestProblems.push(
				bundleFinding(
					'bundle-digest-mismatch',
					object.key,
					'The stored bytes do not match the digest in the manifest.',
				),
			);
		}
	}
	rows.push(checkRow('bundle-digests', checked, 'objects', digestProblems));

	// Every payload is parsed rather than trusted. The digests above prove the bytes are
	// the bytes that were written; the schemas are what prove the bytes are a bundle.
	const payloadProblems = [];
	let payloads = 0;
	for (const object of manifest.objects) {
		const path = join(directory, object.key);
		if (!existsSync(path)) continue;
		const isPage = object.key.startsWith('pages/');
		const isIndex = object.key.startsWith('search/');
		if (!isPage && !isIndex) continue;

		payloads += 1;
		let payload: unknown;
		try {
			const bytes = readFileSync(path);
			const body = isGzipped(object.key) ? gunzipMember(bytes) : bytes;
			payload = JSON.parse(body.toString('utf8'));
		} catch (error) {
			// A member whose bytes were altered throws out of zlib, not out of the schema, and
			// this report is the only place an operator is told which object is wrong. Letting
			// it escape turns the whole run into "incorrect data check" with no key in it, on
			// exactly the corrupted bundle the digests above have already named.
			payloadProblems.push(
				bundleFinding(
					'bundle-digest-mismatch',
					object.key,
					`Could not be read back: ${(error as Error).message}`,
				),
			);
			continue;
		}

		const result = isPage
			? compiledPageSchema.safeParse(payload)
			: searchIndexSchema.safeParse(payload);
		if (!result.success) {
			payloadProblems.push(
				bundleFinding(
					'bundle-digest-mismatch',
					object.key,
					`${isPage ? 'Not a compiled page' : 'Not a search index'}: ${result.error.issues[0]?.message ?? 'unknown'}`,
				),
			);
		}
	}
	rows.push(checkRow('bundle-payloads', payloads, 'payloads', payloadProblems));

	return rows;
}

function bundleFinding(rule: string, key: string, message: string) {
	return {
		rule,
		severity: 'error' as const,
		category: 'bundle' as const,
		location: { kind: 'file' as const, file: key },
		locale: null,
		message,
		consequence:
			'A bundle that does not match its own manifest is one a consumer will mount and read wrong, because every reader trusts the manifest rather than the objects.',
		remediation:
			'Recompile the commit. A bundle is a product of a sha and nothing else, so rebuilding is always safe.',
		suggestion: null,
		excerpt: null,
	};
}
