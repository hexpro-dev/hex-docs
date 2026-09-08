import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { CONSUMER_ROOT } from '../../fixtures/index.js';
import { AST_VERSION } from '../../src/contracts/ast.js';
import type { Locale } from '../../src/contracts/locales.js';
import type { BundleManifest } from '../../src/contracts/manifest.js';
import type { CompiledPage } from '../../src/contracts/page.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import {
	aliasMap,
	breadcrumbFor,
	buildNav,
	docsRoute,
	looksLikePage,
	pageSkew,
	pagerFor,
	type DocsRouteResult,
} from '../../src/site/route.js';
import { goldenManifest, goldenPage, goldenPages } from '../support/golden.js';

const SITE = JSON.parse(
	readFileSync(join(CONSUMER_ROOT, 'fixture-app.docs.json'), 'utf8'),
) as DocsSiteConfig;

const MANIFEST = goldenManifest();
const PAGES = new Map(goldenPages().map((entry) => [`${entry.locale}/${entry.slug}`, entry.page]));

const address = { basePath: SITE.basePath, locale: 'en' as Locale };

async function route(
	overrides: Partial<Parameters<typeof docsRoute>[0]> = {},
): Promise<DocsRouteResult> {
	return docsRoute({
		manifest: MANIFEST,
		site: SITE,
		locale: 'en',
		slug: 'guide/first-tag',
		bundleBase: '/_docs/fixture-app/1.1.0',
		load: async (locale, slug) => PAGES.get(`${locale}/${slug}`),
		...overrides,
	});
}

describe('the happy path', () => {
	test('returns the payload, the chrome and the seo answer in one object', async () => {
		const result = await route();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.page.slug).toBe('guide/first-tag');
		expect(result.data.sourceLocale).toBe('en');
		expect(result.data.version).toEqual({ label: '1.1.0', pinned: false, latest: '1.1.0' });
		expect(result.data.notice).toEqual({ state: 'current' });
		expect(result.seo).toEqual({ indexable: true });
		expect(result.data.navLabel).toBe(SITE.navLabel.en);
	});

	test('serves the source locale when the page has no translation', async () => {
		// The day-one shape: hex-nfc's first bundle is English-only, so every non-English
		// address serves the English payload with a notice and no index.
		const result = await route({ locale: 'fr', slug: 'developer/architecture' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.page.locale).toBe('en');
		expect(result.data.locale).toBe('fr');
		expect(result.data.notice).toEqual({ state: 'fallback', requested: 'fr' });
		expect(result.seo).toEqual({ indexable: false });
	});

	test('builds the edit link from the repository, the branch and the page source file', async () => {
		const result = await route({
			edit: { repo: 'https://example.com/r', branch: 'trunk', root: 'docs/site' },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The four join points, asserted whole. A wrong join is a 404 on GitHub that renders
		// as a perfectly good-looking link.
		expect(result.data.editUrl).toBe(
			`https://example.com/r/edit/trunk/docs/site/${result.data.page.sourceFile}`,
		);
	});

	test('omits the edit link when the consumer supplies no repository', async () => {
		const result = await route();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.editUrl).toBeUndefined();
	});

	test('queries the reader search index when the bundle has one', async () => {
		const result = await route({ locale: 'ja', slug: 'guide/first-tag' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.searchLocale).toBe('ja');
	});

	test('falls back to the source index when the bundle has none for that language', async () => {
		// Silent failure otherwise: a search box over an index that was never built returns
		// nothing, with no error, in one language.
		const thin = { ...MANIFEST, search: { en: MANIFEST.search.en } } as BundleManifest;
		const result = await route({ manifest: thin, locale: 'ja', slug: 'guide/first-tag' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.searchLocale).toBe('en');
	});
});

describe('what the route refuses', () => {
	test('an AST major the manifest declares and this runtime does not know', async () => {
		// A refusal rather than a page of skipped nodes. A bundle compiled at a newer major
		// would render most of a page and drop the rest, which looks exactly like a working
		// page.
		const result = await route({ manifest: { ...MANIFEST, ast: 2 } as unknown as BundleManifest });
		expect(result).toEqual({ ok: false, reason: 'unsupported-ast' });
	});

	test('an AST major the payload declares and the manifest does not', async () => {
		// Both are checked, because they are two claims about the same thing and the whole
		// write-once mechanism rests on them agreeing.
		const page = { ...goldenPage('en', 'guide/first-tag').page, ast: 2 } as unknown as CompiledPage;
		const result = await route({ load: async () => page });
		expect(result).toEqual({ ok: false, reason: 'unsupported-ast' });
		expect(AST_VERSION).toBe(1);
	});

	test('a payload that is not shaped like a compiled page', async () => {
		// The renderer is handed JSON fetched at runtime. A truncated or half-written file
		// otherwise becomes an exception inside a React render, which on both consumers
		// client-renders the whole site shell.
		for (const payload of [undefined, null, {}, '', 42, { slug: 'x' }]) {
			expect(await route({ load: async () => payload })).toEqual({
				ok: false,
				reason: 'bad-payload',
			});
		}
	});

	test('a version label the site config does not carry', async () => {
		expect(await route({ pinned: '9.9.9' })).toEqual({ ok: false, reason: 'no-such-version' });
	});

	test('a site config with no default version', async () => {
		const noDefault = {
			...SITE,
			versions: SITE.versions.map((entry) => ({ ...entry, default: undefined })),
		} as DocsSiteConfig;
		expect(await route({ site: noDefault })).toEqual({ ok: false, reason: 'no-such-version' });
	});

	test('a slug the bundle does not carry', async () => {
		expect(await route({ slug: 'guide/ghost' })).toEqual({ ok: false, reason: 'no-such-page' });
	});

	test('a slug the bundle carries and the site config does not list', async () => {
		// The skew. `site.pages` is the sole input to the consumer's `LOCALISED_PATHS`, so
		// serving a page it does not list ships that page with no canonical, no alternates
		// and no noindex, and it renders perfectly.
		const behind = { ...SITE, pages: SITE.pages.filter((slug) => slug !== 'guide/first-tag') };
		expect(await route({ site: behind })).toEqual({ ok: false, reason: 'no-such-page' });
	});

	test('a slug with no record in any servable locale', async () => {
		const empty = {
			...MANIFEST,
			pages: {
				...MANIFEST.pages,
				'guide/first-tag': { audience: 'both', since: null, locales: {} },
			},
		} as unknown as BundleManifest;
		expect(await route({ manifest: empty })).toEqual({ ok: false, reason: 'no-such-page' });
	});
});

describe('redirects', () => {
	test('an old slug becomes a redirect to the address of the new one', async () => {
		const result = await route({ slug: 'first-tag' });
		expect(result).toEqual({
			ok: false,
			reason: 'redirect',
			to: '/fixture-app/docs/guide/first-tag',
		});
	});

	test('a redirect keeps the locale and the version pin', async () => {
		expect(await route({ slug: 'first-tag', locale: 'ja', pinned: '1.0.0' })).toEqual({
			ok: false,
			reason: 'redirect',
			to: '/ja/fixture-app/docs/v/1.0.0/guide/first-tag',
		});
	});
});

describe('the page set skew', () => {
	test('reports nothing when the config and the bundle agree', () => {
		expect(pageSkew(MANIFEST, SITE)).toEqual({ inBundleOnly: [], inConfigOnly: [] });
	});

	test('names a slug the bundle gained since the config was written', () => {
		const behind = { ...SITE, pages: SITE.pages.filter((slug) => slug !== 'reference/api') };
		expect(pageSkew(MANIFEST, behind)).toEqual({
			inBundleOnly: ['reference/api'],
			inConfigOnly: [],
		});
	});

	test('names a slug the config claims and the bundle does not have', () => {
		const ahead = { ...SITE, pages: [...SITE.pages, 'guide/ghost'] };
		expect(pageSkew(MANIFEST, ahead)).toEqual({ inBundleOnly: [], inConfigOnly: ['guide/ghost'] });
	});
});

describe('the sidebar', () => {
	const nav = buildNav({ manifest: MANIFEST, site: SITE, locale: 'en', current: 'index', address });

	test('nests a section root and its pages, from the slugs alone', () => {
		// The bundle carries no nav.json, so a group that is not a page has no label to
		// render and the compiler flattens it. What is left is a section root, which is a
		// real page with a real translated title.
		const guide =
			nav[0]?.kind === 'section' ? nav[0].items.find((n) => n.slug === 'guide/index') : undefined;
		expect(guide?.kind).toBe('section');
		if (guide?.kind !== 'section') return;
		expect(guide.items.map((item) => item.slug)).toEqual([
			'guide/first-tag',
			'guide/troubleshooting',
		]);
	});

	test('leaves the hidden page out entirely', () => {
		const slugs: string[] = [];
		const walk = (nodes: ReturnType<typeof buildNav>): void => {
			for (const node of nodes) {
				slugs.push(node.slug);
				if (node.kind === 'section') walk(node.items);
			}
		};
		walk(nav);
		expect(slugs).not.toContain('reference/api');
		expect(MANIFEST.nav.some((node) => node.slug === 'reference/api' && node.hidden === true)).toBe(
			true,
		);
	});

	test('marks the current page and nothing else', () => {
		const current: string[] = [];
		const walk = (nodes: ReturnType<typeof buildNav>): void => {
			for (const node of nodes) {
				if (node.current) current.push(node.slug);
				if (node.kind === 'section') walk(node.items);
			}
		};
		walk(nav);
		expect(current).toEqual(['index']);
	});

	test('labels a page in the reader language, falling back to the source', () => {
		const japanese = buildNav({
			manifest: MANIFEST,
			site: SITE,
			locale: 'ja',
			current: 'index',
			address: { basePath: SITE.basePath, locale: 'ja' },
		});
		const flat: { slug: string; label: string }[] = [];
		const walk = (nodes: ReturnType<typeof buildNav>): void => {
			for (const node of nodes) {
				flat.push({ slug: node.slug, label: node.label });
				if (node.kind === 'section') walk(node.items);
			}
		};
		walk(japanese);
		// The developer page has no Japanese translation, so its label comes from the source
		// locale's record, and within that record the nav label still wins over the title.
		const english = MANIFEST.pages['developer/architecture']?.locales.en;
		expect(english?.navTitle).toBeDefined();
		expect(english?.navTitle).not.toBe(english?.title);
		const developer = flat.find((entry) => entry.slug === 'developer/architecture');
		expect(developer?.label).toBe(english?.navTitle);
		const guide = flat.find((entry) => entry.slug === 'guide/index');
		expect(guide?.label).toBe(MANIFEST.pages['guide/index']?.locales.ja?.navTitle);
	});
});

describe('previous and next', () => {
	test('are the neighbours in reading order', () => {
		const pager = pagerFor(MANIFEST, 'en', 'guide/first-tag', address);
		expect(pager.previous?.href).toBe('/fixture-app/docs/guide/');
		expect(pager.next?.href).toBe('/fixture-app/docs/guide/troubleshooting');
	});

	test('the first page has no previous and the last has no next', () => {
		expect(pagerFor(MANIFEST, 'en', 'index', address).previous).toBeUndefined();
		expect(pagerFor(MANIFEST, 'en', 'developer/architecture', address).next).toBeUndefined();
	});

	test('a hidden page gets neither neighbour, not the two that surrounded it', () => {
		// Half of prev/next is not out of prev/next, which is what `nav.ts` promises a
		// hidden page gets.
		expect(pagerFor(MANIFEST, 'en', 'reference/api', address)).toEqual({});
	});

	test('the hidden page is skipped over rather than linked past', () => {
		const pager = pagerFor(MANIFEST, 'en', 'reference/chip-support', address);
		expect(pager.next?.href).toBe('/fixture-app/docs/developer/architecture');
	});
});

describe('breadcrumbs', () => {
	test('walk from the docs home down to the parent section', () => {
		const crumbs = breadcrumbFor(
			MANIFEST,
			'en',
			{ kind: 'page', section: ['guide'], name: 'first-tag' },
			address,
		);
		expect(crumbs.map((crumb) => crumb.href)).toEqual([
			'/fixture-app/docs/',
			'/fixture-app/docs/guide/',
		]);
	});

	test('the docs home has none', () => {
		expect(breadcrumbFor(MANIFEST, 'en', { kind: 'index', section: [] }, address)).toEqual([]);
	});
});

describe('the alias map', () => {
	test('collects every alias a heading answers to', () => {
		// A translated page carries the source locale's slug, so a deep link written against
		// the English page still lands on the right section of the Japanese one.
		const japanese = aliasMap(goldenPage('ja', 'index').page);
		expect(Object.keys(japanese).length).toBeGreaterThan(0);
		expect(japanese['what-you-need']).toBeDefined();
	});

	test('is empty for a page whose headings need no aliases', () => {
		expect(aliasMap(goldenPage('en', 'index').page)).toEqual({});
	});

	test('finds a heading nested inside another block', () => {
		const page = {
			...goldenPage('en', 'index').page,
			body: [
				{
					type: 'blockquote',
					children: [
						{
							type: 'heading',
							depth: 2,
							id: 'deep',
							idSource: 'slug',
							aliases: ['old'],
							children: [],
						},
					],
				},
			],
		} as unknown as CompiledPage;
		expect(aliasMap(page)).toEqual({ old: 'deep' });
	});
});

describe('the payload shape check', () => {
	test('accepts every compiled page in the corpus', () => {
		let checked = 0;
		for (const entry of goldenPages()) {
			expect({ page: `${entry.locale}/${entry.slug}`, ok: looksLikePage(entry.page) }).toEqual({
				page: `${entry.locale}/${entry.slug}`,
				ok: true,
			});
			checked += 1;
		}
		expect(checked).toBe(goldenPages().length);
	});

	test('refuses each field it depends on, one at a time', () => {
		// A sweep rather than one broken object, because a check that only fails on `{}` is
		// satisfied by looking at a single field.
		const page = goldenPage('en', 'index').page as unknown as Record<string, unknown>;
		for (const field of [
			'slug',
			'title',
			'description',
			'locale',
			'body',
			'headings',
			'toc',
			'reading',
			'translation',
		]) {
			const broken = { ...page };
			delete broken[field];
			expect({ field, ok: looksLikePage(broken) }).toEqual({ field, ok: false });
		}
	});

	test('refuses a locale that is not one of the seven', () => {
		const page = { ...goldenPage('en', 'index').page, locale: 'hi' };
		expect(looksLikePage(page)).toBe(false);
	});
});
