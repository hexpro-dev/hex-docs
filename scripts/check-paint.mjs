#!/usr/bin/env node
/**
 * The stylesheet, checked in a real browser.
 *
 * Three kinds of property only a CSS engine has an opinion about, in one row.
 *
 * The first is the token contract. `src/contracts/theme.ts` names the one check that
 * catches the defect it exists to prevent: render the shell under a theme class and assert
 * the computed accent actually differs. Everything else about the stylesheet's text is
 * asserted in `kit/test/theme/stylesheet.test.ts`.
 *
 * The second is what the shell does inside a real site, which is not what it does on a
 * blank page. Step 8 mounted it in hex-web and a headless pass over the production build
 * found four layout defects, every one of them invisible without a host around the docs:
 * a skip link hidden relative to a root that no longer started at the top of the page, a
 * task marker on its own line, an inline image turned into a block by the host's
 * preflight, and a shell with no inline gutter inside a full-bleed `main`. So the layout
 * probes reproduce the host rather than the package: the docs root below a sticky header,
 * Tailwind's preflight in `@layer base`, and phone and desktop widths.
 *
 * The third is whether the engine accepts what the stylesheet says at all, and where paint
 * that depends on direction lands. The partial status mark was written with a gradient
 * direction no engine parses, so every partial mark painted as an empty ring, and the
 * current-item bar used a physical shadow offset that stayed on the left in Arabic. Neither
 * was visible to a probe that measured something else, so the `declarations` probe asks the
 * browser about every declaration in the file, and the `sides-*` probes read the painted
 * pixels of a mark and a bar in both directions and inside a fallback article.
 *
 * ## Why a browser rather than a DOM library
 *
 * Measured, both ways, before this was written.
 *
 *   jsdom      correct stylesheet  color="var(--hx-accent-link, var(--color-accent, ...))"
 *   jsdom      broken  stylesheet  color="var(--hx-accent-link)"
 *   happy-dom  correct stylesheet  #ff6600
 *   happy-dom  broken  stylesheet  #ff6600
 *
 * jsdom does not resolve `var()` at all and hands back the literal text. happy-dom does
 * resolve it, and resolves it at the point of use, which is the opposite of what a browser
 * does: it therefore returns the correct colour for the exact stylesheet bug this check
 * exists to catch, so a theme test written against it passes on the broken version and is
 * worse than no test.
 *
 * ## Why there is a descendant case
 *
 * The check the contract prescribes puts the theme class above the docs root. Measured:
 * the obvious optimisation, declaring one private alias per token on the docs root so the
 * chain is written once, passes that check and fails for anything at or below the root.
 *
 *   case                      chain at every use site   alias on the docs root
 *   theme on an ancestor      themed                    themed
 *   theme on the docs root    themed                    themed
 *   theme on a descendant     themed                    NOT themed
 *   --hx-* on a descendant    themed                    NOT themed
 *
 * So the last two cases are the ones that make this row worth running, and a check with
 * only the first two would have signed off the version that is wrong.
 *
 * ## No dependency
 *
 * Node 22 has a global `WebSocket`, so driving Chrome over the DevTools Protocol is
 * `spawn` plus JSON. GitHub's ubuntu-24.04 image ships Google Chrome and Chromium
 * preinstalled, so this needs no install step in CI either.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

import { check, renderAndExit, skipped } from './lib/report.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Where a browser might be. `HEXDOCS_CHROME` wins, so a developer with one somewhere else
 * can point at it rather than being told the row was skipped.
 */
const CANDIDATES = [
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
];

export function findBrowser() {
	const named = process.env.HEXDOCS_CHROME;
	if (named !== undefined && named !== '') return existsSync(named) ? named : undefined;
	return CANDIDATES.find((path) => existsSync(path));
}

/**
 * The page every probe runs against.
 *
 * It is the package's own stylesheet, unmodified, plus the smallest markup that carries
 * the classes the probes read. A hand-written stylesheet here would be checking something
 * this package does not ship. A host style block, when a probe has one, comes first, the
 * way a consuming site's own CSS does.
 *
 * @param {string} css
 * @param {string} body
 * @param {string} [host]
 */
const page = (css, body, host) =>
	`<!doctype html><meta charset="utf-8">${host === undefined ? '' : `<style>${host}</style>`}<style>${css}</style>${body}`;

/**
 * @typedef {object} Probe
 * @property {string} id
 * @property {string} body
 * @property {string} expression  Evaluated in the page; a promise is awaited.
 * @property {string} why
 * @property {string} [host]  A consuming site's stylesheet, loaded before the package's.
 * @property {number} [width]  The viewport width in CSS pixels. Defaults to `DESKTOP`.
 * @property {boolean} [sample]  The expression returns JSON carrying a `samples` map of names
 *   to viewport points, and the colour painted at each point is read back out of a screenshot
 *   and attached to the measurement as `pixels`.
 * @property {{ name: string, value: string }[]} [media]  Media features the page is emulated
 *   under, such as a forced colour palette. None by default.
 */

const DESKTOP = 1280;
const PHONE = 390;
/** The narrowest phone still in use, where the column is 30px tighter than at `PHONE`. */
const NARROW = 360;
/** A tablet held upright, which is still under the phone breakpoint and wider than the column. */
const TABLET = 768;

/**
 * The smallest distance, in CSS pixels, the shell may leave between its content and the
 * edge of the viewport. It is the floor of the `shell-inset` token's clamp, written here
 * as a number rather than read from the stylesheet, because a probe that read the value it
 * checks would pass on a zero.
 */
const MIN_INSET = 16;

/** What Chrome paints an unstyled link, which is unreadable on the package's ground. */
const UA_LINK = 'rgb(0, 0, 238)';

/**
 * The smallest touch target on a phone, in CSS pixels. A number here rather than read from the
 * stylesheet, for the reason `MIN_INSET` gives.
 */
const TOUCH = 44;

/**
 * How far down a 390 by 900 phone viewport the first paragraph may start: 24rem, which leaves
 * most of the first screen for reading under a 64px host header, the search and Pages row and
 * a one-line title.
 */
const FIRST_SCREEN = 384;

/** The tallest the phone's bottom bar may be with a heading named in it: its 3rem row and room to spare. */
const FOOT_MAX = 64;

/** A seventy-character heading, the length of a long French or Portuguese one, for the bar's second line. */
const LONG_HEADING = 'Hold the top edge of your phone flat against the tag for a full second';

/**
 * The base layer a consuming site puts under the docs, reduced to the rules that restyle
 * an element this renderer emits.
 *
 * Tailwind v4's preflight, which both consumers ship, cut down to those rules and written
 * the way hex-web's production build compiles it: in `@layer base`, with the `--theme()`
 * fallbacks resolved to plain values. The
 * package's rules are unlayered and beat any layered rule, but only for a property they
 * state, so anything here the stylesheet leaves unstated is decided by the host. The
 * heading colour is the one line that is not preflight. kcalc-web's own base layer sets it
 * on h1 to h4, and that site's paper ink on this package's ground is the 1.33:1
 * `src/contracts/theme.ts` records.
 */
const HOST_BASE = `@layer base {
	*, ::after, ::before, ::backdrop { box-sizing: border-box; border: 0 solid; margin: 0; padding: 0; }
	h1, h2, h3, h4, h5, h6 { font-size: inherit; font-weight: inherit; }
	h1, h2, h3, h4 { color: #1f2c26; }
	a { color: inherit; text-decoration: inherit; }
	code, kbd, samp, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 1em; }
	ol, ul, menu { list-style: none; }
	img, svg, video, canvas, audio, iframe, embed, object { vertical-align: middle; display: block; }
	img, video { max-width: 100%; height: auto; }
	button, input, select, optgroup, textarea { font: inherit; letter-spacing: inherit; color: inherit; opacity: 1; background-color: transparent; border-radius: 0; }
	summary { display: list-item; }
}`;

/**
 * hex-web's shape around the docs: a 64px sticky header with a rule under it, then a
 * full-bleed `main`. Its product pages are full-width bands, so nothing between the
 * viewport and the docs root pads it, and the root starts 65px down. A skip link hidden by
 * moving it above the root lands on that header.
 *
 * @param {string} inner
 */
const hosted = (inner) =>
	`<header style="position: sticky; inset-block-start: 0; z-index: 50; block-size: 64px; border-block-end: 1px solid #333; background: #0f0e0d"></header><main>${inner}</main>`;

/**
 * Renderer output, verbatim.
 *
 * `test/paint.test.ts` renders the same nodes through the real renderer and asserts these
 * strings are what comes out, so a probe cannot go on passing against markup the renderer
 * has stopped emitting. The image source does not resolve on a blank page and does not need
 * to: `width` and `height` size the box before anything loads, which is also how a real
 * page lays out before the image arrives.
 */
export const FRAGMENTS = {
	skip: '<a class="hx-skip" href="#hx-content">Skip to documentation</a>',
	taskList:
		'<ul class="hx-list hx-tight"><li><p>An NTAG 213 tag</p></li><li class="hx-task-item"><span class="hx-task hx-task-done" role="img" aria-label="Done"></span><p>An iPhone 7 or later running iOS 16 or newer</p></li><li class="hx-task-item"><span class="hx-task hx-task-todo" role="img" aria-label="Not done"></span><p>A case thinner than 3 mm</p></li></ul>',
	inlineImage:
		'<p>The Scan sheet shows <img class="hx-image" src="/_docs/fixture-app/1.1.0/assets/0000.png" alt="the radio badge" width="16" height="16" loading="lazy" decoding="async"/> in its top corner.</p>',
	figure:
		'<figure class="hx-figure"><img class="hx-image" src="/_docs/fixture-app/1.1.0/assets/0000.png" alt="The Scan sheet" width="320" height="180" loading="lazy" decoding="async"/><figcaption>The Scan sheet, open</figcaption></figure>',
	status:
		'<p>Writing an NTAG424 DNA is <span class="hx-status hx-status-half" data-status="partial" role="img" aria-label="Partial"></span> on iOS 18.2.</p>',
	longToken:
		'<p>The store writes each credential with <code class="hx-code">kSecAttrAccessibleWhenUnlockedThisDeviceOnly</code> so it never leaves the phone.</p>',
	tokenTable:
		'<div class="hx-scroll" tabindex="0" role="group" aria-label="Table"><table class="hx-table"><thead><tr><th scope="col">Chip</th><th scope="col">Attribute</th></tr></thead><tbody><tr><td>NTAG 424 DNA</td><td><code class="hx-code">kSecAttrAccessibleWhenUnlockedThisDeviceOnly</code></td></tr></tbody></table></div>',
};

/**
 * The identifier `FRAGMENTS.longToken` carries, which is the one the defect was measured on.
 *
 * A real Keychain constant rather than a made-up string of x's: it is 44 characters with no
 * space, no hyphen and no underscore, so it offers a line breaker nothing to work with, and
 * at the shell's phone font it lays out 390.2px wide in a 358px column.
 */
const LONG_TOKEN = 'kSecAttrAccessibleWhenUnlockedThisDeviceOnly';

/**
 * The shell around a probe's content, with the class names `DocsPage` renders, nested the way
 * it nests them. Every `hx-` class in any probe's markup is asserted present in a rendered
 * page by `test/paint.test.ts`, which is a check on the names and not on how they nest, so
 * the nesting here is mirrored from `src/render/page.tsx` by hand: the Pages disclosure after
 * the search trigger with the tree list as its next sibling, and the table of contents inside
 * the bar's wrapper with the outline disclosure before its list and the bar's Pages link last.
 *
 * `dir` is the interface direction the root carries, and `article` the attributes the
 * article gains when the content served is in a different language from the interface,
 * which is how an Arabic page serving the English fallback reads left to right inside a
 * right-to-left shell. `current` adds a second tree link and a second table of contents
 * link and marks the first of each current, so a probe can compare a current link with a
 * plain one at the same place. `links` is how many rows the tree has, for a probe that needs
 * a tree long enough to push the article off the first screen if it were shown, and `mark`
 * which of them is the current page. `tocLinks` is how many rows the outline has, and `pages`
 * the word the Pages chip and the bar's link carry.
 *
 * @param {{ prose: string, head?: string, tree?: string, dir?: 'ltr' | 'rtl', article?: string, current?: boolean, links?: number, mark?: number, tocLinks?: number, pages?: string }} parts
 */
const shell = ({
	prose,
	head = '',
	tree = '',
	dir = 'ltr',
	article = '',
	current = false,
	links = current ? 2 : 1,
	mark = current ? 0 : undefined,
	tocLinks = current ? 2 : 1,
	pages = 'Pages',
}) =>
	`<div class="hx-root" dir="${dir}">${FRAGMENTS.skip}<div class="hx-layout"><nav id="hx-tree" class="hx-tree" aria-label="Documentation"><button type="button" class="hx-search-trigger" disabled="">Search</button>${tree}<details class="hx-tree-disclosure"><summary class="hx-tree-summary">${pages}</summary></details><ol class="hx-tree-list">${treeRows(links, mark)}</ol></nav><article id="hx-content" class="hx-article" tabindex="-1"${article}>${head}<h1 id="hx-title" class="hx-title">Scan your first tag</h1><div class="hx-prose">${prose}</div></article><div class="hx-foot"><nav id="hx-toc" class="hx-toc" aria-label="On this page"><p class="hx-toc-heading">On this page</p><details class="hx-toc-disclosure"><summary class="hx-toc-summary"><span class="hx-toc-where"><span class="hx-toc-summary-label">On this page</span><span class="hx-toc-here"></span></span></summary></details><ol class="hx-toc-list">${tocRows(tocLinks, current)}</ol></nav><a class="hx-foot-pages" href="#hx-tree">${pages}</a></div></div></div>`;

/**
 * The tree's rows, with the one at `mark` marked as the current page.
 *
 * @param {number} count
 * @param {number | undefined} mark
 */
function treeRows(count, mark) {
	const names = ['First scan', 'Write a tag'];
	return Array.from(
		{ length: count },
		(_, index) =>
			`<li class="hx-tree-item"><a class="hx-tree-link" href="#${index === 0 ? 'first' : index === 1 ? 'write' : `page-${index + 1}`}"${index === mark ? ' aria-current="page"' : ''}>${names[index] ?? `Page ${index + 1}`}</a></li>`,
	).join('');
}

/**
 * The outline's rows: the first marked current when `current` is set, and the rest plain.
 *
 * @param {number} count
 * @param {boolean} current
 */
function tocRows(count, current) {
	const names = [
		['before', 'Before you start'],
		['hold', 'Hold the tag still'],
	];
	return Array.from({ length: count }, (_, index) => {
		const [id, text] = names[index] ?? [`heading-${index + 1}`, `Heading ${index + 1}`];
		return `<li class="hx-toc-item" data-depth="2"><a href="#${id}" class="hx-toc-link"${current && index === 0 ? ' aria-current="true"' : ''}>${text}</a></li>`;
	}).join('');
}

const PARAGRAPH =
	'<p>A first read takes about ten seconds once the tag is in your hand. Most of that is finding the spot on the phone where the antenna sits, which is further up the back than people expect.</p>';

/**
 * A page carrying a token wider than the phone's column, in the three places one turns up.
 *
 * The ordinary paragraph comes first and is what the prose arm reads, so the probe can say
 * that the line breaker was left alone everywhere the token is not. The fence line is the
 * same identifier inside a `pre`, which keeps `white-space: pre` and scrolls sideways in its
 * own scroller; the table cell is the identifier in a `td`, where a break opportunity that
 * counted towards the minimum content width would collapse the column instead of leaving the
 * table wide. Both are here because the wrong fix for the paragraph takes one of them with
 * it, and neither would say so from a page with only the paragraph on it.
 */
const TOKEN_PAGE = (dir = 'ltr', article = '') =>
	hosted(
		shell({
			dir,
			article,
			prose:
				PARAGRAPH +
				FRAGMENTS.longToken +
				`<div class="hx-fence" data-lang="swift"><pre class="hx-pre" dir="ltr" tabindex="0" role="group" aria-label="Swift code block"><code><span class="hx-line"><span class="hx-s-keyword">let</span> access = ${LONG_TOKEN}</span></code></pre></div>` +
				FRAGMENTS.tokenTable,
		}),
	);

/**
 * What runs past the edge of the screen, and what the line breaker did to get there, as JSON.
 *
 * `scrollingElement.scrollWidth` is read and is not enough on its own, which is the finding
 * that shaped this. In a right-to-left page the overflow runs off the leading edge, and a
 * root's scrollable region does not extend that way: measured on the Arabic address of the
 * same page, the identifier's box ended 41px past a 390px screen while `scrollWidth` read
 * exactly 390. So the boxes are walked as well, and anything inside a scroll container is
 * skipped, because a table that is wider than its scroller is reachable by scrolling and is
 * the point of having one.
 */
const SPILL = `(() => {
	// The document's own direction, which is the reader's: both consumers write it on <html>
	// from their root loader, and the docs root under it carries the same answer. It has to be
	// on the document element and not only on the shell, because that is what decides which way
	// the root's scrollable region extends, and therefore whether scrollWidth can see the
	// overflow at all.
	document.documentElement.dir = document.querySelector('.hx-root').dir;
	const width = document.documentElement.clientWidth;
	const scrolled = (element) => {
		for (let node = element.parentElement; node !== null; node = node.parentElement) {
			const overflow = getComputedStyle(node).overflowX;
			if (overflow === 'auto' || overflow === 'scroll') return true;
			if (node.classList.contains('hx-article')) return false;
		}
		return false;
	};
	const spill = [...document.querySelectorAll('.hx-article *')]
		.map((element) => ({ element, box: element.getBoundingClientRect() }))
		.filter(({ element, box }) => box.width > 0 && (box.right > width + 0.5 || box.left < -0.5) && !scrolled(element))
		.map(({ element, box }) => ({
			name: element.className === '' ? element.tagName.toLowerCase() : String(element.className),
			past: Math.round(Math.max(box.right - width, -box.left)),
		}));
	const token = document.querySelector('.hx-prose > p .hx-code');
	const pre = document.querySelector('.hx-pre');
	const scroller = document.querySelector('.hx-scroll');
	// Where every line break in the ordinary paragraph fell. A break between two characters
	// that are both ink is a word split down the middle, which is what a line breaker told to
	// break anywhere does to prose it was never meant to touch.
	const words = document.querySelector('.hx-prose > p').firstChild;
	const range = document.createRange();
	const text = words.textContent;
	const split = [];
	let line = null;
	for (let index = 0; index < text.length; index += 1) {
		range.setStart(words, index);
		range.setEnd(words, index + 1);
		const box = range.getBoundingClientRect();
		if (box.height === 0) continue;
		if (line !== null && box.top > line + 1 && !/\\s/.test(text[index - 1]) && !/\\s/.test(text[index])) {
			split.push(text.slice(Math.max(0, index - 10), index) + '|' + text.slice(index, index + 6));
		}
		line = box.top;
	}
	return JSON.stringify({
		width,
		scrollWidth: document.scrollingElement.scrollWidth,
		spill,
		lines: token.getClientRects().length,
		fence: { scrolls: pre.scrollWidth > pre.clientWidth, wrap: getComputedStyle(pre).whiteSpace },
		table: { scrolls: scroller.scrollWidth > scroller.clientWidth },
		split,
	});
})()`;

/**
 * How much of an element is painted inside the viewport, as JSON.
 *
 * Whether it is painted at all is geometry rather than hit testing: in hex-web the header's
 * logo paints over the misplaced skip link, so `elementFromPoint` answers "the header" for
 * exactly the defect this is for. Hit testing only answers the second question, whether a
 * link that is shown is on top of the content.
 * `document.getAnimations()` is finished first so a transition cannot leave the box
 * mid-flight when it is measured.
 */
const VISIBLE = `((element) => {
	document.getAnimations().forEach((animation) => animation.finish());
	const box = element.getBoundingClientRect();
	const width = document.documentElement.clientWidth;
	const across = Math.min(box.right, width) - Math.max(box.left, 0);
	const down = Math.min(box.bottom, innerHeight) - Math.max(box.top, 0);
	const centre = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
	return JSON.stringify({
		w: Math.max(0, Math.round(across)),
		h: Math.max(0, Math.round(down)),
		clip: getComputedStyle(element).clipPath,
		top: centre === element,
	});
})`;

/**
 * The distance from the shell's content to each edge of the viewport, as JSON.
 *
 * Every disclosure is opened first. On a phone the tree and outline lists are hidden while
 * their disclosure is closed, and a hidden element's box is all zeros, which would hand the
 * probe a link at the very edge of the screen, or one exactly at the floor, whatever the
 * stylesheet did.
 */
const EDGES = `(() => {
	for (const details of document.querySelectorAll('details')) details.open = true;
	const width = document.documentElement.clientWidth;
	const boxes = ['.hx-search-trigger', '.hx-tree-link', '.hx-title', '.hx-article p', '.hx-toc-link']
		.map((selector) => document.querySelector(selector).getBoundingClientRect());
	return JSON.stringify({
		start: Math.round(Math.min(...boxes.map((box) => box.left))),
		end: Math.round(Math.min(...boxes.map((box) => width - box.right))),
		overflow: document.documentElement.scrollWidth > width,
	});
})()`;

/**
 * Every property a host base layer resets that the docs depend on, as JSON. The same
 * page is measured bare and under `HOST_BASE`, and any difference is a property the
 * stylesheet left to the host.
 */
const BASE_STYLES = `(() => {
	document.querySelector('dialog.hx-search').showModal();
	const style = (selector) => getComputedStyle(document.querySelector(selector));
	return JSON.stringify({
		'page title weight': style('.hx-title').fontWeight,
		'page title colour': style('.hx-title').color,
		'heading weight': style('.hx-heading').fontWeight,
		'heading colour': style('.hx-heading').color,
		'prose link underline': style('.hx-prose p a').textDecorationLine,
		'banner link colour': style('.hx-banner a').color,
		'banner link underline': style('.hx-banner a').textDecorationLine,
		'breadcrumb link colour': style('.hx-breadcrumb a').color,
		'breadcrumb link underline': style('.hx-breadcrumb a').textDecorationLine,
		'edit link colour': style('.hx-meta a').color,
		'edit link underline': style('.hx-meta a').textDecorationLine,
		'skip link underline': style('.hx-skip').textDecorationLine,
		'bullet': style('.hx-prose > ul.hx-list > li').listStyleType,
		'nested bullet': style('.hx-prose li ul.hx-list > li').listStyleType,
		'number': style('.hx-prose > ol.hx-list > li').listStyleType,
		'blockquote end margin': style('.hx-prose > blockquote').marginBlockEnd,
		'figure end margin': style('.hx-figure').marginBlockEnd,
		'fence font': style('.hx-pre').fontFamily,
		'fence code font': style('.hx-pre code').fontFamily,
		'search dialog inline margin': style('dialog.hx-search').marginInlineStart,
	});
})()`;

/** The search dialog, closed, as it sits in the tree's landmark beside the trigger. */
const DIALOG =
	'<dialog class="hx-search" aria-label="Search the documentation"><div class="hx-search-bar"><input class="hx-search-input" type="search"/><button type="button" class="hx-search-close">Close search</button></div></dialog>';

const BASE_PAGE = hosted(
	shell({
		tree: DIALOG,
		head: '<nav id="hx-breadcrumb" class="hx-breadcrumb" aria-label="Breadcrumb"><ol><li><a href="/fixture-app/docs">Overview</a></li></ol></nav><aside class="hx-banner" data-banner="stale"><p>This translation is older than the English page.</p><a href="/fixture-app/docs/guide/first-tag">Read this page in English</a></aside>',
		prose:
			'<h2 id="before" class="hx-heading">Before you start</h2><p>The <a href="/fixture-app/docs/reference/chip-support">chip support matrix</a> lists every chip.</p><ul class="hx-list hx-tight"><li><p>text records</p><ul class="hx-list hx-tight"><li><p>with the language code the tag declares</p></li></ul></li></ul><ol class="hx-list hx-tight"><li><p>Create the package.</p></li></ol><blockquote><p>Hold the tag still.</p></blockquote>' +
			FRAGMENTS.figure +
			'<div class="hx-fence" data-lang="swift"><pre class="hx-pre" dir="ltr" tabindex="0" role="group" aria-label="Swift code block"><code><span class="hx-line"><span class="hx-s-keyword">let</span> session</span></code></pre></div>',
	}).replace(
		'<h1 id="hx-title" class="hx-title">Scan your first tag</h1>',
		'<h1 id="hx-title" class="hx-title">Scan your first tag</h1><p class="hx-meta"><span>4 min read</span><a class="hx-edit" href="https://github.com/hexpro-dev/fixture-app">Edit this page</a></p>',
	),
);

/**
 * Every declaration in a stylesheet, with the selector text of the rule it sits in.
 *
 * A character walker over the text rather than the CSSOM, and that is the whole point of it.
 * The browser's own parser drops a declaration it cannot read before anything can ask about
 * it, so a stylesheet read back through `cssRules` has already lost exactly the declarations
 * the `declarations` probe exists to find. `linear-gradient(to inline-end, ...)` was one: no
 * engine has a logical gradient direction, Chrome discarded the line, and every partial
 * status mark painted as an empty ring for as long as nothing asked.
 *
 * It runs twice, in node where `test/paint.test.ts` holds it to a table of awkward inputs,
 * and in the page, where the probe calls it through its source text. So it must reference
 * nothing outside its own body, and the suite's coverage has to stay on v8: an instrumenting
 * provider rewrites the source that `String(fn)` returns, and the in-page copy would then
 * throw on a counter it cannot see.
 *
 * @param {string} css
 * @returns {{ selector: string, property: string, value: string }[]}
 */
export function declarationsOf(css) {
	/** @type {{ selector: string, property: string, value: string }[]} */
	const found = [];
	/** @type {string[]} */
	const preludes = [];
	let buffer = '';
	let depth = 0;
	for (let index = 0; index < css.length; index += 1) {
		const char = css[index];
		if (char === '/' && css[index + 1] === '*') {
			const end = css.indexOf('*/', index + 2);
			index = end === -1 ? css.length : end + 1;
			continue;
		}
		if (char === '"' || char === "'") {
			let end = index + 1;
			while (end < css.length && css[end] !== char) end += css[end] === '\\' ? 2 : 1;
			buffer += css.slice(index, end + 1);
			index = end;
			continue;
		}
		if (char === '(') depth += 1;
		if (char === ')') depth -= 1;
		if (depth === 0 && char === '{') {
			preludes.push(buffer.trim().replace(/\s+/g, ' '));
			buffer = '';
			continue;
		}
		if (depth === 0 && (char === ';' || char === '}')) {
			const text = buffer.trim();
			const colon = text.indexOf(':');
			if (colon > 0 && preludes.length > 0) {
				found.push({
					selector: preludes[preludes.length - 1],
					property: text.slice(0, colon).trim().toLowerCase(),
					// `!important` is not part of the value `CSS.supports` validates, and left on it
					// every declaration in the reduced-motion block reads as invalid.
					value: text
						.slice(colon + 1)
						.trim()
						.replace(/\s*!\s*important$/i, ''),
				});
			}
			buffer = '';
			if (char === '}') preludes.pop();
			continue;
		}
		buffer += char;
	}
	return found;
}

/**
 * A value with every `var(--name, fallback)` and `env(name, fallback)` replaced by its
 * fallback, or `undefined` when a reference in it has none.
 *
 * `CSS.supports` answers true for any value containing a `var()` or an `env()`, because such a
 * value is only checked once the reference is substituted, so a declaration passed through
 * unchanged is valid by definition and the probe would check nothing in a stylesheet where
 * every value is a token chain. Measured for `env()` in Chrome 153: `max(4px
 * env(safe-area-inset-bottom, 0px))`, with its comma missing, is supported and computes 0px.
 * Every chain the theme contract generates ends in a literal, which is what makes the fallback
 * the value a page with no overrides actually paints. An `env()` fallback is what a browser that
 * defines no such variable paints; Chrome defines the safe-area insets, so there the substituted
 * value holds the whole declaration to the grammar rather than to what the probe page painted. A
 * reference with no fallback has nothing to substitute and is skipped, and the probe counts the
 * skips so a substitution that returned `undefined` for everything cannot pass.
 *
 * Self-contained for the same reason as `declarationsOf`: the page runs its source text.
 *
 * @param {string} value
 * @returns {string | undefined}
 */
export function withFallbacks(value) {
	let result = '';
	let index = 0;
	for (;;) {
		// Both names are three letters and a parenthesis, so everything after this reads either.
		const nextVar = value.indexOf('var(', index);
		const nextEnv = value.indexOf('env(', index);
		const start = nextEnv === -1 || (nextVar !== -1 && nextVar < nextEnv) ? nextVar : nextEnv;
		if (start === -1) return result + value.slice(index);
		if (start > 0 && /[\w-]/.test(value[start - 1] ?? '')) {
			result += value.slice(index, start + 4);
			index = start + 4;
			continue;
		}
		result += value.slice(index, start);
		let depth = 0;
		let comma = -1;
		let end = start + 3;
		for (; end < value.length; end += 1) {
			if (value[end] === '(') depth += 1;
			else if (value[end] === ')') {
				depth -= 1;
				if (depth === 0) break;
			} else if (value[end] === ',' && depth === 1 && comma === -1) comma = end;
		}
		if (comma === -1) return undefined;
		const fallback = withFallbacks(value.slice(comma + 1, end).trim());
		if (fallback === undefined) return undefined;
		result += fallback;
		index = end + 1;
	}
}

/**
 * How many declarations a stylesheet terminates, counted without the parser.
 *
 * A semicolon outside a comment, a string and a pair of parentheses ends a declaration, and
 * the generator ends every declaration with one. So a parser that returns fewer declarations
 * than this has missed some, and the ones it missed were never validated: a walker that did
 * not descend into `@media` would otherwise pass while ignoring the reduced-motion block.
 * Deliberately a different mechanism from `declarationsOf`, because two copies of one
 * mistake agree with each other.
 *
 * @param {string} css
 * @returns {number}
 */
export function terminatorsOf(css) {
	let text = css
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '');
	let previous = '';
	while (previous !== text) {
		previous = text;
		text = text.replace(/\([^()]*\)/g, '');
	}
	return (text.match(/;/g) ?? []).length;
}

/**
 * Validates every declaration in the page's stylesheet with the browser's own grammar.
 *
 * The probe page carries no host stylesheet, so the only `<style>` element is the package's.
 */
const DECLARATIONS = `(() => {
	const declarationsOf = ${declarationsOf};
	const withFallbacks = ${withFallbacks};
	const terminatorsOf = ${terminatorsOf};
	const css = document.querySelector('style').textContent;
	const found = declarationsOf(css);
	const skipped = [];
	const invalid = [];
	for (const declaration of found) {
		const tested = withFallbacks(declaration.value);
		if (tested === undefined) skipped.push(declaration);
		else if (!CSS.supports(declaration.property, tested)) invalid.push({ ...declaration, tested });
	}
	return JSON.stringify({
		terminators: terminatorsOf(css),
		found: found.length,
		validated: found.length - skipped.length,
		skipped,
		invalid,
	});
})()`;

/**
 * The colour painted on each side of a partial status mark and at both edges of a current
 * and a plain link, as JSON, with the points the harness reads back from a screenshot.
 *
 * Pixels rather than computed styles, because what is being asked is where the paint lands.
 * A computed `box-shadow` or `background-image` would need parsing in the one serialisation
 * Chrome happens to use today, and would fail a correct fix that drew the bar another way,
 * with a pseudo-element or a logical border. The mark's `background-image` is read as well,
 * because `none` names the defect more precisely than two unfilled pixels do.
 *
 * The mark is sampled at 35% and 65% of its width, which on a 12px mark with a 2px ring is
 * inside the ring and clear of the hard stop in the middle. Each link is sampled at its
 * vertical middle, one pixel inside each edge, where the 2px bar is fully painted whatever
 * the subpixel position of the box, and where the padding keeps the text away. The plain
 * link beside it is the reference, so nothing here has to know what colour the ground is.
 */
const SIDES = `(() => {
	const middle = (box) => Math.floor(box.top + box.height / 2);
	const across = (element, fraction) => {
		const box = element.getBoundingClientRect();
		return [Math.floor(box.left + box.width * fraction), middle(box)];
	};
	const edges = (name, element) => {
		const box = element.getBoundingClientRect();
		return {
			[name + ' left']: [Math.ceil(box.left), middle(box)],
			[name + ' right']: [Math.floor(box.right) - 1, middle(box)],
		};
	};
	const mark = document.querySelector('.hx-status-half');
	const [treeCurrent, treePlain] = document.querySelectorAll('.hx-tree-link');
	const [tocCurrent, tocPlain] = document.querySelectorAll('.hx-toc-link');
	return JSON.stringify({
		background: getComputedStyle(mark).backgroundImage,
		fill: getComputedStyle(mark).color,
		samples: {
			'mark left': across(mark, 0.35),
			'mark right': across(mark, 0.65),
			...edges('tree current', treeCurrent),
			...edges('tree plain', treePlain),
			...edges('toc current', tocCurrent),
			...edges('toc plain', tocPlain),
		},
	});
})()`;

/**
 * Which half of a partial status mark each `sides-*` probe expects filled, and which edge of
 * a current link it expects the bar on.
 *
 * The fallback probe states no bar, deliberately. Its tree and table of contents are in the
 * interface direction, which is the Arabic probe's, so a bar expectation there would fail
 * together with that probe's for every bar defect, and the two would never say anything apart.
 */
const SIDE_EXPECTATIONS = {
	'sides-rtl': { mark: 'right', bar: 'right' },
	'sides-fallback': { mark: 'left', bar: undefined },
	'sides-ltr': { mark: 'left', bar: 'left' },
};

/**
 * `--color-accent` stands in for a consuming site's own token, and `.themed` for one of
 * its per-app classes. The package's accent token has no host link, so what is being
 * checked is the `--hx-*` override, which is the documented way a consumer themes this.
 *
 * @param {string} className
 */
const link = (className) =>
	`<div class="hx-root ${className}"><div class="hx-prose"><p><a id="t" href="#x">x</a></p></div></div>`;

/**
 * Where each summary's chevron is drawn, as JSON with the points the harness reads back from a
 * screenshot, whether there is a chevron to read at all, and whether the page is under a forced
 * palette.
 *
 * The chevron is the summary's last flex item, drawn one gap after everything before it, and
 * centred on the cross axis. A range over the summary's contents covers what comes before it and
 * not the pseudo-element. It is sampled down its middle, where its point crosses whichever way it
 * is turned, beside a point of ground just before it.
 *
 * `drawn` is what lets a missing chevron say so. A pseudo-element with no `content`, or a summary
 * that is not displayed, leaves ground at every point, which reads exactly like a chevron painted
 * in the ground's colour and would blame the palette for a box that was never there.
 *
 * `forced` reads the palette itself rather than the media query: an inline colour a forced palette
 * replaces, which only a page whose colours really were forced reports as something else. A
 * browser whose emulation matched the media query and forced nothing would pass a query check.
 */
const CHEVRONS = `(() => {
	const points = (name, summary) => {
		const range = document.createRange();
		range.selectNodeContents(summary);
		const before = range.getBoundingClientRect();
		const box = summary.getBoundingClientRect();
		const chevron = getComputedStyle(summary, '::after');
		const width = parseFloat(chevron.width);
		const height = parseFloat(chevron.height);
		const left = before.right + parseFloat(getComputedStyle(summary).columnGap);
		const top = box.top + (box.height - height) / 2;
		drawn[name] = box.height > 0 && chevron.content !== 'none' && chevron.display !== 'none';
		return {
			[name + ' ground']: [Math.floor(left - 4), Math.floor(top + height / 2)],
			[name + ' chevron 1']: [Math.floor(left + width / 2), Math.floor(top + height * 0.1875)],
			[name + ' chevron 2']: [Math.floor(left + width / 2), Math.floor(top + height * 0.3125)],
			[name + ' chevron 3']: [Math.floor(left + width / 2), Math.floor(top + height * 0.6875)],
			[name + ' chevron 4']: [Math.floor(left + width / 2), Math.floor(top + height * 0.8125)],
		};
	};
	const drawn = {};
	const marker = document.createElement('span');
	marker.style.color = 'rgb(1, 2, 3)';
	document.body.append(marker);
	const forced = getComputedStyle(marker).color !== 'rgb(1, 2, 3)';
	marker.remove();
	const samples = {
		...points('tree', document.querySelector('.hx-tree-summary')),
		...points('toc', document.querySelector('.hx-toc-summary')),
	};
	return JSON.stringify({ forced, drawn, samples });
})()`;

/**
 * Exported so `test/paint.test.ts` can hold every class a probe selects on against a
 * rendered page, and pin the count.
 *
 * @type {Probe[]}
 */
export const PROBES = [
	{
		id: 'baseline',
		body: link(''),
		expression: `getComputedStyle(document.getElementById('t')).color`,
		why: 'An unthemed page paints the package literal.',
	},
	{
		id: 'ancestor',
		body: `<div style="--hx-accent-link:#ff6600">${link('')}</div>`,
		expression: `getComputedStyle(document.getElementById('t')).color`,
		why: 'A token rebound above the docs root reaches the link. This is the case the contract prescribes.',
	},
	{
		id: 'root',
		body: link('').replace('class="hx-root "', 'class="hx-root" style="--hx-accent-link:#ff6600"'),
		expression: `getComputedStyle(document.getElementById('t')).color`,
		why: 'A token rebound on the docs root itself reaches the link.',
	},
	{
		id: 'descendant',
		body: `<div class="hx-root"><div class="hx-prose" style="--hx-accent-link:#ff6600"><p><a id="t" href="#x">x</a></p></div></div>`,
		expression: `getComputedStyle(document.getElementById('t')).color`,
		why: 'A token rebound BELOW the docs root reaches the link. This is the case an alias declared on the root would fail, and the reason this row exists.',
	},
	{
		id: 'code-scope',
		body: `<div class="hx-root"><pre class="hx-pre"><code><span class="hx-s-keyword" id="t">let</span></code></pre></div>`,
		expression: `getComputedStyle(document.getElementById('t')).color`,
		why: 'A highlight scope is painted from the palette rather than inheriting the body colour.',
	},
	{
		id: 'code-scope-override',
		body: `<div class="hx-root"><pre class="hx-pre" style="--hx-code-key:#ff6600"><code><span class="hx-s-keyword" id="t">let</span></code></pre></div>`,
		expression: `getComputedStyle(document.getElementById('t')).color`,
		why: 'A palette colour is overridable the same way a theme token is, which is what makes the two tables one contract.',
	},
	{
		id: 'sr-only',
		body: `<div class="hx-root"><span class="hx-sr" id="t">hidden</span></div>`,
		expression: `JSON.stringify([getComputedStyle(document.getElementById('t')).position, document.getElementById('t').getBoundingClientRect().width < 2])`,
		why: 'The visually hidden helper is clipped rather than removed, so assistive technology still reads it.',
	},
	{
		id: 'skip-unfocused',
		host: HOST_BASE,
		width: PHONE,
		body: hosted(shell({ prose: PARAGRAPH })),
		expression: `(${VISIBLE})(document.querySelector('.hx-skip'))`,
		why: 'Hidden by moving it above the docs root, the link is only off-screen when the root starts at the top of the page. In hex-web the root starts under a sticky header and the link sat on the site logo.',
	},
	{
		id: 'skip-focused',
		host: HOST_BASE,
		width: PHONE,
		body: hosted(shell({ prose: PARAGRAPH })),
		expression: `(() => { const link = document.querySelector('.hx-skip'); link.focus(); return (${VISIBLE})(link); })()`,
		why: 'Once focused, the link is inside the viewport, unclipped and on top of the content, which is the only state in which a keyboard reader can use it.',
	},
	{
		id: 'task-line',
		host: HOST_BASE,
		body: hosted(shell({ prose: FRAGMENTS.taskList })),
		expression: `(() => {
			const marker = document.querySelector('.hx-task');
			const range = document.createRange();
			range.selectNodeContents(marker.nextElementSibling);
			const line = range.getClientRects()[0];
			const box = marker.getBoundingClientRect();
			const tops = [...document.querySelectorAll('.hx-list > li')].map((item) => item.getBoundingClientRect().top);
			return JSON.stringify({
				shared: box.top < line.bottom && box.bottom > line.top,
				plain: Math.round(tops[1] - tops[0]),
				task: Math.round(tops[2] - tops[1]),
			});
		})()`,
		why: 'The marker is an inline box and the paragraph after it is a block, so without a rule the text always starts on the line below the checkbox.',
	},
	{
		id: 'image-display',
		host: HOST_BASE,
		body: hosted(shell({ prose: FRAGMENTS.inlineImage + FRAGMENTS.figure })),
		expression: `(() => {
			const [inline, figure] = document.querySelectorAll('.hx-image');
			const range = document.createRange();
			range.selectNodeContents(inline.previousSibling);
			const rects = range.getClientRects();
			const last = rects[rects.length - 1];
			const box = inline.getBoundingClientRect();
			return JSON.stringify({
				inline: getComputedStyle(inline).display,
				figure: getComputedStyle(figure).display,
				shared: box.top < last.bottom && box.bottom > last.top,
			});
		})()`,
		why: "Tailwind's preflight makes every img a block in @layer base, which splits a sentence around an inline icon unless the stylesheet states the display itself.",
	},
	{
		id: 'gutter-phone',
		host: HOST_BASE,
		width: PHONE,
		body: hosted(shell({ prose: PARAGRAPH })),
		expression: EDGES,
		why: 'Inside a full-bleed main at phone width, body text ran to both edges of the screen.',
	},
	{
		id: 'gutter-desktop',
		host: HOST_BASE,
		body: hosted(shell({ prose: PARAGRAPH })),
		expression: EDGES,
		why: 'Inside a full-bleed main on a desktop, the sidebar and the search box sat flush against the edge of the viewport.',
	},
	{
		id: 'gutter-padded-host',
		host: HOST_BASE,
		width: PHONE,
		body: `<main style="max-inline-size: 80rem; margin-inline: auto; padding-inline: 1.5rem">${shell({ prose: PARAGRAPH })}</main>`,
		expression: EDGES,
		why: 'A host that already pads its container still gets a page that fits. A gutter written as a negative margin or a viewport width is right in a full-bleed main and scrolls sideways in this one.',
	},
	{
		id: 'phone-reading',
		host: HOST_BASE,
		width: PHONE,
		body: hosted(shell({ prose: PARAGRAPH, links: 20, mark: 14 })),
		expression: `(() => {
			const list = document.querySelector('.hx-tree-list');
			const closed = {
				list: list.getBoundingClientRect().height,
				paragraph: Math.round(document.querySelector('.hx-article p').getBoundingClientRect().top),
				rootGap: document.querySelector('.hx-root').getBoundingClientRect().top - document.querySelector('header').getBoundingClientRect().bottom,
			};
			document.querySelector('.hx-tree-disclosure').open = true;
			const panel = list.getBoundingClientRect();
			list.scrollTop = list.scrollHeight;
			const rows = list.querySelectorAll('.hx-tree-link');
			const current = list.querySelector('[aria-current]');
			return JSON.stringify({
				...closed,
				viewport: innerHeight,
				panelHeight: Math.round(panel.height),
				panelBottom: list.getBoundingClientRect().bottom,
				lastBottom: rows[rows.length - 1].getBoundingClientRect().bottom,
				offsetParent: current.offsetParent === list ? 'the panel' : String(current.offsetParent?.className),
			});
		})()`,
		why: 'On a phone the page tree sits above the article behind a closed Pages disclosure, so a reader arriving on a page reads it on the first screen, and the docs ground starts right under the host header. Opened, a long tree is a panel no taller than 60% of the screen that scrolls to its last row, and the panel is what its rows are measured from, which is how opening it scrolls to the current page.',
	},
	{
		id: 'phone-foot',
		host: HOST_BASE,
		width: PHONE,
		body: hosted(shell({ prose: PARAGRAPH.repeat(40), tocLinks: 25 })),
		expression: `(() => {
			const foot = document.querySelector('.hx-foot');
			const label = document.querySelector('.hx-toc-summary-label');
			const here = document.querySelector('.hx-toc-here');
			const link = document.querySelector('.hx-foot-pages');
			const scrollable = document.documentElement.scrollHeight > innerHeight;
			const bottom = foot.getBoundingClientRect().bottom;
			const rest = getComputedStyle(label).fontSize;
			const restHeight = foot.getBoundingClientRect().height;
			const wide = document.documentElement.scrollWidth;
			here.textContent = ${JSON.stringify(LONG_HEADING)};
			const named = getComputedStyle(label).fontSize;
			const namedHeight = foot.getBoundingClientRect().height;
			const overflow = getComputedStyle(here).textOverflow;
			const heading = here.getBoundingClientRect();
			const target = link.getBoundingClientRect();
			const rtl = getComputedStyle(foot).direction === 'rtl';
			const rings = [document.querySelector('.hx-toc-summary'), link]
				.filter((element) => element.getBoundingClientRect().height > 0)
				.map((element) => {
					element.focus();
					// A live declaration, so every value is read before the blur takes the ring away.
					const style = getComputedStyle(element);
					const ring = {
						name: element.className,
						drawn: style.outlineStyle !== 'none',
						reach: element.getBoundingClientRect().bottom + parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth),
					};
					element.blur();
					return ring;
				});
			document.querySelector('.hx-toc-disclosure').open = true;
			const list = document.querySelector('.hx-toc-list');
			const panel = list.getBoundingClientRect();
			const bar = foot.getBoundingClientRect();
			list.scrollTop = list.scrollHeight;
			const rows = list.querySelectorAll('.hx-toc-link');
			return JSON.stringify({
				scrollable,
				bottom: Math.round(bottom),
				viewport: innerHeight,
				rest,
				named,
				restHeight,
				namedHeight,
				clash: target.width === 0 ? 0 : Math.round(rtl ? target.right - heading.left : heading.right - target.left),
				spill: document.documentElement.scrollWidth - wide,
				overflow,
				rings,
				footGround: getComputedStyle(foot).backgroundColor,
				panelGround: getComputedStyle(list).backgroundColor,
				panelBottom: panel.bottom,
				footTop: bar.top,
				rule: parseFloat(getComputedStyle(foot).borderTopWidth),
				ruleColour: getComputedStyle(foot).borderTopColor,
				end: parseFloat(getComputedStyle(list).borderBottomWidth),
				endColour: getComputedStyle(list).borderBottomColor,
				panelInline: [panel.left, panel.right],
				barInline: [bar.left, bar.right],
				panelHeight: Math.round(panel.height),
				lastBottom: rows[rows.length - 1].getBoundingClientRect().bottom,
			});
		})()`,
		why: "On a phone the table of contents is a bar with its own ground, stuck to the bottom of the viewport, under the thumb, on a page long enough to scroll. At rest its label is the control, at the size of the link beside it; once a heading is named the label becomes a caption above one line of heading that ellipsises beside the link, the bar keeps its height, and a focus ring on either control stays on screen. The outline opens above the bar across the bar's whole width, on a ground of its own, with its last row of pixels on the bar's rule and a border there in the rule's colour, so no row of the article shows between them at any device pixel ratio, and a long one scrolls inside a panel no taller than 60% of the screen.",
	},
	{
		id: 'phone-targets',
		host: HOST_BASE,
		width: PHONE,
		body: hosted(shell({ prose: PARAGRAPH })),
		expression: `(() => {
			for (const details of document.querySelectorAll('details')) details.open = true;
			const box = (selector) => document.querySelector(selector).getBoundingClientRect();
			const height = (selector) => Math.round(box(selector).height);
			const pages = box('.hx-foot-pages');
			const reading = {
				heights: Object.fromEntries(
					['.hx-search-trigger', '.hx-tree-summary', '.hx-toc-summary', '.hx-foot-pages', '.hx-tree-link', '.hx-toc-link'].map((selector) => [selector, height(selector)]),
				),
				end: Math.round(document.documentElement.clientWidth - pages.right),
				summary: getComputedStyle(document.querySelector('.hx-tree-summary')).display,
				row: box('.hx-tree-summary').top - box('.hx-search-trigger').top,
				under: box('.hx-tree-list').top - box('.hx-tree-summary').bottom,
			};
			document.getElementById('hx-toc').remove();
			const alone = box('.hx-foot-pages');
			return JSON.stringify({ ...reading, alone: { height: Math.round(alone.height), shift: alone.right - pages.right } });
		})()`,
		why: 'Every control and row on a phone is at least 44px tall, the Pages chip sits beside Search with the open tree under both, and the bar pads its Pages link in from the edge of the screen though its ground runs edge to edge. On a page with no outline the link is still 44px tall and ends where it ends on every other page. The Pages chip has to state its own display at phone width, because otherwise the rule that hides it on a desktop hides it here too.',
	},
	{
		id: 'phone-bare',
		width: PHONE,
		body: hosted(shell({ prose: PARAGRAPH })),
		expression: `JSON.stringify({
			colour: getComputedStyle(document.querySelector('.hx-foot-pages')).color,
			ink: getComputedStyle(document.querySelector('.hx-root')).color,
			decoration: getComputedStyle(document.querySelector('.hx-foot-pages')).textDecorationLine,
		})`,
		why: "With no host stylesheet at all, the bar's Pages link is the docs root's ink with no underline. Only the phone block states either, so the desktop comparison of a bare page with a hosted one never sees the link, and a host whose base layer sets links to inherit hides the browser's own blue.",
	},
	{
		id: 'phone-search',
		host: HOST_BASE,
		width: PHONE,
		body: hosted(shell({ prose: PARAGRAPH, tree: DIALOG })),
		expression: `(() => {
			const dialog = document.querySelector('dialog.hx-search');
			dialog.showModal();
			const box = dialog.getBoundingClientRect();
			return JSON.stringify({ start: box.left, end: document.documentElement.clientWidth - box.right, top: box.top });
		})()`,
		why: "On a phone the search dialog is anchored to the top of the screen, so its input stays above the keyboard and does not move as results arrive, and it is as wide as the column, 16px from each edge at 390px where the shell's inset sits at its floor. The browser's own rule for a modal dialog caps its width below that, and the rule that centres it on a desktop wins if the phone block comes before it.",
	},
	{
		id: 'phone-token',
		host: HOST_BASE,
		width: PHONE,
		body: TOKEN_PAGE(),
		expression: SPILL,
		why: "A symbol name has no space in it, so a long one is one unbreakable word and a phone's column is narrower than it. Both consumers set overflow-x: hidden on the body, so the tail is clipped with nothing to scroll to and the characters cannot be read at all. Inline code may break inside the word; the prose around it may not, the fence keeps its own sideways scroller, and the table stays wide inside the scroller that is there for it.",
	},
	{
		id: 'phone-token-rtl',
		host: HOST_BASE,
		width: PHONE,
		body: TOKEN_PAGE('rtl', ' lang="en" dir="ltr"'),
		expression: SPILL,
		why: "The same page at the Arabic address, where the interface is right to left and the article is the English fallback. This is the case scrollWidth cannot see: the overflow runs off the leading edge, which a root's scrollable region does not extend to, so the page measures exactly the width of the screen while the identifier's box ends past it.",
	},
	{
		id: 'phone-token-narrow',
		host: HOST_BASE,
		width: NARROW,
		body: TOKEN_PAGE(),
		expression: SPILL,
		why: 'The same page on the narrowest phone still in use, where the column is 30px tighter. A fix that reached only as far as the wider phone would leave this one clipped.',
	},
	{
		id: 'phone-tablet',
		host: HOST_BASE,
		width: TABLET,
		body: hosted(
			shell({ prose: PARAGRAPH, dir: 'rtl', pages: '\u0627\u0644\u0635\u0641\u062d\u0627\u062a' }),
		),
		expression: `(() => {
			const box = (selector) => document.querySelector(selector).getBoundingClientRect();
			const trigger = box('.hx-search-trigger');
			const chip = box('.hx-tree-summary');
			const link = box('.hx-foot-pages');
			const column = box('.hx-article');
			const foot = box('.hx-foot');
			// The label's text rather than the summary's box: padding at the summary's start
			// moves the words inside the column and leaves the box where it was.
			const label = document.createRange();
			label.selectNodeContents(document.querySelector('.hx-toc-summary-label'));
			return JSON.stringify({
				column: [column.left, column.right],
				row: [Math.min(trigger.left, chip.left), Math.max(trigger.right, chip.right)],
				bar: [link.left, label.getBoundingClientRect().right],
				foot: [foot.left, foot.right],
				width: document.documentElement.clientWidth,
				link: link.width,
				minimum: parseFloat(getComputedStyle(document.querySelector('.hx-foot-pages')).minInlineSize),
			});
		})()`,
		why: "At 768px the phone layout centres the column at its measure. The search and Pages row lines up with it, and the bar's ground runs edge to edge while its label starts where the column starts and its Pages link ends where the column ends. In Arabic the word for Pages is wider than the link's minimum, which is where a bar laid out around that minimum sat 10px outside the column at both ends.",
	},
	{
		id: 'phone-chevrons',
		host: HOST_BASE,
		width: PHONE,
		sample: true,
		body: hosted(shell({ prose: PARAGRAPH })),
		expression: CHEVRONS,
		why: "The chevron on the Pages chip and on the bar is the only sign either disclosure is open or closed, and it points where the panel appears: down for the closed tree, up for the closed outline. It is a box clipped to a V and painted in the dim token, so down its middle a closed tree's chevron is ground and then paint, and a closed outline's is paint and then ground.",
	},
	{
		id: 'phone-forced',
		host: HOST_BASE,
		width: PHONE,
		sample: true,
		media: [{ name: 'forced-colors', value: 'active' }],
		body: hosted(shell({ prose: PARAGRAPH })),
		expression: CHEVRONS,
		why: "The chevron on the Pages chip and on the bar is the only sign either disclosure is open or closed. Under a forced colour palette its token background is repainted as the ground's own colour unless the stylesheet paints it in the palette's text colour. The chevron is sampled down its middle, where its point crosses whichever way it is turned, beside a point of ground just before it.",
	},
	{
		id: 'base-bare',
		body: BASE_PAGE,
		expression: BASE_STYLES,
		why: 'The reference: the same page with no host stylesheet at all.',
	},
	{
		id: 'base-hosted',
		host: HOST_BASE,
		body: BASE_PAGE,
		expression: BASE_STYLES,
		why: 'The same page under a host base layer, which must measure the same.',
	},
	{
		id: 'declarations',
		body: '',
		expression: DECLARATIONS,
		why: 'A declaration the browser cannot parse is dropped without a word and the rule paints as if the line were never written. Every probe above measures a property somebody thought to measure, and this one asks about every declaration in the file.',
	},
	{
		id: 'sides-rtl',
		sample: true,
		body: shell({ prose: FRAGMENTS.status, dir: 'rtl', current: true }),
		expression: SIDES,
		why: 'In Arabic the inline-start half of a partial mark, the filled one, is its right half, and the inline-start edge of a current link, where the bar goes, is its right edge.',
	},
	{
		id: 'sides-fallback',
		sample: true,
		body: shell({
			prose: FRAGMENTS.status,
			dir: 'rtl',
			article: ' lang="en" dir="ltr"',
			current: true,
		}),
		expression: SIDES,
		why: 'An Arabic page serving the English fallback carries dir="ltr" on its article, so a mark inside it reads left to right. A mirror keyed on the docs root rather than on the element itself fills the wrong half here and nowhere else.',
	},
	{
		id: 'sides-ltr',
		sample: true,
		body: shell({ prose: FRAGMENTS.status, current: true }),
		expression: SIDES,
		why: 'The control for the Arabic probe. A stylesheet that put the fill or the bar on one side in both directions passes whichever of the two probes that side happens to suit, and fails the other.',
	},
];

const ORANGE = 'rgb(255, 102, 0)';

/**
 * The colour of a one-pixel PNG, as `[red, green, blue]`.
 *
 * No image library, because there is nothing here one would be for. A PNG is a signature and
 * a run of chunks, the pixel data is one zlib stream across the IDAT chunks, and a one-pixel
 * image inflates to one filter byte and one pixel. Every PNG filter predicts from the pixel to
 * the left and the row above, both of which are zero for the only pixel of the only row, so
 * the stored bytes are the pixel whichever filter the encoder chose. Anything other than an
 * 8-bit RGB or RGBA image of exactly one pixel is refused rather than read wrongly.
 *
 * @param {string} base64
 * @returns {number[]}
 */
export function pixelOf(base64) {
	const png = Buffer.from(base64, 'base64');
	/** @type {Buffer | undefined} */
	let header;
	/** @type {Buffer[]} */
	const data = [];
	for (let offset = 8; offset + 8 <= png.length;) {
		const length = png.readUInt32BE(offset);
		const type = png.toString('latin1', offset + 4, offset + 8);
		const body = png.subarray(offset + 8, offset + 8 + length);
		if (type === 'IHDR') header = body;
		if (type === 'IDAT') data.push(body);
		offset += 12 + length;
	}
	if (
		header === undefined ||
		header.readUInt32BE(0) !== 1 ||
		header.readUInt32BE(4) !== 1 ||
		header[8] !== 8 ||
		(header[9] !== 2 && header[9] !== 6)
	) {
		throw new Error('Expected a one-pixel 8-bit RGB or RGBA PNG from the screenshot.');
	}
	const raw = inflateSync(Buffer.concat(data));
	return [raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 0];
}

/**
 * @param {string} binary
 * @param {Probe[]} probes
 * @param {string} root  Where to read the stylesheet from, so the failure path can be
 *   driven against a deliberately broken one the way the other guards are.
 * @returns {Promise<Record<string, string>>}
 */
async function measure(binary, probes, root) {
	const css = readFileSync(join(root, 'src', 'render', 'docs.css'), 'utf8');
	const profile = mkdtempSync(join(tmpdir(), 'hexdocs-chrome-'));
	const child = spawn(
		binary,
		[
			'--headless=new',
			'--remote-debugging-port=0',
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-gpu',
			'--disable-dev-shm-usage',
			'--no-sandbox',
			`--user-data-dir=${profile}`,
			'about:blank',
		],
		{ stdio: ['ignore', 'ignore', 'pipe'] },
	);

	/** @type {Record<string, string>} */
	const measured = {};
	try {
		const url = await new Promise((res, rej) => {
			let buffer = '';
			const timer = setTimeout(() => rej(new Error('no devtools endpoint after 30s')), 30_000);
			child.on('exit', (code) => {
				clearTimeout(timer);
				rej(new Error(`browser exited ${code}: ${buffer.slice(-300)}`));
			});
			child.stderr.on('data', (chunk) => {
				buffer += chunk;
				const found = /ws:\/\/\S+/.exec(buffer);
				if (found !== null) {
					clearTimeout(timer);
					res(found[0]);
				}
			});
		});

		const socket = new WebSocket(url);
		await new Promise((res, rej) => {
			socket.addEventListener('open', res, { once: true });
			socket.addEventListener('error', () => rej(new Error('devtools socket refused')), {
				once: true,
			});
		});

		let id = 0;
		/** @type {Map<number, (value: any) => void>} */
		const pending = new Map();
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data));
			const resolve_ = pending.get(message.id);
			if (resolve_ !== undefined) {
				pending.delete(message.id);
				resolve_(message);
			}
		});
		/**
		 * @param {string} method
		 * @param {object} [params]
		 * @param {string} [session]
		 */
		const send = (method, params = {}, session) =>
			new Promise((res, rej) => {
				const next = (id += 1);
				const timer = setTimeout(() => {
					pending.delete(next);
					rej(new Error(`${method} timed out`));
				}, 20_000);
				pending.set(next, (message) => {
					clearTimeout(timer);
					if (message.error !== undefined) rej(new Error(`${method}: ${message.error.message}`));
					else res(message.result);
				});
				socket.send(
					JSON.stringify({ id: next, method, params, ...(session ? { sessionId: session } : {}) }),
				);
			});

		const target = /** @type {any} */ (await send('Target.createTarget', { url: 'about:blank' }));
		const attached = /** @type {any} */ (
			await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
		);
		const session = attached.sessionId;
		await send('Page.enable', {}, session);
		const tree = /** @type {any} */ (await send('Page.getFrameTree', {}, session));
		const frameId = tree.frameTree.frame.id;
		// `:focus` only matches in a page that counts as focused, and a headless page is not
		// guaranteed to. Measured on macOS it matches without this. Nobody has measured a Linux
		// runner, and the emulation makes the skip link probe's answer not depend on it.
		await send('Emulation.setFocusEmulationEnabled', { enabled: true }, session);

		let width = 0;
		let media = '[]';
		for (const probe of probes) {
			const features = JSON.stringify(probe.media ?? []);
			if (features !== media) {
				await send('Emulation.setEmulatedMedia', { features: probe.media ?? [] }, session);
				media = features;
			}
			const wanted = probe.width ?? DESKTOP;
			if (wanted !== width) {
				// `mobile: false` on purpose. With it true, a page with no viewport meta tag lays
				// out at 980px and scales down, so a phone-width probe would measure a desktop.
				await send(
					'Emulation.setDeviceMetricsOverride',
					{ width: wanted, height: 900, deviceScaleFactor: 1, mobile: false },
					session,
				);
				width = wanted;
			}
			await send(
				'Page.setDocumentContent',
				{ frameId, html: page(css, probe.body, probe.host) },
				session,
			);
			const evaluated = /** @type {any} */ (
				await send(
					'Runtime.evaluate',
					{ expression: probe.expression, returnByValue: true, awaitPromise: true },
					session,
				)
			);
			if (evaluated.exceptionDetails !== undefined) {
				throw new Error(`${probe.id}: ${evaluated.exceptionDetails.text}`);
			}
			measured[probe.id] = String(evaluated.result.value);
			if (probe.sample === true) {
				const reading = JSON.parse(measured[probe.id]);
				/** @type {Record<string, number[]>} */
				const pixels = {};
				for (const [name, [x, y]] of Object.entries(reading.samples)) {
					// One CSS pixel at a device scale factor of 1, so the image is one pixel. The
					// probe pages are shorter than the viewport and never scroll, which is what
					// lets a viewport point stand for a page point here.
					const shot = /** @type {any} */ (
						await send(
							'Page.captureScreenshot',
							{ format: 'png', clip: { x, y, width: 1, height: 1, scale: 1 } },
							session,
						)
					);
					pixels[name] = pixelOf(shot.data);
				}
				measured[probe.id] = JSON.stringify({ ...reading, pixels });
			}
		}
		socket.close();
	} finally {
		child.kill('SIGKILL');
		try {
			rmSync(profile, { recursive: true, force: true });
		} catch {
			// A profile directory that could not be removed is not a reason to fail a check
			// about colours. The temp directory is the operating system's problem.
		}
	}
	return measured;
}

/**
 * @param {string} [root]
 * @returns {Promise<import('./lib/report.mjs').CheckResult[]>}
 */
export async function run(root = ROOT) {
	const binary = findBrowser();
	if (binary === undefined) {
		const reason =
			'No Chrome or Chromium found. Set HEXDOCS_CHROME to one, or run this where a browser is installed.';
		if (process.env.CI === 'true') {
			// SKIPPED is a deliberate, explained non-run. In CI it is not deliberate: the
			// runner image ships Chrome, so a missing browser there means the environment
			// changed under the check rather than that somebody chose to skip it.
			return [
				check('stylesheet in a browser', 0, 'probes', [
					`${reason} CI runs on an image that ships one, so this is a broken environment rather than a skip.`,
				]),
			];
		}
		return [skipped('stylesheet in a browser', 'probes', reason)];
	}

	/** @type {string[]} */
	const problems = [];
	/** @type {Record<string, string>} */
	let measured = {};
	try {
		measured = await measure(binary, PROBES, root);
	} catch (error) {
		return [
			check('stylesheet in a browser', 0, 'probes', [
				`Could not measure with ${binary}: ${error instanceof Error ? error.message : String(error)}`,
			]),
		];
	}

	const baseline = measured.baseline;
	if (baseline === undefined || !/^rgb/.test(baseline)) {
		problems.push(`The unthemed link colour did not resolve at all: ${String(baseline)}.`);
	}

	for (const id of ['ancestor', 'root', 'descendant']) {
		const probe = PROBES.find((entry) => entry.id === id);
		if (measured[id] !== ORANGE) {
			problems.push(
				`An override on the ${id} did not reach the link: expected ${ORANGE}, got ${String(measured[id])}. ${probe?.why ?? ''}`,
			);
		}
	}

	if (measured['code-scope'] === baseline) {
		problems.push(
			'A highlight scope painted the same colour as an inline link, which means the palette rule is not reaching it.',
		);
	}
	if (measured['code-scope-override'] !== ORANGE) {
		problems.push(
			`Overriding a palette colour did not reach the token span: got ${String(measured['code-scope-override'])}.`,
		);
	}

	const hidden = measured['sr-only'];
	if (hidden !== '["absolute",true]') {
		problems.push(
			`The visually hidden helper measured ${String(hidden)} rather than a clipped absolute box.`,
		);
	}

	problems.push(...layoutProblems(measured));
	problems.push(...declarationProblems(measured.declarations));
	problems.push(...sideProblems(measured));

	let counted = '';
	try {
		const reading = JSON.parse(measured.declarations ?? '');
		counted = `, ${reading.validated} declarations valid, ${reading.skipped.length} skipped for a var() or env() with no fallback`;
	} catch {
		// Already a problem above. The note is what a passing row prints, and this row is not
		// passing.
	}
	return [
		check('stylesheet in a browser', PROBES.length, 'probes', problems, {
			note: `${binary.split('/').pop() ?? binary}${counted}`,
		}),
	];
}

/**
 * What the `declarations` probe measured, as problems. Exported so the two failures a real
 * stylesheet cannot produce, a parser that missed declarations and one that validated none,
 * can be driven without a browser.
 *
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function declarationProblems(raw) {
	/** @type {{ terminators: number, found: number, validated: number, skipped: unknown[], invalid: { selector: string, property: string, value: string, tested: string }[] }} */
	let reading;
	try {
		reading = JSON.parse(raw ?? '');
	} catch {
		return [`The declarations probe returned something that is not a measurement: ${String(raw)}.`];
	}
	/** @type {string[]} */
	const problems = reading.invalid.map(
		(entry) =>
			`A declaration the browser does not accept: \`${entry.selector}\` declares \`${entry.property}: ${entry.value}\`${entry.tested === entry.value ? '' : `, tested as \`${entry.tested}\` with each var() and env() replaced by its fallback`}. It is dropped, so the rule paints as if the line were never written.`,
	);
	if (reading.found < reading.terminators) {
		problems.push(
			`The declaration parser found ${reading.found} declarations in a stylesheet with ${reading.terminators} semicolons outside comments, strings and parentheses, so the ones it missed were never validated.`,
		);
	}
	if (reading.validated === 0) {
		problems.push(
			`The declarations probe validated nothing: ${reading.skipped.length} of ${reading.found} declarations were skipped for a var() or env() with no fallback. A probe that skipped everything has checked nothing.`,
		);
	}
	return problems;
}

/**
 * Whether two sampled pixels are the same paint: no channel differs by more than 24.
 *
 * Measured on macOS, a screenshot of a flat colour comes back exact, and nobody has measured a
 * Linux runner, so the margin is for a capture that turns out to be colour managed. The colours
 * being told apart are at least 145 apart on some channel, the dim chevron on the surface being
 * the closest pair, so it cannot blur one into the other.
 *
 * @param {number[] | undefined} a
 * @param {number[] | undefined} b
 */
const samePaint = (a, b) =>
	a !== undefined &&
	b !== undefined &&
	a.every((channel, index) => Math.abs(channel - (b[index] ?? -999)) <= 24);

/**
 * What the `sides-*` probes measured, as problems: one for the partial mark and one for the
 * current-item bar, per probe, so a defect names the direction it shows up in.
 *
 * @param {Record<string, string>} measured
 * @returns {string[]}
 */
export function sideProblems(measured) {
	/** @type {string[]} */
	const problems = [];
	const same = samePaint;
	/** @param {boolean} left @param {boolean} right @param {string} one @param {string} two */
	const which = (left, right, one, two) =>
		left && right
			? `both ${two}`
			: left
				? `the left ${one}`
				: right
					? `the right ${one}`
					: `neither ${one}`;
	for (const [id, wanted] of Object.entries(SIDE_EXPECTATIONS)) {
		const why = PROBES.find((probe) => probe.id === id)?.why ?? '';
		/** @type {{ background: string, fill: string, pixels: Record<string, number[]> }} */
		let reading;
		try {
			reading = JSON.parse(measured[id] ?? '');
		} catch {
			problems.push(
				`The ${id} probe returned something that is not a measurement: ${String(measured[id])}.`,
			);
			continue;
		}
		const pixels = reading.pixels;
		if (reading.background === 'none') {
			problems.push(
				`The partial status mark in the ${id} probe computes background-image none, so it paints as an empty ring, which is the shape of "no". ${why}`,
			);
		} else {
			const fill = (reading.fill.match(/\d+/g) ?? []).slice(0, 3).map(Number);
			const left = same(pixels['mark left'], fill);
			const right = same(pixels['mark right'], fill);
			if (left !== (wanted.mark === 'left') || right !== (wanted.mark === 'right')) {
				problems.push(
					`The partial status mark in the ${id} probe is filled on ${which(left, right, 'half', 'halves')}, where its inline-start half is the ${wanted.mark}. ${why}`,
				);
			}
		}
		if (wanted.bar !== undefined) {
			const wrong = [
				{ name: 'tree', label: 'tree link' },
				{ name: 'toc', label: 'table of contents link' },
			]
				.map(({ name, label }) => {
					const left = !same(pixels[`${name} current left`], pixels[`${name} plain left`]);
					const right = !same(pixels[`${name} current right`], pixels[`${name} plain right`]);
					return { label, left, right };
				})
				.filter(
					(entry) =>
						entry.left !== (wanted.bar === 'left') || entry.right !== (wanted.bar === 'right'),
				);
			if (wrong.length > 0) {
				problems.push(
					`The current-item bar in the ${id} probe belongs on the ${wanted.bar} edge, and it is on ${wrong.map((entry) => `${which(entry.left, entry.right, 'edge', 'edges')} of the ${entry.label}`).join(' and ')}. ${why}`,
				);
			}
		}
	}
	return problems;
}

/**
 * What the layout probes measured, as problems.
 *
 * One problem per probe, except the base layer comparison, which names every property that
 * moved: "the host changed something" is not a message anybody can act on.
 *
 * @param {Record<string, string>} measured
 * @returns {string[]}
 */
function layoutProblems(measured) {
	/** @type {string[]} */
	const problems = [];
	/** @param {string} id */
	const read = (id) => {
		try {
			return JSON.parse(measured[id] ?? '');
		} catch {
			problems.push(
				`The ${id} probe returned something that is not a measurement: ${String(measured[id])}.`,
			);
			return undefined;
		}
	};
	/** @param {string} id */
	const why = (id) => PROBES.find((probe) => probe.id === id)?.why ?? '';

	const unfocused = read('skip-unfocused');
	if (unfocused !== undefined && unfocused.w > 1 && unfocused.h > 1) {
		problems.push(
			`The skip link paints a ${unfocused.w} by ${unfocused.h} box inside the viewport while nothing has focused it. ${why('skip-unfocused')}`,
		);
	}
	const focused = read('skip-focused');
	if (
		focused !== undefined &&
		!(focused.w > 1 && focused.h > 1 && focused.clip === 'none' && focused.top === true)
	) {
		problems.push(
			`The focused skip link is not shown: ${focused.w} by ${focused.h} inside the viewport, clip-path ${focused.clip}, on top of the content ${focused.top}. ${why('skip-focused')}`,
		);
	}

	const task = read('task-line');
	if (task !== undefined && (task.shared !== true || Math.abs(task.plain - task.task) > 1)) {
		problems.push(
			`A task list item does not read as one line: marker and text share a line ${task.shared}, and the item takes ${task.task}px where a plain item takes ${task.plain}px. ${why('task-line')}`,
		);
	}

	const image = read('image-display');
	if (
		image !== undefined &&
		(image.inline === 'block' || image.shared !== true || image.figure !== 'block')
	) {
		problems.push(
			`An image in a paragraph computes display ${image.inline} and shares a line with the text before it ${image.shared}, and an image in a figure computes ${image.figure}. ${why('image-display')}`,
		);
	}

	for (const id of ['gutter-phone', 'gutter-desktop', 'gutter-padded-host']) {
		const edges = read(id);
		if (
			edges !== undefined &&
			(edges.start < MIN_INSET || edges.end < MIN_INSET || edges.overflow === true)
		) {
			problems.push(
				`The ${id} probe measured ${edges.start}px to the start edge and ${edges.end}px to the end edge, where ${MIN_INSET}px is the floor, and horizontal overflow ${edges.overflow}. ${why(id)}`,
			);
		}
	}

	// The phone probes. One message each, listing everything that probe found, so a break that
	// trips two of one probe's checks is still one probe failing and not two.
	/** @param {string} id @param {string[]} found */
	const report = (id, found) => {
		if (found.length > 0)
			problems.push(`The ${id} probe found ${found.join(', and ')}. ${why(id)}`);
	};
	/** @param {number} value */
	const px = (value) => `${Math.round(value * 100) / 100}px`;
	const transparent = 'rgba(0, 0, 0, 0)';

	const reading = read('phone-reading');
	if (reading !== undefined) {
		/** @type {string[]} */
		const found = [];
		if (reading.list > 0) {
			found.push(`the page tree ${reading.list}px tall while its disclosure is closed`);
		}
		if (reading.paragraph > FIRST_SCREEN) {
			found.push(
				`the first paragraph starting ${reading.paragraph}px down, where ${FIRST_SCREEN}px is the most the first screen can spare`,
			);
		}
		if (Math.abs(reading.rootGap) > 0.5) {
			found.push(
				`the docs root starting ${px(reading.rootGap)} below the host's header, with the host's own ground in the gap`,
			);
		}
		if (reading.panelHeight > 0.6 * reading.viewport) {
			found.push(`the open page tree ${reading.panelHeight}px tall, over 60% of the viewport`);
		}
		if (reading.lastBottom > reading.panelBottom + 1) {
			found.push(
				`the open tree's last row ${px(reading.lastBottom - reading.panelBottom)} below the bottom of its panel, where nothing scrolls to it`,
			);
		}
		if (reading.offsetParent !== 'the panel') {
			found.push(
				`the current row in the open tree measured from ${reading.offsetParent} rather than from its panel, so opening the tree scrolls to the wrong place`,
			);
		}
		report('phone-reading', found);
	}

	const foot = read('phone-foot');
	if (foot !== undefined) {
		/** @type {string[]} */
		const found = [];
		if (foot.scrollable !== true) {
			found.push('a page that does not scroll, so whether the bar sticks was never examined');
		} else if (Math.abs(foot.bottom - foot.viewport) > 1) {
			found.push(
				`the bar's bottom edge at ${foot.bottom}px in a ${foot.viewport}px viewport rather than on the bottom of it`,
			);
		}
		if (foot.rest !== '15px' || foot.named !== '12px') {
			found.push(
				`the bar's label at ${foot.rest} with no heading and ${foot.named} with one, where it is 15px as the control and 12px as a caption`,
			);
		}
		if (foot.namedHeight > FOOT_MAX) {
			found.push(
				`the bar ${px(foot.namedHeight)} tall with a long heading named, over ${FOOT_MAX}px`,
			);
		}
		if (Math.abs(foot.namedHeight - foot.restHeight) > 0.01) {
			found.push(
				`the bar growing from ${px(foot.restHeight)} to ${px(foot.namedHeight)} when a heading is named`,
			);
		}
		if (foot.clash > 0) {
			found.push(`a long heading running ${foot.clash}px under the Pages link`);
		}
		if (foot.spill > 0) {
			found.push(`the page ${foot.spill}px wider than the screen with a long heading named`);
		}
		if (foot.overflow !== 'ellipsis') {
			found.push(
				`a long heading cut off with text-overflow ${foot.overflow} rather than an ellipsis`,
			);
		}
		/** @type {{ name: string, drawn: boolean, reach: number }[]} */
		const rings = foot.rings;
		if (rings.length === 0 || rings.some((ring) => !ring.drawn)) {
			found.push(
				'a focused control on the bar with no focus ring drawn, so where the ring reaches was never examined',
			);
		}
		for (const ring of rings.filter((entry) => entry.drawn && entry.reach > foot.viewport + 0.5)) {
			found.push(
				`the focus ring on .${ring.name} reaching ${px(ring.reach - foot.viewport)} below the bottom of the screen`,
			);
		}
		if (foot.footGround === transparent) {
			found.push('the bar with no ground of its own, over the article it sits on');
		}
		if (foot.panelGround === transparent) {
			found.push('the open outline with no ground of its own, over the article it covers');
		}
		// The panel's last row lies on the bar's rule rather than meeting its outer edge, because
		// two edges that meet exactly snap to different device rows at a fractional device pixel
		// ratio and leave a row of the article between them. This runs at a ratio of 1, where they
		// meet cleanly, so what is held is the overlap and the border that covers it, not a pixel.
		const overlap = foot.panelBottom - foot.footTop;
		if (!(overlap > 0 && overlap <= foot.rule)) {
			found.push(
				`the open outline's bottom edge ${px(overlap)} below the bar's top, where it lies on the bar's ${px(foot.rule)} rule and no further`,
			);
		}
		if (!(foot.end >= foot.rule)) {
			found.push(
				`the open outline's end border ${px(foot.end)} wide over the bar's ${px(foot.rule)} rule`,
			);
		}
		if (foot.endColour !== foot.ruleColour) {
			found.push(
				`the open outline's end border in ${foot.endColour} over a rule in ${foot.ruleColour}`,
			);
		}
		const [panelStart = Number.NaN, panelEnd = Number.NaN] = foot.panelInline;
		const [barStart = Number.NaN, barEnd = Number.NaN] = foot.barInline;
		if (!(Math.abs(panelStart - barStart) <= 0.5 && Math.abs(panelEnd - barEnd) <= 0.5)) {
			found.push(
				`the open outline from ${px(panelStart)} to ${px(panelEnd)} where the bar runs from ${px(barStart)} to ${px(barEnd)}`,
			);
		}
		if (foot.panelHeight > 0.6 * foot.viewport) {
			found.push(`the open outline ${foot.panelHeight}px tall, over 60% of the viewport`);
		}
		if (foot.lastBottom > foot.panelBottom + 1) {
			found.push(
				`the outline's last row ${px(foot.lastBottom - foot.panelBottom)} below the bottom of its panel, where nothing scrolls to it`,
			);
		}
		report('phone-foot', found);
	}

	const targets = read('phone-targets');
	if (targets !== undefined) {
		/** @type {string[]} */
		const found = Object.entries(targets.heights)
			.filter(([, height]) => height < TOUCH)
			.map(([selector, height]) => `${selector} ${height}px tall, under the ${TOUCH}px floor`);
		if (targets.end < MIN_INSET) {
			found.push(
				`the bar's Pages link ${targets.end}px from the end edge of the screen, under the ${MIN_INSET}px floor`,
			);
		}
		if (targets.summary !== 'flex') {
			found.push(`the Pages chip computing display ${targets.summary} rather than flex`);
		}
		if (Math.abs(targets.row) > 1) {
			found.push(`the Pages chip ${px(targets.row)} below the top of Search rather than beside it`);
		}
		if (targets.under < -0.5) {
			found.push('the open page tree beside the Pages chip rather than under it');
		}
		if (targets.alone.height < TOUCH) {
			found.push(
				`the Pages link ${targets.alone.height}px tall on a page with no outline, under the ${TOUCH}px floor`,
			);
		}
		if (Math.abs(targets.alone.shift) > 1) {
			found.push(
				`the Pages link ending ${px(Math.abs(targets.alone.shift))} away from where it ends on a page with an outline`,
			);
		}
		report('phone-targets', found);
	}

	const bareLink = read('phone-bare');
	if (bareLink !== undefined) {
		/** @type {string[]} */
		const found = [];
		// The docs root's own colour is the reference rather than the browser's link blue, which
		// is only one of the wrong answers: the faint token, at 3.3:1 on the bar's ground, and the
		// bar's own ground, which hides the link, both differ from blue.
		if (bareLink.colour !== bareLink.ink) {
			found.push(
				`the bar's Pages link in ${bareLink.colour}${bareLink.colour === UA_LINK ? ", the browser's default link blue," : ''} rather than the docs root's ink, ${bareLink.ink}`,
			);
		}
		if (bareLink.decoration !== 'none') {
			found.push(`the bar's Pages link drawn with a ${bareLink.decoration} decoration`);
		}
		report('phone-bare', found);
	}

	const search = read('phone-search');
	if (search !== undefined) {
		/** @type {string[]} */
		const found = [];
		// Not rounded: the desktop rule's 92vw leaves 15.6px either side at this width, which
		// rounds to the floor, so a rounded comparison passed with the phone width deleted.
		if (Math.abs(search.start - MIN_INSET) > 0.25 || Math.abs(search.end - MIN_INSET) > 0.25) {
			found.push(
				`the open search dialog ${px(search.start)} from the start edge and ${px(search.end)} from the end edge, where both are ${MIN_INSET}px`,
			);
		}
		if (search.top > MIN_INSET + 1) {
			found.push(`the open search dialog starting ${px(search.top)} down rather than at the top`);
		}
		report('phone-search', found);
	}

	for (const id of ['phone-token', 'phone-token-rtl', 'phone-token-narrow']) {
		const token = read(id);
		if (token === undefined) continue;
		/** @type {string[]} */
		const found = [];
		for (const { name, past } of token.spill) {
			found.push(`.${name} ending ${past}px past the edge of a ${token.width}px screen`);
		}
		if (token.scrollWidth > token.width) {
			found.push(
				`the page ${token.scrollWidth - token.width}px wider than its ${token.width}px screen`,
			);
		}
		// Negated, so a token that stopped being wider than the column fails rather than passes:
		// on one line it fits, and then nothing about breaking it was examined.
		if (!(token.lines > 1)) {
			found.push(
				`the identifier on ${token.lines} line where it is wider than the column, so whether it can break was never examined`,
			);
		}
		for (const split of token.split) {
			found.push(`an ordinary prose word split down the middle at ${split}`);
		}
		if (token.fence.wrap !== 'pre' || token.fence.scrolls !== true) {
			found.push(
				`a fence with white-space ${token.fence.wrap} and its own sideways scroll ${token.fence.scrolls}, where it keeps both`,
			);
		}
		if (token.table.scrolls !== true) {
			found.push(
				'a table no wider than its scroller, so the cell holding the identifier was squeezed into a column of fragments rather than left to scroll',
			);
		}
		report(id, found);
	}

	const tablet = read('phone-tablet');
	if (tablet !== undefined) {
		/** @type {string[]} */
		const found = [];
		const [start, end] = tablet.column;
		/** @param {number[]} edges */
		const off = (edges) =>
			Math.abs((edges[0] ?? Number.NaN) - start) > 1 ||
			Math.abs((edges[1] ?? Number.NaN) - end) > 1;
		/** @param {number[]} edges */
		const span = (edges) => `${px(edges[0] ?? Number.NaN)} to ${px(edges[1] ?? Number.NaN)}`;
		// Measured in the page rather than written here, so a minimum that grew past the Arabic
		// word cannot quietly stop this probe testing what it is for. Negated, so a minimum that
		// did not parse fails rather than passes.
		if (!(tablet.link > tablet.minimum + 0.5)) {
			found.push(
				`a Pages link ${px(tablet.link)} wide against its ${px(tablet.minimum)} minimum, so how a wider one lines up was never examined`,
			);
		}
		if (off(tablet.row)) {
			found.push(
				`the search and Pages row from ${span(tablet.row)} where the column runs from ${span(tablet.column)}`,
			);
		}
		if (off(tablet.bar)) {
			found.push(
				`the bar's Pages link and label from ${span(tablet.bar)} where the column runs from ${span(tablet.column)}`,
			);
		}
		if (tablet.foot[0] > 0.5 || tablet.width - tablet.foot[1] > 0.5) {
			found.push(
				`the bar's ground from ${span(tablet.foot)} rather than edge to edge of a ${tablet.width}px screen`,
			);
		}
		report('phone-tablet', found);
	}

	const chevronNames = [
		['tree', "the Pages chip's chevron"],
		['toc', "the bar's chevron"],
	];

	const plain = read('phone-chevrons');
	if (plain !== undefined) {
		/** @type {string[]} */
		const found = [];
		// Down the middle of a V pointing down, the ground comes first and the paint second, and
		// the outline's chevron is turned to point up while it is closed.
		const expected = {
			tree: ['ground', 'ground', 'paint', 'paint'],
			toc: ['paint', 'paint', 'ground', 'ground'],
		};
		for (const [name, label] of chevronNames) {
			if (plain.drawn[name] !== true) {
				found.push(`${label} not drawn at all`);
				continue;
			}
			const ground = plain.pixels[`${name} ground`];
			const seen = [1, 2, 3, 4].map((index) =>
				samePaint(plain.pixels[`${name} chevron ${index}`], ground) ? 'ground' : 'paint',
			);
			const want = expected[/** @type {'tree' | 'toc'} */ (name)];
			if (seen.join() !== want.join()) {
				found.push(
					`${label} reading ${seen.join(', ')} down its middle, where a closed one reads ${want.join(', ')}`,
				);
			}
		}
		report('phone-chevrons', found);
	}

	const forced = read('phone-forced');
	if (forced !== undefined) {
		/** @type {string[]} */
		const found = [];
		if (forced.forced !== true) {
			found.push(
				'a page that was not under a forced palette, so what one paints was never examined',
			);
		} else {
			for (const [name, label] of chevronNames) {
				if (forced.drawn[name] !== true) {
					found.push(`${label} not drawn at all, so there was no chevron for a palette to repaint`);
					continue;
				}
				const ground = forced.pixels[`${name} ground`];
				const shown = [1, 2, 3, 4].some(
					(index) => !samePaint(forced.pixels[`${name} chevron ${index}`], ground),
				);
				if (!shown) found.push(`${label} painted in the colour of the ground under it`);
			}
		}
		report('phone-forced', found);
	}

	const bare = read('base-bare');
	const hostedStyles = read('base-hosted');
	if (bare !== undefined && hostedStyles !== undefined) {
		const keys = Object.keys(bare);
		if (keys.length === 0) problems.push('The base layer probe measured no properties at all.');
		for (const key of keys) {
			if (bare[key] !== hostedStyles[key]) {
				problems.push(
					`A host base layer changed the ${key}: ${bare[key]} on a bare page, ${hostedStyles[key]} under the preflight. An unlayered rule only beats a layered one for a property it states, so the stylesheet has to state this one.`,
				);
			}
		}
		for (const key of ['banner link colour', 'breadcrumb link colour', 'edit link colour']) {
			if (bare[key] === UA_LINK) {
				problems.push(
					`The ${key} on a page with no host styles is the browser's default link blue, ${UA_LINK}, which is unreadable on the package's ground.`,
				);
			}
		}
		if (bare['fence code font'] !== bare['fence font']) {
			problems.push(
				`The code inside a fence is set in ${bare['fence code font']}, not the fence's ${bare['fence font']}. The browser's own stylesheet gives code a font family, so the token never reaches the text unless a rule makes it inherit.`,
			);
		}
	}
	return problems;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	renderAndExit('hex-docs paint', await run());
}
