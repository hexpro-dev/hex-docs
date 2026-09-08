/**
 * `hexdocs bundle` / `docs_bundle`: is this bundle intact, what is in it, and what
 * changed since another one.
 *
 * Three of the original design's tools in one command: `verify`, `describe_bundle` and
 * `diff_bundles`. They read the same directory and the same manifest, and every one of
 * them has to load and validate that manifest before it can answer anything, so three
 * tools would have been three copies of one read with three ideas of what a malformed
 * manifest means.
 *
 * The rows are exactly what `verifyBundle` returns, surfaced unchanged. Nothing here
 * re-derives a digest, a key set or a payload shape. `compile/bundle.ts` is the reader
 * that the publisher and the compiler both already trust, and a second implementation
 * living in the CLI is how the CLI and the publisher end up disagreeing about whether a
 * bundle is publishable.
 *
 * **Row ids and `CheckId`s are two namespaces, and this is the command where the
 * difference is visible.** `CheckRow.id` is a row id, free to be any string;
 * `Finding.rule` is the closed union of `LINT_RULE_IDS` and `CHECK_IDS`. `verifyBundle`
 * already emits the rows `bundle-manifest`, `bundle-objects`, `bundle-digests` and
 * `bundle-payloads`, and not one of those four is a `CheckId`. `bundle-ast-major` is
 * both, which is the coincidence that makes the confusion tempting. A test sweeping
 * `CHECK_IDS` against this command's row ids in both directions would fail against the
 * compiler's own existing output, and the only way to make it pass would be to invent
 * five check ids that nothing reports findings under. So the two lists stay separate, and
 * `Finding.rule` is the one that is closed.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { notRunRow, type CheckRow } from '../../../src/contracts/diagnostics.js';
import type { Locale } from '../../../src/contracts/locales.js';
import { MANIFEST_KEY, type BundleManifest } from '../../../src/contracts/manifest.js';
import { verifyBundle } from '../compile/bundle.js';
import type { JsonValue } from '../compile/serialise.js';
import { bundleManifestSchema } from '../contracts/bundle.schema.js';
import { defineCommand } from '../registry/command.js';

/** One page in one locale, which is the unit a digest addresses. */
type PageLocale = { slug: string; locale: string };

type DigestChange = { slug: string; locale: string; from: string; to: string };

type TermDelta = { locale: string; from: number | null; to: number | null; delta: number | null };

/**
 * A manifest, or the reason there is not one.
 *
 * Returned rather than thrown so the caller can put the reason on a row. Every failure
 * this can meet is one `verifyBundle` has already reported against, so the description
 * half going quiet with a reason is the honest shape: two reports of one broken manifest
 * would differ in wording and a reader would have to work out whether they were about the
 * same file.
 */
function readManifest(directory: string): { manifest: BundleManifest } | { why: string } {
	const path = join(directory, MANIFEST_KEY);
	if (!existsSync(path)) return { why: `${path} does not exist.` };
	let document: unknown;
	try {
		document = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		return { why: `${path} is not JSON: ${(error as Error).message}` };
	}
	const parsed = bundleManifestSchema.safeParse(document);
	if (!parsed.success) {
		// The AST major is the common case here and it is not corruption: a bundle written
		// by a newer kit is a legitimate object sitting beside the ones this toolchain
		// understands, which is the whole reason the `ast-N` key segment exists. The rows
		// name it, so this only has to decline to describe it.
		return {
			why: `${path} is not a manifest this toolchain can read: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
		};
	}
	return { manifest: parsed.data as BundleManifest };
}

/** Every page payload digest in the bundle, keyed by slug and locale. */
function pageLocaleDigests(manifest: BundleManifest): Map<string, string> {
	const digests = new Map<string, string>();
	for (const [slug, page] of Object.entries(manifest.pages)) {
		for (const [locale, record] of Object.entries(page.locales)) {
			if (record === undefined) continue;
			// U+0000 as the separator rather than a slash or a hyphen: a slug carries
			// slashes and a locale carries a hyphen, and a separator either of them can
			// contain is one that two different pairs collide on. Written as an escape
			// because the character itself is invisible in a diff.
			digests.set(`${slug}\u0000${locale}`, record.digest);
		}
	}
	return digests;
}

function splitKey(key: string): PageLocale {
	const [slug = '', locale = ''] = key.split('\u0000');
	return { slug, locale };
}

/**
 * What changed between two bundles, in both directions.
 *
 * The unit is the page payload digest rather than the slug, because a translation
 * landing changes nothing about the slug set and is the single most common thing a
 * release note has to describe. Slug-level additions and removals are reported as well,
 * because those are the ones that need a redirect.
 */
export function diffManifests(
	current: BundleManifest,
	against: BundleManifest,
): {
	addedSlugs: string[];
	removedSlugs: string[];
	addedPages: PageLocale[];
	removedPages: PageLocale[];
	changedPages: DigestChange[];
	terms: TermDelta[];
} {
	const currentSlugs = new Set(Object.keys(current.pages));
	const againstSlugs = new Set(Object.keys(against.pages));

	const mine = pageLocaleDigests(current);
	const theirs = pageLocaleDigests(against);

	const addedPages: PageLocale[] = [];
	const changedPages: DigestChange[] = [];
	for (const [key, digest] of mine) {
		const other = theirs.get(key);
		if (other === undefined) addedPages.push(splitKey(key));
		else if (other !== digest) changedPages.push({ ...splitKey(key), from: other, to: digest });
	}
	const removedPages: PageLocale[] = [];
	for (const key of theirs.keys()) if (!mine.has(key)) removedPages.push(splitKey(key));

	// Sorted, all of them. This output is read by an agent that will run the command again
	// after a change and compare, and an unordered list makes an unrelated diff every run.
	const byPage = (a: PageLocale, b: PageLocale): number =>
		a.slug === b.slug ? (a.locale < b.locale ? -1 : 1) : a.slug < b.slug ? -1 : 1;
	addedPages.sort(byPage);
	removedPages.sort(byPage);
	changedPages.sort(byPage);

	// Every locale either bundle carries, so a locale that appeared or disappeared shows
	// up as a null on one side rather than being absent from the table entirely.
	const locales = [...new Set<string>([...current.locales, ...against.locales])].sort();
	const terms: TermDelta[] = locales.map((locale) => {
		const to = current.search[locale as Locale]?.terms ?? null;
		const from = against.search[locale as Locale]?.terms ?? null;
		return { locale, from, to, delta: from === null || to === null ? null : to - from };
	});

	return {
		addedSlugs: [...currentSlugs].filter((slug) => !againstSlugs.has(slug)).sort(),
		removedSlugs: [...againstSlugs].filter((slug) => !currentSlugs.has(slug)).sort(),
		addedPages,
		removedPages,
		changedPages,
		terms,
	};
}

/** The manifest's own summary, as plain JSON. */
function describe(directory: string, manifest: BundleManifest): Record<string, JsonValue> {
	const hidden = new Set(manifest.nav.filter((node) => node.hidden === true).map((n) => n.slug));
	return {
		path: directory,
		// A discriminator, present in both shapes this command can return. Without it the
		// caller of `--json` has to work out from the absence of `project` whether the
		// manifest was read, and "absent because it could not be read" and "absent because
		// this version of the output does not carry it" look identical.
		described: true,
		project: manifest.project,
		commit: manifest.commit,
		commitTimestamp: manifest.commitTimestamp,
		ast: manifest.ast,
		generator: manifest.generator,
		sourceLocale: manifest.sourceLocale,
		locales: [...manifest.locales],
		counts: { ...manifest.counts },
		coverage: Object.fromEntries(
			manifest.locales.map((locale) => {
				const entry = manifest.coverage[locale];
				return [
					locale,
					entry === undefined
						? null
						: {
								pages: entry.pages,
								translated: entry.translated,
								stale: entry.stale,
								scaffolded: entry.scaffolded,
							},
				];
			}),
		),
		search: Object.fromEntries(
			manifest.locales.map((locale) => {
				const entry = manifest.search[locale];
				return [
					locale,
					entry === undefined ? null : { records: entry.records, terms: entry.terms },
				];
			}),
		),
		// Nav order rather than key order. `pages` is a code-point sorted record and `nav`
		// is reading order, and a person scanning this list wants the second one; the
		// manifest already guarantees every nav slug is a page.
		pages: manifest.nav.map((node) => {
			const page = manifest.pages[node.slug];
			return {
				slug: node.slug,
				hidden: hidden.has(node.slug),
				locales: page === undefined ? [] : Object.keys(page.locales).sort(),
			};
		}),
	};
}

function coverageLine(manifest: BundleManifest): string {
	return manifest.locales
		.map((locale) => {
			const entry = manifest.coverage[locale];
			if (entry === undefined) return `${locale} ?`;
			return `${locale} ${entry.translated}/${entry.pages}`;
		})
		.join('  ');
}

export const bundle = defineCommand({
	name: 'bundle',
	tool: 'docs_bundle',
	writes: 'nothing',
	summary: 'Verify a compiled bundle, describe what is in it, and diff it against another.',
	detail:
		'Point this at the ast-N directory of one bundle, either the output of `hexdocs build` or a directory the prefetch cache holds. It reads the manifest back, checks that every object it names is present with the bytes and the digest recorded for it, parses every page payload and every search index, and reports the project, the commit, the counts, the per-locale coverage and the page list. Pass --against with a second bundle directory to get the slugs added and removed, every page payload whose digest changed, and the per-locale search term counts on both sides, which is what a release note is written from.',
	params: {
		path: {
			help: 'the ast-N directory of one bundle',
			type: 'string',
			required: true,
		},
		against: {
			help: 'a second bundle directory to compare this one with',
			type: 'string',
		},
	},
	positionals: ['path'],
	taughtBy: ['docs-publish-version', 'docs-diagnose'],
	async run(input, ctx) {
		const directory = resolve(ctx.cwd, input.path);

		// A path that is not a directory is refused before `verifyBundle` sees it, and this
		// is the one place this command adds a row of its own. `verifyBundle` would report
		// a missing manifest, which is true and is the wrong sentence: "there is no bundle
		// here" and "you passed the parent of the ast-N directory, or a typo" send an
		// operator to two different places, and the second is what actually happens.
		if (!existsSync(directory) || !statSync(directory).isDirectory()) {
			const why = `${directory} is not a directory. Point at the ast-N directory of one bundle, such as <cache>/<project>/<commit>/ast-1.`;
			return {
				data: { path: directory, described: false, why },
				lines: [why],
				envelope: null,
				rows: [notRunRow('bundle-path', 'bundles', why)],
			};
		}

		const rows: CheckRow[] = [...verifyBundle(directory)];
		const read = readManifest(directory);
		if (!('manifest' in read)) {
			return {
				data: { path: directory, described: false, why: read.why },
				lines: [`Could not describe ${directory}.`, read.why],
				envelope: null,
				rows,
			};
		}
		const manifest = read.manifest;

		const lines = [
			`${manifest.project} at ${manifest.commit.slice(0, 8)}, AST major ${manifest.ast}, built by ${manifest.generator}.`,
			`${manifest.counts.pages} page(s), ${manifest.counts.locales} locale(s), ` +
				`${manifest.counts.objects} object(s), ${manifest.counts.bytes} stored byte(s).`,
			`translated: ${coverageLine(manifest)}`,
		];

		let against: JsonValue = null;
		if (input.against !== undefined) {
			const otherPath = resolve(ctx.cwd, input.against);
			const other =
				existsSync(otherPath) && statSync(otherPath).isDirectory()
					? readManifest(otherPath)
					: { why: `${otherPath} is not a directory.` };
			if (!('manifest' in other)) {
				// A comparison that was asked for and did not happen is a `not-run` row rather
				// than a quiet `against: null`. The whole reason `--against` was passed is that
				// somebody wants to know what changed, and an empty diff and a diff that never
				// ran look identical in JSON.
				rows.push(notRunRow('bundle-against', 'bundles', other.why));
				lines.push(`Could not compare against ${otherPath}. ${other.why}`);
			} else {
				const diff = diffManifests(manifest, other.manifest);
				const notes: string[] = [];
				if (other.manifest.project !== manifest.project) {
					// Not a refusal. The numbers below are still exactly what they say they are;
					// what changes is whether the reader should believe the diff means anything,
					// and that is a sentence rather than an exit code.
					notes.push(
						`These are different projects, ${manifest.project} and ${other.manifest.project}. Every page will read as added or removed.`,
					);
				}
				if (other.manifest.ast !== manifest.ast) {
					notes.push(
						`These are different AST majors, ${manifest.ast} and ${other.manifest.ast}. A digest change here can mean a recompile rather than an edit.`,
					);
				}
				against = {
					path: otherPath,
					project: other.manifest.project,
					commit: other.manifest.commit,
					addedSlugs: diff.addedSlugs,
					removedSlugs: diff.removedSlugs,
					addedPages: diff.addedPages,
					removedPages: diff.removedPages,
					changedPages: diff.changedPages,
					terms: diff.terms,
					notes,
				};
				lines.push(
					`Against ${other.manifest.commit.slice(0, 8)}: ${diff.addedSlugs.length} slug(s) added, ` +
						`${diff.removedSlugs.length} removed, ${diff.changedPages.length} page payload(s) changed, ` +
						`${diff.addedPages.length} translation(s) added, ${diff.removedPages.length} removed.`,
					...notes,
				);
			}
		}

		return {
			data: { ...describe(directory, manifest), against },
			lines,
			envelope: null,
			rows,
		};
	},
});
