/**
 * The arms an operator meets on a bad day, across every command that has one.
 *
 * The per-command test files each pin what their command is for. This one pins what
 * happens when the input is wrong, which is the half nothing else reaches: a bundle
 * directory that is not one, a site config that does not parse, an output directory that
 * cannot be written, a filter that matches nothing, and a repository that is not a
 * consuming site. Every one of those is a state where the operator has nothing to go on
 * but the sentence the command printed, so every assertion here is on the **message**
 * rather than only on the shape. A row that says "failed" and nothing more is this
 * repository's counting rule failing one level along: it reports a verdict nobody can act
 * on, which is the same as reporting nothing.
 *
 * Two properties are asserted for every refusal in this file, because the two failures
 * they exclude are the ones that look like success:
 *
 *   * **Never a throw.** A malformed input is not a bug in hexdocs, so it is a row and a
 *     reason rather than a stack trace under "this is a bug in hexdocs".
 *   * **Never an empty success.** Every refusal carries a `not-run` or `fail` row, so
 *     `exitCodeFor` is 3. An empty page list, an empty diff and an empty finding list all
 *     render identically to a clean run, and only the row tells them apart.
 *
 * What is deliberately not covered here, and why:
 *
 *   * `sync` against a config file that is absent, and `sync` against a cache with no
 *     manifest at all for the default version. Both are already proved, in
 *     `sync.test.ts`, by `a file that is not there is a refusal naming the command that
 *     makes it` and `no bundle for the default version is two not-run rows and no write`.
 *     Repeating them here would be a second copy of an assertion that already exists.
 *   * `readBundle`'s "one is below this path" arm, which names a bundle found under a
 *     wrongly-passed parent directory. `pages.test.ts` reaches it by pointing `--bundle`
 *     at the write root. The sibling arm, where the search finds nothing at all, is the
 *     one covered here.
 *   * `bundleCandidates`' `CANDIDATE_DIRECTORIES` cap. Reaching it means materialising
 *     four hundred directories to prove a number, and the cap changes no answer: it
 *     shortens a hint that is already best-effort.
 *   * `sync`'s `defaultEntry === undefined` arm. `versionTableProblems` refuses a table
 *     with no default before that line is reached, so the arm is unreachable defence
 *     rather than a state a person can produce. Its reachable twin, a table with two
 *     defaults, is in `sync.test.ts`.
 *   * `regionOf` against a context. It takes no context: the whole of what it does is
 *     read `REGION.fallback` rather than a literal, so that is what is asserted, in both
 *     directions.
 */

import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { CONSUMER_ROOT, materialiseCorpus } from '../../../fixtures/index.js';
import { AST_VERSION } from '../../../src/contracts/ast.js';
import { FINDING_CATEGORIES } from '../../../src/contracts/diagnostics.js';
import type { DiagnosticEnvelope } from '../../../src/contracts/diagnostics.js';
import { MANIFEST_KEY, bundlePrefix, pageKey, rawKey } from '../../../src/contracts/manifest.js';
import type { BundleManifest } from '../../../src/contracts/manifest.js';
import { buildBundle } from '../../src/compile/build.js';
import { writeBundle } from '../../src/compile/bundle.js';
import { build } from '../../src/commands/build.js';
import { bundle } from '../../src/commands/bundle.js';
import { check } from '../../src/commands/check.js';
import { BUCKET, REGION, bucketOf, regionOf, rootOf } from '../../src/commands/common.js';
import { page } from '../../src/commands/page.js';
import { pages } from '../../src/commands/pages.js';
import { sync } from '../../src/commands/sync.js';
import { verifyInstall } from '../../src/commands/verify-install.js';
import { NO_EXEC } from '../../src/exec/run.js';
import { fileWriter } from '../../src/io/write.js';
import { exitCodeFor, invoke, type CommandOutput, type Ctx } from '../../src/registry/command.js';

// A real version string. `bundleManifestSchema` holds `generator` to
// `@hex-pro/docs-kit@<major>.<minor>.<patch>`, and `sync` reads its cached manifest
// through that schema, so a made-up suffix would refuse a bundle for the wrong reason.
const KIT_VERSION = '@hex-pro/docs-kit@0.0.1';

const PROJECT = 'fixture-app';
const SITE = 'apps/front';
/** The sha `fixtures/site/fixture-app.docs.json` marks default. */
const DEFAULT_COMMIT = '67a7f22c66619693ab861f82cd1cc5fb2f1788a6';

let scratch: string;
let corpus: string;
/** The `ast-N` directory of a bundle written out of the corpus. */
let good: string;
let manifest: BundleManifest;
let fixtureText: string;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'hexdocs-arms-'));
	corpus = materialiseCorpus(join(scratch, 'repo')).root;
	fixtureText = readFileSync(join(CONSUMER_ROOT, `${PROJECT}.docs.json`), 'utf8');

	const built = buildBundle(corpus, { generator: KIT_VERSION, commit: DEFAULT_COMMIT });
	// A build whose own manifest invariants complained would make every refusal below
	// ambiguous: the reason could be the corruption this file plants or the one it did not.
	expect(built.manifestProblems).toEqual([]);
	manifest = built.manifest;
	good = writeBundle(join(scratch, 'cache'), built.manifest, built.objects).prefix;
}, 120_000);

afterAll(() => {
	if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

function ctx(cwd: string): Ctx {
	return {
		cwd,
		kitVersion: KIT_VERSION,
		exec: NO_EXEC,
		write: null,
		now: () => new Date('2026-01-01T00:00:00Z'),
		log: () => {},
	};
}

/**
 * A context whose `git` says what git says outside a working tree.
 *
 * `NO_EXEC` throws, which is the right context for every command in this file that must
 * not run a process, and the wrong one for `verify-install`: its submodule probe does run
 * git, and a thrown refusal would be a different failure from the one under test.
 */
function repoCtx(cwd: string): Ctx {
	return {
		...ctx(cwd),
		exec: () => ({
			status: 128,
			stdout: '',
			stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
		}),
	};
}

let copies = 0;

/**
 * A byte copy of the good bundle, with one file replaced or removed.
 *
 * Copied rather than mutated in place so each arm meets a bundle that is intact except
 * for the one thing it is about. A shared directory carrying every corruption at once
 * would let a command report the first one it noticed and pass every assertion.
 */
function bundleCopy(edit: (directory: string) => void): string {
	copies += 1;
	const directory = join(scratch, `bundle-${copies}`);
	cpSync(good, directory, { recursive: true });
	edit(directory);
	return directory;
}

function writeManifest(directory: string, text: string): void {
	writeFileSync(join(directory, MANIFEST_KEY), text, 'utf8');
}

/** A bundle whose manifest is not JSON at all. */
function notJsonBundle(): string {
	return bundleCopy((directory) => writeManifest(directory, '{"project": "fixture-app",'));
}

/** A bundle written by a kit whose AST major this toolchain does not know. */
function futureMajorBundle(): string {
	return bundleCopy((directory) =>
		writeManifest(directory, JSON.stringify({ ...manifest, ast: AST_VERSION + 1 })),
	);
}

/** A directory that exists, holds no manifest, and has none below it either. */
function emptyDirectory(name: string): string {
	const directory = join(scratch, name);
	mkdirSync(directory, { recursive: true });
	return directory;
}

// ---------------------------------------------------------------------------
// commands/common.ts: the three resolvers every command shares
// ---------------------------------------------------------------------------

describe('bucketOf', () => {
	/** Saved and restored per assertion, so one arm cannot leak into the next. */
	function withEnv<T>(value: string | undefined, body: () => T): T {
		const before = process.env['HEXDOCS_BUCKET'];
		if (value === undefined) delete process.env['HEXDOCS_BUCKET'];
		else process.env['HEXDOCS_BUCKET'] = value;
		try {
			return body();
		} finally {
			if (before === undefined) delete process.env['HEXDOCS_BUCKET'];
			else process.env['HEXDOCS_BUCKET'] = before;
		}
	}

	test('with no flag and no environment variable, refuses and says why there is no default', () => {
		const result = withEnv(undefined, () => bucketOf(undefined));

		expect(result).not.toHaveProperty('bucket');
		const why = (result as { why: string }).why;
		// The reason is the assertion, not the refusal. "No bucket" alone would send an
		// operator to look for a configuration file; the sentence has to say that the
		// absence is deliberate and what it is protecting, because a default here would be
		// a command that appears to work while writing into a bucket somebody else owns.
		expect(why).toContain('--bucket');
		expect(why).toContain('HEXDOCS_BUCKET');
		expect(why).toContain('There is no default');
		expect(why).toContain('public repository');
		expect(why).toContain('somebody else owns');
	});

	test('the parameter table declares no fallback, which is what makes the refusal reachable', () => {
		// The other half of the same fact. `shapeOf` applies a `fallback` before a handler
		// runs, so a fallback added to `BUCKET` would fill `--bucket` in at the boundary and
		// the refusal above would become unreachable with every test in this file green.
		expect(BUCKET).not.toHaveProperty('fallback');
	});

	test('either the flag or the environment variable is enough, and the flag wins', () => {
		expect(withEnv(undefined, () => bucketOf('from-flag'))).toEqual({ bucket: 'from-flag' });
		expect(withEnv('from-env', () => bucketOf(undefined))).toEqual({ bucket: 'from-env' });
		expect(withEnv('from-env', () => bucketOf('from-flag'))).toEqual({ bucket: 'from-flag' });
	});

	test('an empty flag is a refusal rather than a fall through to the environment', () => {
		// `??` keeps an empty string, so `--bucket ''` does not reach the environment. That
		// is the right answer and it is not the obvious one: falling through would let a
		// mistyped flag silently publish into whatever the shell happened to export.
		const result = withEnv('from-env', () => bucketOf(''));
		expect(result).not.toHaveProperty('bucket');
		expect((result as { why: string }).why).toContain('There is no default');

		// And an empty environment variable is the same refusal, which is the state an
		// unset variable in a CI `env:` block actually produces.
		const unset = withEnv('', () => bucketOf(undefined));
		expect(unset).not.toHaveProperty('bucket');
	});
});

describe('rootOf', () => {
	test('resolves against the context, not against process.cwd()', () => {
		const context = join(scratch, 'context');

		expect(rootOf(context, 'sub')).toBe(join(context, 'sub'));
		expect(rootOf(context, undefined)).toBe(context);
		expect(rootOf(context, '.')).toBe(context);
		expect(rootOf(context, '../sibling')).toBe(join(scratch, 'sibling'));

		// The assertion that fails if `resolve` is ever called with one argument. The
		// scratch directory is a temporary directory and this repository is not inside one,
		// so a result that fell back to the process directory would land under this file's
		// own checkout instead.
		expect(rootOf(context, 'sub').startsWith(process.cwd())).toBe(false);
	});

	test('an absolute root ignores the context, which is what a flag has to do', () => {
		expect(rootOf(join(scratch, 'context'), corpus)).toBe(corpus);
	});

	test('a command reads it through ctx.cwd, which is how HEXDOCS_PROJECT_ROOT reaches it', async () => {
		// `cli/main.ts` sets `Ctx.cwd` from `HEXDOCS_PROJECT_ROOT` and falls back to
		// `process.cwd()`, and the launcher exports that variable before it changes
		// directory into the submodule to install. So a command that resolved a relative
		// root against the process directory would resolve it against `kit/` on every real
		// invocation. `sync` is the cheapest command that puts the resolved path in its
		// own refusal, which is what makes the resolution observable from outside.
		const output = await invoke(
			sync,
			{ root: 'nested/web', site: SITE, project: PROJECT, cache: join(scratch, 'no-cache') },
			{ ...ctx(scratch), write: fileWriter() },
		);

		const why = (output.data as { why: string }).why;
		expect(why).toContain(join(scratch, 'nested', 'web', SITE, 'app', 'docs'));
		expect(why.startsWith(process.cwd())).toBe(false);
	});
});

describe('regionOf', () => {
	test('is the parameter table own fallback, read back rather than repeated', () => {
		// Declared once, in the place `--help` and the JSON Schema both read. A literal
		// here would be a second declaration neither of them can see, so the assertion is
		// against `REGION.fallback` and then against the value that constant has to hold.
		expect(regionOf(undefined)).toBe(REGION.fallback);
		expect(REGION.fallback).toBe('ap-southeast-2');
	});

	test('a region that was given wins, so the fallback is a fallback', () => {
		expect(regionOf('us-east-1')).toBe('us-east-1');
	});
});

// ---------------------------------------------------------------------------
// a bundle directory that is not one, through all three commands that read one
// ---------------------------------------------------------------------------

/** Every command that takes a bundle directory, with the flag each one spells it with. */
const BUNDLE_READERS = [
	{
		name: 'pages',
		command: pages,
		input: (directory: string) => ({ root: corpus, bundle: directory }),
		row: 'pages',
	},
	{
		name: 'page',
		command: page,
		input: (directory: string) => ({ slug: 'index', root: corpus, bundle: directory }),
		row: 'page',
	},
] as const;

describe('a bundle directory with no manifest', () => {
	for (const reader of BUNDLE_READERS) {
		test(`${reader.name} names the ast-N layout and the partial download`, async () => {
			const directory = emptyDirectory(`no-manifest-${reader.name}`);
			const output = await invoke(reader.command, reader.input(directory), ctx(scratch));

			expect(output.rows).toHaveLength(1);
			const row = output.rows[0];
			expect(row?.id).toBe(reader.row);
			expect(row?.status).toBe('not-run');
			expect(row?.unit).toBe('bundles');
			// Three things the sentence has to carry: where the manifest was looked for, what
			// a bundle directory actually is, and the second reading of an absent manifest.
			// The manifest is written last, so "there is no bundle here" and "the download
			// stopped early" are the same observation and send an operator to two places.
			expect(row?.note).toContain(`${directory} has no ${MANIFEST_KEY}`);
			expect(row?.note).toContain(`ast-${AST_VERSION}`);
			expect(row?.note).toContain('hexdocs prefetch');
			expect(row?.note).toContain('partial download');
			expect(exitCodeFor(output)).toBe(3);
		});
	}

	test('bundle reports it through verifyBundle and declines to describe it', async () => {
		const directory = emptyDirectory('no-manifest-bundle');
		const output = await invoke(bundle, { path: directory }, ctx(scratch));

		// `bundle` is the one of the three that has a reader of its own, so it produces two
		// statements about one absence: the verify row, which is the verdict, and the
		// description declining, which is why the JSON has no `project` in it.
		const row = output.rows.find((one) => one.id === 'bundle-manifest');
		expect(row?.status).toBe('fail');
		expect(row?.findings[0]?.message).toContain('has no manifest.json');
		expect((output.data as { described: boolean }).described).toBe(false);
		expect((output.data as { why: string }).why).toContain(join(directory, MANIFEST_KEY));
		expect(exitCodeFor(output)).toBe(3);
	});
});

describe('a manifest that is not JSON', () => {
	for (const reader of BUNDLE_READERS) {
		test(`${reader.name} reports the parse error rather than throwing it`, async () => {
			const directory = notJsonBundle();
			const output = await invoke(reader.command, reader.input(directory), ctx(scratch));

			const row = output.rows[0];
			expect(row?.status).toBe('not-run');
			expect(row?.note).toContain(join(directory, MANIFEST_KEY));
			expect(row?.note).toContain('is not JSON');
			expect(exitCodeFor(output)).toBe(3);
		});
	}

	test('bundle reports it as a finding on the manifest row, with the object named', async () => {
		const directory = notJsonBundle();
		const output = await invoke(bundle, { path: directory }, ctx(scratch));

		const row = output.rows.find((one) => one.id === 'bundle-manifest');
		expect(row?.status).toBe('fail');
		expect(row?.findings[0]?.message).toContain('manifest.json is not JSON');
		// A malformed manifest is still one manifest examined. A zero here would be
		// coerced to a failure by `checkRow` and would be the wrong reason for the right
		// verdict: the file was read, and what it said was not JSON.
		expect(row?.examined).toBe(1);
		expect((output.data as { described: boolean }).described).toBe(false);
	});
});

describe('a manifest declaring an AST major this toolchain does not know', () => {
	for (const reader of BUNDLE_READERS) {
		test(`${reader.name} names both majors and calls it a submodule bump`, async () => {
			const directory = futureMajorBundle();
			const output = await invoke(reader.command, reader.input(directory), ctx(scratch));

			const note = output.rows[0]?.note ?? '';
			expect(output.rows[0]?.status).toBe('not-run');
			expect(note).toContain(`AST major ${AST_VERSION + 1}`);
			expect(note).toContain(`this toolchain is ${AST_VERSION}`);
			// The remedy, which is the whole reason this arm is read before the schema. The
			// schema pins `ast` to this major, so without the early check the message would
			// be a validation error at pointer /ast, and the operator would recompile a
			// bundle that is not broken.
			expect(note).toContain('submodule bump');
			expect(note).not.toContain('recompile the commit');
			expect(exitCodeFor(output)).toBe(3);
		});
	}

	test('bundle emits the ast-major row rather than a malformed-manifest row', async () => {
		const directory = futureMajorBundle();
		const output = await invoke(bundle, { path: directory }, ctx(scratch));

		// Both directions on the row set. The ordering inside `verifyBundle` is the only
		// thing that makes `bundle-ast-major` reachable at all, so a report that named
		// `bundle-manifest` instead would be the exact regression the ordering exists for.
		expect(output.rows.map((one) => one.id)).toEqual(['bundle-ast-major']);
		expect(output.rows[0]?.findings[0]?.message).toContain(`AST major ${AST_VERSION + 1}`);
		expect((output.data as { described: boolean }).described).toBe(false);
		expect(exitCodeFor(output)).toBe(3);
	});
});

describe('a bundle that is intact except for one object', () => {
	test('page names the key the manifest promised and calls it a partial download', async () => {
		const key = rawKey('en', 'index');
		const directory = bundleCopy((where) => rmSync(join(where, key)));
		const output = await invoke(
			page,
			{ slug: 'index', root: corpus, bundle: directory },
			ctx(scratch),
		);

		const row = output.rows[0];
		expect(row?.status).toBe('not-run');
		expect(row?.unit).toBe('objects');
		expect(row?.note).toContain(key);
		// The distinction that decides what an operator does next. The manifest names every
		// object a bundle holds, so a record with no file is a download that stopped, not a
		// page that does not exist, and the fix is to fetch the rest rather than to write it.
		expect(row?.note).toContain('partial download, not a missing page');
		expect(exitCodeFor(output)).toBe(3);
	});

	test('page reports a member that is not gzip rather than throwing out of zlib', async () => {
		const key = pageKey('en', 'index');
		const directory = bundleCopy((where) =>
			writeFileSync(join(where, key), 'this is not a gzip member', 'utf8'),
		);
		const output = await invoke(
			page,
			{ slug: 'index', root: corpus, bundle: directory, format: 'ast' },
			ctx(scratch),
		);

		const row = output.rows[0];
		expect(row?.status).toBe('not-run');
		expect(row?.note).toContain(key);
		expect(row?.note).toContain('not a readable gzip member');
		expect(exitCodeFor(output)).toBe(3);
	});

	test('page refuses a locale the bundle does not carry, naming the ones it does', async () => {
		// `developer/architecture` is the English-only page. The site serves the source
		// locale with a notice, and this command does not: returning English under a
		// Japanese address is a lie an agent cannot see.
		const output = await invoke(
			page,
			{ slug: 'developer/architecture', root: corpus, bundle: good, locale: 'ja' },
			ctx(scratch),
		);

		const row = output.rows[0];
		expect(row?.status).toBe('not-run');
		expect(row?.note).toContain('has no ja translation in this bundle');
		expect(row?.note).toContain('en');
		expect(exitCodeFor(output)).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// sync, against a config and a cache it cannot read
// ---------------------------------------------------------------------------

/**
 * A web repository holding one site config, seeded from the checked-in fixture.
 *
 * `edit` receives the file text, so an arm can produce a file that no parser accepts,
 * which is not expressible by editing a parsed object.
 */
let sites = 0;
function siteRepo(edit: (text: string) => string): string {
	sites += 1;
	const root = join(scratch, `site-${sites}`);
	const path = join(root, SITE, 'app', 'docs', `${PROJECT}.docs.json`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, edit(fixtureText), 'utf8');
	return root;
}

function configPathOf(root: string): string {
	return join(root, SITE, 'app', 'docs', `${PROJECT}.docs.json`);
}

async function runSync(root: string, cache: string): Promise<CommandOutput> {
	return invoke(
		sync,
		{ root, site: SITE, project: PROJECT, cache },
		{ ...ctx(root), write: fileWriter() },
	);
}

/** A cache holding the default version's bundle, with its manifest replaced. */
function cacheWithManifest(name: string, text: string): string {
	const cache = join(scratch, name);
	const prefix = join(cache, bundlePrefix(PROJECT, DEFAULT_COMMIT));
	mkdirSync(prefix, { recursive: true });
	writeFileSync(join(prefix, MANIFEST_KEY), text, 'utf8');
	return cache;
}

describe('sync against a config it cannot read', () => {
	test('a file that is not JSON is refused with the parse error and nothing is written', async () => {
		// A stray comma after a `[`, which is the hand-edit a person actually makes.
		const root = siteRepo((text) => text.replace('\t"versions": [', '\t"versions": [,'));
		const before = readFileSync(configPathOf(root));
		const output = await runSync(root, join(scratch, 'no-cache'));

		const why = (output.data as { why: string }).why;
		expect(why).toContain(configPathOf(root));
		expect(why).toContain('is not JSON');
		// Both rows, not one. A report with a row missing reads as a report with a row that
		// passed, which is the failure `notRunRow` exists for in the first place.
		expect(output.rows.map((row) => row.id)).toEqual(['sync-pages', 'sync-digests']);
		expect(output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run']);
		expect(readFileSync(configPathOf(root))).toEqual(before);
		expect(exitCodeFor(output)).toBe(3);
	});

	test('a file that parses and is not a site config is refused as a config, not as JSON', async () => {
		const root = siteRepo((text) => {
			const config = JSON.parse(text) as Record<string, unknown>;
			// A real mistake rather than a random one: `basePath` is the field whose shape a
			// person is most likely to get wrong by hand, and the schema is the only thing
			// standing between a malformed one and a site that mounts docs at nothing.
			config['basePath'] = 'fixture-app/docs';
			return `${JSON.stringify(config, null, '\t')}\n`;
		});
		const before = readFileSync(configPathOf(root));
		const output = await runSync(root, join(scratch, 'no-cache'));

		const why = (output.data as { why: string }).why;
		expect(why).toContain(configPathOf(root));
		expect(why).toContain('is not a valid site config');
		// The two refusals have to read differently. "Not JSON" sends a person to a comma
		// and "not a valid site config" sends them to a field, and a shared sentence would
		// send them to the wrong one half the time.
		expect(why).not.toContain('is not JSON');
		expect(why).toContain('basePath');
		expect(output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run']);
		expect(readFileSync(configPathOf(root))).toEqual(before);
		expect(exitCodeFor(output)).toBe(3);
	});

	test('a duplicated pages member has no unique span to write into', async () => {
		// `JSON.parse` keeps the last of two equal keys, so this file validates and the
		// surgery has two candidate spans. Writing into either would produce a file whose
		// parsed value and whose visible text disagree, which is worse than not writing.
		const root = siteRepo((text) => text.replace('\t"pages": [', '\t"pages": [],\n\t"pages": ['));
		const before = readFileSync(configPathOf(root));
		const output = await runSync(root, cacheWithManifest('cache-dup', JSON.stringify(manifest)));

		const why = (output.data as { why: string }).why;
		expect(why).toContain(configPathOf(root));
		expect(why).toContain('no unique `pages` member');
		expect(output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run']);
		expect(readFileSync(configPathOf(root))).toEqual(before);
		expect(exitCodeFor(output)).toBe(3);
	});
});

describe('sync against a cache it cannot read', () => {
	test('a cached manifest that is not JSON refuses for the default version', async () => {
		const root = siteRepo((text) => text);
		const cache = cacheWithManifest('cache-not-json', '{"project":');
		const before = readFileSync(configPathOf(root));
		const output = await runSync(root, cache);

		const why = (output.data as { why: string }).why;
		expect(why).toContain(join(cache, bundlePrefix(PROJECT, DEFAULT_COMMIT), MANIFEST_KEY));
		expect(why).toContain('is not JSON');
		expect(output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run']);
		expect(readFileSync(configPathOf(root))).toEqual(before);
		expect(exitCodeFor(output)).toBe(3);
	});

	test('a cached manifest this kit cannot validate is refused as a manifest', async () => {
		const root = siteRepo((text) => text);
		// A manifest from a kit that writes a field this one does not understand, which is
		// the shape a submodule skew actually produces. The digest would still hash, which
		// is why the schema rather than the bytes is what refuses it.
		const cache = cacheWithManifest(
			'cache-bad-shape',
			JSON.stringify({ ...manifest, counts: { pages: 'many' } }),
		);
		const before = readFileSync(configPathOf(root));
		const output = await runSync(root, cache);

		const why = (output.data as { why: string }).why;
		expect(why).toContain('is not a bundle manifest this kit understands');
		expect(output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run']);
		expect(readFileSync(configPathOf(root))).toEqual(before);
		expect(exitCodeFor(output)).toBe(3);
	});

	test('a cached manifest for a different project is refused by name', async () => {
		const root = siteRepo((text) => text);
		const cache = cacheWithManifest(
			'cache-other-project',
			JSON.stringify({ ...manifest, project: 'other-app' }),
		);
		const output = await runSync(root, cache);

		const why = (output.data as { why: string }).why;
		// Both names, because the operator has to be able to tell which of the two is the
		// one they got wrong: the config's `project` field or the directory they prefetched
		// into.
		expect(why).toContain('other-app');
		expect(why).toContain(PROJECT);
		expect(output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run']);
		expect(exitCodeFor(output)).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// build, writing where it cannot
// ---------------------------------------------------------------------------

describe('build into a directory it cannot own', () => {
	test('the write-once refusal is a failing row naming the key, not a stack trace', async () => {
		const out = join(scratch, 'out-write-once');
		const first = await invoke(build, { root: corpus, out }, ctx(scratch));
		const prefix = (first.data as { prefix: string }).prefix;
		expect(prefix).not.toBeNull();
		expect((first.data as { written: number }).written).toBeGreaterThan(0);

		// The state the refusal exists for, produced the only way it can be: the same commit
		// with different bytes under one key. On a real machine that is a toolchain change
		// under a published sha or a compile that is not deterministic, and either way the
		// bundle in the bucket and the bundle on disk would stop being the same object.
		const key = pageKey('en', 'index');
		writeFileSync(join(prefix, key), 'different bytes', 'utf8');

		const second = await invoke(build, { root: corpus, out }, ctx(scratch));
		const row = second.rows.find((one) => one.id === 'build-objects');
		expect(row?.status).toBe('fail');
		expect(row?.note).toContain(join(prefix, key));
		expect(row?.note).toContain('write-once');
		expect(row?.note).toContain('not deterministic');
		// Nothing was written, and the line says so rather than reporting a partial count as
		// though the run had finished.
		expect((second.data as { prefix: string | null }).prefix).toBeNull();
		expect((second.data as { written: number }).written).toBe(0);
		expect(second.lines.some((line) => line.includes(`Nothing was written under ${out}`))).toBe(
			true,
		);
		expect(exitCodeFor(second)).toBe(3);

		// And the compile itself still happened. The manifest row is the proof: a failure to
		// write is not a failure to compile, and folding the two would tell an operator to
		// go and look at the documentation tree.
		expect(second.rows.find((one) => one.id === 'build-manifest')?.status).toBe('pass');
	});

	test('an --out that cannot be created is the same failing row, with the errno reason', async () => {
		// `--out` pointing at an existing file, which is what a shell glob or a stray
		// redirect produces. `mkdirSync` cannot make a directory under it, and the honest
		// output is the same row as the write-once refusal: the compile is fine and the
		// write is not.
		const out = join(scratch, 'out-is-a-file');
		writeFileSync(out, 'not a directory', 'utf8');
		expect(statSync(out).isFile()).toBe(true);

		const output = await invoke(build, { root: corpus, out }, ctx(scratch));
		const row = output.rows.find((one) => one.id === 'build-objects');
		expect(row?.status).toBe('fail');
		expect(row?.note).toContain(out);
		expect(row?.note).toMatch(/ENOTDIR|EEXIST|ENOENT/);
		expect((output.data as { prefix: string | null }).prefix).toBeNull();
		expect(exitCodeFor(output)).toBe(3);
		// Still a file. A failed write must not have left half a bundle beside it.
		expect(statSync(out).isFile()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// verify-install, against something that is not a consuming site
// ---------------------------------------------------------------------------

describe('verify-install pointed at a directory that is not a repository', () => {
	test('every check skips or fails having examined nothing, and the run says so', async () => {
		const root = emptyDirectory('not-a-repository');
		mkdirSync(join(root, SITE), { recursive: true });
		const output = await invoke(verifyInstall, { root, site: SITE }, repoCtx(root));

		// The state itself first: every row examined zero. Without this the assertion below
		// would pass against a report where one probe happened to find something.
		expect(output.rows.length).toBeGreaterThan(1);
		expect(output.rows.every((row) => row.examined === 0)).toBe(true);

		const scope = output.rows.find((row) => row.id === 'verify-install-scope');
		expect(scope?.status).toBe('not-run');
		// `not-run` rather than `fail`, because nothing is wrong with the repository: the
		// check should have run and could not, which is what that state means.
		expect(scope?.note).toContain('Every check skipped, so nothing was examined');
		expect(scope?.note).toContain(SITE);
		// The two things an operator can do about it, both named. A report that stopped at
		// "does not look like a consuming site" would leave a person in a documentation
		// source repository with no idea that a different command is the one they want.
		expect(scope?.note).toContain('app/docs/<project>.docs.json');
		expect(scope?.note).toContain('hexdocs check');
		expect(exitCodeFor(output)).toBe(3);
	});

	test('the report still validates, so the arm is a row rather than a thrown contract error', async () => {
		const root = emptyDirectory('not-a-repository-2');
		mkdirSync(join(root, SITE), { recursive: true });
		const output = await invoke(verifyInstall, { root, site: SITE }, repoCtx(root));

		// `verify-install` throws when the report it assembled fails its own contract, and
		// an all-skipped report is exactly the shape `examinedNothing` refuses. The row is
		// what converts a contract violation into an answer, so reaching this line at all is
		// half the assertion.
		const report = output.data as unknown as {
			exitCode: number;
			rows: readonly { id: string }[];
			nextAction: { kind: string; why: string };
		};
		expect(report.exitCode).toBe(3);
		expect(report.rows.some((row) => row.id === 'verify-install-scope')).toBe(true);
		expect(report.nextAction.kind).toBe('command');
	});
});

// ---------------------------------------------------------------------------
// check, with a filter that matches nothing
// ---------------------------------------------------------------------------

/**
 * The categories the fixture corpus produces, and the ones it does not.
 *
 * Measured rather than assumed, and pinned in both directions below: a corpus that grew a
 * `links` finding would make the empty-filter test vacuous, and it would do so silently,
 * because a filter over a category that now matches something still returns a summary
 * whose arithmetic is correct.
 */
const CORPUS_CATEGORIES = ['brand', 'house-style', 'i18n', 'structure'];

describe('check with a filter that matches nothing', () => {
	async function envelopeFor(input: Record<string, unknown>): Promise<DiagnosticEnvelope> {
		const output = await invoke(check, { root: corpus, ...input }, ctx(scratch));
		expect(output.envelope).not.toBeNull();
		return output.envelope as DiagnosticEnvelope;
	}

	test('the corpus produces four categories and not the other six', async () => {
		const whole = await envelopeFor({});
		const present = [...new Set(whole.findings.map((finding) => finding.category))].sort();

		// Both directions. The first half is what makes the tests below non-vacuous; the
		// second is what fails when the corpus starts producing a category one of them
		// filters on.
		expect(present).toEqual(CORPUS_CATEGORIES);
		expect(FINDING_CATEGORIES.filter((category) => !present.includes(category)).length).toBe(
			FINDING_CATEGORIES.length - CORPUS_CATEGORIES.length,
		);
	});

	test('a category filter that matches nothing re-derives the summary to zero', async () => {
		const absent = FINDING_CATEGORIES.filter((category) => !CORPUS_CATEGORIES.includes(category));
		const whole = await envelopeFor({});
		const empty = await envelopeFor({ category: absent });

		expect(empty.findings).toEqual([]);
		expect(empty.summary.errors).toBe(0);
		expect(empty.summary.warnings).toBe(0);
		expect(empty.summary.infos).toBe(0);
		// The counts the unfiltered run produced, so the zeros above are a re-derivation
		// rather than a corpus that had nothing to say.
		expect(whole.summary.errors).toBeGreaterThan(0);
		expect(whole.summary.warnings).toBeGreaterThan(0);
		// `passing` is carried through unchanged and deliberately: a rule the filter dropped
		// did report something, so a filter cannot recount it. `diagnostics.ts` already says
		// this number is not a coverage measure.
		expect(empty.summary.passing).toBe(whole.summary.passing);
	});

	test('the next action is none, and its reason distinguishes the two ways of being empty', async () => {
		const absent = FINDING_CATEGORIES.filter((category) => !CORPUS_CATEGORIES.includes(category));
		const empty = await envelopeFor({ category: absent });

		expect(empty.nextAction.kind).toBe('none');
		// The sentence is the whole point of the arm. An agent handed an empty report reads
		// it as a clean tree, and this run is a clean tree seen through a filter that hid
		// twenty-nine findings. Both halves are asserted, because "nothing matched" alone
		// still reads as good news.
		expect(empty.nextAction.why).toContain('Nothing matched this filter');
		expect(empty.nextAction.why).toContain('not the same as nothing being wrong');
		expect(empty.nextAction.why).toContain('run `hexdocs check` with no filter');
		expect(empty.nextAction).not.toHaveProperty('argv');
	});

	test('a locale filter and a category filter that each match alone, and not together', async () => {
		// The conjunction, which is the arm a filter that ORed its predicates would pass
		// every other test in this file with. `brand` findings are English only and `ja`
		// findings are all `i18n`, so each filter alone returns findings and the two
		// together return none.
		const brand = await envelopeFor({ category: ['brand'] });
		const japanese = await envelopeFor({ locale: ['ja'] });
		const both = await envelopeFor({ category: ['brand'], locale: ['ja'] });

		expect(brand.findings.length).toBeGreaterThan(0);
		expect(brand.findings.every((finding) => finding.category === 'brand')).toBe(true);
		expect(japanese.findings.length).toBeGreaterThan(0);
		expect(japanese.findings.every((finding) => finding.locale === 'ja')).toBe(true);

		expect(both.findings).toEqual([]);
		expect(both.summary.errors + both.summary.warnings + both.summary.infos).toBe(0);
		expect(both.nextAction.kind).toBe('none');
		expect(both.nextAction.why).toContain('not the same as nothing being wrong');
	});

	test('a run filtered to nothing exits 0, and the row that examined nothing is not a pass', async () => {
		const absent = FINDING_CATEGORIES.filter((category) => !CORPUS_CATEGORIES.includes(category));
		const output = await invoke(check, { root: corpus, category: absent }, ctx(scratch));

		// The exit code is 0 here and it is not a clean bill of health, which is exactly why
		// `nextAction.why` has to say so in words: the filter is the operator's own, and a
		// command cannot fail a run because somebody asked a narrow question.
		expect(exitCodeFor(output)).toBe(0);

		// The allowlist row is unaffected by the envelope filter, and it is `skipped` rather
		// than `pass` because the corpus has no mirror script. "Nothing here to read" and
		// "what is here is fine" are different answers and only one of them is a pass.
		expect(output.rows.map((row) => row.id)).toEqual(['wiring-allow-paths']);
		expect(output.rows[0]?.status).toBe('skipped');
		expect(output.rows[0]?.note).toContain('not a pass');
	});
});
