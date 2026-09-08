/**
 * The HexDoc AST.
 *
 * Markdown is parsed exactly once, at publish time, into these nodes. Syntax
 * highlighting has already resolved to scope names, links have already resolved to
 * what they point at, soft wraps have already been folded away. The runtime is a
 * switch over this union and nothing else: no parser, no sanitiser, no
 * `dangerouslySetInnerHTML`, and therefore no runtime dependency and no argument
 * about what a hostile document could do to a reader.
 *
 * There is no `html` node, by design, and no `props` bag. The compiler refuses raw
 * HTML in source rather than carrying it here, so there is no path from author text
 * to markup that the renderer did not itself construct. That is what makes "no
 * `dangerouslySetInnerHTML` anywhere" a structural property rather than a
 * convention someone has to keep.
 *
 * That guarantee covers the node tree, and only the node tree. An asset is a separate
 * file, served from the consuming site's own origin, and an SVG one is a document when
 * navigated to directly however safe it is inside `<img>`. What keeps that closed is a
 * publish-time refusal, described on `ASSET_EXTENSIONS` in `manifest.ts`, not anything
 * in this union.
 *
 * Field convention: a field is required when the renderer always branches on it, and
 * optional when absence is both meaningful and the common case. Nothing here uses
 * `null` except inside arrays, where absence cannot be expressed.
 *
 * ## What is deliberately not here
 *
 * The real corpus this package has to publish is 59 markdown files across hex-nfc,
 * hex-web's legal documents and kcalc's design notes. It contains zero images, zero
 * mermaid, zero math, zero footnotes, zero raw HTML, zero `<details>`, no heading
 * deeper than h3 and no list nested more than two levels. The union below is sized
 * to that, plus the user manual step 9 will write, and nothing else.
 *
 * - **Math.** Deferred. There is no math in the corpus, and `$…$` as an inline
 *   delimiter has two live false positives in already-published copy: "A$9.99 per
 *   month or A$6.99" in kcalc's terms, and `$0.createdAt > $1` in a Swift snippet. A
 *   MathML element tree also costs roughly fifty allowlisted identifiers that
 *   nothing would exercise. `$$…$$` is reserved: the compiler refuses it with a
 *   message rather than rendering prices as equations.
 * - **Mermaid diagrams.** Deferred, and the reason is the toolchain rather than the
 *   node. Rendering mermaid needs a real DOM for text measurement, which means
 *   headless Chromium in the publish workflow, for zero diagrams. The one
 *   architecture diagram in the corpus is box-drawing art in a code fence. An author
 *   who needs a diagram today commits an SVG and uses an image.
 * - **Footnotes and `<details>`.** No instances, no plan warrant, and footnotes add
 *   an index-ordering invariant that nothing would test.
 *
 * Adding any of these later bumps `AST_VERSION`, which costs a recompile of the
 * bundles (additive, they are commit-addressed) and one commit bumping the submodule
 * pin in each consumer. That is exactly the cost the `ast-N` key namespace exists to
 * make small, so deferring is cheap and guessing is not.
 */

import type { AssertCovers, Exact, Expect } from './exact.js';

/**
 * The AST major. It is the `ast-N` segment of every bundle key, which is what makes
 * bundles write-once: recompiling an old commit at a new major adds objects beside
 * the old ones and overwrites none, so a website pinned to an older runtime keeps
 * reading the bundle it was built against.
 *
 * Bump this for any change an existing renderer could not display correctly, which
 * includes adding a node type. Adding an optional field to an existing node is not
 * that: `hexdocs prefetch` validates a bundle's major against this constant and
 * refuses one it does not know, so an unknown field can only reach a renderer that
 * already agreed it understands the shape.
 */
export const AST_VERSION = 1;

export type AstVersion = typeof AST_VERSION;

// ---------------------------------------------------------------------------
// Inline nodes
// ---------------------------------------------------------------------------

/**
 * A run of text.
 *
 * Soft wraps are already folded in. Every file in the corpus is hard-wrapped at
 * roughly 75 columns, so a line break inside a paragraph is an artefact of the file
 * width and never content. `legal-markdown.ts` already ships the joining rule and
 * its comment records the part that is easy to get wrong: the joiner is a space
 * unless the characters on *both* sides are wide, because the seam between a Latin
 * word and a CJK word is a real space in a mixed sentence and stays one.
 *
 * Nothing strips "invisible" characters from this value. U+FE0F carries the
 * difference between a coloured warning glyph and a monochrome one, and U+200F is
 * load-bearing in the Arabic documents, where removing it reverses the visual order
 * of a line that mixes Arabic with a Latin company name.
 */
export interface TextNode {
	type: 'text';
	value: string;
}

export interface Emphasis {
	type: 'emphasis';
	children: Inline[];
}

export interface Strong {
	type: 'strong';
	children: Inline[];
}

/**
 * The corpus has no strikethrough today. It is here anyway, because it is one of the
 * three GFM extensions and the corpus already uses the other two, because a
 * changelog and a deprecation notice are the obvious near-term docs to migrate, and
 * because the alternative is a compiler that refuses `~~text~~` in source that
 * renders correctly on the GitHub page the author is reading it on.
 */
export interface Strikethrough {
	type: 'strikethrough';
	children: Inline[];
}

export interface InlineCode {
	type: 'inlineCode';
	value: string;
}

/**
 * Links are resolved at compile time into what they actually are, because the
 * renderer must not parse a URL to decide how to render one. `external` gets
 * `rel="noopener noreferrer"` and a marker; `internal` gets a client-side
 * navigation; `anchor` gets neither.
 *
 * An internal link carries a slug, never a URL. The address a slug resolves to
 * depends on the mount point and the locale, both of which belong to the consuming
 * website and neither of which the compiler knows. Baking `/hex-nfc/docs/...` into a
 * bundle would break the moment the same bundle were mounted at a second site or the
 * `basePath` changed, and it would break silently, as a working link to a 404.
 *
 * Source writes relative markdown paths, not slugs: the corpus links
 * `[Contributor Covenant](CODE_OF_CONDUCT.md)` and eight variants of
 * `[00-program.md](00-program.md)`. Resolving those to slugs is the compiler's job,
 * and an unresolvable one is an error rather than a link that quietly becomes
 * external.
 *
 * There is no `http:` kind. `legal-markdown.ts`'s `safeHref` already permits only
 * site-relative, `https:` and `mailto:` for the documents most likely to migrate
 * into this package, the corpus has no plaintext link, and widening here would put
 * the two gates out of step.
 */
export type Link =
	| {
			type: 'link';
			kind: 'internal';
			/** A slug from this project, in the same spelling `nav.json` uses. */
			slug: string;
			/** A heading id within the target page. */
			anchor?: string;
			title?: string;
			children: Inline[];
	  }
	| {
			type: 'link';
			kind: 'anchor';
			/** A heading id within this page. */
			anchor: string;
			title?: string;
			children: Inline[];
	  }
	| {
			type: 'link';
			kind: 'external';
			/** Absolute and `https:`. Nothing else reaches the renderer. */
			href: string;
			title?: string;
			children: Inline[];
	  }
	| {
			type: 'link';
			kind: 'mailto';
			/** The address, without the scheme. */
			address: string;
			title?: string;
			children: Inline[];
	  };

export type LinkKind = Link['kind'];

export interface ImageNode {
	type: 'image';
	/** Bundle-relative, `assets/<sha256>.<ext>`. Never an absolute URL. */
	src: string;
	/**
	 * Required. The linter refuses an empty one unless the project has disabled the
	 * rule, because a documentation screenshot with no text alternative is the single
	 * most common accessibility failure in a manual.
	 */
	alt: string;
	/**
	 * Intrinsic pixel dimensions, measured at compile time so the renderer can reserve
	 * space. A manual read on a phone reflows as each screenshot arrives otherwise,
	 * and the reader loses their place mid-procedure.
	 */
	width: number;
	height: number;
	title?: string;
}

/**
 * A hard line break.
 *
 * Not decorative. The legal masthead is two consecutive source lines that mean two
 * lines, and the soft-wrap folding above would otherwise join them into one.
 */
export interface BreakNode {
	type: 'break';
}

/**
 * The four states a support matrix cell can be in.
 *
 * `chip-support-matrix.md` carries 86 status glyphs, 59 white heavy check marks
 * among them, and they are the data rather than decoration: a Legend section defines
 * each one. Three things break if they stay as text. A screen reader announces
 * "white heavy check mark" in all seven languages. Search for "supported" matches no
 * row. And the global rule against decorative unicode has to grow an exception it
 * cannot express, because the same glyph is decoration on the next page.
 *
 * So the compiler recognises the glyph and the AST carries the meaning. Authors keep
 * typing the glyph, which is what makes the source still read correctly on GitHub;
 * the renderer supplies a localised label and the search index gets a real word.
 */
export const STATUS_VALUES = ['yes', 'partial', 'no', 'na'] as const;

export type StatusValue = (typeof STATUS_VALUES)[number];

export interface StatusNode {
	type: 'status';
	value: StatusValue;
}

export type Inline =
	| TextNode
	| Emphasis
	| Strong
	| Strikethrough
	| InlineCode
	| Link
	| ImageNode
	| BreakNode
	| StatusNode;

export type InlineType = Inline['type'];

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

/**
 * The highlight vocabulary.
 *
 * Highlighting resolves to these names, never to colours. A bundle carrying baked
 * theme colours could not honour a per-instance accent, could not follow the
 * reader's light or dark preference, and would have to be recompiled to restyle. The
 * compiler maps TextMate scopes onto this fixed set and drops anything that does not
 * map, so the CSS in this package owns every colour on the page.
 */
export const CODE_SCOPES = [
	'keyword',
	'string',
	'number',
	'boolean',
	'comment',
	'doc',
	'function',
	'type',
	'variable',
	'property',
	'constant',
	'operator',
	'punctuation',
	'tag',
	'attribute',
	'regexp',
	'escape',
	'deleted',
	'inserted',
	'invalid',
] as const;

export type CodeScope = (typeof CODE_SCOPES)[number];

export interface CodeToken {
	text: string;
	/** Absent means unstyled text, which is the majority of every code block. */
	scope?: CodeScope;
}

export interface CodeLine {
	tokens: CodeToken[];
}

export interface Code {
	type: 'code';
	/**
	 * The language the author wrote, normalised. Present whenever the fence carried
	 * one, *including* when no grammar exists for it.
	 *
	 * The corpus has ten `metal` fences, and no mainstream highlighter has a Metal
	 * grammar. Dropping `lang` for those would erase the language chip and make
	 * "unknown language" indistinguishable from "unlabelled fence", which are
	 * different things to a reader and to `llms.txt`.
	 */
	lang?: string;
	/** What to print on the language chip, e.g. `Metal`. Absent means print nothing. */
	langLabel?: string;
	/**
	 * Whether `lines` carries real scopes. False for an unlabelled fence and for a
	 * language with no grammar, in both of which every token is unstyled.
	 */
	highlighted: boolean;
	/** An author-supplied filename, shown above the block. */
	filename?: string;
	lines: CodeLine[];
	showLineNumbers: boolean;
	/** First line number, when the excerpt does not start at 1. */
	startLine?: number;
	/** 1-based line numbers to mark, relative to `startLine`. */
	highlight?: number[];
	/**
	 * Soft-wrap long lines. Absent means scroll horizontally, which is the default
	 * because the corpus has a box-drawing module graph and a column-aligned directory
	 * tree, and wrapping destroys both.
	 */
	wrap?: boolean;
}

// ---------------------------------------------------------------------------
// Block nodes
// ---------------------------------------------------------------------------

export interface Paragraph {
	type: 'paragraph';
	children: Inline[];
}

export type HeadingDepth = 2 | 3 | 4 | 5 | 6;

/**
 * How a heading's anchor was arrived at. Three ways, because two are already in
 * production and they are mutually incompatible.
 *
 * - `slug` is derived from the heading text. The engineering documents deep-link
 *   `#station-data` this way. It is locale-dependent by construction.
 * - `explicit` is an author-written `{#id}`. Identical in every language.
 * - `section-number` is derived from a leading section number. Every legal document
 *   depends on it: `#section-4` addresses the same clause in all seven languages, and
 *   `hex-web/apps/front/app/legal/CLAUDE.md` records why, that slugs from headings
 *   would give every language its own anchors and silently break every link into a
 *   document.
 *
 * A two-state boolean would force roughly eight hundred hand-written `{#section-N}`
 * annotations across thirty files to preserve an invariant the compiler can derive.
 */
export const HEADING_ID_SOURCES = ['slug', 'explicit', 'section-number'] as const;

export type HeadingIdSource = (typeof HEADING_ID_SOURCES)[number];

export interface Heading {
	type: 'heading';
	/**
	 * There is no depth 1. The page title is front matter, rendered by the shell, so a
	 * page always has exactly one `h1` and it always matches the title in the nav, the
	 * manifest and the search index. A source file that keeps its own `# Title` is a
	 * compile error, not a silent demotion to depth 2, which would give the page two
	 * competing titles.
	 */
	depth: HeadingDepth;
	/** Unique within the page. The anchor, the TOC key and the search record key. */
	id: string;
	/**
	 * Which rule produced `id`. `check_links` needs it to tell "this anchor is missing
	 * in ja" from "this anchor was never meant to match across languages".
	 */
	idSource: HeadingIdSource;
	/**
	 * Other anchors this heading also answers to. Unique within the page, across
	 * `id` and every `aliases` entry.
	 *
	 * This is what keeps a deep link alive across two changes that would otherwise
	 * break it silently. A translated page carries the source locale's slug here, so
	 * `#station-data` written against the English page still lands on the right
	 * section of the Japanese one. A renamed heading carries its former slug here, so
	 * a link from a support reply written last year still works.
	 *
	 * The renderer emits `id` and leaves the rest to a scroll handler, rather than
	 * emitting seven empty anchor elements per heading.
	 */
	aliases?: string[];
	/**
	 * Inline, never a string. A heading in the corpus can be entirely inline code
	 * (`### \`HexNFCRecords\``) or contain a link (`## [Unreleased]`, resolved against
	 * a definition at the foot of the file).
	 */
	children: Inline[];
}

export type ListStyle = 'bullet' | 'ordered';

export interface ListItem {
	type: 'listItem';
	/** Present only for task list items. Absent means an ordinary item. */
	checked?: boolean;
	children: Block[];
}

export interface ListNode {
	type: 'list';
	style: ListStyle;
	/** Ordered lists that do not start at 1. */
	start?: number;
	/** Items render without paragraph spacing. Always explicit: the renderer branches on it. */
	tight: boolean;
	children: ListItem[];
}

export interface Blockquote {
	type: 'blockquote';
	/**
	 * Block, not inline. The corpus quotes whole paragraphs carrying links, bold and
	 * inline code; an inline-only quote would lose both the link and the paragraph
	 * boundary.
	 */
	children: Block[];
}

/**
 * The five GitHub alert kinds, spelled the way GitHub spells them.
 *
 * That is deliberate. Documentation lives in the app repository, where developers
 * read it in the GitHub UI before it is ever published. `> [!WARNING]` renders there;
 * an invented vocabulary renders as a stray blockquote. The `:::warning` directive
 * form compiles to the same node for authors who prefer it.
 *
 * The corpus has no callouts yet. What it has is nineteen blockquotes per kcalc
 * design document carrying callout semantics through a bold lead-in, which is what
 * the migration lint offers to promote.
 */
export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;

export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export interface Callout {
	type: 'callout';
	kind: CalloutKind;
	/** Author-supplied heading. Absent means the localised default label for `kind`. */
	title?: Inline[];
	children: Block[];
}

export type TableAlign = 'left' | 'center' | 'right';

export interface TableCell {
	type: 'tableCell';
	/**
	 * Inline only. GFM tables cannot hold block content, and inventing an extension
	 * that can would produce source markdown that renders as a broken table on GitHub,
	 * which is where the author reads it. Cells do carry inline code, links, bold and
	 * status glyphs: one kcalc reference table has 213 such cells.
	 */
	children: Inline[];
}

export interface Table {
	type: 'table';
	caption?: Inline[];
	/**
	 * One entry per column; `null` is the reader's default alignment.
	 *
	 * Not one delimiter row in the corpus uses a colon, so every real table is
	 * all-null and this field's only coverage is the fixture corpus. Worth knowing
	 * before trusting a bug report about alignment.
	 */
	align: (TableAlign | null)[];
	header: TableCell[];
	rows: TableCell[][];
}

/**
 * A block-level image with an optional caption. The compiler promotes a paragraph
 * containing nothing but an image into one of these, which is what makes the
 * difference between `<p><img></p>` and `<figure>` a compile-time decision rather
 * than a renderer heuristic.
 */
export interface Figure {
	type: 'figure';
	image: ImageNode;
	caption?: Inline[];
}

export interface ThematicBreak {
	type: 'thematicBreak';
}

export interface Step {
	type: 'step';
	/** Anchor, so an individual step is linkable from a support reply. */
	id: string;
	title: Inline[];
	children: Block[];
}

/**
 * An ordered procedure.
 *
 * Distinct from an ordered list because it is the only structure `HowTo` JSON-LD can
 * be derived from without guessing. A numbered list might be steps, or might be a
 * ranking; a `:::steps` container says which, once, where the author can see it.
 *
 * No corpus instance yet. The manual written in step 9 is what this is for, and
 * until then the fixture corpus is its only coverage.
 */
export interface Steps {
	type: 'steps';
	children: Step[];
}

export type Block =
	| Paragraph
	| Heading
	| ListNode
	| Code
	| Blockquote
	| Callout
	| Table
	| Figure
	| ThematicBreak
	| Steps;

export type BlockType = Block['type'];

/**
 * Nodes that only ever appear as the child of a specific parent. They are not part
 * of `Block` or `Inline`, so the renderer's two exhaustive switches stay exhaustive
 * and a `listItem` can never turn up where a paragraph belongs.
 */
export type ChildNode = ListItem | TableCell | Step;

export type AstNode = Block | Inline | ChildNode;

export type AstNodeType = AstNode['type'];

/**
 * The node types, as values.
 *
 * A discriminated union exists only at compile time, so nothing at runtime can
 * enumerate it, and a test that cannot enumerate the thing it covers is a test that
 * silently examines fewer cases every time a node type is added. These arrays are
 * pinned to their unions at the foot of this file: adding a node type to `Block`
 * without adding it here fails the typecheck, and adding it here without adding it
 * to `Block` fails too.
 *
 * The golden renderer suite, the schema registry and the compiler's coverage check
 * all iterate these, so their counts move with the union rather than with whoever
 * remembered.
 */
export const BLOCK_TYPES = [
	'paragraph',
	'heading',
	'list',
	'code',
	'blockquote',
	'callout',
	'table',
	'figure',
	'thematicBreak',
	'steps',
] as const;

export const INLINE_TYPES = [
	'text',
	'emphasis',
	'strong',
	'strikethrough',
	'inlineCode',
	'link',
	'image',
	'break',
	'status',
] as const;

export const CHILD_TYPES = ['listItem', 'tableCell', 'step'] as const;

export const AST_NODE_TYPES = [...BLOCK_TYPES, ...INLINE_TYPES, ...CHILD_TYPES] as const;

// ---------------------------------------------------------------------------
// Exhaustiveness
// ---------------------------------------------------------------------------

/**
 * The compiler's default branch.
 *
 * Throws, because the compiler controls its own input: a node it cannot handle is a
 * bug in the code that just produced it, and a bundle must not be written from a
 * tree the writer did not understand.
 *
 * This is *not* the renderer's default branch. See `unhandledNode`.
 */
export function assertNever(value: never, context: string): never {
	const seen = (value as { type?: unknown } | null)?.type;
	throw new Error(
		`${context}: unhandled node ${typeof seen === 'string' ? `"${seen}"` : JSON.stringify(value)}.`,
	);
}

const warnedNodeTypes = new Set<string>();

/**
 * The renderer's default branch. Renders nothing, and says so once per node type
 * when a development build is running.
 *
 * It does not throw, and the difference from `assertNever` is about who controls the
 * input. The renderer is handed a bundle compiled somewhere else, possibly by a
 * newer toolchain, and taking a whole page to a 500 over one node it could have
 * skipped is a worse outcome than a paragraph that does not appear.
 *
 * This is a last resort rather than the guard. The real check is `hexdocs prefetch`,
 * which compares a bundle's `ast` major against `AST_VERSION` and refuses one it does
 * not know, so reaching here at all means that already failed.
 *
 * It warns in production too. There is no `NODE_ENV` check here, partly because this
 * half compiles with no ambient node types on purpose, and mostly because an unknown
 * node in production is a real misconfiguration that somebody should see. Once per
 * node type per process is not noise.
 */
export function unhandledNode(node: { type?: unknown }, context: string): null {
	const seen = typeof node?.type === 'string' ? node.type : '(no type)';
	if (!warnedNodeTypes.has(seen)) {
		warnedNodeTypes.add(seen);
		console.warn(
			`[hex-docs] ${context}: skipped unknown node "${seen}". ` +
				`This bundle was compiled at a newer AST major than this runtime (${AST_VERSION}).`,
		);
	}
	return null;
}

/** Test seam. Nothing else should need it. */
export function resetUnhandledNodeWarnings(): void {
	warnedNodeTypes.clear();
}

// ---------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------

/*
 * These fail the typecheck when a node type is added to a union without being added
 * to the matching array, or the other way round. The error names the node type.
 *
 * Without them the arrays above are just a list somebody maintains by hand, every
 * suite that iterates them silently covers one case fewer, and the first sign of it
 * is a node type that renders as nothing in production.
 */
type _blockTypesCovered = Expect<AssertCovers<typeof BLOCK_TYPES, BlockType>>;
type _inlineTypesCovered = Expect<AssertCovers<typeof INLINE_TYPES, InlineType>>;
type _childTypesCovered = Expect<AssertCovers<typeof CHILD_TYPES, ChildNode['type']>>;
type _allTypesCovered = Expect<AssertCovers<typeof AST_NODE_TYPES, AstNodeType>>;

/* Block and Inline must stay disjoint: the renderer has two exhaustive switches and
 * a type in both would make one of them unreachable for that node. */
type _unionsDisjoint = Expect<Exact<BlockType & InlineType, never>>;
