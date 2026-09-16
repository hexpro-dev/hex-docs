import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, test } from 'vitest';

import { CONSUMER_ROOT } from '../../fixtures/index.js';
import type { Locale } from '../../src/contracts/locales.js';
import type { CompiledPage } from '../../src/contracts/page.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import type { DocsLinkComponent } from '../../src/render/context.js';
import { DocsPage } from '../../src/render/page.js';
import { IDS } from '../../src/site/ids.js';
import type { DocsPageData } from '../../src/site/route.js';
import { STATUS_LABELS } from '../../src/ui/status.js';
import { UI_STRINGS } from '../../src/ui/strings.js';
import { goldenManifest, goldenPages } from '../support/golden.js';
import { pageData } from '../support/render.js';

const SITE = JSON.parse(
	readFileSync(join(CONSUMER_ROOT, 'fixture-app.docs.json'), 'utf8'),
) as DocsSiteConfig;

const MANIFEST = goldenManifest();

const PAGES = new Map(goldenPages().map((entry) => [`${entry.locale}/${entry.slug}`, entry.page]));

const load = (locale: Locale, slug: string): CompiledPage | undefined =>
	PAGES.get(`${locale}/${slug}`);

async function shell(
	locale: Locale,
	slug: string,
	extra: { pinned?: string } = {},
): Promise<{ html: string; data: DocsPageData }> {
	const data = await pageData({ manifest: MANIFEST, site: SITE, locale, slug, load, ...extra });
	return { html: renderToStaticMarkup(<DocsPage {...data} />), data };
}

let english = '';
let arabic = '';
let japanese = '';
let fallback = '';

beforeAll(async () => {
	english = (await shell('en', 'guide/troubleshooting')).html;
	arabic = (await shell('ar', 'index')).html;
	japanese = (await shell('ja', 'reference/chip-support')).html;
	// French has no developer page, so the route serves the English payload at the French
	// address. This is the shape hex-nfc ships on day one, when the bundle is English-only.
	fallback = (await shell('fr', 'developer/architecture')).html;
});

const count = (html: string, pattern: RegExp): number => [...html.matchAll(pattern)].length;

describe('landmarks', () => {
	test('the shell renders no main, because the consuming site already has one', () => {
		// Two `main` elements is an authoring error a screen reader reports as such, and
		// both consumers' root.tsx already renders one.
		expect(count(english, /<main[\s>]/g)).toBe(0);
	});

	test('the counter can see a main, so the zero above means something', () => {
		// The positive control. Every assertion of the form "zero occurrences of X" is
		// satisfied by a broken matcher, by an empty string and by a component that
		// rendered nothing at all.
		const planted = `${english}<main id="planted"></main>`;
		expect(count(planted, /<main[\s>]/g)).toBe(1);
		expect(english.length).toBeGreaterThan(2000);
	});

	test('every navigation landmark has its own accessible name', () => {
		// Four navs on a page inside a site that already has its own. Without distinct
		// names a screen reader's landmark list reads "navigation" four times over.
		const names = [...english.matchAll(/<nav[^>]*aria-label(?:ledby)?="([^"]+)"/g)].map(
			(match) => match[1] as string,
		);
		expect(names.length).toBe(count(english, /<nav[\s>]/g));
		expect(new Set(names).size).toBe(names.length);
		expect(names.length).toBeGreaterThanOrEqual(3);
	});

	test('the skip link points at the article, which is focusable', () => {
		expect(english).toContain(`href="#${IDS.content}"`);
		expect(english).toMatch(new RegExp(`id="${IDS.content}"[^>]*tabindex="-1"`));
	});

	test('the article is labelled by the only h1 on the page', () => {
		expect(count(english, /<h1[\s>]/g)).toBe(1);
		expect(english).toContain(`aria-labelledby="${IDS.title}"`);
		expect(english).toContain(`id="${IDS.title}"`);
	});

	test('there is a polite live region and it is empty in the markup', () => {
		// It is filled by an effect after a client-side navigation. Filling it on the
		// server would make a screen reader announce the page it is already reading.
		expect(english).toMatch(
			new RegExp(`id="${IDS.live}"[^>]*role="status"[^>]*aria-live="polite"[^>]*></p>`),
		);
	});
});

describe('every ARIA reference resolves', () => {
	/**
	 * The cheapest catch for the commonest silent ARIA break.
	 *
	 * A reference to an element that was renamed, moved into a component that no longer
	 * renders it, or duplicated, produces no warning and no visible change: the
	 * relationship is simply gone. Sweeping every rendered page is what makes the ids
	 * module worth having.
	 */
	test.each([
		['en/guide/troubleshooting', () => english],
		['ar/index', () => arabic],
		['ja/reference/chip-support', () => japanese],
	])('%s', (_name, get) => {
		const html = get();
		const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] as string);
		const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
		expect(duplicated).toEqual([]);

		const referenced = [
			...html.matchAll(/aria-(?:labelledby|controls|describedby|activedescendant)="([^"]+)"/g),
		].flatMap((match) => (match[1] as string).split(/\s+/));
		expect(referenced.length).toBeGreaterThan(0);
		expect(referenced.filter((id) => !ids.includes(id))).toEqual([]);
	});
});

describe('the table of contents', () => {
	test('shows what the compiler put in headings, not what the body contains', () => {
		// The divergence that makes both obvious implementations wrong. This page has seven
		// headings in its body and six in `headings`, and the missing one is a real anchor
		// somebody can link to: a table of contents built from the body shows what the
		// compiler deliberately filtered, and anchors built from `headings` leave that
		// heading unlinkable.
		const page = PAGES.get('en/guide/troubleshooting') as CompiledPage;
		expect(page.headings.length).toBe(6);

		const tocLinks = [...english.matchAll(/<a href="#([^"]+)" class="hx-toc-link"/g)].map(
			(match) => match[1] as string,
		);
		expect(tocLinks.length).toBe(6);
		expect(tocLinks).not.toContain('tags-that-read-once-and-then-go-quiet');

		// And the anchor is still there, in the body, where a deep link lands.
		expect(english).toContain('id="tags-that-read-once-and-then-go-quiet"');
	});

	test('is absent on a page whose front matter switched it off', async () => {
		// The corpus carries one on purpose. `toc: false` is a suppression only, so this is
		// the only way a page can have headings and no table of contents, and a renderer
		// that re-decided from the heading count would show one anyway.
		const page = PAGES.get('ja/reference/chip-support') as CompiledPage;
		expect(page.toc).toBe(false);
		expect(page.headings.length).toBeGreaterThan(0);
		expect(japanese).not.toContain('class="hx-toc"');
		expect(japanese).not.toContain(UI_STRINGS.ja.tocLabel);
	});
});

describe('language and direction', () => {
	test('an Arabic page is right to left at the root', () => {
		expect(arabic).toMatch(/<div id="hx-root"[^>]*dir="rtl"/);
	});

	test('an English fallback served at a French address is labelled English', () => {
		// Marking it `lang="fr"` would tell a screen reader to read English words with
		// French phonetics and a translation tool that the job is done.
		expect(fallback).toMatch(/<article[^>]*lang="en"/);
		expect(fallback).toMatch(/<article[^>]*dir="ltr"/);
	});

	test('a page in the language that was asked for does not repeat the attributes', () => {
		// Repeating them is not harmless: a screen reader announces a language change into
		// the language it is already reading.
		expect(english).not.toMatch(/<article[^>]*lang=/);
	});

	test('inline code carries the class the bidi isolation hangs off', () => {
		expect(arabic).toContain('class="hx-code"');
	});
});

describe('the shell text inside a fallback article', () => {
	/**
	 * Every run of text under `html` that inherits its language rather than declaring one.
	 *
	 * A scan rather than a list of selectors, because the list is what goes stale: a piece of
	 * furniture added to the article a year from now joins the markup without joining any
	 * assertion, and the first sign is a reader hearing Arabic read as English. What is
	 * checked instead is a property of the whole subtree, so a new piece is covered the day it
	 * is written or it fails here.
	 */
	const inherited = (html: string): string[] => {
		const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source']);
		const stack: boolean[] = [];
		const found: string[] = [];
		const token = /<(\/?)([a-z0-9]+)((?:"[^"]*"|[^>])*)>|([^<]+)/gi;
		for (let match = token.exec(html); match !== null; match = token.exec(html)) {
			const [whole, closing, name, attrs, text] = match;
			if (text !== undefined) {
				const run = text.trim();
				if (run !== '' && !stack.some(Boolean)) found.push(run);
			} else if (closing === '/') {
				stack.pop();
			} else if (!whole.endsWith('/>') && !VOID.has((name as string).toLowerCase())) {
				stack.push(/\slang="/.test(attrs as string));
			}
		}
		return found;
	};

	/** The Arabic block, which is what an interface string laid out as English shows up as. */
	const ARABIC = /[؀-ۿ]/;

	/** What the article holds, without the article's own tag, so its `lang` is the baseline. */
	const inside = (html: string): string => {
		const open = html.indexOf('<article');
		const start = html.indexOf('>', open) + 1;
		return html.slice(start, html.indexOf('</article>', start));
	};

	let arabicFallback = '';

	beforeAll(async () => {
		// Arabic asking for a page that exists only in English: the interface is right to left
		// and the words are left to right, which is the pair that makes every mark visible.
		arabicFallback = (await shell('ar', 'developer/architecture')).html;
	});

	test('the article is English and every piece of the shell inside it is Arabic', () => {
		expect(arabicFallback).toMatch(/<article[^>]*lang="en"[^>]*dir="ltr"/);
		for (const pattern of [
			// The notice, which only ever appears on a page in another language.
			/<aside class="hx-banner" data-banner="fallback" lang="ar" dir="rtl">/,
			// The trail, whose accessible name is a string from the table.
			/<nav id="hx-breadcrumb"[^>]*lang="ar" dir="rtl">/,
			// The reading estimate and the edit link share one line.
			/<p class="hx-meta" lang="ar" dir="rtl">/,
			// Previous and next, whose own labels are from the table too.
			/<nav id="hx-pager"[^>]*lang="ar" dir="rtl">/,
		]) {
			expect(arabicFallback).toMatch(pattern);
		}
	});

	test('no Arabic is left to inherit the article language', () => {
		// The sweep. Laid out as English, an Arabic sentence runs the wrong way and its final
		// full stop paints before its first word, and a screen reader reads it with English
		// phonetics.
		const stray = inherited(inside(arabicFallback)).filter((run) => ARABIC.test(run));
		expect(stray).toEqual([]);
	});

	test('the sweep can see an unmarked Arabic run, so the empty list above means something', () => {
		// The positive control, and it is the shape the defect shipped in: the notice's own
		// sentence with no language of its own, inheriting the English article around it.
		const planted = arabicFallback.replaceAll(' lang="ar" dir="rtl"', '');
		expect(planted).not.toBe(arabicFallback);
		const stray = inherited(inside(planted)).filter((run) => ARABIC.test(run));
		expect(stray.length).toBeGreaterThan(0);
		// And it is not a false positive elsewhere: the Arabic it found is in the notice.
		expect(stray.join(' ')).toContain(UI_STRINGS.ar.noticeReadEnglish);
	});

	test('a page in the language that was asked for marks nothing inside the article', () => {
		// The other half of the condition the two marks share. Repeating an attribute an
		// element already inherits is not harmless: a screen reader announces a language
		// change into the language it is already reading, on every banner and every pager.
		for (const html of [english, arabic, japanese]) {
			expect(inside(html)).not.toContain('lang=');
		}
		// The Arabic page here is a stale translation rather than a page with no notice, so
		// the banner an unconditional mark would have laboured is really in the markup.
		expect(arabic).toContain('data-banner=');
	});

	test('the article keeps the page language and the prose keeps it too', () => {
		// The mirror: nothing marks the content back to the reader's language. The title and
		// the body are English on this page, and the one place the interface carries the
		// article's own answer is the heading named in the phone's bar.
		expect(arabicFallback).toContain('<span class="hx-toc-here" lang="en" dir="ltr">');
		expect(arabicFallback).not.toMatch(/<h1[^>]*lang=/);
		expect(arabicFallback).not.toMatch(/<div class="hx-prose"[^>]*lang=/);
	});
});

describe('the interface is in the reader language, not the content language', () => {
	test('a Japanese page reads its chrome in Japanese', () => {
		expect(japanese).toContain(UI_STRINGS.ja.skipToContent);
		expect(japanese).toContain(UI_STRINGS.ja.pagerLabel);
		expect(japanese).toContain(UI_STRINGS.ja.editPage);
		expect(japanese).not.toContain(UI_STRINGS.en.skipToContent);
	});

	test('a status glyph is named in the reader language', () => {
		// The whole reason the status node exists. Left as text the glyph makes a screen
		// reader say "white heavy check mark" in seven languages.
		expect(japanese).toContain(`aria-label="${STATUS_LABELS.ja.yes}"`);
		expect(japanese).not.toContain(`aria-label="${STATUS_LABELS.en.yes}"`);
	});

	test('an English fallback still reads its chrome in French', () => {
		// The distinction between the two locales, from the other side: the words are
		// English and the furniture is not.
		expect(fallback).toContain(UI_STRINGS.fr.tocLabel);
		expect(fallback).not.toContain(UI_STRINGS.en.skipToContent);
	});

	test('the accessible name of a scrollable region is not the English one', () => {
		// A hardcoded English label passes every "has an accessible name" assertion. This
		// is the line that catches it.
		expect(japanese).toContain(`aria-label="${UI_STRINGS.ja.tableRegion}"`);
		expect(japanese).not.toContain(`aria-label="${UI_STRINGS.en.tableRegion}"`);
	});
});

describe('the notices', () => {
	test('a current page in its own language shows none', async () => {
		const { html } = await shell('ja', 'guide/index');
		expect(html).not.toContain('data-banner=');
	});

	test('a stale translation says so and dates the English page', async () => {
		const { html, data } = await shell('ja', 'guide/first-tag');
		expect(data.notice.state).toBe('stale');
		expect(html).toContain('data-banner="stale"');
		expect(html).toContain(data.page.translation.sourceUpdated.slice(0, 10));
	});

	test('a fallback names the reader language in the reader language', async () => {
		// A French reader is told the page is not in "français", not that it is not in
		// "French", which is what a hardcoded English language name would give them.
		expect(fallback).toContain('data-banner="fallback"');
		expect(fallback).toContain('fran');
	});

	test('a scaffolded page is the source page under the fallback notice', async () => {
		// The Spanish file exists and is not a translation, so the route serves the English
		// page and the notice says why. The corpus's scaffolded file happens to be a copy of
		// the English one; what `hexdocs scaffold` writes is a page of TODO markers, which is
		// the case `test/site/divergence.test.ts` serves.
		const { html, data } = await shell('es', 'reference/chip-support');
		expect(MANIFEST.pages['reference/chip-support']?.locales.es?.state).toBe('scaffolded');
		expect([data.page.locale, data.page.translation.state]).toEqual(['en', 'source']);
		expect(data.notice).toEqual({ state: 'fallback', requested: 'es' });
		expect(html).toContain('data-banner="fallback"');
	});

	test('the notice links to the source page through the consumer link, like every other docs link', async () => {
		// It is the one link that changes the reader's language, and it used to be a plain
		// anchor on the grounds that a client-side navigation would leave the shell in the
		// wrong language. Neither consumer does that: both render `<html lang dir>` from root
		// data and revalidate root on a pathname change, so the anchor bought a full reload
		// and nothing else. A marked link proves which component rendered it, because the
		// default one is itself a plain anchor and a markup match could not tell them apart.
		const Marked: DocsLinkComponent = ({ to, children, ...rest }) => (
			<a href={to} data-consumer-link="" {...rest}>
				{children}
			</a>
		);
		const data = await pageData({
			manifest: MANIFEST,
			site: SITE,
			locale: 'fr',
			slug: 'developer/architecture',
			load,
		});
		const html = renderToStaticMarkup(<DocsPage {...data} Link={Marked} />);
		const banner =
			/<aside class="hx-banner" data-banner="fallback"[^>]*>[\s\S]*?<\/aside>/.exec(html)?.[0] ??
			'';
		expect(banner).toContain(
			'<a href="/fixture-app/docs/developer/architecture" data-consumer-link="">',
		);
		expect(fallback).toMatch(/<a href="\/fixture-app\/docs\/developer\/architecture">/);
	});
});

describe('the version banner', () => {
	test('is absent at the default version', () => {
		expect(english).not.toContain('data-banner="version"');
	});

	test('appears when the address pins an older version, and links to the same page', async () => {
		// The same page at the default version, not the docs home. A reader who pinned a
		// version and clicked through wants the page they were reading.
		const { html, data } = await shell('en', 'guide/first-tag', { pinned: '1.0.0' });
		expect(data.version).toEqual({ label: '1.0.0', pinned: true, latest: '1.1.0' });
		expect(html).toContain('data-banner="version"');
		expect(html).toContain('href="/fixture-app/docs/guide/first-tag"');
	});

	test('every link on a pinned page keeps the pin', async () => {
		const { html } = await shell('en', 'guide/first-tag', { pinned: '1.0.0' });
		const treeLinks = [...html.matchAll(/<a href="([^"]+)" class="hx-tree-(?:link|section)"/g)].map(
			(match) => match[1] as string,
		);
		expect(treeLinks.length).toBeGreaterThan(3);
		// The pin as a whole segment, which the docs home ends on now that no address carries
		// a trailing slash.
		for (const href of treeLinks) expect(href).toMatch(/^\/fixture-app\/docs\/v\/1\.0\.0(\/|$)/);
		expect(treeLinks).toContain('/fixture-app/docs/v/1.0.0');
	});
});

describe('the sidebar and the pager', () => {
	test('the current page is marked, once', async () => {
		const { html } = await shell('en', 'guide/first-tag');
		expect(count(html, /aria-current="page"/g)).toBe(1);
	});

	test('the hidden page is in neither the sidebar nor prev/next', async () => {
		// `reference/api` is marked hidden in nav.json. `nav.ts` promises a hidden page
		// stays out of the sidebar, the sitemap and prev/next while staying published, and
		// until the manifest carried the flag the renderer had no way to know.
		const hidden = MANIFEST.nav.find((node) => node.hidden === true);
		expect(hidden?.slug).toBe('reference/api');
		const { html } = await shell('en', 'reference/chip-support');
		expect(html).not.toContain('/fixture-app/docs/reference/api');
	});

	test('a hidden page still renders, and gets no neighbours', async () => {
		const { html, data } = await shell('en', 'reference/api');
		expect(data.previous).toBeUndefined();
		expect(data.next).toBeUndefined();
		expect(html).toContain('<h1');
		expect(html).not.toContain('class="hx-pager"');
	});

	test('the sidebar uses navTitle where a page has one', async () => {
		// The field's whole purpose is the sidebar, and until it reached the manifest the
		// sidebar was the one place that could not see it.
		// `index` in Japanese, where the two really differ: the title is a sentence and the
		// nav label is one word. `guide/index` has both and they are the same word, which
		// would make this pass on a renderer that read the title.
		const record = MANIFEST.pages['index']?.locales.ja;
		expect(record?.navTitle).toBeDefined();
		expect(record?.navTitle).not.toBe(record?.title);
		const { html } = await shell('ja', 'index');
		// Scoped to the sidebar. The full title is on the page, in the h1, so a sweep over
		// the whole document would find it and prove nothing.
		const tree = html.slice(html.indexOf('<nav id="hx-tree"'), html.indexOf('</nav>'));
		expect(tree).toContain(record?.navTitle as string);
		expect(tree).not.toContain(record?.title as string);
		// The phone's Pages control is in the same landmark, named in the reader's language.
		expect(tree).toContain(UI_STRINGS.ja.pages);
	});
});

describe('the phone controls', () => {
	test('both disclosures render closed, and the outline one only where there is an outline', () => {
		// Closed in the server's markup and never given `open` by React, so a reader who opens
		// one before hydration keeps it open and hydration has nothing to disagree about.
		expect(count(english, /<details class="hx-tree-disclosure">/g)).toBe(1);
		expect(count(english, /<details class="hx-toc-disclosure">/g)).toBe(1);
		expect(count(english, /<details[^>]* open/g)).toBe(0);
		expect(count(japanese, /<details class="hx-tree-disclosure">/g)).toBe(1);
		expect(japanese).not.toContain('hx-toc-disclosure');
	});

	test('the open counter can see an open disclosure, so the zero above means something', () => {
		const planted = english.replace(
			'<details class="hx-tree-disclosure">',
			'<details class="hx-tree-disclosure" open="">',
		);
		expect(count(planted, /<details[^>]* open/g)).toBe(1);
	});

	test('the summaries say where the reader is going, and the server never names a heading', () => {
		// The bar's second line is empty until the scroll spy answers. Filled on the server it
		// would repeat the page title under the h1, and stay that way with no script.
		expect(english).toContain(`<summary class="hx-tree-summary">${UI_STRINGS.en.pages}</summary>`);
		expect(english).toContain(
			`<summary class="hx-toc-summary"><span class="hx-toc-where"><span class="hx-toc-summary-label">${UI_STRINGS.en.tocLabel}</span><span class="hx-toc-here"></span></span></summary>`,
		);
		expect(arabic).toContain(`<summary class="hx-tree-summary">${UI_STRINGS.ar.pages}</summary>`);
	});

	test('the bar names a heading in the language the article is in', async () => {
		// The heading is the article's text inside the interface's chrome. On a fallback it is
		// English inside a French or Arabic bar, and without its own `lang` and `dir` it is read
		// with the interface's phonetics and laid out in the interface's direction, which in
		// Arabic clips the start of a long English heading and moves its punctuation.
		const here = '<span class="hx-toc-here" lang="en" dir="ltr"></span>';
		expect(fallback).toContain(here);
		expect((await shell('ar', 'developer/architecture')).html).toContain(here);
		for (const html of [english, (await shell('ar', 'guide/troubleshooting')).html]) {
			expect(html).toContain('<span class="hx-toc-here"></span>');
		}
	});

	test('the bar and its Pages link are on every page, the one with no outline included', () => {
		// The link is how a reader mid-article reaches the tree, and a page with no table of
		// contents is still a page somebody wants to leave.
		for (const [html, locale] of [
			[english, 'en'],
			[arabic, 'ar'],
			[japanese, 'ja'],
		] as const) {
			expect(count(html, /class="hx-foot"/g)).toBe(1);
			expect(html).toContain(
				`<a class="hx-foot-pages" href="#${IDS.tree}">${UI_STRINGS[locale].pages}</a>`,
			);
		}
		expect(japanese).toContain(
			`<div class="hx-foot"><a class="hx-foot-pages" href="#${IDS.tree}">`,
		);
	});

	test('source order is the phone order, top to bottom', () => {
		// No reordering in CSS, so the tab order and a screen reader's reading order are the
		// order the phone draws: the Pages control, its rows, the article, the bar, its rows,
		// and the bar's link last.
		const at = (needle: string): number => {
			const index = english.indexOf(needle);
			expect({ needle, found: index >= 0 }).toEqual({ needle, found: true });
			return index;
		};
		expect(at('class="hx-tree-summary"')).toBeLessThan(at('class="hx-tree-link"'));
		const order = [
			at(`id="${IDS.content}"`),
			at('class="hx-toc-summary"'),
			at('class="hx-toc-link"'),
			at('class="hx-foot-pages"'),
		];
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});
});

describe('the search trigger', () => {
	test('is disabled in the markup the server sends', () => {
		// A control announced as available that does nothing because the script never ran
		// is worse than no control.
		expect(english).toMatch(/class="hx-search-trigger" disabled=""/);
	});

	test('is a combobox with the results it controls', () => {
		expect(english).toContain('role="combobox"');
		expect(english).toContain(`aria-controls="${IDS.searchResults}"`);
		expect(english).toContain(`id="${IDS.searchResults}"`);
		expect(english).toContain('role="listbox"');
	});

	test('names no active option before anything is typed', () => {
		expect(english).not.toContain('aria-activedescendant');
	});
});

describe('what the shell never emits', () => {
	test('no inline style, script or event attribute reaches the markup', () => {
		for (const html of [english, arabic, japanese, fallback]) {
			expect(html).not.toContain('<script');
			expect(html).not.toContain(' onclick=');
			expect(html).not.toContain('javascript:');
		}
	});

	test('the sweep can see each of those, so the absence means something', () => {
		const planted = `${english}<script>x</script><a onclick="y" href="javascript:void 0">z</a>`;
		expect(planted).toContain('<script');
		expect(planted).toContain(' onclick=');
		expect(planted).toContain('javascript:');
	});
});

describe('heading aliases', () => {
	test('a translated page keeps a link written against the source anchor', async () => {
		// The Japanese index links to `#what-you-need`, which is the English heading slug,
		// while its own heading id is Japanese. `ast.ts` says aliases exist so a deep link
		// written against the English page still lands on the right section of the Japanese
		// one, and the renderer emits `id` and leaves the rest to a scroll handler, so the
		// alias map is what carries that promise.
		const { html, data } = await shell('ja', 'index');
		expect(html).toContain('href="#what-you-need"');
		expect(html).not.toContain('id="what-you-need"');
		expect(data.aliases['what-you-need']).toBeDefined();
		expect(html).toContain(`id="${data.aliases['what-you-need'] as string}"`);
	});

	test('the English page needs no alias for its own anchor', async () => {
		const { html, data } = await shell('en', 'index');
		expect(html).toContain('id="what-you-need"');
		expect(data.aliases['what-you-need']).toBeUndefined();
	});
});
