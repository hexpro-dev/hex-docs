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
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { CONSUMER_ROOT, materialiseCorpus } from '../../../fixtures/index.js';
import {
	CONSUMER_SHAPES,
	materialiseConsumerWithConfig,
	removeConsumer,
	type ConsumerShape,
} from '../../../fixtures/consumers.js';
import type { CheckRow, CheckState } from '../../../src/contracts/diagnostics.js';
import { CHECK_IDS, type CheckId } from '../../../src/contracts/lint.js';
import { buildBundle } from '../../src/compile/build.js';
import { check } from '../../src/commands/check.js';
import { install } from '../../src/commands/install.js';
import { runRecipe } from '../../src/exec/run.js';
import { fileWriter } from '../../src/io/write.js';
import { invoke } from '../../src/registry/command.js';
import { CONSUMER_CHECK_IDS, runConsumerChecks } from '../../src/wiring/checks.js';
import { detectSite } from '../../src/wiring/detect.js';
import { parseJsonc } from '../../src/wiring/needles.js';

const SITE_CONFIG = join(CONSUMER_ROOT, 'fixture-app.docs.json');
const KIT_VERSION = '@hex-pro/docs-kit@0.0.0-test';

/**
 * Where the package is mounted in each shape, chosen to match the real consumers.
 *
 * hex-web mounts at `common/docs` because it already keeps its source-consumed submodules
 * under `common/`; kcalc mounts beside its site. Neither fixture ships a `common/`
 * directory, so `conventionalMount` would propose `apps/docs` for the first of them, which
 * is a path no consumer uses. Passing the mount explicitly is what `--mount` is for and is
 * what `detectSite` reports as `mountSource: 'flag'`.
 */
const MOUNT_OF: Record<ConsumerShape, string> = {
	'glob-workspace': 'common/docs',
	'literal-workspace': 'web/docs',
};

/** A gitlink sha. Never resolved: `git ls-files -s` prints what the index holds. */
const GITLINK_SHA = 'a'.repeat(40);

/** The spread a person adds to `routes.ts` by hand. One spelling, so a mutation can move it. */
const ROUTES_SPREAD =
	"\t...DOCS_ROUTES.filter((r) => r.kind === 'machine').map((r) => route(r.path.slice(1), r.file)),\n";

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
function editJson(repo: Repo, path: string, edit: (value: Record<string, unknown>) => void): void {
	const value = parseJsonc(read(repo, path)) as Record<string, unknown>;
	edit(value);
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
 * A consumer with every edit applied, mechanical and by hand.
 *
 * The mechanical half goes through `install --write` rather than being written here, so
 * the baseline this file calls "wired" is the state `install` actually produces and not a
 * second description of it. The by-hand half is the seven edits `install` prints and never
 * writes, applied the way its own instructions say to.
 *
 * Two things are set up that are not docs wiring at all and are stated so they are not
 * mistaken for it. `deploy.config.json` gains a `sites` block, because `projectTypeOf`
 * matches the site path against `sites.*.projects.*.path` and both fixtures carry only a
 * `hash` key, so without it the deploy row is a `fail` about a missing project rather than
 * about the mount. And the mount gets three source files and a launcher, because
 * `wiring-tsconfig-path` and `wiring-mcp` both assert that a path they read resolves to
 * something on disk.
 */
async function wire(shape: ConsumerShape, into: string): Promise<void> {
	const consumer = materialiseConsumerWithConfig(shape, SITE_CONFIG);
	const repo: Repo = {
		shape,
		root: consumer.root,
		site: consumer.site,
		mount: MOUNT_OF[shape],
	};

	// The submodule's own tree, as a checkout of it would look from the consumer's side.
	// `kit/bin/hexdocs` is deliberately absent: it is the launcher the prebuild fragment
	// names, and the shared-script arm of `wiring-prebuild-hook` reads every `../` token in
	// that string. The test that pins that behaviour is at the foot of this file.
	for (const file of ['src/index.ts', 'src/render/index.ts', 'src/contracts/index.ts']) {
		write(repo, `${repo.mount}/${file}`, 'export {};\n');
	}
	write(repo, `${repo.mount}/kit/start.sh`, '#!/bin/sh\nexec ./bin/hexdocs mcp\n');

	editJson(repo, 'deploy.config.json', (value) => {
		value['sites'] = { main: { projects: { front: { path: repo.site } } } };
	});

	// By hand: the submodule stanza. `install` refuses this one because a stanza with no
	// gitlink is a state a fresh clone gets nothing from, and `git submodule add` writes
	// both in one operation.
	write(
		repo,
		'.gitmodules',
		`${read(repo, '.gitmodules')}[submodule "${repo.mount}"]\n\tpath = ${repo.mount}\n\turl = git@github.com:hexpro-dev/hex-docs.git\n`,
	);

	// By hand: the three route modules and the spread that mounts them.
	for (const leaf of ['docs.tsx', 'docs.machine.tsx', 'docs.raw.tsx']) {
		write(
			repo,
			`${repo.site}/app/routes/${leaf}`,
			'export default function DocsRoute() {\n\treturn null;\n}\n',
		);
	}
	write(
		repo,
		`${repo.site}/app/routes.ts`,
		read(repo, `${repo.site}/app/routes.ts`).replace(
			"\troute(':lang'",
			`${ROUTES_SPREAD}\troute(':lang'`,
		),
	);

	// By hand: LOCALISED_PATHS. One consumer has an array to spread into and the other has
	// a readonly alias with nowhere to splice, which is the difference the two shapes exist
	// for, so the two edits are different edits.
	const paths = read(repo, `${repo.site}/app/lib/paths.ts`);
	write(
		repo,
		`${repo.site}/app/lib/paths.ts`,
		shape === 'glob-workspace'
			? paths.replace('\t...LEGAL_PATHS,', '\t...LEGAL_PATHS,\n\t...DOCS_PATHS,')
			: paths.replace('= PAGE_PATHS;', '= [...PAGE_PATHS, ...DOCS_PATHS];'),
	);

	// By hand: the sitemap, which has an entries array on one shape and none on the other.
	const sitemapFile = `${repo.site}/app/routes/sitemap[.]xml.tsx`;
	const sitemap = read(repo, sitemapFile);
	write(
		repo,
		sitemapFile,
		shape === 'glob-workspace'
			? sitemap.replace('];', '\t...DOCS_SITEMAP,\n];')
			: sitemap.replace('\tconst urls =', '\tconst sources = [...DOCS_SITEMAP];\n\tconst urls ='),
	);

	// By hand: `resolveJsonModule`, which lives in the shared config both consumers extend.
	// The glob shape already sets it in the site tsconfig; the literal one extends a config
	// that the fixture does not ship, so the chain has to end somewhere real.
	if (shape === 'literal-workspace') {
		write(
			repo,
			'config/tsconfig.front.json',
			'{\n\t"compilerOptions": {\n\t\t"resolveJsonModule": true\n\t}\n}\n',
		);
	}

	// By hand: the settings file. `install` prints this one and never writes it, because
	// whether a local settings file merges with the project one could not be established.
	write(
		repo,
		'.claude/settings.json',
		`${JSON.stringify(
			{
				enabledMcpjsonServers: ['hexdocs'],
				permissions: { additionalDirectories: [`${repo.mount}/.claude/skills`] },
			},
			null,
			'\t',
		)}\n`,
	);

	await invoke(
		install,
		{ root: repo.root, site: repo.site, mount: repo.mount, write: true },
		{
			cwd: repo.root,
			kitVersion: KIT_VERSION,
			exec: runRecipe,
			write: fileWriter(),
			now: () => new Date(0),
			log: () => {},
		},
	);

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
	const site = detectSite({ repoRoot: repo.root, site: repo.site, mount: repo.mount });
	return runConsumerChecks(site, { exec: runRecipe, kitVersion: KIT_VERSION });
}

function copy(shape: ConsumerShape): Repo {
	copies += 1;
	const root = join(scratch, `copy-${copies}`);
	cpSync(TEMPLATES.get(shape) as string, root, { recursive: true, verbatimSymlinks: true });
	return {
		shape,
		root,
		site: shape === 'glob-workspace' ? 'apps/front' : 'web/front',
		mount: MOUNT_OF[shape],
	};
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
	 * about multi-arm rules: `wiring-prebuild-hook` reports four different things and a
	 * mutation that broke one of them keeps the row red while the other three are deleted.
	 */
	readonly message: RegExp | null;
	/** For a `skipped` or `failed` row, which carries its reason as a note. */
	readonly note?: RegExp;
	/**
	 * Rows other than the claimed one that this mutation legitimately moves.
	 *
	 * Declared rather than tolerated. The one entry that needs it is the invalid site
	 * config: every address on this mount is derived from that file, so a config that does
	 * not validate takes the sitemap's source away with it.
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

const MUTATIONS: readonly Mutation[] = [
	// -------------------------------------------------------------------------
	// wiring-submodule
	// -------------------------------------------------------------------------
	{
		name: 'the docs stanza is gone from .gitmodules',
		check: 'wiring-submodule',
		why: 'A mount nothing declares is a fresh clone with an empty directory and a module resolution error inside the build.',
		apply: (repo) =>
			write(
				repo,
				'.gitmodules',
				read(repo, '.gitmodules').replace(new RegExp(`\\[submodule "${repo.mount}"\\][^[]*`), ''),
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
			write(
				repo,
				'pnpm-workspace.yaml',
				read(repo, 'pnpm-workspace.yaml')
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
			write(
				repo,
				'pnpm-workspace.yaml',
				read(repo, 'pnpm-workspace.yaml').replace(`"!${repo.mount}"`, `!${repo.mount}`),
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
		outcome: () => ({
			status: 'skipped',
			message: null,
			note: /no pnpm-workspace\.yaml/,
		}),
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
		outcome: fails(/would resolve to `[^`]+`, which does not exist/),
	},
	{
		name: 'resolveJsonModule is switched off',
		check: 'wiring-tsconfig-path',
		why: 'app/lib/docs.ts imports *.docs.json through import.meta.glob, and without this the typecheck fails on the glob rather than on anything a reader would connect to the docs install.',
		apply: (repo) => {
			remove(repo, 'config/tsconfig.front.json');
			editJson(repo, `${repo.site}/tsconfig.json`, (value) => {
				(value['compilerOptions'] as Record<string, unknown>)['resolveJsonModule'] = false;
			});
		},
		outcome: fails(/`resolveJsonModule` is false for/),
	},
	{
		name: 'the extends chain ends at a file that is not there',
		check: 'wiring-tsconfig-path',
		why: 'Neither real consumer sets the option in its own tsconfig, so following extends is not optional. An unfollowable chain is reported as could-not-determine rather than as false, which are different states.',
		apply: (repo) => {
			remove(repo, 'config/tsconfig.front.json');
			editJson(repo, `${repo.site}/tsconfig.json`, (value) => {
				delete (value['compilerOptions'] as Record<string, unknown>)['resolveJsonModule'];
			});
		},
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
	// wiring-prebuild-hook, which is four arms in one row
	// -------------------------------------------------------------------------
	{
		name: 'nothing in the build chain runs the guard',
		check: 'wiring-prebuild-hook',
		why: 'There is no CI on either consumer, so a check that only runs when somebody types it is not a guard. prebuild is the one thing that always runs.',
		apply: (repo) =>
			editJson(repo, `${repo.site}/package.json`, (value) => {
				const scripts = value['scripts'] as Record<string, string>;
				for (const [name, command] of Object.entries(scripts)) {
					if (command.includes('hexdocs prefetch')) scripts[name] = 'react-router build';
				}
			}),
		outcome: fails(/build chain runs the docs guard/),
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
	// wiring-routes
	// -------------------------------------------------------------------------
	{
		name: 'routes.ts names DOCS_ROUTES nowhere',
		check: 'wiring-routes',
		why: 'Without the spread there are no docs routes, and the site answers every docs URL with its own 404 while every other row still passes.',
		apply: (repo) =>
			write(
				repo,
				`${repo.site}/app/routes.ts`,
				read(repo, `${repo.site}/app/routes.ts`).replace(ROUTES_SPREAD, ''),
			),
		outcome: fails(/does not reference DOCS_ROUTES/),
	},
	{
		name: 'the DOCS_ROUTES spread sits below the :lang mount',
		check: 'wiring-routes',
		why: 'A leaf route with no default export is dispatched to queryRoute, which runs that route own loader and no parent, so a machine endpoint mounted under :lang answers a nonsense language with a 200. The file still names DOCS_ROUTES, so the needle above cannot see this.',
		apply: (repo) => {
			const text = read(repo, `${repo.site}/app/routes.ts`).replace(ROUTES_SPREAD, '');
			write(
				repo,
				`${repo.site}/app/routes.ts`,
				text.replace(/(\troute\(':lang'[^\n]*\n)/, `$1${ROUTES_SPREAD}`),
			);
		},
		outcome: fails(
			/No DOCS_ROUTES spread is declared between the bare mount and the `:lang` mount/,
		),
	},
	{
		name: 'there is no :lang mount to bracket the machine endpoints',
		check: 'wiring-routes',
		why: 'This package installs into a site that already mounts its pages twice. Creating that scheme is a change to the site, not to its docs, and the message has to say so rather than proposing an edit.',
		apply: (repo) =>
			write(
				repo,
				`${repo.site}/app/routes.ts`,
				read(repo, `${repo.site}/app/routes.ts`).replace(/\troute\(':lang'[^\n]*\n/, ''),
			),
		outcome: fails(/has no `route\(":lang", \.\.\.\)` mount/),
	},
	{
		name: 'a docs route module exports headers',
		check: 'wiring-routes',
		why: 'React Router copies only Set-Cookie from a parent, so a child headers export ships docs pages with no Content-Security-Policy and no nonce, and the page renders and never hydrates. The only thing standing here today is a prose comment in root.tsx.',
		apply: (repo) =>
			write(
				repo,
				`${repo.site}/app/routes/docs.tsx`,
				`export function headers() {\n\treturn { 'Cache-Control': 'max-age=60' };\n}\n\nexport default function DocsRoute() {\n\treturn null;\n}\n`,
			),
		outcome: fails(/exports `headers`/),
	},
	{
		name: 'a docs route module is not there',
		check: 'wiring-routes',
		why: 'The route table fails to build, and the failure names a module rather than the docs install.',
		apply: (repo) => remove(repo, `${repo.site}/app/routes/docs.raw.tsx`),
		outcome: fails(/A docs mount needs [^,]+, and it does not exist/),
	},
	{
		name: 'there is no routes.ts',
		check: 'wiring-routes',
		why: 'No route table to check is not a pass.',
		apply: (repo) => remove(repo, `${repo.site}/app/routes.ts`),
		outcome: failsWithNote(/does not exist, so this site has no route table/),
	},

	// -------------------------------------------------------------------------
	// wiring-localised-paths
	// -------------------------------------------------------------------------
	{
		name: 'app/lib/docs.ts is gone',
		check: 'wiring-localised-paths',
		why: 'Nothing derives DOCS_PATHS, DOCS_ROUTES or DOCS_SITEMAP, and the remediation is the one edit install can make rather than a paragraph.',
		apply: (repo) => remove(repo, `${repo.site}/app/lib/docs.ts`),
		outcome: fails(/does not exist, so nothing derives DOCS_PATHS/),
	},
	{
		name: 'app/lib/docs.ts exists and stops deriving from the package',
		check: 'wiring-localised-paths',
		why: 'A separate arm from the one above and a different remediation: the module header invites editing, so a file that exists and does not derive is a file somebody wrote and install must not rewrite it.',
		apply: (repo) =>
			write(
				repo,
				`${repo.site}/app/lib/docs.ts`,
				'export const DOCS_PATHS: string[] = [];\nexport const DOCS_ROUTES: unknown[] = [];\nexport const DOCS_SITEMAP: unknown[] = [];\n',
			),
		outcome: fails(/does not derive its three exports from the package/),
	},
	{
		name: 'there is no app/lib/paths.ts',
		check: 'wiring-localised-paths',
		why: 'root.tsx gates the canonical link and the eight hreflang alternates on that list. A site without one is not a site this package can install into.',
		apply: (repo) => remove(repo, `${repo.site}/app/lib/paths.ts`),
		outcome: fails(/does not exist, so this site has no localised-path list/),
	},
	{
		name: 'LOCALISED_PATHS drops the docs addresses',
		check: 'wiring-localised-paths',
		why: 'A docs slug missing from that list ships with a self-referential canonical and eight alternates pointing at eight 404s, on a page that renders perfectly.',
		apply: (repo) =>
			write(
				repo,
				`${repo.site}/app/lib/paths.ts`,
				read(repo, `${repo.site}/app/lib/paths.ts`)
					.replace('\n\t...DOCS_PATHS,', '')
					.replace('[...PAGE_PATHS, ...DOCS_PATHS]', 'PAGE_PATHS'),
			),
		outcome: fails(/LOCALISED_PATHS does not include the docs addresses/),
	},
	{
		name: 'the site config does not validate',
		check: 'wiring-localised-paths',
		why: 'Every route, canonical, alternate and sitemap entry for this mount is derived from that one file, so a config that does not validate is a docs mount that does not exist. The sitemap row loses its source with it, which is why that row is declared here rather than tolerated.',
		apply: (repo) =>
			editJson(repo, `${repo.site}/app/docs/fixture-app.docs.json`, (value) => {
				value['basePath'] = 'no-leading-slash';
			}),
		outcome: () => ({
			status: 'fail',
			message: /is not a valid site config/,
			also: ['wiring-sitemap'],
		}),
	},

	// -------------------------------------------------------------------------
	// wiring-sitemap
	// -------------------------------------------------------------------------
	{
		name: 'the sitemap stops deriving DOCS_SITEMAP',
		check: 'wiring-sitemap',
		why: 'A sitemap with no docs entries is a docs tree Google never sees, and nothing else in the report notices.',
		apply: (repo) =>
			write(
				repo,
				`${repo.site}/app/routes/sitemap[.]xml.tsx`,
				read(repo, `${repo.site}/app/routes/sitemap[.]xml.tsx`)
					.replace('\t...DOCS_SITEMAP,\n', '')
					.replace('\tconst sources = [...DOCS_SITEMAP];\n', ''),
			),
		outcome: fails(/does not derive its docs entries from DOCS_SITEMAP/),
	},
	{
		name: 'the sitemap hand-lists the docs base path',
		check: 'wiring-sitemap',
		why: 'A hand-written list cannot know which pages are hidden, so it advertises a page that is deliberately out of the sidebar, out of prev and next and out of the sitemap.',
		apply: (repo) =>
			write(
				repo,
				`${repo.site}/app/routes/sitemap[.]xml.tsx`,
				`${read(repo, `${repo.site}/app/routes/sitemap[.]xml.tsx`)}\nconst extra = ['/fixture-app/docs/reference/api'];\n`,
			),
		outcome: fails(/names `\/fixture-app\/docs` directly/),
	},
	{
		name: 'there is no sitemap route',
		check: 'wiring-sitemap',
		why: 'No sitemap to add docs entries to is not the same as a sitemap that has them.',
		apply: (repo) => remove(repo, `${repo.site}/app/routes/sitemap[.]xml.tsx`),
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
	{
		name: 'no settings file enables the server',
		check: 'wiring-mcp',
		why: 'A declared server that is not enabled is a server that never starts, and .mcp.json alone cannot say.',
		apply: (repo) =>
			editJson(repo, '.claude/settings.json', (value) => {
				delete value['enabledMcpjsonServers'];
			}),
		outcome: fails(/No settings file enables the hexdocs server/),
	},
	{
		name: 'the skills directory is not granted',
		check: 'wiring-mcp',
		why: 'The skills ship inside the submodule and .claude is gitignored in the app repositories by policy, so the additionalDirectories grant is the only route to them.',
		apply: (repo) =>
			editJson(repo, '.claude/settings.json', (value) => {
				delete value['permissions'];
			}),
		outcome: fails(/grants `[^`]+\/\.claude\/skills` in permissions\.additionalDirectories/),
	},
];

// ---------------------------------------------------------------------------
// The assertions
// ---------------------------------------------------------------------------

/**
 * Everything every mutation produced, as `Finding.rule` values.
 *
 * Filled in the `beforeAll` below rather than by the tests, which is `rules-fire.test.ts`'s
 * shape and is not only tidiness: a union assertion accumulated by its neighbours is an
 * assertion that answers differently under `-t`, and reads as a pass when the tests that
 * were meant to fill it did not run.
 */
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
		// probes above and no mutation of a consumer fixture can reach it. It was declared
		// unfired for a while and the declaration was true: `allowPathsFindings` builds every
		// finding of that rule and nothing called it, so the rule was implemented and
		// unreachable, which is the same shape of failure this whole file exists to close,
		// one step earlier. `hexdocs check` now reads the mirror script, so the rule is
		// reachable and is fired here rather than exempted.
		//
		// The mirror script written below carries a bare `docs` entry, which is the one edit
		// that copies an internal documentation tree to a public repository.
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

describe('a fully wired consumer passes every row', () => {
	test.each(CONSUMER_SHAPES)('%s', (shape) => {
		const rows = rowsOf(copy(shape));
		const notPassing = rows
			.filter((row) => row.status !== 'pass')
			.map((row) => `${row.id}: ${row.status} ${row.findings.map((f) => f.message).join(' | ')}`);
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

		expect(row.status, `${mutation.name}. ${mutation.why}`).toBe(outcome.status);

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
				(candidate) => `${candidate.id}: ${baseline.get(candidate.id)} became ${candidate.status}`,
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
	//
	// It was a marked failure for a while, over `wiring-allow-paths`, and the marker is
	// what forced the gap closed rather than documented: the day `check` began reading the
	// mirror script the test started passing, `test.fails` turned it red, and whoever made
	// that change was pointed at the exemption table to empty. An exemption nobody is
	// forced to revisit is the reassuring kind of stale.
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
	// omission was hiding. `prebuildFragment` writes `<mountFromSite>/kit/bin/hexdocs
	// prefetch ...`, and the shared-script scan walks every `../`-prefixed token in the
	// prebuild string, reads the file it resolves to and reports it when the text contains
	// `hexdocs`. The launcher is such a token, it is checked out in every real consumer, and
	// it prints "hexdocs: installing toolchain dependencies (first run)" on first run. So a
	// correctly wired repository with the submodule present failed this row for naming its
	// own launcher, and the only way to green was to stop invoking it.
	//
	// The scan now skips any token resolving inside the mount, because the launcher is not
	// a script shared with other packages: it is hexdocs. This is the regression test for
	// that, and it is the case the fixture cannot cover on its own, since the fixture has
	// no submodule checked out.
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
