/**
 * The generator for `src/render/docs.css`.
 *
 * The stylesheet is generated, not hand-edited, and the reason is the one defect this
 * package's theme contract exists to prevent. Every colour has to be read at its point of
 * use through the full `var()` chain, and a hand-written rule that spells a chain slightly
 * differently, or writes a literal because the chain was long, passes every test that reads
 * the stylesheet and every test that renders it under a theme class. So the only thing in
 * here that can produce a colour is `t()`, which expands a token name through the contract's
 * own `tokenValue` and throws on a name the table does not have. A hard-coded colour is not
 * detected; it is unwriteable.
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
 * Exported only so the test can call it. The guarantee this file rests on is that a
 * hard-coded colour is unwriteable rather than merely detectable, and a guarantee nobody
 * has made fail is not known to hold.
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

const BASE = `.hx-root {
	color: ${t('ink')};
	background: ${t('ground')};
	font-family: ${t('font-body')};
	font-size: ${t('font-size')};
	line-height: ${t('leading')};
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
	font-size: 0.9375rem;
}

.hx-root .hx-article {
	max-inline-size: ${t('measure')};
	min-inline-size: 0;
}

.hx-root .hx-article:focus {
	outline: none;
}

@media (max-width: 60rem) {
	.hx-root .hx-layout {
		grid-template-columns: minmax(0, 1fr);
	}

	.hx-root .hx-tree,
	.hx-root .hx-toc {
		position: static;
		max-block-size: none;
	}
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

.hx-root .hx-pager a {
	display: block;
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
