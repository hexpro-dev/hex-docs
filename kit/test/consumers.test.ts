/**
 * The consumer sweep.
 *
 * Every other suite in this repository reads files this repository owns. This one reads
 * files it does not: the `docs/site/docs.json` in each app repository and the
 * `<project>.docs.json` in each website, wherever they happen to be beside this checkout.
 * The failure it exists to catch is a config key that only exists on a branch. Somebody
 * adds a field to a real consumer's config, the compiler grows to read it, the field is
 * later renamed here, and nothing notices until a publish. Validating the real files
 * against the current schemas moves that discovery to the suite.
 *
 * Nothing is named. The sweep discovers, which means the sweep can be broken in a way
 * that reads as a pass: a prune list that swallows the directory, a wrong root, a depth
 * cap one short. Three things guard against that, and each one is a separate test below.
 * The walk has to rediscover this repository's own fixture pair, so a walk that finds
 * nothing fails instead of passing. Every `docs/site` directory it enters has to yield a
 * project config, so a scaffolded consumer with no config is a failure rather than an
 * absence. And the directory budget is asserted rather than silently exhausted, because a
 * truncated walk and a complete one are the same green row otherwise.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { DocsProjectConfig } from '../../src/contracts/project.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import {
	denyListSchema,
	docsProjectConfigSchema,
	docsSiteConfigSchema,
	navTreeSchema,
	protectedRuleViolations,
	versionTableProblems,
} from '../src/contracts/index.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** `@hex-pro/docs`, read rather than written, so a rename cannot leave this stale. */
const PACKAGE_NAME = (
	JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { name: string }
).name;

/**
 * The directory holding this checkout, which on a development machine is `~/Hex`.
 *
 * Falling back to the checkout itself matters when this repository is vendored somewhere
 * whose parent is a filesystem root or a home directory full of unrelated trees. The
 * sweep still has the fixtures to work on, so it still examines something, which is the
 * property that stops it reporting a pass over nothing.
 */
const SWEEP_ROOT = dirname(REPO_ROOT) === REPO_ROOT ? REPO_ROOT : dirname(REPO_ROOT);

/**
 * Directories the walk never enters.
 *
 * Build output and installed packages are the two that matter. `node_modules` in a real
 * consumer holds a vendored copy of every package it depends on, and `build/` holds a
 * copy of whatever the last build produced, so entering either turns a sweep of a dozen
 * repositories into a sweep of a hundred thousand directories and finds nothing a
 * developer can act on.
 */
const PRUNED = new Set([
	'.cache',
	'.git',
	'.next',
	'.turbo',
	'.venv',
	'DerivedData',
	'Pods',
	'build',
	'coverage',
	'dist',
	'node_modules',
	'out',
	'target',
	'vendor',
	'venv',
]);

/**
 * Deep enough for the two real shapes and no deeper.
 *
 * A project config sits at `<repo>/docs/site/docs.json`, two directories down. A site
 * config sits at `<repo>/apps/front/app/docs/<project>.docs.json`, four. Seven leaves
 * room for a repository that nests one more level without turning the sweep into a walk
 * of every source file beside it.
 */
const MAX_DEPTH = 7;

/**
 * A ceiling on directories entered, asserted rather than applied quietly.
 *
 * A cap that truncates and says nothing reports the same green row as a complete walk,
 * which is the shape of failure this whole file is written against. If this is ever hit,
 * the answer is to work out which tree got large rather than to raise the number.
 */
const MAX_DIRECTORIES = 40_000;

interface FoundConfig {
	kind: 'project' | 'site';
	/** Absolute, so a message names a file the reader can open. */
	path: string;
}

interface SweepResult {
	configs: FoundConfig[];
	/** Every `docs/site` directory entered, which is what the parity test checks against. */
	siteDirs: string[];
	visited: number;
	/** Repositories the walk started from, for the coverage message. */
	repositories: string[];
	/** Configs dropped because they belong to a vendored copy of this package. */
	vendored: string[];
}

/** A checkout to sweep: a git repository beside this one, or this one. */
function repositoryRoots(): string[] {
	const roots = new Set<string>([REPO_ROOT]);
	for (const entry of readdirSync(SWEEP_ROOT, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const path = join(SWEEP_ROOT, entry.name);
		// A git repository is what "every repo beside ~/Hex" means. This checkout is added
		// unconditionally above rather than through this test, because a tree exported
		// without its `.git` is still the tree under test and its fixtures are the sweep's
		// only proof that the walk works.
		if (existsSync(join(path, '.git'))) roots.add(path);
	}
	return [...roots].sort();
}

/**
 * True when the config belongs to a vendored copy of this package rather than to a
 * consumer.
 *
 * hex-docs mounts into its consumers as a submodule, so once step 8 lands, `hex-web`
 * contains this repository's own `fixtures/` at `common/docs/fixtures/`. Sweeping those
 * would be harmless on the day the pin is current and misleading on every other day: a
 * submodule pinned to an older sha carries older fixtures, and validating them against
 * today's schemas would fail this suite for a stale pin somewhere else, which is not a
 * defect in anything this repository ships.
 */
function isVendored(path: string, root: string): boolean {
	let directory = dirname(path);
	while (directory.startsWith(root) && directory !== root) {
		if (directory !== REPO_ROOT) {
			const manifest = join(directory, 'package.json');
			if (existsSync(manifest)) {
				try {
					const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
					if (parsed.name === PACKAGE_NAME) return true;
				} catch {
					// An unreadable or malformed package.json elsewhere is not this suite's
					// problem, and treating it as a vendor marker would hide a real config.
				}
			}
		}
		directory = dirname(directory);
	}
	return false;
}

function sweep(): SweepResult {
	const configs: FoundConfig[] = [];
	const siteDirs: string[] = [];
	const vendored: string[] = [];
	const repositories = repositoryRoots();
	let visited = 0;

	const walk = (directory: string, depth: number, root: string): void => {
		if (depth > MAX_DEPTH || visited >= MAX_DIRECTORIES) return;
		visited += 1;

		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			// A directory this user cannot read is not a consumer config, and a repository
			// beside this one is not this suite's to demand permissions on.
			return;
		}

		for (const entry of entries) {
			// Symlinks are skipped rather than followed, which is the compiler's own rule
			// for `docs/site`. Following one here would let a loop or a link to `/` decide
			// how long the suite runs.
			if (entry.isSymbolicLink()) continue;
			const path = join(directory, entry.name);

			if (entry.isDirectory()) {
				if (PRUNED.has(entry.name)) continue;
				if (entry.name === 'site' && basename(directory) === 'docs') siteDirs.push(path);
				walk(path, depth + 1, root);
				continue;
			}

			if (!entry.isFile()) continue;
			if (entry.name === 'docs.json' && basename(directory) === 'site') {
				if (basename(dirname(directory)) !== 'docs') continue;
				if (isVendored(path, root)) vendored.push(path);
				else configs.push({ kind: 'project', path });
			} else if (entry.name.endsWith('.docs.json')) {
				if (isVendored(path, root)) vendored.push(path);
				else configs.push({ kind: 'site', path });
			}
		}
	};

	for (const root of repositories) walk(root, 0, root);

	configs.sort((a, b) => a.path.localeCompare(b.path));
	siteDirs.sort();
	return { configs, siteDirs, visited, repositories, vendored };
}

const result = sweep();
const projectConfigs = result.configs.filter((config) => config.kind === 'project');
const siteConfigs = result.configs.filter((config) => config.kind === 'site');

/** Relative to the sweep root, because an absolute path is unreadable in a diff. */
const show = (path: string): string => relative(SWEEP_ROOT, path);

const readJson = (path: string): { value?: unknown; problem?: string } => {
	try {
		return { value: JSON.parse(readFileSync(path, 'utf8')) };
	} catch (error) {
		return { problem: `${show(path)}: ${(error as Error).message}` };
	}
};

const issues = (error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string =>
	error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');

describe('discovery', () => {
	test("the walk rediscovers this repository's own fixture pair", () => {
		// The sweep names nothing, so a broken walk finds nothing and every validation test
		// below passes over an empty list. This is the one assertion that cannot be
		// satisfied by an empty result: the fixture corpus ships both shapes, so a walk
		// that works finds both, and a walk that does not fails here naming which is
		// missing rather than reporting a clean sweep of zero files.
		const found = result.configs.map((config) => config.path);
		expect(found, 'no project config found: the walk is not reaching docs/site').toContain(
			join(REPO_ROOT, 'fixtures', 'app', 'docs', 'site', 'docs.json'),
		);
		expect(found, 'no site config found: the walk is not matching *.docs.json').toContain(
			join(REPO_ROOT, 'fixtures', 'site', 'fixture-app.docs.json'),
		);
	});

	test('every docs/site directory yielded a project config', () => {
		// The both-directions half. A `docs/site` the walk entered and took no config out of
		// is either a consumer that scaffolded the directory and never wrote `docs.json`, or
		// a prune list that swallowed the file. Both are failures, and neither shows up in a
		// test that only validates what it found.
		const withConfig = new Set(projectConfigs.map((config) => dirname(config.path)));
		const missing = result.siteDirs
			.filter((directory) => !withConfig.has(directory))
			.filter((directory) => !isVendored(join(directory, 'docs.json'), SWEEP_ROOT))
			.map(show);
		expect(missing).toEqual([]);
	});

	test('the walk completed rather than hitting its ceiling', () => {
		expect(result.repositories.length).toBeGreaterThan(0);
		expect(
			result.visited,
			`the walk stopped at ${MAX_DIRECTORIES} directories, so this sweep is partial`,
		).toBeLessThan(MAX_DIRECTORIES);
	});
});

describe('project configs', () => {
	test(`every docs/site/docs.json validates (${projectConfigs.length} found)`, () => {
		const problems: string[] = [];
		let examined = 0;

		for (const config of projectConfigs) {
			examined += 1;
			const read = readJson(config.path);
			if (read.problem !== undefined) {
				problems.push(read.problem);
				continue;
			}

			const parsed = docsProjectConfigSchema.safeParse(read.value);
			if (!parsed.success) {
				problems.push(`${show(config.path)}: ${issues(parsed.error)}`);
				continue;
			}

			const violations = protectedRuleViolations(parsed.data as DocsProjectConfig);
			if (violations.length > 0) {
				problems.push(`${show(config.path)}: lowers a protected rule: ${violations.join(', ')}`);
			}

			// `nav.json` is what makes "a page cannot exist in one language and not another"
			// checkable, and it is not optional. A `docs/site` with a config and no nav is a
			// project that will fail at publish time, which is later than here.
			const nav = join(dirname(config.path), 'nav.json');
			if (!existsSync(nav)) {
				problems.push(`${show(nav)}: missing, but docs.json beside it exists`);
				continue;
			}
			const navRead = readJson(nav);
			if (navRead.problem !== undefined) {
				problems.push(navRead.problem);
				continue;
			}
			const navParsed = navTreeSchema.safeParse(navRead.value);
			if (!navParsed.success) problems.push(`${show(nav)}: ${issues(navParsed.error)}`);
		}

		expect(problems).toEqual([]);
		expect(examined).toBe(projectConfigs.length);
		expect(examined).toBeGreaterThan(0);
	});

	test('every deny list beside a project validates', () => {
		// `docs.private.json` lives outside `docs/site` on purpose, so the publisher cannot
		// reach it and a deny list can name a string that must never be published without
		// publishing it. That places it one directory above the config, which is why it is
		// swept from here rather than found by the walk.
		const problems: string[] = [];
		let examined = 0;

		for (const config of projectConfigs) {
			const deny = join(dirname(dirname(config.path)), 'docs.private.json');
			if (!existsSync(deny)) continue;
			examined += 1;
			const read = readJson(deny);
			if (read.problem !== undefined) {
				problems.push(read.problem);
				continue;
			}
			const parsed = denyListSchema.safeParse(read.value);
			if (!parsed.success) problems.push(`${show(deny)}: ${issues(parsed.error)}`);
		}

		expect(problems).toEqual([]);
		// The fixture corpus ships one, so zero here means the sweep stopped finding them.
		expect(examined).toBeGreaterThan(0);
	});
});

describe('site configs', () => {
	test(`every <project>.docs.json validates (${siteConfigs.length} found)`, () => {
		const problems: string[] = [];
		let examined = 0;

		for (const config of siteConfigs) {
			examined += 1;
			const read = readJson(config.path);
			if (read.problem !== undefined) {
				problems.push(read.problem);
				continue;
			}

			const parsed = docsSiteConfigSchema.safeParse(read.value);
			if (!parsed.success) {
				problems.push(`${show(config.path)}: ${issues(parsed.error)}`);
				continue;
			}

			const site = parsed.data as DocsSiteConfig;
			const table = versionTableProblems(site);
			if (table.length > 0) problems.push(`${show(config.path)}: ${table.join('; ')}`);

			// The filename is the address the install writes and the loader globs, so a file
			// whose stem disagrees with its `project` field is a config that resolves under
			// one name and reports another. The failure is a bundle fetched for a project
			// nobody labelled, which reads as a missing version rather than as a typo.
			const stem = basename(config.path, '.docs.json');
			if (stem !== site.project) {
				problems.push(
					`${show(config.path)}: filename says "${stem}", project says "${site.project}"`,
				);
			}
		}

		expect(problems).toEqual([]);
		expect(examined).toBe(siteConfigs.length);
		expect(examined).toBeGreaterThan(0);
	});
});
