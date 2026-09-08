/**
 * `hexdocs prefetch`: every labelled bundle a site declares, on disk, before the build.
 *
 * This is what makes the consuming website need no origin, no CDN host, no cache TTL and
 * no runtime fetch of anything it did not build with. Everything the browser asks for is
 * a static file from the site's own origin, which is what `connect-src 'self'` in the
 * consumers' CSP already assumes, and it is why an earlier design's origin URL and disk
 * cache path are not fields on `DocsSiteConfig`.
 *
 * It hangs off `prebuild`, which is the one script that always runs: the deploy runs
 * `pnpm build` on the host before the Docker build, and the container's own
 * `npm install --ignore-scripts` never re-runs it. So the normal case is a laptop or a
 * build host with a warm cache, and **a warm cache makes zero exec calls and needs no
 * AWS credentials.** That is a property worth protecting rather than an optimisation: a
 * prefetch that reached for a bucket on every build would put an AWS profile in the
 * critical path of every deploy, and the deploy inherits the developer's environment by
 * accident of `...process.env` rather than by anything the repository pins. A cold cache
 * with no credentials is a `not-run` row naming what was missing, never a crash and never
 * a pass.
 *
 * **The cache key is the commit, not the label.** `~/.cache/hexdocs/<project>/<sha>/ast-N`
 * mirrors the bucket exactly, so relabelling a sha, or pointing a second label at one,
 * does no network at all.
 *
 * Two destinations, and the split is decided by shipped renderer code rather than by
 * taste. Page payloads, raw markdown, `llms.txt` and the manifest go under the site's app
 * source, where a lazy `import.meta.glob` turns each page into a code-split chunk and a
 * resource route can serve the markdown. **The search index and the assets go to
 * `public/`**, because `src/render/search.tsx` fetches the index at runtime through
 * `fetch(bundleUrl(props.bundleBase, searchKey(...)))` and an image is an `<img src>`:
 * both have to be same-origin static files, and `public/` is the only tree Vite copies
 * into `build/client/`, which is the only thing the Dockerfile copies.
 *
 * Two digest families are checked, in this order, and they are not interchangeable.
 * `objects[].digest` covers the **stored** bytes, gzip included, which is what
 * `s3api get-object` writes because it does not decode `Content-Encoding`. The page, raw,
 * search and asset records cover the **uncompressed** bytes, which is what lands in the
 * site. Checking only the first would let a corrupt decompression through; checking only
 * the second would leave the cache unverified.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { AST_VERSION } from '../../../src/contracts/ast.js';
import {
	checkRow,
	failedRow,
	notRunRow,
	type CheckRow,
} from '../../../src/contracts/diagnostics.js';
import {
	MANIFEST_KEY,
	assetKey,
	bundlePrefix,
	isGzipped,
	llmsKey,
	pageKey,
	rawKey,
	searchKey,
	type BundleManifest,
} from '../../../src/contracts/manifest.js';
import type { DocsSiteConfig, VersionEntry } from '../../../src/contracts/site.js';
import { pageSkew } from '../../../src/site/route.js';
import { gunzipMember, sha256Hex, utf8Bytes, type JsonValue } from '../compile/serialise.js';
import { raw, type RawFinding } from '../compile/types.js';
import { bundleManifestSchema } from '../contracts/bundle.schema.js';
import { docsSiteConfigSchema } from '../contracts/config.schema.js';
import { defineCommand, type Ctx, type Writer } from '../registry/command.js';
import { checkFindings, s3Client, type S3Client } from '../s3/client.js';

import { BUCKET, bucketOf, PROFILE, REGION, regionOf, ROOT, rootOf, SITE } from './common.js';

/** Where `<project>.docs.json` lives, relative to the consuming site directory. */
const DOCS_DIR = ['app', 'docs'];

/** Where page payloads, raw markdown, `llms.txt` and the manifest land. */
const BUNDLE_DIR = [...DOCS_DIR, '_bundles'];

/** Where the search index and the assets land: the only tree the browser can reach. */
const PUBLIC_DIR = ['public', '_docs'];

/** The two lines `prefetch` adds to the site's `.gitignore`, and nothing else. */
const IGNORE_ENTRIES = ['app/docs/_bundles/', 'public/_docs/'];

const IGNORE_HEADER =
	'# Written by hexdocs prefetch. Downloaded bundles, rebuilt from the cache on every build.';

/**
 * A client that answers every call with the same refusal.
 *
 * What `clientFor` returns when there is no bucket to talk to. It is a client rather than
 * a null, so `fill` has one code path: the reason travels on the refusal and lands on a
 * `not-run` row, and there is no second branch in the caller that could forget to check.
 */
interface MaybeClient extends S3Client {
	/** Why this client cannot talk to anything, or `null` when it can. */
	readonly why: string | null;
}

export const prefetch = defineCommand({
	name: 'prefetch',
	tool: null,
	writes: 'files',
	summary: 'Download every labelled bundle a site declares and write it into the site.',
	detail:
		'Reads every <project>.docs.json under the site, caches each labelled commit under a commit-addressed cache directory, verifies both the stored and the uncompressed digest of every file, and writes the page payloads into the app source and the search index and the assets into public/. A warm cache makes no network call and needs no AWS credentials, which is what makes this safe to run from a prebuild hook on a laptop and in a container. Run it before every build of a site that mounts documentation.',
	params: {
		root: ROOT,
		site: SITE,
		bucket: BUCKET,
		region: REGION,
		profile: PROFILE,
		cache: {
			help: 'where downloaded bundles are cached; defaults to $XDG_CACHE_HOME/hexdocs, or ~/.cache/hexdocs',
			type: 'string',
		},
		offline: {
			help: 'make no network call at all; a bundle missing from the cache then fails rather than downloading',
			type: 'boolean',
		},
	},
	positionals: ['root'],
	taughtBy: ['docs-install-site'],
	// `async` because `Command.run` is. Nothing awaits: `Exec` is synchronous.
	async run(input, ctx) {
		const root = rootOf(ctx.cwd, input.root);
		const cacheRoot =
			input.cache === undefined ? defaultCacheRoot() : resolve(ctx.cwd, input.cache);

		// `--site` is declared required and `invoke` parses against a schema that refuses a
		// call without it, so on either front door this cannot fire. It is kept because
		// `run` is a public method and a test or a future caller can reach it without going
		// through `invoke`, and the failure it would otherwise produce is silent: an empty
		// site path resolves to the repository root, and this command writes a bundle tree
		// wherever it is pointed.
		if (input.site === undefined) {
			const why = 'No --site. It names the consuming site directory, such as apps/front.';
			return output([notRunRow('prefetch-configs', 'site configs', why)], { prefetched: false }, [
				why,
			]);
		}
		const siteDirectory = resolve(root, input.site);

		const writer = ctx.write;
		if (writer === null) {
			// The MCP boundary, met at runtime rather than at the type. It cannot happen: a
			// command that declares `writes` has no tool name and the union refuses to give
			// it one. It is here so that if something ever does reach it, the transcript
			// says so rather than the command half running.
			const why =
				'This context has no writer. prefetch writes into a repository and is not reachable over MCP.';
			return output([notRunRow('prefetch-configs', 'site configs', why)], { prefetched: false }, [
				why,
			]);
		}

		// ---- the site's declarations ----------------------------------------

		const docsDirectory = join(siteDirectory, ...DOCS_DIR);
		if (!existsSync(docsDirectory)) {
			const why = `${docsDirectory} does not exist, so this site declares no documentation. Run hexdocs install first, or point --site at the directory that holds app/docs.`;
			return output(
				[notRunRow('prefetch-configs', 'site configs', why)],
				{ site: siteDirectory, prefetched: false, why },
				[why],
			);
		}

		const configs: DocsSiteConfig[] = [];
		const configProblems: string[] = [];
		for (const name of readdirSync(docsDirectory).sort()) {
			if (!name.endsWith('.docs.json')) continue;
			const path = join(docsDirectory, name);
			if (!statSync(path).isFile()) continue;
			const parsed = readSiteConfig(path);
			if ('why' in parsed) configProblems.push(`${name}: ${parsed.why}`);
			else configs.push(parsed.config);
		}

		const configRow: CheckRow =
			configProblems.length > 0
				? failedRow('prefetch-configs', configs.length, 'site configs', configProblems.join(' '))
				: checkRow('prefetch-configs', configs.length, 'site configs', []);
		if (configRow.status !== 'pass') {
			return output([configRow], { site: siteDirectory, prefetched: false }, []);
		}

		// ---- fill the cache --------------------------------------------------

		const client = clientFor(ctx, input.bucket, regionOf(input.region), input.profile);
		const bundles: Bundle[] = [];
		const cacheProblems: RawFinding[] = [];
		let stopped: string | null = null;
		let versions = 0;

		for (const config of configs) {
			for (const entry of config.versions) {
				versions += 1;
				const cacheDirectory = bundleCache(cacheRoot, config.project, entry.commit);
				const filled = fill(
					cacheDirectory,
					config.project,
					entry,
					client,
					input.offline === true,
					ctx,
				);
				if ('why' in filled) {
					// The first bundle that could not be materialised stops the run. Carrying on
					// would produce a site missing one version's pages and a report whose other
					// rows all passed, which is the reassuring direction to be wrong in.
					stopped = filled.why;
					break;
				}
				cacheProblems.push(...filled.problems);
				if (filled.problems.length === 0) {
					bundles.push({
						project: config.project,
						entry,
						manifest: filled.manifest,
						cacheDirectory,
					});
				}
			}
			if (stopped !== null) break;
		}

		if (stopped !== null) {
			return output(
				[configRow, notRunRow('prefetch-cache', 'bundles', stopped)],
				{ site: siteDirectory, prefetched: false, why: stopped },
				[stopped],
			);
		}

		const cacheRow = checkRow(
			'prefetch-cache',
			versions,
			'bundles',
			checkFindings(cacheProblems, ctx.kitVersion),
			`${client.calls} AWS call(s).`,
		);
		if (cacheRow.status !== 'pass') {
			return output([configRow, cacheRow], { site: siteDirectory, prefetched: false }, []);
		}

		// ---- extract into the site -------------------------------------------

		const extracted = extract(bundles, siteDirectory, writer);
		const extractRow = checkRow(
			'prefetch-extract',
			extracted.files,
			'files',
			checkFindings(extracted.problems, ctx.kitVersion),
			`${extracted.written} written, ${extracted.unchanged} already current.`,
		);

		const rows = [
			configRow,
			cacheRow,
			extractRow,
			skew(configs, bundles),
			ignore(writer, siteDirectory),
		];
		return output(
			rows,
			{
				site: siteDirectory,
				prefetched: rows.every((row) => row.status === 'pass'),
				bundles: bundles.length,
				files: extracted.files,
				written: extracted.written,
				unchanged: extracted.unchanged,
				calls: client.calls,
			},
			[
				`${bundles.length} bundle(s), ${extracted.files} file(s): ${extracted.written} written, ` +
					`${extracted.unchanged} already current, ${client.calls} AWS call(s).`,
			],
		);
	},
});

// ---------------------------------------------------------------------------
// Where things live
// ---------------------------------------------------------------------------

/**
 * The cache root when the flag is absent.
 *
 * Not a `Param.fallback`, and that is a deliberate exception to the rule that a default
 * belongs in the parameter table where `--help` and the JSON Schema can see it. A
 * fallback is one literal value; this one is a function of two environment variables, so
 * the closest a table could get is a lie about one of them. The help text spells both out
 * instead, which is the only place a reader would look for it.
 */
function defaultCacheRoot(): string {
	const xdg = process.env['XDG_CACHE_HOME'];
	const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.cache');
	return join(base, 'hexdocs');
}

function bundleCache(cacheRoot: string, project: string, commit: string): string {
	// The same layout as the bucket, deliberately. `bundle.ts` makes this argument for the
	// compiler's output already: when the two agree, a copy is a copy rather than a
	// translation, and somebody comparing a cache with a prefix is comparing like with like.
	return join(cacheRoot, ...bundlePrefix(project, commit, AST_VERSION).split('/'));
}

function localPath(directory: string, key: string): string {
	return join(directory, ...key.split('/'));
}

/** One version of one project, resolved far enough to extract. */
interface Bundle {
	project: string;
	entry: VersionEntry;
	manifest: BundleManifest;
	cacheDirectory: string;
}

// ---------------------------------------------------------------------------
// Reading the site's declarations
// ---------------------------------------------------------------------------

function readSiteConfig(path: string): { config: DocsSiteConfig } | { why: string } {
	let document: unknown;
	try {
		document = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		return { why: `not JSON: ${(error as Error).message}` };
	}
	const parsed = docsSiteConfigSchema.safeParse(document);
	if (!parsed.success) {
		// Three issues rather than all of them. A config that is wrong in twenty ways is
		// usually wrong in one, and a row note is one line on a terminal.
		return {
			why: `does not validate: ${parsed.error.issues
				.slice(0, 3)
				.map((issue) => `/${issue.path.join('/')} ${issue.message}`)
				.join('; ')}`,
		};
	}
	return { config: parsed.data as DocsSiteConfig };
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

/**
 * The client, or one that refuses with a reason.
 *
 * The bucket is resolved here rather than at the top of `run`, because a warm cache never
 * asks for it. A prefetch that demanded `--bucket` before looking at the cache would put
 * a bucket name in the environment of every build of every site, which is the property
 * this command exists to avoid.
 */
function clientFor(
	ctx: Ctx,
	bucket: string | undefined,
	region: string,
	profile: string | undefined,
): MaybeClient {
	const resolved = bucketOf(bucket);
	if ('why' in resolved) {
		const refused = { kind: 'refused' as const, why: resolved.why, credentials: true };
		return {
			why: resolved.why,
			head: () => refused,
			list: () => refused,
			get: () => refused,
			put: () => refused,
			calls: 0,
		};
	}
	const client = s3Client(ctx.exec, { bucket: resolved.bucket, region, profile }, ctx.cwd);
	return {
		why: null,
		head: (key) => client.head(key),
		list: (prefix) => client.list(prefix),
		get: (key, out) => client.get(key, out),
		put: (key, body, media, digest) => client.put(key, body, media, digest),
		get calls(): number {
			return client.calls;
		},
	};
}

/**
 * One bundle in the cache, downloading only what is missing or wrong.
 *
 * Every cached object is re-hashed on every run, warm or cold. That is a local read of a
 * couple of megabytes and it is what lets the extraction trust the cache without asking
 * the network anything: a half-written file from an interrupted download is otherwise
 * indistinguishable from a good one, and it would be copied into the site and built into
 * an image.
 *
 * A `why` is the whole run stopping; a `problems` list is a bundle that downloaded and
 * disagrees with itself. The first is a `not-run` row and the second is findings on a
 * failing one, and the difference is whether anything was examined.
 */
function fill(
	cacheDirectory: string,
	project: string,
	entry: VersionEntry,
	client: MaybeClient,
	offline: boolean,
	ctx: Ctx,
): { manifest: BundleManifest; problems: RawFinding[] } | { why: string } {
	const prefix = bundlePrefix(project, entry.commit, AST_VERSION);
	const problems: RawFinding[] = [];

	const download = (key: string): { why: string } | null => {
		if (offline) {
			return {
				why: `${prefix}/${key} is not in the cache at ${cacheDirectory} and --offline was given, so nothing was downloaded. Run once without --offline to fill the cache.`,
			};
		}
		if (client.why !== null) return { why: client.why };
		const path = localPath(cacheDirectory, key);
		mkdirSync(dirname(path), { recursive: true });
		const result = client.get(`${prefix}/${key}`, path);
		if (result.kind === 'ok') return null;
		if (result.kind === 'absent') {
			return {
				why: `${prefix}/${key} is not in the bucket. Version "${entry.label}" points at a commit whose bundle was never published, so every page of it would 404.`,
			};
		}
		return { why: result.why };
	};

	let loaded = readCachedManifest(join(cacheDirectory, MANIFEST_KEY));
	if (loaded === null) {
		const failure = download(MANIFEST_KEY);
		if (failure !== null) return failure;
		loaded = readCachedManifest(join(cacheDirectory, MANIFEST_KEY));
		if (loaded === null) {
			return {
				why: `${prefix}/${MANIFEST_KEY} downloaded and is not a manifest this toolchain can read. Check the AST major: a bundle from a newer kit is not malformed, it is one this submodule cannot mount.`,
			};
		}
	}
	const { manifest, bytes } = loaded;

	// The only integrity pin this design has, and it exists only once `hexdocs sync` has
	// written one. A manifest cannot carry its own digest, so the value lives downstream,
	// in the repository that decided to trust that bundle.
	const manifestDigest = sha256Hex(bytes);
	if (entry.digest !== undefined && entry.digest !== manifestDigest) {
		problems.push(
			raw(
				'bundle-digest-mismatch',
				{ kind: 'file', file: `${prefix}/${MANIFEST_KEY}` },
				null,
				`Version "${entry.label}" pins manifest digest ${entry.digest.slice(0, 12)} and the bundle for that commit is ${manifestDigest.slice(0, 12)}.`,
				{
					remediation:
						'Either something republished a sha that already had a bundle, which write-once should have refused, or the pinned digest was written against a different commit. Run hexdocs sync against the bundle this version means and read the diff before committing it.',
				},
			),
		);
	}
	// The key is not trusted; the manifest self-declares and this compares. A manifest
	// under one prefix claiming another commit means two bundles have been confused, and
	// every digest below would then be checked against the wrong authority.
	if (manifest.project !== project || manifest.commit !== entry.commit) {
		problems.push(
			raw(
				'bundle-digest-mismatch',
				{ kind: 'file', file: `${prefix}/${MANIFEST_KEY}` },
				null,
				`The manifest at ${prefix} says it is ${manifest.project} at ${manifest.commit.slice(0, 12)}, and this version asks for ${project} at ${entry.commit.slice(0, 12)}.`,
				{
					remediation:
						'Establish which commit wrote that prefix before publishing anything else into it. Nothing downstream can tell the two apart, because every reader trusts the manifest.',
				},
			),
		);
	}
	if (problems.length > 0) return { manifest, problems };

	let downloaded = 0;
	for (const object of manifest.objects) {
		const path = localPath(cacheDirectory, object.key);
		if (existsSync(path) && sha256Hex(readFileSync(path)) === object.digest) continue;
		const failure = download(object.key);
		if (failure !== null) return failure;
		downloaded += 1;
		// The stored digest, against the bytes `get-object` wrote. `s3api get-object` does
		// not decode `Content-Encoding`, so a gzipped object arrives as the member that was
		// stored and this comparison is direct rather than one taken after a decode.
		const found = sha256Hex(readFileSync(path));
		if (found !== object.digest) {
			problems.push(
				raw(
					'bundle-digest-mismatch',
					{ kind: 'file', file: `${prefix}/${object.key}` },
					null,
					`${object.key} downloaded as ${found.slice(0, 12)} and the manifest records ${object.digest.slice(0, 12)} for the stored bytes.`,
					{
						remediation:
							'The download is not what the manifest names. Delete the cache directory and run again; if it repeats, the object in the bucket is wrong and the commit has to be recompiled at a new AST major, because write-once will not let it be replaced.',
					},
				),
			);
		}
	}
	if (downloaded > 0) {
		ctx.log(
			`  ${project} ${entry.label}: ${downloaded} object(s) downloaded into ${cacheDirectory}`,
		);
	}

	return { manifest, problems };
}

/**
 * A cached manifest, or `null` for every reason a caller would treat the same way.
 *
 * Absent, truncated, not JSON and not a manifest this AST major understands all mean the
 * same thing to `fill`: fetch it. Distinguishing them here would be a set of messages
 * about a cache file, which is a directory a person is meant to be able to delete.
 */
function readCachedManifest(path: string): { manifest: BundleManifest; bytes: Buffer } | null {
	if (!existsSync(path)) return null;
	const bytes = readFileSync(path);
	let document: unknown;
	try {
		document = JSON.parse(bytes.toString('utf8'));
	} catch {
		return null;
	}
	const parsed = bundleManifestSchema.safeParse(document);
	return parsed.success ? { manifest: parsed.data, bytes } : null;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * A file the bundle carries, and where it goes in the site.
 *
 * Built from the manifest's own records rather than by taking key strings apart, so the
 * expected uncompressed digest travels with the destination. Parsing
 * `pages/ja/guide/first-tag.json.gz` back into a locale and a slug would be a second
 * implementation of `pageKey`, and the two would disagree the first time a slug contained
 * something one of them did not expect.
 */
interface Extraction {
	/** The bundle key, relative to the `ast-N` prefix. */
	key: string;
	destination: string;
	/** sha256 of what lands at `destination`, which is the uncompressed digest. */
	digest: string;
	/** Assets, which cannot survive a decode and re-encode round trip. */
	binary: boolean;
}

/**
 * Every file the manifest says this bundle contains, with its destination.
 *
 * The cross-check afterwards is the point of building it this way. `manifest.objects` is
 * the flat list of what is stored, and these entries come from the page, search, llms and
 * asset records, so comparing the two key sets in both directions catches an object
 * nothing would extract (a file the site would silently lack) and a record with no object
 * behind it (a fetch that would 404). Neither is visible from either list alone.
 */
function planExtraction(
	manifest: BundleManifest,
	bundleDirectory: string,
	publicDirectory: string,
	manifestDigest: string,
): { entries: Extraction[]; problems: RawFinding[] } {
	const entries: Extraction[] = [
		{
			key: MANIFEST_KEY,
			destination: join(bundleDirectory, MANIFEST_KEY),
			digest: manifestDigest,
			binary: false,
		},
	];

	for (const [slug, page] of Object.entries(manifest.pages)) {
		for (const locale of manifest.locales) {
			const record = page.locales[locale];
			if (record === undefined) continue;
			entries.push({
				key: pageKey(locale, slug),
				destination: localPath(bundleDirectory, `pages/${locale}/${slug}.json`),
				digest: record.digest,
				binary: false,
			});
			entries.push({
				key: rawKey(locale, slug),
				destination: localPath(bundleDirectory, `raw/${locale}/${slug}.md`),
				digest: record.rawDigest,
				binary: false,
			});
		}
	}

	for (const locale of manifest.locales) {
		const search = manifest.search[locale];
		if (search !== undefined) {
			entries.push({
				key: searchKey(locale),
				destination: localPath(publicDirectory, `search/${locale}.idx.json`),
				digest: search.digest,
				binary: false,
			});
		}
		const llms = manifest.llms[locale];
		if (llms !== undefined) {
			entries.push({
				key: llmsKey(locale),
				destination: localPath(bundleDirectory, `llms/${locale}.txt`),
				digest: llms.digest,
				binary: false,
			});
		}
	}

	for (const asset of manifest.assets) {
		entries.push({
			key: assetKey(asset.sha256, asset.ext),
			destination: localPath(publicDirectory, `assets/${asset.sha256}.${asset.ext}`),
			digest: asset.sha256,
			binary: true,
		});
	}

	const derived = new Set(entries.map((entry) => entry.key));
	const stored = new Set(manifest.objects.map((object) => object.key));
	const problems: RawFinding[] = [];
	for (const key of [...stored].filter((candidate) => !derived.has(candidate)).sort()) {
		problems.push(
			raw(
				'bundle-missing-object',
				{ kind: 'file', file: key },
				null,
				`${key} is stored in this bundle and no page, search, llms or asset record names it, so nothing would copy it into the site.`,
				{
					remediation:
						'The records and the object list are written by the same compile, so a key in one and not in the other is a compiler defect rather than something to work around. Recompile the commit and compare the two lists.',
				},
			),
		);
	}
	for (const key of [...derived]
		.filter((candidate) => candidate !== MANIFEST_KEY && !stored.has(candidate))
		.sort()) {
		problems.push(
			raw(
				'bundle-missing-object',
				{ kind: 'file', file: key },
				null,
				`${key} is named by a manifest record and is not in the stored object list, so there is nothing to download.`,
				{
					remediation:
						'Recompile the commit. A record with no object behind it renders as a link the site draws and the bucket cannot answer.',
				},
			),
		);
	}

	return { entries, problems };
}

/**
 * Bytes to a file, for the one thing `Writer` cannot carry.
 *
 * `Writer.write` takes a string and encodes it as UTF-8, which is right for every text
 * file here and destroys a PNG. Assets are the only binary a bundle holds, so this is the
 * only place it matters. The boundary the `Writer` exists to police is unaffected:
 * everything in this command, this call included, sits behind one `ctx.write === null`
 * refusal at the top, so a context with no writer writes nothing by either route. The
 * honest fix is a byte-taking method on `Writer`, which is a change to
 * `kit/src/io/write.ts` rather than to this file.
 *
 * Returns false when the bytes were already there, matching `Writer.write`, so a re-run
 * counts as unchanged rather than as a write and the idempotency claim stays measurable.
 */
function writeBytes(path: string, bytes: Buffer): boolean {
	if (existsSync(path) && readFileSync(path).equals(bytes)) return false;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
	return true;
}

function extract(
	bundles: readonly Bundle[],
	siteDirectory: string,
	writer: Writer,
): { files: number; written: number; unchanged: number; problems: RawFinding[] } {
	let files = 0;
	let written = 0;
	let unchanged = 0;
	const problems: RawFinding[] = [];

	for (const bundle of bundles) {
		const bundleDirectory = join(siteDirectory, ...BUNDLE_DIR, bundle.project, bundle.entry.label);
		const publicDirectory = join(siteDirectory, ...PUBLIC_DIR, bundle.project, bundle.entry.label);
		const manifestBytes = readFileSync(join(bundle.cacheDirectory, MANIFEST_KEY));
		const plan = planExtraction(
			bundle.manifest,
			bundleDirectory,
			publicDirectory,
			sha256Hex(manifestBytes),
		);
		problems.push(...plan.problems);
		// A bundle whose key sets disagree is not extracted at all. Copying the part that
		// does line up would leave a site that builds and is missing files, which is the
		// failure this whole command exists to make impossible.
		if (plan.problems.length > 0) continue;

		for (const entry of plan.entries) {
			files += 1;
			const stored = readFileSync(localPath(bundle.cacheDirectory, entry.key));
			const bytes = isGzipped(entry.key) ? gunzipMember(stored) : stored;

			if (entry.binary) {
				const found = sha256Hex(bytes);
				if (found !== entry.digest) {
					problems.push(uncompressedMismatch(entry.key, entry.digest, found));
					continue;
				}
				if (writeBytes(entry.destination, bytes)) written += 1;
				else unchanged += 1;
				continue;
			}

			// Hashed after the decode rather than before it, so what is compared is exactly
			// what is written. Decoding and re-encoding is byte-identical for valid UTF-8,
			// and this is what proves it per file rather than assuming it.
			const text = bytes.toString('utf8');
			const found = sha256Hex(utf8Bytes(text));
			if (found !== entry.digest) {
				problems.push(uncompressedMismatch(entry.key, entry.digest, found));
				continue;
			}
			if (writer.write(entry.destination, text)) written += 1;
			else unchanged += 1;
		}
	}

	return { files, written, unchanged, problems };
}

function uncompressedMismatch(key: string, expected: string, found: string): RawFinding {
	return raw(
		'bundle-digest-mismatch',
		{ kind: 'file', file: key },
		null,
		`${key} decompresses to ${found.slice(0, 12)} and the manifest records ${expected.slice(0, 12)} for the file the site serves.`,
		{
			remediation:
				'The stored bytes matched their own digest, so the download is intact and the manifest disagrees with itself about the uncompressed content. Recompile the commit; a bundle is a product of a sha and nothing else.',
		},
	);
}

// ---------------------------------------------------------------------------
// What the site will route, and what git should ignore
// ---------------------------------------------------------------------------

/**
 * The bundle's page set against the one the host will route.
 *
 * `route.ts` names the consequence: a slug the bundle carries and the config does not
 * renders, links from the sidebar and appears in prev and next, while the host's
 * `isLocalisedPath` returns false for it, so the page ships with no canonical, no
 * alternates and no `noindex`. The reverse is eight hreflang alternates pointing at eight
 * 404s. Both directions fail here, at build time, where somebody is watching.
 *
 * Only the default version is compared, because `site.pages` describes the default
 * version and nothing else: a pinned version lives at `/v/<label>/`, which
 * `isLocalisedPath` deliberately does not cover.
 */
function skew(configs: readonly DocsSiteConfig[], bundles: readonly Bundle[]): CheckRow {
	const problems: string[] = [];
	let compared = 0;

	for (const config of configs) {
		const entry = config.versions.find((version) => version.default === true);
		if (entry === undefined) {
			// `versionTableProblems` is what reports this properly and it is not this
			// command's job. Saying nothing would leave the row counting one fewer config
			// than it read, which is the shape of a check that quietly stopped covering
			// something.
			problems.push(`${config.project} has no default version, so no page set could be compared.`);
			continue;
		}
		const bundle = bundles.find(
			(candidate) => candidate.project === config.project && candidate.entry.label === entry.label,
		);
		if (bundle === undefined) {
			problems.push(`${config.project} has no materialised bundle for its default version.`);
			continue;
		}
		compared += 1;
		const { inBundleOnly, inConfigOnly } = pageSkew(bundle.manifest, config);
		if (inBundleOnly.length > 0) {
			problems.push(
				`${config.project} carries ${inBundleOnly.length} page(s) the site config does not list (${inBundleOnly.slice(0, 3).join(', ')}). Run hexdocs sync.`,
			);
		}
		if (inConfigOnly.length > 0) {
			problems.push(
				`${config.project} lists ${inConfigOnly.length} page(s) the bundle does not carry (${inConfigOnly.slice(0, 3).join(', ')}). Run hexdocs sync.`,
			);
		}
	}

	return problems.length > 0
		? failedRow('prefetch-skew', compared, 'page sets', problems.join(' '))
		: checkRow('prefetch-skew', compared, 'page sets', []);
}

/**
 * Both destination trees, in the site's own `.gitignore`.
 *
 * Neither consumer has an entry today and `apps/front` has no `.gitignore` at all, so
 * this creates one. The entries are relative to the site directory, which is where the
 * file lives, so neither can match anything outside it. Written through the `Writer`, so
 * a second run with the lines already present writes nothing.
 */
function ignore(writer: Writer, siteDirectory: string): CheckRow {
	const path = join(siteDirectory, '.gitignore');
	const existing = writer.read(path);
	const present = new Set((existing ?? '').split('\n').map((line) => line.trim()));
	const missing = IGNORE_ENTRIES.filter((entry) => !present.has(entry));
	if (missing.length === 0) {
		return checkRow('prefetch-gitignore', IGNORE_ENTRIES.length, 'ignore entries', []);
	}

	const block = present.has(IGNORE_HEADER) ? missing : [IGNORE_HEADER, ...missing];
	const body =
		existing === undefined || existing.trim() === ''
			? `${block.join('\n')}\n`
			: `${existing.replace(/\n+$/, '')}\n\n${block.join('\n')}\n`;
	writer.write(path, body);
	return checkRow('prefetch-gitignore', IGNORE_ENTRIES.length, 'ignore entries', []);
}

/** The one shape every return takes, so a field cannot be forgotten on one path. */
function output(
	rows: readonly CheckRow[],
	data: JsonValue,
	lines: readonly string[],
): { data: JsonValue; lines: readonly string[]; envelope: null; rows: readonly CheckRow[] } {
	return { data, lines, envelope: null, rows };
}
