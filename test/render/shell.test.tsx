import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, test } from 'vitest';

import { CONSUMER_ROOT } from '../../fixtures/index.js';
import { LOCALES, isLocale, type Locale } from '../../src/contracts/locales.js';
import type { BundleManifest } from '../../src/contracts/manifest.js';
import type { CompiledPage } from '../../src/contracts/page.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import type { DocsLinkComponent } from '../../src/render/context.js';
import { DocsPage } from '../../src/render/page.js';
import { IDS } from '../../src/site/ids.js';
import type { DocsPageData } from '../../src/site/route.js';
import { STATUS_LABELS } from '../../src/ui/status.js';
import {
	CALLOUT_LABELS,
	PLURAL_KEYS,
	PLURAL_STRINGS,
	UI_STRINGS,
	type UiKey,
} from '../../src/ui/strings.js';
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

/**
 * The manifest with one page's records cut down to the locales named.
 *
 * The corpus is deliberately not uniform and still cannot hold every state at once: it has no
 * untranslated section root, and every right-to-left locale in it has its own support matrix.
 * Both of those are ordinary states in a real bundle, and hex-nfc's first one is nothing else.
 * Perturbing the manifest is how the fixture corpus already reaches a scaffolded snippet, and
 * it is cheaper than a corpus page whose only job is to be missing.
 */
function narrowed(slug: string, keep: Locale[]): BundleManifest {
	const record = MANIFEST.pages[slug];
	if (record === undefined) throw new Error(`No page ${slug} to narrow; the corpus moved.`);
	const locales = Object.fromEntries(
		Object.entries(record.locales).filter(([locale]) => keep.includes(locale as Locale)),
	);
	expect(Object.keys(locales).length).toBe(keep.length);
	return { ...MANIFEST, pages: { ...MANIFEST.pages, [slug]: { ...record, locales } } };
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

describe('every run of text is declared to be in a language it could be in', () => {
	/**
	 * One sweep, both directions, over every address the corpus can serve.
	 *
	 * The rule is one rule: a run of text, or an accessible name, must sit under a declared
	 * language the words in it could actually be in. An Arabic interface string inside an
	 * article marked English breaks it, and so does an English page title inside a breadcrumb
	 * marked Arabic. Writing it as two rules is what let the second one ship: the first version
	 * of this sweep looked only for Arabic in runs that declared nothing, so the commit that
	 * fixed the shell's words introduced the mirror defect in the trail and the pager and this
	 * file stayed green.
	 *
	 * It reads the whole shell rather than the article, with the reader's locale as the
	 * baseline, because that is what both consumers' `root.tsx` writes on `<html>`. The
	 * sidebar, the outline and the trail are outside the article and every one of them carried
	 * the same defect.
	 *
	 * ## What it can place, and what it cannot
	 *
	 * A run is judged only when there is evidence about which language it is in: it matches an
	 * interface string in some language, or it is a page label the manifest gives in one, or it
	 * is the served page's own title or one of its headings. Anything else, a sentence of prose
	 * or a number, has no evidence and is skipped, which is why `placed` is asserted below: a
	 * matcher that placed nothing would otherwise report a clean sweep over the whole corpus.
	 *
	 * Five interface strings interpolate, so the evidence is a pattern per string rather than a
	 * set of literals. `'Step {number}'` is one of them, and matching it literally is how the
	 * step number stayed unmarked while the sweep read every page it appears on.
	 */
	const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source']);

	/** The five escapes `renderToStaticMarkup` writes, undone, so a run compares as authored. */
	const decode = (value: string): string =>
		value.replace(
			/&(?:amp|lt|gt|quot|#x27|#39);/g,
			(entity) =>
				({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" })[
					entity
				] as string,
		);

	interface Run {
		text: string;
		/** The nearest declared language, the reader's where nothing nearer declares one. */
		lang: Locale;
		/** Whether the run is text on the page or an accessible name that is only an attribute. */
		source: 'text' | 'aria-label';
		/** The open tag it sat in, so a failure names a place rather than a string. */
		element: string;
	}

	/** Every run of text and every accessible name, each with the language declared over it. */
	const runsIn = (html: string, baseline: Locale): { runs: Run[]; unknown: string[] } => {
		const stack: Locale[] = [];
		const runs: Run[] = [];
		const unknown: string[] = [];
		const at = (): Locale => stack[stack.length - 1] ?? baseline;
		const token = /<(\/?)([a-z0-9]+)((?:"[^"]*"|[^>])*)>|([^<]+)/gi;
		for (let match = token.exec(html); match !== null; match = token.exec(html)) {
			const [whole, closing, name, attrs, text] = match;
			if (text !== undefined) {
				const run = decode(text).trim();
				if (run !== '') runs.push({ text: run, lang: at(), source: 'text', element: 'text' });
				continue;
			}
			if (closing === '/') {
				stack.pop();
				continue;
			}
			const declared = /\slang="([^"]*)"/.exec(attrs as string)?.[1];
			if (declared !== undefined && !isLocale(declared)) unknown.push(whole);
			const lang = declared !== undefined && isLocale(declared) ? declared : at();
			// The element's own language, not its parent's: an attribute on an element that
			// declares one is read in the language that element declares.
			const label = /\saria-label="([^"]*)"/.exec(attrs as string)?.[1];
			if (label !== undefined) {
				const run = decode(label).trim();
				if (run !== '') runs.push({ text: run, lang, source: 'aria-label', element: whole });
			}
			if (!whole.endsWith('/>') && !VOID.has((name as string).toLowerCase())) stack.push(lang);
		}
		return { runs, unknown };
	};

	/** One interface string as a pattern, with each `{token}` standing for whatever filled it. */
	const patternOf = (template: string): RegExp =>
		new RegExp(
			`^${template
				.split(/\{[A-Za-z]+\}/)
				.map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
				.join('[\\s\\S]+')}$`,
		);

	const INTERFACE: Record<Locale, RegExp[]> = Object.fromEntries(
		LOCALES.map((locale) => [
			locale,
			[
				...Object.values(UI_STRINGS[locale]),
				...PLURAL_KEYS.flatMap((key) => Object.values(PLURAL_STRINGS[key][locale])),
				...Object.values(CALLOUT_LABELS[locale]),
				...Object.values(STATUS_LABELS[locale]),
			].map(patternOf),
		]),
	) as Record<Locale, RegExp[]>;

	/** Every page label the manifest carries, and the languages it is carried in. */
	const LABELS = new Map<string, Set<Locale>>();
	for (const record of Object.values(MANIFEST.pages)) {
		for (const [locale, entry] of Object.entries(record.locales)) {
			for (const label of [entry?.title, entry?.navTitle]) {
				if (label === undefined) continue;
				const seen = LABELS.get(label) ?? new Set<Locale>();
				seen.add(locale as Locale);
				LABELS.set(label, seen);
			}
		}
	}

	/** Every language a run could be in. Empty means there is no evidence either way. */
	const couldBe = (run: string, page: CompiledPage): Set<Locale> => {
		const found = new Set<Locale>(LABELS.get(run) ?? []);
		if (page.title === run || page.headings.some((heading) => heading.text === run)) {
			found.add(page.locale);
		}
		for (const locale of LOCALES) {
			if (INTERFACE[locale].some((pattern) => pattern.test(run))) found.add(locale);
		}
		return found;
	};

	/**
	 * The accessible names the shell knowingly leaves in the reader's language on an element
	 * whose words are the page's own.
	 *
	 * The one exemption mechanism this sweep has, and it is the case `direction.ts` states:
	 * there is no way in HTML to give an attribute a different language from the text beside
	 * it, and the text is what is read. A status mark is not in this list and must not join it,
	 * because it has no text for the text to win over, which is why it carries a `lang` of its
	 * own.
	 *
	 * Checked in both directions below. An exemption whose string stopped appearing anywhere in
	 * the corpus is an exemption covering nothing, which is how a list like this goes stale.
	 */
	const ATTRIBUTE_ONLY: { key: UiKey; why: string }[] = [
		{
			key: 'tableRegion',
			why: "The scroll region's name sits on the element holding the table, whose cells are the page's own words.",
		},
		{
			key: 'codeRegion',
			why: "A fence's region name sits on the `pre` holding the code, and code is nobody's language.",
		},
		{
			key: 'codeRegionNamed',
			why: 'The same name with the language label in it, which is the form every labelled fence takes.',
		},
	];

	interface Swept {
		misplaced: { where: string; text: string; declared: Locale; could: Locale[] }[];
		placed: number;
		exempted: Set<UiKey>;
		unknown: string[];
	}

	const sweep = (html: string, locale: Locale, page: CompiledPage): Swept => {
		const { runs, unknown } = runsIn(html, locale);
		const exempted = new Set<UiKey>();
		const misplaced: Swept['misplaced'] = [];
		let placed = 0;
		for (const run of runs) {
			const exemption =
				run.source === 'aria-label'
					? ATTRIBUTE_ONLY.find((entry) => patternOf(UI_STRINGS[locale][entry.key]).test(run.text))
					: undefined;
			if (exemption !== undefined) {
				exempted.add(exemption.key);
				continue;
			}
			const could = couldBe(run.text, page);
			if (could.size === 0) continue;
			placed += 1;
			if (!could.has(run.lang)) {
				misplaced.push({
					where: `${locale}/${page.slug} ${run.element}`,
					text: run.text,
					declared: run.lang,
					could: [...could],
				});
			}
		}
		return { misplaced, placed, exempted, unknown };
	};

	/**
	 * The corpus twice: as it stands, and as an English-only bundle.
	 *
	 * The second pass is not padding. `hexdocs init` publishes an English-only bundle, which is
	 * what hex-nfc serves today, and in that state every address in six languages is a fallback
	 * and every node type on every page is inside an article in another language. The corpus as
	 * it stands has no fallback page carrying an ordered procedure, so the step number could be
	 * left unmarked with all 56 addresses green, which is the same hole one page wide that this
	 * sweep was rewritten to close.
	 */
	const ENGLISH_ONLY: BundleManifest = {
		...MANIFEST,
		pages: Object.fromEntries(
			Object.entries(MANIFEST.pages).map(([slug, record]) => [
				slug,
				{ ...record, locales: { en: record.locales.en } },
			]),
		),
	};

	const ADDRESSES = [
		{ manifest: MANIFEST, why: 'the corpus as it stands' },
		{ manifest: ENGLISH_ONLY, why: 'an English-only bundle, which is what hexdocs init writes' },
	].flatMap(({ manifest, why }) =>
		LOCALES.flatMap((locale) => SITE.pages.map((slug) => ({ manifest, why, locale, slug }))),
	);

	let swept: Swept[] = [];

	beforeAll(async () => {
		swept = await Promise.all(
			ADDRESSES.map(async ({ manifest, locale, slug }) => {
				const data = await pageData({ manifest, site: SITE, locale, slug, load });
				return sweep(renderToStaticMarkup(<DocsPage {...data} />), locale, data.page);
			}),
		);
	});

	test('no run anywhere in the corpus is declared to be in a language it is not', () => {
		// The whole point of sweeping the pairings rather than one page: the page the first
		// version of this swept was the only page in the corpus carrying none of the five node
		// types that emit an interface string inside the article, so its empty result was empty
		// partly because nothing on it could have filled it.
		expect(swept.flatMap((entry) => entry.misplaced)).toEqual([]);
	});

	test('the sweep placed enough runs for an empty list to mean something', () => {
		// A matcher that placed nothing reports a clean sweep over 112 pages. The floor is well
		// under what it reaches, because the number moves with the corpus and a literal here
		// would be a second thing to maintain.
		const placed = swept.reduce((total, entry) => total + entry.placed, 0);
		expect(placed).toBeGreaterThan(800);
		expect(swept.length).toBe(2 * LOCALES.length * SITE.pages.length);
		expect(swept.flatMap((entry) => entry.unknown)).toEqual([]);
	});

	test('every declared exemption is one the corpus actually reaches', () => {
		// The second direction of the exemption list, which is the half worth having: an
		// exemption whose string no longer appears covers nothing, and the sweep goes on
		// reporting a clean run with one fewer thing examined.
		const exempted = new Set(swept.flatMap((entry) => [...entry.exempted]));
		expect([...exempted].sort()).toEqual(ATTRIBUTE_ONLY.map((entry) => entry.key).sort());
		for (const entry of ATTRIBUTE_ONLY) expect(entry.why.length).toBeGreaterThan(40);
	});

	test.each([
		{
			name: "the shell's own words unmarked inside a fallback article",
			// The defect as it shipped, and what the first version of this sweep was written for.
			edit: (html: string) => html.replaceAll(' lang="fr" dir="ltr"', ''),
			text: UI_STRINGS.fr.noticeReadEnglish,
		},
		{
			name: 'a status mark named in the reader language with no language of its own',
			// The `lang` half alone, which no sweep over runs of text could ever see: the mark has
			// no text, so its name is an attribute and nothing else, and 25 of them sit on this page.
			edit: (html: string) => html.replaceAll(/(<span class="hx-status[^>]*) lang="fr"/g, '$1'),
			text: STATUS_LABELS.fr.partial,
		},
		{
			name: "an untranslated neighbour's title declared to be the reader's language",
			// The mirror, and the one the commit that fixed the first defect introduced.
			edit: (html: string) =>
				html.replaceAll(/(<span class="hx-pager-title") lang="en" dir="ltr"/g, '$1'),
			text: 'Architecture',
		},
	])('the sweep sees $name', async ({ edit, text }) => {
		// Each positive control is the real defect, put back into the markup the renderer emits,
		// because a sweep that cannot fail proves nothing. French asking for the support matrix is
		// the one address in the corpus where all three are visible at once: there is no French
		// file, so the English page is served under a French interface, the page carries 25 status
		// marks, and the page after it in the order has no French title either.
		const { html, data } = await shell('fr', 'reference/chip-support');
		const planted = edit(html);
		expect(planted).not.toBe(html);
		const found = sweep(planted, 'fr', data.page).misplaced;
		expect(found.map((entry) => entry.text)).toContain(text);
	});
});

describe('the shell text inside a fallback article', () => {
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
			// The copy button's label, and not the button: a `dir` on the button moves it, because
			// it is a flex item whose `margin-inline-start: auto` resolves in its own direction.
			new RegExp(
				`<button type="button" class="hx-copy" disabled=""><span lang="ar" dir="rtl">${UI_STRINGS.ar.copyCode}</span></button>`,
			),
		]) {
			expect(arabicFallback).toMatch(pattern);
		}
		// And the button itself carries neither, which is the half a `toMatch` above cannot say.
		expect(arabicFallback).not.toMatch(/<button[^>]*class="hx-copy"[^>]*lang=/);
	});

	test('a marker with no text carries the language and not the direction', async () => {
		// Every locale in the corpus that reads right to left has its own support matrix, so the
		// state is made rather than found: the Arabic record is taken away and the English page
		// is served at the Arabic address, which is what hex-nfc's first bundle does on every
		// page at once.
		//
		// `dir="rtl"` on a partial mark makes it match `.hx-status-half:dir(rtl)`, whose
		// background fills the other half, so the shape would say the opposite of what the row
		// says. The mark is a shape as well as a colour precisely because the colour is not
		// enough, and a shape that says the wrong thing is worse than the glyph it replaced.
		const thin = narrowed('reference/chip-support', ['en']);
		const data = await pageData({
			manifest: thin,
			site: SITE,
			locale: 'ar',
			slug: 'reference/chip-support',
			load,
		});
		const html = renderToStaticMarkup(<DocsPage {...data} />);
		expect(data.page.locale).toBe('en');
		expect(html).toContain(
			`<span class="hx-status hx-status-half" data-status="partial" role="img" aria-label="${STATUS_LABELS.ar.partial}" lang="ar"></span>`,
		);
		expect(html).not.toMatch(/<span class="hx-status[^>]*dir=/);
	});

	test('a page in the language that was asked for marks only what is not in it', () => {
		// The other half of the condition the two marks share. Repeating an attribute an element
		// already inherits is not harmless: a screen reader announces a language change into the
		// language it is already reading. What is left is a different thing: a neighbour's title
		// that has no translation is English on a Japanese page and says so.
		for (const html of [english, arabic]) {
			expect(inside(html)).not.toContain('lang=');
		}
		expect(inside(japanese)).toContain(
			'<span class="hx-pager-title" lang="en" dir="ltr">Architecture</span>',
		);
		expect(inside(japanese).replaceAll(' lang="en" dir="ltr"', '')).not.toContain('lang=');
		// The Arabic page here is a stale translation rather than a page with no notice, so the
		// banner an unconditional mark would have laboured is really in the markup.
		expect(arabic).toContain('data-banner=');
	});

	test('the article keeps the page language and the prose keeps it too', () => {
		// The mirror: nothing marks the content back to the reader's language. The title and
		// the body are English on this page, and the interface carries the article's own answer
		// in the bar's current heading and in the outline below it.
		expect(arabicFallback).toContain('<span class="hx-toc-here" lang="en" dir="ltr">');
		expect(arabicFallback).toContain('<ol class="hx-toc-list" lang="en" dir="ltr">');
		expect(arabicFallback).not.toMatch(/<h1[^>]*lang=/);
		expect(arabicFallback).not.toMatch(/<div class="hx-prose"[^>]*lang=/);
	});

	test('one trail carries three answers, and each is on the element it is about', async () => {
		// The corpus has no untranslated section root, so the state is made rather than found:
		// `reference/index` keeps only its English record, which is what an app repository looks
		// like the week after somebody adds a section and before anyone translates it.
		//
		// Three decisions land on one trail. The landmark carries the reader's language, because
		// its accessible name and its separators are the interface's words. The crumb whose page
		// has a French title says nothing, because it already inherits French. The crumb whose
		// page has only an English one says English. Marking the landmark alone, which is what
		// shipped, declared that English crumb to be French.
		const data = await pageData({
			manifest: narrowed('reference/index', ['en']),
			site: SITE,
			locale: 'fr',
			slug: 'reference/chip-support',
			load,
		});
		const html = renderToStaticMarkup(<DocsPage {...data} />);
		const trail = /<nav id="hx-breadcrumb"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
		expect(trail).toMatch(/<nav id="hx-breadcrumb"[^>]*lang="fr" dir="ltr">/);
		expect(trail).toContain('<span lang="en" dir="ltr">Reference</span>');
		expect(trail).toContain('<a href="/fr/fixture-app/docs"><span>');
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
