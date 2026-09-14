/**
 * `hexdocs sync`, and row 12 of the failure catalogue: a spurious diff every run.
 *
 * The failure this closes is quiet. `pages` is written from a manifest, and both the nav
 * order and the manifest's own key order are valid orderings of the same set, so a command
 * that picked either one arbitrarily would produce a file that changed on every run, in a
 * repository where the file is committed and read by `root.tsx` at build time. Nobody
 * would call that a bug; they would call it "sync touched the config again".
 *
 * So the assertions here are about bytes rather than about values.
 *
 *   * Two runs produce a **byte-identical** file, trailing newline included.
 *   * `pages` comes out in `manifest.llmsOrder`, and the test first proves that order and
 *     code point order actually differ for this corpus. Without that the assertion would
 *     pass against a sort, which is exactly the mutation it exists to catch.
 *   * Every byte outside `pages`, `hidden` and `versions[].digest` is unchanged, compared
 *     against a hand-authored expectation built by applying the two edits that are allowed
 *     and nothing else. `$schema`, `themeClass`, `navLabel` and the key order all survive,
 *     which is what "a surgical edit, not a reserialise" means.
 *
 * The bundles are built from the materialised corpus with the commit set to the shas
 * `fixtures/site/fixture-app.docs.json` names, because a version entry is keyed by a sha.
 * The `1.1.0` sha is the corpus's own head, which is a function of the corpus alone, and
 * `1.0.0` is a second commit the corpus never had, so its build overrides the sha.
 *
 * The fixture's `1.1.0` digest is deliberately not the digest of that manifest. That is
 * what gives the re-pin arm a case: sync writes the real one and says the same sha now
 * produces different manifest bytes, which means the toolchain that built it changed.
 */

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

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { CONSUMER_ROOT, materialiseCorpus } from '../../../fixtures/index.js';
import { MANIFEST_KEY, bundlePrefix } from '../../../src/contracts/manifest.js';
import type { BundleManifest } from '../../../src/contracts/manifest.js';
import type { DocsSiteConfig } from '../../../src/contracts/site.js';
import { buildBundle } from '../../src/compile/build.js';
import { writeBundle } from '../../src/compile/bundle.js';
import { sha256Hex } from '../../src/compile/serialise.js';
import { label } from '../../src/commands/label.js';
import { scaffold } from '../../src/commands/scaffold.js';
import { sync } from '../../src/commands/sync.js';
import { docsSiteConfigSchema, versionTableProblems } from '../../src/contracts/config.schema.js';
import { NO_EXEC } from '../../src/exec/run.js';
import { fileWriter } from '../../src/io/write.js';
import { exitCodeFor, invoke, type CommandOutput, type Ctx } from '../../src/registry/command.js';

/**
 * A switch on the JSON editor sync uses, off unless a test turns it on.
 *
 * It exists for one test, the post-edit proof, which guards against the editor landing a
 * value somewhere it was not meant to go. Nothing in the real editor is known to do that on
 * any input, which is the point of a proof, and it also means no input can make the proof
 * fire. With the switch on, `setMember` writes every `digest` under a misspelt key instead.
 */
const surgery = vi.hoisted(() => ({ misplace: false, misplaced: 0 }));

vi.mock('../../src/io/jsonc.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/io/jsonc.js')>();
	return {
		...actual,
		setMember: (...args: Parameters<typeof actual.setMember>) => {
			const [text, span, key, value, options] = args;
			if (!surgery.misplace || key !== 'digest') return actual.setMember(...args);
			surgery.misplaced += 1;
			return actual.setMember(text, span, 'digset', value, options);
		},
	};
});

const PROJECT = 'fixture-app';
const SITE = 'apps/front';
// A real version string. `bundleManifestSchema` holds `generator` to
// `@hex-pro/docs-kit@<major>.<minor>.<patch>`, and sync reads the cached manifest through
// that schema, so a made-up suffix here would refuse every bundle for the wrong reason.
const KIT_VERSION = '@hex-pro/docs-kit@0.0.1';

/**
 * The two shas the checked-in site config names, and a distinct timestamp for each. The
 * first is the commit the fixture corpus materialises to, so the checked-in config is what
 * sync writes for that corpus.
 */
const VERSIONS = [
	{
		label: '1.1.0',
		commit: 'fc2ef4dea95fb36e5201504e7d06fd2cd0c79b56',
		at: '2026-04-08T09:00:00Z',
	},
	{
		label: '1.0.0',
		commit: 'bec42b4a2f4d59371ae29e19d9e8b441165b186b',
		at: '2026-01-12T09:00:00Z',
	},
] as const;

const FIXTURE_CONFIG_PATH = join(CONSUMER_ROOT, `${PROJECT}.docs.json`);

let scratch: string;
let corpus: string;
/** A cache holding both manifests, and one holding only the default version's. */
let fullCache: string;
let partialCache: string;
let manifest: BundleManifest;
const digests = new Map<string, string>();
let fixtureText: string;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'hexdocs-sync-'));
	corpus = materialiseCorpus(join(scratch, 'app')).root;
	fixtureText = readFileSync(FIXTURE_CONFIG_PATH, 'utf8');

	fullCache = join(scratch, 'cache-full');
	partialCache = join(scratch, 'cache-partial');

	for (const version of VERSIONS) {
		const result = buildBundle(corpus, {
			generator: KIT_VERSION,
			commit: version.commit,
			commitTimestamp: version.at,
		});
		if (version.label === '1.1.0') manifest = result.manifest;
		// Written by the bundle writer rather than by a second serialiser here, so the bytes
		// in the cache are the bytes `hexdocs prefetch` would have stored and the digest sync
		// computes is a digest of those.
		writeBundle(fullCache, result.manifest, []);
		if (version.label === '1.1.0') writeBundle(partialCache, result.manifest, []);
		const path = join(
			fullCache,
			bundlePrefix(result.manifest.project, version.commit),
			MANIFEST_KEY,
		);
		digests.set(version.label, sha256Hex(readFileSync(path)));
	}
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

let sites = 0;

/**
 * A web repository holding one site config, seeded from the checked-in fixture.
 *
 * `edit` receives the parsed config and may change it; when it does, the file is written
 * back with `JSON.stringify` and the byte-level assertions do not apply to that copy. The
 * default is a byte copy of the fixture, which is the one checked-in example of this
 * command's own output.
 */
function siteRepo(edit?: (config: DocsSiteConfig) => void): string {
	sites += 1;
	const root = join(scratch, `site-${sites}`);
	const path = join(root, SITE, 'app', 'docs', `${PROJECT}.docs.json`);
	mkdirSync(dirname(path), { recursive: true });
	if (edit === undefined) {
		// A byte copy, so the formatting assertions below are about the one checked-in
		// example of this command's own output.
		cpSync(FIXTURE_CONFIG_PATH, path);
	} else {
		const config = JSON.parse(fixtureText) as DocsSiteConfig;
		edit(config);
		writeFileSync(path, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
	}
	return root;
}

function configPathOf(root: string): string {
	return join(root, SITE, 'app', 'docs', `${PROJECT}.docs.json`);
}

function context(cwd: string): Ctx {
	return {
		cwd,
		kitVersion: KIT_VERSION,
		exec: NO_EXEC,
		write: fileWriter(),
		now: () => new Date('2026-06-01T00:00:00Z'),
		log: () => undefined,
	};
}

interface SyncData {
	path: string;
	written: boolean;
	why?: string;
	pages?: {
		total: number;
		added: string[];
		removed: string[];
		redirected: string[];
		dropped: string[];
		orphans: string[];
	};
	hidden?: string[];
	repinned?: string[];
	versions?: { label: string; digest: string | null; why: string | null }[];
}

async function runSync(root: string, cache: string) {
	const output: CommandOutput = await invoke(
		sync,
		{ root, site: SITE, project: PROJECT, cache },
		context(root),
	);
	return {
		output,
		data: output.data as unknown as SyncData,
		exit: exitCodeFor(output),
		text: readFileSync(configPathOf(root), 'utf8'),
		row: (id: string) => output.rows.find((entry) => entry.id === id),
	};
}

// ---------------------------------------------------------------------------
// the order, which is the whole of row 12
// ---------------------------------------------------------------------------

describe('the page order', () => {
	test('the nav order and code point order really are different for this corpus', () => {
		// Without this the assertion below would pass against a `sort()`, which is the exact
		// mutation the catalogue names. Stated as a test rather than as a comment, so a
		// corpus edit that made the two orders coincide fails here and says so rather than
		// silently removing the teeth from the next test.
		const nav = manifest.llmsOrder;
		const codePoint = [...nav].sort();
		expect(nav).not.toEqual(codePoint);
		expect([...nav].sort()).toEqual(codePoint);
		expect(Object.keys(manifest.pages)).toEqual(codePoint);
	});

	test('pages is written in llmsOrder, not in code point order', async () => {
		// The config starts with its pages reversed, so neither order can be reached by
		// leaving the file alone.
		const root = siteRepo((config) => {
			config.pages = [...config.pages].reverse();
		});
		const { data, text } = await runSync(root, fullCache);
		const written = (JSON.parse(text) as DocsSiteConfig).pages;

		expect(written).toEqual([...manifest.llmsOrder]);
		expect(written).not.toEqual([...manifest.llmsOrder].sort());
		expect(data.pages?.total).toBe(manifest.llmsOrder.length);
		// Nothing added or removed: the same set, reordered.
		expect(data.pages?.added).toEqual([]);
		expect(data.pages?.removed).toEqual([]);
	});

	test('the hidden page stays in pages and is named in hidden', async () => {
		const root = siteRepo();
		const { data, text } = await runSync(root, fullCache);
		const config = JSON.parse(text) as DocsSiteConfig;

		const hidden = manifest.nav.filter((node) => node.hidden === true).map((node) => node.slug);
		expect(hidden).toHaveLength(1);
		// Published, indexable and addressable: only the sitebar and the sitemap tell the two
		// apart, so leaving it out of `pages` would ship it with no canonical and no noindex.
		for (const slug of hidden) expect(config.pages).toContain(slug);
		expect(config.hidden).toEqual(hidden);
		expect(data.hidden).toEqual(hidden);
		// And `hidden` is a subset of `pages` in the same order, so the two read together.
		const order = config.pages;
		expect(config.hidden).toEqual(order.filter((slug) => hidden.includes(slug)));
	});
});

// ---------------------------------------------------------------------------
// byte stability
// ---------------------------------------------------------------------------

describe('the bytes', () => {
	test('a second run produces a byte-identical file and writes nothing', async () => {
		const root = siteRepo();
		const first = await runSync(root, fullCache);
		expect(first.data.written).toBe(true);

		const second = await runSync(root, fullCache);
		expect(second.data.written).toBe(false);
		// Buffers, not strings: a change of line ending or a lost final newline is a change,
		// and a comparison of decoded text would report the file identical.
		expect(readFileSync(configPathOf(root))).toEqual(Buffer.from(first.text, 'utf8'));
		expect(second.text).toBe(first.text);
		expect(second.output.lines.join('\n')).toContain('was already up to date');

		// The trailing newline survives because no edit reaches the end of the file.
		expect(fixtureText.endsWith('\n')).toBe(true);
		expect(second.text.endsWith('\n')).toBe(true);
		expect(second.text.endsWith('\n\n')).toBe(false);
	});

	test('every byte outside pages, hidden, redirects and versions[].digest is unchanged', async () => {
		const root = siteRepo();
		const { text } = await runSync(root, fullCache);

		// Hand-authored: the fixture with exactly the edits this command owns applied to it,
		// and nothing else. The `1.1.0` entry already carries a digest, so its value is
		// replaced in place; the `1.0.0` entry carries none, so one is appended after
		// `released` at that entry's own indent. The fixture already carries the bundle's
		// `redirects`, expanded above `pages` where sync writes the member, so that edit is
		// a no-op here and `redirects` is not in the replacements.
		const expected = fixtureText
			.replace(
				'"3f1c0a2b9d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8"',
				JSON.stringify(digests.get('1.1.0')),
			)
			.replace(
				'"released": "2026-01-12"',
				`"released": "2026-01-12",\n\t\t\t"digest": ${JSON.stringify(digests.get('1.0.0'))}`,
			);
		expect(text).toBe(expected);

		// Said again as a count, so the claim is not resting on one `toBe`. One line is
		// added and three differ from anything in the original: the replaced `1.1.0` digest,
		// the `1.0.0` released line that gains a comma, and the appended `1.0.0` digest.
		// Every other line in the file is one the original already had, in its original
		// order.
		const before = fixtureText.split('\n');
		const after = text.split('\n');
		expect(after.length).toBe(before.length + 1);
		const changed = after.filter((line) => !before.includes(line));
		expect(changed).toHaveLength(3);
		expect(changed.every((line) => /"digest"|"released"/.test(line))).toBe(true);

		// And the fields this command does not own kept their bytes, their key order and
		// their packing.
		for (const key of ['$schema', 'site', 'project', 'basePath', 'themeClass', 'navLabel']) {
			expect(text).toContain(`"${key}"`);
		}
		expect(text).toContain('"zh": "文档"');
		const keysBefore = Object.keys(JSON.parse(fixtureText) as object);
		expect(Object.keys(JSON.parse(text) as object)).toEqual(keysBefore);
		expect(keysBefore.slice(-2)).toEqual(['redirects', 'pages']);
	});
});

// ---------------------------------------------------------------------------
// the digests
// ---------------------------------------------------------------------------

describe('the version digests', () => {
	test('a pinned digest that no longer matches is rewritten and reported', async () => {
		const root = siteRepo();
		const { data, text, output } = await runSync(root, fullCache);
		const config = JSON.parse(text) as DocsSiteConfig;

		// The fixture pins a digest that is deliberately not this manifest's, so the arm has
		// a case that can fail. Silently replacing a pinned integrity value is the one thing
		// this command must never do without saying so.
		expect(data.repinned).toEqual(['1.1.0']);
		expect(config.versions[0]?.digest).toBe(digests.get('1.1.0'));
		expect(config.versions[0]?.digest).not.toBe(
			'3f1c0a2b9d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8',
		);
		const lines = output.lines.join('\n');
		expect(lines).toContain('The digest changed for 1.1.0');
		expect(lines).toContain('the toolchain that built it did');

		// The other entry gains its first digest, and the two are different values, so the
		// loop is writing per entry rather than the same answer twice.
		expect(config.versions[1]?.digest).toBe(digests.get('1.0.0'));
		expect(digests.get('1.0.0')).not.toBe(digests.get('1.1.0'));
	});

	test('a version with no bundle in the cache fails sync-digests and keeps its digest', async () => {
		const root = siteRepo();
		const { data, text, exit, row } = await runSync(root, partialCache);
		const config = JSON.parse(text) as DocsSiteConfig;

		const digestRow = row('sync-digests');
		expect(digestRow?.status).toBe('fail');
		// Counted as the versions it could answer for, not as the versions it was asked
		// about. A row that reported two here would be claiming a verdict it does not have.
		expect(digestRow?.examined).toBe(1);
		expect(digestRow?.note).toContain('1.0.0');
		expect(digestRow?.note).toContain('hexdocs prefetch');
		expect(config.versions[1]?.digest).toBeUndefined();
		expect(data.versions?.find((entry) => entry.label === '1.0.0')?.digest).toBeNull();
		expect(data.versions?.find((entry) => entry.label === '1.0.0')?.why).toContain(
			'not in the cache',
		);
		expect(exit).toBe(3);

		// `pages` is still written, because the default version's manifest was readable.
		expect(row('sync-pages')?.status).toBe('pass');
		expect(config.pages).toEqual([...manifest.llmsOrder]);
	});

	test('no bundle for the default version is two not-run rows and no write', async () => {
		const root = siteRepo();
		const before = readFileSync(configPathOf(root));
		const empty = join(scratch, 'cache-empty');
		mkdirSync(empty, { recursive: true });

		const { data, exit, output } = await runSync(root, empty);
		expect(data.written).toBe(false);
		expect(output.rows.map((entry) => entry.id)).toEqual(['sync-pages', 'sync-digests']);
		// Both rows, not one. A report with a row missing reads as a report with a row that
		// passed.
		expect(output.rows.map((entry) => entry.status)).toEqual(['not-run', 'not-run']);
		expect(output.rows.every((entry) => (entry.note ?? '') !== '')).toBe(true);
		expect(readFileSync(configPathOf(root))).toEqual(before);
		expect(exit).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// slugs that left
// ---------------------------------------------------------------------------

describe('a slug that is no longer in the bundle', () => {
	test('fails sync-pages when nothing redirects it, and passes when something does', async () => {
		// `first-tag` is in the manifest's redirect table and `ghost/page` is in neither the
		// bundle nor the redirects, so one run covers both directions.
		expect(Object.hasOwn(manifest.redirects, 'first-tag')).toBe(true);
		expect(Object.hasOwn(manifest.redirects, 'ghost/page')).toBe(false);

		// A config synced before the rename: it lists the old slug and has no redirect yet,
		// which the checked-in fixture, synced after it, does.
		const root = siteRepo((config) => {
			config.pages = [...config.pages, 'first-tag', 'ghost/page'];
			delete config.redirects;
		});
		const { data, exit, row, text } = await runSync(root, fullCache);

		const pagesRow = row('sync-pages');
		expect(pagesRow?.status).toBe('fail');
		expect(pagesRow?.note).toContain('ghost/page');
		// The redirected one is named as removed-with-a-redirect and is not in the failure.
		expect(pagesRow?.note).not.toContain('first-tag');
		expect(data.pages?.dropped).toEqual(['ghost/page']);
		expect(data.pages?.redirected).toEqual(['first-tag']);
		expect(exit).toBe(3);

		// The file is still corrected, because the failing row is a statement about an
		// address somebody linked to rather than a reason to leave the config stale.
		expect((JSON.parse(text) as DocsSiteConfig).pages).toEqual([...manifest.llmsOrder]);
	});

	test('a redirected slug alone is a clean run with a line naming where it went', async () => {
		const root = siteRepo((config) => {
			config.pages = [...config.pages, 'first-tag'];
			delete config.redirects;
		});
		const { exit, row, output } = await runSync(root, fullCache);
		expect(row('sync-pages')?.status).toBe('pass');
		expect(exit).toBe(0);
		expect(output.lines.join('\n')).toContain(
			'Removed, with a redirect: first-tag to guide/first-tag',
		);
	});
});

// ---------------------------------------------------------------------------
// redirects
// ---------------------------------------------------------------------------

let doctored = 0;

/**
 * A copy of the full cache whose default-version manifest has had its redirects replaced.
 *
 * Written with `JSON.stringify` rather than through the bundle writer, because the point is
 * a manifest the compiler would never have produced. Its digest changes with it, which
 * `sync` reports as a re-pin and which none of these tests is about.
 */
function cacheWithRedirects(redirects: Record<string, string>): string {
	return doctoredCache((value) => ({ ...value, redirects }));
}

/** The same, for any change to the default version's manifest. */
function doctoredCache(edit: (manifest: BundleManifest) => BundleManifest): string {
	doctored += 1;
	const cache = join(scratch, `cache-doctored-${doctored}`);
	cpSync(fullCache, cache, { recursive: true });
	const path = join(cache, bundlePrefix(PROJECT, VERSIONS[0].commit), MANIFEST_KEY);
	const value = JSON.parse(readFileSync(path, 'utf8')) as BundleManifest;
	writeFileSync(path, JSON.stringify(edit(value)), 'utf8');
	return cache;
}

describe('redirects', () => {
	test('the bundle carries one, and the config gains it as an expanded member above pages', async () => {
		expect(manifest.redirects).toEqual({ 'first-tag': 'guide/first-tag' });
		// The checked-in fixture already carries the member, so it is taken out first: a byte
		// copy would leave the insertion with nothing to do and this test green over an edit
		// that never runs.
		const root = siteRepo((config) => {
			delete config.redirects;
		});
		expect(readFileSync(configPathOf(root), 'utf8')).not.toContain('"redirects"');
		const { data, text, exit } = await runSync(root, fullCache);
		const config = JSON.parse(text) as DocsSiteConfig;

		expect(exit).toBe(0);
		expect(config.redirects).toEqual(manifest.redirects);
		expect(Object.keys(config)).toEqual([
			'$schema',
			'site',
			'project',
			'basePath',
			'themeClass',
			'navLabel',
			'versions',
			'hidden',
			'redirects',
			'pages',
		]);
		expect(text).toContain('\t"redirects": {\n\t\t"first-tag": "guide/first-tag"\n\t},\n');
		expect((data as unknown as { redirects: unknown }).redirects).toEqual(manifest.redirects);
	});

	test('a config already saying the same thing in another shape is left as it is', async () => {
		// Value-gated, like `pages`. A packed object says what the expanded one says, and
		// rewriting it would be the diff a formatter and this command fight over.
		const root = siteRepo();
		await runSync(root, fullCache);
		const path = configPathOf(root);
		const packed = readFileSync(path, 'utf8').replace(
			'"redirects": {\n\t\t"first-tag": "guide/first-tag"\n\t}',
			'"redirects": { "first-tag": "guide/first-tag" }',
		);
		writeFileSync(path, packed, 'utf8');

		const again = await runSync(root, fullCache);
		expect(again.data.written).toBe(false);
		expect(again.text).toBe(packed);
	});

	test('redirects written in another order say the same thing, and are left in that order', async () => {
		// Order-blind on purpose, and a behaviour somebody reaches by hand rather than a
		// defensive guard: reordering the member in an editor is ordinary, and a sync that
		// rewrote it back to the manifest's order would be the spurious diff this command
		// exists not to produce. Settled first, so the second run has nothing else to write.
		const cache = cacheWithRedirects({ 'first-tag': 'guide/first-tag', 'old-home': 'index' });
		const root = siteRepo();
		const settled = await runSync(root, cache);
		expect(settled.exit).toBe(0);
		const path = configPathOf(root);
		const reordered = settled.text.replace(
			'"first-tag": "guide/first-tag",\n\t\t"old-home": "index"',
			'"old-home": "index",\n\t\t"first-tag": "guide/first-tag"',
		);
		expect(reordered).not.toBe(settled.text);
		writeFileSync(path, reordered, 'utf8');

		const again = await runSync(root, cache);

		expect(again.exit).toBe(0);
		expect(again.data.written).toBe(false);
		expect(again.text).toBe(reordered);
	});

	test('an empty redirects member beside a bundle with none is taken out, not refused as a bug', async () => {
		// The schema accepts `{}` and the value gate read it as equal to absent, so no edit was
		// made, while the object the edit is proved against had no member at all. Every run
		// then refused with "a bug in hexdocs" and never wrote the digests or the pages.
		const root = siteRepo((config) => {
			config.redirects = {};
		});
		const cache = cacheWithRedirects({});

		const first = await runSync(root, cache);
		expect(first.data.why).toBeUndefined();
		expect(first.exit).toBe(0);
		expect('redirects' in (JSON.parse(first.text) as object)).toBe(false);

		const second = await runSync(root, cache);
		expect(second.data.written).toBe(false);
		expect(second.text).toBe(first.text);
	});

	test('an empty hidden member beside a bundle that hides nothing is taken out, not refused as a bug', async () => {
		const root = siteRepo((config) => {
			config.hidden = [];
		});
		const cache = doctoredCache((value) => ({
			...value,
			nav: value.nav.map((node) => {
				const { hidden: _hidden, ...shown } = node;
				return shown;
			}),
		}));

		const first = await runSync(root, cache);
		expect(first.data.why).toBeUndefined();
		expect(first.exit).toBe(0);
		expect('hidden' in (JSON.parse(first.text) as object)).toBe(false);

		const second = await runSync(root, cache);
		expect(second.data.written).toBe(false);
		expect(second.text).toBe(first.text);
	});

	test('a bundle with no redirects takes the member out, and a second run changes nothing', async () => {
		const root = siteRepo((config) => {
			config.redirects = { 'first-tag': 'guide/first-tag' };
		});
		const cache = cacheWithRedirects({});

		const first = await runSync(root, cache);
		expect(first.exit).toBe(0);
		expect('redirects' in (JSON.parse(first.text) as object)).toBe(false);
		expect(first.text).not.toContain('"redirects"');

		const second = await runSync(root, cache);
		expect(second.data.written).toBe(false);
		expect(second.text).toBe(first.text);
	});

	const REFUSED: readonly { name: string; redirects: Record<string, string>; says: string }[] = [
		{
			name: 'a source that is also a page',
			redirects: { 'guide/first-tag': 'index' },
			says: 'The redirect source "guide/first-tag" has the same address as the page "guide/first-tag"',
		},
		{
			// A leaf and a section root are one address once addresses carry no trailing slash,
			// so this is the same collision spelled so that a comparison of slugs misses it.
			name: 'a leaf source at the address of a section root',
			redirects: { guide: 'index' },
			says: 'The redirect source "guide" has the same address as the page "guide/index"',
		},
		{
			name: 'a target that is not a page',
			redirects: { 'old-page': 'guide/renamed' },
			says: '"old-page" redirects to "guide/renamed", which is not in `pages`',
		},
	];

	for (const entry of REFUSED) {
		test(`${entry.name} is refused, naming it, and nothing is written`, async () => {
			const root = siteRepo();
			const before = readFileSync(configPathOf(root));

			const { data, exit, output } = await runSync(root, cacheWithRedirects(entry.redirects));

			expect(data.written).toBe(false);
			expect(data.why).toContain('does not validate, so nothing was written');
			expect(data.why).toContain(entry.says);
			expect(output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run']);
			expect(readFileSync(configPathOf(root))).toEqual(before);
			expect(exit).toBe(3);
		});
	}
});

// ---------------------------------------------------------------------------
// a new config, end to end
// ---------------------------------------------------------------------------

describe('a config scaffold wrote, label extended and sync then filled in', () => {
	test('validates at every step, and sync accepts it with nothing left to report', async () => {
		// The dead end this replaces: `scaffold site` used to return `versions: []`, which the
		// schema refuses, `label` could not anchor on, and `sync` and `prefetch` both refused.
		// Every tool here is the real command, and the only hand step is the one a person
		// takes with Edit, applying the patch `label` returned.
		const root = join(scratch, 'end-to-end');
		mkdirSync(root, { recursive: true });
		const older = VERSIONS[1];
		const newer = VERSIONS[0];

		const scaffolded = await invoke(
			scaffold,
			{
				kind: 'site',
				root,
				project: PROJECT,
				site: SITE,
				commit: older.commit,
				version: older.label,
				released: older.at.slice(0, 10),
			},
			{ ...context(root), write: null },
		);
		expect(exitCodeFor(scaffolded)).toBe(0);
		const file = (scaffolded.data as unknown as { files: { path: string; contents: string }[] })
			.files[0];
		expect(file?.path).toBe(`${SITE}/app/docs/${PROJECT}.docs.json`);
		mkdirSync(dirname(configPathOf(root)), { recursive: true });
		writeFileSync(configPathOf(root), file?.contents ?? '', 'utf8');
		const initial = docsSiteConfigSchema.safeParse(JSON.parse(file?.contents ?? ''));
		expect(initial.success).toBe(true);

		const labelled = await invoke(
			label,
			{
				root,
				project: PROJECT,
				commit: newer.commit,
				version: newer.label,
				released: newer.at.slice(0, 10),
				cache: fullCache,
			},
			context(root),
		);
		expect(labelled.rows.map((row) => row.status)).toEqual(['pass', 'pass', 'skipped']);
		const patch = (labelled.data as unknown as { patch: { anchor: string; insert: string } | null })
			.patch;
		expect(patch).not.toBeNull();
		const text = readFileSync(configPathOf(root), 'utf8');
		expect(text.split(patch?.anchor ?? '').length).toBe(2);
		writeFileSync(
			configPathOf(root),
			text.replace(patch?.anchor ?? '', `${patch?.anchor ?? ''}\n${patch?.insert ?? ''}`),
			'utf8',
		);
		const patched = docsSiteConfigSchema.safeParse(
			JSON.parse(readFileSync(configPathOf(root), 'utf8')),
		);
		expect(patched.success).toBe(true);
		expect(versionTableProblems(patched.data as DocsSiteConfig)).toEqual([]);

		const synced = await runSync(root, fullCache);
		expect(synced.exit).toBe(0);
		expect(synced.output.rows.map((row) => row.status)).toEqual(['pass', 'pass']);
		const config = JSON.parse(synced.text) as DocsSiteConfig;
		expect(config.versions.map((entry) => [entry.label, entry.default === true])).toEqual([
			[newer.label, false],
			[older.label, true],
		]);
		expect(config.versions.map((entry) => entry.digest)).toEqual([
			digests.get(newer.label),
			digests.get(older.label),
		]);
		expect(docsSiteConfigSchema.safeParse(config).success).toBe(true);
		expect((await runSync(root, fullCache)).data.written).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// files this command will not touch
// ---------------------------------------------------------------------------

describe('a config sync cannot read', () => {
	test('a file that is not there is a refusal naming the command that makes it', async () => {
		const root = join(scratch, 'no-config');
		mkdirSync(root, { recursive: true });
		const output = await invoke(
			sync,
			{ root, site: SITE, project: PROJECT, cache: fullCache },
			context(root),
		);
		expect((output.data as unknown as SyncData).why).toContain('hexdocs install');
		expect(output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run']);
		expect(exitCodeFor(output)).toBe(3);
		expect(existsSync(configPathOf(root))).toBe(false);
	});

	test('a config whose project field disagrees with its name is refused', async () => {
		const root = siteRepo((config) => {
			config.project = 'other-app';
		});
		const before = readFileSync(configPathOf(root));
		const { data, exit, output } = await runSync(root, fullCache);
		expect(data.why).toContain('declares project "other-app"');
		expect(output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run']);
		expect(readFileSync(configPathOf(root))).toEqual(before);
		expect(exit).toBe(3);
	});

	test('a version table with two defaults has no answer rather than an arbitrary one', async () => {
		const root = siteRepo((config) => {
			const second = config.versions[1];
			if (second !== undefined) config.versions[1] = { ...second, default: true };
		});
		const before = readFileSync(configPathOf(root));
		const { data, exit } = await runSync(root, fullCache);
		expect(data.why).toContain('version table sync cannot read');
		expect(data.why).toContain('marked default');
		expect(readFileSync(configPathOf(root))).toEqual(before);
		expect(exit).toBe(3);
	});

	test('a version entry whose commit is written twice is refused, and the file keeps its bytes', async () => {
		// Strict JSON has one way for the file text and the parsed config to disagree about a
		// version's commit, and it is a key written twice: `JSON.parse` keeps the last one and
		// another reader may keep the first. A digest written into that entry is pinned to
		// whichever sha the reader picks, and the proof below compares through `JSON.parse`
		// too, so it cannot see this.
		const root = siteRepo();
		const path = configPathOf(root);
		const text = readFileSync(path, 'utf8').replace(
			`"commit": "${VERSIONS[1].commit}"`,
			`"commit": "${'a'.repeat(40)}",\n\t\t\t"commit": "${VERSIONS[1].commit}"`,
		);
		writeFileSync(path, text, 'utf8');

		const { data, exit, output } = await runSync(root, fullCache);

		expect(data.written).toBe(false);
		expect(data.why).toContain('the entry labelled 1.0.0');
		expect(data.why).toContain('written twice');
		expect(output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run']);
		expect(readFileSync(path, 'utf8')).toBe(text);
		expect(exit).toBe(3);
	});

	test('an edit that lands somewhere other than intended is refused before it is written', async () => {
		// The surgery is span arithmetic, so what it produced is compared with what it was
		// meant to produce. No input to the real editor is known to make it land wrong, so the
		// editor is made to: every digest goes under a misspelt key, which is valid JSON and
		// the wrong config.
		const root = siteRepo();
		const before = readFileSync(configPathOf(root));
		surgery.misplace = true;
		let outcome: Awaited<ReturnType<typeof runSync>>;
		try {
			outcome = await runSync(root, fullCache);
		} finally {
			surgery.misplace = false;
		}

		expect(surgery.misplaced).toBeGreaterThan(0);
		expect(outcome.data.written).toBe(false);
		expect(outcome.data.why).toContain('did not produce the intended config');
		expect(outcome.output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run']);
		expect(readFileSync(configPathOf(root))).toEqual(before);
		expect(outcome.exit).toBe(3);
	});

	test('a context with no writer refuses rather than reporting a clean run', async () => {
		const root = siteRepo();
		const before = readFileSync(configPathOf(root));
		const output = await invoke(
			sync,
			{ root, site: SITE, project: PROJECT, cache: fullCache },
			{ ...context(root), write: null },
		);
		expect((output.data as unknown as SyncData).written).toBe(false);
		expect(output.rows.map((row) => row.status)).toEqual(['not-run', 'not-run']);
		expect(readFileSync(configPathOf(root))).toEqual(before);
	});
});
