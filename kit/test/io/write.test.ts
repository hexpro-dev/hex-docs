/**
 * The only path from this package to the filesystem, and the recording twin of it.
 *
 * Two claims are load-bearing everywhere else and neither is checked anywhere else.
 *
 * **A write that would produce bytes already on disk is not a write.** Every command's
 * idempotency contract is measured through `written`, so "running install twice writes
 * nothing the second time" is an assertion about a length rather than about a diff. A
 * writer that pushed every path would make every one of those assertions vacuous while
 * the commands themselves stayed correct.
 *
 * **The dry run and the real run cannot disagree**, because `install` and `init` without
 * `--write` produce the plan a person reads through the same code path that would apply
 * it. That is only true while `recordingWriter` answers the same questions the same way,
 * so the two are driven through one script below and compared rather than described.
 */

import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { fileWriter, recordingWriter } from '../../src/io/write.js';
import type { Writer } from '../../src/registry/command.js';

let root: string;
let counter = 0;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'hexdocs-write-'));
});

afterAll(() => {
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** A fresh directory per test, so no test can see another test's bytes. */
function scratch(): string {
	counter += 1;
	const directory = join(root, `case-${counter}`);
	mkdirSync(directory, { recursive: true });
	return directory;
}

/** A timestamp far enough in the past that any rewrite moves it by seconds. */
const PLANTED_MTIME = new Date('2020-01-02T03:04:05Z');

// ---------------------------------------------------------------------------
// fileWriter
// ---------------------------------------------------------------------------

describe('fileWriter', () => {
	test('writes a new file, creating the directories above it', () => {
		const directory = scratch();
		const writer = fileWriter();
		const path = join(directory, 'a', 'b', 'c.json');

		expect(writer.write(path, '{"a":1}\n')).toBe(true);
		expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
		expect(writer.written).toEqual([path]);
	});

	test('returns false and does not touch the file when the bytes are already there', () => {
		// "Does not touch" is measured rather than inferred. `mtime` is planted far in the
		// past, so a writer that opened the file for writing and produced the same bytes moves
		// it to now, and the two are seconds apart rather than milliseconds.
		const directory = scratch();
		const writer = fileWriter();
		const path = join(directory, 'same.txt');
		writeFileSync(path, 'the same bytes\n');
		utimesSync(path, PLANTED_MTIME, PLANTED_MTIME);

		expect(writer.write(path, 'the same bytes\n')).toBe(false);

		expect(statSync(path).mtime.getTime()).toBe(PLANTED_MTIME.getTime());
		expect(writer.written).toEqual([]);
		expect(readFileSync(path, 'utf8')).toBe('the same bytes\n');
	});

	test('a read-only file is not opened at all when the bytes match', () => {
		// The second half of the same claim, from the other side: opening this file for
		// writing throws EACCES, so a writer that wrote unconditionally could not return
		// false here. Skipped as root, where the mode means nothing, rather than passing on a
		// probe that cannot fail.
		const directory = scratch();
		const path = join(directory, 'locked.txt');
		writeFileSync(path, 'locked\n');
		chmodSync(path, 0o444);
		const rootUser = typeof process.getuid === 'function' && process.getuid() === 0;

		try {
			expect(fileWriter().write(path, 'locked\n')).toBe(false);
			if (!rootUser) {
				// The control: the same call with different bytes really does have to open it,
				// and really does fail. Without this the row above would pass on a filesystem
				// that ignored the mode.
				expect(() => fileWriter().write(path, 'different\n')).toThrow();
			}
		} finally {
			chmodSync(path, 0o644);
		}
	});

	test('a line ending is a change, so a file that only differs by CRLF is rewritten', () => {
		const directory = scratch();
		const writer = fileWriter();
		const path = join(directory, 'endings.txt');
		writeFileSync(path, 'a\r\nb\r\n');

		expect(writer.write(path, 'a\nb\n')).toBe(true);
		expect(readFileSync(path)).toEqual(Buffer.from('a\nb\n', 'utf8'));
		expect(writer.written).toEqual([path]);
		// Naming the limit: a comparison over decoded text answers this case identically, so
		// this row is a statement about behaviour rather than a discriminator between the two
		// implementations. The next test is the discriminator.
	});

	test('the comparison is over bytes, which a decoded comparison cannot be', () => {
		// A file holding a byte that is not valid UTF-8 decodes to U+FFFD, and so does the
		// replacement character itself. `readFileSync(path, 'utf8') === contents` therefore
		// reports these two as identical and leaves the broken bytes on disk, where
		// `Buffer.equals` sees one byte against three.
		const directory = scratch();
		const writer = fileWriter();
		const path = join(directory, 'invalid.txt');
		const broken = Buffer.from([0x61, 0x80, 0x62]);
		writeFileSync(path, broken);
		expect(readFileSync(path, 'utf8')).toBe('a\uFFFDb');

		expect(writer.write(path, 'a\uFFFDb')).toBe(true);

		expect(readFileSync(path)).toEqual(Buffer.from('a\uFFFDb', 'utf8'));
		expect(readFileSync(path)).not.toEqual(broken);
		expect(writer.written).toEqual([path]);
	});

	test('written lists only the paths that actually changed, in call order', () => {
		const directory = scratch();
		const writer = fileWriter();
		const a = join(directory, 'a.txt');
		const b = join(directory, 'b.txt');

		expect(writer.write(a, 'one')).toBe(true);
		expect(writer.write(a, 'one')).toBe(false);
		expect(writer.write(b, 'two')).toBe(true);
		expect(writer.write(a, 'changed')).toBe(true);
		expect(writer.write(b, 'two')).toBe(false);

		expect(writer.written).toEqual([a, b, a]);
	});

	test('exists and read answer about the filesystem, and a missing path is undefined', () => {
		const directory = scratch();
		const writer = fileWriter();
		const path = join(directory, 'present.txt');
		writeFileSync(path, 'here\n');

		expect(writer.exists(path)).toBe(true);
		expect(writer.read(path)).toBe('here\n');
		expect(writer.exists(join(directory, 'absent.txt'))).toBe(false);
		expect(writer.read(join(directory, 'absent.txt'))).toBeUndefined();
		// A directory is not a file this can read, and the honest answer is the same
		// `undefined` rather than an exception out of a prebuild hook.
		expect(writer.read(directory)).toBeUndefined();
	});

	test('remove takes one file and says so, and a second remove finds nothing', () => {
		const directory = scratch();
		const writer = fileWriter();
		const path = join(directory, 'gone.txt');
		writeFileSync(path, 'bytes\n');

		expect(writer.remove(path)).toBe(true);
		expect(existsSync(path)).toBe(false);
		expect(writer.remove(path)).toBe(false);
		expect(writer.remove(join(directory, 'never.txt'))).toBe(false);
		expect(writer.removed).toEqual([path]);
		expect(writer.written).toEqual([]);
	});

	test('remove unlinks a symbolic link and leaves what it points at', () => {
		// The property a prune depends on. A link planted inside a tree the prune owns, and
		// pointing at a directory somewhere else, has to go without anything behind it going:
		// `rmdir` or a recursive remove would follow it.
		const directory = scratch();
		const outside = join(directory, 'outside');
		mkdirSync(outside);
		writeFileSync(join(outside, 'precious.txt'), 'keep me\n');
		const fileTarget = join(directory, 'target.txt');
		writeFileSync(fileTarget, 'also keep me\n');
		const toDirectory = join(directory, 'to-directory');
		const toFile = join(directory, 'to-file');
		symlinkSync(outside, toDirectory);
		symlinkSync(fileTarget, toFile);

		const writer = fileWriter();
		expect(writer.remove(toDirectory)).toBe(true);
		expect(writer.remove(toFile)).toBe(true);

		expect(() => lstatSync(toDirectory)).toThrow();
		expect(() => lstatSync(toFile)).toThrow();
		expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me\n');
		expect(readFileSync(fileTarget, 'utf8')).toBe('also keep me\n');
		expect(writer.removed).toEqual([toDirectory, toFile]);
	});

	test('remove takes an empty directory and refuses one that still holds anything', () => {
		// Never recursive. A directory with something left in it is a throw naming the path,
		// which is loud, rather than a subtree that is quietly gone.
		const directory = scratch();
		const empty = join(directory, 'empty');
		const full = join(directory, 'full');
		mkdirSync(empty);
		mkdirSync(full);
		writeFileSync(join(full, 'inside.txt'), 'x');

		const writer = fileWriter();
		expect(writer.remove(empty)).toBe(true);
		expect(existsSync(empty)).toBe(false);
		expect(() => writer.remove(full)).toThrow(/ENOTEMPTY|EEXIST/);
		expect(readFileSync(join(full, 'inside.txt'), 'utf8')).toBe('x');
		expect(writer.removed).toEqual([empty]);
	});

	test('a remove that cannot look is a throw rather than an answer of nothing there', () => {
		// Only ENOENT means absent. A path whose parent is a file answers ENOTDIR, and
		// reading that as "already gone" would let a prune report a clean tree it never saw.
		const directory = scratch();
		const file = join(directory, 'plain.txt');
		writeFileSync(file, 'x');
		expect(() => fileWriter().remove(join(file, 'child'))).toThrow(/ENOTDIR/);
	});

	test('two writers over one tree keep separate lists, which is what a per-run count needs', () => {
		// `written` is per writer and every command is handed a fresh one, so a second run in
		// the same process reports its own writes rather than the total since start.
		const directory = scratch();
		const path = join(directory, 'shared.txt');
		const first = fileWriter();
		const second = fileWriter();

		expect(first.write(path, 'x')).toBe(true);
		expect(second.write(path, 'x')).toBe(false);
		expect(first.written).toEqual([path]);
		expect(second.written).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// recordingWriter, against fileWriter
// ---------------------------------------------------------------------------

/**
 * One script, run against both writers, so a dry run and a real run cannot disagree.
 *
 * The paths are relative to whatever root the caller gives, which is how the same script
 * addresses a temporary directory and a bare map. Every step returns its answer, and the
 * two answer lists are compared element for element rather than summarised.
 */
function script(
	writer: Writer,
	at: (name: string) => string,
): {
	answers: boolean[];
	written: readonly string[];
	removed: readonly string[];
	reads: (string | undefined)[];
	exists: boolean[];
} {
	const answers = [
		writer.write(at('one.txt'), 'first'),
		writer.write(at('one.txt'), 'first'),
		writer.write(at('one.txt'), 'second'),
		writer.write(at('nested/two.txt'), 'a'),
		writer.write(at('nested/two.txt'), 'a'),
		writer.write(at('three.txt'), ''),
		writer.write(at('three.txt'), ''),
		writer.write(at('four.txt'), 'doomed'),
		writer.remove(at('four.txt')),
		writer.remove(at('four.txt')),
		writer.write(at('four.txt'), 'back'),
	];
	return {
		answers,
		written: writer.written,
		removed: writer.removed,
		reads: [
			writer.read(at('one.txt')),
			writer.read(at('missing.txt')),
			writer.read(at('three.txt')),
			writer.read(at('four.txt')),
		],
		exists: [
			writer.exists(at('one.txt')),
			writer.exists(at('missing.txt')),
			writer.exists(at('four.txt')),
		],
	};
}

describe('recordingWriter behaves identically to fileWriter', () => {
	test('the same script produces the same answers, the same written list and the same reads', () => {
		const directory = scratch();
		const real = script(fileWriter(), (name) => join(directory, ...name.split('/')));
		const recorded = script(recordingWriter(), (name) => join(directory, ...name.split('/')));

		expect(recorded.answers).toEqual(real.answers);
		expect(recorded.written).toEqual(real.written);
		expect(recorded.removed).toEqual(real.removed);
		expect(real.removed).toHaveLength(1);
		expect(recorded.reads).toEqual(real.reads);
		expect(recorded.exists).toEqual(real.exists);
		// And the script really did exercise both answers, so an equality between two lists
		// of all-true would not satisfy it.
		expect(new Set(real.answers)).toEqual(new Set([true, false]));
	});

	test('what the recording writer holds is what the real one left on disk', () => {
		const directory = scratch();
		const at = (name: string): string => join(directory, ...name.split('/'));
		script(fileWriter(), at);
		const recording = recordingWriter();
		script(recording, at);

		let compared = 0;
		for (const [path, contents] of recording.files) {
			expect([path, readFileSync(path, 'utf8')]).toEqual([path, contents]);
			compared += 1;
		}
		expect(compared).toBe(4);
	});

	test('a seeded recording writer reports the seeded bytes as already there', () => {
		// The seed is how a test hands the dry run a repository it does not have on disk, so
		// a seeded value that still counted as a write would make every planned edit look new.
		const writer = recordingWriter({ '/x/a.json': '{"a":1}\n' });

		expect(writer.exists('/x/a.json')).toBe(true);
		expect(writer.read('/x/a.json')).toBe('{"a":1}\n');
		expect(writer.write('/x/a.json', '{"a":1}\n')).toBe(false);
		expect(writer.write('/x/a.json', '{"a":2}\n')).toBe(true);
		expect(writer.written).toEqual(['/x/a.json']);
		expect(writer.files.get('/x/a.json')).toBe('{"a":2}\n');
	});

	test('the recording writer touches no filesystem, which is the whole point of a dry run', () => {
		const directory = scratch();
		const path = join(directory, 'never.txt');
		const writer = recordingWriter();

		expect(writer.write(path, 'planned')).toBe(true);
		expect(fileWriter().exists(path)).toBe(false);
	});

	test('the one thing the two cannot agree about, named rather than left to be found', () => {
		// `fileWriter` compares bytes and `recordingWriter` compares strings, so a file already
		// holding bytes that are not valid UTF-8 is a change to one and nothing to the other.
		// It cannot arise in a dry run, which has no bytes on disk to disagree with, and it is
		// written down here so the parity claim above is read as the claim it is.
		const directory = scratch();
		const path = join(directory, 'invalid.txt');
		writeFileSync(path, Buffer.from([0x61, 0x80, 0x62]));

		expect(fileWriter().write(path, 'a\uFFFDb')).toBe(true);
		expect(recordingWriter({ [path]: 'a\uFFFDb' }).write(path, 'a\uFFFDb')).toBe(false);
	});

	test('the second: a remove of something nothing ever held', () => {
		// `fileWriter` looks and finds nothing. `recordingWriter` has no disk to look at, so
		// it records the removal: its only caller walks a real tree and removes what that walk
		// found, and a dry run of that walk has to report those paths rather than an empty
		// list. A removal nobody found first is the case the two answer differently.
		const directory = scratch();
		const path = join(directory, 'nothing-here.txt');
		expect(fileWriter().remove(path)).toBe(false);
		const recording = recordingWriter();
		expect(recording.remove(path)).toBe(true);
		expect(recording.removed).toEqual([path]);
		expect(recording.remove(path)).toBe(false);
	});
});
