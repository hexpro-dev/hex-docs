/**
 * The markdown a scaffolded page is made of, and the reading of a source page that a
 * translation stub is built from.
 *
 * The one decision worth knowing before touching anything here: **a scaffolded
 * translation is not a copy of the English page.** The design this replaces copied the
 * source body into six locale files and stamped a digest equal to the source's, which
 * marked six locales of English as fully translated, permanently and invisibly, and left
 * no state between "missing" and "fresh" for anything to report. `translationStub` writes
 * the source's heading structure with a TODO under each heading instead.
 *
 * What actually grades the file `scaffolded` is the `translated: false` flag, and being
 * precise about that matters. `stateOf` in `kit/src/compile/build.ts` has two independent
 * detectors and either alone is enough, but the second one is a body byte identical to the
 * source, and this stub's body deliberately is not: that detector exists for the person
 * who deletes the flag and pastes the English in, not for a file this module wrote.
 * Writing the body as a skeleton is what closes the other half, which is a reader, human
 * or agent, mistaking a page of English prose for a finished translation. Neither
 * mechanism substitutes for the other and neither is decoration.
 */

import { LEAF_DIRECTIVE_PATTERN, SNIPPET_INCLUDE_NAME } from '../../../src/contracts/source.js';

/**
 * A built file, or the reason it could not be built.
 *
 * A result rather than a throw, because the one way this fails is a title or a description
 * that has no spelling in the front matter dialect this package reads, and the caller
 * wants to say so in a note beside the files it did build rather than lose the whole call
 * to an exception.
 */
export type Emitted =
	{ readonly ok: true; readonly contents: string } | { readonly ok: false; readonly why: string };

/** What a scaffolded translation copies from its source: a depth and the heading text. */
export interface StubHeading {
	/** 1 to 6, as written. */
	readonly depth: number;
	/** Everything after the hashes and the space, verbatim. */
	readonly text: string;
}

/**
 * The description a new page starts with.
 *
 * A sentence, ending in a full stop, because `description-is-a-sentence` requires one and
 * a scaffold that trips the lint it exists to serve teaches the wrong lesson on the first
 * run. It is obviously a placeholder for the same reason the deny list ships with no
 * strings: something that reads as a real description would be published as one.
 */
export const PLACEHOLDER_DESCRIPTION =
	'Replace this sentence with one sentence describing the page.';

export const TODO_TRANSLATE_PAGE = 'TODO: translate this page.';
export const TODO_TRANSLATE_SECTION = 'TODO: translate this section.';
export const TODO_WRITE_PAGE = 'TODO: write the opening paragraph.';
export const TODO_WRITE_SECTION = 'TODO: write this section.';

// ---------------------------------------------------------------------------
// front matter
// ---------------------------------------------------------------------------

/**
 * Bare scalars the reader in `kit/src/compile/frontmatter.ts` refuses, restated as one
 * test.
 *
 * It is a restatement and not an import, because that module keeps its refusal table
 * private and each entry there carries a message about what YAML would have done with the
 * value. The pairing that matters is the direction: everything this predicate calls
 * unsafe, that reader also refuses. If it ever calls something safe that the reader
 * refuses, the emitted file fails to parse with a message naming the exact construct,
 * which is a loud failure on the next `hexdocs check` rather than a quiet one.
 */
const NEEDS_QUOTING = /^['[{&*|>!%@`#]|:\s|\s#|^(?:true|false)$/;

/**
 * One front matter scalar, quoted only when a bare one would mean something else.
 *
 * Three branches and the third is a refusal, which is the honest answer: this dialect
 * implements no escapes inside a double-quoted scalar, so a value carrying a double quote
 * or a backslash has no spelling at all. Emitting one anyway would produce a file that
 * the compiler refuses to read, with a message about quoting, about a value this tool
 * chose.
 */
export function yamlScalar(value: string): Emitted {
	if (value === '') {
		return {
			ok: false,
			why: 'An empty value has no front matter spelling, and the schema refuses one anyway.',
		};
	}
	if (!NEEDS_QUOTING.test(value)) return { ok: true, contents: value };
	if (value.includes('"') || value.includes('\\')) {
		return {
			ok: false,
			why:
				`${JSON.stringify(value)} has to be quoted (a bare scalar would mean something else to ` +
				'YAML) and it carries a double quote or a backslash, which this front matter dialect ' +
				'implements no escape for. Reword it, or write the file by hand and choose the ' +
				'wording deliberately.',
		};
	}
	return { ok: true, contents: `"${value}"` };
}

/**
 * Every value shape the front matter reader can hand back.
 *
 * String, boolean and list of strings, and nothing else: the dialect is one level deep,
 * with no nested maps and no block scalars. Stated as a type here so a stub built from a
 * source page's own front matter is built from the same three cases the reader produces,
 * rather than from `unknown` and a chain of guesses.
 */
export type FrontMatterValue = string | boolean | readonly string[];

export interface FrontMatterEntry {
	readonly key: string;
	readonly value: FrontMatterValue;
}

/** Two spaces, matching the corpus. Any leading whitespace parses; consistency is free. */
const LIST_INDENT = '  ';

/**
 * A front matter block, or the first value that has no spelling in this dialect.
 *
 * An empty list is written as no key at all rather than as a bare `key:`. The reader
 * refuses a key whose value is neither a scalar nor a following `- item`, so `tags:` with
 * nothing under it would be a file this tool wrote and the compiler will not read; and an
 * empty list and an absent key mean the same thing to every consumer of the field.
 */
function frontMatterLines(
	entries: readonly FrontMatterEntry[],
): { ok: true; lines: string[] } | { ok: false; why: string } {
	const lines: string[] = [];
	for (const entry of entries) {
		if (typeof entry.value === 'boolean') {
			lines.push(`${entry.key}: ${entry.value ? 'true' : 'false'}`);
			continue;
		}
		if (typeof entry.value === 'string') {
			const scalar = yamlScalar(entry.value);
			if (!scalar.ok) return { ok: false, why: `${entry.key}: ${scalar.why}` };
			lines.push(`${entry.key}: ${scalar.contents}`);
			continue;
		}
		if (entry.value.length === 0) continue;
		lines.push(`${entry.key}:`);
		for (const item of entry.value) {
			const scalar = yamlScalar(item);
			if (!scalar.ok) return { ok: false, why: `${entry.key}: ${scalar.why}` };
			lines.push(`${LIST_INDENT}- ${scalar.contents}`);
		}
	}
	return { ok: true, lines };
}

// ---------------------------------------------------------------------------
// reading a source page
// ---------------------------------------------------------------------------

/**
 * A fence opener, and an ATX heading, copied from `kit/src/compile/markdown/blocks.ts`.
 *
 * Copied because that module exports neither, and reaching for `parseBlocks` instead
 * would mean assembling a whole `ParseServices` and a validated `DocsProjectConfig` for a
 * scaffold that runs before either exists. This is therefore a second, much narrower
 * reader of the same file, which is the shape `CLAUDE.md` warns about, so here is exactly
 * what it does and does not cover.
 *
 * It agrees with the parser on the two things it reads: which lines are ATX headings and
 * which lines are inside a fence, including the fence-closing rule (same character, at
 * least as long, nothing else on the line). It knows nothing about lists, block quotes or
 * container directives, so a `#` line indented as list continuation is a heading to this
 * and a paragraph to the parser. And it does not expand `::include`, so a heading that
 * reaches the compiled page through a snippet is not here.
 *
 * Neither gap is silent. `heading-set-matches-source` compares the compiled heading sets
 * of the two locales, so a stub whose structure came out different from the source's is
 * reported against the file it is wrong in, by the rule that exists for exactly that.
 */
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const ATX_HEADING = /^(#{1,6})[ \t]+(.*)$/;

/** Leading spaces and tabs, counted the way `blocks.ts` counts them. */
function indentOf(text: string): number {
	let count = 0;
	while (text[count] === ' ' || text[count] === '\t') count += 1;
	return count;
}

/**
 * Every line of a body that is not inside a fence, with its indent already removed.
 *
 * One walk, shared by both readers below, so the two cannot come to differ about where a
 * fence ends. The closing rule is `blocks.ts`'s: the same character, at least as long as
 * the opener, and nothing else on the line.
 */
function contentLines(body: string): string[] {
	const kept: string[] = [];
	let fence: string | null = null;

	for (const raw of body.split(/\r?\n/)) {
		const text = raw.slice(indentOf(raw));
		if (fence !== null) {
			const candidate = text.trim();
			if (
				candidate.startsWith(fence[0] as string) &&
				candidate.length >= fence.length &&
				candidate === candidate[0]?.repeat(candidate.length)
			) {
				fence = null;
			}
			continue;
		}
		const opened = FENCE.exec(text);
		if (opened !== null) {
			fence = opened[1] as string;
			continue;
		}
		kept.push(text);
	}
	return kept;
}

/**
 * The headings of a markdown body, in order, outside fenced code.
 *
 * Takes the body rather than the whole file, so front matter is already gone and a `#`
 * inside it cannot be read as a heading.
 */
export function headingsOf(body: string): StubHeading[] {
	const headings: StubHeading[] = [];
	for (const text of contentLines(body)) {
		const heading = ATX_HEADING.exec(text);
		if (heading === null) continue;
		headings.push({
			depth: (heading[1] as string).length,
			// Verbatim, trailing whitespace aside. An explicit `{#anchor}` at the end of a
			// heading is part of the text and has to survive into the translation: it is what
			// keeps one anchor addressing the same section in all seven languages, where
			// slugified heading text gives each language its own.
			text: (heading[2] as string).trimEnd(),
		});
	}
	return headings;
}

/**
 * The snippet ids a body transcludes, in order, outside fenced code.
 *
 * Read so `scaffold` can say what a stub is missing rather than guess. A stub deliberately
 * does not carry the `::include` lines: a snippet with no file in the target locale is a
 * `snippet-resolves` error, which is a publish-blocking failure on a page nobody has
 * translated yet, where leaving the include out is a `heading-set-matches-source` warning
 * on the same page. The warning is the better failure, and the note names the snippets to
 * translate so the include can go back in.
 */
export function includeIdsOf(body: string): string[] {
	const ids: string[] = [];
	for (const text of contentLines(body)) {
		const directive = LEAF_DIRECTIVE_PATTERN.exec(text.trimEnd());
		if (directive === null || directive[1] !== SNIPPET_INCLUDE_NAME) continue;
		const id = (directive[2] as string).trim();
		if (id !== '' && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

// ---------------------------------------------------------------------------
// the pages themselves
// ---------------------------------------------------------------------------

export interface SourcePageOptions {
	title: string;
	description: string;
}

/**
 * A new page in the source language: front matter and a skeleton nobody could mistake for
 * finished prose.
 *
 * No `# heading` on line one. The title is front matter and is the only place it is
 * written, because a body `h1` gives the page two competing titles in the table of
 * contents, the search index and the browser tab, and `no-h1-in-body` is what reports it.
 */
export function sourcePage(options: SourcePageOptions): Emitted {
	const front = frontMatterLines([
		{ key: 'title', value: options.title },
		{ key: 'description', value: options.description },
	]);
	if (!front.ok) return front;

	const lines = [
		'---',
		...front.lines,
		'---',
		'',
		`${TODO_WRITE_PAGE} It is what the search index and llms.txt read for this page, so`,
		'it is worth writing before the rest.',
		'',
		'## TODO: name this section',
		'',
		`${TODO_WRITE_SECTION} Add headings as the page needs them, and add the page to`,
		'docs/site/nav.json: a published page that no nav entry reaches is an orphan, and',
		'the compiler reports that as an error rather than a warning.',
		'',
	];
	return { ok: true, contents: lines.join('\n') };
}

export interface TranslationStubOptions {
	/**
	 * The source page's whole front matter, in the order it was written, minus
	 * `translated`.
	 *
	 * All of it, and that is the correction worth stating. An earlier version copied only
	 * `title`, `description` and `navTitle`, which silently dropped every page-level fact
	 * the translation shares with its source: `pageKind: faq` is the one that showed it,
	 * because `no-rhetorical-opener` exempts a page that declares itself a set of
	 * questions, so a stub built from a FAQ page came back with a house-style warning per
	 * heading, on prose the scaffolder had copied. `audience`, `tags`, `since` and
	 * `toc: false` are the same kind of fact and would have failed more quietly.
	 *
	 * The prose fields are copied untranslated. The schema requires a non-empty title and
	 * description, a placeholder would be a worse thing to publish than the English, and
	 * the file says `translated: false` so nothing reads it as a translation anyway.
	 *
	 * `draft` is the one key the caller is expected to drop: the contract reads it from
	 * the source locale only, because a missing translation has no front matter to agree
	 * with and asking six files to agree about a flag one of them can set is a rule with
	 * no right answer.
	 */
	front: readonly FrontMatterEntry[];
	/** The source's heading structure, in order. Empty is a real and valid answer. */
	headings: readonly StubHeading[];
}

/**
 * A locale file for a page nobody has translated yet.
 *
 * The body is the source's headings with a TODO under each, and never the source's prose.
 * See this module's opening paragraph for what copying the prose did.
 *
 * The TODO lines are English in a file for another language, deliberately. They are a
 * marker for whoever picks the page up, not content, and the file carries
 * `translated: false` so no reader is ever served them: a page in this state renders the
 * source language with a notice, and is `noindex`.
 */
export function translationStub(options: TranslationStubOptions): Emitted {
	const front = frontMatterLines([
		...options.front.filter((entry) => entry.key !== 'translated'),
		// Last, so it is the line a reviewer's eye lands on, and so removing it once the
		// page is translated is one line at the bottom of the block rather than one in the
		// middle of it.
		{ key: 'translated', value: false },
	]);
	if (!front.ok) return front;

	const body: string[] = [TODO_TRANSLATE_PAGE, ''];
	for (const heading of options.headings) {
		body.push(`${'#'.repeat(heading.depth)} ${heading.text}`, '', TODO_TRANSLATE_SECTION, '');
	}

	return { ok: true, contents: ['---', ...front.lines, '---', '', ...body].join('\n') };
}
