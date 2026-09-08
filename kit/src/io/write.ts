/**
 * The only path from this package to the filesystem, outside the bundle writer.
 *
 * Every command that writes takes it from `Ctx.write`, which is `null` under MCP, so
 * "the server mutates nothing" is enforced by there being nothing to call rather than by
 * a flag somebody could set. `kit/src/compile/bundle.ts` is the deliberate exception and
 * predates this: it is reached only by `build` and `publish`, both CLI-only, and its
 * write-once refusal is a stronger guarantee than this interface can express.
 *
 * A write that would produce bytes already on disk is not a write. That is what makes
 * every command's idempotency contract measurable rather than asserted: `written` is the
 * list of paths that actually changed, so "running install twice writes nothing the
 * second time" is an assertion about a length rather than about a diff.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Writer } from '../registry/command.js';

export function fileWriter(): Writer {
	const written: string[] = [];
	return {
		write(path: string, contents: string): boolean {
			if (existsSync(path)) {
				// Compared as bytes, not as decoded text. A change of line ending or a
				// stripped byte order mark is a change, and a comparison that normalised
				// either would report an identical file and leave the old bytes there.
				const existing = readFileSync(path);
				if (existing.equals(Buffer.from(contents, 'utf8'))) return false;
			}
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, contents, 'utf8');
			written.push(path);
			return true;
		},
		exists: (path) => existsSync(path),
		read(path: string): string | undefined {
			try {
				return readFileSync(path, 'utf8');
			} catch {
				return undefined;
			}
		},
		get written(): readonly string[] {
			return written;
		},
	};
}

/**
 * A writer that records instead of writing, for a dry run and for the tests.
 *
 * `install` and `init` without `--write` use it, so the plan a person reads is produced
 * by the same code path that would apply it. A separate "describe what I would do"
 * branch is how a dry run and a real run come to disagree.
 */
export function recordingWriter(seed: Readonly<Record<string, string>> = {}): Writer & {
	readonly files: Map<string, string>;
} {
	const files = new Map<string, string>(Object.entries(seed));
	const written: string[] = [];
	return {
		files,
		write(path: string, contents: string): boolean {
			if (files.get(path) === contents) return false;
			files.set(path, contents);
			written.push(path);
			return true;
		},
		exists: (path) => files.has(path),
		read: (path) => files.get(path),
		get written(): readonly string[] {
			return written;
		},
	};
}
