/**
 * `hexdocs pages` / `docs_pages`: what pages exist, and what state each language is in.
 *
 * This is the original design's `list_pages` and `translation_status` in one command,
 * because they were never two questions. A page list with no translation column is a
 * list of filenames, and a translation report with no page list is a set of counts
 * nobody can act on: the answer a translator wants is a table, and a table is one call.
 *
 * The whole report is derived from a manifest, and that is what lets one implementation
 * serve both a source tree and a published bundle. `buildBundle` produces a manifest in
 * memory; a bundle directory has one on disk. Everything below reads the same fields out
 * of the same shape, so `--bundle` cannot grow a different idea of what a page is.
 *
 * The one field a manifest cannot answer is `effectiveState`, and the comment on it says
 * what is done about that in each mode.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { notRunRow } from '../../../src/contracts/diagnostics.js';
import { TRANSLATION_STATES, type TranslationState } from '../../../src/contracts/frontmatter.js';
import { LOCALES, sortLocales, type Locale } from '../../../src/contracts/locales.js';
import { AST_VERSION } from '../../../src/contracts/ast.js';
import { MANIFEST_KEY, pageKey, type BundleManifest } from '../../../src/contracts/manifest.js';
import { parseSlug } from '../../../src/contracts/slug.js';
import { buildBundle } from '../compile/build.js';
import { gunzipMember } from '../compile/serialise.js';
import { bundleManifestSchema } from '../contracts/bundle.schema.js';
import { defineCommand } from '../registry/command.js';

import { LOCALE_MANY, ROOT, rootOf } from './common.js';

/**
 * The `--bundle` flag, spelled once and shared with `page`.
 *
 * Both commands take the same directory and mean the same thing by it, and a flag whose
 * help text differs between two commands is a flag an agent has to read twice. The
 * reasoning is `commands/common.ts`'s; it lives here rather than there because these are
 * the only two commands that read a bundle to answer a question about its content, and a
 * third would be the moment to move it.
 */
export const BUNDLE_DIRECTORY = {
	help: 'read a compiled bundle directory (the ast-N directory) instead of a source tree',
	type: 'string',
} as const;

export type BundleRead =
	| { readonly ok: true; readonly directory: string; readonly manifest: BundleManifest }
	| { readonly ok: false; readonly why: string };

/**
 * How far down a wrong path this looks for the bundle the caller meant.
 *
 * `hexdocs prefetch` writes `_bundles/<project>/<sha>/ast-N/`, so the natural mistake is
 * to pass the cache root or the project directory, three levels above the manifest. The
 * search is bounded in both directions on purpose: a caller who passes a repository root
 * by accident would otherwise pay a full tree walk to be told the same thing, and the
 * cap is what stops a helpful message becoming a hang.
 */
const CANDIDATE_DEPTH = 3;
const CANDIDATE_DIRECTORIES = 400;

/** Directories at or below `root` that do hold a manifest, for the refusal to name. */
function bundleCandidates(root: string): string[] {
	const found: string[] = [];
	let visited = 0;
	const walk = (directory: string, depth: number): void => {
		if (depth > CANDIDATE_DEPTH || visited >= CANDIDATE_DIRECTORIES) return;
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			visited += 1;
			if (visited > CANDIDATE_DIRECTORIES) return;
			const child = join(directory, entry.name);
			if (existsSync(join(child, MANIFEST_KEY))) found.push(child);
			else walk(child, depth + 1);
		}
	};
	walk(root, 1);
	return found.slice(0, 3);
}

/**
 * A bundle directory, read and validated, as a value or a reason.
 *
 * Returned rather than thrown so the caller can put the reason on a `not-run` row. A
 * bundle that cannot be read is a run that examined nothing, and the house rule is that
 * such a run fails rather than reporting an empty success.
 *
 * The AST major is read before the schema, which is the ordering `verifyBundle` already
 * uses and for the same reason: `bundleManifestSchema` pins `ast` to this toolchain's
 * major, so a bundle written by a newer kit would otherwise be reported as a malformed
 * manifest at pointer /ast. Bundles at two majors sit beside each other legitimately,
 * which is the entire reason the `ast-N` key segment exists, so the honest answer names
 * the major and the submodule bump that would read it.
 */
export function readBundle(cwd: string, path: string): BundleRead {
	const directory = resolve(cwd, path);
	const manifestPath = join(directory, MANIFEST_KEY);

	if (!existsSync(manifestPath)) {
		const candidates = bundleCandidates(directory);
		return {
			ok: false,
			why:
				`${directory} has no ${MANIFEST_KEY}. A bundle directory is the ast-N directory itself, ` +
				`which is what hexdocs prefetch writes at _bundles/<project>/<sha>/ast-${AST_VERSION}.` +
				(candidates.length === 0
					? ' The manifest is also written last, so its absence can mean a partial download.'
					: ` One is below this path: ${candidates.join(', ')}.`),
		};
	}

	let document: unknown;
	try {
		document = JSON.parse(readFileSync(manifestPath, 'utf8'));
	} catch (error) {
		return {
			ok: false,
			why: `${manifestPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const declared = (document as { ast?: unknown }).ast;
	if (typeof declared === 'number' && declared !== AST_VERSION) {
		return {
			ok: false,
			why:
				`${manifestPath} declares AST major ${declared} and this toolchain is ${AST_VERSION}. ` +
				`Bundles at two majors sit beside each other on purpose, so this is a submodule bump ` +
				`rather than a recompile.`,
		};
	}

	const parsed = bundleManifestSchema.safeParse(document);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return {
			ok: false,
			why:
				`${manifestPath} is not a manifest this toolchain can read` +
				(issue === undefined ? '.' : `: /${issue.path.join('/')} ${issue.message}.`) +
				` A hand-edited manifest is not a supported state; recompile the commit.`,
		};
	}

	return { ok: true, directory, manifest: parsed.data };
}

/**
 * The effective translation state, read out of a compiled page payload.
 *
 * `manifest.ts` opens by saying that nothing may need a page payload to answer a
 * question about the bundle, and this is the one read in this package that does. The
 * reason is that the effective state is by construction not in the manifest:
 * `PageLocaleRecord.state` is the page's own state because that is what a translator
 * acts on, and the worst of the page and everything it transcludes lives on the compiled
 * page where the reader's notice reads it. The alternative was a field that is populated
 * from a source tree and null from a bundle, and a null that means "this mode does not
 * answer" is indistinguishable from a null that means "the payload is not here".
 *
 * So a null from this function has exactly one meaning: this directory does not hold a
 * readable payload for that page and locale, which is what a partial download looks
 * like. The shape check is deliberately narrow rather than `compiledPageSchema`: one
 * field is wanted, and validating the whole payload would refuse a page for reasons that
 * have nothing to do with the question and that `hexdocs bundle` already reports.
 */
function payloadState(directory: string, slug: string, locale: Locale): TranslationState | null {
	const path = join(directory, pageKey(locale, slug));
	if (!existsSync(path)) return null;
	let value: unknown;
	try {
		value = JSON.parse(gunzipMember(readFileSync(path)).toString('utf8'));
	} catch {
		return null;
	}
	const state = (value as { translation?: { state?: unknown } } | null)?.translation?.state;
	if (typeof state !== 'string') return null;
	return (TRANSLATION_STATES as readonly string[]).includes(state)
		? (state as TranslationState)
		: null;
}

/**
 * The section a slug sits in, or `null` for a page at the docs root.
 *
 * Derived rather than stored, because the slug is the only thing that decides it: the
 * sidebar's nesting comes from the slug hierarchy and not from `nav.json`'s groups,
 * which the compiler flattens.
 */
export function sectionOf(slug: string): string | null {
	const parsed = parseSlug(slug);
	if (!parsed.ok) return null;
	const section = parsed.slug.section.join('/');
	return section === '' ? null : section;
}

/** The per-language cell of the table. Every field is present, `null` when unknown. */
export type PagesLocaleEntry = {
	/**
	 * `PageLocaleRecord.state`: the page's own state, which is what `coverage` counts and
	 * what a translator opens files by.
	 */
	state: TranslationState;
	/**
	 * `CompiledPage.translation.state`: the worst of the page and every snippet it
	 * transcludes, which is what a reader gets.
	 *
	 * Two fields rather than one because a current page full of stale snippets is not
	 * current to a reader and is not a page to retranslate, and a single number would
	 * make one of those two answers wrong. Measured against the fixture corpus rather
	 * than assumed: the two disagree on exactly one page, `index`, in all six
	 * translations, where the page's own state is `current` and a transcluded snippet
	 * drags the effective state to `stale`. Every other page and locale agrees, which is
	 * the case that makes a single field look sufficient right up until it is not.
	 */
	effectiveState: TranslationState | null;
	title: string | null;
	/** The source locale's committer date, so staleness is a comparison a reader can do. */
	sourceUpdated: string | null;
	/**
	 * This file's own committer date, and `null` in the source locale, which is its own
	 * source.
	 *
	 * `PageLocaleRecord.updatedAt` verbatim. That field falls back to the source date for
	 * a file the git walk has no date for, which is a state `bundle-file-undated` reports
	 * at compile time; this report repeats the manifest's answer rather than forming a
	 * second opinion about it.
	 */
	translationUpdated: string | null;
};

export type PagesEntry = {
	slug: string;
	section: string | null;
	/**
	 * The nav marks this page hidden: published and indexable, out of the sidebar, the
	 * sitemap and prev/next.
	 *
	 * `false` is not a claim that the sidebar reaches the page. A page no nav entry
	 * reaches at all is an orphan, which is a finding `hexdocs check` reports and which
	 * this field does not distinguish from a page the nav lists normally.
	 */
	hidden: boolean;
	/** The source locale's sidebar label. Per-locale labels are in the manifest. */
	navTitle: string | null;
	locales: { [locale: string]: PagesLocaleEntry };
};

export type PagesCoverage = {
	pages: number;
	translated: number;
	stale: number;
	scaffolded: number;
};

export type PagesReport = {
	project: string;
	/**
	 * The columns of this report, not the project's languages.
	 *
	 * With no `--locale` they are the same list. With one, a language the project does
	 * not build is still a legitimate column: every page reads `missing` in it, which is
	 * the answer to "is this language shipped at all", and dropping the column would make
	 * that question return an empty success.
	 */
	locales: string[];
	coverage: { [locale: string]: PagesCoverage };
	pages: PagesEntry[];
};

const EMPTY_COVERAGE: PagesCoverage = { pages: 0, translated: 0, stale: 0, scaffolded: 0 };

/** A fixed-width column set, so the human table lines up without any drawing characters. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
	const widths = header.map((cell, column) =>
		Math.max(cell.length, ...rows.map((row) => (row[column] ?? '').length)),
	);
	const line = (row: readonly string[]): string =>
		row
			.map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
			.join('  ')
			.trimEnd();
	return [line(header), ...rows.map(line)];
}

export const pages = defineCommand({
	name: 'pages',
	tool: 'docs_pages',
	writes: 'nothing',
	summary: 'List every page with its translation state in every language.',
	detail:
		"One row per page and one cell per language, from a source tree or from a compiled bundle. Each cell carries two states: `state` is the page's own, which is what the coverage counts and what a translator opens files by, and `effectiveState` is the worst of the page and every snippet it transcludes, which is what a reader gets. A language with no file for a page reads `missing` rather than being absent, so the table is rectangular. Use this to decide what to translate next, and to check what a published bundle actually contains.",
	params: {
		root: ROOT,
		bundle: BUNDLE_DIRECTORY,
		locale: LOCALE_MANY,
	},
	positionals: ['root'],
	taughtBy: ['docs-authoring', 'docs-diagnose'],
	async run(input, ctx) {
		const root = rootOf(ctx.cwd, input.root);

		let manifest: BundleManifest;
		let origin: string;
		// Where the effective state comes from. A source tree has the compiled pages in
		// hand; a bundle directory has to read the payload back. Both answer the same
		// question, which is what keeps the field meaning one thing.
		let effectiveState: (slug: string, locale: Locale) => TranslationState | null;

		if (input.bundle === undefined) {
			let result;
			try {
				result = buildBundle(root, { generator: ctx.kitVersion });
			} catch (error) {
				// A `ProjectError` arrives here as an `Error` whose message already names the
				// file, and a tree with no git history throws from `buildBundle` itself. Neither
				// is a stack trace worth printing, and neither is an empty page list: an
				// inventory that examined nothing has not found that the project has no pages.
				const why = error instanceof Error ? error.message : String(error);
				return {
					data: { root, listed: false, why },
					lines: [`Could not list the pages in ${root}.`, why],
					envelope: null,
					rows: [notRunRow('pages', 'documentation trees', why)],
				};
			}
			manifest = result.manifest;
			origin = root;
			effectiveState = (slug, locale) =>
				result.pages.get(slug)?.get(locale)?.page.translation.state ?? null;
		} else {
			const read = readBundle(ctx.cwd, input.bundle);
			if (!read.ok) {
				return {
					data: { root, listed: false, why: read.why },
					lines: ['Could not read that bundle.', read.why],
					envelope: null,
					rows: [notRunRow('pages', 'bundles', read.why)],
				};
			}
			manifest = read.manifest;
			origin = read.directory;
			effectiveState = (slug, locale) => payloadState(read.directory, slug, locale);
		}

		// Two things are going on here and only one of them is about locales.
		//
		// `LOCALE_MANY` is annotated `Param` in `commands/common.ts`, and that annotation
		// erases `many: true` from the type: `Input` computes `string` for this field where
		// the runtime value is a `string[]`, because `shapeOf` builds `z.array()` from the
		// same declaration and validates it as one. So the value is unpacked rather than
		// cast. It is the type that is wrong, not the value, and annotating the constant
		// `as const satisfies Param` there would turn this into a no-op.
		//
		// The filter is then how the type learns what the schema already enforced, since
		// the enum has refused anything outside `LOCALES` before `run` was called. Sorted
		// into tuple order so the columns read the same whatever order the flags were typed
		// in.
		const asked: readonly string[] = Array.isArray(input.locale)
			? input.locale
			: input.locale === undefined
				? []
				: [input.locale];
		const requested = asked.filter((value): value is Locale =>
			(LOCALES as readonly string[]).includes(value),
		);
		const scope = sortLocales(requested.length === 0 ? manifest.locales : [...new Set(requested)]);
		const declared = new Set<string>(manifest.locales);
		const undeclared = scope.filter((locale) => !declared.has(locale));

		const entries: PagesEntry[] = [];
		const hidden = new Set(
			manifest.nav.filter((node) => node.hidden === true).map((node) => node.slug),
		);

		// `manifest.pages` keys are already in code point order, which is the order the
		// manifest's own invariants pin. Re-sorting here would be a second opinion about
		// page order in a report whose whole job is to agree with the bundle.
		for (const [slug, record] of Object.entries(manifest.pages)) {
			const sourceRecord = record.locales[manifest.sourceLocale];
			const locales: { [locale: string]: PagesLocaleEntry } = {};

			for (const locale of scope) {
				const localeRecord = record.locales[locale];
				if (localeRecord === undefined) {
					// Absence of a key is how a manifest says a page has no translation, and
					// `missing` is how a page says the same thing in a diagnostic where every
					// language is listed. This is the second of those, so the cell is written out:
					// a translator asking which pages have no Japanese file needs to see them, and
					// an absent key is exactly the row that would be scrolled past.
					locales[locale] = {
						state: 'missing',
						effectiveState: 'missing',
						title: null,
						sourceUpdated: sourceRecord?.updatedAt ?? null,
						translationUpdated: null,
					};
					continue;
				}
				locales[locale] = {
					state: localeRecord.state,
					effectiveState: effectiveState(slug, locale),
					title: localeRecord.title,
					sourceUpdated: sourceRecord?.updatedAt ?? null,
					translationUpdated: locale === manifest.sourceLocale ? null : localeRecord.updatedAt,
				};
			}

			entries.push({
				slug,
				section: sectionOf(slug),
				hidden: hidden.has(slug),
				navTitle: sourceRecord?.navTitle ?? null,
				locales,
			});
		}

		const coverage: { [locale: string]: PagesCoverage } = {};
		for (const locale of scope) {
			const declaredCoverage = manifest.coverage[locale];
			coverage[locale] =
				declaredCoverage === undefined
					? // Copied rather than shared, so no two keys of the report alias one object. It
						// is never mutated today and a report whose rows are the same object is the
						// kind of thing a later edit turns into a bug in silence.
						{ ...EMPTY_COVERAGE }
					: {
							pages: declaredCoverage.pages,
							translated: declaredCoverage.translated,
							stale: declaredCoverage.stale,
							scaffolded: declaredCoverage.scaffolded,
						};
		}

		const report: PagesReport = {
			project: manifest.project,
			locales: [...scope],
			coverage,
			pages: entries,
		};

		const total = entries.length;
		const lines = [
			`${manifest.project}: ${total} page(s) in ${scope.length} language(s), from ${origin}.`,
			'',
			// The `missing` column is arithmetic over the manifest's own numbers rather than a
			// fifth stored count. `LocaleCoverage` deliberately carries four, and deriving a
			// fifth into the data would be a second definition of a number the manifest is the
			// authority on; deriving it for a person to read is just subtraction.
			...table(
				['locale', 'pages', 'translated', 'stale', 'scaffolded', 'missing'],
				scope.map((locale) => {
					const row = coverage[locale] ?? EMPTY_COVERAGE;
					return [
						locale,
						String(row.pages),
						String(row.translated),
						String(row.stale),
						String(row.scaffolded),
						String(total - row.pages),
					];
				}),
			),
		];

		if (undeclared.length > 0) {
			lines.push(
				'',
				`${undeclared.join(', ')} is not a language this project builds, so every page reads missing in it. ` +
					`The project builds ${manifest.locales.join(', ')}.`,
			);
		}

		// No envelope, so a tree with lint errors still exits 0 here. That is deliberate:
		// the inventory of a tree is a fact about it whether or not the tree is clean, and
		// reporting the same findings from two commands would give an agent two lists to
		// reconcile. `hexdocs check` is where a finding is reported and where it fails.
		return { data: report, lines, envelope: null, rows: [] };
	},
});
