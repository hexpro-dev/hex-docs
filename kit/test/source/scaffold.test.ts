/**
 * Row 6: a scaffolder that claims a translation it did not perform.
 *
 * The shape of this file is the point. **Nothing here reads the scaffolded string.** The
 * design this replaces copied the English body into six locale files and stamped a digest
 * equal to the source's, which marked six locales of English as fully translated,
 * permanently and invisibly. A test that asserted the template contains the characters
 * `translated: false` would have passed against that design too, because the failure was
 * never about what the string says. It was about what the compiler makes of it.
 *
 * So every case here writes the scaffolder's own output into a materialised corpus, runs
 * the real `buildBundle`, and asserts on `manifest.pages[slug].locales[locale].state`. The
 * corpus is materialised rather than read in place because translation state is a
 * comparison of committer dates, and a tree committed in one go has none.
 *
 * The two mechanisms are then separated, because the claim is that either alone is enough
 * and a test that only ran the scaffolder's real output could not tell which one did the
 * work:
 *
 *   * A: the scaffolder's output as written. `scaffolded`.
 *   * B: the same file with its `translated: false` line taken out, committed after the
 *     source. `current`. This is the catalogue's own mutation, applied to the file rather
 *     than to the template, and it proves that in case A the flag was doing the work: if
 *     the body had been the source's bytes the state would have stayed `scaffolded`.
 *   * C: the English file copied byte for byte into the translation's path, with no
 *     `translated` key anywhere in it. `scaffolded` again, from the second detector alone.
 *
 * `guide/troubleshooting` is the page, because the corpus carries it in `en`, `ja` and
 * `ar` and in no other locale. `fr` is therefore a locale where a stub is a real scaffold
 * rather than an overwrite, and `ja` is the locale that proves the command will not
 * overwrite.
 */

import { execFileSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus } from '../../../fixtures/index.js';
import type { TranslationState } from '../../../src/contracts/frontmatter.js';
import { SITE_ROOT_RELATIVE } from '../../../src/contracts/project.js';
import { buildBundle } from '../../src/compile/build.js';
import { scaffold } from '../../src/commands/scaffold.js';
import { NO_EXEC } from '../../src/exec/run.js';
import { invoke, type Ctx } from '../../src/registry/command.js';

const KIT_VERSION = '@hex-pro/docs-kit@0.0.1';
const SLUG = 'guide/troubleshooting';

/** Later than every date `FIXTURE_HISTORY` sets, so a date comparison has a real answer. */
const COMMITTED_AT = '2026-07-01T12:00:00Z';

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

let scratch: string;
let template: string;
let copies = 0;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'hexdocs-scaffold-'));
	template = materialiseCorpus(join(scratch, 'template')).root;
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

/** A throwaway copy of the materialised corpus, history and all. */
function corpus(): string {
	copies += 1;
	const target = join(scratch, `copy-${copies}`);
	cpSync(template, target, { recursive: true, dereference: false, verbatimSymlinks: true });
	return target;
}

function context(cwd: string): Ctx {
	return {
		cwd,
		kitVersion: KIT_VERSION,
		exec: NO_EXEC,
		write: null,
		now: () => new Date('2026-06-01T00:00:00Z'),
		log: () => undefined,
	};
}

async function runScaffold(root: string, args: Record<string, unknown>): Promise<ScaffoldData> {
	const output = await invoke(scaffold, { root, ...args }, context(root));
	return output.data as unknown as ScaffoldData;
}

function contentPath(locale: string): string {
	return `${SITE_ROOT_RELATIVE}/content/${locale}/${SLUG}.md`;
}

function put(repo: string, relative: string, contents: string): void {
	const path = join(repo, ...relative.split('/'));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, 'utf8');
}

function commit(repo: string, at: string): void {
	execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['commit', '--quiet', '-m', 'scaffold a translation', '--no-verify'], {
		cwd: repo,
		stdio: 'ignore',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'Fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
			GIT_AUTHOR_DATE: at,
			GIT_COMMITTER_DATE: at,
		},
	});
}

/** The state the compiler gives one page in one locale, through the real build. */
function stateOf(repo: string, locale: string): TranslationState | undefined {
	const result = buildBundle(repo, { generator: KIT_VERSION });
	return result.manifest.pages[SLUG]?.locales[locale as 'fr']?.state;
}

/** The scaffolder's own French stub for the page, as it would be applied. */
async function frenchStub(repo: string): Promise<string> {
	const data = await runScaffold(repo, { kind: 'page', slug: SLUG, locale: ['fr'] });
	const file = data.files.find((entry) => entry.path === contentPath('fr'));
	expect(file).toBeDefined();
	expect(file?.action).toBe('create');
	if (file === undefined) throw new Error('scaffold returned no French file');
	return file.contents;
}

// ---------------------------------------------------------------------------
// the state the compiler gives it
// ---------------------------------------------------------------------------

describe('a scaffolded translation, through the real compiler', () => {
	test('A: the file the scaffolder returns compiles as scaffolded', async () => {
		const repo = corpus();
		put(repo, contentPath('fr'), await frenchStub(repo));
		commit(repo, COMMITTED_AT);

		expect(stateOf(repo, 'fr')).toBe('scaffolded');
		// And the states around it are unchanged, so the assertion above is about this file
		// rather than about a build that broke.
		expect(stateOf(repo, 'en')).toBe('source');
		expect(stateOf(repo, 'ja')).toBe('current');
	});

	test('B: with the flag taken out it is current, which is what makes A the flag', async () => {
		const repo = corpus();
		const stub = await frenchStub(repo);

		// The catalogue's mutation, applied to the file. Asserting that exactly one line
		// matched is what stops this from being a no-op: a template that stopped writing the
		// flag would otherwise make this case identical to case A and it would still pass.
		const lines = stub.split('\n');
		const withoutFlag = lines.filter((line) => !/^translated:\s*false\s*$/.test(line));
		expect(lines.length - withoutFlag.length).toBe(1);

		put(repo, contentPath('fr'), withoutFlag.join('\n'));
		// Committed after the English page, so the date comparison has a real answer and the
		// state is not `current` because the git walk had no date for the file.
		commit(repo, COMMITTED_AT);

		expect(stateOf(repo, 'fr')).toBe('current');
		// Which is the whole argument: the body the scaffolder writes is not the source's
		// bytes, so the second detector cannot have been what produced A.
		expect(stateOf(repo, 'fr')).not.toBe('scaffolded');
	});

	test('C: the source body with no flag at all is still scaffolded', async () => {
		const repo = corpus();
		const english = readFileSync(join(repo, ...contentPath('en').split('/')), 'utf8');
		// The failure this detector exists for: somebody deletes the flag and pastes the
		// English in. Nothing in the file says it is untranslated, and the timestamps cannot
		// see it either, because a copy is committed after the page it copies.
		expect(english).not.toMatch(/^translated:/m);
		put(repo, contentPath('fr'), english);
		commit(repo, COMMITTED_AT);

		expect(stateOf(repo, 'fr')).toBe('scaffolded');
	});

	test('the two mechanisms are independent, which is the claim being made', async () => {
		// Stated as one assertion over the three cases, so a reading of the file that took A
		// and C to be the same test fails here. A has the flag and a body that is not the
		// source's; C has the source's body and no flag; B has neither and is the only one
		// that is not scaffolded.
		const outcomes = new Map<string, TranslationState | undefined>();

		const withFlag = corpus();
		put(withFlag, contentPath('fr'), await frenchStub(withFlag));
		commit(withFlag, COMMITTED_AT);
		outcomes.set('flag only', stateOf(withFlag, 'fr'));

		const bodyOnly = corpus();
		put(
			bodyOnly,
			contentPath('fr'),
			readFileSync(join(bodyOnly, ...contentPath('en').split('/')), 'utf8'),
		);
		commit(bodyOnly, COMMITTED_AT);
		outcomes.set('body only', stateOf(bodyOnly, 'fr'));

		expect([...outcomes.entries()]).toEqual([
			['flag only', 'scaffolded'],
			['body only', 'scaffolded'],
		]);
	});

	test('a scaffolded locale is counted as neither translated nor stale', async () => {
		const repo = corpus();
		put(repo, contentPath('fr'), await frenchStub(repo));
		commit(repo, COMMITTED_AT);

		const before = buildBundle(template, { generator: KIT_VERSION }).manifest.coverage.fr;
		const after = buildBundle(repo, { generator: KIT_VERSION }).manifest.coverage.fr;
		expect(after?.pages).toBe((before?.pages ?? 0) + 1);
		expect(after?.scaffolded).toBe((before?.scaffolded ?? 0) + 1);
		// The page it was scaffolded from is not counted as covered by it.
		expect(after?.translated).toBe(before?.translated);
		expect(after?.stale).toBe(before?.stale);
	});
});

// ---------------------------------------------------------------------------
// what the command will not do
// ---------------------------------------------------------------------------

describe('scaffold page never overwrites', () => {
	test('drops a locale that already has a file, and says which in a note', async () => {
		const repo = corpus();
		// `ja` is on disk, `fr` is not, so one call covers both directions.
		expect(existsSync(join(repo, ...contentPath('ja').split('/')))).toBe(true);
		expect(existsSync(join(repo, ...contentPath('fr').split('/')))).toBe(false);

		const data = await runScaffold(repo, { kind: 'page', slug: SLUG, locale: ['ja', 'fr'] });
		const paths = data.files.map((file) => file.path);
		expect(paths).toContain(contentPath('fr'));
		expect(paths).not.toContain(contentPath('ja'));

		// Not silently. A dropped file that produced no note would look exactly like a
		// locale nobody asked for.
		const note = data.notes.find((line) => line.startsWith(contentPath('ja')));
		expect(note).toBeDefined();
		expect(note).toContain('already exists');
		expect(note).toContain('never');
	});

	test('the source locale is dropped too, so the rule is not special to a translation', async () => {
		const repo = corpus();
		const data = await runScaffold(repo, { kind: 'page', slug: SLUG, locale: ['en'] });
		expect(data.files).toEqual([]);
		expect(data.notes.some((line) => line.startsWith(contentPath('en')))).toBe(true);
	});

	test('and the file on disk is untouched, because this command holds no writer', async () => {
		const repo = corpus();
		const path = join(repo, ...contentPath('ja').split('/'));
		const before = readFileSync(path);
		await runScaffold(repo, { kind: 'page', slug: SLUG, locale: ['ja', 'fr'] });
		expect(readFileSync(path)).toEqual(before);
		expect(existsSync(join(repo, ...contentPath('fr').split('/')))).toBe(false);
	});

	test('a translation of a page that does not exist is refused with a reason', async () => {
		const repo = corpus();
		const data = await runScaffold(repo, {
			kind: 'page',
			slug: 'guide/nothing-here',
			locale: ['en', 'fr'],
		});
		// The source file is offered, because that is the page somebody is starting. The
		// translation is not, because a stub built from nothing is a translation of nothing.
		expect(data.files.map((file) => file.path)).toEqual([
			`${SITE_ROOT_RELATIVE}/content/en/guide/nothing-here.md`,
		]);
		expect(data.notes.join(' ')).toContain('translation of nothing');
	});
});
