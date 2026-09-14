/**
 * `hexdocs prefetch`, driven against a recording fake `Exec` and two real consumer shapes.
 *
 * Nothing here reaches a network. The fake fills the same recipe templates `runRecipe`
 * fills, so a `get-object` argv asserted here is the argv `spawnSync` would have been
 * handed, and the counting tests below are counts of calls that were about to be made.
 * What it cannot prove is that `aws s3api get-object` writes the stored bytes rather than
 * a decoded copy of them: the whole gzip half of the digest checking rests on that, and it
 * is a claim about a tool this repository does not run.
 *
 * **Step 6 measured it.** A `search/en.idx.json.gz` fetched back out of the real bucket,
 * stored with `Content-Encoding: gzip`, came down byte for byte equal to the manifest's
 * digest and still passed `gunzip -t`. The CLI does not decode the encoding, and the
 * digest check rests on solid ground.
 *
 * The property worth the most here is the cheapest to lose. `prefetch` hangs off
 * `prebuild`, which the deploy runs on the host, so **a warm cache must make zero exec
 * calls and need no credentials**. A prefetch that reached for a bucket on every build
 * would put an AWS profile in the critical path of every deploy of every consuming site,
 * and it would do it silently on the machine of whoever had one configured.
 */

import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
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
import { fileWriter, recordingWriter } from '../../src/io/write.js';
import type { Exec, RunResult } from '../../src/exec/run.js';
import { exitCodeFor, invoke, type Ctx } from '../../src/registry/command.js';
import type { Writer } from '../../src/registry/command.js';

const BUCKET = 'hexdocs-fixture-bucket';
const KIT_VERSION = '@hex-pro/docs-kit@0.0.0';
const LABEL = '1.1.0';
const PROJECT = 'fixture-app';
/** A pinned version beside the default, served at `/v/1.0.0/` and compiled from its own commit. */
const OLDER = {
	label: '1.0.0',
	commit: 'bec42b4a2f4d59371ae29e19d9e8b441165b186b',
	released: '2026-01-12',
} as const;

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
		/** What a bucket that serves nothing prints, so a credentials refusal can be staged. */
		private readonly refusal: string | null = null,
	) {}

	readonly exec: Exec = (id, holes) => {
		this.calls.push({ id, holes: [...holes], argv: fill(id, holes) });
		if (id !== 'aws.get-object' || this.serve === null) {
			const stderr = this.refusal ?? `the fake has no answer for ${id}`;
			return { status: 255, stdout: '', stderr };
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
	// A second commit of the same corpus, for the pinned version beside the default one.
	const older = buildBundle(corpus.root, {
		generator: KIT_VERSION,
		commit: OLDER.commit,
		commitTimestamp: '2026-01-12T09:00:00Z',
	});
	writeBundle(bundleRoot, older.manifest, older.objects);

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
	/** Replaces the one version's label, for a relabel. */
	readonly label?: string;
	/** Anything else, applied last to the parsed object before it is written. */
	readonly edit?: (config: Record<string, unknown>) => void;
}

/**
 * A `<project>.docs.json` for the bundle that was just compiled.
 *
 * Derived from the checked-in fixture config rather than written out, so the page list,
 * the hidden list and the seven nav labels are the ones a real `hexdocs sync` produced.
 * The version table is the only field replaced, because the tests vary its label and its
 * digest and drop the fixture's second version. The commit is read off the compiled
 * manifest rather than off the fixture, because `fill` compares the manifest's
 * self-declared commit against the one the version asks for, and a corpus edit moves it.
 */
function siteConfigText(options: ConfigOptions = {}): string {
	const fixture = JSON.parse(
		readFileSync(join(CONSUMER_ROOT, `${PROJECT}.docs.json`), 'utf8'),
	) as Record<string, unknown>;
	const config: Record<string, unknown> = {
		...fixture,
		versions: [
			{
				label: options.label ?? LABEL,
				commit: manifest.commit,
				released: '2026-04-08',
				default: true,
				...(options.digest === undefined ? {} : { digest: options.digest }),
			},
		],
		...(options.pages === undefined ? {} : { pages: [...options.pages] }),
	};
	options.edit?.(config);
	return `${JSON.stringify(config, null, '\t')}\n`;
}

interface Site {
	readonly consumer: Consumer;
	/** The absolute site directory: `<root>/apps/front` or `<root>/web/front`. */
	readonly directory: string;
}

function makeSite(shape: ConsumerShape, options: ConfigOptions = {}): Site {
	const consumer = materialiseConsumer(shape);
	const site: Site = { consumer, directory: join(consumer.root, consumer.site) };
	writeConfig(site, options);
	return site;
}

/** Rewrites the site's one config, which is how a test relabels between two runs. */
function writeConfig(site: Site, options: ConfigOptions = {}): void {
	const target = join(site.directory, 'app', 'docs', `${PROJECT}.docs.json`);
	mkdirSync(join(target, '..'), { recursive: true });
	writeFileSync(target, siteConfigText(options), 'utf8');
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
	/** A writer other than the real one, for the dry-run case. */
	readonly writer?: Writer;
}

async function run(site: Site, options: RunOptions = {}): Promise<Outcome> {
	const fake = options.fake ?? new FakeS3(options.serve ?? null, prefix);
	const writer = options.writer ?? fileWriter();
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

	test('the rows are the five this command reports, in order, and there is no gitignore row', () => {
		// The gitignore lines are `install`'s to write and `verify-install`'s to check. A
		// second writer of the same two lines in a prebuild hook is how a consumer's file
		// comes to carry them twice under two headers.
		expect(outcome.rows.map((entry) => entry.id)).toEqual([
			'prefetch-configs',
			'prefetch-trees',
			'prefetch-cache',
			'prefetch-extract',
			'prefetch-skew',
		]);
		expect(outcome.writer.written.some((path) => path.endsWith('.gitignore'))).toBe(false);
	});

	test('a second run writes nothing and removes nothing, which is what makes it safe on every build', async () => {
		const second = await run(site);

		expect(second.code).toBe(0);
		expect(second.data['written']).toBe(0);
		expect(second.data['removed']).toBe(0);
		expect(second.data['unchanged']).toBe(outcome.data['files']);
		expect(second.fake.calls).toEqual([]);
		// The writer is the measurement rather than a diff: `written` and `removed` are the
		// lists of paths that actually changed, so an idempotency claim is an assertion about
		// two lengths. A keep set that disagreed with what extraction writes would show here
		// as a file removed and then written back on every run.
		expect(second.writer.written).toEqual([]);
		expect(second.writer.removed).toEqual([]);
		expect(String(row(second, 'prefetch-extract').note)).toContain('0 removed');
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
				'--checksum-mode',
				'ENABLED',
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
// Pruning: the trees hold what the configs name, and nothing else
// ---------------------------------------------------------------------------

/** `<site>/app/docs/_bundles` and `<site>/public/_docs`. */
function trees(site: Site): { bundle: string; public: string } {
	return {
		bundle: join(site.directory, 'app', 'docs', '_bundles'),
		public: join(site.directory, 'public', '_docs'),
	};
}

function plant(path: string, contents = 'planted\n'): string {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, contents, 'utf8');
	return path;
}

describe('pruning', () => {
	test('a stale label, a stale project and a stale file in a live label are removed and counted', async () => {
		const site = makeSite('glob-workspace');
		try {
			await run(site);
			const { bundle, public: publicTree } = trees(site);
			// One of each shape the prune exists for. A label nothing configures any more, in
			// both trees; a project no config names; and a file inside the live label that no
			// manifest record accounts for, at two depths.
			const stale = [
				plant(join(bundle, PROJECT, '1.0.0', 'pages', 'en', 'index.json')),
				plant(join(publicTree, PROJECT, '1.0.0', 'search', 'en.idx.json')),
				plant(join(bundle, 'retired-app', '2.0.0', 'manifest.json')),
				plant(join(bundle, PROJECT, LABEL, 'pages', 'en', 'deleted-page.json')),
				plant(join(publicTree, PROJECT, LABEL, 'stray.txt')),
			];

			const second = await run(site);

			expect(second.code).toBe(0);
			for (const path of stale) expect([path, existsSync(path)]).toEqual([path, false]);
			// The directories the walk emptied went with them, and the live trees are intact.
			expect(readdirSync(bundle)).toEqual([PROJECT]);
			expect(readdirSync(join(bundle, PROJECT))).toEqual([LABEL]);
			expect(readdirSync(join(publicTree, PROJECT))).toEqual([LABEL]);
			expect(tree(join(bundle, PROJECT, LABEL))).toEqual(expectedFiles().bundle);
			expect(tree(join(publicTree, PROJECT, LABEL))).toEqual(expectedFiles().public);

			// Counted: five files, and the seven directories they left empty. Every removal is
			// on the writer's list, so the number on the row is a length rather than a claim.
			const removedDirectories = [
				join(bundle, PROJECT, '1.0.0', 'pages', 'en'),
				join(bundle, PROJECT, '1.0.0', 'pages'),
				join(bundle, PROJECT, '1.0.0'),
				join(publicTree, PROJECT, '1.0.0', 'search'),
				join(publicTree, PROJECT, '1.0.0'),
				join(bundle, 'retired-app', '2.0.0'),
				join(bundle, 'retired-app'),
			];
			expect([...second.writer.removed].sort()).toEqual([...stale, ...removedDirectories].sort());
			expect(second.data['removed']).toBe(12);
			expect(String(row(second, 'prefetch-extract').note)).toContain('12 removed');
			// Nothing the live label needed was removed and written back.
			expect(second.data['written']).toBe(0);
		} finally {
			removeConsumer(site.consumer);
		}
	});

	test('a stray regular file at the project or label level, a .DS_Store included, is removed and counted', async () => {
		// Finder writes a `.DS_Store` into every directory it opens and the deploy host is a
		// Mac. The tree row used to refuse a file at these levels, which failed the production
		// prebuild over a file nobody would ever want built. It is a stale file like any other.
		const site = makeSite('glob-workspace');
		try {
			await run(site);
			const { bundle, public: publicTree } = trees(site);
			const stray = [
				plant(join(bundle, '.DS_Store')),
				plant(join(publicTree, '.DS_Store')),
				plant(join(bundle, PROJECT, '.DS_Store')),
				plant(join(publicTree, PROJECT, '.DS_Store')),
				plant(join(publicTree, 'manual.pdf')),
				plant(join(bundle, PROJECT, 'notes.txt')),
			];

			const second = await run(site);

			expect(second.code).toBe(0);
			const shape = row(second, 'prefetch-trees');
			// Looked at and passed: the nine directories a clean second run counts, and the six
			// files beside them.
			expect([shape.status, shape.examined]).toEqual(['pass', 15]);
			for (const path of stray) expect([path, existsSync(path)]).toEqual([path, false]);
			expect([...second.writer.removed].sort()).toEqual([...stray].sort());
			expect(second.data['removed']).toBe(6);
			expect(String(row(second, 'prefetch-extract').note)).toContain('6 removed');
			expect(readdirSync(bundle)).toEqual([PROJECT]);
			expect(readdirSync(join(bundle, PROJECT))).toEqual([LABEL]);
			expect(tree(join(bundle, PROJECT, LABEL))).toEqual(expectedFiles().bundle);
			expect(tree(join(publicTree, PROJECT, LABEL))).toEqual(expectedFiles().public);
			expect(second.data['written']).toBe(0);
		} finally {
			removeConsumer(site.consumer);
		}
	});

	test('a regular file standing where a configured label directory goes is removed, and the label extracted', async () => {
		// The file has the label's own name, so it is exactly where extraction needs a
		// directory. It is still not a planned destination, so it goes first.
		const site = makeSite('glob-workspace');
		try {
			const { public: publicTree } = trees(site);
			const squatter = plant(join(publicTree, PROJECT, LABEL), 'not a directory\n');

			const outcome = await run(site);

			expect(outcome.code).toBe(0);
			expect(row(outcome, 'prefetch-trees').status).toBe('pass');
			expect(outcome.writer.removed).toEqual([squatter]);
			expect(lstatSync(squatter).isDirectory()).toBe(true);
			expect(tree(join(publicTree, PROJECT, LABEL))).toEqual(expectedFiles().public);
		} finally {
			removeConsumer(site.consumer);
		}
	});

	test('a symbolic link inside a label directory is unlinked, and what it points at survives', async () => {
		const site = makeSite('glob-workspace');
		const outside = join(root, 'outside-the-site');
		try {
			await run(site);
			mkdirSync(outside, { recursive: true });
			writeFileSync(join(outside, 'precious.txt'), 'not the site\n', 'utf8');
			const { bundle } = trees(site);
			const linkedDirectory = join(bundle, PROJECT, LABEL, 'pages', 'elsewhere');
			symlinkSync(outside, linkedDirectory);
			// And a link sitting exactly where a destination file belongs. A prune that kept it
			// because the path is in the keep set would leave extraction writing through it.
			const destination = join(bundle, PROJECT, LABEL, MANIFEST_KEY);
			const manifestBytes = readFileSync(destination);
			rmSync(destination);
			symlinkSync(join(outside, 'precious.txt'), destination);

			const second = await run(site);

			expect(second.code).toBe(0);
			expect(() => lstatSync(linkedDirectory)).toThrow();
			expect(lstatSync(destination).isSymbolicLink()).toBe(false);
			expect(readFileSync(destination)).toEqual(manifestBytes);
			expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('not the site\n');
			expect(second.writer.removed).toEqual(expect.arrayContaining([linkedDirectory, destination]));
		} finally {
			removeConsumer(site.consumer);
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test('a relabel by case alone lands in the configured case, and the run after it changes nothing', async () => {
		// Measured on APFS before this existed: with `1.1.0-RC` on disk, a write under
		// `1.1.0-rc` lands inside the old directory and `readdirSync` goes on reporting the
		// old case, while the Linux container that serves `public/` is case-sensitive.
		// Pruning before extraction is what empties the old spelling first, on either kind of
		// filesystem, so this passes on a laptop and on the CI runner alike.
		const site = makeSite('glob-workspace', { label: '1.1.0-RC' });
		try {
			expect((await run(site)).code).toBe(0);
			writeConfig(site, { label: '1.1.0-rc' });

			const relabelled = await run(site);
			expect(relabelled.code).toBe(0);
			const { bundle, public: publicTree } = trees(site);
			expect(readdirSync(join(bundle, PROJECT))).toEqual(['1.1.0-rc']);
			expect(readdirSync(join(publicTree, PROJECT))).toEqual(['1.1.0-rc']);
			expect(tree(join(bundle, PROJECT, '1.1.0-rc'))).toEqual(expectedFiles().bundle);

			const settled = await run(site);
			expect(settled.code).toBe(0);
			expect(settled.writer.written).toEqual([]);
			expect(settled.writer.removed).toEqual([]);
		} finally {
			removeConsumer(site.consumer);
		}
	});

	test('a pinned version is kept beside the default, and removing it from the config removes its trees', async () => {
		const withOlder = (config: Record<string, unknown>): void => {
			(config['versions'] as Record<string, unknown>[]).push({ ...OLDER });
		};
		const site = makeSite('glob-workspace', { edit: withOlder });
		try {
			const both = await run(site);
			expect(both.code).toBe(0);
			expect(row(both, 'prefetch-cache').examined).toBe(2);
			// Only the default version is compared with `pages`, because a pinned version lives
			// at `/v/<label>/` and the config's page list does not describe it.
			expect(row(both, 'prefetch-skew').examined).toBe(1);
			const { bundle, public: publicTree } = trees(site);
			expect(readdirSync(join(bundle, PROJECT)).sort()).toEqual([OLDER.label, LABEL]);
			expect(tree(join(bundle, PROJECT, OLDER.label))).toEqual(expectedFiles().bundle);
			expect(tree(join(publicTree, PROJECT, OLDER.label))).toEqual(expectedFiles().public);
			const olderFiles =
				tree(join(bundle, PROJECT, OLDER.label)).length +
				tree(join(publicTree, PROJECT, OLDER.label)).length;

			expect((await run(site)).writer.removed).toEqual([]);

			writeConfig(site);
			const dropped = await run(site);
			expect(dropped.code).toBe(0);
			expect(readdirSync(join(bundle, PROJECT))).toEqual([LABEL]);
			expect(readdirSync(join(publicTree, PROJECT))).toEqual([LABEL]);
			expect(dropped.writer.written).toEqual([]);
			// Every file of the dropped version went, and at least its two label directories.
			expect(dropped.writer.removed.length).toBeGreaterThan(olderFiles + 1);
			expect(dropped.data['removed']).toBe(dropped.writer.removed.length);
		} finally {
			removeConsumer(site.consumer);
		}
	});

	test('a dry run through a recording writer reports what it would remove and removes nothing', async () => {
		const site = makeSite('glob-workspace');
		try {
			await run(site);
			const stale = plant(join(trees(site).bundle, PROJECT, 'old', 'manifest.json'));

			const dry = await run(site, { writer: recordingWriter() });

			expect(dry.writer.removed).toEqual([stale, join(stale, '..')]);
			expect(existsSync(stale)).toBe(true);
		} finally {
			removeConsumer(site.consumer);
		}
	});

	test('a config that does not validate removes nothing, because nothing is known to be stale', async () => {
		// The prune runs only once every earlier row has passed. A sibling config that stopped
		// validating is a site whose version table nobody can read, and pruning against the
		// configs that did validate would delete the other project's whole tree.
		const site = makeSite('glob-workspace');
		try {
			await run(site);
			const stale = plant(join(trees(site).bundle, PROJECT, 'old', 'manifest.json'));
			writeFileSync(
				join(site.directory, 'app', 'docs', 'another-app.docs.json'),
				JSON.stringify({ site: 1, project: 'another-app' }),
				'utf8',
			);

			const outcome = await run(site);

			expect(row(outcome, 'prefetch-configs').status).toBe('fail');
			expect(outcome.rows.map((entry) => entry.id)).toEqual(['prefetch-configs']);
			expect(existsSync(stale)).toBe(true);
			expect(outcome.writer.removed).toEqual([]);
			expect(outcome.writer.written).toEqual([]);
			expect(outcome.code).toBe(3);
		} finally {
			removeConsumer(site.consumer);
		}
	});

	test('a cold cache with no bucket removes nothing, so a laptop without credentials keeps its tree', async () => {
		const site = makeSite('glob-workspace');
		const cache = join(root, 'prune-cold');
		try {
			await run(site);
			const stale = plant(join(trees(site).bundle, PROJECT, 'old', 'manifest.json'));

			const outcome = await run(site, { cache });

			expect(row(outcome, 'prefetch-cache').status).toBe('not-run');
			expect(existsSync(stale)).toBe(true);
			expect(outcome.writer.removed).toEqual([]);
		} finally {
			removeConsumer(site.consumer);
			rmSync(cache, { recursive: true, force: true });
		}
	});

	test('a bundle whose records and objects disagree prunes nothing and writes nothing', async () => {
		// The keep set is the plan, so a plan known to be wrong is not something to delete
		// against. The manifest here drops one object from its stored list, which fill does
		// not notice (every object it lists is intact) and the plan does.
		const site = makeSite('glob-workspace');
		const cache = join(root, 'prune-bad-plan');
		try {
			await run(site);
			const stale = plant(join(trees(site).bundle, PROJECT, 'old', 'manifest.json'));
			cpSync(bundleRoot, cache, { recursive: true });
			const cachedManifest = join(cache, ...prefix.split('/'), MANIFEST_KEY);
			const doctored = { ...manifest, objects: manifest.objects.slice(1) };
			writeFileSync(cachedManifest, JSON.stringify(doctored), 'utf8');

			const outcome = await run(site, { cache });

			const extract = row(outcome, 'prefetch-extract');
			expect(extract.status).toBe('fail');
			expect(extract.findings.map((finding) => finding.rule)).toContain('bundle-missing-object');
			expect(extract.note).toBe('Nothing was pruned or written.');
			expect(existsSync(stale)).toBe(true);
			expect(outcome.writer.removed).toEqual([]);
			expect(outcome.writer.written).toEqual([]);
		} finally {
			removeConsumer(site.consumer);
			rmSync(cache, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// The shape of the trees, before anything touches them
// ---------------------------------------------------------------------------

describe('a tree this command will not write into', () => {
	/**
	 * One planted shape per case, each at a level the shape check owns, with the entry the
	 * refusal has to name.
	 */
	const CASES: readonly {
		name: string;
		plant: (site: Site, outside: string) => string;
	}[] = [
		{
			name: 'the bundle tree itself is a symbolic link',
			plant: (site, outside) => {
				symlinkSync(outside, trees(site).bundle);
				return 'app/docs/_bundles is a symbolic link';
			},
		},
		{
			name: 'the public tree itself is a symbolic link',
			plant: (site, outside) => {
				mkdirSync(join(site.directory, 'public'), { recursive: true });
				symlinkSync(outside, trees(site).public);
				return 'public/_docs is a symbolic link';
			},
		},
		{
			name: 'a project directory is a symbolic link',
			plant: (site, outside) => {
				mkdirSync(trees(site).bundle, { recursive: true });
				symlinkSync(outside, join(trees(site).bundle, PROJECT));
				return `app/docs/_bundles/${PROJECT} is a symbolic link`;
			},
		},
		{
			name: 'a label directory is a symbolic link',
			plant: (site, outside) => {
				mkdirSync(join(trees(site).public, PROJECT), { recursive: true });
				symlinkSync(outside, join(trees(site).public, PROJECT, LABEL));
				return `public/_docs/${PROJECT}/${LABEL} is a symbolic link`;
			},
		},
		{
			// Not a regular file, so the prune's `unlink` is not the answer for it. A regular
			// file at this level is removed instead, in the pruning cases above.
			name: 'a named pipe sits where a label directory goes',
			plant: (site) => {
				const pipe = join(trees(site).bundle, PROJECT, 'pipe');
				mkdirSync(join(pipe, '..'), { recursive: true });
				execFileSync('mkfifo', [pipe]);
				return `app/docs/_bundles/${PROJECT}/pipe is neither a directory nor a regular file`;
			},
		},
		{
			name: 'the public directory above the tree is a file',
			plant: (site) => {
				plant(join(site.directory, 'public'));
				return 'public is not a directory';
			},
		},
	];

	for (const entry of CASES) {
		test(`fails a named row and touches nothing when ${entry.name}`, async () => {
			const site = makeSite('glob-workspace');
			const outside = join(root, `outside-${entry.name.replace(/\W+/g, '-')}`);
			const cache = join(root, `shape-cold-${entry.name.replace(/\W+/g, '-')}`);
			try {
				mkdirSync(outside, { recursive: true });
				writeFileSync(join(outside, 'precious.txt'), 'not the site\n', 'utf8');
				const named = entry.plant(site, outside);

				// A cold cache with a bucket, so a run that got past the check would make a call.
				const outcome = await run(site, { cache, serve: cachedBundle, bucket: BUCKET });

				const shape = row(outcome, 'prefetch-trees');
				expect(shape.status).toBe('fail');
				expect(String(shape.note)).toContain(named);
				expect(String(shape.note)).toContain('Nothing was downloaded, pruned or written.');
				expect(outcome.rows.map((found) => found.id)).toEqual([
					'prefetch-configs',
					'prefetch-trees',
				]);
				expect(outcome.fake.calls).toEqual([]);
				expect(outcome.writer.written).toEqual([]);
				expect(outcome.writer.removed).toEqual([]);
				expect(readdirSync(outside)).toEqual(['precious.txt']);
				expect(existsSync(cache)).toBe(false);
				expect(outcome.code).toBe(3);
			} finally {
				removeConsumer(site.consumer);
				rmSync(outside, { recursive: true, force: true });
				rmSync(cache, { recursive: true, force: true });
			}
		});
	}

	// The mode means nothing to root, so a run as root would pass these on a probe that cannot
	// fail. Skipped there rather than asserted.
	const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

	const UNREADABLE: readonly { name: string; directory: string; mode: number; named: string }[] = [
		{
			name: 'an entry below a directory with no search permission',
			directory: 'public',
			mode: 0o600,
			named: 'public/_docs could not be read (EACCES)',
		},
		{
			name: 'a directory that cannot be listed',
			directory: 'public/_docs',
			mode: 0o311,
			named: 'public/_docs could not be read (EACCES)',
		},
	];

	for (const entry of UNREADABLE) {
		test.skipIf(asRoot)(`${entry.name} is a named problem on the row, not a throw`, async () => {
			// A throw reaches the CLI as a stack trace under a sentence calling it a bug in
			// hexdocs. A mode on the site's own directory is not one.
			const site = makeSite('glob-workspace');
			const locked = join(site.directory, ...entry.directory.split('/'));
			try {
				await run(site);
				chmodSync(locked, entry.mode);

				const outcome = await run(site);

				const shape = row(outcome, 'prefetch-trees');
				expect(shape.status).toBe('fail');
				expect(String(shape.note)).toContain(entry.named);
				expect(outcome.writer.removed).toEqual([]);
				expect(outcome.writer.written).toEqual([]);
			} finally {
				chmodSync(locked, 0o755);
				removeConsumer(site.consumer);
			}
		});
	}

	test('a clean site passes and counts the directories it looked at', async () => {
		const site = makeSite('glob-workspace');
		try {
			// `app` and `app/docs` exist before anything is extracted, and `public` does if the
			// fixture consumer ships one. Neither tree does yet.
			const before = existsSync(join(site.directory, 'public')) ? 3 : 2;
			const first = await run(site);
			expect([row(first, 'prefetch-trees').status, row(first, 'prefetch-trees').examined]).toEqual([
				'pass',
				before,
			]);
			const second = await run(site);
			// app, app/docs, _bundles, its project and label; public, _docs, its project and label.
			expect(row(second, 'prefetch-trees').examined).toBe(9);
		} finally {
			removeConsumer(site.consumer);
		}
	});
});

// ---------------------------------------------------------------------------
// The version table and the project set, before anything is fetched
// ---------------------------------------------------------------------------

describe('a version table with no single answer', () => {
	const second = {
		label: '1.0.0',
		commit: 'bec42b4a2f4d59371ae29e19d9e8b441165b186b',
		released: '2026-01-12',
	};

	const CASES: readonly {
		name: string;
		edit: (config: Record<string, unknown>) => void;
		says: string;
	}[] = [
		{
			name: 'two defaults',
			edit: (config) => {
				const versions = config['versions'] as Record<string, unknown>[];
				versions.push({ ...second, default: true });
			},
			says: 'marked default',
		},
		{
			name: 'two labels that differ only in case',
			edit: (config) => {
				const versions = config['versions'] as Record<string, unknown>[];
				versions.push({ ...second, label: '1.0.0-RC' });
				versions.push({ ...second, commit: 'a'.repeat(40), label: '1.0.0-rc' });
			},
			says: 'differ only in case',
		},
	];

	for (const entry of CASES) {
		test(`${entry.name} fails the configs row before any call, prune or write`, async () => {
			const site = makeSite('glob-workspace', { edit: entry.edit });
			const cache = join(root, `table-${entry.name.replace(/\W+/g, '-')}`);
			try {
				const outcome = await run(site, { cache, serve: cachedBundle, bucket: BUCKET });

				const configs = row(outcome, 'prefetch-configs');
				expect(configs.status).toBe('fail');
				expect(String(configs.note)).toContain(`${PROJECT}.docs.json`);
				expect(String(configs.note)).toContain(entry.says);
				expect(outcome.rows).toHaveLength(1);
				expect(outcome.fake.calls).toEqual([]);
				expect(existsSync(trees(site).bundle)).toBe(false);
				expect(outcome.code).toBe(3);
			} finally {
				removeConsumer(site.consumer);
				rmSync(cache, { recursive: true, force: true });
			}
		});
	}

	test('two configs declaring one project fail the configs row, naming both files', async () => {
		const site = makeSite('glob-workspace');
		try {
			writeFileSync(
				join(site.directory, 'app', 'docs', 'copy-of-fixture.docs.json'),
				siteConfigText(),
				'utf8',
			);
			const outcome = await run(site);

			const configs = row(outcome, 'prefetch-configs');
			expect(configs.status).toBe('fail');
			expect(String(configs.note)).toContain(`${PROJECT}.docs.json and copy-of-fixture.docs.json`);
			expect(String(configs.note)).toContain(`both declare the project "${PROJECT}"`);
			// Counted as the two files read, not the one that passed.
			expect(configs.examined).toBe(2);
			expect(existsSync(trees(site).bundle)).toBe(false);
		} finally {
			removeConsumer(site.consumer);
		}
	});
});

// ---------------------------------------------------------------------------
// The sentence a refusal carries
// ---------------------------------------------------------------------------

describe('a refusal from the bucket', () => {
	test('a credentials refusal names AWS_PROFILE and --profile, and not aws configure as the fix', async () => {
		const site = makeSite('glob-workspace');
		const cache = join(root, 'credentials');
		try {
			const fake = new FakeS3(
				null,
				prefix,
				'Unable to locate credentials. You can configure credentials by running "aws configure".',
			);
			const outcome = await run(site, { cache, bucket: BUCKET, fake });

			const note = String(row(outcome, 'prefetch-cache').note);
			expect(row(outcome, 'prefetch-cache').status).toBe('not-run');
			expect(note).toContain('Unable to locate credentials');
			expect(note).toContain('AWS_PROFILE');
			expect(note).toContain('--profile');
			expect(note).toContain('rather than running aws configure');
			expect(fake.calls).toHaveLength(1);
		} finally {
			removeConsumer(site.consumer);
			rmSync(cache, { recursive: true, force: true });
		}
	});

	test('any other refusal is quoted without that sentence, which belongs to credentials alone', async () => {
		const site = makeSite('glob-workspace');
		const cache = join(root, 'not-credentials');
		try {
			const outcome = await run(site, { cache, bucket: BUCKET });
			const note = String(row(outcome, 'prefetch-cache').note);
			expect(note).toContain('the fake has no answer');
			expect(note).not.toContain('AWS_PROFILE');
		} finally {
			removeConsumer(site.consumer);
			rmSync(cache, { recursive: true, force: true });
		}
	});

	test('a bucket that is not a bucket name is refused before any call', async () => {
		// The AWS CLI reads a `file://` value as a file to expand and a leading hyphen as a
		// flag, so the value is checked where it enters rather than handed over.
		const site = makeSite('glob-workspace');
		const cache = join(root, 'bad-bucket');
		try {
			for (const bucket of ['file:///etc/hosts', '--debug', 'Upper-Case']) {
				const outcome = await run(site, { cache, bucket });
				const cacheRow = row(outcome, 'prefetch-cache');
				expect([bucket, cacheRow.status]).toEqual([bucket, 'not-run']);
				expect(String(cacheRow.note)).toContain('not an S3 bucket name');
				expect(outcome.fake.calls).toEqual([]);
			}
		} finally {
			removeConsumer(site.consumer);
			rmSync(cache, { recursive: true, force: true });
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
