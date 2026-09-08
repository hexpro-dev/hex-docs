/**
 * `hexdocs page` / `docs_page`: one page, in one language, as text.
 *
 * Two things it is for. From a source tree it is how an agent reads a page before
 * editing it, and it returns the markdown that is actually published rather than the
 * markdown on disk: includes are expanded at compile time and leave no node behind, so
 * the file and the served document are different documents. From a bundle directory it
 * is the read-only published-docs interface: point it at what `hexdocs prefetch` wrote
 * and get the raw markdown of any page in any of the seven languages, with no compile
 * and no network.
 *
 * The pagination is the part worth reading twice. It counts code points, not bytes and
 * not UTF-16 units, and it cuts at a paragraph break. A byte offset splits a Japanese or
 * an Arabic character in half and produces mojibake at the seam in exactly the six
 * languages nobody in this repository can proofread, and the failure is invisible to
 * whoever asked for the window.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { notRunRow } from '../../../src/contracts/diagnostics.js';
import { LOCALES, type Locale } from '../../../src/contracts/locales.js';
import { pageKey, rawKey } from '../../../src/contracts/manifest.js';
import { parseSlug } from '../../../src/contracts/slug.js';
import { buildBundle } from '../compile/build.js';
import { canonicalJson, gunzipMember } from '../compile/serialise.js';
import { defineCommand } from '../registry/command.js';

import { ROOT, rootOf } from './common.js';
import { BUNDLE_DIRECTORY, readBundle } from './pages.js';

/**
 * What a window may be cut out of.
 *
 * `markdown` is what `<slug>.md` serves, includes expanded. `ast` is the compiled page
 * payload, byte for byte the JSON the bundle stores under `pages/<locale>/<slug>.json`,
 * which is what the renderer switches on.
 */
export const PAGE_FORMATS = ['markdown', 'ast'] as const;

export type PageFormat = (typeof PAGE_FORMATS)[number];

export type PageWindow = {
	text: string;
	/** Where the window starts, in code points. The requested offset, clamped to the text. */
	offset: number;
	/** Where the next window starts, or `null` when this one reached the end. */
	nextOffset: number | null;
	/** The whole document's length in code points, so a caller can size the job. */
	total: number;
	truncated: boolean;
};

/**
 * The largest paragraph boundary at or before `end`, or `null` when there is none.
 *
 * A boundary is the position just after a blank line, so the window ends where a
 * paragraph ends and the next one starts where the next paragraph starts. Carriage
 * returns and trailing spaces on the blank line count as blank, because a file that
 * arrived through a Windows editor should still cut in the right place rather than
 * silently falling back to the hard limit.
 */
function lastParagraphBreak(units: readonly string[], start: number, end: number): number | null {
	for (let position = end; position > start; position -= 1) {
		if (units[position - 1] !== '\n') continue;
		let back = position - 2;
		while (back >= 0) {
			const unit = units[back];
			if (unit !== ' ' && unit !== '\t' && unit !== '\r') break;
			back -= 1;
		}
		if (back >= 0 && units[back] === '\n') return position;
	}
	return null;
}

/**
 * One window of a document, measured in code points.
 *
 * `Array.from` rather than `slice`, and that is the whole point of this function.
 * `String.prototype.slice` indexes UTF-16 code units, so an offset that lands between
 * the two halves of a surrogate pair produces a lone surrogate at each seam: an emoji
 * turns into two replacement characters, and rejoining the windows does not put it back.
 * `Array.from` iterates code points, so a surrogate pair is one unit and a window
 * boundary can never fall inside one.
 *
 * It does not fix combining marks or a grapheme cluster, and saying so matters more than
 * the guarantee it does give: an Arabic word with a separate combining mark, or a flag
 * emoji built from two regional indicators, can still be split across two windows. What
 * makes that survivable is that the two windows concatenate back to the original bytes,
 * which is not true of a byte cut and not true of a UTF-16 cut.
 *
 * **The start is never snapped, only the end.** Snapping the start backwards would make
 * two adjacent windows overlap, so an agent concatenating them would silently duplicate
 * a paragraph, and a run of pages would come back longer than the pages are. So a caller
 * that pages with `nextOffset` always starts on a paragraph boundary because the
 * previous window ended on one, and a caller that types an offset by hand gets exactly
 * the offset it asked for.
 *
 * `snap` is off for the AST format, and not as an optimisation: canonical JSON contains
 * no literal newline at all, since the serialiser writes no whitespace between tokens
 * and escapes every newline inside a string. The scan could only ever fail, and a
 * function that quietly always falls back is worse documentation than one that says it
 * does not apply. An AST window therefore cuts at exactly `limit` code points and is a
 * fragment: concatenate every window before parsing it.
 */
export function windowOf(text: string, offset: number, limit: number, snap: boolean): PageWindow {
	const units = Array.from(text);
	const total = units.length;
	const start = Math.min(Math.max(offset, 0), total);
	const hardEnd = Math.min(start + limit, total);

	// Only snap when there is something after the window. At the end of the document the
	// hard end is the document's end, and snapping backwards from it would drop the last
	// paragraph and then report `nextOffset` for a window that had already finished.
	const snapped = snap && hardEnd < total ? lastParagraphBreak(units, start, hardEnd) : null;
	const end = snapped ?? hardEnd;

	return {
		text: units.slice(start, end).join(''),
		offset: start,
		nextOffset: end < total ? end : null,
		total,
		truncated: end < total,
	};
}

/** Levenshtein distance, two rows, no dependency. Used only to rank a suggestion. */
function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
	for (let i = 1; i <= a.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= b.length; j += 1) {
			const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
			const deletion = (previous[j] ?? 0) + 1;
			const insertion = (current[j - 1] ?? 0) + 1;
			current[j] = Math.min(substitution, deletion, insertion);
		}
		previous = current;
	}
	return previous[b.length] ?? Math.max(a.length, b.length);
}

/**
 * The slugs a typo most plausibly meant.
 *
 * Containment first, because the commonest mistake is a slug with its section dropped
 * (`first-tag` for `guide/first-tag`), and edit distance ranks that badly: the missing
 * prefix costs six edits on a short string. The distance threshold scales with the
 * query so a long slug is allowed a long typo and a three-character one is not allowed
 * to match everything.
 */
export function nearestSlugs(query: string, candidates: readonly string[]): string[] {
	const threshold = Math.max(2, Math.ceil(query.length / 3));
	const scored: { slug: string; contains: boolean; distance: number }[] = [];
	for (const slug of candidates) {
		const contains = slug.includes(query) || query.includes(slug);
		const distance = editDistance(query, slug);
		if (contains || distance <= threshold) scored.push({ slug, contains, distance });
	}
	scored.sort((a, b) => {
		if (a.contains !== b.contains) return a.contains ? -1 : 1;
		if (a.distance !== b.distance) return a.distance - b.distance;
		return a.slug < b.slug ? -1 : 1;
	});
	return scored.slice(0, 5).map((entry) => entry.slug);
}

/** The refusal a missing slug produces, with the suggestion attached. */
function noSuchSlug(slug: string, origin: string, candidates: readonly string[]): string {
	const parsed = parseSlug(slug);
	const shape = parsed.ok ? '' : ` ${parsed.message}`;
	const near = nearestSlugs(slug, candidates);
	const tail =
		near.length === 0
			? ` There are ${candidates.length} page(s); run hexdocs pages to list them.`
			: ` Did you mean ${near.join(', ')}?`;
	return `"${slug}" is not a page in ${origin}.${shape}${tail}`;
}

export type PageResult = {
	slug: string;
	locale: string;
	format: string;
	text: string;
	offset: number;
	nextOffset: number | null;
	total: number;
	truncated: boolean;
};

export const page = defineCommand({
	name: 'page',
	tool: 'docs_page',
	writes: 'nothing',
	summary: 'Read one page in one language, as markdown or as the compiled AST.',
	detail:
		'From a source tree, returns the markdown that is actually published: transclusions are expanded, so this is the document a reader gets rather than the file on disk. With --bundle it reads a compiled bundle directory instead, which needs no compile and no network, and is how an agent reads published documentation it did not write. Long pages come back a window at a time: offsets count code points, a window ends at a paragraph break, and nextOffset is where the following call starts. A slug that does not exist is refused with the nearest matches, never an empty page.',
	params: {
		// `slug` is first and `root` is last because a required positional cannot sit
		// behind an optional one: `hexdocs page guide/first-tag` has to work without the
		// caller typing a dot for a root that already defaults to the working directory.
		slug: {
			help: 'the page slug, such as guide/first-tag or index',
			type: 'string',
			required: true,
		},
		root: ROOT,
		locale: {
			help: 'the language to read',
			type: 'string',
			values: LOCALES,
			fallback: 'en',
		},
		bundle: BUNDLE_DIRECTORY,
		format: {
			help: 'markdown as published, or the compiled page payload',
			type: 'string',
			values: PAGE_FORMATS,
			fallback: 'markdown',
		},
		offset: {
			help: 'start this many code points in; use the nextOffset of the previous call',
			type: 'integer',
			fallback: 0,
		},
		limit: {
			help: 'how many code points to return at most, before the cut is moved back to a paragraph break',
			type: 'integer',
			fallback: 12000,
		},
	},
	positionals: ['slug', 'root'],
	taughtBy: ['docs-authoring', 'docs-diagnose'],
	async run(input, ctx) {
		const root = rootOf(ctx.cwd, input.root);
		// The enum has already refused anything outside these two closed sets, so the
		// narrowing here is how the type learns what the schema knows. It is not a second
		// validation, and it must not become one: a fallback branch would be a silent
		// answer to a call the schema had already refused.
		const locale: Locale = input.locale;
		const format: PageFormat = input.format;

		// One refusal shape, so every way of not reading a page produces the same output: a
		// `not-run` row, which fails the run, and a reason in the data for a caller reading
		// `--json`. An empty page with a clean exit is the one answer this command must never
		// give, because it is indistinguishable from a page that is genuinely empty.
		const fail = (why: string, unit: string) => ({
			data: { slug: input.slug, locale, format, read: false, why },
			lines: [`Could not read ${input.slug} (${locale}).`, why],
			envelope: null,
			rows: [notRunRow('page', unit, why)],
		});

		// A limit of zero reads nothing and reports `nextOffset` equal to the offset it was
		// given, which is a loop rather than a page. Refused out loud rather than clamped:
		// clamping would answer a different call from the one that was made.
		if (input.limit === 0) {
			return fail(
				'A limit of 0 code points reads nothing and would page forever. Ask for a window, or leave --limit unset.',
				'pages',
			);
		}

		let text: string;
		let origin: string;
		let note: string | null = null;

		if (input.bundle === undefined) {
			let result;
			try {
				result = buildBundle(root, { generator: ctx.kitVersion });
			} catch (error) {
				// A `ProjectError` arrives here as an `Error` whose message already names the
				// file, and a tree with no git history throws from `buildBundle` itself.
				return fail(error instanceof Error ? error.message : String(error), 'documentation trees');
			}

			const compiled = result.pages.get(input.slug);
			if (compiled === undefined) {
				return fail(noSuchSlug(input.slug, root, [...result.pages.keys()]), 'pages');
			}
			const output = compiled.get(locale);
			if (output === undefined) {
				return fail(
					`"${input.slug}" has no ${locale} file. It exists in ${[...compiled.keys()].join(', ')}. ` +
						`The site serves the source locale with a notice for a reader, and this command does ` +
						`not, because returning English under a Japanese address is a lie an agent cannot see.`,
					'pages',
				);
			}

			// The pages map carries every slug the tree holds; the manifest carries only the
			// ones a bundle would. A page in one and not the other is readable and is not
			// published, and which of the two reasons applies is worth naming: a draft is a
			// decision somebody made, and a missing source-locale file is a mistake.
			if (!(input.slug in result.manifest.pages)) {
				note = compiled.has(result.manifest.sourceLocale)
					? 'This page is marked draft, so it is readable here and is not in a bundle.'
					: `This page has no ${result.manifest.sourceLocale} file, so it gets no record in a bundle and no page is published for it.`;
			}

			// Canonical JSON rather than `JSON.stringify`, so the AST a caller reads here is
			// byte for byte the AST the bundle stores and a digest taken over either is the
			// same digest.
			text = format === 'ast' ? canonicalJson(output.page) : output.raw;
			origin = root;
		} else {
			// `root` is not read in this mode, and that is the point of the mode: a bundle
			// directory is self-contained, so an agent can read published documentation for a
			// repository it does not have a checkout of.
			const read = readBundle(ctx.cwd, input.bundle);
			if (!read.ok) return fail(read.why, 'bundles');

			const record = read.manifest.pages[input.slug];
			if (record === undefined) {
				return fail(
					noSuchSlug(input.slug, read.directory, Object.keys(read.manifest.pages)),
					'pages',
				);
			}
			if (record.locales[locale] === undefined) {
				return fail(
					`"${input.slug}" has no ${locale} translation in this bundle. It carries ${Object.keys(record.locales).join(', ')}.`,
					'pages',
				);
			}

			const key = format === 'ast' ? pageKey(locale, input.slug) : rawKey(locale, input.slug);
			const path = join(read.directory, key);
			if (!existsSync(path)) {
				// The manifest names every object the bundle holds, so a record with no file is
				// a partial download rather than a page that does not exist. Reported as its own
				// state because the fix is different: fetch the rest of the bundle.
				return fail(
					`${read.manifest.project} lists ${key} in its manifest and ${read.directory} does not hold it. That is a partial download, not a missing page.`,
					'objects',
				);
			}
			try {
				text = gunzipMember(readFileSync(path)).toString('utf8');
			} catch (error) {
				return fail(
					`${key} is not a readable gzip member: ${error instanceof Error ? error.message : String(error)}`,
					'objects',
				);
			}
			origin = read.directory;
		}

		const window = windowOf(text, input.offset, input.limit, format === 'markdown');

		const result: PageResult = {
			slug: input.slug,
			locale,
			format,
			text: window.text,
			offset: window.offset,
			nextOffset: window.nextOffset,
			total: window.total,
			truncated: window.truncated,
		};

		const header =
			`${input.slug} (${locale}, ${format}) from ${origin}: code points ` +
			`${window.offset} to ${window.offset + Array.from(window.text).length} of ${window.total}.`;
		const lines = [header, ...(note === null ? [] : [note]), '', ...window.text.split('\n')];
		if (window.nextOffset !== null) {
			lines.push(
				'',
				`Truncated. Continue with --offset ${window.nextOffset}, which is the start of the next paragraph.`,
			);
		}

		return { data: result, lines, envelope: null, rows: [] };
	},
});
