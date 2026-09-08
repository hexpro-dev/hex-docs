/**
 * `hexdocs sync`: write what the bundle says back into `<project>.docs.json`.
 *
 * Three fields, and no others: `pages`, `hidden` and `versions[].digest`. Their contracts
 * in `src/contracts/site.ts` all name this command as their writer, and everything else
 * in that file is a human decision. `navLabel` in particular exists so that installing
 * docs needs no locale-file edit, and a command that rewrote it would take that with it.
 *
 * It is a surgical edit, not a reserialise. Nothing here parses the file and writes it
 * back out: the fields this command does not own keep their bytes, their key order and
 * their packing, and the trailing newline survives because no edit reaches the end of the
 * file. The edit is also value-gated, which is what makes idempotency a property rather
 * than a hope: a field whose value already matches the bundle is not rewritten, so a
 * config formatted one way and a formatter that would write it another cannot fight.
 *
 * The bundle is read from the prefetch cache, keyed by the commit sha, which is the same
 * thing a `versions[]` entry is keyed by. It is deliberately not read from the extracted
 * tree under `<site>/app/docs/_bundles/`: the digest pins the bytes S3 served, so it is
 * taken over the bytes that were fetched and stored, never over a copy whose shape
 * depends on how the extractor wrote it.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { canonicalJson, sha256Hex, type JsonValue } from '../compile/serialise.js';
import { bundleManifestSchema } from '../contracts/bundle.schema.js';
import { docsSiteConfigSchema, versionTableProblems } from '../contracts/config.schema.js';
import { checkRow, failedRow, notRunRow } from '../../../src/contracts/diagnostics.js';
import type { CheckRow } from '../../../src/contracts/diagnostics.js';
import { MANIFEST_KEY, bundlePrefix } from '../../../src/contracts/manifest.js';
import type { BundleManifest } from '../../../src/contracts/manifest.js';
import type { DocsSiteConfig, VersionEntry } from '../../../src/contracts/site.js';
import {
	arrayElements,
	detectIndent,
	findValue,
	lineIndentAt,
	removeMember,
	rootSpan,
	setMember,
} from '../io/jsonc.js';
import type { CommandOutput } from '../registry/command.js';
import { defineCommand } from '../registry/command.js';

import { ROOT, SITE, rootOf } from './common.js';

/**
 * Prettier's defaults for this estate, so a rewritten array has the shape a formatter
 * would give it.
 *
 * `fixtures/site/fixture-app.docs.json` is the one checked-in example of this command's
 * output and it is formatted by this repository's prettier, which packs a short array
 * onto one line and expands a long one. Writing the other shape would put a diff in front
 * of somebody on every `pnpm format`, and neither consumer has prettier installed to put
 * it back. Tabs count as `tabWidth` columns, which is how prettier measures them.
 */
const PRINT_WIDTH = 100;
const TAB_COLUMNS = 2;

function columnsOf(text: string): number {
	let columns = 0;
	for (const character of text) columns += character === '\t' ? TAB_COLUMNS : 1;
	return columns;
}

/**
 * A JSON array of strings, packed onto one line when it fits and expanded when it does
 * not. `prefix` is the width of everything before it on that line, plus the comma after.
 */
function renderArray(
	values: readonly string[],
	indent: string,
	unit: string,
	newline: string,
	prefix: number,
): string {
	if (values.length === 0) return '[]';
	const packed = `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
	if (prefix + columnsOf(packed) <= PRINT_WIDTH) return packed;
	const body = values
		.map((value) => `${indent}${unit}${JSON.stringify(value)}`)
		.join(`,${newline}`);
	return `[${newline}${body}${newline}${indent}]`;
}

/**
 * Where `hexdocs prefetch` keeps what it fetched.
 *
 * Exported because it has to be the same rule in both commands: the cache is the handover
 * between them, and a second spelling of the default would make `sync` report a bundle as
 * missing on a machine that had just downloaded it.
 */
export function cacheRoot(cwd: string, flag: string | undefined): string {
	if (flag !== undefined && flag !== '') return resolve(cwd, flag);
	const configured = process.env['XDG_CACHE_HOME'];
	const base =
		configured === undefined || configured === '' ? join(homedir(), '.cache') : configured;
	return join(base, 'hexdocs');
}

interface FetchedManifest {
	readonly path: string;
	readonly digest: string;
	readonly manifest: BundleManifest;
}

/**
 * Reads one bundle manifest out of the cache, by commit. A string is the reason it could
 * not be read, ready to put on a row.
 *
 * The digest is taken over the bytes as read, not over a re-encoded string, because it is
 * a pin on what the bucket served and `hexdocs prefetch` compares it against exactly
 * those bytes.
 *
 * The AST major comes from `bundlePrefix`, which means the major this kit understands. A
 * kit bumped to `ast-2` therefore syncs from the `ast-2` bundle and reports a version
 * whose `ast-2` bundle has not been published yet as missing, rather than pinning a
 * digest for a bundle the renderer could not read.
 */
function readManifest(cache: string, project: string, commit: string): FetchedManifest | string {
	const path = join(cache, bundlePrefix(project, commit), MANIFEST_KEY);
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch {
		return `${path} is not in the cache. Run \`hexdocs prefetch\` first: it is what downloads a labelled bundle, and sync reads what it stored rather than reaching for the network itself.`;
	}
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString('utf8')) as unknown;
	} catch (error) {
		return `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`;
	}
	const parsed = bundleManifestSchema.safeParse(value);
	if (!parsed.success) {
		return `${path} is not a bundle manifest this kit understands: ${parsed.error.message}`;
	}
	return { path, digest: sha256Hex(bytes), manifest: parsed.data };
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function commandOutput(
	data: Record<string, JsonValue | undefined>,
	lines: readonly string[],
	rows: readonly CheckRow[],
): CommandOutput {
	return { data, lines, envelope: null, rows };
}

/**
 * Nothing was read, so neither row has a verdict.
 *
 * Both rows carry the same reason rather than one row carrying it and the other being
 * absent: a report with a row missing reads as a report with a row that passed, which is
 * the failure `notRunRow` exists for in the first place.
 */
function refused(path: string, reason: string): CommandOutput {
	return commandOutput(
		{ path, written: false, why: reason },
		[reason],
		[notRunRow('sync-pages', 'pages', reason), notRunRow('sync-digests', 'versions', reason)],
	);
}

export const sync = defineCommand({
	name: 'sync',
	tool: null,
	writes: 'files',
	summary: 'Write the page list and the bundle digests back into a site config.',
	detail:
		'Reads the manifest of every labelled version out of the prefetch cache and updates <site>/app/docs/<project>.docs.json in place: `pages` and `hidden` from the default version, `versions[].digest` from each fetched manifest. Nothing else in the file is touched and its formatting is preserved. `pages` is written in the manifest nav order, so running it twice produces the same bytes. A slug that has disappeared and has no redirect behind it fails the run, because that is a 404 at an address somebody linked to.',
	params: {
		root: ROOT,
		site: SITE,
		project: {
			help: 'the documented project, which names <site>/app/docs/<project>.docs.json',
			type: 'string',
			required: true,
		},
		cache: {
			help: 'the prefetch cache directory; defaults to $XDG_CACHE_HOME/hexdocs, or ~/.cache/hexdocs',
			type: 'string',
		},
	},
	positionals: ['root'],
	taughtBy: ['docs-publish-version'],
	async run(input, ctx) {
		const root = rootOf(ctx.cwd, input.root);
		const configPath = join(root, input.site, 'app', 'docs', `${input.project}.docs.json`);
		const cache = cacheRoot(ctx.cwd, input.cache);
		const writer = ctx.write;

		if (writer === null) {
			// Unreachable from the MCP server, which cannot dispatch a command with no tool
			// name, and this command has none. It is here because `Ctx.write` is the boundary,
			// and a writer that read `null` as "write anyway" would be the one place it leaked.
			return refused(configPath, 'This context has no writer, so nothing can be written.');
		}

		let text: string;
		try {
			text = readFileSync(configPath, 'utf8');
		} catch {
			return refused(
				configPath,
				`${configPath} does not exist. \`hexdocs install\` creates it; sync only maintains the three fields it owns.`,
			);
		}

		let raw: unknown;
		try {
			raw = JSON.parse(text) as unknown;
		} catch (error) {
			return refused(
				configPath,
				`${configPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const parsed = docsSiteConfigSchema.safeParse(raw);
		if (!parsed.success) {
			return refused(
				configPath,
				`${configPath} is not a valid site config: ${parsed.error.message}`,
			);
		}
		const config: DocsSiteConfig = parsed.data;
		if (config.project !== input.project) {
			return refused(
				configPath,
				`${configPath} declares project "${config.project}", not "${input.project}". The file name and the field have to agree: the field is what joins to the bundle prefix.`,
			);
		}

		// Exactly one default, no repeated label, no repeated commit. The schema cannot say
		// any of it, and sync reads the default entry to decide what `pages` is, so a file
		// with two of them has no answer rather than an arbitrary one.
		const tableProblems = versionTableProblems(config);
		if (tableProblems.length > 0) {
			return refused(
				configPath,
				`${configPath} has a version table sync cannot read. ${tableProblems.join(' ')}`,
			);
		}

		const fetched = config.versions.map((entry) => {
			const found = readManifest(cache, config.project, entry.commit);
			return typeof found === 'string'
				? { label: entry.label, commit: entry.commit, why: found, found: null }
				: { label: entry.label, commit: entry.commit, why: null, found };
		});
		const defaultIndex = config.versions.findIndex((entry) => entry.default === true);
		const defaultEntry = config.versions[defaultIndex];
		const defaultFetch = fetched[defaultIndex];
		if (defaultEntry === undefined || defaultFetch === undefined) {
			return refused(configPath, `${configPath} has no version marked default.`);
		}
		if (defaultFetch.found === null) {
			// The default version is what `pages` describes, so without it there is no page
			// list to write and no verdict to give on the digests either.
			return refused(configPath, defaultFetch.why ?? 'The default version has no bundle.');
		}

		const manifest = defaultFetch.found.manifest;
		if (manifest.project !== config.project) {
			return refused(
				configPath,
				`${defaultFetch.found.path} is a bundle for "${manifest.project}", not "${config.project}".`,
			);
		}

		// ---- what the file should say -----------------------------------------

		// Nav order, which is `llmsOrder`, because the order has to be pinned to one
		// deterministic choice or every run produces a spurious diff. `manifest.pages` keys
		// come back in code point order, which is equally valid and different, which is
		// exactly why it is chosen once and written down. Filtered against `pages` because a
		// slug in `llmsOrder` that the bundle does not carry is a link to nothing.
		const carried = new Set(Object.keys(manifest.pages));
		const slugs = manifest.llmsOrder.filter((slug) => carried.has(slug));
		// A page no nav entry reaches is an orphan, which `hexdocs check` reports as a lint
		// error. It is still a published page, and leaving it out of `pages` would take it
		// out of `LOCALISED_PATHS` and ship it with no canonical, no alternates and no
		// noindex. So it is appended in the manifest's own key order, which is code point
		// order, and named in the output rather than quietly included.
		const inNav = new Set(slugs);
		const orphans = Object.keys(manifest.pages).filter((slug) => !inNav.has(slug));
		slugs.push(...orphans);

		// A hidden page stays in `pages`: it is published, indexable and addressable, and
		// the sitemap is the only thing that needs to tell the two apart. `hidden` is the
		// subset in the same order, so the two lists read together.
		const hiddenSlugs = new Set(
			manifest.nav.filter((node) => node.hidden === true).map((node) => node.slug),
		);
		const hidden = slugs.filter((slug) => hiddenSlugs.has(slug));

		const now = new Set(slugs);
		const before = new Set(config.pages);
		const added = slugs.filter((slug) => !before.has(slug));
		const removed = config.pages.filter((slug) => !now.has(slug));
		const redirected = removed.filter((slug) => Object.hasOwn(manifest.redirects, slug));
		const dropped = removed.filter((slug) => !Object.hasOwn(manifest.redirects, slug));

		const missing = fetched.filter((entry) => entry.found === null).map((entry) => entry.label);
		// A version that already carried a digest and whose cached manifest hashes to a
		// different one. It is written, because the cache is what the site will read, and it
		// is reported, because the same sha producing different manifest bytes means the
		// toolchain that built it changed. Silently replacing a pinned integrity value is the
		// one thing this command should never do without saying so.
		const repinned = config.versions
			.filter((entry, index) => {
				const digest = fetched[index]?.found?.digest;
				return entry.digest !== undefined && digest !== undefined && entry.digest !== digest;
			})
			.map((entry) => entry.label);

		// ---- the edit ---------------------------------------------------------

		const newline = text.includes('\r\n') ? '\r\n' : '\n';
		const unit = detectIndent(text);
		const pagesSpan = findValue(text, 'pages');
		if (pagesSpan === null) {
			return refused(configPath, `${configPath} has no unique \`pages\` member to write.`);
		}
		// The indentation of the line `pages` sits on, which is the depth every member of
		// this object is written at. Read from the file rather than assumed, so a config
		// somebody indented with spaces stays indented with spaces.
		const memberIndent = lineIndentAt(text, pagesSpan.start);

		let next = text;
		if (!sameStrings(config.pages, slugs)) {
			const span = rootSpan(next);
			const value = renderArray(
				slugs,
				memberIndent,
				unit,
				newline,
				columnsOf(`${memberIndent}"pages": `) + 1,
			);
			const replaced = span === null ? null : setMember(next, span, 'pages', value);
			if (replaced === null)
				return refused(configPath, `Could not write \`pages\` into ${configPath}.`);
			next = replaced;
		}

		if (!sameStrings(config.hidden ?? [], hidden)) {
			const span = rootSpan(next);
			const value = renderArray(
				hidden,
				memberIndent,
				unit,
				newline,
				columnsOf(`${memberIndent}"hidden": `) + 1,
			);
			const edited =
				span === null
					? null
					: hidden.length === 0
						? removeMember(next, span, 'hidden')
						: // Above `pages`, which is where the checked-in example of this file carries
							// it. `pages` is always present here, and the option falls back to last.
							setMember(next, span, 'hidden', value, { before: 'pages' });
			if (edited === null)
				return refused(configPath, `Could not write \`hidden\` into ${configPath}.`);
			next = edited;
		}

		for (const [index, entry] of config.versions.entries()) {
			const digest = fetched[index]?.found?.digest;
			if (digest === undefined || entry.digest === digest) continue;
			// Every edit moves every offset after it, so the version spans are located again
			// from the current text on each pass. A list of spans taken once and reused would
			// write the second digest into the wrong object as soon as the first insert
			// changed the file's length.
			const versionsSpan = findValue(next, 'versions');
			const elements = versionsSpan === null ? null : arrayElements(next, versionsSpan);
			const element = elements?.[index];
			if (element === undefined) {
				return refused(
					configPath,
					`Could not find version ${index + 1} of ${config.versions.length} in ${configPath}.`,
				);
			}
			const commitSpan = findValue(next, 'commit', element);
			const commit =
				commitSpan === null
					? null
					: (JSON.parse(next.slice(commitSpan.start, commitSpan.end)) as string);
			if (commit !== entry.commit) {
				// The parsed config and the file text disagree about which entry is which, which
				// cannot happen and would write a digest against the wrong sha if it did.
				return refused(
					configPath,
					`Version ${index + 1} in ${configPath} is not the entry labelled ${entry.label}.`,
				);
			}
			const written = setMember(next, element, 'digest', JSON.stringify(digest));
			if (written === null) {
				return refused(configPath, `Could not write the digest for ${entry.label}.`);
			}
			next = written;
		}

		// ---- prove the edit before it lands ------------------------------------

		// The surgery is span arithmetic over somebody else's file, so the result is compared
		// against the object it was supposed to produce before anything is written. Compared
		// through `canonicalJson`, which sorts keys and drops undefined properties, so this
		// asserts the values and says nothing about the formatting, which is the half that is
		// meant to be left alone.
		const expectedVersions: VersionEntry[] = config.versions.map((entry, index) => {
			const digest = fetched[index]?.found?.digest;
			return digest === undefined ? entry : { ...entry, digest };
		});
		const expected: DocsSiteConfig = {
			...config,
			versions: expectedVersions,
			pages: slugs,
			hidden: hidden.length > 0 ? hidden : undefined,
		};
		let actual: unknown;
		try {
			actual = JSON.parse(next) as unknown;
		} catch (error) {
			return refused(
				configPath,
				`The edit did not produce JSON, so nothing was written: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (canonicalJson(actual) !== canonicalJson(expected)) {
			return refused(
				configPath,
				`The edit did not produce the intended config, so nothing was written to ${configPath}. That is a bug in hexdocs rather than a problem with the file.`,
			);
		}

		const changed = writer.write(configPath, next);

		// ---- rows --------------------------------------------------------------

		const rows: CheckRow[] = [
			dropped.length === 0
				? checkRow('sync-pages', slugs.length, 'pages', [])
				: failedRow(
						'sync-pages',
						slugs.length,
						'pages',
						`${dropped.join(', ')} left the bundle with no entry in \`redirects\`, so that address is a 404 for anyone who linked to it. Add a redirect in the app repository, or record that the page is gone.`,
					),
			missing.length === 0
				? checkRow('sync-digests', config.versions.length, 'versions', [])
				: failedRow(
						'sync-digests',
						config.versions.length - missing.length,
						'versions',
						`No bundle in the cache for ${missing.join(', ')}, so those versions keep whatever digest they had. Run \`hexdocs prefetch --site ${input.site}\` and sync again.`,
					),
		];

		const lines = [
			`${config.project} ${defaultEntry.label} (${defaultEntry.commit.slice(0, 12)}): ` +
				`${slugs.length} page(s), ${hidden.length} hidden, ` +
				`${config.versions.length - missing.length} of ${config.versions.length} version(s) digested.`,
			changed ? `Wrote ${configPath}.` : `${configPath} was already up to date.`,
			...(added.length > 0 ? [`Added: ${added.join(', ')}.`] : []),
			...(redirected.length > 0
				? [
						`Removed, with a redirect: ${redirected
							.map((slug) => `${slug} to ${manifest.redirects[slug] ?? '?'}`)
							.join(', ')}.`,
					]
				: []),
			...(orphans.length > 0
				? [
						`In the bundle and in no nav entry, so appended at the end: ${orphans.join(', ')}. ` +
							'`hexdocs check` reports each one as an orphan.',
					]
				: []),
			...(repinned.length > 0
				? [
						`The digest changed for ${repinned.join(', ')}, which is the same commit with a ` +
							'different manifest. The content did not change; the toolchain that built it did.',
					]
				: []),
		];

		return commandOutput(
			{
				path: configPath,
				project: config.project,
				label: defaultEntry.label,
				commit: defaultEntry.commit,
				written: changed,
				pages: { total: slugs.length, added, removed, redirected, dropped, orphans },
				hidden,
				repinned,
				versions: fetched.map((entry) => ({
					label: entry.label,
					commit: entry.commit,
					digest: entry.found?.digest ?? null,
					manifest: entry.found?.path ?? null,
					why: entry.why,
				})),
			},
			lines,
			rows,
		);
	},
});
