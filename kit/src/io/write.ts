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
 * second time" is an assertion about a length rather than about a diff. `removed` is the
 * same measurement for deletions, which is what lets "a second prefetch removes nothing"
 * be a length too.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { Writer } from '../registry/command.js';

export function fileWriter(): Writer {
	const written: string[] = [];
	const removed: string[] = [];
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
		remove(path: string): boolean {
			let isDirectory: boolean;
			try {
				// `lstat`, not `stat`. A link to a directory answers as a link here, so it is
				// unlinked rather than handed to `rmdir`, which would follow it.
				isDirectory = lstatSync(path).isDirectory();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
				throw error;
			}
			// `rmdir` refuses a directory that still holds anything, and that refusal is
			// wanted: it is a throw naming the path rather than a subtree gone.
			if (isDirectory) rmdirSync(path);
			else unlinkSync(path);
			removed.push(path);
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
		get removed(): readonly string[] {
			return removed;
		},
	};
}

/**
 * A writer that records instead of writing, for a dry run and for the tests.
 *
 * `install` and `init` without `--write` use it, so the plan a person reads is produced
 * by the same code path that would apply it. A separate "describe what I would do"
 * branch is how a dry run and a real run come to disagree.
 *
 * `remove` has no disk to consult, so it cannot know whether an entry it was never shown
 * exists. It records the first removal of a path and answers true, and answers false only
 * for a path this writer has already removed and not written since. A caller that walks a
 * real tree and removes what it found, which is the only caller there is, gets the list it
 * would have produced for real; a caller that removes a path nothing ever held gets a
 * `true` that `fileWriter` would not give, and `write.test.ts` names that disagreement.
 */
export function recordingWriter(seed: Readonly<Record<string, string>> = {}): Writer & {
	readonly files: Map<string, string>;
} {
	const files = new Map<string, string>(Object.entries(seed));
	const written: string[] = [];
	const removed: string[] = [];
	const gone = new Set<string>();
	return {
		files,
		write(path: string, contents: string): boolean {
			gone.delete(path);
			if (files.get(path) === contents) return false;
			files.set(path, contents);
			written.push(path);
			return true;
		},
		remove(path: string): boolean {
			if (gone.has(path)) return false;
			files.delete(path);
			gone.add(path);
			removed.push(path);
			return true;
		},
		exists: (path) => files.has(path),
		read: (path) => files.get(path),
		get written(): readonly string[] {
			return written;
		},
		get removed(): readonly string[] {
			return removed;
		},
	};
}
