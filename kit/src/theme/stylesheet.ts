/**
 * The generator for `src/render/docs.css`.
 *
 * The stylesheet is generated, not hand-edited, and the reason is the one defect this
 * package's theme contract exists to prevent. Every colour has to be read at its point of
 * use through the full `var()` chain, and a hand-written rule that spells a chain slightly
 * differently, or writes a literal because the chain was long, passes every test that reads
 * the stylesheet and every test that renders it under a theme class. So every theme and palette
 * colour here comes from `t()`, which expands a token name through the contract's own
 * `tokenValue` and throws on a name the table does not have, and a hex literal anywhere outside
 * a chain fails `kit/test/theme/stylesheet.test.ts`. The colour values that are not tokens are
 * `currentColor`, `transparent`, the search dialog's backdrop scrim and one system colour under
 * a forced palette, and a theme sets none of those. That test scans for hex and nothing else,
 * so a named colour or an `rgb()` written into a rule is a thing review has to catch.
 *
 * `pnpm schemas` writes the file and CI fails on a diff, the same way the JSON Schemas and
 * the house rule pack are gated, so an edit to the checked-in CSS is caught rather than
 * being quietly correct until the next regeneration.
 *
 * ## Four rules the CSS itself has to keep, none of which a generator can enforce
 *
 * No physical properties. `margin-left`, `text-align: left` and `border-inline` written as
 * `border-left` all look right in six languages and wrong in Arabic, and the build that
 * shows it is the one nobody runs. `kit/test/theme/stylesheet.test.ts` scans for them. A
 * few physical forms have no logical spelling, a shadow's horizontal offset and a gradient's
 * direction among them, and the scan accepts one of those only beside a rule for the same
 * selector with `:dir(rtl)` that declares its mirror. Which of the pair is the right way
 * round is not something a scan of the text can know, so the `sides-*` probes in
 * `scripts/check-paint.mjs` measure where the paint lands in both directions.
 *
 * No `@layer`. Measured against both consumers: hex-web's `app.css` declares no layer and
 * has no bare-element selectors, and kcalc's `@layer base` restyles `p` and `h4`. Any
 * unlayered rule beats every layered one, so a layered docs stylesheet would lose to
 * kcalc's base and win nothing anywhere. Unlayered rules scoped under `.hx-root` beat both
 * and cannot be reordered by a host's layer statement.
 *
 * No selector on `[data-reduced]`. The attribute is rendered `false` for the whole first
 * paint and flips in an effect, so a rule keyed off it is wrong for exactly the readers it
 * is for. `@media (prefers-reduced-motion: reduce)` needs no JavaScript and is the gate.
 *
 * State every property a host's base layer resets. Unlayered beats layered only for the
 * properties a rule states; for everything else the host's `@layer base` still wins over
 * the browser default this file was written against. Both consumers ship Tailwind v4's
 * preflight there, which makes every img a block, strips list markers, heading weights
 * and link underlines, gives `code` its own font and zeroes every margin, including the
 * `margin: auto` that centres a modal dialog. Under hex-web's production CSS that was a
 * sentence split around an inline icon, a search dialog pinned to the corner of the screen
 * and numbered lists with no numbers. `scripts/check-paint.mjs` renders one page bare and
 * under that base layer and fails on any property it measures that differs.
 */

import { PALETTE, SCOPE_COLOUR as SCOPES, paletteValue } from '../../../src/contracts/palette.js';
import { THEME_TOKENS, tokenValue } from '../../../src/contracts/theme.js';

/** The path this writes, relative to the repository root. */
export const STYLESHEET_PATH = 'src/render/docs.css';

/**
 * The only way to produce a colour, a length or a font in this file.
 *
 * Throws on an unknown name, so a typo is a failed build rather than a rule that silently
 * paints nothing, and a token removed from the table takes every rule that used it down
 * with it rather than leaving a `var()` with no fallback.
 *
 * Exported only so the test can call it. The guarantee this file rests on is that a token's
 * chain cannot be spelled any way but the contract's, and a guarantee nobody has made fail is
 * not known to hold.
 */
export function t(name: string): string {
	const token = THEME_TOKENS.find((entry) => entry.name === name);
	if (token !== undefined) return tokenValue(token);
	const colour = PALETTE.find((entry) => entry.name === name);
	if (colour !== undefined) return paletteValue(colour);
	throw new Error(
		`No theme token or palette colour named "${name}". The stylesheet may only name values the contract declares, which is what stops a rule spelling a fallback chain its own way.`,
	);
}

/** Every code scope, as one rule each, generated from the palette's own map. */
function scopeRules(): string {
	return PALETTE.filter((colour) => colour.name.startsWith('code-'))
		.map((colour) => {
			const scopes = Object.entries(SCOPES)
				.filter(([, name]) => name === colour.name)
				.map(([scope]) => `.hx-root .hx-s-${scope}`)
				.join(',\n');
			return scopes === '' ? '' : `${scopes} {\n\tcolor: ${t(colour.name)};\n}`;
		})
		.filter((rule) => rule !== '')
		.join('\n\n');
}

function calloutRules(): string {
	return PALETTE.filter((colour) => colour.name.startsWith('callout-'))
		.map((colour) => {
			const kind = colour.name.slice('callout-'.length);
			return `.hx-root .hx-callout[data-callout='${kind}'] {\n\tborder-inline-start-color: ${t(colour.name)};\n}\n\n.hx-root .hx-callout[data-callout='${kind}'] .hx-callout-title {\n\tcolor: ${t(colour.name)};\n}`;
		})
		.join('\n\n');
}

function statusRules(): string {
	return PALETTE.filter((colour) => colour.name.startsWith('status-'))
		.map((colour) => {
			const value = colour.name.slice('status-'.length);
			return `.hx-root .hx-status[data-status='${value}'] {\n\tcolor: ${t(colour.name)};\n}`;
		})
		.join('\n\n');
}

export function emitStylesheet(): string {
	return `${HEADER}

${BASE}

${LAYOUT}

${PROSE}

${CODE}

${CHROME}

${SEARCH}

${PHONE}

${scopeRules()}

${calloutRules()}

${statusRules()}

${SCRIPTS}

${MOTION}
`;
}

const HEADER = `/*
 * GENERATED FILE. Do not edit.
 *
 * Written by kit/src/theme/stylesheet.ts from THEME_TOKENS and PALETTE, and regenerated by
 * \`pnpm schemas\`. CI fails on a diff, so an edit here is caught rather than surviving
 * until the next regeneration overwrites it.
 *
 * Every colour, length and font is a full var() chain read at its point of use. That is
 * not verbosity for its own sake: a custom property is substituted where it is declared,
 * so an alias at the root or on the docs root resolves once and a rebinding below it can
 * never take effect. gzip collapses the repetition to almost nothing.
 */`;

const BASE = `/*
 * \`overflow-wrap\` is on the root because every text holder in the shell inherits it, and
 * the holder that needed it was not the one it was first written for.
 *
 * A symbol name has no space in it, so a long one is a single unbreakable word and a
 * phone's column is narrower than it: measured on hex-web at 390px,
 * \`kSecAttrAccessibleWhenUnlockedThisDeviceOnly\` laid out 390.2px wide in a 358px column.
 * Both consumers set \`overflow-x: hidden\` on the body, so the tail is clipped with nothing
 * to scroll to and neither the reader nor a find-in-page can reach the characters. Scoped
 * to \`.hx-code\`, that was fixed for an author who wrote backticks and for nobody else:
 * measured on a page carrying the same identifier as its title, its heading and a pager
 * title, the title ran 362px past a 390px screen, the heading 413px, and in Arabic the
 * pager ran 82px off the leading edge instead.
 *
 * \`break-word\` rather than \`anywhere\` or \`break-all\`, and the difference is not
 * cosmetic. \`break-all\` breaks every word at the edge of the line, so ordinary prose stops
 * breaking at its spaces and words are chopped for no reason. \`anywhere\` breaks only when a
 * word would overflow, as this does, but it also makes the broken word's width count as the
 * minimum content width, which is what a table lays its columns out from: a chip name in a
 * cell would be squeezed into a stack of fragments instead of leaving the table wide and
 * scrolling inside \`.hx-scroll\`. \`break-word\` contributes nothing to the minimum, which is
 * what lets it sit on the root without reaching the table's measure. It reaches no fence
 * either, because a fence keeps \`white-space: pre\` and never wraps at all, so it goes on
 * scrolling sideways in the scroller it already owns.
 */
.hx-root {
	color: ${t('ink')};
	background: ${t('ground')};
	font-family: ${t('font-body')};
	font-size: ${t('font-size')};
	line-height: ${t('leading')};
	overflow-wrap: break-word;
	position: relative;
}

/*
 * The ambient wash, and it paints nothing at all by default: the glow token's literal is
 * \`transparent\`, so a consumer that sets nothing gets a flat ground. It is here rather
 * than left to the backdrop slot because that slot is for a consumer's own shader, and a
 * project that only wants a tint should not have to mount a canvas to get one.
 */
.hx-root::before {
	content: '';
	position: absolute;
	inset-block-start: 0;
	inset-inline: 0;
	block-size: 24rem;
	background: radial-gradient(60% 100% at 50% 0%, ${t('glow')}, transparent);
	pointer-events: none;
	z-index: 0;
}

.hx-root *,
.hx-root *::before,
.hx-root *::after {
	box-sizing: border-box;
}

/*
 * Visually hidden and still read. The clip-path form rather than \`display: none\`, which
 * removes the element from the accessibility tree, and rather than a negative offset,
 * which scrolls the page when the element is focused.
 *
 * The skip link is hidden the same way until it has focus. It used to be moved above the
 * docs root with a transform, which is off-screen only when the root starts at the top of
 * the page: in hex-web the root starts under a 64px sticky header, and the link sat on the
 * site's logo on every page load, on a phone and on a desktop. A clip does not care where
 * the root is.
 */
.hx-root .hx-sr,
.hx-root .hx-skip:not(:focus) {
	position: absolute;
	inline-size: 1px;
	block-size: 1px;
	margin: -1px;
	padding: 0;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
	border: 0;
}

/*
 * Once focused, the skip link is shown whole at the top of the docs root, in line with the
 * shell's inset and above the content. root.tsx already has one that reaches this shell;
 * this one reaches the article past a sidebar that can be fifty items long.
 *
 * The underline is stated because a host's preflight sets \`text-decoration: inherit\` on
 * every link. The short slide is decoration and nothing depends on it: the clip above is
 * what hides and shows the link and it switches in one frame, so the reduced-motion gate
 * at the foot of this file removes the slide without leaving the link half shown.
 */
.hx-root .hx-skip {
	position: absolute;
	inset-block-start: 0;
	inset-inline-start: ${t('shell-inset')};
	z-index: 10;
	padding: 0.75rem 1rem;
	background: ${t('surface')};
	color: ${t('ink')};
	text-decoration: underline;
	text-underline-offset: 0.2em;
	border-end-start-radius: ${t('radius')};
	border-end-end-radius: ${t('radius')};
	transition: transform 120ms ${t('ease')};
}

.hx-root .hx-skip:not(:focus) {
	transform: translateY(-0.5rem);
}

/*
 * One focus ring for everything, and it uses the furniture accent, which is held to 3:1
 * against the ground. \`outline\` rather than a box-shadow so it follows the element's own
 * shape and survives a forced-colours mode.
 */
.hx-root :focus-visible {
	outline: 2px solid ${t('accent')};
	outline-offset: 2px;
	border-radius: 2px;
}`;

const LAYOUT = `/*
 * The shell pads itself and caps its own width, because a host is not guaranteed to do
 * either. hex-web's \`main\` is full-bleed, since its product pages are full-width bands, and
 * with a column gap and nothing else the sidebar and the search box sat flush against the
 * viewport on a desktop and body text ran to both edges of a phone.
 *
 * Padding on the layout rather than on the root, so the ambient wash and the backdrop slot
 * stay full-bleed. A host that already pads its container gets both paddings, which is a
 * wider margin rather than a broken page, and setting the \`shell-inset\` token to zero
 * removes this one.
 *
 * The cap is the three columns at their intended sizes plus the padding, which counts
 * because every box under the root is border-box. On a wide screen the columns then stay
 * together in the middle, where without it the middle track grew and the table of contents
 * drifted away from an article that stops at the measure. It is derived rather than a token
 * of its own, so raising the measure widens the shell with it.
 */
.hx-root .hx-layout {
	display: grid;
	grid-template-columns: ${t('tree-size')} minmax(0, 1fr) ${t('toc-size')};
	gap: ${t('gutter')};
	align-items: start;
	position: relative;
	z-index: 1;
	max-inline-size: calc(${t('tree-size')} + ${t('measure')} + ${t('toc-size')} + 2 * ${t('gutter')} + 2 * ${t('shell-inset')});
	/*
	 * The pager and the end of each rail are the last things in the shell, and a host's footer
	 * follows directly. Without this both consumers put the footer's edge against them.
	 */
	padding-block-end: 4rem;
	margin-inline: auto;
	padding-inline: ${t('shell-inset')};
}

/*
 * Sticky rails. \`inset-block-start\` rather than \`top\` for the same reason every other
 * offset here is logical: it costs nothing and it is one fewer thing to find in Arabic.
 */
.hx-root .hx-tree,
.hx-root .hx-toc {
	position: sticky;
	inset-block-start: ${t('sticky-offset')};
	max-block-size: calc(100vh - ${t('sticky-offset')});
	overflow-y: auto;
	/* So the last row of a rail scrolled to its end is not flush with the bottom of the window. */
	padding-block-end: 1.5rem;
	font-size: 0.9375rem;
}

.hx-root .hx-article {
	max-inline-size: ${t('measure')};
	min-inline-size: 0;
}

.hx-root .hx-article:focus {
	outline: none;
}

/*
 * The backdrop slot's geometry, copied from the working pattern in hex-web rather than
 * invented. A wrapper with \`overflow\` would become the scrollport and pin the sticky
 * frame, which is the failure that pattern documents; the negative block margin pulls the
 * article back over the frame so the effect sits behind the whole scrolling document.
 */
.hx-root .hx-backdrop {
	position: sticky;
	inset-block-start: 0;
	block-size: 100svh;
	margin-block-end: -100svh;
	z-index: 0;
	pointer-events: none;
}`;

const PROSE = `/*
 * Headings state their weight and their colour. Tailwind's preflight sets every heading's
 * weight to \`inherit\`, so in hex-web the hierarchy rested on size alone and the CJK weight
 * synthesis further down this file had nothing to synthesise. kcalc-web's own base layer
 * colours h1 to h4 with its ink, and on its paper world that is #1f2c26 on this package's
 * ground: 1.33:1. 600 rather than the browser's 700 to match every other title this file
 * sets, and a face with only 400 and 700 cuts, which hex-web's display face is, renders 600
 * from the 700 cut.
 */
.hx-root .hx-title {
	font-family: ${t('font-display')};
	font-size: 2rem;
	font-weight: 600;
	line-height: 1.2;
	margin-block: 0 0.5rem;
	color: ${t('ink')};
}

.hx-root .hx-meta {
	display: flex;
	gap: 1rem;
	color: ${t('dim')};
	font-size: 0.875rem;
	margin-block: 0 2rem;
}

/*
 * The edit link keeps the metadata's colour and is told apart from the reading time beside
 * it by its underline. Both are stated: a preflight sets them to \`inherit\`, and with no
 * host at all an unstated link is the browser's own blue, 2.05:1 on the ground.
 */
.hx-root .hx-meta a {
	color: inherit;
	text-decoration: underline;
	text-underline-offset: 0.2em;
}

.hx-root .hx-meta a:hover {
	color: ${t('ink')};
}

.hx-root .hx-heading {
	font-family: ${t('font-display')};
	font-weight: 600;
	line-height: 1.3;
	color: ${t('ink')};
	margin-block: 2rem 0.75rem;
	/*
	 * Not the site's scroll-padding. That helps a smooth scroll and does nothing for an
	 * anchor jump or a programmatic focus, both of which land the heading under the
	 * sticky header without this.
	 */
	scroll-margin-block-start: ${t('sticky-offset')};
}

.hx-root h2.hx-heading { font-size: 1.5rem; }
.hx-root h3.hx-heading { font-size: 1.25rem; }
.hx-root h4.hx-heading { font-size: 1.0625rem; }
.hx-root h5.hx-heading,
.hx-root h6.hx-heading { font-size: 1rem; }

.hx-root .hx-prose p,
.hx-root .hx-prose ul,
.hx-root .hx-prose ol {
	margin-block: 0 1rem;
}

/*
 * A link in running text is underlined as well as coloured, and the underline is stated
 * because a preflight sets \`text-decoration: inherit\` on every link. Without it a link was
 * told apart by hue alone, and the link colour against body text measures 2.25:1, short of
 * the 3:1 WCAG asks of a colour-only cue. The banner's one link is the same kind of link,
 * and under a preflight it had lost both its colour and its underline to the sentence
 * above it.
 */
.hx-root .hx-prose a,
.hx-root .hx-banner a {
	color: ${t('accent-link')};
	text-decoration: underline;
	text-underline-offset: 0.2em;
}

.hx-root .hx-prose a:hover,
.hx-root .hx-banner a:hover {
	color: ${t('accent-soft')};
}

.hx-root .hx-external::after {
	content: '';
	display: inline-block;
	inline-size: 0.5em;
	block-size: 0.5em;
	margin-inline-start: 0.3em;
	border-block-start: 1px solid currentColor;
	border-inline-end: 1px solid currentColor;
}

/*
 * The single highest-value line for Arabic. Without isolation the bidirectional algorithm
 * reorders an identifier like NDEFMessage.records against the Arabic around it and the
 * reader sees a mangled symbol name.
 *
 * The line breaker an identifier needs is on \`.hx-root\`, where every text holder inherits
 * it, and the paragraph beside that rule says why it is not here.
 */
.hx-root .hx-code {
	font-family: ${t('font-mono')};
	font-size: 0.9em;
	background: ${t('raised')};
	padding: 0.15em 0.35em;
	border-radius: 4px;
	unicode-bidi: isolate;
}

.hx-root .hx-list {
	padding-inline-start: 1.5rem;
}

/*
 * List markers are stated because a preflight sets \`list-style: none\` on every ul and ol.
 * Unstated, a numbered procedure lost its numbers and a bulleted list became a column of
 * indented sentences. The nesting follows the browser's own sequence, so a page reads the
 * same with a host around it and without one.
 */
.hx-root ul.hx-list {
	list-style-type: disc;
}

.hx-root li ul.hx-list {
	list-style-type: circle;
}

.hx-root li li ul.hx-list {
	list-style-type: square;
}

.hx-root ol.hx-list {
	list-style-type: decimal;
}

.hx-root .hx-tight li {
	margin-block: 0;
}

/*
 * The block margins of a quote and a figure are stated for the reason every other margin
 * here is: a preflight zeroes them. A figure has no paragraph inside it to lend it an end
 * margin, so under one the next paragraph sat against the image or the caption.
 */
.hx-root blockquote {
	margin-inline: 0;
	margin-block: 0 1rem;
	padding-inline-start: 1rem;
	border-inline-start: 3px solid ${t('edge')};
	color: ${t('dim')};
}

.hx-root hr {
	border: 0;
	border-block-start: 1px solid ${t('edge')};
	margin-block: 2rem;
}

/*
 * An image states its display, because a preflight makes every img a block and an
 * unlayered rule only overrides what it states. Unstated, the inline icon on the Arabic
 * troubleshooting page split its sentence in two. In a paragraph an image sits on the
 * middle of the line, the way an icon in a sentence should. In a figure it is a block, so
 * the caption starts below it and not beside it.
 */
.hx-root .hx-image {
	display: inline-block;
	vertical-align: middle;
	max-inline-size: 100%;
	block-size: auto;
	border-radius: ${t('radius')};
}

.hx-root .hx-figure {
	margin-inline: 0;
	margin-block: 0 1rem;
}

.hx-root .hx-figure .hx-image {
	display: block;
}

.hx-root .hx-figure figcaption {
	color: ${t('dim')};
	font-size: 0.875rem;
	margin-block-start: 0.5rem;
}

/* A scrollable region needs a visible boundary as well as a tab stop and a name. */
.hx-root .hx-scroll {
	overflow-x: auto;
	border: 1px solid ${t('control')};
	border-radius: ${t('radius')};
	margin-block-end: 1rem;
}

.hx-root .hx-table {
	border-collapse: collapse;
	inline-size: 100%;
	font-size: 0.9375rem;
}

.hx-root .hx-table th,
.hx-root .hx-table td {
	padding: 0.5rem 0.75rem;
	border-block-end: 1px solid ${t('edge')};
	text-align: start;
	vertical-align: baseline;
}

.hx-root .hx-table th {
	background: ${t('raised')};
	font-weight: 600;
}

.hx-root .hx-table caption {
	color: ${t('dim')};
	font-size: 0.875rem;
	padding-block: 0.5rem;
	text-align: start;
}

/*
 * A status mark is a shape, a colour and a name. The glyphs an author would reach for are
 * banned from anything this package emits, and no glyph that survives the ban is covered
 * by every font the seven languages fall back to, so the shape is drawn here.
 */
.hx-root .hx-status {
	display: inline-block;
	inline-size: 0.75em;
	block-size: 0.75em;
	vertical-align: -0.05em;
	margin-inline-end: 0.15em;
	border: 2px solid currentColor;
	border-radius: 50%;
}

.hx-root .hx-status-disc { background: currentColor; }
.hx-root .hx-status-ring { background: transparent; }

/*
 * A partial mark fills its inline-end half: the right half in a left-to-right line, the left
 * half in Arabic.
 *
 * The gradient is physical and mirrored because there is no logical one. It was written
 * \`to inline-end\`, which is in no engine's grammar, so the declaration was dropped without a
 * word, every partial mark computed \`background-image: none\` and painted as an empty ring,
 * which is the shape of "no", and a status stopped being a shape as well as a colour.
 * \`scripts/check-paint.mjs\` asks the browser to parse every declaration in this file, which is
 * the check that would have caught it the day it was written.
 *
 * \`:dir(rtl)\` is on the mark itself rather than on the docs root. An Arabic page serving
 * the English fallback carries \`dir="ltr"\` on its article, and a mark inside it reads left
 * to right; a selector on the root's direction fills the wrong half there.
 *
 * The inline-start half is the filled one, which is what the original declaration said: its
 * colour stop came first along the line. A mark reads as progress from where a line begins.
 */
.hx-root .hx-status-half { background: linear-gradient(to right, currentColor 50%, transparent 50%); }
.hx-root .hx-status-half:dir(rtl) { background: linear-gradient(to left, currentColor 50%, transparent 50%); }

.hx-root .hx-status-bar {
	border: 0;
	border-radius: 0;
	border-block-start: 2px solid currentColor;
	block-size: 0;
	vertical-align: 0.3em;
}

.hx-root .hx-task {
	display: inline-block;
	inline-size: 0.85em;
	block-size: 0.85em;
	margin-inline-end: 0.4em;
	vertical-align: -0.1em;
	border: 2px solid ${t('control')};
	border-radius: 3px;
}

.hx-root .hx-task-done {
	background: ${t('accent')};
	border-color: ${t('accent')};
}

.hx-root .hx-task-item {
	list-style: none;
}

/*
 * A task item's text flows on the marker's line. The marker is an inline box and the
 * paragraph after it is a block, so without this the text always started on the line
 * below the checkbox. Only the paragraph directly after the marker goes inline, and
 * anything after it in the same item stays a block.
 *
 * An inline box has no block margins, so the two rules after it put back the space that
 * paragraph's own end margin used to give: above whatever follows it in the item, and
 * below the item itself. Without them a task item sits closer to its neighbours than a
 * plain item in the same list. The second one has to come after \`.hx-tight li\`, which
 * it ties with on specificity.
 */
.hx-root .hx-task + p {
	display: inline;
}

.hx-root .hx-task + p + * {
	margin-block-start: 1rem;
}

.hx-root li.hx-task-item {
	margin-block-end: 1rem;
}

.hx-root .hx-steps {
	list-style: none;
	padding-inline-start: 0;
	counter-reset: hx-step;
}

.hx-root .hx-step {
	border-inline-start: 2px solid ${t('edge')};
	padding-inline-start: 1rem;
	padding-block-end: 1rem;
	scroll-margin-block-start: ${t('sticky-offset')};
}

.hx-root .hx-step-number {
	display: block;
	color: ${t('dim')};
	font-size: 0.8125rem;
	text-transform: uppercase;
	letter-spacing: 0.05em;
}

.hx-root .hx-step-title {
	font-weight: 600;
	margin-block: 0 0.5rem;
}

.hx-root .hx-callout {
	background: ${t('surface')};
	border-inline-start: 3px solid ${t('edge')};
	border-radius: ${t('radius')};
	padding: 0.75rem 1rem;
	margin-block-end: 1rem;
}

.hx-root .hx-callout-title {
	font-weight: 600;
	margin-block: 0 0.5rem;
}

.hx-root .hx-callout > :last-child {
	margin-block-end: 0;
}`;

const CODE = `.hx-root .hx-fence {
	background: ${t('raised')};
	border: 1px solid ${t('edge')};
	border-radius: ${t('radius')};
	margin-block-end: 1rem;
	overflow: hidden;
}

.hx-root .hx-fence-bar {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	padding: 0.35rem 0.75rem;
	border-block-end: 1px solid ${t('edge')};
	color: ${t('dim')};
	font-size: 0.8125rem;
}

.hx-root .hx-fence-file {
	font-family: ${t('font-mono')};
}

.hx-root .hx-fence-lang {
	margin-inline-start: auto;
	text-transform: uppercase;
	letter-spacing: 0.05em;
}

.hx-root .hx-fence-lang + .hx-copy {
	margin-inline-start: 0;
}

.hx-root .hx-copy {
	margin-inline-start: auto;
	background: transparent;
	border: 1px solid ${t('control')};
	border-radius: 6px;
	color: ${t('dim')};
	font: inherit;
	font-size: 0.8125rem;
	padding: 0.15rem 0.5rem;
	cursor: pointer;
	min-block-size: 24px;
}

.hx-root .hx-copy:disabled {
	color: ${t('faint')};
	cursor: default;
}

.hx-root .hx-pre {
	margin: 0;
	padding: 0.75rem 0;
	overflow-x: auto;
	font-family: ${t('font-mono')};
	font-size: 0.875rem;
	line-height: 1.6;
	color: ${t('code-ink')};
	tab-size: 4;
}

/*
 * The code element inside a fence takes the fence's font. The browser's own stylesheet
 * gives \`code\` a font family, \`monospace\` alone, and a preflight gives it another, so
 * without this the mono token never reached the text of a fence on any host: not the stack
 * that covers the box-drawing characters, and not a consumer's override.
 */
.hx-root .hx-pre code {
	font: inherit;
}

.hx-root .hx-pre.hx-wrap {
	overflow-x: visible;
	white-space: pre-wrap;
	word-break: break-word;
}

.hx-root .hx-line {
	display: block;
	padding-inline: 0.75rem;
}

.hx-root .hx-line[data-marked='true'] {
	background: ${t('surface')};
	box-shadow: inset 2px 0 0 ${t('accent')};
}

/*
 * A fence is always \`dir="ltr"\` (\`CODE_DIRECTION\`), so this matches nothing today. It is
 * here so the bar does not rest on that: a shadow offset is physical, and a fence that ever
 * followed the content's direction would draw its bar on the trailing edge without it. The
 * physical-property scan in \`kit/test/theme/stylesheet.test.ts\` accepts a physical offset
 * only beside its mirror, and it would name this rule's absence.
 */
.hx-root .hx-line[data-marked='true']:dir(rtl) {
	box-shadow: inset -2px 0 0 ${t('accent')};
}

.hx-root .hx-line-number {
	display: inline-block;
	inline-size: 2.5em;
	margin-inline-end: 0.75em;
	color: ${t('faint')};
	text-align: end;
	user-select: none;
}

/*
 * The second channel for a diff. The two diff colours measure 1.29:1 against each other,
 * so a reader who cannot separate the hues gets everything from this character and nothing
 * from the colour.
 */
.hx-root .hx-line-diff {
	display: inline-block;
	inline-size: 1em;
	user-select: none;
}

.hx-root .hx-line[data-diff='inserted'] { background: color-mix(in srgb, ${t('code-good')} 12%, transparent); }
.hx-root .hx-line[data-diff='deleted'] { background: color-mix(in srgb, ${t('code-bad')} 12%, transparent); }`;

const CHROME = `.hx-root .hx-tree-list {
	list-style: none;
	margin: 0;
	padding-inline-start: 0;
}

.hx-root .hx-tree-list .hx-tree-list {
	padding-inline-start: 0.75rem;
	border-inline-start: 1px solid ${t('edge')};
	margin-inline-start: 0.25rem;
}

/*
 * WCAG 2.2 SC 2.5.8 wants 24 by 24. A dense sidebar fails it by default, and the padding
 * is what makes the target reach the number rather than the text happening to be tall.
 */
.hx-root .hx-tree-link,
.hx-root .hx-tree-section,
.hx-root .hx-toc-link {
	display: block;
	min-block-size: 24px;
	padding-block: 4px;
	padding-inline: 0.5rem;
	border-radius: 6px;
	color: ${t('dim')};
	text-decoration: none;
}

.hx-root .hx-tree-section {
	color: ${t('ink')};
	font-weight: 600;
}

/*
 * A group is a label over rows, not a page, so it is not a link and takes no target size.
 * Its rows sit at the indent of the rows around it rather than one step in: the label is
 * what says they belong together, and an indent per group as well would spend the phone's
 * text column on a structure the label already shows.
 *
 * The label is in \`ink\` at a medium weight, against rows in \`dim\` at the regular one, so
 * it is set apart by brightness rather than by being heavier: at 600 it read as a bolder
 * row, and the section rows above it are already the 600 in this list.
 */
.hx-root .hx-tree-group-label {
	display: block;
	margin-block: 0.25rem 0;
	padding-block: 4px;
	padding-inline: 0.5rem;
	color: ${t('ink')};
	font-size: 0.8125rem;
	font-weight: 500;
}

/*
 * A hairline over every group that follows a row, so a group reads as a block rather than
 * as a gap. The first row of a list has nothing above it to separate from, so it has none.
 */
.hx-root .hx-tree-item + .hx-tree-group {
	margin-block-start: 0.5rem;
	border-block-start: 1px solid ${t('edge')};
	padding-block-start: 0.25rem;
}

.hx-root .hx-tree-group > .hx-tree-list {
	padding-inline-start: 0;
	border-inline-start: 0;
	margin-inline-start: 0;
}

.hx-root .hx-tree-link:hover,
.hx-root .hx-toc-link:hover {
	color: ${t('ink')};
	background: ${t('surface')};
}

.hx-root [aria-current='page'],
.hx-root [aria-current='true'] {
	color: ${t('accent-link')};
	box-shadow: inset 2px 0 0 ${t('accent')};
}

/*
 * The current-item bar sits on the inline-start edge. A shadow's horizontal offset is
 * physical and has no logical form, so without this the bar stayed on the left in Arabic,
 * which is the trailing edge of a right-to-left list. A shadow rather than a logical border
 * because it takes no space, so marking a link current moves nothing. \`:dir()\` rather than
 * a selector on the root, so the element's own direction decides, whatever carries it.
 */
.hx-root [aria-current='page']:dir(rtl),
.hx-root [aria-current='true']:dir(rtl) {
	box-shadow: inset -2px 0 0 ${t('accent')};
}

.hx-root .hx-toc ol {
	list-style: none;
	margin: 0;
	padding-inline-start: 0;
}

.hx-root .hx-toc-heading {
	color: ${t('dim')};
	font-size: 0.8125rem;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	margin-block: 0 0.5rem;
}

.hx-root .hx-toc-item[data-depth='3'] { padding-inline-start: 0.75rem; }
.hx-root .hx-toc-item[data-depth='4'] { padding-inline-start: 1.5rem; }
.hx-root .hx-toc-item[data-depth='5'],
.hx-root .hx-toc-item[data-depth='6'] { padding-inline-start: 2.25rem; }

.hx-root .hx-breadcrumb ol {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	list-style: none;
	margin: 0 0 1rem;
	padding-inline-start: 0;
	color: ${t('dim')};
	font-size: 0.875rem;
}

/*
 * Breadcrumb links take the trail's colour and underline on hover. Stated rather than
 * left to the host, for the same reason as the edit link.
 */
.hx-root .hx-breadcrumb a {
	color: inherit;
	text-decoration: none;
}

.hx-root .hx-breadcrumb a:hover {
	color: ${t('ink')};
	text-decoration: underline;
}

.hx-root .hx-breadcrumb li + li::before {
	content: '/';
	margin-inline-end: 0.5rem;
	color: ${t('faint')};
}

.hx-root .hx-banner {
	background: ${t('surface')};
	border: 1px solid ${t('control')};
	border-radius: ${t('radius')};
	padding: 0.75rem 1rem;
	margin-block-end: 1.5rem;
	font-size: 0.9375rem;
}

.hx-root .hx-banner p {
	margin-block: 0 0.25rem;
}

.hx-root .hx-pager {
	display: flex;
	gap: 1rem;
	margin-block-start: 3rem;
	border-block-start: 1px solid ${t('edge')};
	padding-block-start: 1.5rem;
}

.hx-root .hx-next {
	margin-inline-start: auto;
	text-align: end;
}

/*
 * \`min-inline-size: 0\` is what lets the root's line breaker reach a pager title, and it is
 * the one holder the inherited property could not fix on its own. These are flex items, and
 * a flex item's automatic minimum size is its content's, so an unbreakable identifier held
 * the link at its own width however willing the text inside it was to break: measured at
 * 390px, a pager title carrying one ran to 451px in English and 82px off the leading edge in
 * Arabic, where the overflow runs the way a root's scrollable region does not extend.
 */
.hx-root .hx-pager a {
	display: block;
	min-inline-size: 0;
	min-block-size: 24px;
	text-decoration: none;
	color: ${t('accent-link')};
}

.hx-root .hx-pager-kind {
	display: block;
	color: ${t('dim')};
	font-size: 0.8125rem;
}`;

const SEARCH = `.hx-root .hx-search-trigger {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	inline-size: 100%;
	min-block-size: 24px;
	padding: 0.4rem 0.6rem;
	margin-block-end: 1rem;
	background: ${t('surface')};
	border: 1px solid ${t('control')};
	border-radius: 8px;
	color: ${t('dim')};
	font: inherit;
	font-size: 0.9375rem;
	cursor: pointer;
}

.hx-root .hx-search-trigger:disabled {
	color: ${t('faint')};
	cursor: default;
}

.hx-root .hx-search-hint {
	margin-inline-start: auto;
	color: ${t('faint')};
	font-size: 0.8125rem;
}

/*
 * \`margin: auto\` is what centres a modal dialog, and it is the browser's default rather
 * than anything this file said, until a preflight's \`* { margin: 0 }\` took it away. In
 * hex-web the dialog opened pinned to the top corner of the screen.
 */
.hx-search {
	inline-size: min(40rem, 92vw);
	max-block-size: 70vh;
	margin: auto;
	padding: 0;
	border: 1px solid ${t('control')};
	border-radius: ${t('radius')};
	background: ${t('surface')};
	color: ${t('ink')};
	font-family: ${t('font-body')};
}

.hx-search::backdrop {
	background: rgb(0 0 0 / 0.5);
}

.hx-search .hx-search-bar {
	display: flex;
	gap: 0.5rem;
	padding: 0.75rem;
	border-block-end: 1px solid ${t('edge')};
}

.hx-search .hx-search-input {
	flex: 1;
	background: ${t('ground')};
	border: 1px solid ${t('control')};
	border-radius: 8px;
	color: ${t('ink')};
	font: inherit;
	padding: 0.5rem 0.75rem;
}

.hx-search .hx-search-input::placeholder {
	color: ${t('faint')};
}

.hx-search .hx-search-close {
	background: transparent;
	border: 1px solid ${t('control')};
	border-radius: 8px;
	color: ${t('dim')};
	font: inherit;
	padding-inline: 0.75rem;
	min-block-size: 24px;
	cursor: pointer;
}

.hx-search .hx-search-results {
	list-style: none;
	margin: 0;
	padding: 0.5rem;
	overflow-y: auto;
	max-block-size: 50vh;
}

.hx-search .hx-search-link {
	display: block;
	padding: 0.5rem;
	border-radius: 8px;
	text-decoration: none;
	color: ${t('ink')};
	min-block-size: 24px;
}

.hx-search .hx-search-result[aria-selected='true'] .hx-search-link {
	background: ${t('raised')};
	box-shadow: inset 2px 0 0 ${t('accent')};
}

/*
 * The same bar, mirrored for the same reason. The dialog is drawn in the top layer and stays
 * where it is in the document, inside the docs root, so \`:dir()\` reads the interface
 * direction the root carries.
 */
.hx-search .hx-search-result[aria-selected='true'] .hx-search-link:dir(rtl) {
	box-shadow: inset -2px 0 0 ${t('accent')};
}

.hx-search .hx-search-heading {
	display: block;
	color: ${t('dim')};
	font-size: 0.875rem;
}`;

/**
 * The smallest touch target on a phone, 44px. Not a token, and neither are the two below: no
 * host would retheme them, and a token is read through a `var()` chain that only earns its
 * length when somebody has a reason to override it.
 */
const TARGET = '2.75rem';

/** The height of the row in the phone's bottom bar, above any safe-area padding under it. */
const FOOT = '3rem';

/**
 * The bar's Pages link at its narrowest, so it stays a wide target in a language whose word for
 * it is short. Nothing else is derived from it: the bar pads itself in to the column, so the
 * link ends at the column's edge whatever width the translated word turns out to be.
 */
const PAGES_WIDTH = '5rem';

const PHONE = `/*
 * The phone layout, below 60rem, and the desktop state of the elements only it shows.
 *
 * After CHROME and SEARCH, and that position is load-bearing. The rules for the tree and
 * outline rows and for the search dialog override rules of exactly the same specificity in
 * those two blocks, and at equal specificity the later rule wins. Moved above them, every
 * row falls back to the desktop's 24px target and the dialog to its centred desktop size.
 * \`kit/test/theme/stylesheet.test.ts\` asserts the order.
 *
 * The page tree and search sit at the top of the page in flow and scroll away once reading
 * starts. The table of contents becomes a bar stuck to the bottom of the viewport, under the
 * thumb, which names the heading the reader is in and opens the outline upward. Both are
 * native \`<details>\`, so the whole layout works with no script, and neither adds anything
 * to the top of the viewport, where the host's own sticky header already is.
 *
 * Nothing here is physical. The chevrons are symmetric about the vertical axis, so a turn
 * needs no mirror, and \`env(safe-area-inset-bottom)\` names an edge of the device rather
 * than a side of the text.
 *
 * The desktop state of the new elements states every property a host's base layer sets on
 * them, Tailwind's \`summary { display: list-item }\` included, for the reason the generator
 * gives at its top: an unlayered rule beats a layered one only for the properties it states.
 */
.hx-root .hx-tree-summary,
.hx-root .hx-toc-summary {
	display: none;
	list-style: none;
	margin: 0;
	padding: 0;
	border: 0;
}

.hx-root .hx-tree-summary::-webkit-details-marker,
.hx-root .hx-toc-summary::-webkit-details-marker {
	display: none;
}

/*
 * Not displayed on a desktop at all. A closed details element that generates a box, even an
 * empty zero-height one, is an unnamed group in the accessibility tree, so a desktop screen
 * reader walking the tree or the outline landmark met a group it could do nothing with. The
 * phone block displays both again, and without that rule the Pages chip and the bar's outline
 * control are gone at phone width. Not \`display: contents\`, which Chrome still exposes as a
 * group.
 */
.hx-root .hx-tree-disclosure,
.hx-root .hx-toc-disclosure {
	display: none;
	margin: 0;
	padding: 0;
	border: 0;
}

/* It generates no box on a desktop, so the table of contents is still the grid's third item. */
.hx-root .hx-foot {
	display: contents;
}

.hx-root .hx-foot-pages {
	display: none;
}

@media (max-width: 60rem) {
	/*
	 * A block container rather than a one-column grid, and not for the bar's sake: a sticky grid
	 * item is held inside the grid container rather than its own area, and measured in Chrome the
	 * bar sticks and settles above the host's footer either way. What a grid changes is the rows.
	 * An auto inline margin stops a grid item stretching, so the centred row and article would
	 * shrink to their content rather than fill the column, and the desktop's gap would open 2rem
	 * between rows. A flow root rather than a plain block, because a plain block lets the tree's
	 * top margin collapse through it and out past the docs root, which then starts 12px below the
	 * host's header with the host's ground showing in the gap.
	 */
	.hx-root .hx-layout {
		display: flow-root;
		/* The article's own end margin already clears the footer by 2rem here. */
		padding-block-end: 1rem;
	}

	/*
	 * The top row: Search taking the room and Pages beside it, with the list on a line of its
	 * own under them. Static, because the desktop's sticky rail would pin the row, and an
	 * open tree with it, over the article. The scroll margin is for the bar's Pages link,
	 * which jumps here and would otherwise land the row under the host's header.
	 */
	.hx-root .hx-tree {
		position: static;
		max-block-size: none;
		overflow: visible;
		padding-block-end: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: stretch;
		gap: 0.5rem;
		max-inline-size: ${t('measure')};
		margin-inline: auto;
		margin-block: 0.75rem 1rem;
		scroll-margin-block-start: ${t('sticky-offset')};
	}

	.hx-root .hx-tree > * {
		flex: 0 0 100%;
		min-inline-size: 0;
	}

	.hx-root .hx-tree > .hx-search-trigger {
		flex: 1 1 0;
		inline-size: auto;
		min-block-size: ${TARGET};
		margin-block-end: 0;
	}

	/* The desktop hides both disclosures outright; here they are the controls. */
	.hx-root .hx-tree-disclosure,
	.hx-root .hx-toc-disclosure {
		display: block;
	}

	.hx-root .hx-tree > .hx-tree-disclosure {
		flex: 0 0 auto;
	}

	/* The shortcut is a keyboard's, and a phone reader has none to press it on. */
	.hx-root .hx-search-hint {
		display: none;
	}

	.hx-root .hx-tree-summary {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-block-size: ${TARGET};
		padding-inline: 0.875rem 0.75rem;
		background: ${t('surface')};
		border: 1px solid ${t('control')};
		border-radius: 8px;
		color: ${t('ink')};
		font-size: 0.9375rem;
		cursor: pointer;
	}

	/*
	 * A box clipped to a chevron, painted with a token rather than a glyph some font in seven
	 * languages has to cover. It points where the panel appears: down for the tree, up for
	 * the outline, and the other way while each is open.
	 */
	.hx-root .hx-tree-summary::after,
	.hx-root .hx-toc-summary::after {
		content: '';
		flex: none;
		inline-size: 0.75rem;
		block-size: 0.5rem;
		background: ${t('dim')};
		clip-path: polygon(0 0, 16% 0, 50% 62%, 84% 0, 100% 0, 50% 100%);
	}

	.hx-root .hx-tree-disclosure[open] > .hx-tree-summary::after,
	.hx-root .hx-toc-summary::after {
		transform: rotate(180deg);
	}

	.hx-root .hx-toc-disclosure[open] > .hx-toc-summary::after {
		transform: none;
	}

	/*
	 * The lists are the disclosures' next siblings rather than their content, so a desktop
	 * never depends on a \`<details>\` being open. Here the closed state hides them.
	 */
	.hx-root .hx-tree-disclosure:not([open]) + .hx-tree-list {
		display: none;
	}

	/*
	 * In flow under the row, so the article moves down rather than being covered. Its own
	 * scroll container, contained, so the page stays still at the end of a long tree.
	 * Positioned so it is the offset parent of its rows, which is what \`revealCurrent\` in
	 * \`src/render/client.ts\` measures against.
	 */
	.hx-root .hx-tree-disclosure + .hx-tree-list {
		position: relative;
		max-block-size: 60svh;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0.5rem;
		background: ${t('surface')};
		border: 1px solid ${t('edge')};
		border-radius: ${t('radius')};
	}

	/* Every row a thumb can hit. \`test/paint.test.ts\` deletes the height and watches the probe fail. */
	.hx-root .hx-tree-link,
	.hx-root .hx-tree-section,
	.hx-root .hx-toc-link {
		display: flex;
		align-items: center;
		min-block-size: ${TARGET};
		padding-block: 0.5rem;
		padding-inline: 0.75rem;
	}

	/* The label lines up with the rows under it, which the phone pads further in. */
	.hx-root .hx-tree-group-label {
		padding-inline: 0.75rem;
	}

	.hx-root .hx-article {
		margin-inline: auto;
		margin-block-end: 2rem;
	}

	/* The summary carries the same words on a phone, and it is the one that toggles. */
	.hx-root .hx-toc-heading {
		display: none;
	}

	/*
	 * The bar. It pulls out of the layout's inset and pads back in, so its rule and ground run
	 * edge to edge while its content lines up with the column. Overflow stays visible: the
	 * outline panel is drawn outside this box, above it, and a clipped bar would hide it.
	 * Sticky inside the layout, so at the end of the page it settles into flow above the
	 * host's footer rather than covering it.
	 *
	 * The inline padding is the column's own inset: the shell's inset on a phone, and on a
	 * tablet the room either side of the centred measure as well, so the label starts at the
	 * column's start and the link ends at its end whatever width the translated link has. A
	 * percentage in padding resolves against the layout's content box, which is the box the
	 * column is centred in. Padding by the shell's inset alone and centring a pair sized around
	 * the link's minimum lined up only when the word fitted that minimum; in Arabic it did not,
	 * and at 768px the label and the link each sat 10px outside the column.
	 *
	 * The block-end padding is never less than 4px, which is how far the shared focus ring
	 * reaches outside a control: 2px wide at a 2px offset. The bar is stuck to the bottom of the
	 * viewport, so with no padding the ring's bottom edge on the summary and the Pages link is
	 * drawn below the screen. An inset ring was measured and refused: the summary has no
	 * inline-start padding, and a ring drawn inside it covers the label's first letter.
	 */
	.hx-root .hx-foot {
		display: flex;
		align-items: stretch;
		justify-content: center;
		position: sticky;
		inset-block-end: 0;
		z-index: 2;
		margin-inline: calc(-1 * ${t('shell-inset')});
		padding-inline: max(${t('shell-inset')}, calc((100% - ${t('measure')}) / 2 + ${t('shell-inset')}));
		padding-block-end: max(4px, env(safe-area-inset-bottom, 0px));
		background: ${t('surface')};
		border-block-start: 1px solid ${t('edge')};
	}

	/*
	 * Static, so the sticky bar is the outline panel's containing block. It takes whatever the
	 * Pages link leaves of the bar's content box, which the bar's padding makes the column, so
	 * nothing here has to know how wide the translated link is.
	 */
	.hx-root .hx-toc {
		position: static;
		max-block-size: none;
		overflow: visible;
		padding-block-end: 0;
		flex: 1 1 auto;
		min-inline-size: 0;
	}

	.hx-root .hx-toc-summary {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-block-size: ${FOOT};
		padding-block: 0.375rem;
		padding-inline-end: 0.5rem;
		color: ${t('ink')};
		cursor: pointer;
	}

	.hx-root .hx-toc-where {
		display: flex;
		flex-direction: column;
		justify-content: center;
		flex: 1 1 auto;
		min-inline-size: 0;
	}

	.hx-root .hx-toc-summary-label {
		display: block;
		color: ${t('dim')};
		font-size: 0.75rem;
		line-height: 1.25;
	}

	/*
	 * Until the scroll spy names a heading, and for the whole visit with no script, the label
	 * is the control and reads as one: ink, at the size of the link beside it. Without this
	 * the bar at rest is a small dim caption for a second line that is not there.
	 */
	.hx-root .hx-toc-summary:has(.hx-toc-here:empty) .hx-toc-summary-label {
		color: ${t('ink')};
		font-size: 0.9375rem;
		line-height: 1.4;
	}

	/*
	 * One line whatever the heading; the accessible name keeps the whole text. The caption's
	 * 15px line, this 21px one and the summary's 12px of padding fill its 3rem row exactly, so
	 * naming a heading changes the bar's height by nothing. A caption at a line height of 1.3
	 * made the row 48.6px, and the bar's top rule moved the first time the spy answered.
	 */
	.hx-root .hx-toc-here {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.9375rem;
		line-height: 1.4;
	}

	.hx-root .hx-toc-disclosure:not([open]) + .hx-toc-list {
		display: none;
	}

	/*
	 * Above the bar and out of flow, so the article never moves when it opens or closes. The
	 * percentage in the inline padding resolves against the bar's full-bleed box rather than
	 * the column, which is why it is not the column's own centring formula.
	 *
	 * An absolute box is placed against its containing block's padding box, which starts inside
	 * the bar's 1px top rule, so the panel's last row of pixels lies on that rule, and the panel
	 * draws its own end border there in the rule's colour. Placed a pixel higher, its edge met the
	 * rule's outer edge exactly, and edges that meet exactly snap to different device rows at a
	 * fractional device pixel ratio: measured at 1.5, 1.75 and 2.625, a row of the article showed
	 * through between the open panel and the bar. Every box under the docs root is border-box, so
	 * the border takes nothing past the panel's height cap.
	 */
	.hx-root .hx-toc-disclosure + .hx-toc-list {
		position: absolute;
		inset-block-end: 100%;
		inset-inline: 0;
		margin: 0;
		max-block-size: 60svh;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding-block: 0.5rem;
		padding-inline: max(${t('shell-inset')}, calc((100% - ${t('measure')}) / 2));
		background: ${t('surface')};
		border-block: 1px solid ${t('edge')};
	}

	.hx-root .hx-foot-pages {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		flex: 0 0 auto;
		min-inline-size: ${PAGES_WIDTH};
		min-block-size: ${FOOT};
		margin: 0;
		padding-inline: 1.25rem;
		border: 0;
		color: ${t('ink')};
		font-size: 0.9375rem;
		font-weight: 600;
		text-decoration: none;
	}

	/*
	 * A page with no outline: the link takes the column's width, so the word sits where it
	 * does on every other page and the whole bar is the target.
	 */
	.hx-root .hx-foot-pages:only-child {
		flex: 0 1 ${t('measure')};
	}

	/*
	 * Anchored to the top, so the input does not move as results arrive and stays above the
	 * on-screen keyboard. The rule outside this block keeps \`margin: auto\`, which centres the
	 * dialog everywhere else. The maximum is lifted because the browser's own rule for a modal
	 * dialog caps it at \`calc(100% - 6px - 2em)\`, which is narrower than this width below about
	 * 720px: the dialog was 354px wide with 18px either side, not the shell's 16px.
	 */
	.hx-search {
		inline-size: calc(100% - 2 * ${t('shell-inset')});
		max-inline-size: none;
		max-block-size: 80svh;
		margin-block: ${t('shell-inset')} auto;
	}
}

/*
 * A forced palette repaints the chevrons' token background as Canvas, the colour of the ground
 * under them, and both vanish, which takes away the only open or closed cue either disclosure
 * has and leaves the bar reading as plain text. CanvasText is the reader's own text colour, so
 * it follows whichever palette they chose. After the phone block, because the rule it overrides
 * there has the same specificity; outside it, because the summaries show nowhere else.
 */
@media (forced-colors: active) {
	.hx-root .hx-tree-summary::after,
	.hx-root .hx-toc-summary::after {
		background: CanvasText;
	}
}`;

const SCRIPTS = `/*
 * Script-dependent typography.
 *
 * The self-hosted faces both consumers ship cover latin and latin-ext, so CJK and Arabic
 * body text falls to the system stack, whose metrics differ. Leading has to change with
 * it or the lines crowd.
 *
 * \`font-synthesis-weight\` is the one that is a real bug rather than a preference. Both
 * consumers set it to \`none\` on \`body\`, which is right for a variable Latin face that
 * covers 400 to 700 and wrong for a system CJK face with no bold cut: a Japanese h3 then
 * renders at body weight and the heading hierarchy disappears.
 */
.hx-root:lang(ja),
.hx-root:lang(zh) {
	line-height: 1.9;
	font-synthesis-weight: auto;
}

.hx-root:lang(ar) {
	line-height: 2;
	font-size: 1.0625rem;
	font-synthesis-weight: auto;
}`;

const MOTION = `/*
 * The motion gate is the media query and only the media query. It needs no JavaScript and
 * is correct on the first paint, which is exactly what a rule keyed off the root's
 * \`data-reduced\` attribute would not be.
 */
@media (prefers-reduced-motion: reduce) {
	.hx-root *,
	.hx-root *::before,
	.hx-root *::after {
		transition-duration: 0.01ms !important;
		animation-duration: 0.01ms !important;
		animation-iteration-count: 1 !important;
		scroll-behavior: auto !important;
	}
}`;
