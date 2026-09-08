/**
 * The descriptor, derived from a repository rather than declared in one.
 *
 * `site.ts` opens by refusing a per-consumer `hexdocs.site.json`, on the ground that a
 * third configuration file beside `<project>.docs.json` is a confusion generator. The
 * price of that refusal is that every field here is inferred, and an inference that is
 * wrong is silently wrong: `projectType` guessed as `front` adds the mount to a key
 * nothing hashes, and the deploy then reports `unchanged` while production keeps serving
 * the old code. So this file asserts the whole descriptor for both shapes rather than the
 * fields a check happens to read.
 *
 * The two shapes are the point. `literal-workspace` reports no workspace enrolment and has
 * no `prebuild` at all, and both of those are states a check written against the other
 * consumer gets wrong in the direction that reads as fine: demanding an exclusion fails a
 * correctly wired kcalc forever, and appending to a `prebuild` that is not there produces
 * nothing. Every assertion about them is written from the file the fixture actually ships,
 * so a fixture edited to make a check pass fails here first.
 */

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import {
	CONSUMER_SHAPES,
	GLOB_WORKSPACE,
	LITERAL_WORKSPACE,
	materialiseConsumer,
	materialiseConsumerWithConfig,
	removeConsumer,
	type Consumer,
	type ConsumerFile,
	type ConsumerShape,
} from '../../../fixtures/consumers.js';
import { CONSUMER_ROOT } from '../../../fixtures/index.js';
import {
	conventionalMount,
	detectSite,
	memoryFiles,
	parseGitmodules,
	parseWorkspacePackages,
	projectTypeOf,
	workspaceEnrolment,
	workspaceMatches,
} from '../../src/wiring/detect.js';
import {
	editById,
	prebuildFragment,
	tsconfigPathEntries,
	type Edit,
} from '../../src/wiring/edits.js';
import { parseJsonc } from '../../src/wiring/needles.js';
import {
	dirnamePosix,
	joinPosix,
	relativePosix,
	resolveFrom,
	requireSitePath,
} from '../../src/wiring/site.js';

const SITE_CONFIG = join(CONSUMER_ROOT, 'fixture-app.docs.json');

const FILES_OF: Record<ConsumerShape, readonly ConsumerFile[]> = {
	'glob-workspace': GLOB_WORKSPACE,
	'literal-workspace': LITERAL_WORKSPACE,
};

const live: Consumer[] = [];

function consumer(shape: ConsumerShape, withConfig = false): Consumer {
	const made = withConfig
		? materialiseConsumerWithConfig(shape, SITE_CONFIG)
		: materialiseConsumer(shape);
	live.push(made);
	return made;
}

afterAll(() => {
	for (const made of live) removeConsumer(made);
});

// ---------------------------------------------------------------------------
// The whole descriptor, per shape
// ---------------------------------------------------------------------------

interface Expected {
	readonly site: string;
	readonly mount: string;
	readonly mountFromSite: string;
	readonly repoFromSite: string;
	/** `null` until a `sites` block names this path. Matched, never assumed to be `front`. */
	readonly projectType: string | null;
	readonly enrols: boolean;
	readonly enrolledBy: string | null;
	readonly excludedBy: string | null;
	readonly packages: readonly string[];
	readonly submodulePaths: readonly string[];
	/** Whether the site package declares a `prebuild` script at all. */
	readonly hasPrebuild: boolean;
}

const EXPECTED: Record<ConsumerShape, Expected> = {
	'glob-workspace': {
		site: 'apps/front',
		mount: 'common/docs',
		mountFromSite: '../../common/docs',
		repoFromSite: '../..',
		projectType: null,
		enrols: true,
		enrolledBy: 'common/*',
		excludedBy: null,
		packages: ['config', 'common/*', '!common/private-image-converter', 'apps/front'],
		submodulePaths: ['hex-terraform', 'common/private-image-converter'],
		hasPrebuild: true,
	},
	'literal-workspace': {
		site: 'web/front',
		mount: 'web/docs',
		mountFromSite: '../docs',
		repoFromSite: '../..',
		projectType: null,
		enrols: false,
		enrolledBy: null,
		excludedBy: null,
		packages: ['config', 'web/database', 'web/api', 'web/front'],
		submodulePaths: ['hex-terraform'],
		hasPrebuild: false,
	},
};

describe('the descriptor derived from each shape', () => {
	test.each(CONSUMER_SHAPES)('%s', (shape) => {
		const made = consumer(shape);
		const expected = EXPECTED[shape];
		const site = detectSite({ repoRoot: made.root, site: made.site, mount: expected.mount });

		expect({
			site: site.site,
			mount: site.mount,
			mountSource: site.mountSource,
			mountFromSite: site.mountFromSite,
			repoFromSite: site.repoFromSite,
			projectType: site.projectType,
			enrols: site.workspace.enrols,
			enrolledBy: site.workspace.enrolledBy,
			excludedBy: site.workspace.excludedBy,
			workspaceFile: site.workspace.file,
			entries: site.workspace.entries,
			projects: site.projects,
		}).toEqual({
			site: expected.site,
			mount: expected.mount,
			mountSource: 'flag',
			mountFromSite: expected.mountFromSite,
			repoFromSite: expected.repoFromSite,
			projectType: expected.projectType,
			enrols: expected.enrols,
			enrolledBy: expected.enrolledBy,
			excludedBy: expected.excludedBy,
			workspaceFile: 'pnpm-workspace.yaml',
			entries: expected.packages,
			projects: [],
		});
	});

	test('literal-workspace reports no workspace enrolment, and no line is what says so', () => {
		// The question is enrolment, not the presence of a `!` line. kcalc's file is an
		// explicit literal include list with no glob anywhere, so the mount is already out of
		// the workspace and an exclusion would be inert decoration. A check that demanded one
		// would fail a correctly wired repository forever, which is the reason the descriptor
		// carries `enrols` rather than a boolean about a line.
		const made = consumer('literal-workspace');
		const text = readFileSync(join(made.root, 'pnpm-workspace.yaml'), 'utf8');
		expect(text).not.toContain('*');
		expect(text).not.toContain('!');

		const enrolment = workspaceEnrolment(
			memoryFiles({ 'pnpm-workspace.yaml': text }),
			EXPECTED['literal-workspace'].mount,
		);
		expect(enrolment.enrols).toBe(false);
		expect([enrolment.enrolledBy, enrolment.excludedBy]).toEqual([null, null]);

		// And the glob shape is the control, so the assertion above is not vacuous.
		const glob = consumer('glob-workspace');
		const globText = readFileSync(join(glob.root, 'pnpm-workspace.yaml'), 'utf8');
		expect(
			workspaceEnrolment(memoryFiles({ 'pnpm-workspace.yaml': globText }), 'common/docs'),
		).toMatchObject({ enrols: true, enrolledBy: 'common/*' });
	});

	test('literal-workspace has no prebuild, and the applier creates the key rather than appending', () => {
		// The other half of the same difference. hex-web's four fronts share one `prebuild`
		// string, so the guard is appended inside that literal; kcalc has none at all, so the
		// key has to be created. An applier written against either shape produces nothing on
		// the other, and neither failure is visible in a diff of the file it did not write.
		for (const shape of CONSUMER_SHAPES) {
			const made = consumer(shape);
			const site = detectSite({
				repoRoot: made.root,
				site: made.site,
				mount: EXPECTED[shape].mount,
			});
			const packageFile = joinPosix(made.site, 'package.json');
			const before = parseJsonc(readFileSync(join(made.root, packageFile), 'utf8')) as {
				scripts: Record<string, string>;
			};
			expect('prebuild' in before.scripts).toBe(EXPECTED[shape].hasPrebuild);

			const edit = editById(site, 'prebuild-hook') as Edit;
			const applied = edit.apply(site.files.read(packageFile), site) as string;
			const after = parseJsonc(applied) as { scripts: Record<string, string> };
			expect(after.scripts['prebuild']).toContain(prebuildFragment(site));
			expect(after.scripts['prebuild']?.startsWith(prebuildFragment(site))).toBe(
				!EXPECTED[shape].hasPrebuild,
			);
			// The keys the consumer already had are untouched, which is what makes the edit an
			// insertion into the original bytes rather than a re-serialise.
			for (const [name, value] of Object.entries(before.scripts)) {
				if (name === 'prebuild') continue;
				expect(after.scripts[name]).toBe(value);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// The fixture tables and the tree they produce, in both directions
// ---------------------------------------------------------------------------

describe('the fixture file tables', () => {
	test.each(CONSUMER_SHAPES)(
		'%s: every declared file lands on disk and carries a reason',
		(shape) => {
			const made = consumer(shape);
			expect(made.files).toBe(FILES_OF[shape]);
			for (const file of made.files) {
				expect(readFileSync(join(made.root, file.path), 'utf8')).toBe(file.contents);
				// The `why` is what a reader opens when a check starts failing on one of these.
				// A blank one is a file nobody decided to add.
				expect(file.why.length, `${file.path} has no reason`).toBeGreaterThan(40);
			}
			expect(new Set(made.files.map((file) => file.path)).size).toBe(made.files.length);
		},
	);

	test('the two shapes differ in shape and not only in content', () => {
		// A single fixture would let every check be written against one consumer and pass,
		// which is how a guard ends up correct about the repository it was developed in and
		// wrong about the other one. The paths are the same set; the contents are not.
		const globPaths = GLOB_WORKSPACE.map((file) =>
			file.path.replace('apps/front', '<site>'),
		).sort();
		const literalPaths = LITERAL_WORKSPACE.map((file) =>
			file.path.replace('web/front', '<site>'),
		).sort();
		expect(globPaths).toEqual(literalPaths);
		const shared = GLOB_WORKSPACE.filter((file) =>
			LITERAL_WORKSPACE.some(
				(other) =>
					other.path.replace('web/front', '<site>') === file.path.replace('apps/front', '<site>') &&
					other.contents === file.contents,
			),
		);
		// Exactly one file is byte-identical between the shapes, and it is the two-line
		// ignore list, where there is nothing shape-specific to differ about. Everything
		// else differs, which is what makes a check written against one of them fail the
		// other. Named rather than allowed by a count, so a fixture edited to make a check
		// pass by copying the other shape's file fails here.
		expect(shared.map((file) => file.path)).toEqual(['apps/front/.gitignore']);
	});
});

// ---------------------------------------------------------------------------
// Where the mount comes from
// ---------------------------------------------------------------------------

describe('the mount, and how it was arrived at', () => {
	test('a flag outranks everything', () => {
		const made = consumer('glob-workspace');
		const site = detectSite({ repoRoot: made.root, site: made.site, mount: 'somewhere/else' });
		expect([site.mount, site.mountSource]).toEqual(['somewhere/else', 'flag']);
	});

	test('a hex-docs url in .gitmodules is read, and only a hex-docs url', () => {
		const made = consumer('glob-workspace');
		const gitmodules = join(made.root, '.gitmodules');
		const original = readFileSync(gitmodules, 'utf8');
		// The two stanzas the fixture already ships name other remotes, so a detector that
		// took the first stanza would answer `hex-terraform` here.
		expect(detectSite({ repoRoot: made.root, site: made.site }).mountSource).toBe('convention');

		const site = detectSite({
			repoRoot: made.root,
			site: made.site,
			files: memoryFiles({
				'.gitmodules': `${original}[submodule "vendor/docs"]\n\tpath = vendor/docs\n\turl = git@github.com:hexpro-dev/hex-docs.git\n`,
			}),
		});
		expect([site.mount, site.mountSource]).toEqual(['vendor/docs', 'gitmodules']);
	});

	test('the convention is common/ where the repository already keeps its submodules there', () => {
		// hex-web's two existing source-consumed submodules live under `common/`, which is why
		// its tsconfig paths entries point there. Everything else gets a mount beside the site.
		expect(conventionalMount(memoryFiles({ 'common/ui/package.json': '{}' }), 'apps/front')).toBe(
			'common/docs',
		);
		expect(conventionalMount(memoryFiles({}), 'web/front')).toBe('web/docs');
		expect(conventionalMount(memoryFiles({}), 'front')).toBe('docs');
	});

	test.each(CONSUMER_SHAPES)(
		'%s: with nothing else to go on, the mount is proposed beside the site',
		(shape) => {
			// The measured answer, and it is `apps/docs` on the glob shape rather than the
			// `common/docs` that repository really uses. That is a fixture limit worth naming:
			// `GLOB_WORKSPACE` declares `common/private-image-converter` in `.gitmodules` and in
			// its tsconfig paths but ships no file under `common/`, so the `files.exists('common')`
			// branch of `conventionalMount` is unreachable from this tree and is covered by the
			// `memoryFiles` case above instead. Every other test in this directory passes the
			// mount explicitly, which is what `--mount` is for and what `mountSource: 'flag'`
			// then reports.
			const made = consumer(shape);
			const site = detectSite({ repoRoot: made.root, site: made.site });
			expect([site.mount, site.mountSource]).toEqual([
				shape === 'glob-workspace' ? 'apps/docs' : 'web/docs',
				'convention',
			]);
			expect(site.files.exists('common')).toBe(false);
		},
	);
});

// ---------------------------------------------------------------------------
// projectType, which is matched rather than assumed
// ---------------------------------------------------------------------------

describe('the deploy project type', () => {
	const deployConfig = (type: string, path: string): string =>
		JSON.stringify({
			hash: { extra_dirs: { [type]: [] } },
			sites: { main: { projects: { [type]: { path } } } },
		});

	test('is the key whose project path is this site, whatever that key is called', () => {
		// `hash.extra_dirs` is keyed by project type and `hex-terraform/deploy/src/hash.ts`
		// reads `extraDirs[type]`, so a hard-coded `front` would add the mount to a key
		// nothing hashes. Both consumers happen to call it `front`, which is exactly why this
		// asserts a repository that does not.
		expect(
			projectTypeOf(
				memoryFiles({ 'deploy.config.json': deployConfig('web', 'web/front') }),
				'web/front',
			),
		).toBe('web');
		expect(
			projectTypeOf(
				memoryFiles({ 'deploy.config.json': deployConfig('front', 'apps/front') }),
				'apps/front',
			),
		).toBe('front');
	});

	test('is null when no project has this path, and when there is no deploy config at all', () => {
		expect(
			projectTypeOf(
				memoryFiles({ 'deploy.config.json': deployConfig('front', 'apps/admin') }),
				'apps/front',
			),
		).toBeNull();
		expect(projectTypeOf(memoryFiles({}), 'apps/front')).toBeNull();
		expect(
			projectTypeOf(memoryFiles({ 'deploy.config.json': 'not json' }), 'apps/front'),
		).toBeNull();
	});

	test.each(CONSUMER_SHAPES)(
		'%s: the fixture declares no sites block, so the type is null',
		(shape) => {
			// Stated rather than worked around. The fixtures carry only a `hash` key, which is
			// why every test in this directory that needs a project type adds a `sites` block and
			// says so. A fixture that grew one silently would change what those tests prove.
			const made = consumer(shape);
			expect(
				parseJsonc(readFileSync(join(made.root, 'deploy.config.json'), 'utf8')),
			).not.toHaveProperty('sites');
			expect(detectSite({ repoRoot: made.root, site: made.site }).projectType).toBeNull();
		},
	);
});

// ---------------------------------------------------------------------------
// The site configs under the site
// ---------------------------------------------------------------------------

describe('the site configs', () => {
	test('an empty app/docs directory yields no projects and no problem', () => {
		const made = consumer('glob-workspace');
		expect(detectSite({ repoRoot: made.root, site: made.site }).projects).toEqual([]);
	});

	test('a valid config is carried with problem null', () => {
		const made = consumer('glob-workspace', true);
		const projects = detectSite({ repoRoot: made.root, site: made.site }).projects;
		expect(projects).toHaveLength(1);
		expect(projects[0]?.file).toBe(`${made.site}/app/docs/fixture-app.docs.json`);
		expect(projects[0]?.problem).toBeNull();
		expect(projects[0]?.config?.project).toBe('fixture-app');
		// The digest the fixture carries on 1.1.0 is deliberately not the manifest's, so a
		// test that assumed the two matched would be asserting the fixture rather than the
		// code. What is asserted here is that the field survives the parse.
		expect(projects[0]?.config?.hidden).toEqual(['reference/api']);
	});

	test('a config that does not parse and one that does not validate are different problems', () => {
		const site = detectSite({
			repoRoot: '/nowhere',
			site: 'apps/front',
			files: memoryFiles({
				'apps/front/app/docs/broken.docs.json': '{ "site": 1,',
				'apps/front/app/docs/invalid.docs.json': JSON.stringify({
					site: 1,
					project: 'invalid',
					basePath: 'no-leading-slash',
					pages: [],
				}),
			}),
		});
		const problems = site.projects.map((project) => [project.file, project.problem === null]);
		expect(problems).toEqual([
			['apps/front/app/docs/broken.docs.json', false],
			['apps/front/app/docs/invalid.docs.json', false],
		]);
		expect(site.projects[0]?.problem).toBe('the file is not valid JSON');
		expect(site.projects[1]?.problem ?? '').toMatch(/basePath/);
		expect(site.projects.every((project) => project.config === null)).toBe(true);
	});

	test('files that are not *.docs.json are ignored', () => {
		const site = detectSite({
			repoRoot: '/nowhere',
			site: 'apps/front',
			files: memoryFiles({
				'apps/front/app/docs/README.md': '# not a config',
				'apps/front/app/docs/docs.json': '{}',
			}),
		});
		expect(site.projects).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The parsers underneath
// ---------------------------------------------------------------------------

describe('parseGitmodules', () => {
	test.each(CONSUMER_SHAPES)('%s: reads the fixture stanzas, in both directions', (shape) => {
		const made = consumer(shape);
		const text = readFileSync(join(made.root, '.gitmodules'), 'utf8');
		const stanzas = parseGitmodules(text);
		expect(stanzas.map((stanza) => stanza.path)).toEqual(EXPECTED[shape].submodulePaths);
		// And nothing was invented: every path the parser reports is a line in the file, and
		// every `path =` line in the file is a stanza the parser reported.
		const lines = text.split('\n').filter((line) => line.trim().startsWith('path ='));
		expect(lines).toHaveLength(stanzas.length);
		for (const stanza of stanzas) {
			expect(text).toContain(`\tpath = ${stanza.path}\n`);
			expect(stanza.url ?? '').toMatch(/^git@github\.com:/);
		}
	});

	test('the name and the path are separate fields', () => {
		// Both consumers happen to name their stanzas after their paths, and nothing requires
		// it. Every assertion in this package is about the path, which is what git checks out
		// and what deploy.config.json and pnpm-workspace.yaml both name.
		const stanzas = parseGitmodules(
			'[submodule "docs"]\n\tpath = common/docs\n\turl = git@github.com:hexpro-dev/hex-docs.git\n',
		);
		expect(stanzas).toEqual([
			{ name: 'docs', path: 'common/docs', url: 'git@github.com:hexpro-dev/hex-docs.git' },
		]);
	});

	test('a stanza with no path keeps a null rather than borrowing its name', () => {
		expect(parseGitmodules('[submodule "docs"]\n\turl = git@example.invalid:docs.git\n')).toEqual([
			{ name: 'docs', path: null, url: 'git@example.invalid:docs.git' },
		]);
	});
});

describe('parseWorkspacePackages', () => {
	test.each(CONSUMER_SHAPES)('%s: reads exactly the packages list', (shape) => {
		const made = consumer(shape);
		const text = readFileSync(join(made.root, 'pnpm-workspace.yaml'), 'utf8');
		expect(parseWorkspacePackages(text)).toEqual(EXPECTED[shape].packages);
	});

	test('a top-level key after the list ends it', () => {
		// hex-web declares `onlyBuiltDependencies` below its packages list. Reading its
		// entries as packages would enrol `esbuild` as a workspace path.
		const made = consumer('glob-workspace');
		const text = readFileSync(join(made.root, 'pnpm-workspace.yaml'), 'utf8');
		expect(text).toContain('onlyBuiltDependencies:');
		expect(parseWorkspacePackages(text)).not.toContain('esbuild');
	});

	test('comments are skipped and quotes are stripped from the value', () => {
		expect(
			parseWorkspacePackages(
				'packages:\n  # a reason\n  - config\n  - "!common/docs"\n  - \'apps/*\'\n',
			),
		).toEqual(['config', '!common/docs', 'apps/*']);
	});
});

describe('workspaceMatches', () => {
	// pnpm's own reading of these globs. The two cases that pin the literal comparison are
	// the ones the fixtures cannot reach: neither consumer lists a directory that contains
	// the mount, so a literal read as a prefix would give the same answer on both trees and
	// only these say otherwise. Measured, after a prefix reading was introduced deliberately
	// and this table passed unchanged without them.
	const CASES: readonly [string, string, boolean][] = [
		['common/*', 'common/docs', true],
		['common/*', 'common/a/b', false],
		['common/**', 'common/a/b', true],
		['!common/docs', 'common/docs', true],
		['web/front', 'web/docs', false],
		['web/front', 'web/front', true],
		['web/front/', 'web/front', true],
		['apps/*', 'apps/front', true],
		['apps/*', 'common/docs', false],
		// A parent listed as a literal does not enrol what is under it. `packages: - web`
		// enrols the directory `web` and not `web/docs`.
		['web', 'web/docs', false],
		// Nor does the mount itself enrol anything beneath it, which is what would let the
		// exclusion for `common/docs` be read as covering `common/docs/kit`.
		['common/docs', 'common/docs/kit', false],
		['common/docs', 'common/docsy', false],
	];

	test.each(CASES)('%s against %s', (pattern, path, expected) => {
		expect(workspaceMatches(pattern, path)).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// The path arithmetic the descriptor is built out of
// ---------------------------------------------------------------------------

describe('the posix path helpers', () => {
	test('relativePosix produces the mount and repo paths each shape needs', () => {
		// Hand written rather than node:path's `relative`, because these are written into a
		// consumer's tsconfig, its package scripts and its .mcp.json, all of which are read on
		// a machine whose separator is irrelevant to what those files mean.
		expect(relativePosix('apps/front', 'common/docs')).toBe('../../common/docs');
		expect(relativePosix('web/front', 'web/docs')).toBe('../docs');
		expect(relativePosix('apps/front', '')).toBe('../..');
		expect(relativePosix('front', '')).toBe('..');
		expect(relativePosix('apps/front', 'apps/front')).toBe('.');
	});

	test('resolveFrom walks .. and . the way a tsconfig target does', () => {
		expect(resolveFrom('apps/front', '../../common/docs/src/index.ts')).toBe(
			'common/docs/src/index.ts',
		);
		expect(resolveFrom('apps/front', './app/routes.ts')).toBe('apps/front/app/routes.ts');
		expect(resolveFrom('', 'docs/site')).toBe('docs/site');
	});

	test('joinPosix and dirnamePosix keep forward slashes and collapse repeats', () => {
		expect(joinPosix('apps/front', 'app/routes.ts')).toBe('apps/front/app/routes.ts');
		expect(joinPosix('', 'docs')).toBe('docs');
		expect(joinPosix('a/', '/b')).toBe('a/b');
		expect(dirnamePosix('apps/front/app/docs/x.docs.json')).toBe('apps/front/app/docs');
		expect(dirnamePosix('deploy.config.json')).toBe('');
	});

	test.each(CONSUMER_SHAPES)(
		'%s: the tsconfig targets are built from the same arithmetic',
		(shape) => {
			const made = consumer(shape);
			const site = detectSite({
				repoRoot: made.root,
				site: made.site,
				mount: EXPECTED[shape].mount,
			});
			expect(tsconfigPathEntries(site).map(([, target]) => target)).toEqual([
				`${EXPECTED[shape].mountFromSite}/src/index.ts`,
				`${EXPECTED[shape].mountFromSite}/src/render/index.ts`,
				`${EXPECTED[shape].mountFromSite}/src/contracts/index.ts`,
			]);
			for (const [, target] of tsconfigPathEntries(site)) {
				expect(resolveFrom(site.site, target).startsWith(`${site.mount}/`)).toBe(true);
			}
		},
	);

	test('requireSitePath refuses rather than producing a descriptor pointing at the root', () => {
		// Not quite unreachable: a test or a future caller building an input object by hand
		// skips the Zod parse, and a cast there would put `undefined` into path arithmetic.
		expect(() => requireSitePath(undefined)).toThrow(/--site/);
		expect(() => requireSitePath('')).toThrow(/--site/);
		expect(requireSitePath('apps/front')).toBe('apps/front');
	});

	test('a leading or trailing slash on --site is normalised away', () => {
		const made = consumer('glob-workspace');
		expect(detectSite({ repoRoot: made.root, site: './apps/front/' }).site).toBe('apps/front');
	});
});

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

describe('memoryFiles is the same interface diskFiles is', () => {
	test('read, exists and list answer over a map of paths', () => {
		const files = memoryFiles({
			'apps/front/app/docs/a.docs.json': '{}',
			'apps/front/app/docs/b.docs.json': '{}',
			'apps/front/tsconfig.json': '{}',
		});
		expect(files.read('apps/front/tsconfig.json')).toBe('{}');
		expect(files.read('nothing')).toBeNull();
		// A directory exists when something is under it, which is what `wiring-mcp` and the
		// `common/` convention probe both ask.
		expect(files.exists('apps/front')).toBe(true);
		expect(files.exists('apps')).toBe(true);
		expect(files.exists('apps/back')).toBe(false);
		expect(files.list('apps/front/app/docs')).toEqual(['a.docs.json', 'b.docs.json']);
		expect(files.list('apps/front')).toEqual(['app', 'tsconfig.json']);
		expect(files.list('nothing')).toEqual([]);
	});

	test('a disk descriptor and a memory descriptor over the same bytes agree', () => {
		// The seam exists so a test can drive the whole wiring layer from a map, and so
		// `install` and `verify-install` cannot end up reading through two different
		// resolvers. That is only true if the two resolvers answer the same.
		const made = consumer('literal-workspace');
		const tree: Record<string, string> = {};
		for (const file of made.files) tree[file.path] = file.contents;
		const onDisk = detectSite({ repoRoot: made.root, site: made.site, mount: 'web/docs' });
		const inMemory = detectSite({
			repoRoot: made.root,
			site: made.site,
			mount: 'web/docs',
			files: memoryFiles(tree),
		});
		const shape = (value: typeof onDisk): unknown => ({
			site: value.site,
			mount: value.mount,
			projectType: value.projectType,
			workspace: value.workspace,
			projects: value.projects,
		});
		expect(shape(inMemory)).toEqual(shape(onDisk));
	});
});

test('a removed consumer leaves nothing behind', () => {
	// `materialiseConsumer` deliberately has no cache keyed on the shape, because `install`
	// writes into this tree and two tests sharing one directory would be two tests sharing a
	// mutable fixture. The removal is the other half of that.
	const made = materialiseConsumer('glob-workspace');
	const root = made.root;
	expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').length).toBeGreaterThan(0);
	removeConsumer(made);
	expect(() => readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')).toThrow();
	rmSync(root, { recursive: true, force: true });
});
