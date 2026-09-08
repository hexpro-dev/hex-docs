/**
 * `hexdocs scaffold`, driven through `invoke` against real directories.
 *
 * `kit/test/source/scaffold.test.ts` owns `kind=page`, and owns it the hard way: it writes
 * the scaffolder's own output into a materialised corpus, runs the real `buildBundle`, and
 * asserts the translation state the compiler gives it. Nothing here duplicates that. This
 * file is the other three kinds and the four properties that are the same for all four,
 * and the reason it is a separate file is that those three kinds never reach the compiler
 * at all: a config, a workflow and a mirror-script patch are validated by their own
 * schemas, by a YAML reader and by the allowlist parser respectively.
 *
 * The property every case here shares is that **this command writes nothing**. `Ctx.write`
 * is null in every context below, which is the runtime half of the guarantee, and every
 * kind is run against a directory that is snapshotted before and after, which is the half
 * that would catch a `writeFileSync` reached some other way. A test that only asserted the
 * returned file list would pass against a command that returned the list and wrote it too.
 *
 * The second property is that nothing here can overwrite. It is asserted per kind rather
 * than once, because "this one command cannot clobber and the others can" is a distinction
 * nobody remembers under pressure, and because the drop happens in a shared collector whose
 * three callers each reach it by a different route.
 *
 * Deliberately not covered here: the contents of the generated JSON beyond the fact that it
 * validates and that the fields a person will edit say what the scaffold means them to say.
 * The builders themselves are `kit/test/templates/source.test.ts`, and the workflow
 * document is `kit/test/templates/workflow.test.ts`; repeating those assertions against the
 * command would pin one implementation twice and neither surface once.
 *
 * Four arms in `scaffold.ts` are left uncovered on purpose, and each is unreachable through
 * this command rather than merely untested. Writing a test for one would mean calling a
 * private function directly, which would assert that the defence exists rather than that it
 * does anything.
 *
 *   * `titleFromSlug`'s two `null` returns, and the `?? slug` fallback that reads them.
 *     `scaffoldPage` refuses an unparseable slug before it ever calls the function, and a
 *     slug that parses always has a last segment.
 *   * `applyMirrorPatch`'s "no anchor to insert after" arm. `allowPathsRefusals` has
 *     already returned `unreadable-block` for a block this cannot parse and `empty-block`
 *     for one with no entries, which are the only two ways the anchor lookup can come back
 *     undefined. Both of those refusals are covered below.
 *   * `requestedLocales`'s bare-string arm. It exists because `common.ts` annotates
 *     `LOCALE_MANY` as `Param`, which erases `many: true` from the type; the schema both
 *     front doors validate against still says array, so a string cannot arrive.
 */

import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, test } from 'vitest';

import { LOCALES } from '../../../src/contracts/locales.js';
import { DENY_LIST_RELATIVE, SITE_ROOT_RELATIVE } from '../../../src/contracts/project.js';
import { UI_STRINGS } from '../../../src/ui/strings.js';
import { scaffold } from '../../src/commands/scaffold.js';
import {
	denyListSchema,
	docsProjectConfigSchema,
	docsSiteConfigSchema,
	navTreeSchema,
} from '../../src/contracts/config.schema.js';
import { NO_EXEC } from '../../src/exec/run.js';
import { exitCodeFor, invoke, type Ctx } from '../../src/registry/command.js';
import {
	MIRROR_SCRIPT_RELATIVE,
	allowPathsRefusals,
	insertSiteRoot,
	parseAllowPaths,
} from '../../src/source/allow-paths.js';
import { DEFAULT_KIT_MOUNT } from '../../src/templates/source.js';
import {
	BUCKET_VARIABLE,
	PUBLISH_WORKFLOW_PATH,
	ROLE_VARIABLE,
} from '../../src/templates/workflow.js';

const PROJECT = 'fixture-app';
const PRODUCT = 'Fixture App';
const REPO = 'hexpro-dev/fixture-app';
const SITE = 'apps/front';
const SITE_CONFIG = `${SITE}/app/docs/${PROJECT}.docs.json`;

/** This checkout, so the measured-mount case can be built from where the toolchain is. */
const HEX_DOCS_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface ScaffoldedFile {
	path: string;
	action: string;
	contents: string;
	anchor: string | null;
	why: string;
}

interface ScaffoldData {
	kind: string;
	root: string;
	files: ScaffoldedFile[];
	notes: string[];
}

const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repository(files: Readonly<Record<string, string>> = {}): string {
	const root = mkdtempSync(join(tmpdir(), 'hexdocs-scaffold-kind-'));
	roots.push(root);
	for (const [path, contents] of Object.entries(files)) put(root, path, contents);
	return root;
}

function put(root: string, relative: string, contents: string): void {
	const path = join(root, ...relative.split('/'));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, 'utf8');
}

/**
 * Every file under a root, by path and by content digest.
 *
 * The digest rather than the path list, because a command that rewrote a file it was
 * shown would leave the path list untouched. This is what "writes nothing" is measured
 * over.
 */
function snapshot(root: string): string[] {
	const found: string[] = [];
	const walk = (directory: string, prefix: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			// Symlinks are recorded by name and never followed, matching the compiler's own
			// rule: following one would take this walk outside the directory under test.
			if (entry.isSymbolicLink()) {
				found.push(`${relative} symlink`);
				continue;
			}
			if (entry.isDirectory()) {
				walk(join(directory, entry.name), relative);
				continue;
			}
			if (!entry.isFile()) continue;
			const digest = createHash('sha256')
				.update(readFileSync(join(directory, entry.name)))
				.digest('hex');
			found.push(`${relative} ${digest}`);
		}
	};
	walk(root, '');
	return found.sort();
}

/** `write` is null, which is what the MCP boundary hands every tool handler. */
function context(cwd: string): Ctx {
	return {
		cwd,
		kitVersion: '@hex-pro/docs-kit@0.0.0-test',
		exec: NO_EXEC,
		write: null,
		now: () => new Date('2026-06-01T00:00:00Z'),
		log: () => undefined,
	};
}

async function invokeScaffold(root: string, args: Record<string, unknown>) {
	const ctx = context(root);
	// The runtime half of the guarantee, asserted at every call site rather than once: the
	// `Command` union refuses to give a writing command a tool name, and this one has a tool
	// name, so a writer reachable from here would be a hole in that claim.
	expect(ctx.write).toBeNull();
	const output = await invoke(scaffold, { root, ...args }, ctx);
	return {
		output,
		data: output.data as unknown as ScaffoldData,
		exit: exitCodeFor(output),
	};
}

async function run(root: string, args: Record<string, unknown>) {
	const before = snapshot(root);
	const result = await invokeScaffold(root, args);
	// Every call in this file makes the same assertion, because the one thing that must be
	// true of all four kinds is that none of them touched the disk. The file list on its own
	// would pass against a command that returned the list and wrote it too.
	expect(snapshot(root)).toEqual(before);
	return result;
}

function parseJson(text: string): unknown {
	return JSON.parse(text) as unknown;
}

function fileAt(data: ScaffoldData, path: string): ScaffoldedFile {
	const file = data.files.find((entry) => entry.path === path);
	expect(file, `no scaffolded file at ${path}`).toBeDefined();
	return file as ScaffoldedFile;
}

const INDENT = '    ';

/**
 * hex-nfc's shape, shortened to the entries the behaviour under test turns on.
 *
 * `"docs/public"` is deliberately **not** the last entry. It was, at first, and that made
 * the anchor assertion below unfalsifiable: an implementation that ignored the
 * documentation group entirely and always appended after the last entry produced the same
 * answer, and the test stayed green through exactly that mutation. The real array is
 * grouped by area with the documentation group in the middle of it.
 */
function mirror(
	entries: readonly string[] = ['app', 'LICENSE', 'docs/public', '.github/workflows/ci.yml'],
	indent = INDENT,
) {
	return [
		'#!/usr/bin/env bash',
		'set -euo pipefail',
		'',
		'readonly ALLOW_PATHS=(',
		...entries.map((entry) => `${indent}"${entry}"`),
		')',
		'',
		'copy_allowed_paths',
		'',
	].join('\n');
}

// ---------------------------------------------------------------------------
// the four kinds, and what is true of all of them
// ---------------------------------------------------------------------------

/**
 * One claim per kind: the arguments it needs and the first file it offers.
 *
 * Checked against the command's own parameter table in both directions below, so a fifth
 * kind added to `SCAFFOLD_KINDS` fails here naming it rather than arriving with no test,
 * and a kind removed fails too.
 */
const KINDS: readonly { kind: string; args: Record<string, unknown>; first: string }[] = [
	{
		kind: 'source',
		args: { project: PROJECT, 'product-name': PRODUCT, repo: REPO },
		first: `${SITE_ROOT_RELATIVE}/docs.json`,
	},
	{
		kind: 'page',
		args: { slug: 'guide/first-tag' },
		first: `${SITE_ROOT_RELATIVE}/content/en/guide/first-tag.md`,
	},
	{ kind: 'site', args: { project: PROJECT, site: SITE }, first: SITE_CONFIG },
	{ kind: 'workflow', args: {}, first: PUBLISH_WORKFLOW_PATH },
];

describe('every kind', () => {
	test('is claimed by a case, and this table names no kind the command does not have', () => {
		const declared = scaffold.params['kind']?.values ?? [];
		expect(KINDS.map((entry) => entry.kind).sort()).toEqual([...declared].sort());
		expect(declared.length).toBeGreaterThan(0);
	});

	for (const entry of KINDS) {
		test(`${entry.kind} returns files, writes nothing, and offers a reason for each`, async () => {
			const root = repository({ [MIRROR_SCRIPT_RELATIVE]: mirror() });
			const { data, exit, output } = await run(root, { kind: entry.kind, ...entry.args });

			expect(exit).toBe(0);
			expect(data.kind).toBe(entry.kind);
			expect(data.root).toBe(root);
			expect(data.files.length).toBeGreaterThan(0);
			expect(data.files.map((file) => file.path)).toContain(entry.first);
			for (const file of data.files) {
				expect(['create', 'patch']).toContain(file.action);
				expect(file.why.length).toBeGreaterThan(20);
				expect(file.contents.length).toBeGreaterThan(0);
				// Present and null on a create, so "there is no anchor" cannot read the same as a
				// key somebody forgot to set.
				expect(file.action === 'create' ? file.anchor : 'set').not.toBe(undefined);
			}
			// The printed summary says out loud that nothing happened, because an agent that
			// read the file list as a report of work done would not apply it.
			expect(output.lines[0]).toContain('Nothing was written');
		});

		test(`${entry.kind} drops a target that already exists and names it in a note`, async () => {
			const root = repository({
				[MIRROR_SCRIPT_RELATIVE]: mirror(),
				[entry.first]: 'somebody else wrote this\n',
			});
			const { data, exit } = await run(root, { kind: entry.kind, ...entry.args });

			// Dropped, not refused: the rest of the plan is still worth applying.
			expect(exit).toBe(0);
			expect(data.files.map((file) => file.path)).not.toContain(entry.first);
			const note = data.notes.find((line) => line.startsWith(entry.first));
			expect(note).toBeDefined();
			expect(note).toContain('already exists');
			expect(note).toContain('never');
			// And the bytes on disk are the ones that were there, which `run` has already
			// asserted for the whole tree.
			expect(readFileSync(join(root, ...entry.first.split('/')), 'utf8')).toBe(
				'somebody else wrote this\n',
			);
		});
	}
});

// ---------------------------------------------------------------------------
// missing arguments
// ---------------------------------------------------------------------------

/**
 * Every argument a kind needs, and the kind that needs it.
 *
 * `--project`, `--site`, `--repo` and `--product-name` are optional in the parameter table
 * because only some kinds need them, so the requirement is conditional and is checked in
 * the handler. That makes these the arms most likely to rot: nothing in the schema would
 * notice if one stopped being checked, and the result would be a config with the string
 * `undefined` in it.
 */
/** Every conditional flag, so the both-directions check below has a set to subtract from. */
const FLAGS = ['--project', '--product-name', '--repo', '--slug', '--site'] as const;

const REQUIRED: readonly { kind: string; args: Record<string, unknown>; missing: string[] }[] = [
	{
		kind: 'source',
		args: {},
		missing: ['--project', '--product-name', '--repo'],
	},
	{
		kind: 'source',
		args: { project: PROJECT, repo: REPO },
		missing: ['--product-name'],
	},
	{ kind: 'site', args: {}, missing: ['--project', '--site'] },
	{ kind: 'site', args: { site: SITE }, missing: ['--project'] },
	{ kind: 'page', args: {}, missing: ['--slug'] },
];

describe('a kind that was not told what it needs', () => {
	for (const entry of REQUIRED) {
		test(`${entry.kind} without ${entry.missing.join(' and ')} refuses and builds nothing`, async () => {
			const root = repository({ [MIRROR_SCRIPT_RELATIVE]: mirror() });
			const { data, exit, output } = await run(root, { kind: entry.kind, ...entry.args });

			// A not-run row rather than a clean exit with an empty file list. An empty list is
			// what a successful scaffold of an already-scaffolded repository looks like, so
			// returning one here would make "you did not say which project" and "there was
			// nothing to do" the same answer to an agent reading the JSON.
			expect(exit).toBe(3);
			expect(output.rows.map((row) => row.status)).toEqual(['not-run']);
			expect(output.rows[0]?.id).toBe('scaffold');
			expect(data.files).toEqual([]);
			expect(data.notes).toHaveLength(1);

			// The flags it asks for are exactly the flags that were not supplied, both
			// directions. A refusal listing a flag somebody did pass sends them looking at the
			// wrong argument, which is worse than a shorter message.
			const why = data.notes[0] as string;
			const sentence = why.split('. ')[0] as string;
			expect(sentence.startsWith(`scaffold ${entry.kind} needs `)).toBe(true);
			expect(FLAGS.filter((flag) => sentence.includes(flag)).sort()).toEqual(
				[...entry.missing].sort(),
			);
			// And the sentence after it says why there is no default worth guessing, because a
			// refusal that only says a flag is missing is one an agent will retry with a value
			// it invented.
			expect(why.length).toBeGreaterThan(sentence.length + 40);
		});
	}

	test('an argument that is the wrong shape is refused with the shape it should be', async () => {
		const root = repository();
		const bad = await run(root, {
			kind: 'source',
			project: 'Fixture_App',
			'product-name': PRODUCT,
			repo: REPO,
		});
		expect(bad.exit).toBe(3);
		expect(bad.data.files).toEqual([]);
		expect(bad.data.notes[0]).toContain('S3 key prefix');

		const repo = await run(root, {
			kind: 'source',
			project: PROJECT,
			'product-name': PRODUCT,
			repo: 'fixture-app',
		});
		expect(repo.exit).toBe(3);
		expect(repo.data.notes[0]).toContain('owner/name');

		const site = await run(root, { kind: 'site', project: 'Fixture_App', site: SITE });
		expect(site.exit).toBe(3);
		expect(site.data.files).toEqual([]);

		// A slug is the filename and the address, so it is parsed rather than pattern
		// matched, and the refusal is the parser's own message.
		const slug = await run(root, { kind: 'page', slug: 'Guide/First Tag' });
		expect(slug.exit).toBe(3);
		expect(slug.data.files).toEqual([]);
		expect(slug.data.notes[0]).not.toBe('');
	});
});

// ---------------------------------------------------------------------------
// kind=page, at the command level only
// ---------------------------------------------------------------------------

/**
 * The arms of `page` that are about reading a repository rather than about what the
 * compiler makes of the result.
 *
 * `kit/test/source/scaffold.test.ts` owns the property that matters most about this kind,
 * and owns it through the real `buildBundle` over a materialised history. Nothing here
 * repeats that. What is here is the three answers this command can give about a source page
 * it was asked to translate, each of which is a decision about a file on disk: the title it
 * derives when nobody passed one, the front matter keys a stub does not inherit, and the
 * snippets a stub deliberately leaves out.
 */
describe('scaffold page', () => {
	const SOURCE = `${SITE_ROOT_RELATIVE}/content/en/guide/index.md`;

	function page(front: readonly string[], body: readonly string[]): string {
		return ['---', ...front, '---', '', ...body, ''].join('\n');
	}

	test('derives a section title from the section rather than from the word index', async () => {
		// `guide/index` is `Guide`, because the meaningful segment of a section root is the
		// section. A title of "Index" would be the one field an author is certain to rewrite,
		// written wrongly.
		const { data } = await run(repository(), { kind: 'page', slug: 'guide/index' });
		expect(fileAt(data, SOURCE).contents).toContain('title: Guide');
	});

	test('and an explicit title wins over the derived one', async () => {
		const { data } = await run(repository(), {
			kind: 'page',
			slug: 'guide/index',
			title: 'Using the app',
		});
		expect(fileAt(data, SOURCE).contents).toContain('title: Using the app');
	});

	test('a title with no front matter spelling is a note rather than a file', async () => {
		// The same refusal `templates/page.ts` returns to `init`, reaching an agent as a note
		// beside the files that were built. Emitting the file anyway would produce one the
		// compiler refuses to read, with a message about a value this tool chose.
		const { data, exit } = await run(repository(), {
			kind: 'page',
			slug: 'guide/index',
			title: 'He said: "no"',
		});
		expect(exit).toBe(0);
		expect(data.files).toEqual([]);
		const note = data.notes.find((line) => line.startsWith(SOURCE));
		expect(note).toContain('could not be built');
		expect(note).toContain('double quote');
	});

	test('a stub inherits every page-level fact except the two it must not', async () => {
		const root = repository({
			[SOURCE]: page(
				[
					'title: Guide',
					'description: A sentence about the guide.',
					'audience: user',
					'draft: true',
					'tags:',
					'  - scanning',
				],
				['Prose.', '', '## Before you start', '', 'More prose.'],
			),
		});
		const { data } = await run(root, { kind: 'page', slug: 'guide/index', locale: ['fr'] });
		const stub = fileAt(data, `${SITE_ROOT_RELATIVE}/content/fr/guide/index.md`).contents;

		expect(stub).toContain('audience: user');
		expect(stub).toContain('- scanning');
		expect(stub).toContain('## Before you start');
		expect(stub).toContain('translated: false');
		// `draft` is read from the source locale only, because a missing translation has no
		// front matter to agree with, and asking six files to agree about a flag one of them
		// can set is a rule with no right answer.
		expect(stub).not.toContain('draft:');
	});

	test('a transcluded snippet is left out of the stub and named in a note', async () => {
		const root = repository({
			[SOURCE]: page(
				['title: Guide', 'description: A sentence about the guide.'],
				['Prose.', '', '::include[safety-note]', '', '## Next', '', 'More prose.'],
			),
		});
		const { data } = await run(root, { kind: 'page', slug: 'guide/index', locale: ['fr'] });
		const stub = fileAt(data, `${SITE_ROOT_RELATIVE}/content/fr/guide/index.md`).contents;

		// A snippet with no file in the target locale is a `snippet-resolves` error, which
		// blocks the whole bundle, where the missing section is only a
		// `heading-set-matches-source` warning. The warning is the better failure.
		expect(stub).not.toContain('::include');
		const note = data.notes.find((line) => line.includes('safety-note'));
		expect(note).toBeDefined();
		expect(note).toContain('snippets/<locale>/');
	});

	test('and a source page nobody asked to translate produces no snippet note', async () => {
		// The other direction on the same arm. The note is for a translator, so a run that
		// scaffolds only the source locale has nobody to tell.
		const root = repository({
			[SOURCE]: page(
				['title: Guide', 'description: A sentence about the guide.'],
				['::include[safety-note]'],
			),
		});
		const { data } = await run(root, { kind: 'page', slug: 'guide/index', locale: ['en'] });
		expect(data.notes.filter((line) => line.includes('safety-note'))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// kind=source
// ---------------------------------------------------------------------------

describe('scaffold source', () => {
	test('offers exactly what an app repository needs, and every JSON validates', async () => {
		const root = repository({ [MIRROR_SCRIPT_RELATIVE]: mirror() });
		const { data } = await run(root, {
			kind: 'source',
			project: PROJECT,
			'product-name': PRODUCT,
			repo: REPO,
		});

		// Both directions on the file set. A file added to the template and not offered here
		// fails, and a file offered that the set does not name fails too.
		expect(data.files.map((file) => file.path)).toEqual([
			`${SITE_ROOT_RELATIVE}/docs.json`,
			`${SITE_ROOT_RELATIVE}/nav.json`,
			`${SITE_ROOT_RELATIVE}/content/en/index.md`,
			DENY_LIST_RELATIVE,
			PUBLISH_WORKFLOW_PATH,
			MIRROR_SCRIPT_RELATIVE,
		]);

		// The assertion that matters most: a scaffolder emitting a config its own validator
		// rejects is the tool contradicting itself, and nobody sees it until somebody runs
		// `hexdocs check` in a repository they have just set up.
		const cases: readonly [string, { safeParse: (value: unknown) => { success: boolean } }][] = [
			[`${SITE_ROOT_RELATIVE}/docs.json`, docsProjectConfigSchema],
			[`${SITE_ROOT_RELATIVE}/nav.json`, navTreeSchema],
			[DENY_LIST_RELATIVE, denyListSchema],
		];
		for (const [path, schema] of cases) {
			const parsed = schema.safeParse(parseJson(fileAt(data, path).contents));
			expect([path, parsed.success]).toEqual([path, true]);
		}
	});

	test('the requested locales reach the config, deduplicated and in LOCALES order', async () => {
		const root = repository();
		const { data } = await run(root, {
			kind: 'source',
			project: PROJECT,
			'product-name': PRODUCT,
			repo: REPO,
			locale: ['fr', 'en', 'fr'],
		});
		const config = docsProjectConfigSchema.parse(
			parseJson(fileAt(data, `${SITE_ROOT_RELATIVE}/docs.json`).contents),
		);
		// `LOCALES` order and not the order they were typed, so two people setting the same
		// project up produce the same file.
		expect(config.i18n.locales).toEqual(['en', 'fr']);
	});

	test('the allowlist line is four spaces and the publishable root, after "docs/public"', async () => {
		const text = mirror();
		const root = repository({ [MIRROR_SCRIPT_RELATIVE]: text });
		const { data } = await run(root, {
			kind: 'source',
			project: PROJECT,
			'product-name': PRODUCT,
			repo: REPO,
		});

		const patch = fileAt(data, MIRROR_SCRIPT_RELATIVE);
		expect(patch.action).toBe('patch');
		expect(patch.contents).toBe(`${INDENT}"${SITE_ROOT_RELATIVE}"`);
		expect(patch.contents.slice(0, patch.contents.indexOf('"'))).toBe('    ');
		// The anchor is the line the array really has, so an agent applying this with Edit
		// puts the entry in the documentation group rather than at the end.
		expect(patch.anchor).toBe(`${INDENT}"docs/public"`);
		expect(text).toContain(patch.anchor as string);

		// And the result is a file the guard accepts, which is the property a string
		// comparison cannot make: applying the patch by hand and applying it with the editor
		// this package ships produce the same array.
		const applied = text.replace(patch.anchor as string, `${patch.anchor}\n${patch.contents}`);
		expect(allowPathsRefusals(applied)).toEqual([]);
		expect(applied).toBe(insertSiteRoot(text));
		const entries = parseAllowPaths(applied)?.entries.map((item) => item.normalised) ?? [];
		expect(entries).toContain(SITE_ROOT_RELATIVE);
		// Never the parent. That entry copies the internal documentation tree to the mirror
		// and the prune step that follows would report nothing to prune.
		expect(entries).not.toContain('docs');
	});

	test('an allowlist with no docs/public entry anchors on the last line and says so', async () => {
		// Every repository except hex-nfc. The insertion still has to land inside the array,
		// and at the indent its neighbours use.
		const text = mirror(['app', 'LICENSE'], '\t');
		const root = repository({ [MIRROR_SCRIPT_RELATIVE]: text });
		const { data } = await run(root, {
			kind: 'source',
			project: PROJECT,
			'product-name': PRODUCT,
			repo: REPO,
		});

		const patch = fileAt(data, MIRROR_SCRIPT_RELATIVE);
		expect(patch.contents).toBe(`\t"${SITE_ROOT_RELATIVE}"`);
		expect(patch.anchor).toBe('\t"LICENSE"');
		expect(data.notes.join('\n')).toContain('no "docs/public" entry');
	});

	test('a repository with no mirror script gets a note instead of a patch', async () => {
		const root = repository();
		const { data } = await run(root, {
			kind: 'source',
			project: PROJECT,
			'product-name': PRODUCT,
			repo: REPO,
		});
		expect(data.files.map((file) => file.path)).not.toContain(MIRROR_SCRIPT_RELATIVE);
		const note = data.notes.find((line) => line.includes(MIRROR_SCRIPT_RELATIVE));
		expect(note).toContain('no public mirror');
	});

	test('an allowlist that is already wired is left alone', async () => {
		const root = repository({
			[MIRROR_SCRIPT_RELATIVE]: mirror(['app', 'docs/public', SITE_ROOT_RELATIVE]),
		});
		const { data } = await run(root, {
			kind: 'source',
			project: PROJECT,
			'product-name': PRODUCT,
			repo: REPO,
		});
		expect(data.files.map((file) => file.path)).not.toContain(MIRROR_SCRIPT_RELATIVE);
		expect(data.notes.join('\n')).toContain('Nothing to add');
	});

	test('a dangerous allowlist gets the refusal and no line to add', async () => {
		// The one edit in this package that cannot be taken back. A bare `docs` entry copies
		// the internal documentation tree to a public repository, so adding a line to an array
		// that is already wrong would endorse it.
		const root = repository({ [MIRROR_SCRIPT_RELATIVE]: mirror(['app', 'docs']) });
		const { data } = await run(root, {
			kind: 'source',
			project: PROJECT,
			'product-name': PRODUCT,
			repo: REPO,
		});

		expect(data.files.map((file) => file.path)).not.toContain(MIRROR_SCRIPT_RELATIVE);
		const notes = data.notes.join('\n');
		expect(notes).toContain('bare-docs');
		// The message is the product here. A boolean tells somebody the edit did not happen;
		// only the message tells them what the alternative ships.
		expect(notes).toContain('export-compliance');
		expect(notes).toContain('device identifier');
		expect(notes).toContain('nothing to prune');
		expect(notes).toContain('would endorse it');
		// The rest of the plan still stands, because one bad array is a fact about one file.
		expect(data.files.map((file) => file.path)).toContain(`${SITE_ROOT_RELATIVE}/docs.json`);
	});

	test('an allowlist this code cannot read is refused rather than guessed at', async () => {
		// An unquoted line is valid bash and a real bare-docs entry, so the whole block is
		// unreadable rather than one line skipped.
		const root = repository({
			[MIRROR_SCRIPT_RELATIVE]: mirror().replace(`${INDENT}"app"`, `${INDENT}app`),
		});
		const { data } = await run(root, {
			kind: 'source',
			project: PROJECT,
			'product-name': PRODUCT,
			repo: REPO,
		});
		expect(data.files.map((file) => file.path)).not.toContain(MIRROR_SCRIPT_RELATIVE);
		expect(data.notes.join('\n')).toContain('unreadable-block');
	});

	test('a mirror script this process cannot read is treated as one that is not there', async () => {
		// A directory where the script should be. The read fails closed, which folds an
		// unreadable file into the same answer as an absent one: no patch. That is the safe
		// direction, and it is worth a test because the alternative to folding is a throw out
		// of a command whose whole contract is that it returns content.
		const root = repository();
		mkdirSync(join(root, ...MIRROR_SCRIPT_RELATIVE.split('/')), { recursive: true });
		const { data, exit } = await run(root, {
			kind: 'source',
			project: PROJECT,
			'product-name': PRODUCT,
			repo: REPO,
		});
		expect(exit).toBe(0);
		expect(data.files.map((file) => file.path)).not.toContain(MIRROR_SCRIPT_RELATIVE);
		expect(data.notes.join('\n')).toContain('no public mirror');
	});

	test('an allowlist with no entries names no anchor, so there is nothing to insert after', async () => {
		const root = repository({ [MIRROR_SCRIPT_RELATIVE]: mirror([]) });
		const { data } = await run(root, {
			kind: 'source',
			project: PROJECT,
			'product-name': PRODUCT,
			repo: REPO,
		});
		expect(data.files.map((file) => file.path)).not.toContain(MIRROR_SCRIPT_RELATIVE);
		expect(data.notes.join('\n')).toContain('empty-block');
	});
});

// ---------------------------------------------------------------------------
// kind=site
// ---------------------------------------------------------------------------

describe('scaffold site', () => {
	async function siteRun(args: Record<string, unknown> = {}) {
		const root = repository();
		return run(root, { kind: 'site', project: PROJECT, site: SITE, ...args });
	}

	test('writes one file, where verify-install and prefetch both look for it', async () => {
		const { data } = await siteRun();
		expect(data.files.map((file) => file.path)).toEqual([SITE_CONFIG]);
	});

	test('a site path with a leading dot slash or a trailing slash lands in the same place', async () => {
		const tidy = await siteRun({ site: './apps/front/' });
		expect(tidy.data.files.map((file) => file.path)).toEqual([SITE_CONFIG]);
	});

	test('the config validates apart from versions, which only hexdocs label can fill in', async () => {
		const { data } = await siteRun();
		const value = parseJson(fileAt(data, SITE_CONFIG).contents) as Record<string, unknown>;

		const parsed = docsSiteConfigSchema.safeParse(value);
		expect(parsed.success).toBe(false);
		// Exactly one reason. The schema needs a real 40-character commit sha, which a
		// scaffolder cannot know, and writing a plausible one would put a fabricated commit
		// into the file the version picker reads.
		expect((parsed.error?.issues ?? []).map((issue) => issue.path.join('.'))).toEqual(['versions']);
		expect(
			docsSiteConfigSchema.safeParse({
				...value,
				versions: [{ label: '1.0', commit: 'a'.repeat(40), released: '2026-01-01', default: true }],
			}).success,
		).toBe(true);

		expect(value['project']).toBe(PROJECT);
		expect(value['basePath']).toBe(`/${PROJECT}/docs`);
	});

	test('the sidebar label is this package own table, in all seven languages', async () => {
		const { data } = await siteRun();
		const value = parseJson(fileAt(data, SITE_CONFIG).contents) as Record<string, unknown>;
		const label = value['navLabel'] as Record<string, string>;

		// Both directions on the key set, so a locale added to the package fails here rather
		// than shipping a sidebar heading in English under an Arabic page.
		expect(Object.keys(label).sort()).toEqual([...LOCALES].sort());
		for (const locale of LOCALES) expect(label[locale]).toBe(UI_STRINGS[locale].treeLabel);
	});

	test('pages comes back empty, with a note saying which command fills it', async () => {
		const { data } = await siteRun();
		const value = parseJson(fileAt(data, SITE_CONFIG).contents) as Record<string, unknown>;
		expect(value['pages']).toEqual([]);

		// It has to be a build input, because root.tsx renders the canonical link and all
		// eight hreflang alternates above <Meta />, where a route cannot correct them.
		const note = data.notes.find((line) => line.startsWith('pages stays empty'));
		expect(note).toBeDefined();
		expect(note).toContain('hexdocs sync');
		expect(data.notes.join('\n')).toContain('hexdocs label');
		expect(data.notes.join('\n')).toContain('themeClass');
	});

	test('a project id that is also a language code is named rather than quietly emitted', async () => {
		const { data } = await siteRun({ project: 'es' });
		const note = data.notes.find((line) => line.includes('language code'));
		expect(note).toBeDefined();

		// And the note is true: the schema really does refuse that basePath, because the
		// locale prefix is added per request and a basePath carrying one would have to exist
		// seven times.
		const value = parseJson(fileAt(data, `${SITE}/app/docs/es.docs.json`).contents) as Record<
			string,
			unknown
		>;
		const parsed = docsSiteConfigSchema.safeParse({
			...value,
			versions: [{ label: '1.0', commit: 'b'.repeat(40), released: '2026-01-01', default: true }],
		});
		expect(parsed.success).toBe(false);
		expect((parsed.error?.issues ?? []).map((issue) => issue.path.join('.'))).toContain('basePath');
	});
});

// ---------------------------------------------------------------------------
// kind=workflow
// ---------------------------------------------------------------------------

describe('scaffold workflow', () => {
	test('is one file at the one path GitHub reads, and it names no account', async () => {
		const root = repository();
		const { data } = await run(root, { kind: 'workflow' });

		expect(data.files.map((file) => file.path)).toEqual([PUBLISH_WORKFLOW_PATH]);
		const text = fileAt(data, PUBLISH_WORKFLOW_PATH).contents;
		// hex-docs is public and an app repository may have a public mirror, so the pair an
		// attacker would want is the bucket name and the role ARN. `workflow.test.ts` reads
		// the document; this is the same scan at the surface a person actually applies.
		expect(/\d{12}/.test(text)).toBe(false);
		expect(/arn:aws:/.test(text)).toBe(false);
		expect(text).toContain(`\${{ vars.${ROLE_VARIABLE} }}`);
		expect(text).toContain(`\${{ vars.${BUCKET_VARIABLE} }}`);
	});

	test('the region comes from the flag default rather than from a second literal', async () => {
		const root = repository();
		const { data } = await run(root, { kind: 'workflow' });
		// The one default declared in `common.ts`, read rather than repeated, so the flag a
		// person passes to `publish` and the region the workflow assumes cannot drift.
		expect(fileAt(data, PUBLISH_WORKFLOW_PATH).contents).toContain('aws-region: ap-southeast-2');
	});

	test('the notes name both variables and say not to allowlist the file', async () => {
		const root = repository();
		const { data } = await run(root, { kind: 'workflow' });
		const notes = data.notes.join('\n');
		expect(notes).toContain(ROLE_VARIABLE);
		expect(notes).toContain(BUCKET_VARIABLE);
		// Exclusion by absence is what keeps the bucket name and the role name off a mirror,
		// and it is invisible: nothing fails when it stops holding.
		expect(notes).toContain('public-mirror allowlist');
		expect(notes).toContain('.github/scripts/');
	});
});

// ---------------------------------------------------------------------------
// where the toolchain is
// ---------------------------------------------------------------------------

describe('the mount', () => {
	test('falls back to the documented default, and says it did', async () => {
		// A temporary directory is not above this checkout, which is what happens when
		// somebody runs the CLI out of a hex-docs clone against a repository somewhere else. A
		// relative path climbing out of the repository would be worse than the default,
		// because it would be silently wrong on the machine that later reads the file.
		const root = repository();
		const { data } = await run(root, { kind: 'site', project: PROJECT, site: SITE });
		const note = data.notes.find((line) => line.includes('assumes it is mounted at'));
		expect(note).toBeDefined();
		expect(note).toContain(`${DEFAULT_KIT_MOUNT}/`);

		const value = parseJson(fileAt(data, SITE_CONFIG).contents) as Record<string, string>;
		expect(value['$schema']).toBe(`../../../../${DEFAULT_KIT_MOUNT}/kit/schema/site-1.json`);
	});

	test('is measured when the toolchain really is under the root', async () => {
		// The ordinary case in every consuming repository, and the only root it can be run
		// against is a real ancestor of this checkout: the mount is measured from this
		// module's own location, so a temporary directory can only ever produce the fallback
		// above. The site directory named below is one nothing can already have, so no file is
		// dropped and the assertion is about the mount rather than about whatever happens to
		// sit beside hex-docs.
		//
		// This is the one call in the file that does not snapshot its root. That root is a
		// directory holding every repository in the estate, so walking it would be neither
		// quick nor a measurement of anything this command did; the target directory is
		// checked for instead, which is the write this call could have made.
		const root = dirname(HEX_DOCS_ROOT.replace(/\/+$/, ''));
		const mount = basename(HEX_DOCS_ROOT.replace(/\/+$/, ''));
		const { data } = await invokeScaffold(root, {
			kind: 'site',
			project: PROJECT,
			site: 'hexdocs-scaffold-probe',
		});
		expect(existsSync(join(root, 'hexdocs-scaffold-probe'))).toBe(false);

		expect(data.notes.filter((line) => line.includes('assumes it is mounted at'))).toEqual([]);
		const config = fileAt(data, `hexdocs-scaffold-probe/app/docs/${PROJECT}.docs.json`);
		const value = parseJson(config.contents) as Record<string, string>;
		expect(value['$schema']).toBe(`../../../${mount}/kit/schema/site-1.json`);
	});
});
