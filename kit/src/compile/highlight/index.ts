/**
 * Highlighting, resolved once at publish time.
 *
 * The renderer never sees source. A `Code` node carries lines of tokens whose scopes
 * are names from `CODE_SCOPES`, and the CSS in this package owns every colour, which is
 * what lets one bundle follow a reader's light or dark preference and a per-instance
 * accent without being recompiled. A highlighter shipped to the browser would be a
 * runtime dependency, a parser running over author text on somebody else's page, and a
 * second opinion about what colour a keyword is.
 *
 * A grammar here classifies, it does not tokenise. `scan` returns contiguous spans over
 * the fence body and `linesFrom` does the slicing, so the text of every token is a slice
 * of the input and no grammar can drop, reorder or rewrite a character. That is the
 * whole shape of the module, because the failure it prevents is silent: a highlighter
 * that loses a backslash publishes a snippet that does not compile, and nobody reviewing
 * a coloured code block notices a missing character.
 *
 * ## The four cases, which look identical in the tokens
 *
 * Three of the four produce one unstyled token per line, so `highlighted` and `label`
 * are the only things that tell them apart, and both are stated rather than inferred.
 *
 * - **No language.** An unlabelled fence: unstyled, `highlighted` false, no label.
 * - **`text`.** The named plain language, for the box-drawing module graph and the
 *   column-aligned directory tree the corpus carries. Unstyled, `highlighted` false,
 *   and no label: a chip reading "Text" over a directory tree is noise on every page
 *   that has one, and it is the difference between this and an unknown language.
 * - **A language with a grammar.** Scoped tokens, `highlighted` true, label from the
 *   table.
 * - **A language with no grammar.** `metal` is the live case, ten fences in hex-nfc and
 *   no mainstream highlighter has a Metal grammar. Unstyled, `highlighted` false, and
 *   the label is still printed. `Code.lang` records why: dropping the language there
 *   would make "unknown language" indistinguishable from "unlabelled fence", which are
 *   different things to a reader and to `llms.txt`.
 */

import type { CodeLine, CodeScope, CodeToken } from '../../../../src/contracts/ast.js';
import { PLAIN_CODE_LANGUAGE } from '../../../../src/contracts/project.js';
import type { HighlightResult } from '../types.js';
import { jsonGrammar } from './json.js';
import { swiftGrammar } from './swift.js';

// ---------------------------------------------------------------------------
// What a grammar is
// ---------------------------------------------------------------------------

/**
 * One classified run of the fence body.
 *
 * `end` is the offset one past the last character covered, and a span starts where the
 * previous one ended, so a span list cannot express a gap, an overlap or a reordering.
 * The alternative, a start and an end per span, can express all three, and each one
 * loses or duplicates source text on the published page.
 *
 * An absent `scope` is unstyled, which is the majority of every code block.
 */
export interface Span {
	end: number;
	scope?: CodeScope;
}

/**
 * A language this package can highlight.
 *
 * `scopes` is the declared vocabulary: every scope `scan` can emit, and nothing else.
 * It is here so the suite can check a grammar against what it really produces in both
 * directions. Without it a rule that stopped firing, a keyword set that quietly lost
 * `guard`, say, would leave every test green: an unstyled token still round-trips, and
 * every scope still present is still a legal one.
 *
 * There is deliberately no `label` field. `LANGUAGE_LABELS` is the one table, because
 * `metal` needs a label and has no grammar, and a label in both places is two sources
 * of truth for the same string with nothing keeping them in step.
 */
export interface Grammar {
	scopes: readonly CodeScope[];
	scan: (code: string) => readonly Span[];
}

/**
 * The grammars, by lower-case language id.
 *
 * Two, and both were written because the corpus has fences in them. Adding a third is a
 * file beside these two and a key here; nothing else in the compiler changes, because a
 * language with no grammar is already a supported outcome rather than an error.
 */
export const GRAMMARS: Readonly<Record<string, Grammar>> = {
	json: jsonGrammar,
	swift: swiftGrammar,
};

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * What the language chip prints, by lower-case language id.
 *
 * Lower-case keys, because that is how a fence info string is written and how
 * `code.languages` in a project config lists them. The entries are what a census of the
 * fences in hex-nfc, kcalc's documents and hex-web's legal documents actually counts,
 * which is swift, metal, bash, sh, ts, xml and sql, plus the json the fixture corpus
 * adds. Nothing is here on the grounds that a project might one day want it.
 *
 * An id with no entry falls back to the id the author typed, so a project that adds a
 * language to its allowlist gets a chip reading `kotlin` rather than no chip at all.
 * That fallback is what makes growing this table cosmetic rather than load-bearing.
 *
 * `text` is absent on purpose and `languageLabel` refuses it outright rather than
 * falling back to the id.
 */
export const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
	bash: 'Bash',
	json: 'JSON',
	metal: 'Metal',
	sh: 'Shell',
	sql: 'SQL',
	swift: 'Swift',
	ts: 'TypeScript',
	xml: 'XML',
};

/** What to print on the language chip, or `undefined` when nothing should be printed. */
export function languageLabel(lang: string): string | undefined {
	const id = lang.toLowerCase();
	if (id === PLAIN_CODE_LANGUAGE) return undefined;
	return LANGUAGE_LABELS[id] ?? lang;
}

// ---------------------------------------------------------------------------
// Spans to lines
// ---------------------------------------------------------------------------

/**
 * Slices `code` by `spans` into lines of tokens.
 *
 * Exported for the suite, which feeds it span lists no grammar in this package
 * produces: one that stops short of the end, and one whose spans go backwards. Both are
 * recoverable and neither loses a character. That is worth testing directly rather than
 * inferring from the two grammars that happen to be correct today, because the two
 * recovery branches are the ones a third grammar will be the first to reach.
 *
 * Text past the last span is unstyled, and that is also how the unhighlighted path is
 * expressed: no spans at all. A span that does not advance past the last one is skipped,
 * which costs it its scope and nothing else.
 *
 * Lines are split on U+000A alone. A body with CRLF endings therefore keeps its carriage
 * returns inside the token text: dropping them would read as tidying up and would be the
 * one edit here that breaks the round trip.
 *
 * Adjacent slices with the same scope are merged, so a run of plain text is one token
 * rather than one per character. An empty line is a `CodeLine` with no tokens at all.
 */
export function linesFrom(code: string, spans: readonly Span[]): CodeLine[] {
	const lines: CodeLine[] = [];
	let tokens: CodeToken[] = [];

	const add = (text: string, scope: CodeScope | undefined): void => {
		if (text === '') return;
		const last = tokens[tokens.length - 1];
		if (last !== undefined && last.scope === scope) {
			last.text += text;
			return;
		}
		tokens.push(scope === undefined ? { text } : { text, scope });
	};

	const write = (text: string, scope: CodeScope | undefined): void => {
		text.split('\n').forEach((part, index) => {
			if (index > 0) {
				lines.push({ tokens });
				tokens = [];
			}
			add(part, scope);
		});
	};

	let cursor = 0;
	for (const span of spans) {
		if (span.end <= cursor) continue;
		write(code.slice(cursor, span.end), span.scope);
		cursor = span.end;
	}
	write(code.slice(cursor), undefined);
	lines.push({ tokens });
	return lines;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Turns a fence body into lines of scoped tokens.
 *
 * The one trailing newline is the fence's own, not the author's: a fence body runs up to
 * the newline before the closing marker. Removing exactly one is what makes the last
 * line the last line rather than an empty one after it, and removing more would delete a
 * blank line the author wrote and meant.
 *
 * The language is matched case-insensitively, so a fence opened with `Swift` gets the
 * Swift grammar. The label still comes back in the author's own spelling, because an id
 * with no entry in the table is printed as typed.
 */
export function highlight(code: string, lang: string | undefined): HighlightResult {
	const body = code.endsWith('\n') ? code.slice(0, -1) : code;
	if (lang === undefined) return { lines: linesFrom(body, []), highlighted: false };

	const grammar = GRAMMARS[lang.toLowerCase()];
	const label = languageLabel(lang);
	const result: HighlightResult = {
		lines: linesFrom(body, grammar === undefined ? [] : grammar.scan(body)),
		highlighted: grammar !== undefined,
	};
	if (label !== undefined) result.label = label;
	return result;
}
