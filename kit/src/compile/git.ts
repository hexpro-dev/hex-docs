/**
 * What git knows about the tree, read once.
 *
 * Translation staleness is a comparison of committer dates, so this is the only source
 * of truth for how fresh a page is. Two things about that are worth stating where the
 * reading happens rather than where it is used.
 *
 * **One walk, not one call per file.** A fourteen-hundred-file project would otherwise
 * spawn fourteen hundred processes on a runner, and the answer is the same: walking the
 * log once and taking the first commit that touched each path is what `git log -1 --
 * <path>` does, once per path, from the same data. That sentence was false for merge
 * commits until `--diff-merges=combined` was added below, and the equivalence test could
 * not see it because the fixture history was linear. Both are fixed; the comment at the
 * option says which case each way of walking gets wrong.
 *
 * **A shallow clone is refused rather than reported.** `actions/checkout` defaults to
 * `fetch-depth: 1`, and in a shallow clone every file carries the same commit date, so
 * English is never newer than anything and the whole corpus reads `current`. That is
 * the wrong answer that looks fine, which is the only kind worth refusing over.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** ISO 8601 with a local offset, as `%cI` emits it, normalised to UTC to the second. */
export function toUtcTimestamp(iso: string): string {
	return new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function git(root: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 64 * 1024 * 1024,
	});
}

/**
 * `git`, with a non-zero exit turned into `undefined`.
 *
 * Only used for the first call, which is what decides whether there is any history to
 * read at all. Every later call is made against a repository that has already answered
 * `rev-parse HEAD`, so a failure there is a real fault and is left to throw.
 */
function gitOrUndefined(root: string, args: string[]): string | undefined {
	try {
		return git(root, args);
	} catch {
		return undefined;
	}
}

/** The repository root at or above `from`, or `undefined` when there is not one. */
export function findRepositoryRoot(from: string): string | undefined {
	let current = resolve(from);
	for (;;) {
		if (existsSync(resolve(current, '.git'))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export interface RepositoryState {
	root: string;
	/** 40 lower-case hex. */
	head: string;
	/** The head commit's committer date, normalised to UTC. */
	headTimestamp: string;
	shallow: boolean;
	/** Repo-relative path to the committer date of the last commit that touched it. */
	dates: Map<string, string>;
}

const COMMIT_MARKER = '\u0001';

/**
 * Reads the head, the shallow flag and a committer date per path.
 *
 * Paths git has never seen are absent from the map rather than defaulting to the head's
 * date. An uncommitted file has no history, and giving it one would make a page written
 * this morning look as fresh as the source it has not been compared against yet.
 */
export function readRepository(from: string): RepositoryState | undefined {
	const root = findRepositoryRoot(from);
	if (root === undefined) return undefined;

	// A repository with no commits has a `.git` directory and an unborn HEAD, so the
	// root is found and `rev-parse HEAD` exits 128. That is a state a real app repository
	// passes through: `git init` then `hexdocs init` before anything is committed. It is
	// reported as no repository, because that is what it is for this purpose: no path has
	// a date, so no page can be compared against its source. The caller then says so in
	// one sentence naming the directory, where letting the throw through says it in a
	// child process stack trace with no file and no line.
	const head = gitOrUndefined(root, ['rev-parse', 'HEAD'])?.trim();
	if (head === undefined || head === '') return undefined;
	const headTimestamp = toUtcTimestamp(git(root, ['log', '-1', '--format=%cI']).trim());
	const shallow = git(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true';

	const dates = new Map<string, string>();
	// `--diff-merges=combined` is the option that makes the equivalence above true. A
	// plain `--name-only` walk prints no file names for a merge commit at all, so a file
	// whose most recent change was the merge's own conflict resolution is attributed to
	// whichever older commit last named it. Measured: a source page resolved in a merge
	// dated 2026-06-01 came back as 2026-01-20, four months early, so every translation of
	// it read `current` when all six were stale. That is the error this module exists to
	// refuse, arriving through the one commit shape the walk could not see.
	//
	// `--first-parent` was the other candidate and it is wrong in the other direction: it
	// attributes a file changed only on a side branch to the merge date, which for a
	// translation merged after its source changed turns a stale page into a current one.
	// The combined diff lists a merge's files only where it differs from every parent,
	// which is exactly git's own history simplification, so both cases match `git log -1`.
	// Measured against it on a conflict resolution and a side-branch-only file.
	const log = git(root, [
		'log',
		`--format=${COMMIT_MARKER}%cI`,
		'--name-only',
		'--diff-merges=combined',
	]);
	let current: string | undefined;
	for (const line of log.split('\n')) {
		if (line.startsWith(COMMIT_MARKER)) {
			current = toUtcTimestamp(line.slice(1).trim());
			continue;
		}
		const path = line.trim();
		if (path === '' || current === undefined) continue;
		// The log is newest first, so the first time a path appears is the last commit
		// that touched it. Later appearances are older and must not overwrite it.
		if (!dates.has(path)) dates.set(path, current);
	}

	return { root, head, headTimestamp, shallow, dates };
}
