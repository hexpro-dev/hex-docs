/**
 * Every wiring check, fired at least once, on both consumer shapes, by breaking a file.
 *
 * This is `rules-fire.test.ts` applied to the other half of the id space, and it exists
 * for the reason `kit/src/README.md` gives at the head of its failure catalogue: eleven
 * check ids sat in `CHECK_IDS` through four steps with a green suite, because the only
 * test over them was `test/contracts/constants.test.ts` asserting that ten `wiring-*` ids
 * exist. A literal in an unreachable branch satisfies a grep and satisfies that test. So
 * nothing here scans source for a string: every row is proved by breaking a real file in a
 * materialised consumer and reading the row that comes back.
 *
 * Two namespaces meet here and they are not the same one. `Finding.rule` is the closed
 * union `LintRuleId | CheckId`, and it is what the union assertions below are keyed on.
 * `CheckRow.id` is a plain string and it is a **row** id: `verifyBundle` has emitted
 * `bundle-manifest`, `bundle-objects`, `bundle-digests` and `bundle-payloads` as row ids
 * since step 3 and none of them is in `CHECK_IDS`. A both-directions coverage test keyed
 * on row ids therefore fails against the compiler's own existing output, and one keyed on
 * `Finding.rule` is the one worth having. The row id is still asserted per mutation,
 * because a finding landing on the wrong row is its own failure.
 *
 * The mutation table is the shape that matters more than the cases. Each entry names the
 * one row it must turn red and the message that names the arm inside that row, and every
 * mutation is also checked from the other side: every other row keeps the status it had on
 * the wired baseline. Without that second half a mutation that broke the whole descriptor
 * would satisfy this file, and the row it claimed would be red for the wrong reason.
 *
 * The route table is answered by `route-loader.ts`, a model of `react-router routes --json`,
 * because no React Router is installed here; that file says what the model copies from the
 * real loader and what it does not. The by-hand edits are pasted from the same constants the
 * printed instructions are rendered from, by `apply-instructions.ts`.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { CONSUMER_ROOT, materialiseCorpus } from '../../../fixtures/index.js';
import {
	CONSUMER_SHAPES,
	GLOB_WORKSPACE,
	LITERAL_WORKSPACE,
	MOUNT_OF,
	SITE_OF,
	materialiseConsumerWithConfig,
	removeConsumer,
	type ConsumerShape,
} from '../../../fixtures/consumers.js';
import type { CheckRow, CheckState } from '../../../src/contracts/diagnostics.js';
import { CHECK_IDS, type CheckId } from '../../../src/contracts/lint.js';
import { docsRouteRows } from '../../../src/site/address.js';
import { buildBundle } from '../../src/compile/build.js';
import { check } from '../../src/commands/check.js';
import { install } from '../../src/commands/install.js';
import type { Exec } from '../../src/exec/run.js';
import { runRecipe } from '../../src/exec/run.js';
import { fileWriter } from '../../src/io/write.js';
import { invoke } from '../../src/registry/command.js';
import { CONSUMER_CHECK_IDS, runConsumerChecks } from '../../src/wiring/checks.js';
import { detectSite } from '../../src/wiring/detect.js';
import {
	DOCS_PAGES_BARE,
	LANG_CHILDREN_WITH_DOCS,
	MACHINE_ROUTES_SPREAD,
	PAGE_TUPLES_SPREAD,
	ROOT_DECISION,
	rootChanges,
	routesChanges,
	sitemapChanges,
	type Change,
} from '../../src/wiring/instructions.js';
import { parseJsonc } from '../../src/wiring/needles.js';
import { validConfigs } from '../../src/wiring/site.js';

import { applyRoot, applyRoutes, applySitemap, indent, once } from './apply-instructions.js';
import { modelExec } from './route-loader.js';

const SITE_CONFIG = join(CONSUMER_ROOT, 'fixture-app.docs.json');
const KIT_VERSION = '@hex-pro/docs-kit@0.0.0-test';

/** A gitlink sha. Never resolved: `git ls-files -s` prints what the index holds. */
const GITLINK_SHA = 'a'.repeat(40);

interface Repo {
	readonly shape: ConsumerShape;
	readonly root: string;
	readonly site: string;
	readonly mount: string;
}

function read(repo: Repo, path: string): string {
	return readFileSync(join(repo.root, path), 'utf8');
}

function write(repo: Repo, path: string, text: string): void {
	const target = join(repo.root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, text, 'utf8');
}

function edit(repo: Repo, path: string, change: (text: string) => string): void {
	write(repo, path, change(read(repo, path)));
}

function remove(repo: Repo, path: string): void {
	rmSync(join(repo.root, path), { recursive: true, force: true });
}

/**
 * Reads with the comment-stripping parser and writes back as strict JSON.
 *
 * `parseJsonc` rather than `JSON.parse`, because hex-web's `apps/front/tsconfig.json`
 * carries block comments inside its `paths` object and the fixture reproduces that. The
 * comments do not survive the round trip, which is fine here and is exactly what
 * `insertIntoBlock` exists to avoid in the applier: these are mutations, not edits.
 */
function editJson(
	repo: Repo,
	path: string,
	change: (value: Record<string, unknown>) => void,
): void {
	const value = parseJsonc(read(repo, path)) as Record<string, unknown>;
	change(value);
	write(repo, path, `${JSON.stringify(value, null, '\t')}\n`);
}

function git(repo: Repo, ...argv: string[]): void {
	execFileSync('git', argv, {
		cwd: repo.root,
		stdio: 'ignore',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'Fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
		},
	});
}

/**
 * The exec every run here uses: the route table from the model, everything else for real.
 *
 * The rows the model hands `routes.ts` as `DOCS_ROUTES` are the rows `docsRouteRows` derives
 * from the site configs on disk at the time, so a mutation to a config changes the table the
 * way it would in the site.
 */
function execFor(repo: Repo): Exec {
	return modelExec(() =>
		docsRouteRows(validConfigs(detectSite({ repoRoot: repo.root, site: repo.site }))),
	);
}

/**
 * A consumer with every edit applied, mechanical and by hand.
 *
 * The mechanical half goes through `install --write` rather than being written here, so
 * the baseline this file calls "wired" is the state `install` actually produces and not a
 * second description of it. The by-hand half is pasted from the constants the printed
 * instructions are rendered from.
 *
 * What is set up that is not docs wiring, stated so it is not mistaken for it: the mount's
 * source files and launcher, because two rows assert that a path they read resolves to
 * something on disk, and the site's `@types/react` and `react-router` binary, which a real
 * site has once its dependencies are installed. The binary is a placeholder that is never
 * run; its presence is what `readRouteTable` looks for before asking the exec. No mount is
 * passed: hex-web's fixture carries a `common/` directory and kcalc's does not, so detection
 * proposes the real mount for each.
 */
async function wire(shape: ConsumerShape, into: string): Promise<void> {
	const consumer = materialiseConsumerWithConfig(shape, SITE_CONFIG);
	const repo: Repo = { shape, root: consumer.root, site: consumer.site, mount: consumer.mount };

	for (const file of ['src/index.ts', 'src/render/index.ts', 'src/contracts/index.ts']) {
		write(repo, `${repo.mount}/${file}`, 'export {};\n');
	}
	write(repo, `${repo.mount}/kit/start.sh`, '#!/bin/sh\nexec ./bin/hexdocs mcp\n');
	write(repo, `${repo.site}/node_modules/@types/react/index.d.ts`, 'export {};\n');
	write(repo, `${repo.site}/node_modules/.bin/react-router`, '#!/bin/sh\nexit 70\n');

	// By hand: the submodule stanza. `install` refuses this one because a stanza with no
	// gitlink is a state a fresh clone gets nothing from, and `git submodule add` writes
	// both in one operation.
	edit(
		repo,
		'.gitmodules',
		(text) =>
			`${text}[submodule "${repo.mount}"]\n\tpath = ${repo.mount}\n\turl = git@github.com:hexpro-dev/hex-docs.git\n`,
	);

	await invoke(
		install,
		{ root: repo.root, site: repo.site, write: true },
		{
			cwd: repo.root,
			kitVersion: KIT_VERSION,
			exec: execFor(repo),
			write: fileWriter(),
			now: () => new Date(0),
			log: () => {},
		},
	);

	// By hand: the three insertions `install` prints, pasted from its constants.
	edit(repo, `${repo.site}/app/routes.ts`, applyRoutes);
	edit(repo, `${repo.site}/app/root.tsx`, applyRoot);
	edit(repo, `${repo.site}/app/routes/sitemap[.]xml.tsx`, applySitemap);

	// The gitlink. `git add -A` stages the mount's files, which is what a superproject with
	// no submodule pin looks like, so they are dropped from the index and replaced by one
	// `160000` entry. That is the fact `wiring-submodule` reads and it is not in any file.
	git(repo, 'init', '-q');
	git(repo, 'add', '-A');
	git(repo, 'rm', '-r', '--cached', '-q', repo.mount);
	git(repo, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_SHA},${repo.mount}`);

	cpSync(repo.root, into, { recursive: true, verbatimSymlinks: true });
	removeConsumer(consumer);
}

let scratch: string;
const TEMPLATES = new Map<ConsumerShape, string>();
const BASELINE = new Map<ConsumerShape, Map<string, CheckState>>();
let copies = 0;

function rowsOf(repo: Repo): CheckRow[] {
	const site = detectSite({ repoRoot: repo.root, site: repo.site });
	return runConsumerChecks(site, { exec: execFor(repo), kitVersion: KIT_VERSION });
}

function copy(shape: ConsumerShape): Repo {
	copies += 1;
	const root = join(scratch, `copy-${copies}`);
	cpSync(TEMPLATES.get(shape) as string, root, { recursive: true, verbatimSymlinks: true });
	return { shape, root, site: SITE_OF[shape], mount: MOUNT_OF[shape] };
}

beforeAll(async () => {
	// git is not optional here. Two rows read the index and the fixture corpus cannot be
	// materialised without it, so a missing git would turn this file into a set of green
	// rows that examined nothing, which is the thing the whole suite refuses.
	execFileSync('git', ['--version'], { stdio: 'ignore' });

	scratch = mkdtempSync(join(tmpdir(), 'hexdocs-checks-fire-'));
	for (const shape of CONSUMER_SHAPES) {
		const template = join(scratch, `template-${shape}`);
		await wire(shape, template);
		TEMPLATES.set(shape, template);
		const repo = copy(shape);
		BASELINE.set(shape, new Map(rowsOf(repo).map((row) => [row.id, row.status])));
	}
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

interface Outcome {
	/** What the claimed row must become. */
	readonly status: CheckState;
	/**
	 * The message that names the arm, or `null` for a row-level state with no finding.
	 *
	 * A regular expression rather than a rule id, for the reason `rules-fire.test.ts` gives
	 * about multi-arm rules: `wiring-prebuild-hook` reports many different things and a
	 * mutation that broke one of them keeps the row red while the others are deleted.
	 */
	readonly message: RegExp | null;
	/** For a `skipped`, `not-run` or `failed` row, which carries its reason as a note. */
	readonly note?: RegExp;
	/**
	 * Rows other than the claimed one that this mutation legitimately moves.
	 *
	 * Declared rather than tolerated. The two entries that need it are the invalid and the
	 * missing site config: every address on this mount is derived from that file, so a config
	 * that does not validate takes the sitemap's source and the routes row's docs rows away
	 * with it.
	 */
	readonly also?: readonly CheckId[];
}

interface Mutation {
	/** What is wrong, in the words a reader of a failure would want. */
	readonly name: string;
	/** The row it must turn red, asserted as the row id and as `Finding.rule`. */
	readonly check: CheckId;
	/** What this would catch. Read when the mutation stops producing what it claims. */
	readonly why: string;
	readonly shapes?: readonly ConsumerShape[];
	apply(repo: Repo): void;
	outcome(shape: ConsumerShape): Outcome;
}

const fails = (message: RegExp) => (): Outcome => ({ status: 'fail', message });

const failsWithNote = (note: RegExp) => (): Outcome => ({ status: 'fail', message: null, note });

/** The prebuild string install wrote, which every prebuild mutation starts from. */
function editPrebuild(repo: Repo, change: (script: string) => string): void {
	editJson(repo, `${repo.site}/package.json`, (value) => {
		const scripts = value['scripts'] as Record<string, string>;
		scripts['prebuild'] = change(scripts['prebuild'] as string);
	});
}

const routesFile = (repo: Repo): string => `${repo.site}/app/routes.ts`;
const pageModule = (repo: Repo): string => `${repo.site}/app/routes/docs.tsx`;
const machineModule = (repo: Repo): string => `${repo.site}/app/routes/docs.machine.tsx`;
const rootFile = (repo: Repo): string => `${repo.site}/app/root.tsx`;
const sitemapFile = (repo: Repo): string => `${repo.site}/app/routes/sitemap[.]xml.tsx`;

const MUTATIONS: readonly Mutation[] = [
	// -------------------------------------------------------------------------
	// wiring-submodule
	// -------------------------------------------------------------------------
	{
		name: 'the docs stanza is gone from .gitmodules',
		check: 'wiring-submodule',
		why: 'A mount nothing declares is a fresh clone with an empty directory and a module resolution error inside the build.',
		apply: (repo) =>
			edit(repo, '.gitmodules', (text) =>
				text.replace(new RegExp(`\\[submodule "${repo.mount}"\\][^[]*`), ''),
			),
		outcome: fails(/declares no submodule at `[^`]+`/),
	},
	{
		name: 'the stanza is there and the superproject records no gitlink',
		check: 'wiring-submodule',
		why: 'The stanza and the gitlink are two facts and only one of them is in a file. This is the arm no text match can reach.',
		apply: (repo) => git(repo, 'update-index', '--force-remove', repo.mount),
		outcome: fails(/git records no gitlink for it/),
	},

	// -------------------------------------------------------------------------
	// wiring-workspace-exclusion, where the two consumers differ on purpose
	// -------------------------------------------------------------------------
	{
		name: 'the workspace exclusion is deleted',
		check: 'wiring-workspace-exclusion',
		why: 'The whole reason there are two consumer shapes. hex-web has a glob that enrols the mount, so the exclusion is load-bearing; kcalc has an explicit literal list with no glob, so an exclusion there would be inert decoration and a check demanding one would fail a correctly wired repository forever.',
		apply: (repo) =>
			edit(repo, 'pnpm-workspace.yaml', (text) =>
				text
					.split('\n')
					.filter((line) => !line.includes(`!${repo.mount}`))
					.join('\n'),
			),
		outcome: (shape) =>
			shape === 'glob-workspace'
				? { status: 'fail', message: /enrols `[^`]+` as a workspace package through `common\/\*`/ }
				: { status: 'pass', message: null },
	},
	{
		name: 'the exclusion loses its double quotes',
		check: 'wiring-workspace-exclusion',
		why: 'An unquoted exclusion satisfies pnpm and fails the consumer own guard, which matches that literal string including the quotes. It is a red row in a file this install never touched.',
		shapes: ['glob-workspace'],
		apply: (repo) =>
			edit(repo, 'pnpm-workspace.yaml', (text) =>
				text.replace(`"!${repo.mount}"`, `!${repo.mount}`),
			),
		outcome: fails(/excludes `[^`]+` without the double quotes/),
	},
	{
		name: 'the packages list reads as empty',
		check: 'wiring-workspace-exclusion',
		why: 'A file that exists and cannot be read is a failure, not a pass. Reporting success over a list this check cannot see is the false green the whole row exists against.',
		apply: (repo) => write(repo, 'pnpm-workspace.yaml', 'onlyBuiltDependencies:\n  - esbuild\n'),
		outcome: failsWithNote(/Read zero packages entries/),
	},
	{
		name: 'there is no pnpm-workspace.yaml at all',
		check: 'wiring-workspace-exclusion',
		why: 'Nothing can enrol the mount, so there is nothing to be wrong. The assertion is on the state: `skipped` carries the reason and is not a pass.',
		apply: (repo) => remove(repo, 'pnpm-workspace.yaml'),
		outcome: () => ({ status: 'skipped', message: null, note: /no pnpm-workspace\.yaml/ }),
	},

	// -------------------------------------------------------------------------
	// wiring-tsconfig-path
	// -------------------------------------------------------------------------
	{
		name: 'the docs specifier is not in compilerOptions.paths',
		check: 'wiring-tsconfig-path',
		why: 'vite-tsconfig-paths is the only thing turning these into Vite aliases, so without them tsc and Vite disagree about the same specifier inside a submodule during a deploy.',
		apply: (repo) =>
			editJson(repo, `${repo.site}/tsconfig.json`, (value) => {
				const options = value['compilerOptions'] as Record<string, unknown>;
				delete (options['paths'] as Record<string, unknown>)['@hex-pro/docs'];
			}),
		outcome: fails(/does not map the docs package to its TypeScript source/),
	},
	{
		name: 'a paths entry points at a file that is not checked out',
		check: 'wiring-tsconfig-path',
		why: 'A key that is present and dangles resolves to nothing, and the error names a path rather than a missing install. Nothing in a consuming repository builds a dist/, which is why they point at source.',
		apply: (repo) => remove(repo, `${repo.mount}/src/render/index.ts`),
		outcome: fails(/would resolve to `[^`]+src\/render\/index\.ts`, which does not exist/),
	},
	{
		name: 'react is not mapped to the site own types',
		check: 'wiring-tsconfig-path',
		why: 'tsc resolves a bare react from the submodule by walking up past a directory with no node_modules/react, so the render half fails to typecheck in the consumer with ten resolution errors.',
		apply: (repo) =>
			editJson(repo, `${repo.site}/tsconfig.json`, (value) => {
				const options = value['compilerOptions'] as Record<string, unknown>;
				delete (options['paths'] as Record<string, unknown>)['react'];
			}),
		outcome: fails(/does not map `react` to this site's own types/),
	},
	{
		name: 'the site has no @types/react installed',
		check: 'wiring-tsconfig-path',
		why: 'A wildcard target is checked as the directory it expands under, because a literal star is never on disk; this is the arm that tells an uninstalled site from a missing submodule.',
		apply: (repo) => remove(repo, `${repo.site}/node_modules/@types`),
		outcome: fails(
			/`react\/\*` would resolve to `[^`]+node_modules\/@types\/react`, which does not exist/,
		),
	},
	{
		name: 'resolveJsonModule is switched off',
		check: 'wiring-tsconfig-path',
		why: 'The server module globs *.docs.json, and both consumers set the option in the shared config every front extends.',
		apply: (repo) =>
			editJson(repo, `${repo.site}/tsconfig.json`, (value) => {
				(value['compilerOptions'] as Record<string, unknown>)['resolveJsonModule'] = false;
			}),
		outcome: fails(/`resolveJsonModule` is false for/),
	},
	{
		name: 'the extends chain ends at a file that is not there',
		check: 'wiring-tsconfig-path',
		why: 'Neither real consumer sets the option in its own tsconfig, so following extends is not optional. An unfollowable chain is reported as could-not-determine rather than as false, which are different states.',
		apply: (repo) => remove(repo, 'config/tsconfig.front.json'),
		outcome: fails(/Could not determine `resolveJsonModule`/),
	},
	{
		name: 'the site tsconfig does not parse',
		check: 'wiring-tsconfig-path',
		why: 'Refusing to report success on a configuration this check cannot see is the house idiom, and it is a fail rather than a skip because the file is there.',
		apply: (repo) => write(repo, `${repo.site}/tsconfig.json`, '{ "compilerOptions": {'),
		outcome: failsWithNote(/did not parse, even with comments stripped/),
	},
	{
		name: 'the site has no tsconfig',
		check: 'wiring-tsconfig-path',
		why: 'No path mapping to check is not the same as a correct one.',
		apply: (repo) => remove(repo, `${repo.site}/tsconfig.json`),
		outcome: failsWithNote(/does not exist, so this site has no path mapping/),
	},

	// -------------------------------------------------------------------------
	// wiring-deploy-hash-dirs
	// -------------------------------------------------------------------------
	{
		name: 'the mount is not listed in hash.extra_dirs',
		check: 'wiring-deploy-hash-dirs',
		why: 'Change detection is hash based over project directories. An unlisted submodule leaves the hash identical, the deploy reports unchanged, and production keeps serving the old code.',
		apply: (repo) =>
			editJson(repo, 'deploy.config.json', (value) => {
				const hash = value['hash'] as Record<string, unknown>;
				const extra = hash['extra_dirs'] as Record<string, string[]>;
				extra['front'] = (extra['front'] as string[]).filter((entry) => entry !== repo.mount);
			}),
		outcome: fails(/does not list `[^`]+` in hash\.extra_dirs\.front/),
	},
	{
		name: 'extra_dirs has no key for this project type at all',
		check: 'wiring-deploy-hash-dirs',
		why: 'A separate arm from the one above, and the difference matters at the applier: kcalc extra_dirs holds only a worker key, so the site key has to be created rather than appended to, and `?? []` at the reading end cannot tell the two states apart.',
		apply: (repo) =>
			editJson(repo, 'deploy.config.json', (value) => {
				const hash = value['hash'] as Record<string, unknown>;
				delete (hash['extra_dirs'] as Record<string, unknown>)['front'];
			}),
		outcome: fails(/has no hash\.extra_dirs\.front key at all/),
	},
	{
		name: 'no project in deploy.config.json has this site path',
		check: 'wiring-deploy-hash-dirs',
		why: 'extra_dirs is keyed by project type, not by site. A hard-coded `front` would add the mount to a key nothing hashes, which is the exact failure this row exists for.',
		apply: (repo) =>
			editJson(repo, 'deploy.config.json', (value) => {
				delete value['sites'];
			}),
		outcome: failsWithNote(/no project whose path is/),
	},
	{
		name: 'there is no deploy.config.json',
		check: 'wiring-deploy-hash-dirs',
		why: 'This repository does not deploy through hex-terraform, so there is no hash to extend. `skipped` with the reason, never a pass.',
		apply: (repo) => remove(repo, 'deploy.config.json'),
		outcome: () => ({ status: 'skipped', message: null, note: /no deploy\.config\.json/ }),
	},

	// -------------------------------------------------------------------------
	// wiring-prebuild-hook, where the prefetch segment is bound the way the CLI binds it
	// -------------------------------------------------------------------------
	{
		name: 'nothing in the build chain runs prefetch',
		check: 'wiring-prebuild-hook',
		why: 'There is no CI on either consumer, so a check that only runs when somebody types it is not a guard. prebuild is the one thing that always runs.',
		apply: (repo) =>
			editPrebuild(repo, (script) => script.replace(/\S*hexdocs prefetch[^&]*&& /, '')),
		outcome: fails(/build chain runs `hexdocs prefetch`/),
	},
	{
		name: 'the step 5 fragment passes --root, which prefetch refuses',
		check: 'wiring-prebuild-hook',
		why: 'The exact fragment step 5 installed: root is a positional, so every build exited 2 in prebuild while a substring test stayed green.',
		apply: (repo) =>
			editPrebuild(repo, (script) => script.replace(' prefetch ', ' prefetch --root ')),
		outcome: fails(/is refused by the CLI before it runs: .*--root/),
	},
	{
		name: 'the root resolves to the site rather than the repository',
		check: 'wiring-prebuild-hook',
		why: 'prefetch run with `.` from the site reads a repository that has no deploy config and no submodule, and on a warm cache it can still pass.',
		apply: (repo) =>
			editPrebuild(repo, (script) => script.replace(' prefetch ../.. ', ' prefetch . ')),
		outcome: fails(/names `\.` as the repository root/),
	},
	{
		name: 'the prefetch names a different site',
		check: 'wiring-prebuild-hook',
		why: 'A prefetch for another site in this package fills that site and leaves this one with the bundles of the previous build.',
		apply: (repo) =>
			editPrebuild(repo, (script) => script.replace(`--site ${repo.site}`, '--site apps/other')),
		outcome: fails(/names `--site apps\/other`, and this site is/),
	},
	{
		name: 'a failed prefetch is masked by || true',
		check: 'wiring-prebuild-hook',
		why: 'The build then succeeds whatever prefetch did, which is the substring predicate accepting exactly the chain it was meant to refuse.',
		apply: (repo) => editPrebuild(repo, (script) => `${script} || true`),
		outcome: fails(/is followed in `prebuild` by `\|\|`/),
	},
	{
		name: 'the bucket is a shell variable the check cannot read',
		check: 'wiring-prebuild-hook',
		why: 'The binder would take `$HEXDOCS_BUCKET` literally while the shell hands prefetch something else, so accepting it is accepting a value nothing checked.',
		apply: (repo) =>
			editPrebuild(repo, (script) =>
				script.replace(`--site ${repo.site}`, `--site ${repo.site} --bucket $HEXDOCS_BUCKET`),
			),
		outcome: fails(/holds a character the shell rewrites/),
	},
	{
		name: 'the guard runs before prefetch',
		check: 'wiring-prebuild-hook',
		why: 'install writes prefetch then the guard, and a guard ahead of the prefetch prints its report before a step that can still fail.',
		apply: (repo) =>
			editPrebuild(repo, (script) => {
				const guard = ' && node scripts/check-docs.mjs';
				const withoutGuard = script.replace(guard, '');
				const at = withoutGuard.indexOf(' && ');
				return at === -1
					? `node scripts/check-docs.mjs && ${withoutGuard}`
					: `${withoutGuard.slice(0, at)} && node scripts/check-docs.mjs${withoutGuard.slice(at)}`;
			}),
		outcome: fails(/runs before `hexdocs prefetch` rather than after it/),
	},
	{
		name: 'prefetch runs after react-router build in the build script',
		check: 'wiring-prebuild-hook',
		why: 'The build compiles the bundle globs over whatever is on disk, so a prefetch after it ships the previous bundles or none.',
		apply: (repo) =>
			editJson(repo, `${repo.site}/package.json`, (value) => {
				const scripts = value['scripts'] as Record<string, string>;
				const docs = (scripts['prebuild'] as string).slice(
					(scripts['prebuild'] as string).search(/\S*hexdocs prefetch/),
				);
				const rest = (scripts['prebuild'] as string).replace(docs, '').replace(/ && $/, '');
				if (rest === '') delete scripts['prebuild'];
				else scripts['prebuild'] = rest;
				scripts['build'] = `${scripts['build'] as string} && ${docs}`;
			}),
		outcome: fails(
			/runs after `react-router build`, which compiles the bundles before they are on disk/,
		),
	},
	{
		name: 'the generated shim is gone',
		check: 'wiring-prebuild-hook',
		why: 'The hook and the shim are the same guarantee one step apart, and a prebuild that spawns a file that is not there fails the build with a node error rather than with a docs row.',
		apply: (repo) => remove(repo, `${repo.site}/scripts/check-docs.mjs`),
		outcome: fails(/is missing or is not a guard for/),
	},
	{
		name: 'the prefetch output is not ignored',
		check: 'wiring-prebuild-hook',
		why: 'Both trees are build output fetched from a bundle keyed by commit. Committing them puts every page in every language into the site repository and makes every prefetch a diff.',
		apply: (repo) => write(repo, `${repo.site}/.gitignore`, 'build/\n'),
		outcome: fails(/does not ignore what `hexdocs prefetch` writes/),
	},
	{
		name: 'the guard is inside a script four packages share',
		check: 'wiring-prebuild-hook',
		why: 'All four hex-web fronts declare the identical prebuild string, so a docs guard inside that shell script runs for three sites that have no docs, and the first of them to fail it fails a deploy nobody connected to documentation. The literal shape has no shared script in its prebuild, so it has nothing to break.',
		shapes: ['glob-workspace'],
		apply: (repo) =>
			write(repo, 'common/copy-assets.sh', '#!/bin/sh\nnode ../docs/kit/bin/hexdocs prefetch\n'),
		outcome: fails(/invokes hexdocs, and it is shared/),
	},
	{
		name: 'the site package has no scripts block',
		check: 'wiring-prebuild-hook',
		why: 'Nothing in it always runs, so there is no build chain to hang the guard off and no honest way to call that a pass.',
		apply: (repo) => write(repo, `${repo.site}/package.json`, '{\n\t"name": "front"\n}\n'),
		outcome: failsWithNote(/has no scripts block/),
	},

	// -------------------------------------------------------------------------
	// wiring-routes, read through the site's own route loader
	// -------------------------------------------------------------------------
	{
		name: 'the machine routes are declared without their ids',
		check: 'wiring-routes',
		why: 'Every machine row names one module and React Router defaults an id to the module path, so its loader refuses the whole table. This is the step 5 instruction, which a token test passed.',
		apply: (repo) => edit(repo, routesFile(repo), (text) => text.replace(', { id: row.id }', '')),
		outcome: fails(
			/React Router refused this site's route config: .*duplicate route id: "routes\/docs\.machine"/,
		),
	},
	{
		name: 'the machine routes are declared under :lang',
		check: 'wiring-routes',
		why: 'A leaf with no default export is dispatched to queryRoute, which runs no parent loader, so under :lang nothing validates the language and a nonsense language answers 200.',
		apply: (repo) =>
			edit(repo, routesFile(repo), (text) => {
				const spread = indent(MACHINE_ROUTES_SPREAD, 1);
				const without = once(text, `${spread}\n`, '');
				const inline = MACHINE_ROUTES_SPREAD.replace(/,$/, '');
				return without.includes(LANG_CHILDREN_WITH_DOCS)
					? once(
							without,
							LANG_CHILDREN_WITH_DOCS,
							`[...pages("lang/"), ...docsPages("lang/"), ${inline}]`,
						)
					: once(without, 'pages("lang/"))', `[...pages("lang/"), ${inline}])`);
			}),
		outcome: fails(/machine route\(s\) are not declared at the top level/),
	},
	{
		name: 'the page routes are not declared at the bare mount',
		check: 'wiring-routes',
		why: 'The needle step 5 used was satisfied by the import line alone, so a table with the machine spread and no page spread passed and every docs page was the site 404.',
		apply: (repo) =>
			edit(repo, routesFile(repo), (text) =>
				text.includes(DOCS_PAGES_BARE)
					? once(text, `\t${DOCS_PAGES_BARE}\n`, '')
					: once(text, `${indent(PAGE_TUPLES_SPREAD, 1)}\n`, ''),
			),
		outcome: fails(/docs page route\(s\) are not declared at the bare mount/),
	},
	{
		name: 'the page routes are not declared under :lang',
		check: 'wiring-routes',
		why: 'The registry arm declares the two mounts in two places, so one can be missed while the other is right, and every docs page in six languages is the site 404.',
		shapes: ['literal-workspace'],
		apply: (repo) =>
			edit(repo, routesFile(repo), (text) => once(text, LANG_CHILDREN_WITH_DOCS, 'pages("lang/")')),
		outcome: fails(/docs page route\(s\) are not declared under `:lang`/),
	},
	{
		name: 'there is no :lang route',
		check: 'wiring-routes',
		why: 'This package installs into a site that already mounts its pages twice. Creating that scheme is a change to the site, not to its docs, and the message has to say so rather than proposing an edit.',
		apply: (repo) =>
			edit(repo, routesFile(repo), (text) => text.replace(/\troute\(":lang"[^\n]*\n/, '')),
		outcome: fails(/has no top-level `:lang` route/),
	},
	{
		name: 'there is no routes.ts',
		check: 'wiring-routes',
		why: 'No route table to check is not a pass.',
		apply: (repo) => remove(repo, routesFile(repo)),
		outcome: failsWithNote(/does not exist, so this site has no route table to check/),
	},
	{
		name: 'the server module imports the package through its alias',
		check: 'wiring-routes',
		why: 'The step 5 module did exactly this, and React Router evaluates routes.ts with no Vite plugins, so the alias does not exist there and the route config refuses to load.',
		apply: (repo) =>
			edit(repo, `${repo.site}/app/lib/docs.server.ts`, (text) =>
				text.replace(/from "[^"]*src\/index";/g, 'from "@hex-pro/docs";'),
			),
		outcome: fails(/imports `@hex-pro\/docs` for its value/),
	},
	{
		name: 'the server module is gone',
		check: 'wiring-routes',
		why: 'Every docs module imports it and routes.ts cannot load without it.',
		apply: (repo) => remove(repo, `${repo.site}/app/lib/docs.server.ts`),
		outcome: fails(/app\/lib\/docs\.server\.ts does not exist/),
	},
	{
		name: 'the page module exports headers',
		check: 'wiring-routes',
		why: 'React Router copies only Set-Cookie from a parent, so a child headers export ships docs pages with no Content-Security-Policy and no nonce, and the page renders and never hydrates.',
		apply: (repo) =>
			edit(
				repo,
				pageModule(repo),
				(text) =>
					`${text}\nexport function headers() {\n\treturn { "Cache-Control": "max-age=60" };\n}\n`,
			),
		outcome: fails(/exports `headers`/),
	},
	{
		name: 'the machine module gains a default export',
		check: 'wiring-routes',
		why: 'A default export turns a resource route into a document route, so llms.txt and every raw page render the site shell around plain text.',
		apply: (repo) =>
			edit(
				repo,
				machineModule(repo),
				(text) => `${text}\nexport default function Nothing() {\n\treturn null;\n}\n`,
			),
		outcome: fails(/has a default export, so every machine address renders the site shell/),
	},
	{
		name: 'the page module stops calling DOCS.page',
		check: 'wiring-routes',
		why: 'A destructured method still works and still fails the needle, which is the declared limit of a text match; a module that serves nothing fails it for the right reason.',
		apply: (repo) =>
			edit(repo, pageModule(repo), (text) =>
				text.replace(
					'return DOCS.page(new URL(request.url));',
					'const { page } = DOCS;\n\treturn page(new URL(request.url));',
				),
			),
		outcome: fails(/does not call `DOCS\.page\(`/),
	},
	{
		name: 'the page module drops the docs handle',
		check: 'wiring-routes',
		why: 'root.tsx finds a docs page through this handle, so without it every docs page is an address missing from LOCALISED_PATHS and ships noindex.',
		apply: (repo) =>
			edit(repo, pageModule(repo), (text) =>
				text.replace('export const handle = DOCS_HANDLE;\n', ''),
			),
		outcome: fails(/does not export `DOCS_HANDLE` as its `handle`/),
	},
	{
		name: 'the page module loses its default export',
		check: 'wiring-routes',
		why: 'A page route with no component is a resource route, so every docs page answers with its loader data as JSON.',
		apply: (repo) =>
			edit(repo, pageModule(repo), (text) =>
				text.replace('export default function DocsRoute()', 'function DocsRoute()'),
			),
		outcome: fails(/has no default export, so every docs page is served as a resource route/),
	},
	{
		name: 'a docs route module is not there',
		check: 'wiring-routes',
		why: 'The route table names a module that does not exist, and the build fails naming a file rather than the docs install.',
		apply: (repo) => remove(repo, machineModule(repo)),
		outcome: fails(/A docs mount needs [^,]+, and it does not exist/),
	},
	{
		name: 'the site dependencies are not installed',
		check: 'wiring-routes',
		why: 'Nothing about the route table can be read without the site own React Router, and a row that could not run is not a pass.',
		apply: (repo) => remove(repo, `${repo.site}/node_modules/.bin`),
		outcome: () => ({
			status: 'not-run',
			message: null,
			note: /node_modules\/\.bin\/react-router is not there/,
		}),
	},

	// -------------------------------------------------------------------------
	// wiring-root-seo: the site configs and root's indexing decision
	// -------------------------------------------------------------------------
	{
		name: 'root.tsx does not ask the docs match',
		check: 'wiring-root-seo',
		why: 'Without the call a docs page is an address missing from LOCALISED_PATHS and ships noindex, and no row said why.',
		apply: (repo) =>
			edit(repo, rootFile(repo), (text) =>
				once(
					text,
					indent(ROOT_DECISION, 1),
					'\tconst translated = isLocalisedPath(path);\n\tconst named = () => true;',
				),
			),
		outcome: fails(/does not call `docsSeoFromMatches\(`/),
	},
	{
		name: 'root.tsx ignores the docs languages',
		check: 'wiring-root-seo',
		why: 'The alternates then name every language, including fallback translations served noindex, which Google reads as a broken hreflang group.',
		apply: (repo) =>
			edit(repo, rootFile(repo), (text) =>
				text.replace('!docsSeo || docsSeo.languages.includes(code)', 'code !== undefined'),
			),
		outcome: fails(/does not read the docs answer `languages`/),
	},
	{
		name: 'root.tsx ignores the docs indexable answer',
		check: 'wiring-root-seo',
		why: 'A fallback page would then carry a canonical and alternates, which is defect 13 again.',
		apply: (repo) =>
			edit(repo, rootFile(repo), (text) =>
				text.replace('docsSeo ? docsSeo.indexable :', 'docsSeo ? true :'),
			),
		outcome: fails(/does not read the docs answer `indexable`/),
	},
	{
		name: 'there is no root.tsx',
		check: 'wiring-root-seo',
		why: 'Nothing decides whether a docs page is indexed, and that is a site this package cannot install into.',
		apply: (repo) => remove(repo, rootFile(repo)),
		outcome: fails(/root\.tsx does not exist/),
	},
	{
		name: 'the site config does not validate',
		check: 'wiring-root-seo',
		why: 'Every route, canonical, alternate and sitemap entry for this mount is derived from that one file, so a config that does not validate is a docs mount that does not exist. The sitemap row loses its source with it, which is why that row is declared here rather than tolerated.',
		apply: (repo) =>
			editJson(repo, `${repo.site}/app/docs/fixture-app.docs.json`, (value) => {
				value['basePath'] = 'no-leading-slash';
			}),
		outcome: () => ({
			status: 'fail',
			message: /is not a valid site config/,
			also: ['wiring-sitemap', 'wiring-routes'],
		}),
	},
	{
		name: 'there is no site config at all',
		check: 'wiring-routes',
		why: 'The state of every first install, since install runs before hexdocs scaffold site. With no config there are no docs rows, and the routes row used to pass here having compared a loaded table against nothing, while the install predicate it shares called the routes edit unchanged and never printed it.',
		apply: (repo) => remove(repo, `${repo.site}/app/docs/fixture-app.docs.json`),
		outcome: () => ({
			status: 'not-run',
			message: null,
			note: /No valid site config under app\/docs, so there are no docs route rows/,
			also: ['wiring-root-seo', 'wiring-sitemap'],
		}),
	},

	// -------------------------------------------------------------------------
	// wiring-sitemap
	// -------------------------------------------------------------------------
	{
		name: 'the sitemap stops listing docs pages',
		check: 'wiring-sitemap',
		why: 'A sitemap with no docs entries is a docs tree Google never sees, and nothing else in the report notices.',
		apply: (repo) =>
			edit(repo, sitemapFile(repo), (text) =>
				text.replaceAll('DOCS.sitemap().', '([] as typeof urls).'),
			),
		outcome: fails(/does not call `DOCS\.sitemap\(\)`/),
	},
	{
		name: 'the sitemap imports DOCS from somewhere else',
		check: 'wiring-sitemap',
		why: 'A module named like the server module that is not it is the step 5 shape, where the sitemap read a list derived without the manifests and so without languages.',
		apply: (repo) =>
			edit(repo, sitemapFile(repo), (text) => text.replace('"~/lib/docs.server"', '"~/lib/docs"')),
		outcome: fails(/does not import `DOCS` from `lib\/docs\.server`/),
	},
	{
		name: 'the sitemap lists docs pages in every language',
		check: 'wiring-sitemap',
		why: 'A fallback translation is served noindex, and a sitemap naming it points a crawler at a page that asks not to be indexed.',
		apply: (repo) =>
			edit(repo, sitemapFile(repo), (text) =>
				text.replaceAll('entry.languages', 'SUPPORTED_LANGUAGES'),
			),
		outcome: fails(/never reads an entry's `languages`/),
	},
	{
		name: 'the sitemap hand-lists the docs base path',
		check: 'wiring-sitemap',
		why: 'A hand-written list cannot know which pages are hidden, so it advertises a page that is deliberately out of the sidebar, out of prev and next and out of the sitemap.',
		apply: (repo) =>
			edit(
				repo,
				sitemapFile(repo),
				(text) => `${text}\nconst extra = ['/fixture-app/docs/reference/api'];\n`,
			),
		outcome: fails(/names `\/fixture-app\/docs` directly/),
	},
	{
		name: 'there is no sitemap route',
		check: 'wiring-sitemap',
		why: 'No sitemap to add docs entries to is not the same as a sitemap that has them.',
		apply: (repo) => remove(repo, sitemapFile(repo)),
		outcome: failsWithNote(/does not exist, so this site publishes no sitemap/),
	},

	// -------------------------------------------------------------------------
	// wiring-mcp
	// -------------------------------------------------------------------------
	{
		name: 'there is no .mcp.json',
		check: 'wiring-mcp',
		why: 'An agent in this repository has no way to read a page, check a tree or reach a skill.',
		apply: (repo) => remove(repo, '.mcp.json'),
		outcome: fails(/This repository has no \.mcp\.json/),
	},
	{
		name: '.mcp.json has no mcpServers object',
		check: 'wiring-mcp',
		why: 'A file that exists and holds the wrong shape is its own message, because the remediation is an edit rather than a create.',
		apply: (repo) => write(repo, '.mcp.json', '{\n\t"servers": {}\n}\n'),
		outcome: fails(/has no mcpServers object/),
	},
	{
		name: 'the hexdocs entry is gone from .mcp.json',
		check: 'wiring-mcp',
		why: 'The other servers are still there, so a check keyed on the file existing would pass.',
		apply: (repo) =>
			editJson(repo, '.mcp.json', (value) => {
				delete (value['mcpServers'] as Record<string, unknown>)['hexdocs'];
			}),
		outcome: fails(/declares no hexdocs server/),
	},
	{
		name: 'the server command points at a launcher that is not checked out',
		check: 'wiring-mcp',
		why: 'The launcher lives inside the submodule, so this is the arm that separates a wrong mount path from a submodule nobody initialised, and neither is visible from the JSON alone.',
		apply: (repo) => remove(repo, `${repo.mount}/kit/start.sh`),
		outcome: fails(/The hexdocs server's command is `[^`]+`, which does not exist/),
	},
];

// ---------------------------------------------------------------------------
// The assertions
// ---------------------------------------------------------------------------

/** A context for a read-only command run against a materialised corpus. */
function checkContext(cwd: string) {
	return {
		cwd,
		kitVersion: KIT_VERSION,
		exec: runRecipe,
		write: null,
		now: () => new Date(0),
		log: () => {},
	};
}

/**
 * Everything every mutation produced, as `Finding.rule` values.
 *
 * Filled in the `beforeAll` below rather than by the tests, which is `rules-fire.test.ts`'s
 * shape and is not only tidiness: a union assertion accumulated by its neighbours is an
 * assertion that answers differently under `-t`, and reads as a pass when the tests that
 * were meant to fill it did not run.
 */
const FIRED = new Set<string>();

const CASES = CONSUMER_SHAPES.flatMap((shape) =>
	MUTATIONS.filter((mutation) => (mutation.shapes ?? CONSUMER_SHAPES).includes(shape)).map(
		(mutation) => [`${shape}: ${mutation.name}`, shape, mutation] as const,
	),
);

/** The rows each mutation produced, keyed by the case name. */
let produced: Map<string, CheckRow[]>;

/** Every `wiring-forbidden-agent-files` message a build of a perturbed corpus reported. */
let forbiddenAgentFiles: string[] = [];

/** The rows `hexdocs check` produced over a corpus whose mirror allowlist is too wide. */
let allowPathRows: readonly CheckRow[] = [];

beforeAll(async () => {
	produced = new Map(
		CASES.map(([name, shape, mutation]) => {
			const repo = copy(shape);
			mutation.apply(repo);
			const rows = rowsOf(repo);
			for (const finding of rows.flatMap((row) => row.findings)) FIRED.add(finding.rule);
			return [name, rows];
		}),
	);

	// The other half of the id space, and it belongs in the same pass for the same reason.
	// sync-public.sh copies docs/site into the public mirror and its prune step deletes
	// these four names afterwards, so a release dies there with an error about a file
	// nobody put there on purpose.
	const root = mkdtempSync(join(tmpdir(), 'hexdocs-forbidden-'));
	try {
		const corpus = materialiseCorpus(join(root, 'corpus')).root;
		mkdirSync(join(corpus, 'scripts'), { recursive: true });
		writeFileSync(
			join(corpus, 'docs', 'site', 'CLAUDE.md'),
			'# Notes for an agent\n\nThis file cannot live here.\n',
			'utf8',
		);
		const findings = buildBundle(corpus, { generator: KIT_VERSION }).lint.envelope.findings;
		forbiddenAgentFiles = findings
			.filter((finding) => finding.rule === 'wiring-forbidden-agent-files')
			.map((finding) => finding.message);
		for (const finding of findings) FIRED.add(finding.rule);

		// And the last id in this space, through the command that emits it.
		//
		// `wiring-allow-paths` is an app-repository check, so it is not one of the consumer
		// probes above and no mutation of a consumer fixture can reach it. `hexdocs check`
		// reads the mirror script, so the rule is reachable and is fired here rather than
		// exempted. The mirror script written below carries a bare `docs` entry, which is the
		// one edit that copies an internal documentation tree to a public repository.
		writeFileSync(
			join(corpus, 'scripts', 'sync-public.sh'),
			[
				'#!/usr/bin/env bash',
				'set -euo pipefail',
				'',
				'readonly ALLOW_PATHS=(',
				'    "app"',
				'    "docs"',
				')',
				'',
			].join('\n'),
			'utf8',
		);
		allowPathRows = await invoke(check, { root: corpus }, checkContext(corpus)).then(
			(out) => out.rows,
		);
		for (const finding of allowPathRows.flatMap((row) => row.findings)) FIRED.add(finding.rule);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

describe('every change install prints for a hand-edited file is in the wired baseline', () => {
	// `apply-instructions.ts` says the baseline is wired by the same text a person gets, and
	// every row in this file is measured against that baseline, so a printed change the
	// baseline skipped is one nothing here can see. There was one: `root.tsx` was printed four
	// changes and the baseline applied three, and the fourth was checked by no row either.
	// Each line of each printed change has to be in the wired file, trimmed, because a paste
	// is indented to wherever it lands.
	const UNWIRED = { 'glob-workspace': GLOB_WORKSPACE, 'literal-workspace': LITERAL_WORKSPACE };
	const PRINTED: readonly (readonly [string, (text: string) => Change[]])[] = [
		['app/routes.ts', (text) => routesChanges(text)],
		['app/root.tsx', () => rootChanges()],
		['app/routes/sitemap[.]xml.tsx', (text) => sitemapChanges(text)],
	];

	test.each(
		CONSUMER_SHAPES.flatMap((shape) =>
			PRINTED.map(([file, changes]) => [shape, file, changes] as const),
		),
	)('%s: %s', (shape, file, changes) => {
		const path = `${SITE_OF[shape]}/${file}`;
		const original = UNWIRED[shape].find((entry) => entry.path === path)?.contents;
		expect(original, `${path} is not in the unwired fixture`).toBeDefined();
		const printed = changes(original as string);
		expect(printed.length).toBeGreaterThan(0);
		const wired = read(copy(shape), path);
		const missing = printed.flatMap((change) =>
			change.code
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line !== '' && !wired.includes(line))
				.map((line) => `${change.where}: ${line}`),
		);
		expect(missing, 'printed to a person and not applied by the baseline').toEqual([]);
	});
});

describe('a fully wired consumer passes every row', () => {
	test.each(CONSUMER_SHAPES)('%s', (shape) => {
		const rows = rowsOf(copy(shape));
		const notPassing = rows
			.filter((row) => row.status !== 'pass')
			.map(
				(row) =>
					`${row.id}: ${row.status} ${row.note ?? ''} ${row.findings.map((f) => f.message).join(' | ')}`,
			);
		expect(notPassing).toEqual([]);
		// The count as well as the states, so a row that stopped being emitted at all does
		// not read as a clean sweep of eight.
		expect(rows).toHaveLength(CONSUMER_CHECK_IDS.length);
		expect(rows.every((row) => row.examined > 0)).toBe(true);
	});
});

describe('every wiring check fires', () => {
	test.each(CASES)('%s', (name, shape, mutation) => {
		const rows = produced.get(name) as CheckRow[];
		const outcome = mutation.outcome(shape);

		const row = rows.find((candidate) => candidate.id === mutation.check);
		expect(row, `${mutation.check} emitted no row at all`).toBeDefined();
		if (row === undefined) return;

		expect(
			row.status,
			`${mutation.name}. ${mutation.why} Findings: ${row.findings.map((f) => f.message).join(' | ')} Note: ${row.note ?? ''}`,
		).toBe(outcome.status);

		if (outcome.message !== null) {
			const hit = row.findings.find((finding) => outcome.message?.test(finding.message) === true);
			expect(
				hit?.message ?? row.findings.map((finding) => finding.message).join(' | '),
				`no finding on ${mutation.check} matches ${String(outcome.message)}. ${mutation.why}`,
			).toMatch(outcome.message);
			// The finding has to land on the row that claims it. A rule id and a row id are
			// separate namespaces and this is the one place they are required to agree.
			expect(hit?.rule).toBe(mutation.check);
			expect(hit?.severity).toBe('error');
		}
		if (outcome.note !== undefined) {
			expect(row.note ?? '').toMatch(outcome.note);
		}

		// And no other row moved. Without this half a mutation that broke the descriptor
		// would satisfy the assertion above with the claimed row red for another reason.
		const allowed = new Set<string>([mutation.check, ...(outcome.also ?? [])]);
		const baseline = BASELINE.get(shape) as Map<string, CheckState>;
		const moved = rows
			.filter((candidate) => !allowed.has(candidate.id))
			.filter((candidate) => candidate.status !== baseline.get(candidate.id))
			.map(
				(candidate) =>
					`${candidate.id}: ${baseline.get(candidate.id)} became ${candidate.status} (${candidate.findings.map((f) => f.message).join(' | ')})`,
			);
		expect(moved, `${mutation.name} moved a row it does not claim`).toEqual([]);
	});

	test('every mutation names a check id that exists, and every consumer check is claimed', () => {
		// Both directions over the table itself, which is cheaper than the run above and
		// fails first when a check is renamed.
		const claimed = new Set(MUTATIONS.map((mutation) => mutation.check));
		const unknown = [...claimed].filter((id) => !(CHECK_IDS as readonly string[]).includes(id));
		expect(unknown, 'claimed by a mutation and not in CHECK_IDS').toEqual([]);
		const missing = CONSUMER_CHECK_IDS.filter((id) => !claimed.has(id));
		expect(missing, 'no mutation breaks these checks').toEqual([]);
		expect(claimed.size).toBe(CONSUMER_CHECK_IDS.length);
	});
});

// ---------------------------------------------------------------------------
// What must not move a row
// ---------------------------------------------------------------------------

describe('editor settings are not part of whether a site is wired', () => {
	// The inverse of two mutations this file used to carry, "no settings file enables the
	// server" and "the skills directory is not granted", both claiming wiring-mcp red. That
	// row runs in the build gate, so those arms failed the prebuild of every clone whose
	// developer had not enabled a server, and kcalc keeps its enable in a globally ignored
	// local file. A settings file that enables nothing now moves no row at all, and an arm
	// re-added to the probe turns this red.
	test.each(CONSUMER_SHAPES)('%s: a settings file that enables nothing moves no row', (shape) => {
		const repo = copy(shape);
		write(
			repo,
			'.claude/settings.json',
			`${JSON.stringify({ enabledMcpjsonServers: [], permissions: { additionalDirectories: [] } }, null, '\t')}\n`,
		);
		const baseline = BASELINE.get(shape) as Map<string, CheckState>;
		const moved = rowsOf(repo)
			.filter((row) => row.status !== baseline.get(row.id) || row.findings.length > 0)
			.map((row) => `${row.id}: ${row.status}`);
		expect(moved).toEqual([]);
	});
});

describe('a base path the sitemap import contains is not a hand-listed address', () => {
	// The hand-listing arm used to read the whole sitemap, and the import that arm's own row
	// requires, `import { DOCS } from "~/lib/docs.server";`, contains `/doc`, `/docs` and
	// `/lib/docs`. A site mounted at any of them failed `wiring-sitemap` with every edit in
	// place, `install` reported the sitemap unchanged, and the one edit that cleared the
	// finding, deleting the import, failed the arm that requires it. The scan reads the file
	// with its module statements removed now.
	const BASE_PATHS = ['/docs', '/doc', '/lib/docs'] as const;

	function mountAt(repo: Repo, basePath: string): void {
		editJson(repo, `${repo.site}/app/docs/fixture-app.docs.json`, (value) => {
			value['basePath'] = basePath;
		});
	}

	test.each(CONSUMER_SHAPES.flatMap((shape) => BASE_PATHS.map((path) => [shape, path] as const)))(
		'%s mounted at %s passes every row',
		(shape, basePath) => {
			const repo = copy(shape);
			mountAt(repo, basePath);
			const rows = rowsOf(repo);
			expect(
				rows
					.filter((row) => row.status !== 'pass')
					.map(
						(row) => `${row.id}: ${row.status} ${row.findings.map((f) => f.message).join(' | ')}`,
					),
			).toEqual([]);
			expect(rows).toHaveLength(CONSUMER_CHECK_IDS.length);
		},
	);

	// And the direction the fix must not cost. A quote in front of the base path was the
	// other proposed fix, and two of these three put something else directly before it: a
	// template literal after an origin and a full URL. Each is a hand-written address that
	// advertises hidden pages and fallback translations.
	const HAND_LISTED = [
		['a quoted path', 'const extra = ["/docs/reference/api"];'],
		['a template literal after an origin', 'const extra = [`${ORIGIN}/docs/reference/api`];'],
		['a full URL', 'const extra = ["https://example.com/docs/guide"];'],
	] as const;

	test.each(
		CONSUMER_SHAPES.flatMap((shape) =>
			HAND_LISTED.map(([name, line]) => [shape, name, line] as const),
		),
	)('%s mounted at /docs, with %s, fails the sitemap row', (shape, _name, line) => {
		const repo = copy(shape);
		mountAt(repo, '/docs');
		edit(repo, sitemapFile(repo), (text) => `${text}\n${line}\n`);
		const row = rowsOf(repo).find((candidate) => candidate.id === 'wiring-sitemap');
		expect(row?.status).toBe('fail');
		expect(row?.findings.map((finding) => finding.message)).toEqual([
			`${sitemapFile(repo)} names \`/docs\` directly.`,
		]);
	});
});

// ---------------------------------------------------------------------------
// The two wiring checks that are about an app repository rather than a website
// ---------------------------------------------------------------------------

/**
 * No exemptions.
 *
 * There was one, for `wiring-allow-paths`, and it was true when it was written:
 * `allowPathsFindings` built every finding of that rule and nothing under `kit/src`
 * called it, so the check was implemented and unreachable. That is the same shape of
 * failure this whole file exists to close, one step earlier, and an exemption saying so
 * is a note nobody is forced to revisit. `hexdocs check` now reads the mirror script and
 * the `beforeAll` above fires the rule through it, so the table is empty and the
 * assertion below is over the whole union with nothing taken out of it.
 */
const UNFIRED: Readonly<Record<string, string>> = {};

describe('the app repository half of the wiring id space', () => {
	test('wiring-forbidden-agent-files fires on an agent file under the publishable root', () => {
		expect(forbiddenAgentFiles).toEqual(['"CLAUDE.md" cannot live under docs/site/.']);
	});

	test('wiring-allow-paths fires through `check` on a mirror allowlist that is too wide', () => {
		// The finding, not just the id. This is the one check standing between an internal
		// documentation tree and a public repository, so what it says is the product: a
		// reader who sees "delete this entry" and nothing else has no way to know what was
		// at stake.
		const row = allowPathRows.find((candidate) => candidate.id === 'wiring-allow-paths');
		expect(row?.status).toBe('fail');
		expect(row?.examined).toBe(2);
		const messages = (row?.findings ?? []).map((finding) => finding.message);
		expect(messages.length).toBeGreaterThan(0);
		expect(messages.join(' ')).toContain('docs');
		expect((row?.findings ?? [])[0]?.severity).toBe('error');
	});

	test('every wiring id except the ones declared unfired is produced by something above', () => {
		const wiring = CHECK_IDS.filter((id) => id.startsWith('wiring-'));
		const expected = wiring.filter((id) => UNFIRED[id] === undefined);
		const missing = expected.filter((id) => !FIRED.has(id));
		expect(missing, 'declared reachable and nothing fired it').toEqual([]);

		// The other direction: nothing claims to fire a wiring id that is not in the
		// contract, and no id is exempted that something does in fact fire.
		const firedWiring = [...FIRED].filter((rule) => rule.startsWith('wiring-'));
		const unknown = firedWiring.filter((rule) => !(CHECK_IDS as readonly string[]).includes(rule));
		expect(unknown, 'fired and not in CHECK_IDS').toEqual([]);
		const staleExemption = Object.keys(UNFIRED).filter((id) => FIRED.has(id));
		expect(staleExemption, 'declared unfired and something fired it: delete the entry').toEqual([]);
		for (const id of Object.keys(UNFIRED)) {
			expect((CHECK_IDS as readonly string[]).includes(id), `${id} is not a check id`).toBe(true);
			expect((UNFIRED[id] as string).length).toBeGreaterThan(40);
		}
	});

	// The whole union, with no exemption, which is the assertion this file exists to make.
	test('every wiring member of CHECK_IDS is fired by something in this file', () => {
		const wiring = CHECK_IDS.filter((id) => id.startsWith('wiring-'));
		expect(wiring.filter((id) => !FIRED.has(id))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// One arm that the wired baseline deliberately does not carry
// ---------------------------------------------------------------------------

describe('the shared-script arm reads the launcher the fragment itself names', () => {
	// The wired fixture leaves `<mount>/kit/bin/hexdocs` out, and this is what that
	// omission was hiding. The fragment runs `<mountFromSite>/kit/bin/hexdocs prefetch ...`,
	// and the shared-script scan walks every `../`-prefixed token in the prebuild string,
	// reads the file it resolves to and reports it when the text contains `hexdocs`. The
	// launcher is such a token and it is checked out in every real consumer, so a correctly
	// wired repository with the submodule present failed this row for naming its own
	// launcher. The scan now skips any token resolving inside the mount.
	test('a checked-out launcher does not fail the prebuild row', () => {
		const repo = copy('glob-workspace');
		write(
			repo,
			`${repo.mount}/kit/bin/hexdocs`,
			readFileSync(join(import.meta.dirname, '../../bin/hexdocs'), 'utf8'),
		);
		const row = rowsOf(repo).find((candidate) => candidate.id === 'wiring-prebuild-hook');
		expect(row?.findings.map((finding) => finding.message) ?? []).toEqual([]);
		expect(row?.status).toBe('pass');
	});
});
