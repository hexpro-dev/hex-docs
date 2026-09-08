/**
 * Which page produces which AST node, and how to tell it is still there.
 *
 * The corpus exists so that every node type is reachable from real source. That claim
 * is worth nothing unless something checks it, because the failure mode is silent: a
 * page gets rewritten, the construct goes with it, the compiler's golden test still
 * passes against whatever the page now says, and one node type quietly stops being
 * exercised anywhere.
 *
 * So every node type is claimed here by at least one page, and every claim carries a
 * pattern that must still match that page's source. The suite fails when a node type
 * has no claim, when a claimed file does not exist, and when a claimed pattern stops
 * matching. `AST_NODE_TYPES` is the list it checks against, so adding a node type to
 * the union without adding it to the corpus fails here rather than at publish time.
 *
 * Patterns match SOURCE, not the tree. They are what the compiler will be looking for,
 * so they double as the statement of how each construct is spelled.
 */

import type { AstNodeType } from '../src/contracts/ast.js';

export interface NodeClaim {
	type: AstNodeType;
	/** Which shape of the node, when one type has several worth covering separately. */
	variant?: string;
	/** Relative to `app/docs/site/`. */
	file: string;
	pattern: RegExp;
	why: string;
}

export const NODE_CLAIMS: readonly NodeClaim[] = [
	// ---- blocks ----------------------------------------------------------
	{
		type: 'paragraph',
		file: 'content/en/index.md',
		pattern: /\n\nFixture App turns an iPhone/,
		why: 'The commonest node, and the one whose soft wraps have to fold back into a single text value.',
	},
	{
		type: 'heading',
		variant: 'depth 2, slug id',
		file: 'content/en/index.md',
		pattern: /^## What you need$/m,
		why: 'The default anchor rule: an id derived from the heading text, which is locale-dependent by construction.',
	},
	{
		type: 'heading',
		variant: 'depth 3',
		file: 'content/en/guide/troubleshooting.md',
		pattern: /^### Check the tag before you blame the phone$/m,
		why: 'The middle level, so heading order is exercised rather than assumed.',
	},
	{
		type: 'heading',
		variant: 'depth 4',
		file: 'content/en/guide/troubleshooting.md',
		pattern: /^#### Tags that read once and then go quiet$/m,
		why: 'The deepest heading in the corpus. `toc.maxDepth` is 3, so this is also the heading the table of contents must leave out.',
	},
	{
		type: 'heading',
		variant: 'explicit id',
		file: 'content/en/developer/architecture.md',
		pattern: /^## Module graph \{#module-graph\}$/m,
		why: 'The one anchor spelling that is identical in every language, and the only reason `idSource` has three values rather than two.',
	},
	{
		type: 'list',
		variant: 'bullet, tight',
		file: 'content/en/index.md',
		pattern: /^- text records, with the language code the tag declares$/m,
		why: 'Tight is always explicit on the node because the renderer branches on it.',
	},
	{
		type: 'list',
		variant: 'ordered, loose',
		file: 'content/en/guide/index.md',
		pattern: /^1\. \[Scan your first tag\]\(first-tag\.md\)/m,
		why: 'An ordered list whose items are paragraphs, which is the other half of the tight flag.',
	},
	{
		type: 'list',
		variant: 'ordered, start 3',
		file: 'content/en/guide/first-tag.md',
		pattern: /^3\. "Still looking" appears in the status line/m,
		why: 'The only coverage for `start`. A list that does not begin at 1 is otherwise renumbered silently.',
	},
	{
		type: 'list',
		variant: 'task items',
		file: 'content/en/guide/first-tag.md',
		pattern: /^- \[x\] An iPhone 7 or later/m,
		why: 'The `checked` field, which is present only on task items and absent on every other item.',
	},
	{
		type: 'list',
		variant: 'nested two levels',
		file: 'content/en/guide/troubleshooting.md',
		pattern: /^ {2}- A ferrite layer between the tag and the metal/m,
		why: 'The deepest nesting in the real corpus, and what the nav depth limit was measured against.',
	},
	{
		type: 'listItem',
		file: 'content/en/index.md',
		pattern: /^- URI records, including `tel:` and `mailto:` shortcuts$/m,
		why: 'A child-only node: it can never appear where a paragraph belongs, which is why it is outside the Block union.',
	},
	{
		type: 'code',
		variant: 'highlighted, every option',
		file: 'content/en/reference/api.md',
		pattern: /^```swift title="TagSession\.swift" lineNumbers start=12 highlight="2,5-7"$/m,
		why: 'The only fence carrying the full option set. Filename, line numbers, a start line and a highlight range in one info string is what proves the fence grammar is not four separate special cases.',
	},
	{
		type: 'code',
		variant: 'language with no grammar, wrapped',
		file: 'content/en/reference/api.md',
		pattern: /^```metal wrap$/m,
		why: 'No mainstream highlighter has a Metal grammar. Dropping `lang` here would make "unknown language" indistinguishable from "unlabelled fence", which are different things to a reader and to llms.txt. It is also the only fence carrying `wrap`, which was the one fence option nothing exercised: the absent-means-scroll default is covered by the box-drawing graph, and the opposite case had nothing.',
	},
	{
		type: 'code',
		variant: 'the named plain language, box drawing',
		file: 'content/en/developer/architecture.md',
		pattern: /^```text\nAppShell\n├─ TagSession ─┬─ ChipProfiles$/m,
		why: 'The reason `PLAIN_CODE_LANGUAGE` exists. `code-fence-language` is an error, and a box-drawing module graph is not a language, so without a named plain member the two requirements contradict each other and the rule that loses is the one that would have caught a real mistake. It is also the reason `wrap` defaults to off: soft-wrapping this destroys the graph.',
	},
	{
		type: 'code',
		variant: 'no language at all',
		file: 'content/en/reference/api.md',
		pattern: /^```\nTagSession begin intent=writeRoute/m,
		why: 'The only fence in the corpus with no language, which is what gives `Code.lang` an absent case and `highlighted: false` a second reason to be false. It is also a planted `code-fence-language` violation: the AST can carry an unlabelled fence, because a bundle compiled under a project that downgraded the rule will contain one, and the linter still says so.',
	},
	{
		type: 'code',
		variant: 'json',
		file: 'content/en/reference/api.md',
		pattern: /^```json$/m,
		why: 'A third language, so the allowlist in `code.languages` is exercised with more than one member.',
	},
	{
		type: 'blockquote',
		variant: 'plain',
		file: 'content/en/guide/index.md',
		pattern: /^> A tag that fails to write is usually not faulty\./m,
		why: 'A quote that is not a callout. Without one, every blockquote in the corpus would be an alert and the plain path would never run.',
	},
	{
		type: 'blockquote',
		variant: 'containing a link',
		file: 'content/en/guide/troubleshooting.md',
		pattern: /^> A walkthrough of a scan that works/m,
		why: 'Blockquote children are blocks rather than inline, and this is the case that would lose both the link and the paragraph boundary if they were not.',
	},
	{
		type: 'callout',
		variant: 'note, directive with a title',
		file: 'content/en/index.md',
		pattern: /^:::note\[Background scanning\]$/m,
		why: 'The directive spelling, with an author-supplied title.',
	},
	{
		type: 'callout',
		variant: 'tip, no title',
		file: 'content/en/guide/first-tag.md',
		pattern: /^:::tip$/m,
		why: 'No title, so the renderer has to supply the localised default label. That path exists in seven languages and would otherwise never run.',
	},
	{
		type: 'callout',
		variant: 'warning',
		file: 'content/en/guide/first-tag.md',
		pattern: /^:::warning\[A partial read looks like a success\]$/m,
		why: 'A third kind, so the kind is read from the directive rather than defaulted.',
	},
	{
		type: 'callout',
		variant: 'important, GitHub alert form',
		file: 'content/en/guide/troubleshooting.md',
		pattern: /^> \[!IMPORTANT\]$/m,
		why: 'The spelling that renders in the GitHub UI, where a developer reads the page long before it is published. Both spellings must compile to the same node.',
	},
	{
		type: 'callout',
		variant: 'caution, GitHub alert form',
		file: 'content/en/guide/troubleshooting.md',
		pattern: /^> \[!CAUTION\]$/m,
		why: 'The fifth kind, so every member of CALLOUT_KINDS is produced by the corpus.',
	},
	{
		type: 'callout',
		variant: 'caution, inside a snippet',
		file: 'snippets/en/safety-note.md',
		pattern: /^:::caution\[Do not force a tag against the phone\]$/m,
		why: 'A block inside a transcluded fragment, which is what proves a snippet expands to blocks rather than to text.',
	},
	{
		type: 'table',
		variant: 'no alignment, no caption',
		file: 'content/en/reference/index.md',
		pattern: /^\| Notation \| Meaning \|$/m,
		why: 'Not one delimiter row in the real corpus uses a colon, so the all-null alignment case is the common one and this is it.',
	},
	{
		type: 'table',
		variant: 'alignment and a caption',
		file: 'content/en/reference/chip-support.md',
		pattern: /^\| :--- \| --- \| :---: \| --- \| ---: \|$/m,
		why: 'Left, default, centre, default and right in one delimiter row. `align` has no other coverage anywhere, which the AST comment says outright.',
	},
	{
		type: 'tableCell',
		file: 'content/en/reference/index.md',
		pattern: /^\| `0x04` \| A single byte in hexadecimal, as the app prints it \|$/m,
		why: 'A cell carrying inline code. Cells are inline-only, and a cell that held a block would produce source that renders as a broken table on GitHub.',
	},
	{
		type: 'figure',
		variant: 'with a caption',
		file: 'content/en/guide/first-tag.md',
		pattern: /^:::figure\[The Scan sheet, waiting for a tag to come within range\]$/m,
		why: "The caption is the directive argument. Written as the container's last paragraph it would be ambiguous with the prose after a table, and the ambiguity would show up as a missing sentence on a published page.",
	},
	{
		type: 'figure',
		variant: 'bare standalone image, no caption',
		file: 'content/en/guide/first-tag.md',
		pattern: /^!\[A completed read listing three NDEF records\]/m,
		why: 'A paragraph holding nothing but an image, which the compiler promotes. That promotion is what makes the difference between a paragraph and a figure a compile-time decision rather than a renderer heuristic.',
	},
	{
		type: 'thematicBreak',
		file: 'content/en/index.md',
		pattern: /\n\n---\n\n/,
		why: 'A rule between sections. The pattern requires blank lines on both sides so that it cannot match the front matter delimiters, which are the same three characters.',
	},
	{
		type: 'steps',
		file: 'content/en/guide/first-tag.md',
		pattern: /^::::steps$/m,
		why: 'The only structure HowTo structured data can be derived from without guessing. Four colons, because it contains three-colon step containers.',
	},
	{
		type: 'step',
		file: 'content/en/guide/first-tag.md',
		pattern: /^:::step\[Open the Scan sheet\]$/m,
		why: 'A child-only node with its own anchor, so one step is linkable from a support reply.',
	},

	// ---- inline ----------------------------------------------------------
	{
		type: 'text',
		file: 'content/en/index.md',
		pattern: /Hold the top edge of the phone against a tag/,
		why: 'A run of text with a soft wrap inside it. The joiner is a space unless the characters on both sides are wide, and the Japanese and Chinese pages are what make that rule load-bearing.',
	},
	{
		type: 'emphasis',
		file: 'content/en/index.md',
		pattern: /Writing is \*destructive\*\./,
		why: 'Single asterisks. Prettier rewrites emphasis delimiters, which is one reason the content tree is excluded from formatting.',
	},
	{
		type: 'strong',
		file: 'content/en/index.md',
		pattern: /\*\*Write\*\*/,
		why: 'Double asterisks, on a UI control name.',
	},
	{
		type: 'strikethrough',
		variant: 'in prose',
		file: 'content/en/guide/troubleshooting.md',
		pattern: /~~read only~~/,
		why: 'The corpus has no strikethrough today, which is why it is planted here: the node exists so that a changelog and a deprecation notice can migrate without the compiler refusing source that renders correctly on GitHub.',
	},
	{
		type: 'strikethrough',
		variant: 'naming a removed module',
		file: 'content/en/developer/architecture.md',
		pattern: /~~SyncEngine~~/,
		why: 'A second instance, so the node is not the property of one page.',
	},
	{
		type: 'inlineCode',
		file: 'content/en/index.md',
		pattern: /`Tag is permanently locked`/,
		why: 'Inline code carrying an error string, which is also what the search index has to keep as one term.',
	},
	{
		type: 'link',
		variant: 'internal',
		file: 'content/en/index.md',
		pattern: /\]\(guide\/first-tag\.md\)/,
		why: 'Source writes a relative markdown path; the compiler resolves it to a slug. Baking an address into a bundle would break the moment the same bundle were mounted at a second site, and it would break silently, as a working link to a 404.',
	},
	{
		type: 'link',
		variant: 'internal, carrying an anchor',
		file: 'content/en/developer/architecture.md',
		pattern: /\]\(\.\.\/reference\/api\.md#errors\)/,
		why: "The commonest link shape in a real manual, and the only one that exercises `anchor-resolves` across two files: the compiler has to resolve the slug first and then check the fragment against that page's heading ids and aliases. The optional `anchor` field on an internal link had no coverage at all before this.",
	},
	{
		type: 'link',
		variant: 'internal, anchor whose target id is explicit',
		file: 'content/en/reference/api.md',
		pattern: /\]\(\.\.\/developer\/architecture\.md#module-graph\)/,
		why: "The same shape pointing at the corpus's one explicit `{#id}`, so the cross-page check runs against an idSource of `explicit` as well as one of `slug`. Those are the two the translation rules have to tell apart.",
	},
	{
		type: 'link',
		variant: 'anchor',
		file: 'content/en/index.md',
		pattern: /\]\(#what-you-need\)/,
		why: 'An anchor within the same page, which gets neither a client-side navigation nor a rel attribute.',
	},
	{
		type: 'link',
		variant: 'external',
		file: 'content/en/index.md',
		pattern: /\]\(https:\/\/example\.com\/fixture-app\)/,
		why: 'Absolute https, the only external scheme that reaches the renderer.',
	},
	{
		type: 'link',
		variant: 'mailto',
		file: 'content/en/index.md',
		pattern: /\]\(mailto:docs@example\.com\)/,
		why: 'The fourth link kind. There is no http: kind, matching the safeHref already shipping in hex-web.',
	},
	{
		type: 'image',
		variant: 'inline, mid sentence',
		file: 'content/en/guide/troubleshooting.md',
		pattern: /!\[contactless\]\(\.\.\/\.\.\/\.\.\/assets\/nfc-glyph\.svg\)/,
		why: 'An image that is not alone in its paragraph, and therefore stays an inline node rather than being promoted to a figure. It is also the vector asset, which carries the SVG obligation.',
	},
	{
		type: 'break',
		file: 'content/en/index.md',
		pattern: /\\\n/,
		why: 'A hard line break, written as a trailing backslash. The legal masthead is two consecutive source lines that mean two lines, and soft-wrap folding would otherwise join them.',
	},
	{
		type: 'status',
		variant: 'yes',
		file: 'content/en/reference/chip-support.md',
		pattern: /\| \u2705 \|/,
		why: 'The commonest glyph in the real matrix, 59 of the 86. Left as text it makes a screen reader say "white heavy check mark" in seven languages and makes a search for "supported" match nothing.',
	},
	{
		type: 'status',
		variant: 'partial',
		file: 'content/en/reference/chip-support.md',
		pattern: /\| \u26a0\ufe0f \|/,
		why: 'The emoji-presentation pair. U+FE0F is load-bearing: stripped, the cell renders monochrome and reads as a different status.',
	},
	{
		type: 'status',
		variant: 'no',
		file: 'content/en/reference/chip-support.md',
		pattern: /\| \u274c \|/,
		why: 'The third value, and the second glyph this repository bans in its own source.',
	},
	{
		type: 'status',
		variant: 'inline, outside a table cell',
		file: 'content/en/reference/chip-support.md',
		pattern: /^A \u26a0\ufe0f in the Write column/m,
		why: 'A status glyph in a sentence. Every other instance is a whole cell, so without this the inline scope would be exercised by unit tests and by no real source. The warning sign is the right glyph for it: it is not in BANNED_CHARACTERS, so it needs no exemption to sit in prose.',
	},
	{
		type: 'status',
		variant: 'na',
		file: 'content/en/reference/chip-support.md',
		pattern: /\| \u2014 \|/,
		why: 'An em dash as a whole cell, which is how the real matrix spells "not applicable". Recognising it anywhere else would hand every author a one-character way to write an em dash that no prose rule can see.',
	},
];

/**
 * The variants that must exist, listed separately from the claims that provide them.
 *
 * `NODE_CLAIMS` on its own only guarantees that every node **type** is claimed once,
 * which is satisfied by one claim per type. Every variant beyond the first was
 * unpinned: the entries whose own reason says they are the sole coverage of `align`,
 * of `start` on a list, of `checked` on a task item, of the `wrap` fence option, of the
 * explicit `{#id}` heading, of both callout spellings and of the em dash status cell
 * could all be deleted with both suites green, because the test count would fall and
 * nothing carried an expectation to compare it against.
 *
 * So this is the same shape `AssertCovers` gives the node unions, one level down: the
 * suite checks it against `NODE_CLAIMS` in both directions, so a deleted claim fails
 * naming the variant and an added claim fails until it is declared here. The empty
 * string is the label of a claim with no variant, which is a type that has only one
 * shape worth covering.
 */
export const REQUIRED_VARIANTS: Record<AstNodeType, readonly string[]> = {
	paragraph: [''],
	heading: ['depth 2, slug id', 'depth 3', 'depth 4', 'explicit id'],
	list: ['bullet, tight', 'ordered, loose', 'ordered, start 3', 'task items', 'nested two levels'],
	listItem: [''],
	code: [
		'highlighted, every option',
		'language with no grammar, wrapped',
		'the named plain language, box drawing',
		'no language at all',
		'json',
	],
	blockquote: ['plain', 'containing a link'],
	callout: [
		'note, directive with a title',
		'tip, no title',
		'warning',
		'important, GitHub alert form',
		'caution, GitHub alert form',
		'caution, inside a snippet',
	],
	table: ['no alignment, no caption', 'alignment and a caption'],
	tableCell: [''],
	figure: ['with a caption', 'bare standalone image, no caption'],
	thematicBreak: [''],
	steps: [''],
	step: [''],
	text: [''],
	emphasis: [''],
	strong: [''],
	strikethrough: ['in prose', 'naming a removed module'],
	inlineCode: [''],
	link: [
		'internal',
		'internal, carrying an anchor',
		'internal, anchor whose target id is explicit',
		'anchor',
		'external',
		'mailto',
	],
	image: ['inline, mid sentence'],
	break: [''],
	status: ['yes', 'partial', 'no', 'inline, outside a table cell', 'na'],
};

/**
 * Snippet transclusion is not a node. It leaves nothing behind in the tree, so it
 * cannot be claimed above, and `CompiledPage.snippets` is the only record that a
 * paragraph came from somewhere else.
 */
export const INCLUDE_CLAIMS: readonly { file: string; id: string; pattern: RegExp }[] = [
	{ file: 'content/en/index.md', id: 'safety-note', pattern: /^::include\[safety-note\]$/m },
	{
		file: 'content/en/guide/first-tag.md',
		id: 'safety-note',
		pattern: /^::include\[safety-note\]$/m,
	},
	{
		file: 'content/en/reference/chip-support.md',
		id: 'legend',
		pattern: /^::include\[legend\]$/m,
	},
];
