/**
 * Reading an app repository's `docs/` tree, and what it refuses to read.
 *
 * Two halves, and the split is the point.
 *
 * The corpus half loads `fixtures/app` and checks the counts against what `corpus.ts`
 * declares rather than against numbers written here. A page added to the fixture with
 * no declaration fails, and a declaration with no file fails, so the loader cannot come
 * to disagree with the corpus quietly.
 *
 * The throwaway half builds trees under `os.tmpdir()`, one per refusal, because every
 * one of these is a state the corpus deliberately does not contain: the corpus has to
 * build. A symlink, an agent guide in the publishable root, a locale directory nobody
 * declared and a page named `search` are all things that must be refused, and a fixture
 * that carried them would be a fixture that no longer compiles.
 *
 * The configs those trees are built from are the corpus's own, mutated one key at a
 * time. Hand-writing a minimal `docs.json` here would mean the invalid cases were
 * measured against a config that had never been valid, and a schema change would leave
 * every one of them failing for the wrong reason.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import type { FindingLocation } from '../../../src/contracts/diagnostics.js';
import { FORBIDDEN_SOURCE_NAMES } from '../../../src/contracts/project.js';
import { findRepositoryRoot, readRepository, toUtcTimestamp } from '../../src/compile/git.js';
import { loadProject, ProjectError, type LoadedProject } from '../../src/compile/project.js';
import type { RawFinding } from '../../src/compile/types.js';
import {
	APP_ROOT,
	FIXTURE_ASSETS,
	FIXTURE_HISTORY,
	FIXTURE_PAGES,
	FIXTURE_SNIPPETS,
	SITE_ROOT,
	appFiles,
	materialiseCorpus,
} from '../../../fixtures/index.js';

// ---------------------------------------------------------------------------
// Throwaway trees
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The corpus's own config, parsed, so a mutated copy starts from something valid. */
function baseConfig(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(SITE_ROOT, 'docs.json'), 'utf8')) as Record<string, unknown>;
}

function baseNav(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(SITE_ROOT, 'nav.json'), 'utf8')) as Record<string, unknown>;
}

/** The locales the corpus declares, as the config states them. */
function declaredLocales(config: Record<string, unknown>): string[] {
	return (config.i18n as { locales: string[] }).locales;
}

interface Tree {
	/** Repository-root-relative path to its contents. A directory is made for each. */
	files?: Record<string, string>;
	/** Link path to target path, both repository-root-relative. */
	symlinks?: Record<string, string>;
	config?: Record<string, unknown> | null;
	nav?: Record<string, unknown> | null;
	/** Written to `docs/docs.private.json`, outside the publishable root. */
	privateJson?: string;
}

/** A throwaway directory, removed when the file finishes. */
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), 'hexdocs-project-'));
	roots.push(root);
	return root;
}

/** A throwaway app repository. Returns its root, which is what `loadProject` takes. */
function writeTree(tree: Tree): string {
	const root = scratch();

	const write = (path: string, body: string): void => {
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, body, 'utf8');
	};

	if (tree.config !== null)
		write('docs/site/docs.json', JSON.stringify(tree.config ?? baseConfig()));
	if (tree.nav !== null) write('docs/site/nav.json', JSON.stringify(tree.nav ?? baseNav()));
	if (tree.privateJson !== undefined) write('docs/docs.private.json', tree.privateJson);
	for (const [path, body] of Object.entries(tree.files ?? {})) write(path, body);
	for (const [link, target] of Object.entries(tree.symlinks ?? {})) {
		mkdirSync(dirname(join(root, link)), { recursive: true });
		symlinkSync(join(root, target), join(root, link));
	}
	return root;
}

/** A page body that validates, so a refusal under test is the only thing wrong. */
function page(title: string): string {
	return `---\ntitle: ${title}\ndescription: A description that is a whole sentence about this page.\n---\n\nBody text.\n`;
}

function locationFile(location: FindingLocation): string {
	return 'file' in location ? location.file : '';
}

/** The findings about one file, so a test names the file it is about. */
function about(loaded: LoadedProject, file: string): RawFinding[] {
	return loaded.findings.filter((finding) => locationFile(finding.location) === file);
}

/** Exactly one finding about one file, failing by name when there are more or none. */
function only(loaded: LoadedProject, file: string): RawFinding {
	const found = about(loaded, file);
	if (found.length !== 1) {
		throw new Error(
			`expected one finding about ${file}, got ${found.length}: ${found.map((f) => f.message).join(' | ')}`,
		);
	}
	return found[0] as RawFinding;
}

function thrownBy(root: string): ProjectError {
	try {
		loadProject(root);
	} catch (error) {
		if (error instanceof ProjectError) return error;
		throw error;
	}
	throw new Error('expected loadProject to throw a ProjectError');
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

describe('the fixture corpus, against what corpus.ts declares', () => {
	const loaded = loadProject(APP_ROOT);

	/** One file per declared page locale, per declared snippet locale, and per asset. */
	const declaredFiles =
		FIXTURE_PAGES.reduce((total, entry) => total + Object.keys(entry.locales).length, 0) +
		FIXTURE_SNIPPETS.reduce((total, entry) => total + Object.keys(entry.locales).length, 0) +
		FIXTURE_ASSETS.length;

	test('every page, snippet and asset the corpus declares is loaded and nothing else is', () => {
		expect([...loaded.pages.keys()].sort()).toEqual(
			FIXTURE_PAGES.map((entry) => entry.slug).sort(),
		);
		expect([...loaded.snippets.keys()].sort()).toEqual(
			FIXTURE_SNIPPETS.map((entry) => entry.id).sort(),
		);
		expect([...loaded.assets.keys()].sort()).toEqual(
			FIXTURE_ASSETS.map((entry) => entry.path).sort(),
		);
	});

	test('each page carries exactly the locales it declares', () => {
		// Both directions. A page loaded in a locale it does not declare is a file nobody
		// meant to publish, and a declared locale that did not load is a translation the
		// coverage table would report as present and the bundle would not contain.
		for (const entry of FIXTURE_PAGES) {
			expect([...(loaded.pages.get(entry.slug)?.keys() ?? [])].sort()).toEqual(
				Object.keys(entry.locales).sort(),
			);
		}
		for (const entry of FIXTURE_SNIPPETS) {
			expect([...(loaded.snippets.get(entry.id)?.keys() ?? [])].sort()).toEqual(
				Object.keys(entry.locales).sort(),
			);
		}
		expect(FIXTURE_PAGES.length + FIXTURE_SNIPPETS.length).toBe(11);
	});

	test('the walk examined one file per declaration and reported nothing', () => {
		// `docs.json` and `nav.json` are read before the walk and are not counted, so this
		// is the content the compiler actually has. A run that examined nothing is the
		// failure this number exists to make visible.
		expect(loaded.examined).toBe(declaredFiles);
		expect(loaded.examined).toBe(53);
		expect(loaded.findings).toEqual([]);
	});

	test('the deny list comes from docs/docs.private.json, outside the publishable root', () => {
		// Inside `docs/site/` it would be copied into the public mirror by
		// `sync-public.sh`: the list of strings that must never ship, shipped.
		expect(loaded.denyList?.private).toBe(1);
		expect(loaded.denyList?.strings.length).toBeGreaterThan(0);
		expect(loaded.siteRoot).toBe(join(APP_ROOT, 'docs', 'site'));
		expect(loaded.appRoot).toBe(APP_ROOT);
	});

	test('a document knows its own path twice over, once for git and once for a finding', () => {
		// `file` is relative to `docs/site/` because that is what a finding and the manifest
		// both carry; `repoPath` is relative to the repository root because that is the only
		// thing git answers about. One of the two is always wrong for the other caller.
		const document = loaded.pages.get('guide/first-tag')?.get('en');
		expect(document?.file).toBe('content/en/guide/first-tag.md');
		expect(document?.id).toBe('guide/first-tag');
		expect(document?.locale).toBe('en');
		expect(document?.repoPath.endsWith('content/en/guide/first-tag.md')).toBe(true);
		expect(document?.text.startsWith('---\n')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// There is no project to compile
// ---------------------------------------------------------------------------

describe('the states that are thrown rather than reported', () => {
	test('a missing docs.json names the file and says how to get one back', () => {
		// Thrown, because every finding downstream would be a consequence of this one and a
		// report of four hundred of them buries the sentence that matters.
		const error = thrownBy(writeTree({ config: null }));
		expect(error.name).toBe('ProjectError');
		expect(error.finding.message).toBe('docs.json is missing.');
		expect(error.finding.location).toEqual({ kind: 'file', file: 'docs.json' });
		expect(error.finding.remediation).toContain('hexdocs init');
		expect(error.message).toBe(error.finding.message);
	});

	test('a missing nav.json is the same refusal about the other file', () => {
		const error = thrownBy(writeTree({ nav: null }));
		expect(error.finding.message).toBe('nav.json is missing.');
		expect(error.finding.location).toEqual({ kind: 'file', file: 'nav.json' });
	});

	test('a docs.json that is not JSON carries the parser message', () => {
		// The position the JSON parser gives is the only thing anybody can act on, so it is
		// passed through rather than replaced with "invalid".
		const root = writeTree({});
		writeFileSync(join(root, 'docs/site/docs.json'), '{ "docs": 1,\n', 'utf8');
		const error = thrownBy(root);
		expect(error.finding.message).toContain('docs.json is not valid JSON:');
		expect(error.finding.message).toContain('position');
		expect(error.finding.location).toEqual({ kind: 'file', file: 'docs.json' });
	});

	test('a docs.json that does not validate points at the field', () => {
		// A pointer rather than a line, because the file is JSON and a line number in a
		// file somebody reformats is a location that stops being true.
		const config = baseConfig();
		(config.i18n as { parity: string }).parity = 'strict';
		const error = thrownBy(writeTree({ config }));
		expect(error.finding.location).toEqual({
			kind: 'pointer',
			file: 'docs.json',
			pointer: '/i18n/parity',
		});
		expect(error.finding.remediation).toContain('/i18n/parity');
	});

	test('a pointer names an array index, so a bad entry is findable in a long list', () => {
		const config = baseConfig();
		(config.sections as { id: string; kind: string }[])[1] = { id: 'guide', kind: 'invented' };
		const error = thrownBy(writeTree({ config }));
		expect(error.finding.location).toEqual({
			kind: 'pointer',
			file: 'docs.json',
			pointer: '/sections/1/kind',
		});
	});

	test('a nav.json that does not validate points at the field, in nav.json', () => {
		const nav = baseNav();
		nav.items = [{ doc: 'index', hidden: 'too few' }];
		const error = thrownBy(writeTree({ nav }));
		expect(error.finding.location).toEqual({
			kind: 'pointer',
			file: 'nav.json',
			pointer: '/items/0/hidden',
		});
		expect(error.finding.message).toContain('8 characters');
	});
});

// ---------------------------------------------------------------------------
// A tree that loads
// ---------------------------------------------------------------------------

describe('a tree with nothing wrong with it', () => {
	const root = writeTree({
		files: {
			'docs/site/content/en/index.md': page('Home'),
			'docs/site/content/en/guide/setup.md': page('Setup'),
			'docs/site/content/fr/index.md': page('Accueil'),
			'docs/site/snippets/en/note.md': 'A snippet.\n',
			'docs/site/assets/logo.svg': '<svg></svg>\n',
		},
		privateJson: JSON.stringify({ private: 1, strings: ['Contoso Tap'], patterns: [] }),
	});
	const loaded = loadProject(root);

	test('the counts are what was written and nothing is reported', () => {
		expect(loaded.findings).toEqual([]);
		expect([...loaded.pages.keys()].sort()).toEqual(['guide/setup', 'index']);
		expect([...(loaded.pages.get('index')?.keys() ?? [])].sort()).toEqual(['en', 'fr']);
		expect([...loaded.snippets.keys()]).toEqual(['note']);
		expect([...loaded.assets.keys()]).toEqual(['assets/logo.svg']);
		expect(loaded.examined).toBe(5);
	});

	test('an asset is carried as bytes, because the probe reads a header not a string', () => {
		// Read as UTF-8 a PNG loses every invalid sequence to one replacement character and
		// two different images compare equal, which is the failure the byte check in the
		// corpus materialiser exists to catch from the other side.
		expect(loaded.assets.get('assets/logo.svg')?.bytes.toString('utf8')).toBe('<svg></svg>\n');
		expect(loaded.assets.get('assets/logo.svg')?.file).toBe('assets/logo.svg');
	});

	test('a tree outside a repository loads, with no repository and no prefix', () => {
		// The throwaway directory is under `os.tmpdir()` and is not in a git repository.
		// `build.ts` is what refuses to key a bundle by nothing, in one sentence naming the
		// directory, and it can only do that if the loader hands it `undefined` rather than
		// throwing on the first git call.
		expect(loaded.repository).toBeUndefined();
		expect(loaded.pages.get('index')?.get('en')?.repoPath).toBe('content/en/index.md');
	});

	test('a tree with no content examines nothing, and says so', () => {
		const empty = loadProject(writeTree({}));
		expect(empty.examined).toBe(0);
		expect(empty.pages.size).toBe(0);
		expect(empty.findings).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The deny list
// ---------------------------------------------------------------------------

describe('the one file read from outside the publishable root', () => {
	test('an absent deny list leaves null rather than throwing', () => {
		// Absence is not a pass. A deny scan that examined nothing has cleared nothing, and
		// `null` rather than an empty list is what lets whoever runs the scan say so.
		const loaded = loadProject(writeTree({}));
		expect(loaded.denyList).toBeNull();
	});

	test('the list one level up is the one read, and a copy inside docs/site is not', () => {
		// The whole reason it lives one level up. Inside the publishable root it is copied
		// into the public mirror by `sync-public.sh`, which is the list of strings that must
		// never ship, shipped. Two different lists, so a loader reading the wrong file gets a
		// different answer rather than the same one by luck.
		const loaded = loadProject(
			writeTree({
				privateJson: JSON.stringify({ private: 1, strings: ['One level up'], patterns: [] }),
				files: {
					'docs/site/docs.private.json': JSON.stringify({
						private: 1,
						strings: ['Inside the publishable root'],
						patterns: [],
					}),
				},
			}),
		);
		expect(loaded.denyList?.strings).toEqual(['One level up']);
		expect(only(loaded, 'docs.private.json').message).toContain('is not part of a documentation');
	});

	test('a deny list that does not validate is a finding, not a throw', () => {
		// Unlike the two configs, a bad deny list still leaves a project to compile. It
		// leaves `null`, so the run reports both the schema failure and, downstream, that
		// nothing was scanned.
		const loaded = loadProject(writeTree({ privateJson: '{"private":1,"strings":[""]}' }));
		expect(loaded.denyList).toBeNull();
		const reported = about(loaded, 'docs.private.json');
		expect(reported.map((finding) => finding.location)).toContainEqual({
			kind: 'pointer',
			file: 'docs.private.json',
			pointer: '/strings/0',
		});
		expect(reported.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// What the walk refuses
// ---------------------------------------------------------------------------

describe('what cannot be under docs/site', () => {
	test('a symlink is refused rather than followed, and the refusal says why it matters', () => {
		// The whole of the protection. A symlink is the only thing git can carry into a
		// checkout that points outside the tree, so following one is how a page escapes the
		// publishable root.
		const loaded = loadProject(
			writeTree({
				files: { 'docs/site/content/en/index.md': page('Home') },
				symlinks: { 'docs/site/content/en/alias.md': 'docs/site/content/en/index.md' },
			}),
		);
		const finding = only(loaded, 'content/en/alias.md');
		// `source-layout`, not `unsupported-syntax`. The latter is declared as a source
		// spelling this AST major cannot represent, and its protected status is justified by
		// a construct being dropped from a page. Nothing is dropped here: the file is simply
		// not copied, and an operator sent to `hexdocs explain unsupported-syntax` got
		// examples about math delimiters and directive names.
		expect(finding.rule).toBe('source-layout');
		expect(finding.message).toBe('A symbolic link inside the publishable root.');
		expect(finding.remediation).toContain('outside itself');
		expect(loaded.pages.get('alias')).toBeUndefined();
		expect(loaded.examined).toBe(1);
	});

	test('every forbidden agent file is refused, and the message says where it belongs', () => {
		// Derived from `FORBIDDEN_SOURCE_NAMES`, because the list is what `sync-public.sh`
		// prunes. A name added there and not here would be refused by a release script with
		// an error about a file nobody put in the tree on purpose.
		const files: Record<string, string> = { 'docs/site/content/en/index.md': page('Home') };
		for (const name of FORBIDDEN_SOURCE_NAMES) {
			// Two of the four are directories. Naming a file inside each is what proves the
			// walk refuses the entry rather than descending into it.
			files[`docs/site/${name}${name.startsWith('.') ? '/settings.json' : ''}`] = name.startsWith(
				'.',
			)
				? '{}\n'
				: '# Authoring guide\n';
		}
		const loaded = loadProject(writeTree({ files }));

		for (const name of FORBIDDEN_SOURCE_NAMES) {
			const finding = only(loaded, name);
			expect(finding.rule).toBe('wiring-forbidden-agent-files');
			expect(finding.message).toBe(`"${name}" cannot live under docs/site/.`);
			expect(finding.remediation).toContain('docs/, one level up');
		}
		expect(loaded.findings.length).toBe(FORBIDDEN_SOURCE_NAMES.length);
		expect(FORBIDDEN_SOURCE_NAMES.length).toBe(4);
		// Nothing inside the two refused directories was read.
		expect(loaded.examined).toBe(1);
	});

	test('a directory that is neither content, snippets nor assets is refused by name', () => {
		const loaded = loadProject(
			writeTree({ files: { 'docs/site/extras/handover.md': page('Handover') } }),
		);
		const finding = only(loaded, 'extras/handover.md');
		// `source-layout`, not `unsupported-syntax`. The latter is declared as a source
		// spelling this AST major cannot represent, and its protected status is justified by
		// a construct being dropped from a page. Nothing is dropped here: the file is simply
		// not copied, and an operator sent to `hexdocs explain unsupported-syntax` got
		// examples about math delimiters and directive names.
		expect(finding.rule).toBe('source-layout');
		expect(finding.message).toBe('"extras/" is not part of a documentation tree.');
		expect(finding.remediation).toContain('no route to it');
	});

	test('a markdown file with no locale directory above it is refused', () => {
		// The locale comes from the directory and from nothing else, so a file directly
		// under `content/` has no language at all.
		const loaded = loadProject(
			writeTree({ files: { 'docs/site/content/loose.md': page('Loose') } }),
		);
		const finding = only(loaded, 'content/loose.md');
		expect(finding.message).toBe('content/loose.md is not inside a locale directory.');
		expect(finding.locale).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Locale directories
// ---------------------------------------------------------------------------

describe('the locale a directory names', () => {
	test('a locale the project does not declare is refused, and the message lists the ones it does', () => {
		// Silently dropping the directory publishes a bundle that is quietly missing a
		// language somebody believed they had shipped.
		const config = baseConfig();
		const kept = declaredLocales(config).filter((locale) => locale !== 'fr');
		(config.i18n as { locales: string[] }).locales = kept;
		const loaded = loadProject(
			writeTree({
				config,
				files: {
					'docs/site/content/en/index.md': page('Home'),
					'docs/site/content/fr/index.md': page('Accueil'),
				},
			}),
		);
		const finding = only(loaded, 'content/fr/index.md');
		expect(finding.rule).toBe('translation-missing');
		expect(finding.locale).toBe('fr');
		expect(finding.message).toBe(`"fr" is not in this project's i18n.locales.`);
		expect(finding.remediation).toContain(kept.join(', '));
		expect(loaded.pages.get('index')?.has('fr')).toBe(false);
		expect(loaded.pages.get('index')?.has('en')).toBe(true);
	});

	test('a non-canonical spelling is reported and the file is still loaded under the locale', () => {
		// Both halves matter. Two spellings of one language produce two directories that
		// compile into each other, and refusing the file outright would drop a translation
		// over a directory name.
		const loaded = loadProject(
			writeTree({
				files: {
					'docs/site/content/en/index.md': page('Home'),
					'docs/site/content/pt_BR/index.md': page('Inicio'),
					'docs/site/content/zh-Hans/index.md': page('Home'),
				},
			}),
		);
		expect(only(loaded, 'content/pt_BR/index.md').message).toBe(
			'"pt_BR" is a spelling of "pt-BR" rather than the spelling this package uses.',
		);
		expect(only(loaded, 'content/zh-Hans/index.md').message).toBe(
			'"zh-Hans" is a spelling of "zh" rather than the spelling this package uses.',
		);
		expect(only(loaded, 'content/pt_BR/index.md').remediation).toContain('Rename the directory');
		expect([...(loaded.pages.get('index')?.keys() ?? [])].sort()).toEqual(['en', 'pt-BR', 'zh']);
	});

	test('a directory that is not a language at all is refused with the matcher message', () => {
		const loaded = loadProject(
			writeTree({ files: { 'docs/site/content/hi/index.md': page('Home') } }),
		);
		const finding = only(loaded, 'content/hi/index.md');
		expect(finding.message).toContain('Hindi is not a published web language');
		expect(finding.remediation).toBe('Rename or remove content/hi/.');
		expect(loaded.pages.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Ids and slugs
// ---------------------------------------------------------------------------

describe('what a file is allowed to be called', () => {
	test('a snippet in a subdirectory is refused, because an id is one segment', () => {
		// A snippet id is only ever a filename and a key. `::include[legend]` has nowhere to
		// put a path, so a nested snippet is a file that can never be transcluded.
		const loaded = loadProject(
			writeTree({ files: { 'docs/site/snippets/en/legal/warning.md': 'Careful.\n' } }),
		);
		const finding = only(loaded, 'snippets/en/legal/warning.md');
		expect(finding.rule).toBe('snippet-resolves');
		expect(finding.locale).toBe('en');
		expect(finding.message).toBe('"legal/warning" is not a snippet id.');
		expect(finding.remediation).toContain('one slug segment');
		expect(loaded.snippets.size).toBe(0);
	});

	test('a reserved slug root is refused, and the message names the segment', () => {
		// Each of these already has a route under a docs mount, and React Router breaks a
		// ranking tie on declaration order. The page would resolve to whichever was declared
		// first, deterministically and invisibly.
		const loaded = loadProject(
			writeTree({
				files: {
					'docs/site/content/en/search.md': page('Search'),
					'docs/site/content/en/llms.md': page('Models'),
					'docs/site/content/en/v/pinned.md': page('Pinned'),
					'docs/site/content/en/index.md': page('Home'),
				},
			}),
		);
		for (const [file, segment] of [
			['content/en/search.md', 'search'],
			['content/en/llms.md', 'llms'],
			['content/en/v/pinned.md', 'v'],
		] as const) {
			const finding = only(loaded, file);
			expect(finding.rule).toBe('slug-reserved');
			expect(finding.locale).toBe('en');
			expect(finding.message).toContain(`"${segment}" is a reserved route under a docs mount.`);
			expect(finding.remediation).toContain('Rename the file');
		}
		expect([...loaded.pages.keys()]).toEqual(['index']);
		expect(loaded.examined).toBe(4);
	});

	test('a file under content that is not markdown is refused', () => {
		const loaded = loadProject(
			writeTree({ files: { 'docs/site/content/en/diagram.png': 'not really a png\n' } }),
		);
		const finding = only(loaded, 'content/en/diagram.png');
		expect(finding.message).toBe('content/en/diagram.png is not a markdown file.');
		expect(finding.remediation).toContain('assets/');
	});
});

// ---------------------------------------------------------------------------
// What git knows about the tree
// ---------------------------------------------------------------------------

/**
 * `git log -1` for one path, normalised without going through `toUtcTimestamp`.
 *
 * Deliberately a second implementation of the normalisation. Reusing the module's own
 * would make the comparison circular: a `toUtcTimestamp` that dropped the timezone
 * entirely would agree with itself on both sides and the sweep would stay green.
 */
function committerDateFromGit(root: string, path: string): string {
	const printed = execFileSync('git', ['log', '-1', '--format=%cI', '--', path], {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
	if (printed === '') throw new Error(`git knows nothing about ${path}`);
	return new Date(printed).toISOString().replace('.000Z', 'Z');
}

function run(root: string, args: string[]): void {
	execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The corpus with its declared history replayed over it.
 *
 * Built once, at module level, because two describes read it and materialising it twice
 * would be two `git init`s and eight commits for one question.
 */
const corpus = materialiseCorpus(join(scratch(), 'repo'));

describe('the history, read in one walk', () => {
	const files = appFiles();
	const last = corpus.commits[corpus.commits.length - 1];
	const state = readRepository(join(corpus.root, 'docs', 'site'));
	if (state === undefined) throw new Error('the materialised corpus is not a repository');

	test('the root is found from inside docs/site, and the head is the last commit', () => {
		expect(state.root).toBe(corpus.root);
		expect(findRepositoryRoot(join(corpus.root, 'docs', 'site', 'content', 'en'))).toBe(
			corpus.root,
		);
		expect(state.head).toBe(last?.sha);
		expect(state.head).toMatch(/^[0-9a-f]{40}$/);
		expect(state.headTimestamp).toBe(last?.at);
		expect(corpus.commits.length).toBe(FIXTURE_HISTORY.length);
	});

	test('a full clone is not shallow, which is what makes any of the dates mean anything', () => {
		expect(state.shallow).toBe(false);
	});

	test('the one walk gives the same date git log -1 gives, for every path in the tree', () => {
		// This equivalence is the whole justification for the single walk, and the cost of
		// running it is the argument as well. Measured here: 57 `git log -1` calls take
		// about eleven seconds, three calls for the whole walk take about four hundred
		// milliseconds, and both produce the same 57 dates. A fourteen hundred file
		// project would spawn fourteen hundred processes on a runner. The raised timeout
		// is that measurement rather than a flaky test.
		const disagreed: string[] = [];
		let compared = 0;
		for (const path of files) {
			compared += 1;
			const walked = state.dates.get(path);
			const asked = committerDateFromGit(corpus.root, path);
			if (walked !== asked) disagreed.push(`${path}: walked ${String(walked)}, asked ${asked}`);
		}
		expect(disagreed).toEqual([]);
		expect(compared).toBe(files.length);
		expect(compared).toBe(57);
	}, 60_000);

	test('the equivalence holds across a merge, which linear history cannot show', () => {
		// The test above compares 57 paths against `git log -1` over a history of four
		// strictly linear commits, so it can never exercise the one commit shape the walk
		// gets wrong. `git log --name-only` prints no file names for a merge, so a file
		// whose most recent change was the merge's own conflict resolution was attributed
		// to whichever older commit last named it: measured at four months early on a
		// source page, which makes six stale translations read `current`.
		//
		// Two shapes, because the two candidate fixes each get one of them wrong.
		// `--first-parent` matches on the conflict resolution and over-reports the
		// side-branch-only file to the merge date, which turns a stale translation into a
		// current one. Only the combined diff matches git on both.
		const root = mkdtempSync(join(tmpdir(), 'hexdocs-merge-'));
		try {
			const run = (args: string[], at?: string): void => {
				execFileSync('git', args, {
					cwd: root,
					stdio: 'ignore',
					env: {
						...process.env,
						GIT_AUTHOR_NAME: 'Fixture',
						GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
						GIT_COMMITTER_NAME: 'Fixture',
						GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
						...(at === undefined ? {} : { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }),
					},
				});
			};
			const put = (name: string, text: string): void => writeFileSync(join(root, name), text);

			run(['init', '-q', '--initial-branch=main', '.']);
			put('resolved.md', 'one\n');
			run(['add', '-A']);
			run(['commit', '-m', 'base'], '2026-01-01T00:00:00Z');

			run(['checkout', '-q', '-b', 'side']);
			put('resolved.md', 'side\n');
			put('side-only.md', 'only on the branch\n');
			run(['add', '-A']);
			run(['commit', '-m', 'side'], '2026-01-20T00:00:00Z');

			run(['checkout', '-q', 'main']);
			put('resolved.md', 'main\n');
			run(['add', '-A']);
			run(['commit', '-m', 'main'], '2026-02-05T00:00:00Z');

			// Conflicts on purpose, so the merge itself carries a change to `resolved.md`
			// that is in neither parent. That is the commit shape the plain walk cannot see.
			try {
				run(['merge', 'side', '--no-commit', '--no-ff']);
			} catch {
				// A conflicting merge exits non-zero and leaves the tree to resolve, which is
				// the state this test wants.
			}
			put('resolved.md', 'resolved in the merge\n');
			run(['add', '-A']);
			run(['commit', '-m', 'merge'], '2026-06-01T00:00:00Z');

			const merged = readRepository(root);
			expect(merged).toBeDefined();
			const disagreed: string[] = [];
			let compared = 0;
			for (const path of ['resolved.md', 'side-only.md']) {
				compared += 1;
				const walked = merged?.dates.get(path);
				const asked = committerDateFromGit(root, path);
				if (walked !== asked) disagreed.push(`${path}: walked ${String(walked)}, asked ${asked}`);
			}
			expect(disagreed).toEqual([]);
			expect(compared).toBe(2);

			// Named, so the failure says which case broke rather than only that they differ.
			expect(merged?.dates.get('resolved.md')).toBe('2026-06-01T00:00:00Z');
			expect(merged?.dates.get('side-only.md')).toBe('2026-01-20T00:00:00Z');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('the walk knows about the tree and about nothing else', () => {
		// A path in the map that is not in the tree would be a deleted file still carrying a
		// date, and a file in the tree with no entry would read as having no history at all.
		expect([...state.dates.keys()].sort()).toEqual([...files].sort());
	});

	test('each date is the last commit the corpus declares for that path', () => {
		// Derived from `FIXTURE_HISTORY` rather than from git, so this fails when the
		// materialised history stops producing the states `corpus.ts` says it produces.
		// Without it, git and the walk could agree on an answer neither of them should give.
		const wrong: string[] = [];
		for (const path of files) {
			const declared = [...FIXTURE_HISTORY].reverse().find((commit) => commit.touches(path));
			if (declared === undefined) {
				wrong.push(`${path} is touched by no declared commit`);
				continue;
			}
			if (state.dates.get(path) !== declared.at) {
				wrong.push(`${path}: ${String(state.dates.get(path))} against ${declared.at}`);
			}
		}
		expect(wrong).toEqual([]);
		expect(new Set(state.dates.values()).size).toBe(FIXTURE_HISTORY.length);
	});

	test('the English page revised last is newer than its translations, which is the fixture', () => {
		// The one relation everything downstream of staleness rests on. A corpus committed
		// in one go has this the other way round and reads `current` everywhere.
		const source = state.dates.get('docs/site/content/en/guide/first-tag.md') as string;
		const translated = state.dates.get('docs/site/content/ar/guide/first-tag.md') as string;
		expect(source > translated).toBe(true);
	});

	test('the loader hands git a path git answers about', () => {
		// `repoPath` is `file` with the prefix from the repository root, and the two only
		// agree when the prefix is right. Get it wrong and every lookup misses, every page
		// has no date, and the whole corpus reads `current`: the shallow clone failure
		// again, by another route, with nothing to show for it.
		const loaded = loadProject(corpus.root);
		const documents = [...loaded.pages.values(), ...loaded.snippets.values()].flatMap(
			(byLocale) => [...byLocale.values()],
		);
		const undated = documents.filter(
			(document) => loaded.repository?.dates.get(document.repoPath) === undefined,
		);
		expect(undated.map((document) => document.repoPath)).toEqual([]);
		expect(documents.length).toBe(51);
		expect(documents[0]?.repoPath.startsWith('docs/site/')).toBe(true);
		for (const asset of loaded.assets.values()) {
			expect(loaded.repository?.dates.get(asset.repoPath)).toBeDefined();
		}
		expect(loaded.assets.size).toBe(FIXTURE_ASSETS.length);
	});
});

describe('the states in which there is no usable history', () => {
	test('a shallow clone is reported, and carries one date for the whole tree', () => {
		// The reason the flag exists. `actions/checkout` defaults to `fetch-depth: 1`, and
		// in a shallow clone every path carries the grafted commit's date, so nothing is
		// ever newer than anything and every translation reads current. That is the wrong
		// answer that looks fine, and only the flag can tell it from the right one.
		const holder = scratch();
		const clone = join(holder, 'clone');
		run(holder, ['clone', '--quiet', '--depth', '1', `file://${corpus.root}`, clone]);
		const shallow = readRepository(clone);
		if (shallow === undefined) throw new Error('the clone is not a repository');

		expect(shallow.shallow).toBe(true);
		expect(shallow.dates.size).toBe(appFiles().length);
		expect(new Set(shallow.dates.values()).size).toBe(1);
		expect([...new Set(shallow.dates.values())]).toEqual([shallow.headTimestamp]);
	});

	test('a repository with no commits is reported as no repository', () => {
		// `git init` then `hexdocs init` before anything is committed is a state a real app
		// repository passes through. The `.git` directory is there, so the root is found,
		// and `rev-parse HEAD` exits 128. Reported as no repository, because no path has a
		// date and no page can be compared against its source.
		const root = writeTree({ files: { 'docs/site/content/en/index.md': page('Home') } });
		run(root, ['init', '--quiet', '-b', 'main']);
		expect(findRepositoryRoot(join(root, 'docs', 'site'))).toBe(root);
		expect(readRepository(root)).toBeUndefined();

		const loaded = loadProject(root);
		expect(loaded.repository).toBeUndefined();
		expect(loaded.findings).toEqual([]);
		expect(loaded.pages.size).toBe(1);
	});

	test('a directory in no repository at all has no root', () => {
		expect(findRepositoryRoot(scratch())).toBeUndefined();
	});
});

describe('the timestamp every date passes through', () => {
	test('a local offset is normalised to UTC, to the second', () => {
		// `%cI` prints the committer's own offset. Two clones of one commit on machines in
		// two timezones would otherwise produce two different manifests, and the digest is
		// taken over the bytes.
		expect(toUtcTimestamp('2026-03-15T18:15:00+10:00')).toBe('2026-03-15T08:15:00Z');
		expect(toUtcTimestamp('2026-03-14T22:15:00-10:00')).toBe('2026-03-15T08:15:00Z');
		expect(toUtcTimestamp('2026-03-15T08:15:00Z')).toBe('2026-03-15T08:15:00Z');
	});

	test('milliseconds are removed rather than rounded', () => {
		// The manifest compares these as strings, so one spelling carrying `.000` would be
		// unequal to the same instant without it.
		expect(toUtcTimestamp('2026-03-15T08:15:00.750Z')).toBe('2026-03-15T08:15:00Z');
	});
});
