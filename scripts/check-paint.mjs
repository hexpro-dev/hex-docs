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
 */

const DESKTOP = 1280;
const PHONE = 390;

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
};

/**
 * The shell around a probe's content, with the class names `DocsPage` renders. Every
 * `hx-` class in any probe's markup is asserted present in a rendered page by
 * `test/paint.test.ts`, which is a check on the names and not on how they nest.
 *
 * `dir` is the interface direction the root carries, and `article` the attributes the
 * article gains when the content served is in a different language from the interface,
 * which is how an Arabic page serving the English fallback reads left to right inside a
 * right-to-left shell. `current` adds a second tree link and a second table of contents
 * link and marks the first of each current, so a probe can compare a current link with a
 * plain one at the same place.
 *
 * @param {{ prose: string, head?: string, tree?: string, dir?: 'ltr' | 'rtl', article?: string, current?: boolean }} parts
 */
const shell = ({ prose, head = '', tree = '', dir = 'ltr', article = '', current = false }) =>
	`<div class="hx-root" dir="${dir}">${FRAGMENTS.skip}<div class="hx-layout"><nav id="hx-tree" class="hx-tree" aria-label="Documentation"><button type="button" class="hx-search-trigger" disabled="">Search</button>${tree}<ol class="hx-tree-list"><li class="hx-tree-item"><a class="hx-tree-link" href="#first"${current ? ' aria-current="page"' : ''}>First scan</a></li>${current ? '<li class="hx-tree-item"><a class="hx-tree-link" href="#write">Write a tag</a></li>' : ''}</ol></nav><article id="hx-content" class="hx-article" tabindex="-1"${article}>${head}<h1 id="hx-title" class="hx-title">Scan your first tag</h1><div class="hx-prose">${prose}</div></article><nav id="hx-toc" class="hx-toc" aria-label="On this page"><p class="hx-toc-heading">On this page</p><ol><li class="hx-toc-item" data-depth="2"><a href="#before" class="hx-toc-link"${current ? ' aria-current="true"' : ''}>Before you start</a></li>${current ? '<li class="hx-toc-item" data-depth="2"><a href="#hold" class="hx-toc-link">Hold the tag still</a></li>' : ''}</ol></nav></div></div>`;

const PARAGRAPH =
	'<p>A first read takes about ten seconds once the tag is in your hand. Most of that is finding the spot on the phone where the antenna sits, which is further up the back than people expect.</p>';

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

/** The distance from the shell's content to each edge of the viewport, as JSON. */
const EDGES = `(() => {
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

const BASE_PAGE = hosted(
	shell({
		tree: '<dialog class="hx-search" aria-label="Search the documentation"><div class="hx-search-bar"><input class="hx-search-input" type="search"/><button type="button" class="hx-search-close">Close search</button></div></dialog>',
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
 * A value with every `var(--name, fallback)` replaced by its fallback, or `undefined` when a
 * `var()` in it has none.
 *
 * `CSS.supports` answers true for any value containing a `var()`, because such a value is
 * only checked once the variable is substituted, so a declaration passed through unchanged
 * is valid by definition and the probe would check nothing in a stylesheet where every value
 * is a token chain. Every chain the theme contract generates ends in a literal, which is what
 * makes the fallback the value a page with no overrides actually paints. A `var()` with no
 * fallback has nothing to substitute and is skipped, and the probe counts the skips so a
 * substitution that returned `undefined` for everything cannot pass.
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
		const start = value.indexOf('var(', index);
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
		for (const probe of probes) {
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
		counted = `, ${reading.validated} declarations valid, ${reading.skipped.length} skipped for a var() with no fallback`;
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
			`A declaration the browser does not accept: \`${entry.selector}\` declares \`${entry.property}: ${entry.value}\`${entry.tested === entry.value ? '' : `, tested as \`${entry.tested}\` with each var() replaced by its fallback`}. It is dropped, so the rule paints as if the line were never written.`,
	);
	if (reading.found < reading.terminators) {
		problems.push(
			`The declaration parser found ${reading.found} declarations in a stylesheet with ${reading.terminators} semicolons outside comments, strings and parentheses, so the ones it missed were never validated.`,
		);
	}
	if (reading.validated === 0) {
		problems.push(
			`The declarations probe validated nothing: ${reading.skipped.length} of ${reading.found} declarations were skipped for a var() with no fallback. A probe that skipped everything has checked nothing.`,
		);
	}
	return problems;
}

/**
 * What the `sides-*` probes measured, as problems: one for the partial mark and one for the
 * current-item bar, per probe, so a defect names the direction it shows up in.
 *
 * Two samples are the same paint when no channel differs by more than 24. Measured on macOS,
 * a screenshot of a flat colour comes back exact, and nobody has measured a Linux runner, so
 * the margin is for a capture that turns out to be colour managed. The colours being told
 * apart are at least 200 apart on some channel, so it cannot blur one into the other.
 *
 * @param {Record<string, string>} measured
 * @returns {string[]}
 */
export function sideProblems(measured) {
	/** @type {string[]} */
	const problems = [];
	/** @param {number[] | undefined} a @param {number[] | undefined} b */
	const same = (a, b) =>
		a !== undefined &&
		b !== undefined &&
		a.every((channel, index) => Math.abs(channel - (b[index] ?? -999)) <= 24);
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
