/**
 * The seams inside the compiler.
 *
 * Everything here is internal to `kit/`. The wire formats are in `src/contracts/`, and
 * nothing in this file is ever serialised: these are the shapes the parser, the
 * linter, the highlighter and the bundle writer hand each other. They live in one
 * module because the alternative is each pair of modules agreeing bilaterally, which
 * is how the same concept ends up with two names and one of them silently loses a
 * field.
 *
 * Two ideas here carry most of the weight, and both exist because a diagnostic without
 * a line number is a diagnostic somebody has to go looking for.
 *
 * **Positions live beside the tree, never in it.** The AST has no line numbers, on
 * purpose: it is a wire format read by a renderer that has no source. So the parser
 * records where each node came from in a `WeakMap` keyed by the node itself, and
 * whoever needs a position asks for it. A node the map has never seen is a node the
 * parser did not create, which is the honest answer to give.
 *
 * **Prose is extracted once, with a map back to the source.** House-style rules read
 * prose, not markdown: a banned phrase that straddles a soft wrap has to be found, a
 * status glyph in a table cell has to be invisible to them, and the contents of a code
 * fence must never be scanned for an em dash. A `ProseSegment` is the text of one
 * block with its inline markup removed and its soft wraps folded, plus the runs that
 * say which source line every character came from. That is what lets a phrase match at
 * offset 41 of a folded paragraph report line 12, column 3.
 */

import type { Block, CodeLine, Inline } from '../../../src/contracts/ast.js';
import type { AssetExtension, ColourProbe } from '../../../src/contracts/manifest.js';
import type { FindingLocation } from '../../../src/contracts/diagnostics.js';
import type { RuleId } from '../../../src/contracts/lint.js';
import type { Locale } from '../../../src/contracts/locales.js';

// ---------------------------------------------------------------------------
// Findings before the registry sees them
// ---------------------------------------------------------------------------

/**
 * What a rule returns.
 *
 * Deliberately not a `Finding`. `severity`, `category` and `consequence` come from the
 * rule registry and the project config, and a rule that could set its own severity
 * would be a rule a project cannot configure. `lint.ts` states the same thing from the
 * other side: config is applied to the findings a rule returns, not inside it, which
 * is what lets a rule be golden-tested against a fixture page with no config at all.
 */
export interface RawFinding {
	/**
	 * A `LintRuleId` or a `CheckId`. Both spaces share one namespace in `Finding.rule`,
	 * so a report reads the same whichever produced it, and the compiler's own structural
	 * refusals need the second one.
	 */
	rule: RuleId;
	location: FindingLocation;
	locale: Locale | null;
	message: string;
	remediation: string | null;
	suggestion: string | null;
	excerpt: string | null;
}

/**
 * A `RawFinding` with the three optional halves defaulted to `null`.
 *
 * They are `T | null` and always present in the wire shape, for the reason
 * `diagnostics.ts` gives: an agent must be able to tell "there is no suggested fix"
 * from "the suggested fix is to delete this". Defaulting them here means a rule that
 * has nothing to suggest writes nothing rather than writing `undefined`, which would
 * serialise to an absent key and put the ambiguity back.
 */
export function raw(
	rule: RuleId,
	location: FindingLocation,
	locale: Locale | null,
	message: string,
	extra: Partial<Pick<RawFinding, 'remediation' | 'suggestion' | 'excerpt'>> = {},
): RawFinding {
	return {
		rule,
		location,
		locale,
		message,
		remediation: extra.remediation ?? null,
		suggestion: extra.suggestion ?? null,
		excerpt: extra.excerpt ?? null,
	};
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** Where something is in a source file. Both 1-based, as every editor counts them. */
export interface SourcePosition {
	/** Relative to `docs/site/`, so it is the same string the manifest and a finding use. */
	file: string;
	line: number;
	column: number;
}

/**
 * Node to source position.
 *
 * A `WeakMap` rather than a field on the node, because the node is the wire format and
 * a position field would be published. Keyed by the node object, so a node copied or
 * rebuilt loses its position rather than inheriting a wrong one, which is the failure
 * worth having: a diagnostic pointing at the wrong line is worse than one pointing at
 * the file.
 */
export type NodeOrigins = WeakMap<object, SourcePosition>;

/**
 * A `FindingLocation` for a node, falling back to the file when the node is unknown.
 *
 * Every caller wants this and nobody wants to write the fallback, which is how half of
 * them end up not writing it.
 */
export function locate(origins: NodeOrigins, node: object, file: string): FindingLocation {
	const at = origins.get(node);
	if (at === undefined) return { kind: 'file', file };
	return { kind: 'file', file: at.file, line: at.line, column: at.column };
}

// ---------------------------------------------------------------------------
// Folded text and prose
// ---------------------------------------------------------------------------

/**
 * One contiguous run of characters in a folded string, and where it came from.
 *
 * A run is at most one source line. A folded paragraph is a sequence of runs with a
 * one-character joiner between them, or no joiner where both sides are wide, which is
 * the CJK rule `TextNode` records.
 */
export interface SourceRun {
	/** Offset of this run within the folded text. */
	offset: number;
	length: number;
	line: number;
	/** Column in the source line the run starts at. */
	column: number;
}

/**
 * Source lines folded into the single string the inline parser reads, with the map
 * back.
 *
 * The map is the whole point. Without it every inline node would carry the line the
 * block started on, and a fifty-line procedure would report every finding against its
 * first line.
 */
export interface FoldedText {
	text: string;
	runs: SourceRun[];
}

/**
 * The source position of an offset in a folded string.
 *
 * An offset inside a joiner belongs to the run that follows it, because a joiner is
 * not a character the author typed and pointing at one points between two lines.
 * Offsets past the end resolve to the end of the last run rather than throwing: a rule
 * reporting a span that ends at the end of a paragraph is ordinary, and a throw there
 * would turn a style finding into a compiler crash.
 */
export function positionAt(folded: FoldedText, file: string, offset: number): SourcePosition {
	let last: SourceRun | undefined;
	for (const run of folded.runs) {
		if (offset < run.offset) return { file, line: run.line, column: run.column };
		if (offset < run.offset + run.length) {
			return { file, line: run.line, column: run.column + (offset - run.offset) };
		}
		last = run;
	}
	if (last === undefined) return { file, line: 1, column: 1 };
	return { file, line: last.line, column: last.column + last.length };
}

/**
 * Where a run of prose sits, so a rule can say more than "somewhere on this page".
 *
 * `frontMatter` is the values of the string-valued keys and nothing else: the keys and
 * the delimiters are not prose, and a rule that flagged the word `description` would
 * be unanswerable.
 */
export type ProseKind =
	| 'frontMatter'
	| 'paragraph'
	| 'heading'
	| 'listItem'
	| 'blockquote'
	| 'tableCell'
	| 'caption'
	| 'stepTitle'
	// A link or image title, or a code fence's `title=`. Its own kind rather than part of
	// the block it sits in, because it is not part of the sentence around it and joining
	// the two manufactures an adjacency no author wrote.
	| 'title';

/**
 * One block's prose: what a reader reads, with a map back to what the author typed.
 *
 * Inline markup is gone, inline code is gone, code fences never appear, and a
 * recognised status glyph is gone because the compiler turned it into data before this
 * existed. That last one is the reason this type exists rather than a regex over the
 * file: `no-decorative-unicode` must see the tick that is decoration and must not see
 * the 59 that are a support matrix.
 */
export interface ProseSegment {
	file: string;
	kind: ProseKind;
	folded: FoldedText;
	/**
	 * The block this prose belongs to, when it belongs to one.
	 *
	 * Present so a rule can ask what kind of block it is looking at without the segment
	 * having to restate it. Absent for front matter, which has no node.
	 */
	node?: Block;
}

/** Every prose segment's text, for a rule that only wants the words. */
export function proseText(segment: ProseSegment): string {
	return segment.folded.text;
}

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

/**
 * The front matter block, read but not yet validated.
 *
 * `data` is deliberately `unknown`-valued: validation is `frontMatterSchema`'s job and
 * a reader that narrowed here would be a second, weaker schema. What the reader owes
 * is the shape and the line numbers, so that "description is 190 characters" can point
 * at the line the description is on rather than at the file.
 */
export interface FrontMatterBlock {
	data: Record<string, unknown>;
	/** Key to the 1-based line it is declared on. */
	keyLines: Record<string, number>;
	/** The values of the string-valued keys, as prose. */
	prose: ProseSegment[];
	/** 1-based line of the first body line, so body positions are absolute. */
	bodyLine: number;
	body: string;
	problems: RawFinding[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * A `hexdocs-disable-next-line` comment, as read from the source.
 *
 * Kept rather than applied in place, because two separate things need it: the runner
 * drops the findings it covers, and `maxDisables` counts them. A mechanism that only
 * dropped findings would make the count unknowable, which is the state the cap exists
 * to prevent.
 */
export interface DisableComment {
	file: string;
	/** The line the comment is on. It suppresses findings on the line after it. */
	line: number;
	rule: string;
	reason: string;
	/** True once a finding has actually been dropped by it. */
	used: boolean;
}

/** What `parseDocument` returns for one markdown file. */
export interface ParsedDocument {
	/** Relative to `docs/site/`. */
	file: string;
	/**
	 * What the parser read, after `readSource` normalised it.
	 *
	 * Kept because one caller has to scan the characters the parse deliberately dropped:
	 * the deny rules look for a device identifier or an internal name, and a fence body,
	 * an inline code run and a link target are all published and all absent from `prose`.
	 * Normalised rather than the file's own bytes, so a line number taken from it is the
	 * same line number every finding here already carries.
	 */
	source: string;
	frontMatter: FrontMatterBlock;
	blocks: Block[];
	origins: NodeOrigins;
	prose: ProseSegment[];
	/** Snippet ids this document transcludes, in document order, duplicates included. */
	includes: string[];
	disables: DisableComment[];
	problems: RawFinding[];
}

/**
 * What the parser needs from outside itself.
 *
 * All three are callbacks rather than data, because each one needs something the
 * parser has no business knowing: which slugs exist, what a snippet expands to, and
 * how a language is highlighted. Passing them in is what keeps the parser testable
 * against a string with no project around it.
 */
export interface ParseServices {
	/**
	 * Resolves a markdown link target to the fields of a `Link` node.
	 *
	 * Returns a problem message instead when the target does not resolve, and the
	 * parser then emits the link's children as plain inline. A bundle carrying a broken
	 * link would be a link to a 404 that renders as a link; dropping it leaves the words
	 * and reports the failure, and `link-resolves` is an error so nothing publishes
	 * either way.
	 */
	resolveLink: (href: string, title: string | undefined) => LinkResolution;
	/**
	 * Expands `::include[id]`. Returns the snippet's blocks, already parsed, with their
	 * own origins merged into the caller's map.
	 */
	resolveInclude: (id: string, at: SourcePosition) => IncludeResolution;
	/** Resolves an image path to a bundle-relative `assets/<sha256>.<ext>` and its size. */
	resolveImage: (src: string) => ImageResolution;
	/** Turns a fence body into lines of scoped tokens. */
	highlight: (code: string, lang: string | undefined) => HighlightResult;
}

/**
 * A resolved link, minus its children.
 *
 * Distributed over the union by hand, because `Omit` does not distribute: `Omit<A | B,
 * 'children'>` keys itself on `keyof (A | B)`, which is the intersection, so the four
 * link kinds would collapse into one object with no `slug`, no `href` and no
 * `address`. The parser would then typecheck while building links that carry no
 * destination.
 */
export type ResolvedLink =
	Extract<Inline, { type: 'link' }> extends infer T
		? T extends { type: 'link' }
			? Omit<T, 'children'>
			: never
		: never;

export type LinkResolution =
	{ ok: true; link: ResolvedLink } | { ok: false; message: string; remediation: string | null };

/**
 * An expanded snippet.
 *
 * No origins come back with it. The resolver writes into the same `NodeOrigins` map the
 * page is being parsed with, because a `WeakMap` cannot be enumerated and therefore
 * cannot be merged: two maps would mean every finding on a transcluded block reported
 * the page's file and the snippet's line.
 */
export type IncludeResolution =
	{ ok: true; blocks: Block[] } | { ok: false; message: string; remediation: string | null };

export type ImageResolution =
	| { ok: true; src: string; width: number; height: number }
	| { ok: false; message: string; remediation: string | null };

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

/**
 * What a grammar produces for one fence.
 *
 * `highlighted` is not derivable from the tokens: a fence in a language with no
 * grammar produces one unstyled token per line, and so does an unlabelled fence, and
 * so does a Swift fence that happens to be a single identifier. The renderer branches
 * on it to decide whether to say the block is unhighlighted, so it is stated rather
 * than inferred.
 */
export interface HighlightResult {
	lines: CodeLine[];
	highlighted: boolean;
	/** What to print on the language chip. Absent means print nothing. */
	label?: string;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** What the probe reads out of an asset's bytes. */
export interface ProbedAsset {
	ext: AssetExtension;
	bytes: number;
	width: number;
	height: number;
	colour: { space: 'srgb'; probe: ColourProbe };
	/**
	 * Always `null` in this version, and the reason is the same one that makes a Display
	 * P3 asset a refusal rather than a conversion.
	 *
	 * `AssetRecord.lqip` wants base64 of a 20 by 20 webp. Every encoder available here
	 * is a shell out to ffmpeg or cwebp, whose output varies by build, and the manifest
	 * has to be byte-reproducible from the commit alone or the write-once refusal fires
	 * on a re-run that changed nothing. A deterministic encoder written in this
	 * repository would qualify; borrowing the host's does not.
	 */
	lqip: null;
}

export type AssetProbe =
	| { ok: true; asset: ProbedAsset }
	| { ok: false; rule: RuleId; message: string; remediation: string | null };
