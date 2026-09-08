/**
 * `hexdocs prefetch`, driven against a recording fake `Exec` and two real consumer shapes.
 *
 * Nothing here reaches a network. The fake fills the same recipe templates `runRecipe`
 * fills, so a `get-object` argv asserted here is the argv `spawnSync` would have been
 * handed, and the counting tests below are counts of calls that were about to be made.
 * What it cannot prove is that `aws s3api get-object` writes the stored bytes rather than
 * a decoded copy of them: the whole gzip half of the digest checking rests on that, and it
 * is a claim about a tool this repository does not run. Step 6 owns it, when a bucket
 * exists to fetch a key back out of.
 *
 * The property worth the most here is the cheapest to lose. `prefetch` hangs off
 * `prebuild`, which the deploy runs on the host, so **a warm cache must make zero exec
 * calls and need no credentials**. A prefetch that reached for a bucket on every build
 * would put an AWS profile in the critical path of every deploy of every consuming site,
 * and it would do it silently on the machine of whoever had one configured.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
	CONSUMER_SHAPES,
	materialiseConsumer,
	removeConsumer,
	type Consumer,
	type ConsumerShape,
} from '../../../fixtures/consumers.js';
import { CONSUMER_ROOT, materialiseCorpus } from '../../../fixtures/index.js';
import type { CheckRow } from '../../../src/contracts/diagnostics.js';
import { LOCALES, type Locale } from '../../../src/contracts/locales.js';
import {
	MANIFEST_KEY,
	assetKey,
	bundlePrefix,
	llmsKey,
	pageKey,
	rawKey,
	searchKey,
	type BundleManifest,
} from '../../../src/contracts/manifest.js';
import { buildBundle } from '../../src/compile/build.js';
import { writeBundle } from '../../src/compile/bundle.js';
import { sha256Hex } from '../../src/compile/serialise.js';
import { prefetch } from '../../src/commands/prefetch.js';
import { ALL_RECIPES, HOLE, type Recipe, type RecipeId } from '../../src/exec/recipes.js';
import { fileWriter } from '../../src/io/write.js';
import type { Exec, RunResult } from '../../src/exec/run.js';
import { exitCodeFor, invoke, type Ctx } from '../../src/registry/command.js';
import type { Writer } from '../../src/registry/command.js';

const BUCKET = 'hexdocs-fixture-bucket';
const KIT_VERSION = '@hex-pro/docs-kit@0.0.0';
const LABEL = '1.1.0';
const PROJECT = 'fixture-app';

/**
 * The digest the checked-in site config pins, which is deliberately not this bundle's.
 *
 * Read from the fixture rather than written here, so the arm it covers stays covered if
 * somebody ever makes that file's digest real: this would then stop being a mismatch and
 * the test that needs one would fail rather than passing on a value that no longer means
 * anything.
 */
const FIXTURE_PINNED_DIGEST = (
	JSON.parse(readFileSync(join(CONSUMER_ROOT, `${PROJECT}.docs.json`), 'utf8')) as {
		versions: { digest?: string }[];
	}
).versions.find((entry) => entry.digest !== undefined)?.digest;

// ---------------------------------------------------------------------------
// The recording fake
// ---------------------------------------------------------------------------

interface Recorded {
	readonly id: RecipeId;
	readonly holes: readonly string[];
	/** Exactly what `runRecipe` would hand `spawnSync`, with the binary first. */
	readonly argv: readonly string[];
}

function fill(id: RecipeId, holes: readonly string[]): string[] {
	const recipe = ALL_RECIPES[id] as Recipe;
	const argv: string[] = [recipe.bin];
	let next = 0;
	for (const slot of recipe.argv) {
		if (slot !== HOLE) {
			argv.push(slot);
			continue;
		}
		const value = holes[next];
		next += 1;
		if (value === undefined) throw new Error(`recipe "${id}" was given too few values`);
		argv.push(value);
	}
	if (next !== holes.length) throw new Error(`recipe "${id}" was given too many values`);
	return argv;
}

/**
 * A bucket that serves this bundle, and records everything it was asked.
 *
 * `serve` is a directory rather than a map so the fake answers with the bytes the bundle
 * writer produced, gzip members included. A fake that decompressed on the way out would
 * make the stored-digest half of `fill` untestable.
 */
class FakeS3 {
	readonly calls: Recorded[] = [];
	constructor(
		private readonly serve: string | null,
		private readonly prefix: string,
	) {}

	readonly exec: Exec = (id, holes) => {
		this.calls.push({ id, holes: [...holes], argv: fill(id, holes) });
		if (id !== 'aws.get-object' || this.serve === null) {
			return { status: 255, stdout: '', stderr: `the fake has no answer for ${id}` };
		}
		const key = (holes[1] ?? '').slice(this.prefix.length + 1);
		const source = join(this.serve, ...key.split('/'));
		if (!existsSync(source)) {
			return {
				status: 255,
				stdout: '',
				stderr: 'An error occurred (404) when calling the GetObject operation: Not Found',
			};
		}
		const out = holes[2] ?? '';
		mkdirSync(join(out, '..'), { recursive: true });
		writeFileSync(out, readFileSync(source));
		return { status: 0, stdout: '{}', stderr: '' };
	};

	of(id: RecipeId): Recorded[] {
		return this.calls.filter((call) => call.id === id);
	}
}

// ---------------------------------------------------------------------------
// The bundle, compiled once
// ---------------------------------------------------------------------------

let root: string;
/** The written bundle root, which is laid out exactly as a cache directory is. */
let bundleRoot: string;
let cachedBundle: string;
let manifest: BundleManifest;
let prefix: string;
let previousBucket: string | undefined;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'hexdocs-prefetch-'));
	const corpus = materialiseCorpus(join(root, 'repo'));
	const built = buildBundle(corpus.root, { generator: KIT_VERSION });
	expect(built.manifestProblems).toEqual([]);
	manifest = built.manifest;
	bundleRoot = join(root, 'cache');
	mkdirSync(bundleRoot, { recursive: true });
	cachedBundle = writeBundle(bundleRoot, manifest, built.objects).prefix;
	prefix = bundlePrefix(manifest.project, manifest.commit, manifest.ast);
	expect(manifest.project).toBe(PROJECT);

	// `bucketOf` falls back to this, so a developer with one exported would otherwise make
	// the no-credentials tests below pass for the wrong reason.
	previousBucket = process.env['HEXDOCS_BUCKET'];
	delete process.env['HEXDOCS_BUCKET'];
}, 120_000);

afterAll(() => {
	if (previousBucket !== undefined) process.env['HEXDOCS_BUCKET'] = previousBucket;
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The consuming site
// ---------------------------------------------------------------------------

interface ConfigOptions {
	readonly digest?: string;
	/** Replaces the page list, for the two skew directions. */
	readonly pages?: readonly string[];
}

/**
 * A `<project>.docs.json` for the bundle that was just compiled.
 *
 * Derived from the checked-in fixture config rather than written out, so the page list,
 * the hidden list and the seven nav labels are the ones a real `hexdocs sync` produced.
 * The commit is the only field that has to be replaced: the fixture names two shas that
 * predate this corpus, and `fill` compares the manifest's self-declared commit against
 * the one the version asks for.
 */
function siteConfigText(options: ConfigOptions = {}): string {
	const fixture = JSON.parse(
		readFileSync(join(CONSUMER_ROOT, `${PROJECT}.docs.json`), 'utf8'),
	) as Record<string, unknown>;
	const config: Record<string, unknown> = {
		...fixture,
		versions: [
			{
				label: LABEL,
				commit: manifest.commit,
				released: '2026-04-08',
				default: true,
				...(options.digest === undefined ? {} : { digest: options.digest }),
			},
		],
		...(options.pages === undefined ? {} : { pages: [...options.pages] }),
	};
	return `${JSON.stringify(config, null, '\t')}\n`;
}

interface Site {
	readonly consumer: Consumer;
	/** The absolute site directory: `<root>/apps/front` or `<root>/web/front`. */
	readonly directory: string;
}

function makeSite(shape: ConsumerShape, options: ConfigOptions = {}): Site {
	const consumer = materialiseConsumer(shape);
	const directory = join(consumer.root, consumer.site);
	const target = join(directory, 'app', 'docs', `${PROJECT}.docs.json`);
	mkdirSync(join(target, '..'), { recursive: true });
	writeFileSync(target, siteConfigText(options), 'utf8');
	return { consumer, directory };
}

interface Outcome {
	rows: readonly CheckRow[];
	data: Record<string, unknown>;
	code: number;
	writer: Writer;
	fake: FakeS3;
}

interface RunOptions {
	/** The directory the fake serves from, or `null` for a bucket that answers nothing. */
	readonly serve?: string | null;
	readonly cache?: string;
	readonly bucket?: string;
	readonly offline?: boolean;
	readonly fake?: FakeS3;
}

async function run(site: Site, options: RunOptions = {}): Promise<Outcome> {
	const fake = options.fake ?? new FakeS3(options.serve ?? null, prefix);
	const writer = fileWriter();
	const ctx: Ctx = {
		cwd: site.consumer.root,
		kitVersion: KIT_VERSION,
		exec: fake.exec,
		write: writer,
		now: () => new Date('2026-05-01T00:00:00Z'),
		log: () => undefined,
	};
	const output = await invoke(
		prefetch,
		{
			root: site.consumer.root,
			site: site.consumer.site,
			cache: options.cache ?? bundleRoot,
			...(options.bucket === undefined ? {} : { bucket: options.bucket }),
			...(options.offline === true ? { offline: true } : {}),
		},
		ctx,
	);
	return {
		rows: output.rows,
		data: output.data as Record<string, unknown>,
		code: exitCodeFor(output),
		writer,
		fake,
	};
}

function row(outcome: Outcome, id: string): CheckRow {
	const found = outcome.rows.find((entry) => entry.id === id);
	if (found === undefined) {
		throw new Error(`no ${id} row in [${outcome.rows.map((entry) => entry.id).join(', ')}]`);
	}
	return found;
}

/** Every file under a directory, as paths relative to it with forward slashes. */
function tree(directory: string): string[] {
	if (!existsSync(directory)) return [];
	const found: string[] = [];
	const walk = (at: string): void => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const full = join(at, entry.name);
			if (entry.isDirectory()) walk(full);
			else found.push(relative(directory, full).split(sep).join('/'));
		}
	};
	walk(directory);
	return found.sort();
}

/**
 * Every file the bundle should land in the site, derived from the manifest's own records.
 *
 * Built with the same five key helpers the compiler writes keys with, so the destinations
 * are a function of the manifest rather than of a list somebody kept up to date. A slug
 * added to the corpus arrives here without an edit.
 */
function expectedFiles(): { bundle: string[]; public: string[] } {
	const bundle: string[] = [MANIFEST_KEY];
	const publicFiles: string[] = [];
	for (const [slug, page] of Object.entries(manifest.pages)) {
		for (const locale of manifest.locales) {
			if (page.locales[locale] === undefined) continue;
			bundle.push(pageKey(locale, slug).replace(/\.gz$/, ''));
			bundle.push(rawKey(locale, slug).replace(/\.gz$/, ''));
		}
	}
	for (const locale of manifest.locales) {
		if (manifest.search[locale] !== undefined) {
			publicFiles.push(searchKey(locale).replace(/\.gz$/, ''));
		}
		if (manifest.llms[locale] !== undefined) bundle.push(llmsKey(locale));
	}
	for (const asset of manifest.assets) publicFiles.push(assetKey(asset.sha256, asset.ext));
	return { bundle: bundle.sort(), public: publicFiles.sort() };
}

// ---------------------------------------------------------------------------
// A warm cache
// ---------------------------------------------------------------------------

describe.each(CONSUMER_SHAPES)('a warm cache, on the %s consumer', (shape) => {
	let site: Site;
	let outcome: Outcome;

	beforeAll(async () => {
		site = makeSite(shape);
		outcome = await run(site);
	});

	afterAll(() => {
		if (site !== undefined) removeConsumer(site.consumer);
	});

	test('makes zero exec calls and needs no bucket, which is what makes it a prebuild hook', () => {
		// No `--bucket` was passed and `HEXDOCS_BUCKET` is unset, so the client this run
		// carries refuses everything. It never had to ask.
		expect(outcome.fake.calls).toEqual([]);
		expect(outcome.data['calls']).toBe(0);
		expect(outcome.code).toBe(0);
		expect(outcome.data['prefetched']).toBe(true);
		expect(outcome.rows.every((entry) => entry.status === 'pass')).toBe(true);
	});

	test('the search index and the assets land under public/, where the browser can reach them', () => {
		// `src/render/search.tsx` fetches the index at runtime and `connect-src 'self'` is the
		// consumers' CSP, so this has to be a same-origin static file. `public/` is the only
		// tree Vite copies into `build/client/`, which is the only tree the Dockerfile copies.
		const publicDirectory = join(site.directory, 'public', '_docs', PROJECT, LABEL);
		expect(tree(publicDirectory)).toEqual(expectedFiles().public);
		expect(existsSync(join(publicDirectory, 'search', 'en.idx.json'))).toBe(true);
	});

	test('the page payloads, the raw markdown, llms.txt and the manifest land in the app source', () => {
		const bundleDirectory = join(site.directory, 'app', 'docs', '_bundles', PROJECT, LABEL);
		expect(tree(bundleDirectory)).toEqual(expectedFiles().bundle);
	});

	test('the two trees are disjoint, and neither holds the other one kind of file', () => {
		// The split is decided by shipped renderer code rather than by taste, so it is
		// asserted in both directions: a search index under the app source is a file the
		// browser cannot fetch, and a page payload under `public/` is a payload served to
		// anybody who guesses the URL instead of being a code-split chunk.
		const bundleDirectory = join(site.directory, 'app', 'docs', '_bundles', PROJECT, LABEL);
		const publicDirectory = join(site.directory, 'public', '_docs', PROJECT, LABEL);
		expect(tree(bundleDirectory).filter((path) => path.startsWith('search/'))).toEqual([]);
		expect(tree(bundleDirectory).filter((path) => path.startsWith('assets/'))).toEqual([]);
		expect(tree(publicDirectory).filter((path) => path.startsWith('pages/'))).toEqual([]);
		expect(tree(publicDirectory).filter((path) => path.startsWith('raw/'))).toEqual([]);
		expect(tree(publicDirectory).filter((path) => path.startsWith('llms/'))).toEqual([]);
		expect(tree(publicDirectory)).not.toContain(MANIFEST_KEY);
	});

	test('nothing arrives compressed, and every file hashes to what the manifest records', () => {
		// Two digest families, and they are not interchangeable: `objects[].digest` covers the
		// stored bytes and the page, raw, search and asset records cover the uncompressed ones.
		// This is the second family, over what actually landed in the site.
		const bundleDirectory = join(site.directory, 'app', 'docs', '_bundles', PROJECT, LABEL);
		const publicDirectory = join(site.directory, 'public', '_docs', PROJECT, LABEL);
		for (const path of [...tree(bundleDirectory), ...tree(publicDirectory)]) {
			expect(path.endsWith('.gz')).toBe(false);
		}

		let checked = 0;
		for (const [slug, page] of Object.entries(manifest.pages)) {
			for (const locale of manifest.locales) {
				const record = page.locales[locale];
				if (record === undefined) continue;
				const payload = readFileSync(join(bundleDirectory, 'pages', locale, `${slug}.json`));
				expect([slug, locale, sha256Hex(payload)]).toEqual([slug, locale, record.digest]);
				const markdown = readFileSync(join(bundleDirectory, 'raw', locale, `${slug}.md`));
				expect([slug, locale, sha256Hex(markdown)]).toEqual([slug, locale, record.rawDigest]);
				checked += 2;
			}
		}
		for (const locale of manifest.locales) {
			const search = manifest.search[locale];
			if (search !== undefined) {
				const bytes = readFileSync(join(publicDirectory, 'search', `${locale}.idx.json`));
				expect([locale, sha256Hex(bytes)]).toEqual([locale, search.digest]);
				checked += 1;
			}
		}
		for (const locale of manifest.locales) {
			const llms = manifest.llms[locale];
			if (llms !== undefined) {
				const bytes = readFileSync(join(bundleDirectory, 'llms', `${locale}.txt`));
				expect([locale, sha256Hex(bytes)]).toEqual([locale, llms.digest]);
				checked += 1;
			}
		}
		for (const asset of manifest.assets) {
			const bytes = readFileSync(join(publicDirectory, 'assets', `${asset.sha256}.${asset.ext}`));
			// The asset is its own digest, which is also its filename, so a decode and re-encode
			// round trip would be visible here and nowhere else.
			expect([asset.sha256, sha256Hex(bytes)]).toEqual([asset.sha256, asset.sha256]);
			checked += 1;
		}
		// The manifest is the one file whose expected digest is not a field of anything: it
		// is taken over the cached bytes, which is also what a pinned `digest` is compared to.
		expect(sha256Hex(readFileSync(join(bundleDirectory, MANIFEST_KEY)))).toBe(
			sha256Hex(readFileSync(join(cachedBundle, MANIFEST_KEY))),
		);
		checked += 1;
		// Every file the run counted was hashed here. A destination the plan added and this
		// sweep did not know about would leave the two numbers apart.
		expect(checked).toBe(outcome.data['files'] as number);
	});

	test('the gitignore gains both entries and keeps what the consumer already had', () => {
		const path = join(site.directory, '.gitignore');
		const text = readFileSync(path, 'utf8');
		expect(text.startsWith('.react-router/\nbuild/\n')).toBe(true);
		expect(text).toContain('app/docs/_bundles/');
		expect(text).toContain('public/_docs/');
		expect(text).toContain('# Written by hexdocs prefetch.');
		expect(row(outcome, 'prefetch-gitignore').status).toBe('pass');
		expect(outcome.writer.written).toContain(path);
	});

	test('a second run writes nothing at all, which is what makes it safe on every build', async () => {
		const before = readFileSync(join(site.directory, '.gitignore'), 'utf8');
		const second = await run(site);

		expect(second.code).toBe(0);
		expect(second.data['written']).toBe(0);
		expect(second.data['unchanged']).toBe(outcome.data['files']);
		expect(second.fake.calls).toEqual([]);
		// The writer is the measurement rather than a diff: `written` is the list of paths
		// whose bytes actually changed, so an idempotency claim is an assertion about a
		// length. The gitignore is in it, and it is the one a second run is most likely to
		// append to twice.
		expect(second.writer.written).toEqual([]);
		expect(readFileSync(join(site.directory, '.gitignore'), 'utf8')).toBe(before);
	});
});

// ---------------------------------------------------------------------------
// A cold cache
// ---------------------------------------------------------------------------

describe('a cold cache', () => {
	test('downloads every object once and leaves a cache a second run makes no call against', async () => {
		const site = makeSite('glob-workspace');
		const cache = join(root, 'cold');
		try {
			const first = await run(site, { cache, serve: cachedBundle, bucket: BUCKET });

			expect(first.code).toBe(0);
			// The manifest plus every object it names, each fetched exactly once. A cache that
			// re-hashed wrongly would show up as a second download of the same key.
			expect(first.fake.of('aws.get-object')).toHaveLength(manifest.objects.length + 1);
			expect(new Set(first.fake.of('aws.get-object').map((call) => call.holes[1])).size).toBe(
				manifest.objects.length + 1,
			);
			expect(first.fake.of('aws.get-object')[0]?.argv).toEqual([
				'aws',
				's3api',
				'get-object',
				'--bucket',
				BUCKET,
				'--key',
				`${prefix}/${MANIFEST_KEY}`,
				join(cache, ...prefix.split('/'), MANIFEST_KEY),
				'--output',
				'json',
			]);
			// The cache mirrors the bucket exactly, which is what makes relabelling a sha cost
			// nothing: the key is the commit and not the label.
			expect(tree(join(cache, ...prefix.split('/'))).length).toBe(manifest.objects.length + 1);

			const second = await run(site, { cache, serve: cachedBundle, bucket: BUCKET });
			expect(second.fake.calls).toEqual([]);
			expect(second.code).toBe(0);
		} finally {
			removeConsumer(site.consumer);
			rmSync(cache, { recursive: true, force: true });
		}
	});

	test('with --offline it is a not-run row naming the flag, and still no call', async () => {
		const site = makeSite('glob-workspace');
		const cache = join(root, 'offline');
		try {
			const outcome = await run(site, { cache, offline: true, bucket: BUCKET });

			expect(outcome.fake.calls).toEqual([]);
			const cacheRow = row(outcome, 'prefetch-cache');
			expect(cacheRow.status).toBe('not-run');
			expect(String(cacheRow.note)).toContain('--offline');
			expect(String(cacheRow.note)).toContain(MANIFEST_KEY);
			expect(outcome.code).toBe(3);
		} finally {
			removeConsumer(site.consumer);
			rmSync(cache, { recursive: true, force: true });
		}
	});

	test('with no bucket it is a not-run row naming the missing configuration', async () => {
		// The cold half of the property the warm tests measure: a build host with no AWS
		// profile has not found a broken bundle, it has not looked, so this is `not-run` and
		// never `fail` and never a pass.
		const site = makeSite('glob-workspace');
		const cache = join(root, 'nobucket');
		try {
			const outcome = await run(site, { cache });

			expect(outcome.fake.calls).toEqual([]);
			expect(row(outcome, 'prefetch-cache').status).toBe('not-run');
			expect(String(row(outcome, 'prefetch-cache').note)).toContain('HEXDOCS_BUCKET');
			expect(outcome.code).toBe(3);
		} finally {
			removeConsumer(site.consumer);
			rmSync(cache, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// The pinned digest
// ---------------------------------------------------------------------------

describe('the digest a site pinned', () => {
	test('matching is a pass, so the refusal below is not a test of the flag being read', async () => {
		const digest = sha256Hex(readFileSync(join(cachedBundle, MANIFEST_KEY)));
		const site = makeSite('glob-workspace', { digest });
		try {
			const outcome = await run(site);
			expect(outcome.code).toBe(0);
			expect(row(outcome, 'prefetch-cache').status).toBe('pass');
		} finally {
			removeConsumer(site.consumer);
		}
	});

	test('mismatching refuses, names both digests, and extracts nothing', async () => {
		expect(FIXTURE_PINNED_DIGEST).toMatch(/^[0-9a-f]{64}$/);
		const site = makeSite('glob-workspace', { digest: FIXTURE_PINNED_DIGEST });
		try {
			const outcome = await run(site);

			const cacheRow = row(outcome, 'prefetch-cache');
			expect(cacheRow.status).toBe('fail');
			expect(cacheRow.findings.map((finding) => finding.rule)).toEqual(['bundle-digest-mismatch']);
			expect(cacheRow.findings[0]?.message).toContain((FIXTURE_PINNED_DIGEST ?? '').slice(0, 12));
			expect(outcome.code).toBe(3);
			// Nothing reached the site. A bundle whose integrity pin disagrees must not be
			// half-copied into an image on the way to being reported.
			expect(existsSync(join(site.directory, 'app', 'docs', '_bundles'))).toBe(false);
			expect(existsSync(join(site.directory, 'public', '_docs'))).toBe(false);
		} finally {
			removeConsumer(site.consumer);
		}
	});
});

// ---------------------------------------------------------------------------
// Page skew
// ---------------------------------------------------------------------------

describe('the page set the host will route against the page set the bundle carries', () => {
	const slugs = (): string[] => Object.keys(manifest.pages).sort();

	test('a slug the bundle carries and the config does not fails, naming it', async () => {
		// That page renders, links from the sidebar and appears in prev and next, while the
		// host's `isLocalisedPath` returns false for it: no canonical, no alternates, no
		// noindex, and it renders perfectly.
		const dropped = 'developer/architecture';
		const site = makeSite('glob-workspace', {
			pages: slugs().filter((slug) => slug !== dropped),
		});
		try {
			const outcome = await run(site);

			const skew = row(outcome, 'prefetch-skew');
			expect(skew.status).toBe('fail');
			expect(String(skew.note)).toContain(dropped);
			expect(String(skew.note)).toContain('the site config does not list');
			expect(outcome.code).toBe(3);
		} finally {
			removeConsumer(site.consumer);
		}
	});

	test('a slug the config lists and the bundle does not fails, naming it', async () => {
		// The other direction is eight hreflang alternates pointing at eight 404s.
		const invented = 'guide/does-not-exist';
		const site = makeSite('glob-workspace', { pages: [...slugs(), invented] });
		try {
			const outcome = await run(site);

			const skew = row(outcome, 'prefetch-skew');
			expect(skew.status).toBe('fail');
			expect(String(skew.note)).toContain(invented);
			expect(String(skew.note)).toContain('the bundle does not carry');
			expect(outcome.code).toBe(3);
		} finally {
			removeConsumer(site.consumer);
		}
	});

	test('the matching config passes and the row says it compared something', async () => {
		// Without this the two failures above would pass against a row that fails on every
		// input, and a row that examined nothing is a failure in this repository anyway.
		const site = makeSite('glob-workspace');
		try {
			const outcome = await run(site);
			const skew = row(outcome, 'prefetch-skew');
			expect([skew.status, skew.examined, skew.unit]).toEqual(['pass', 1, 'page sets']);
		} finally {
			removeConsumer(site.consumer);
		}
	});
});

// ---------------------------------------------------------------------------
// The gitignore, on its own
// ---------------------------------------------------------------------------

describe('the gitignore entries', () => {
	test('are added once and adding them twice changes nothing', async () => {
		const site = makeSite('glob-workspace');
		const path = join(site.directory, '.gitignore');
		try {
			const original = readFileSync(path, 'utf8');
			await run(site);
			const afterFirst = readFileSync(path, 'utf8');
			const size = statSync(path).size;

			await run(site);
			await run(site);

			expect(readFileSync(path, 'utf8')).toBe(afterFirst);
			expect(statSync(path).size).toBe(size);
			// One header and one of each entry, however many times this runs.
			expect(afterFirst.split('app/docs/_bundles/')).toHaveLength(2);
			expect(afterFirst.split('public/_docs/')).toHaveLength(2);
			expect(afterFirst.split('# Written by hexdocs prefetch.')).toHaveLength(2);
			expect(afterFirst.startsWith(original)).toBe(true);
		} finally {
			removeConsumer(site.consumer);
		}
	});

	test('a site with the entries already present is left byte for byte alone', async () => {
		// The check and the writer share one answer: the entries are compared line by line
		// after trimming, so a hand-added entry counts and is not duplicated beneath a header.
		const site = makeSite('literal-workspace');
		const path = join(site.directory, '.gitignore');
		try {
			const planted = 'build/\napp/docs/_bundles/\npublic/_docs/\n';
			writeFileSync(path, planted, 'utf8');

			const outcome = await run(site);

			expect(readFileSync(path, 'utf8')).toBe(planted);
			expect(outcome.writer.written).not.toContain(path);
			expect(row(outcome, 'prefetch-gitignore').status).toBe('pass');
		} finally {
			removeConsumer(site.consumer);
		}
	});
});

// ---------------------------------------------------------------------------
// What a site has to have before this can run
// ---------------------------------------------------------------------------

describe('a site that declares nothing', () => {
	test('is a not-run row naming the directory, not an empty pass', async () => {
		const consumer = materialiseConsumer('glob-workspace');
		try {
			const site: Site = { consumer, directory: join(consumer.root, consumer.site) };
			const outcome = await run(site);

			const configs = row(outcome, 'prefetch-configs');
			expect(configs.status).toBe('not-run');
			expect(String(configs.note)).toContain('app/docs');
			expect(outcome.code).toBe(3);
			expect(outcome.fake.calls).toEqual([]);
		} finally {
			removeConsumer(consumer);
		}
	});

	test('a config that does not validate fails rather than being skipped', async () => {
		const site = makeSite('glob-workspace');
		try {
			writeFileSync(
				join(site.directory, 'app', 'docs', `${PROJECT}.docs.json`),
				JSON.stringify({ site: 1, project: PROJECT }),
				'utf8',
			);
			const outcome = await run(site);

			expect(row(outcome, 'prefetch-configs').status).toBe('fail');
			expect(outcome.code).toBe(3);
		} finally {
			removeConsumer(site.consumer);
		}
	});
});

// ---------------------------------------------------------------------------
// The locale set the corpus actually carries
// ---------------------------------------------------------------------------

test('the corpus covers every locale, so the extraction sweep is not one language wide', () => {
	// The destination sweep above iterates `manifest.locales`, which would be satisfied by a
	// single-locale bundle. Naming the limit rather than implying more: this bundle has all
	// seven, and one page (`index`) exists in each of them.
	expect(manifest.locales).toEqual([...LOCALES]);
	const index = manifest.pages['index'];
	const present = LOCALES.filter((locale: Locale) => index?.locales[locale] !== undefined);
	expect(present).toEqual([...LOCALES]);
});
