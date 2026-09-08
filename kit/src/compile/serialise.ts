/**
 * The bytes a bundle is made of.
 *
 * Five primitives, in one module because between them they decide every byte the
 * compiler writes, and every digest in the manifest is taken over what they produce.
 * `manifest.ts` states the rule they exist to keep: the same commit has to compile to
 * the same bytes, because the write-once refusal is unconditional and a rebuild that
 * changed nothing must not look like a rewrite.
 *
 * Two of them are stricter than the platform, for the same reason.
 *
 * `canonicalJson` refuses several values `JSON.stringify` happily writes something for,
 * because in each of those cases what it writes is a different document from the one the
 * caller meant, and a different document with a plausible digest is the failure this
 * whole package is arranged to avoid. It also sorts keys itself rather than trusting
 * insertion order, since two builders that assembled the same record in a different
 * order would otherwise write different bytes for identical content.
 *
 * `gzipMember` asserts three properties of node's own output rather than assuming them,
 * because the member it returns is published under a commit-addressed key that nothing
 * is ever allowed to overwrite.
 */

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { GZIP_SETTINGS } from '../../../src/contracts/manifest.js';

/**
 * What a canonical document may contain.
 *
 * An object property may be `undefined`, and that is the only place it may appear:
 * `undefined` means the key is omitted, which is what optional-and-omitted means in
 * these wire formats. There is no `undefined` in the array member, on purpose, because
 * a hole in a list is not a shorter list.
 */
export type JsonValue =
	null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

/** Keys that read back as a property access. Anything else is bracketed and quoted. */
const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The path a refusal names.
 *
 * Refusals carry one because a bundle is a few thousand nested records and "the document
 * contains a bigint" is a message somebody then has to go looking for. Slugs contain
 * slashes and dots, so a key that is not an identifier is quoted rather than joined with
 * a dot, and `$.pages["guide/first-tag"]` stays unambiguous.
 */
function step(path: string, key: string): string {
	return PLAIN_KEY.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Key order, and the one comparison allowed to decide it.
 *
 * `localeCompare` sorts `a`, `ä`, `b` in that order under most locales and the raw
 * comparison sorts them `a`, `b`, `ä`, and which of those a runner produces depends on
 * its ICU build and its environment. The digest is taken over these bytes, so a
 * locale-aware comparison would make a bundle sha a property of the machine that built
 * it, and the write-once refusal would fire on a rebuild that changed nothing.
 *
 * `<` on strings compares UTF-16 code units, which is also what `[...keys].sort()` does
 * in `validateManifestShape`. That agreement is load-bearing rather than incidental:
 * the validator re-checks the page key order because it decides which page wins a
 * duplicate slug, and a serialiser ordering by code point instead would disagree with it
 * on any key outside the basic multilingual plane.
 */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A readable name for a value that is an object but is not one of ours. */
function nameOf(value: object): string {
	const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
	return typeof name === 'string' && name.length > 0 ? `a ${name}` : 'an object of no class';
}

function write(value: unknown, path: string, ancestors: Set<object>, out: string[]): void {
	if (value === null) {
		out.push('null');
		return;
	}

	switch (typeof value) {
		case 'boolean':
			out.push(value ? 'true' : 'false');
			return;
		case 'number':
			// `JSON.stringify` writes `null` for all three of these, so a budget that came
			// out of a division by zero would publish as a field that reads absent rather
			// than as a field that is wrong, and absent is a state the readers accept.
			if (!Number.isFinite(value)) {
				throw new Error(
					`${path} is ${String(value)}, which JSON has no spelling for. JSON.stringify writes ` +
						`null for it, so the document would say the field is absent rather than wrong.`,
				);
			}
			// `String` on a finite number is the same ToString `JSON.stringify` uses, and it
			// is fully specified, so it is a function of the value alone.
			out.push(String(value));
			return;
		case 'string':
			// `JSON.stringify` on a string escapes exactly what JSON requires and emits every
			// other character literally, which is what keeps 指南 one three-byte sequence in
			// the gzipped payload instead of six ASCII escapes. It also escapes a lone
			// surrogate, which matters here: unescaped it has no UTF-8 encoding and the bytes
			// the digest covers would carry a replacement character instead.
			out.push(JSON.stringify(value));
			return;
		case 'bigint':
			throw new Error(
				`${path} is a bigint. JSON.stringify throws on one and there are two ways to write ` +
					`it, as a number and as a string, so the spelling belongs at the point the value ` +
					`is built rather than here.`,
			);
		case 'undefined':
		case 'function':
		case 'symbol':
			throw new Error(
				`${path} is ${typeof value}, which has no JSON spelling. Only an object property set ` +
					`to undefined is dropped, and only because that is what optional-and-omitted means ` +
					`in these wire formats.`,
			);
	}

	if (ancestors.has(value)) {
		throw new Error(
			`${path} points back at a value that already contains it. A cycle has no canonical ` +
				`form, and JSON.stringify throws on one rather than writing a truncated document.`,
		);
	}
	ancestors.add(value);

	if (Array.isArray(value)) {
		out.push('[');
		for (let index = 0; index < value.length; index += 1) {
			if (index > 0) out.push(',');
			const element: unknown = value[index];
			// The refusal that is easiest to argue with and most worth having. An array is
			// the one place `JSON.stringify` writes `null` for a value it cannot serialise,
			// so a list of three headings with a hole in it publishes as a list of three
			// headings, one of them null, and every reader downstream believes it.
			if (element === undefined || typeof element === 'function' || typeof element === 'symbol') {
				throw new Error(
					`${path}[${index}] is ${typeof element}. JSON.stringify writes null in an array ` +
						`element's place, which is a different document, so this is a refusal rather ` +
						`than a silent hole.`,
				);
			}
			write(element, `${path}[${index}]`, ancestors, out);
		}
		out.push(']');
		ancestors.delete(value);
		return;
	}

	// Anything with a prototype of its own is refused rather than walked. A Date, a Map,
	// a Set and a Uint8Array all have no own enumerable keys, so the loop below would
	// write `{}` for each of them and the document would be silently missing a field
	// rather than loudly missing one.
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(
			`${path} is ${nameOf(value)}, not a plain object. Serialising it would walk its own ` +
				`enumerable keys, which is rarely what it holds, so it is a refusal rather than a ` +
				`guess at what it meant.`,
		);
	}

	out.push('{');
	const record = value as Record<string, unknown>;
	let written = 0;
	for (const key of Object.keys(record).sort(byCodeUnit)) {
		const child: unknown = record[key];
		if (child === undefined) continue;
		if (written > 0) out.push(',');
		out.push(JSON.stringify(key), ':');
		write(child, step(path, key), ancestors, out);
		written += 1;
	}
	out.push('}');
	ancestors.delete(value);
}

/**
 * The one serialiser every digest is taken through.
 *
 * Keys in code unit order, no whitespace anywhere, `undefined` properties dropped, and
 * a throw naming the path for every value that cannot be written honestly. The output is
 * a function of the value alone: nothing here reads a locale, a clock, an environment
 * variable or an insertion order.
 */
export function canonicalJson(value: unknown): string {
	const out: string[] = [];
	write(value, '$', new Set<object>(), out);
	return out.join('');
}

/** UTF-8 bytes, stated rather than left to a default encoding. */
export function utf8Bytes(text: string): Buffer {
	return Buffer.from(text, 'utf8');
}

/**
 * The digest under every `sha256` and `digest` field in the manifest.
 *
 * A string is encoded through `utf8Bytes` rather than handed to `update`, which would
 * reach the same answer through node's default encoding. Saying it here means the two
 * calls that matter, hashing a string and hashing the bytes of that string, are provably
 * the same call.
 */
export function sha256Hex(bytes: Uint8Array | string): string {
	const input = typeof bytes === 'string' ? utf8Bytes(bytes) : bytes;
	return createHash('sha256').update(input).digest('hex');
}

/** Bit 3 of the FLG byte: the member carries a NUL-terminated original filename. */
const FNAME = 0b0000_1000;

/**
 * The gzip member `GZIP_SETTINGS` specifies, which is not the one `gzipSync` returns.
 *
 * Only `level` is a zlib option. `GZIP_SETTINGS` is deliberately not spread into
 * `gzipSync`: node has no `os` or `mtime` option, ignores both in silence, and writes
 * byte 9 from the platform it was compiled on, 19 on macOS and 3 on Linux. A writer that
 * spread the object would produce exactly the host-dependent byte the constant exists to
 * remove, and two runners would write different bytes for the same page.
 *
 * The other two properties of the constant are assertions rather than instructions,
 * so they are asserted here. Header bytes are read through `readUInt32LE` and
 * `readUInt8` rather than by indexing, so a member too short to hold a header throws on
 * the read instead of comparing `undefined` and passing.
 */
export function gzipMember(bytes: Uint8Array): Buffer {
	const member = gzipSync(bytes, { level: GZIP_SETTINGS.level });

	const flags = member.readUInt8(3);
	if ((flags & FNAME) !== 0) {
		throw new Error(
			`gzipSync set the FNAME flag (FLG is 0x${flags.toString(16)}), so the member carries an ` +
				`original filename and its bytes depend on where the build ran. GZIP_SETTINGS.filename ` +
				`is null because nothing here can remove that field once it is written.`,
		);
	}

	// Bytes 4 to 7 are MTIME, little-endian, and zero means "no timestamp". Reading them
	// as one unsigned 32-bit value is the same assertion as four zero bytes.
	const mtime = member.readUInt32LE(4);
	if (mtime !== GZIP_SETTINGS.mtime) {
		throw new Error(
			`gzipSync wrote MTIME ${mtime}, so the member is a function of the clock as well as of ` +
				`its input. GZIP_SETTINGS.mtime is 0 and node has no mtime option to set it with.`,
		);
	}

	member.writeUInt8(GZIP_SETTINGS.os, 9);

	// The round trip runs on every member rather than once in a test, and the reason is
	// worth stating. The OS field sits outside the CRC, which covers the uncompressed
	// data, so a patch that damaged the member could not be caught by the checksum, and
	// the bytes then go to a commit-addressed key the write-once refusal will never let
	// anyone overwrite. Decompressing here is what makes "the patch is safe" a
	// measurement per member instead of a belief.
	const back = gunzipSync(member);
	if (!back.equals(bytes)) {
		throw new Error(
			`the patched member does not decompress to the bytes it was built from ` +
				`(${back.length} bytes back, ${bytes.length} in). Byte 9 is outside the CRC, so nothing ` +
				`downstream would have caught this.`,
		);
	}

	return member;
}

/**
 * The inverse, so nothing downstream reaches for zlib itself.
 *
 * Thin on purpose. It exists so the pair is one module and one test, and so a change to
 * what a member looks like has exactly one place that reads one.
 */
export function gunzipMember(bytes: Uint8Array): Buffer {
	return gunzipSync(bytes);
}
