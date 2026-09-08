/**
 * `hexdocs label` / `docs_label`: is this commit safe to label as a version, and what is
 * the edit.
 *
 * **It writes nothing.** It returns the patch and a person or an agent applies it, which
 * is the boundary every scaffold in this package draws for one reason: a change applied
 * with Edit is visible in the transcript and in git, and a change a tool made to a
 * repository is visible in neither until somebody runs `git diff`. Labelling is also the
 * throttle that decides what the public sees, so it is the last edit in this package that
 * should happen without a person reading it.
 *
 * **Ancestry lives here and deliberately not in `verify-install`.** `verify-install` runs
 * inside the web repository, where the app repository is a sibling directory outside
 * every resolved root and no clone of it exists in any form; `git ls-remote` returns ref
 * tips, which cannot answer whether a commit is on a branch. So the original design's
 * "downgraded to a warning when a clone is not reachable" downgrades on every real
 * invocation, and under the house rule a check that examined nothing is a failure rather
 * than a warning. A check that is structurally always downgraded should move rather than
 * soften, and this is where it moves to: `label` is the one command a person runs with
 * the app repository in mind, so it is the one that can be given `--source-repo`, and
 * `gh api` can answer from anywhere with a network.
 *
 * Two things this command cannot currently do, said plainly rather than implied by their
 * absence. Nothing in `<project>.docs.json` names the app repository, so `owner/name` is
 * read out of the clone's own `docs/site/docs.json` and the GitHub route therefore needs
 * `--source-repo` as well; if `DocsSiteConfig` ever grows a `repo` field, or this command
 * grows a `--repo` flag, the remote route stops needing a clone. And the AWS arm below
 * tests for credentials being *configured*, not for their being valid.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import {
	checkRow,
	failedRow,
	notRunRow,
	skippedRow,
	type CheckRow,
	type Finding,
} from '../../../src/contracts/diagnostics.js';
import { LOCALES } from '../../../src/contracts/locales.js';
import { MANIFEST_KEY, bundlePrefix } from '../../../src/contracts/manifest.js';
import { DEFAULT_BUDGETS, PLAIN_CODE_LANGUAGE } from '../../../src/contracts/project.js';
import type { DocsProjectConfig } from '../../../src/contracts/project.js';
import {
	COMMIT_SHA_PATTERN,
	RELEASE_DATE_PATTERN,
	VERSION_LABEL_PATTERN,
	type DocsSiteConfig,
} from '../../../src/contracts/site.js';
import { runLint } from '../compile/lint/run.js';
import { raw, type RawFinding } from '../compile/types.js';
import { docsProjectConfigSchema, docsSiteConfigSchema } from '../contracts/config.schema.js';
import { defineCommand, type Ctx } from '../registry/command.js';

import { ROOT, bucketOf, rootOf } from './common.js';

/**
 * The config `runLint` needs, and how much of it is real.
 *
 * `label` runs in the web repository, which has no `docs/site/docs.json`: that file lives
 * in the app repository and governs content this command never reads. `runLint` is still
 * the only way a `RawFinding` becomes a `Finding`, because severity resolution, the
 * suppression pass, the de-duplication and the finding order all live there, and a
 * hand-assembled `Finding` here would be a second definition of what a report is. That is
 * the drift `diagnostics.ts` opens by refusing.
 *
 * Only `lint` is read on this path. Every finding this command can produce is a
 * `CheckId`, and `severityFor` pins a check to `error` before the config is consulted at
 * all; `maxDisables` is compared against an empty suppression list. The remaining fields
 * are here because `DocsProjectConfig` is not partial, and they are the narrowest legal
 * value for each rather than a plausible-looking description of a project that does not
 * exist. Written as a whole object rather than a cast so that a field added to
 * `DocsProjectConfig` fails the typecheck here by name, instead of arriving as an
 * `undefined` inside `runLint` some releases later.
 */
const LINT_CONFIG: DocsProjectConfig = {
	docs: 1,
	project: 'hexdocs',
	productName: 'hexdocs',
	repo: 'hexpro-dev/hex-docs',
	defaultAudience: 'both',
	headingIds: 'slug',
	sections: [],
	i18n: { locales: [...LOCALES], sourceLocale: 'en', parity: 'graceful' },
	budgets: DEFAULT_BUDGETS,
	code: { languages: [PLAIN_CODE_LANGUAGE] },
	toc: { enabled: true, maxDepth: 3, minHeadings: 3 },
	lint: { extends: 'house', maxDisables: 0 },
};

/** Raw findings to reportable ones, through the one path that resolves a severity. */
function report(entries: readonly RawFinding[], kitVersion: string): Finding[] {
	return runLint(entries, { config: LINT_CONFIG, disables: [], kitVersion }).envelope.findings;
}

/**
 * Directories a search for a site config never enters.
 *
 * A cap on the walk rather than a nicety: `node_modules` in a pnpm monorepo is hundreds
 * of thousands of entries, and `_bundles` is a prefetched bundle tree with one directory
 * per version per project. Neither can contain a `<project>.docs.json` that anything
 * reads.
 */
const SKIP_DIRECTORIES = new Set([
	'node_modules',
	'.git',
	'.cache',
	'.turbo',
	'.next',
	'build',
	'dist',
	'coverage',
	'_bundles',
]);

/** How deep the search goes. `apps/front/app/docs/<project>.docs.json` is four. */
const MAX_DEPTH = 8;

/**
 * Every `<project>.docs.json` under a root.
 *
 * Every match is returned rather than the first, because two of them is a real state and
 * a silent choice between them is the wrong answer in the reassuring direction: a
 * monorepo with two sites mounting the same project would be labelled in one of them and
 * the other would go on serving the old version list with nothing saying so.
 */
function findSiteConfigs(root: string, project: string): string[] {
	const wanted = `${project}.docs.json`;
	const found: string[] = [];
	const walk = (directory: string, depth: number): void => {
		if (depth > MAX_DEPTH) return;
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			// An unreadable directory is not a failure of this search. It is reported as "no
			// config found" if nothing else matched, which names the root rather than a
			// permission error on a directory nobody asked about.
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
				walk(join(directory, entry.name), depth + 1);
			} else if (entry.name === wanted) {
				found.push(join(directory, entry.name));
			}
		}
	};
	walk(root, 0);
	return found.sort();
}

/**
 * The prefetch cache root.
 *
 * The default cannot be a `Param.fallback`, because that is one printed value and this
 * one is a function of the environment. So it is resolved here with the default named in
 * the flag's help text, which is the same shape `init` uses for a default it cannot spell
 * statically. `XDG_CACHE_HOME` is honoured because `hex-terraform/deploy/src/build.ts`
 * already honours it, and a second convention would put the deploy's cache and this
 * command's cache in two places on one machine.
 */
function cacheRoot(flag: string | undefined, cwd: string): string {
	if (flag !== undefined) return resolve(cwd, flag);
	const xdg = process.env['XDG_CACHE_HOME'];
	const base = xdg === undefined || xdg === '' ? join(homedir(), '.cache') : xdg;
	return join(base, 'hexdocs');
}

/**
 * Whether AWS credentials are *configured*. Not whether they work.
 *
 * There is no cheap call that proves a credential is live, and the honest reading of this
 * function is the narrow one: it says whether asking the bucket is worth attempting. An
 * expired SSO session passes this test, the `head-object` below then fails with an
 * authentication error, and that lands in the "could not answer" branch rather than in
 * "there is no bundle". Those two must not be confused, which is why every non-zero exit
 * from the CLI is classified rather than treated as absence.
 *
 * The estate's `default` profile deliberately carries no credentials, so an unset
 * `AWS_PROFILE` really does mean unconfigured here rather than "the default will do".
 */
function awsConfigured(): boolean {
	return [
		'AWS_PROFILE',
		'AWS_DEFAULT_PROFILE',
		'AWS_ACCESS_KEY_ID',
		'AWS_WEB_IDENTITY_TOKEN_FILE',
		'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
		'AWS_CONTAINER_CREDENTIALS_FULL_URI',
	].some((name) => {
		const value = process.env[name];
		return value !== undefined && value !== '';
	});
}

/** What one arm of a two-arm check answered. */
type Arm = 'yes' | 'no' | { unavailable: string };

/**
 * `head-object` on the bundle's manifest, classified.
 *
 * A 404 is the only non-zero exit that means "this key is not there". Everything else,
 * including a missing `aws` binary, an expired session and a bucket this identity cannot
 * see, is an unanswered question, and reporting one of those as an absent bundle would
 * block a label over a machine's configuration.
 */
function headManifest(ctx: Ctx, bucket: string, key: string, cwd: string): Arm {
	const result = ctx.exec('aws.head-object', [bucket, key], { cwd, timeoutMs: 30_000 });
	if (result.status === 0) return 'yes';
	if (result.status === null) {
		return { unavailable: `the aws CLI could not be run: ${result.stderr.trim()}` };
	}
	if (/\(404\)/.test(result.stderr)) return 'no';
	return {
		unavailable: `aws s3api head-object exited ${result.status}: ${firstLine(result.stderr)}`,
	};
}

function firstLine(text: string): string {
	const line = text.trim().split('\n')[0] ?? '';
	return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

/** `YYYY-MM-DD` in UTC. */
function isoDate(now: Date): string {
	// UTC rather than the local date, because `RELEASE_DATE_PATTERN` is a date with no
	// zone in it: rendering the local date would make the same command produce two
	// different `released` values for one instant on two machines, and the file would then
	// disagree with itself about when a version shipped depending on who ran it.
	return now.toISOString().slice(0, 10);
}

/**
 * Reads the site config, keeping the bytes as well as the parse.
 *
 * The bytes are what the patch is anchored to. Rewriting the file from the parsed object
 * would reformat somebody else's decisions, and this command does not write the file at
 * all: it hands over the smallest edit it can name.
 */
function readSiteConfig(path: string): { config: DocsSiteConfig; text: string } | { why: string } {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		return { why: `${path} could not be read: ${(error as Error).message}` };
	}
	let document: unknown;
	try {
		document = JSON.parse(text);
	} catch (error) {
		return { why: `${path} is not JSON: ${(error as Error).message}` };
	}
	const parsed = docsSiteConfigSchema.safeParse(document);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return {
			why: `${path} is not a valid site config: ${issue === undefined ? 'unknown' : `${issue.message} at /${issue.path.join('/')}`}`,
		};
	}
	return { config: parsed.data as DocsSiteConfig, text };
}

/** `owner/name` for the app repository, from the clone's own project config. */
function repoOfClone(clone: string): { repo: string } | { why: string } {
	const path = join(clone, 'docs', 'site', 'docs.json');
	if (!existsSync(path)) {
		return { why: `${path} does not exist, so nothing names the GitHub repository` };
	}
	try {
		const parsed = docsProjectConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
		if (!parsed.success) return { why: `${path} is not a valid project config` };
		return { repo: (parsed.data as DocsProjectConfig).repo };
	} catch (error) {
		return { why: `${path} could not be read: ${(error as Error).message}` };
	}
}

type Ancestry =
	| { kind: 'ancestor' }
	| { kind: 'not-ancestor'; detail: string }
	| { kind: 'unknown-sha'; detail: string }
	| { kind: 'unavailable'; why: string };

/**
 * Ancestry through the GitHub API.
 *
 * Two calls, and the first one earns its place twice over. It reads `default_branch`
 * rather than assuming `main`, and a repository on `master` or `trunk` would otherwise
 * come back 404 from the compare endpoint and be reported as an unknown sha, which is a
 * wrong answer that reads as a real finding. It also establishes that the repository is
 * reachable by this identity, which is what makes a 404 from the second call a statement
 * about the commit rather than about access.
 */
function ancestryFromGitHub(ctx: Ctx, repo: string, commit: string, cwd: string): Ancestry {
	const probe = ctx.exec('gh.api', [`repos/${repo}`], { cwd, timeoutMs: 30_000 });
	if (probe.status !== 0) {
		return {
			kind: 'unavailable',
			why:
				probe.status === null
					? `gh could not be run: ${probe.stderr.trim()}`
					: `gh api repos/${repo} exited ${probe.status}: ${firstLine(probe.stderr)}`,
		};
	}
	let branch: string;
	try {
		const parsed = JSON.parse(probe.stdout) as { default_branch?: unknown };
		if (typeof parsed.default_branch !== 'string' || parsed.default_branch === '') {
			return { kind: 'unavailable', why: `gh api repos/${repo} named no default branch` };
		}
		branch = parsed.default_branch;
	} catch (error) {
		return { kind: 'unavailable', why: `gh api repos/${repo}: ${(error as Error).message}` };
	}

	const compare = ctx.exec('gh.api', [`repos/${repo}/compare/${branch}...${commit}`], {
		cwd,
		timeoutMs: 30_000,
	});
	if (compare.status !== 0) {
		if (/HTTP 404/.test(compare.stderr) || /"status"\s*:\s*"404"/.test(compare.stdout)) {
			return {
				kind: 'unknown-sha',
				detail: `${repo} does not know the commit ${commit}, and the repository itself answered.`,
			};
		}
		return {
			kind: 'unavailable',
			why: `gh api compare exited ${compare.status}: ${firstLine(compare.stderr)}`,
		};
	}
	let status: unknown;
	try {
		status = (JSON.parse(compare.stdout) as { status?: unknown }).status;
	} catch (error) {
		return { kind: 'unavailable', why: `gh api compare: ${(error as Error).message}` };
	}
	// `identical` is the tip itself and `behind` is a commit the branch has moved past;
	// both mean the commit is on the branch. `ahead` and `diverged` mean it is not.
	if (status === 'identical' || status === 'behind') return { kind: 'ancestor' };
	if (status === 'ahead' || status === 'diverged') {
		return {
			kind: 'not-ancestor',
			detail: `${repo} reports the commit as "${status}" against ${branch}.`,
		};
	}
	return { kind: 'unavailable', why: `gh api compare returned status "${String(status)}"` };
}

/**
 * Ancestry from a local clone, which is the fallback and not the preference.
 *
 * A clone answers from whatever it last fetched, so a stale `origin/<branch>` reports a
 * commit as not an ancestor when it is one, and reports nothing at all about a commit
 * pushed since. The remote is asked first for that reason, and this runs when there is no
 * `gh` or no network.
 */
function ancestryFromClone(ctx: Ctx, clone: string, commit: string, ref: string): Ancestry {
	const result = ctx.exec('git.merge-base-is-ancestor', [commit, ref], {
		cwd: clone,
		timeoutMs: 30_000,
	});
	// Exit 1 is the answer "no". Anything else, 128 for an unknown ref or an unknown object
	// included, is the absence of an answer: treating 128 as "not an ancestor" would report
	// a missing `origin/<branch>` as a commit on the wrong branch.
	if (result.status === 0) return { kind: 'ancestor' };
	if (result.status === 1) {
		return { kind: 'not-ancestor', detail: `${commit} is not an ancestor of ${ref} in ${clone}.` };
	}
	return {
		kind: 'unavailable',
		why:
			result.status === null
				? `git could not be run: ${result.stderr.trim()}`
				: `git merge-base --is-ancestor exited ${result.status}: ${firstLine(result.stderr)}`,
	};
}

/**
 * The exact text to insert, and the line to insert it after.
 *
 * The indent is derived from the file rather than assumed. The fixture and both consumers
 * use tabs, and a patch that hard-coded them would produce a diff with a reformatted
 * block in it the first time somebody's editor writes spaces, which is a review that stops
 * being about the version being added.
 */
export function patchFor(
	text: string,
	entry: { label: string; commit: string; released: string },
): { anchor: string; insert: string } | null {
	const match = /^([ \t]*)"versions"\s*:\s*\[[ \t]*$/m.exec(text);
	if (match === null) return null;
	const outer = match[1] ?? '\t';
	// One level in from the `versions` key. Every consistently indented JSON document
	// indents by the same unit at every level, so the key's own indent is that unit.
	const item = outer.repeat(2);
	const field = outer.repeat(3);
	const insert = [
		`${item}{`,
		`${field}"label": ${JSON.stringify(entry.label)},`,
		`${field}"commit": ${JSON.stringify(entry.commit)},`,
		`${field}"released": ${JSON.stringify(entry.released)}`,
		// The trailing comma is unconditional because the schema requires at least one
		// existing entry, so this one is never the last line of the array.
		`${item}},`,
	].join('\n');
	return { anchor: match[0], insert };
}

export const label = defineCommand({
	name: 'label',
	tool: 'docs_label',
	writes: 'nothing',
	summary: 'Check that a commit is safe to label as a version, and return the edit.',
	detail:
		'Labelling is the throttle: a bundle exists for every commit, and none of them is visible until a version entry in <project>.docs.json names one. This checks the three things that make a label wrong before anybody can see it. The shape of the label, the sha and the date, and that neither the label nor the commit is already in the table. That a bundle actually exists for that commit, in the prefetch cache and, when AWS credentials are configured, in the bucket. And that the commit is on the app repository default branch, through the GitHub API or a local clone given with --source-repo. It writes nothing: the JSON to insert and the line to insert it after come back as data, so the edit is applied by hand and shows up in git.',
	params: {
		root: ROOT,
		project: {
			help: 'the project id, matching <project>.docs.json and the app repository docs.json',
			type: 'string',
			required: true,
		},
		commit: {
			help: 'the 40-character lower-case commit sha to label',
			type: 'string',
			required: true,
		},
		version: {
			help: 'the version label; it becomes a URL segment under /v/<label>/',
			type: 'string',
			required: true,
		},
		released: {
			help: 'the release date as YYYY-MM-DD; defaults to today in UTC',
			type: 'string',
		},
		'source-repo': {
			help: 'a local clone of the app repository, used to name it and to answer ancestry offline',
			type: 'string',
		},
		cache: {
			help: 'the prefetch cache; defaults to $XDG_CACHE_HOME/hexdocs, or ~/.cache/hexdocs',
			type: 'string',
		},
	},
	positionals: [],
	taughtBy: ['docs-publish-version'],
	async run(input, ctx) {
		const root = rootOf(ctx.cwd, input.root);
		const released = input.released ?? isoDate(ctx.now());
		const rows: CheckRow[] = [];
		const notes: string[] = [];

		// ---- the file this label goes into ------------------------------------

		/**
		 * All three rows, all `not-run`, when the file cannot be read.
		 *
		 * Not one row. A report carrying `label-shape` alone leaves a reader unable to say
		 * whether the other two passed or never ran, and dark is indistinguishable from
		 * green to anything reading the list rather than the exit code. Two of the three
		 * could technically still answer without the config, and they do not, because a
		 * label with nowhere to go is not a label and reporting on it would be reporting on
		 * a version entry nobody can create.
		 */
		const nothingChecked = (why: string) => ({
			data: { project: input.project, root, checked: false, why },
			lines: [why],
			envelope: null,
			rows: [
				notRunRow('label-shape', 'site configs', why),
				notRunRow('label-bundle-exists', 'site configs', why),
				notRunRow('label-ancestry', 'site configs', why),
			],
		});

		const candidates = findSiteConfigs(root, input.project);
		if (candidates.length !== 1) {
			return nothingChecked(
				candidates.length === 0
					? `No ${input.project}.docs.json under ${root}. A version entry has nowhere to go, so nothing was checked. Run \`hexdocs install\` first, or point --root at the web repository.`
					: `${candidates.length} files named ${input.project}.docs.json under ${root}: ${candidates.join(', ')}. Labelling one of them would leave the others serving the old version list with nothing saying so.`,
			);
		}
		const configPath = candidates[0] as string;
		const read = readSiteConfig(configPath);
		if (!('config' in read)) return nothingChecked(read.why);
		const { config, text } = read;
		const where = relative(root, configPath) || configPath;

		// ---- label-shape ------------------------------------------------------

		const problems: string[] = [];
		if (!COMMIT_SHA_PATTERN.test(input.commit)) {
			problems.push(
				`"${input.commit}" is not a commit sha. It must be 40 lower-case hex characters; abbreviations are refused because they collide eventually.`,
			);
		}
		if (!VERSION_LABEL_PATTERN.test(input.version)) {
			problems.push(
				`"${input.version}" is not a version label. It is a URL segment under /v/<label>/, so it starts with a letter or a digit and carries only letters, digits, dot, underscore and hyphen, up to 32 characters.`,
			);
		}
		if (!RELEASE_DATE_PATTERN.test(released)) {
			problems.push(`"${released}" is not a release date. The format is YYYY-MM-DD.`);
		}
		const sameLabel = config.versions.find((entry) => entry.label === input.version);
		if (sameLabel !== undefined) {
			problems.push(
				`"${input.version}" already labels ${sameLabel.commit.slice(0, 8)} in ${where}. A label is a URL segment and two entries sharing one means two bundles at one address.`,
			);
		}
		const sameCommit = config.versions.find((entry) => entry.commit === input.commit);
		if (sameCommit !== undefined) {
			problems.push(
				`${input.commit.slice(0, 8)} is already labelled "${sameCommit.label}" in ${where}. Two labels on one commit serve identical bytes at two addresses, which is legal and is almost always a copy-paste.`,
			);
		}
		rows.push(
			problems.length === 0
				? checkRow('label-shape', 5, 'assertions', [])
				: // `failedRow` rather than a finding: none of these five has a rule id to name,
					// and inventing one would put a check in `Finding.rule` that nothing else in
					// the package reports under. That is exactly what `failedRow` exists for.
					failedRow('label-shape', 5, 'assertions', problems.join(' ')),
		);

		// ---- label-bundle-exists ----------------------------------------------

		const cache = cacheRoot(input.cache, ctx.cwd);
		const prefix = bundlePrefix(input.project, input.commit);
		const cached = join(cache, prefix, MANIFEST_KEY);
		const local: Arm = existsSync(cached) ? 'yes' : 'no';

		const bucket = bucketOf(undefined);
		let remote: Arm;
		if (!awsConfigured()) {
			remote = {
				unavailable:
					'no AWS credentials are configured in this environment, so the bucket was not asked',
			};
		} else if ('why' in bucket) {
			remote = { unavailable: bucket.why };
		} else {
			remote = headManifest(ctx, bucket.bucket, `${prefix}/${MANIFEST_KEY}`, ctx.cwd);
		}

		// The two arms and their six combinations. The bucket is the authority on whether a
		// bundle exists, because that is what a deploy fetches from; the cache is a copy of
		// it on this machine. So a cache miss with the object present is a prefetch that has
		// not run, which is not a reason to refuse a label, and a cache hit with the object
		// absent is a bundle that was built locally and never published, which is.
		const armsExamined = typeof remote === 'string' ? 2 : 1;
		const remoteNote =
			typeof remote === 'string' ? null : `bucket not asked: ${remote.unavailable}`;
		if (remote === 'no') {
			rows.push(
				checkRow(
					'label-bundle-exists',
					armsExamined,
					'bundle locations',
					report(
						[
							raw(
								'bundle-label-unknown-sha',
								{ kind: 'file', file: where },
								null,
								`${where} would label ${input.commit.slice(0, 8)} as "${input.version}" and the bucket holds no ${prefix}/${MANIFEST_KEY}. The version dropdown would offer a version whose every page 404s.`,
								{
									remediation: `Either the publish workflow has not run for that commit, or it ran at a different AST major. \`hexdocs bundle ${join(cache, prefix)}\` says what this machine has.`,
								},
							),
						],
						ctx.kitVersion,
					),
					local === 'yes'
						? 'The prefetch cache holds this bundle and the bucket does not, so it was built locally and never published.'
						: null,
				),
			);
		} else if (local === 'no' && remote !== 'yes') {
			rows.push(
				checkRow(
					'label-bundle-exists',
					armsExamined,
					'bundle locations',
					report(
						[
							raw(
								'bundle-label-unknown-sha',
								{ kind: 'file', file: where },
								null,
								`No bundle for ${input.commit.slice(0, 8)}: ${cached} does not exist, and the bucket could not be asked.`,
								{
									remediation: `Run \`hexdocs prefetch\` on this machine, or configure AWS credentials so the bucket can answer. ${remote.unavailable}.`,
								},
							),
						],
						ctx.kitVersion,
					),
					remoteNote,
				),
			);
		} else {
			rows.push(
				checkRow(
					'label-bundle-exists',
					armsExamined,
					'bundle locations',
					[],
					local === 'no'
						? `The bucket holds this bundle and the prefetch cache does not; \`hexdocs prefetch\` will fetch it.`
						: remoteNote,
				),
			);
		}

		// ---- label-ancestry ---------------------------------------------------

		const clone =
			input['source-repo'] === undefined ? null : resolve(ctx.cwd, input['source-repo']);
		const bothRoutes =
			'Pass --source-repo with a local clone of the app repository. It is what names the GitHub repository for `gh api repos/<owner>/<name>/compare`, and it is also the offline route, `git merge-base --is-ancestor`. Nothing in a site config names the app repository, so without it neither route knows which repository to ask about.';

		if (clone === null) {
			rows.push(skippedRow('label-ancestry', 'commits', bothRoutes));
		} else if (!existsSync(clone) || !statSync(clone).isDirectory()) {
			rows.push(
				skippedRow(
					'label-ancestry',
					'commits',
					`${clone} is not a directory, so neither ancestry route ran. ${bothRoutes}`,
				),
			);
		} else {
			const named = repoOfClone(clone);
			let answer: Ancestry;
			let route: string;
			if ('repo' in named) {
				answer = ancestryFromGitHub(ctx, named.repo, input.commit, root);
				route = `gh api repos/${named.repo}/compare`;
				if (answer.kind === 'unavailable') {
					const remoteWhy = answer.why;
					const fallback = ancestryFromClone(ctx, clone, input.commit, 'origin/HEAD');
					route = `git merge-base --is-ancestor in ${clone}, after ${remoteWhy}`;
					// Both reasons, not the first one. A row that named only the GitHub failure
					// would send somebody to check their `gh` login when the clone was the thing
					// that could not answer, and the two failures have nothing to do with each
					// other.
					answer =
						fallback.kind === 'unavailable'
							? { kind: 'unavailable', why: `${remoteWhy}; and ${fallback.why}` }
							: fallback;
				}
			} else {
				// No `owner/name`, so only the local route is available. `origin/HEAD` rather
				// than `origin/main`: a repository whose default branch is not `main` would
				// otherwise fail with an unknown ref, which this classifies as no answer and
				// which is a `skipped` row where the clone could have answered.
				answer = ancestryFromClone(ctx, clone, input.commit, 'origin/HEAD');
				route = `git merge-base --is-ancestor in ${clone} (${named.why})`;
			}

			switch (answer.kind) {
				case 'ancestor':
					rows.push(checkRow('label-ancestry', 1, 'commits', [], route));
					break;
				case 'not-ancestor':
					rows.push(
						failedRow(
							'label-ancestry',
							1,
							'commits',
							`${answer.detail} Labelling a commit that is not on the default branch publishes documentation for code nobody has merged, at an address the sitemap points at.`,
						),
					);
					break;
				case 'unknown-sha':
					rows.push(
						checkRow(
							'label-ancestry',
							1,
							'commits',
							report(
								[
									raw(
										'bundle-label-unknown-sha',
										{ kind: 'file', file: where },
										null,
										`${answer.detail} A commit the repository has never seen has no bundle and never will.`,
										{
											remediation:
												'Check the sha. A force push can also remove a commit that was once on the branch, in which case the bundle it produced is still in the bucket and is no longer reproducible.',
										},
									),
								],
								ctx.kitVersion,
							),
						),
					);
					break;
				default:
					rows.push(
						skippedRow(
							'label-ancestry',
							'commits',
							`Neither route could answer. ${answer.why}. ${bothRoutes}`,
						),
					);
			}
		}

		// ---- the edit ----------------------------------------------------------

		const entry = { label: input.version, commit: input.commit, released };
		const patch = patchFor(text, entry);
		if (patch === null) {
			notes.push(
				`Could not find the \`"versions": [\` line in ${where}, so there is no anchored patch. Add the entry above the newest existing one by hand.`,
			);
		}
		notes.push(
			'This entry carries no `"default": true`. Moving the default changes which version is served at the unprefixed address, which pages are in the sitemap and which are indexable, and it changes `pages` with it, so it is a separate edit somebody decides on.',
			'It also carries no `digest`. `hexdocs sync` writes that after fetching the manifest, and it is the only integrity pin on the bundle, because a manifest cannot carry its own digest.',
		);

		return {
			data: {
				project: input.project,
				root,
				// The discriminator the refusal above also carries, so a reader of `--json`
				// never has to infer from a missing key whether anything was examined.
				checked: true,
				file: configPath,
				entry,
				patch: patch === null ? null : { path: configPath, ...patch },
				notes,
			},
			lines: [
				`${where}: label ${input.commit.slice(0, 8)} as "${input.version}", released ${released}.`,
				...notes,
			],
			envelope: null,
			rows,
		};
	},
});
