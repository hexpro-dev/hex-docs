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
 *
 * **The two trees hold exactly what the configs name, and nothing else.** A relabel, a
 * removed version or a removed project leaves directories behind, and a glob over the
 * bundle tree builds every one of them into the server while Vite copies every stale
 * `public/_docs/<label>` into the client build, where it is served. So after every bundle
 * is in the cache, and before anything is extracted, every file under either tree that no
 * planned extraction writes is removed. Pruning first is also what makes a relabel by case
 * alone work on a case-insensitive filesystem: the old-cased directory is emptied and
 * removed, and extraction then creates it again in the configured case.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { AST_VERSION } from '../../../src/contracts/ast.js';
import {
	checkRow,
	failedRow,
	notRunRow,
	type CheckRow,
} from '../../../src/contracts/diagnostics.js';
import {
	BUNDLE_TREE,
	MANIFEST_KEY,
	PUBLIC_TREE,
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
import { docsSiteConfigSchema, versionTableProblems } from '../contracts/config.schema.js';
import { defineCommand, type Ctx, type Writer } from '../registry/command.js';
import { checkFindings, s3Client, type S3Client } from '../s3/client.js';

import { bucketOf, regionOf, rootOf } from './common.js';
import { PREFETCH_PARAMS, PREFETCH_POSITIONALS } from './prefetch-params.js';

/** Where `<project>.docs.json` lives, relative to the consuming site directory. */
const DOCS_DIR = ['app', 'docs'];

/** Where page payloads, raw markdown, `llms.txt` and the manifest land. */
const BUNDLE_DIR = [...DOCS_DIR, BUNDLE_TREE];

/** Where the search index and the assets land: the only tree the browser can reach. */
const PUBLIC_DIR = ['public', PUBLIC_TREE];

/**
 * The sentence a credentials refusal carries, and the one thing it has to steer away from.
 *
 * The AWS CLI's own message ends by telling the reader to run `aws configure`. In this
 * estate the default profile holds no credentials on purpose, so that an unpinned command
 * fails rather than acting on whichever account a shell last signed in to, and following
 * the CLI's advice undoes exactly that. Every cold build of a consuming site needs this
 * account's credentials, which no build of one needed before documentation was mounted in
 * it, so the message a build log shows is the one place to say which knob is the right one.
 */
const CREDENTIALS_ADVICE =
	'Set AWS_PROFILE, or pass --profile, to a profile for the AWS account that owns the bundle store, rather than running aws configure or signing in to another account.';

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
		'Reads every <project>.docs.json under the site, caches each labelled commit under a commit-addressed cache directory, verifies both the stored and the uncompressed digest of every file, and writes the page payloads into the app source and the search index and the assets into public/. Anything under those two trees that no configured version writes is removed first, so a relabelled or removed version leaves nothing behind to be built. A warm cache makes no network call and needs no AWS credentials, which is what makes this safe to run from a prebuild hook on a laptop and in a container. Run it before every build of a site that mounts documentation.',
	params: PREFETCH_PARAMS,
	positionals: PREFETCH_POSITIONALS,
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

		// A file where the directory belongs, or a directory that cannot be listed, is a named
		// failure here rather than a throw. `existsSync` answers true for a regular file, so the
		// listing below used to throw ENOTDIR before the shape check that claims to refuse this
		// was ever reached, and a throw reaches the CLI as a stack under a sentence calling it a
		// bug in hexdocs. Nothing has been fetched, pruned or written yet.
		let names: string[];
		try {
			if (!statSync(docsDirectory).isDirectory()) {
				const why = `${DOCS_DIR.join('/')} is not a directory, so no site config can be read out of it. Replace it with a directory holding the <project>.docs.json files, or point --site at the directory that holds app/docs.`;
				return output(
					[failedRow('prefetch-configs', 1, 'site configs', why)],
					{ site: siteDirectory, prefetched: false, why },
					[why],
				);
			}
			names = readdirSync(docsDirectory).sort();
		} catch (error) {
			const why = `${DOCS_DIR.join('/')} could not be read (${(error as NodeJS.ErrnoException).code}), so no site config was. Nothing was downloaded, pruned or written.`;
			return output(
				[failedRow('prefetch-configs', 1, 'site configs', why)],
				{ site: siteDirectory, prefetched: false, why },
				[why],
			);
		}

		const configs: DocsSiteConfig[] = [];
		const configProblems: string[] = [];
		const projects = new Map<string, string>();
		let read = 0;
		for (const name of names) {
			if (!name.endsWith('.docs.json')) continue;
			const path = join(docsDirectory, name);
			let isFile: boolean;
			try {
				isFile = statSync(path).isFile();
			} catch (error) {
				// A link to nothing, or an entry that cannot be looked at. Counted and failed
				// rather than skipped: a config left out of this loop is a project whose trees
				// the prune then removes, because no plan names them.
				read += 1;
				configProblems.push(
					`${name} could not be read (${(error as NodeJS.ErrnoException).code}).`,
				);
				continue;
			}
			if (!isFile) continue;
			read += 1;
			const parsed = readSiteConfig(path);
			if ('why' in parsed) {
				configProblems.push(`${name}: ${parsed.why}`);
				continue;
			}
			// Before anything is fetched, extracted or pruned, because each of these is a
			// table with no single answer. Two defaults leave the skew row nothing to compare,
			// and two labels that fold to one name extract two bundles into one directory on a
			// case-insensitive filesystem. `sync` already refused these; a config written or
			// edited by hand reached this command with nothing in the way.
			const table = versionTableProblems(parsed.config);
			if (table.length > 0) {
				configProblems.push(`${name}: ${table.join(' ')}`);
				continue;
			}
			// Two configs naming one project extract into one `<tree>/<project>/` directory,
			// and each prune would remove what the other one wrote. Compared exactly, because
			// `PROJECT_ID_PATTERN` admits only lower case, so exact equality already is the
			// case-folded comparison; a pattern that ever admits upper case has to fold here.
			const earlier = projects.get(parsed.config.project);
			if (earlier !== undefined) {
				configProblems.push(
					`${name} and ${earlier} both declare the project "${parsed.config.project}". Each version extracts into ${[...BUNDLE_DIR, parsed.config.project].join('/')}/, so the two would overwrite each other and each prune would delete the other one's files. Keep one config per project.`,
				);
				continue;
			}
			projects.set(parsed.config.project, name);
			configs.push(parsed.config);
		}

		const configRow: CheckRow =
			configProblems.length > 0
				? failedRow('prefetch-configs', read, 'site configs', configProblems.join(' '))
				: checkRow('prefetch-configs', configs.length, 'site configs', []);
		if (configRow.status !== 'pass') {
			return output([configRow], { site: siteDirectory, prefetched: false }, []);
		}

		// ---- the shape of the two trees ----------------------------------------

		// Before the cache is touched, so a tree this command will not write into costs no
		// network call and leaves the cache as it was.
		const shape = treeShape(siteDirectory);
		const treeRow: CheckRow =
			shape.problems.length > 0
				? failedRow(
						'prefetch-trees',
						shape.examined,
						'entries',
						`${shape.problems.join(' ')} Nothing was downloaded, pruned or written. ${TREE_SHAPE_REASON}`,
					)
				: checkRow('prefetch-trees', shape.examined, 'entries', []);
		if (treeRow.status !== 'pass') {
			return output([configRow, treeRow], { site: siteDirectory, prefetched: false }, []);
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
					bundles.push({ config, entry, manifest: filled.manifest, cacheDirectory });
				}
			}
			if (stopped !== null) break;
		}

		if (stopped !== null) {
			return output(
				[configRow, treeRow, notRunRow('prefetch-cache', 'bundles', stopped)],
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
			return output([configRow, treeRow, cacheRow], { site: siteDirectory, prefetched: false }, []);
		}

		// ---- prune, then extract into the site ----------------------------------

		const plans = bundles.map((bundle) => planFor(bundle, siteDirectory));
		const planProblems = plans.flatMap((plan) => plan.problems);
		let extractRow: CheckRow;
		let extracted = { files: 0, written: 0, unchanged: 0 };
		let removed = 0;
		if (planProblems.length > 0) {
			// A bundle whose key sets disagree is not extracted, nothing else is either, and
			// nothing is pruned. The prune's keep set is the plan, so pruning against a plan
			// known to be wrong could delete a file the corrected bundle will need, and
			// extracting the bundles that did line up would leave a site that builds and is
			// missing a version, which is the failure this command exists to make impossible.
			extractRow = checkRow(
				'prefetch-extract',
				plans.reduce((total, plan) => total + plan.entries.length, 0),
				'files',
				checkFindings(planProblems, ctx.kitVersion),
				'Nothing was pruned or written.',
			);
		} else {
			// One catch around both, because the filesystem can refuse either of them and the
			// shape check above only looked as far as the label directories, and only at whether
			// each level could be read. Below a label, and at any level that can be read and not
			// written, the refusal arrives here part way through: the prune may already have
			// emptied the old label, and extraction may already have written files. Stopping at
			// the first refusal is deliberate, because carrying on into a tree that cannot be
			// written produces more of the same. Without the catch it reached the CLI as a stack
			// under a sentence calling it a bug in hexdocs, with no row saying what had gone.
			const before = writer.removed.length;
			try {
				removed = prune(
					siteDirectory,
					new Set(plans.flatMap((plan) => plan.entries.map((entry) => entry.destination))),
					writer,
				);
				const done = extract(plans, writer);
				extracted = done;
				extractRow = checkRow(
					'prefetch-extract',
					done.files,
					'files',
					checkFindings(done.problems, ctx.kitVersion),
					`${done.written} written, ${done.unchanged} already current, ${removed} removed.`,
				);
			} catch (error) {
				const refused = filesystemRefusal(error);
				if (refused === null) throw error;
				removed = writer.removed.length - before;
				const shown = relative(siteDirectory, refused.path).split(sep).join('/');
				extractRow = failedRow(
					'prefetch-extract',
					plans.reduce((total, plan) => total + plan.entries.length, 0),
					'files',
					`Prefetch stopped at ${shown}: ${refused.syscall} was refused with ${refused.code}. ${removed} stale ${removed === 1 ? 'entry' : 'entries'} had already been removed and some files may already have been written, so the two trees are part way between what they held and what the configs name. Fix the mode or the owner of that path and run prefetch again. The cache row passed, so every bundle is already on this machine and that run needs no download.`,
				);
			}
		}

		const rows = [configRow, treeRow, cacheRow, extractRow, skew(bundles)];
		return output(
			rows,
			{
				site: siteDirectory,
				prefetched: rows.every((row) => row.status === 'pass'),
				bundles: bundles.length,
				files: extracted.files,
				written: extracted.written,
				unchanged: extracted.unchanged,
				removed,
				calls: client.calls,
			},
			[
				`${bundles.length} bundle(s), ${extracted.files} file(s): ${extracted.written} written, ` +
					`${extracted.unchanged} already current, ${removed} removed, ${client.calls} AWS call(s).`,
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
	config: DocsSiteConfig;
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
		// `credentials: false`: the reason is the bucket, and a sentence about which profile
		// to sign with would send somebody to fix a step they have not reached yet.
		const refused = { kind: 'refused' as const, why: resolved.why, credentials: false };
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
		return { why: result.credentials ? `${result.why} ${CREDENTIALS_ADVICE}` : result.why };
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

/** A bundle and every file it lands in the site, planned before anything is touched. */
interface Plan {
	bundle: Bundle;
	entries: Extraction[];
	problems: RawFinding[];
}

function planFor(bundle: Bundle, siteDirectory: string): Plan {
	const project = bundle.config.project;
	const label = bundle.entry.label;
	const manifestBytes = readFileSync(join(bundle.cacheDirectory, MANIFEST_KEY));
	const plan = planExtraction(
		bundle.manifest,
		join(siteDirectory, ...BUNDLE_DIR, project, label),
		join(siteDirectory, ...PUBLIC_DIR, project, label),
		sha256Hex(manifestBytes),
	);
	return { bundle, ...plan };
}

function extract(
	plans: readonly Plan[],
	writer: Writer,
): { files: number; written: number; unchanged: number; problems: RawFinding[] } {
	let files = 0;
	let written = 0;
	let unchanged = 0;
	const problems: RawFinding[] = [];

	for (const { bundle, entries } of plans) {
		for (const entry of entries) {
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
// The two trees: their shape, and what is left in them
// ---------------------------------------------------------------------------

/** Said once on the row rather than once per entry, because every entry has the same fix. */
const TREE_SHAPE_REASON =
	'Every directory from the site down to a label directory has to be a real one. A symbolic link there would carry every write and every prune somewhere outside the site, so it is refused rather than followed or removed. So is a file standing in for public or either tree root, and anything inside the trees that is neither a directory nor a regular file, because prefetch made none of them and it is not for this command to delete them. Replace it with a real directory, or remove it. A stray regular file inside either tree, a Finder .DS_Store included, is not refused: it is removed with the other stale files.';

/**
 * Every entry from the site directory down to the label directories, measured with `lstat`.
 *
 * A symbolic link anywhere on that path is refused rather than followed or removed.
 * Measured in the step 8 critique: with `_bundles/<project>/<label>` a link to a directory outside the site,
 * `mkdirSync(..., { recursive: true })` and a write under it landed in the target, so
 * extraction writes through a link and a prune that skipped links would leave exactly that
 * in place. Removing the link instead would be a delete of something this command did not
 * create, at a level where nothing it writes is a link.
 *
 * Above the trees, `public` and the two tree roots have to be directories, and a file in
 * place of one is refused: those are the site's own paths, and the only way past a file
 * there is deleting it. `app` and `app/docs` are looked at and counted as well, but a file
 * standing in for either never reaches this: the configs are read out of `app/docs` first,
 * so a file there fails the configs row, and a file at `app` leaves no `app/docs` to find.
 *
 * Inside the trees, at the project and label levels, a regular file is not a problem here.
 * It is not a planned destination, so `prune` removes it like any other stale file. That
 * is the case this rule was changed for: Finder writes a `.DS_Store` into every directory
 * it opens, the deploy host is a Mac, and refusing one failed the production prebuild over
 * a file nobody would ever want built. Anything else at those levels, a named pipe, a
 * socket or a device, is still refused on the row. Prefetch writes none of them, the
 * change was made for the regular file Finder writes and not for these, and loosening the
 * rule further than the case that needed it is a delete nobody decided on. A symbolic
 * link at those levels is still refused, for the reason
 * above. Below a label directory is where prefetch's own territory starts, and `prune`
 * owns everything there, links included.
 *
 * An entry that cannot be looked at, a directory with no search or read permission, is a
 * problem on the same row rather than a throw. A throw reaches the CLI as a stack trace
 * under a sentence calling it a bug in hexdocs, and a mode on a site's own directory is not
 * one. This looks only as far as the label directories and only asks whether each level can
 * be read, so a refusal below a label, or on a level that can be read and not written, comes
 * from the prune or from extraction instead, and `run` turns it into a failing
 * `prefetch-extract` row.
 *
 * `examined` counts every entry that was there to look at, a regular file left for the
 * prune included. The site's `app/docs` always is, because the configs were read out of it,
 * so a clean site examines at least two.
 */
function treeShape(siteDirectory: string): { examined: number; problems: string[] } {
	let examined = 0;
	const problems: string[] = [];
	const shown = (path: string): string => relative(siteDirectory, path).split(sep).join('/');

	const unreadable = (path: string, error: unknown): false => {
		problems.push(`${shown(path)} could not be read (${(error as NodeJS.ErrnoException).code}).`);
		return false;
	};

	/**
	 * `true` when the entry is a real directory worth descending into.
	 *
	 * `inTree` is set for an entry at the project or label level, where a regular file is
	 * left for `prune` rather than refused.
	 */
	const directory = (path: string, inTree: boolean): boolean => {
		let stats;
		try {
			stats = lstatSync(path);
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : unreadable(path, error);
		}
		examined += 1;
		if (stats.isSymbolicLink()) {
			problems.push(`${shown(path)} is a symbolic link.`);
			return false;
		}
		if (stats.isDirectory()) return true;
		if (!inTree) {
			problems.push(`${shown(path)} is not a directory.`);
		} else if (!stats.isFile()) {
			problems.push(`${shown(path)} is neither a directory nor a regular file.`);
		}
		return false;
	};

	const entries = (path: string): string[] => {
		try {
			return readdirSync(path).sort();
		} catch (error) {
			unreadable(path, error);
			return [];
		}
	};

	for (const tree of [BUNDLE_DIR, PUBLIC_DIR]) {
		let path = siteDirectory;
		let real = true;
		for (const segment of tree) {
			path = join(path, segment);
			real = directory(path, false);
			if (!real) break;
		}
		if (!real) continue;
		for (const project of entries(path)) {
			const projectPath = join(path, project);
			if (!directory(projectPath, true)) continue;
			for (const label of entries(projectPath)) directory(join(projectPath, label), true);
		}
	}

	return { examined, problems };
}

/**
 * Removes everything under the two trees that no planned extraction writes, and returns
 * how many entries went.
 *
 * What is kept is exactly the set of destinations the plans produced, compared as paths
 * built by the same `join` from the same site directory, so the keep set and the files
 * extraction writes cannot drift into disagreeing and oscillating between runs. A regular
 * file with exactly one link, at a kept path, stays; anything else goes: a file no plan
 * names, a symbolic link at any depth (unlinked, never followed, so what it points at
 * survives), a hard link at a kept path (the same escape by another link type, and removed
 * for the same reason), and then every directory the walk left empty **that no planned
 * destination sits under**. The two tree roots themselves are never removed.
 *
 * That last clause is what keeps the dry run readable. A stray file standing where a label
 * directory goes leaves its project directory empty for a moment, and without the clause
 * the run would report removing a directory it recreates two lines later, which reads as
 * churn rather than as the one stale file it actually removed.
 *
 * It runs only once every earlier row has passed, which is what keeps a laptop without
 * credentials, or a config that stopped validating, from losing an extracted tree it can
 * no longer rebuild. The shape check has already refused a link, and anything that is
 * neither a directory nor a regular file, at every level down to a label directory, and
 * left a regular file there for this walk, which removes it because no plan names it. The
 * root is looked at again here rather than trusted, because the cache fill in between can
 * take as long as a download.
 */
function prune(siteDirectory: string, keep: ReadonlySet<string>, writer: Writer): number {
	const before = writer.removed.length;

	// Every directory a kept file sits in, and every directory above it. Extraction is about
	// to create these, so an empty one is not stale.
	const wanted = new Set<string>();
	for (const path of keep) {
		let directory = dirname(path);
		while (!wanted.has(directory) && directory !== dirname(directory)) {
			wanted.add(directory);
			directory = dirname(directory);
		}
	}

	/** Returns whether the directory was left holding nothing. */
	const walk = (directory: string): boolean => {
		let remaining = 0;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			// `withFileTypes` answers from the directory entry itself, as `lstat` does, so a
			// link to a directory reports as a link here and is never descended into.
			if (entry.isDirectory()) {
				if (walk(path) && !wanted.has(path)) writer.remove(path);
				else remaining += 1;
			} else if (entry.isFile() && keep.has(path) && lstatSync(path).nlink === 1) {
				// A hard link answers as a regular file, and extraction's write opens the path
				// and truncates it, which rewrites the inode every other name for it shares.
				// Unlinking removes only this name, so what the other names hold survives and
				// extraction writes a file of its own.
				remaining += 1;
			} else {
				writer.remove(path);
			}
		}
		return remaining === 0;
	};

	for (const tree of [BUNDLE_DIR, PUBLIC_DIR]) {
		const root = join(siteDirectory, ...tree);
		let real = false;
		try {
			real = lstatSync(root).isDirectory();
		} catch {
			// Absent, which is every first run: there is nothing to prune.
		}
		if (real) walk(root);
	}

	// The writer's own list rather than a count kept here, so the number on the row is the
	// number of paths the writer says went.
	return writer.removed.length - before;
}

// ---------------------------------------------------------------------------
// What the site will route
// ---------------------------------------------------------------------------

/**
 * The bundle's page set against the one the host will route.
 *
 * The consumer's route rows and its sitemap are derived from `pages`, not from the bundle.
 * So a slug the bundle carries and the config does not is a page the sidebar and prev and
 * next link to with no route behind it, and a slug the config lists and the bundle does not
 * is a routed, sitemapped address with nothing to serve. Both directions fail here, at build
 * time, where somebody is watching.
 *
 * Only the default version is compared, because `site.pages` describes the default
 * version and nothing else: a pinned version lives at `/v/<label>/`.
 *
 * Every config contributes exactly one default bundle by the time this runs:
 * `versionTableProblems` refused a table without exactly one default on the configs row,
 * and the cache row refused a run in which any version failed to fill. So the count is one
 * per config, and a run that somehow compared none would still fail on a zero.
 */
function skew(bundles: readonly Bundle[]): CheckRow {
	const problems: string[] = [];
	let compared = 0;

	for (const bundle of bundles) {
		if (bundle.entry.default !== true) continue;
		const { config } = bundle;
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
 * The path, the call and the code of an error the filesystem raised, or `null` for anything
 * else.
 *
 * Narrow on purpose. Only an error carrying all three is a refusal about a named path that a
 * person can go and fix; anything without them is a defect in this command, and rethrowing it
 * is what keeps that a stack trace rather than a row that reads like an environment problem.
 */
function filesystemRefusal(error: unknown): { path: string; syscall: string; code: string } | null {
	if (typeof error !== 'object' || error === null) return null;
	const { path, syscall, code } = error as NodeJS.ErrnoException;
	return typeof path === 'string' && typeof syscall === 'string' && typeof code === 'string'
		? { path, syscall, code }
		: null;
}

/** The one shape every return takes, so a field cannot be forgotten on one path. */
function output(
	rows: readonly CheckRow[],
	data: JsonValue,
	lines: readonly string[],
): { data: JsonValue; lines: readonly string[]; envelope: null; rows: readonly CheckRow[] } {
	return { data, lines, envelope: null, rows };
}
