/**
 * Reading the fixture corpus, and turning it into a repository with a real history.
 *
 * Both suites go through here. The runtime half reads the tree to check the things a
 * consumer can check with no toolchain at all, and the toolchain half validates it
 * against the schemas and, from step 3, compiles it. One reader means the compiler and
 * the renderer cannot end up disagreeing about what the corpus is.
 *
 * The history is the part worth explaining. Translation staleness is
 * `git log -1 --format=%cI` on the English file against the same on the translation, so
 * a corpus committed in one go contains no stale page and cannot grow one. That is the
 * shallow-clone failure this package refuses to run under, reproduced by accident: every
 * file carries one date, nothing is newer than anything, and the whole corpus reads
 * `current`. `materialiseCorpus` builds a throwaway repository with the dates the
 * corpus declares, so the states are produced rather than asserted.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_HISTORY, REVISED_PATHS } from './corpus.js';

export * from './corpus.js';
export * from './frontmatter.js';
export * from './nodes.js';
export * from './planted.js';
export * from './text.js';

export const FIXTURE_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

/** The synthetic app repository: everything a content source owns. */
export const APP_ROOT = join(FIXTURE_ROOT, 'app');

/** The publishable root. Everything the compiler reads resolves against this. */
export const SITE_ROOT = join(APP_ROOT, 'docs', 'site');

/** The consuming website's half of the pair: `<project>.docs.json`. */
export const CONSUMER_ROOT = join(FIXTURE_ROOT, 'site');

/** Assets that must be refused, kept outside the tree that has to build. */
export const REJECTED_ROOT = join(FIXTURE_ROOT, 'rejected');

/**
 * Every file under `app/`, relative to it, with forward slashes, sorted.
 *
 * Symlinks are skipped rather than followed, matching the compiler's own rule: a
 * symlink is the only way a checked-out tree can point outside itself, and it is the
 * whole of what stops a page escaping `docs/site/`.
 */
export function appFiles(root: string = APP_ROOT): string[] {
	const found: string[] = [];

	const walk = (directory: string, prefix: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : 1,
		)) {
			if (entry.isSymbolicLink()) continue;
			const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name === '.git') continue;
				walk(join(directory, entry.name), relative);
			} else {
				found.push(relative);
			}
		}
	};

	walk(root, '');
	return found.sort();
}

/** One file from the corpus, as bytes read back as UTF-8. */
export function readAppFile(path: string, root: string = APP_ROOT): string {
	return readFileSync(join(root, path), 'utf8');
}

/**
 * What the first commit writes for a file a later commit revises.
 *
 * It has to differ from the final content or the revising commit is empty, `git log -1`
 * never moves, and the staleness the corpus declares silently does not exist. The front
 * matter is kept so the placeholder is a plausible earlier draft rather than a fragment.
 */
function placeholderFor(content: string): string {
	const lines = content.split('\n');
	if (lines[0] !== '---') return 'The first draft of this page.\n';
	const close = lines.indexOf('---', 1);
	if (close === -1) return 'The first draft of this page.\n';
	return `${lines.slice(0, close + 1).join('\n')}\n\nThe first draft of this page.\n`;
}

export interface MaterialisedCommit {
	message: string;
	at: string;
	sha: string;
	files: string[];
}

export interface MaterialisedCorpus {
	/** The repository root. `docs/site` sits under it, as in a real app repository. */
	root: string;
	commits: MaterialisedCommit[];
}

function git(root: string, args: string[], at?: string): string {
	return execFileSync(
		'git',
		[
			'-c',
			'user.name=Fixture',
			'-c',
			'user.email=fixture@example.com',
			'-c',
			'commit.gpgsign=false',
			...args,
		],
		{
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			env:
				at === undefined
					? process.env
					: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
		},
	);
}

/**
 * Copies the corpus into `target` and replays `FIXTURE_HISTORY` over it.
 *
 * Throws rather than returning problems. Every failure here means the corpus and the
 * declared history disagree, which makes every state downstream of it meaningless, so
 * there is nothing useful to carry on and report.
 */
export function materialiseCorpus(target: string): MaterialisedCorpus {
	mkdirSync(target, { recursive: true });
	cpSync(APP_ROOT, target, { recursive: true, dereference: false, verbatimSymlinks: true });

	const files = appFiles();
	const revised = new Set(REVISED_PATHS);
	for (const path of revised) {
		if (!files.includes(path)) {
			throw new Error(
				`REVISED_PATHS names ${path}, which is not in the corpus. A revision of a file that ` +
					`does not exist would make its commit empty and the staleness it produces imaginary.`,
			);
		}
		writeFileSync(join(target, path), placeholderFor(readAppFile(path)), 'utf8');
	}

	git(target, ['init', '--quiet', '-b', 'main']);

	const commits: MaterialisedCommit[] = [];
	for (const commit of FIXTURE_HISTORY) {
		const touched = files.filter((path) => commit.touches(path));
		if (touched.length === 0) {
			throw new Error(
				`The commit "${commit.message}" touches no file in the corpus. Either its predicate is ` +
					`stale or the files it named were renamed, and either way the date it exists to set ` +
					`is now set on nothing.`,
			);
		}
		for (const path of touched) {
			if (!revised.has(path)) continue;
			if (commits.length === 0) continue;
			writeFileSync(join(target, path), readAppFile(path), 'utf8');
		}

		git(target, ['add', '--', ...touched]);
		const staged = git(target, ['diff', '--cached', '--name-only']).trim();
		if (staged === '') {
			throw new Error(
				`The commit "${commit.message}" staged nothing. A commit with no diff does not move ` +
					`git log -1 for any path, so the staleness it declares would not exist.`,
			);
		}

		git(target, ['commit', '--quiet', '-m', commit.message], commit.at);
		commits.push({
			message: commit.message,
			at: commit.at,
			sha: git(target, ['rev-parse', 'HEAD']).trim(),
			files: staged.split('\n'),
		});
	}

	// The placeholder must not survive into what the compiler reads. Checking the whole
	// tree rather than the revised files alone is what makes the copy itself trustworthy,
	// and comparing bytes rather than decoded text is what makes it cover the assets: a
	// PNG read as UTF-8 loses every invalid sequence to one replacement character, so two
	// different images compare equal.
	for (const path of files) {
		if (!readFileSync(join(target, path)).equals(readFileSync(join(APP_ROOT, path)))) {
			throw new Error(
				`${path} in the materialised repository does not match the corpus. The history left an ` +
					`earlier revision behind, which means the tree the compiler reads is not the tree on disk.`,
			);
		}
	}

	return { root: target, commits };
}

/**
 * The committer date git reports for one path, normalised to `Z`.
 *
 * `%cI` emits a local offset, so this is the same normalisation the compiler owes the
 * manifest. Doing it here as well means a test can compare a fixture date against a
 * declared one without either side having to know what timezone the run is in.
 */
export function committerDate(root: string, path: string): string | undefined {
	const raw = git(root, ['log', '-1', '--format=%cI', '--', path]).trim();
	if (raw === '') return undefined;
	return new Date(raw).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** True when a path exists under `app/`. For the tests that check declared coverage. */
export function appFileExists(path: string): boolean {
	return existsSync(join(APP_ROOT, path));
}
