/**
 * `docsServer`, over the fixture bundle held in memory the way a consumer's globs hold it.
 *
 * The router table in `router.test.ts` proves which module an address reaches. This file
 * is about what the module answers: every refusal, every header, the fallback per page,
 * the language each body is served in, and every defensive arm, because `src/site/**` is
 * held to 100% of lines and a defensive arm nobody drives is a branch that has never been
 * seen to work.
 */

import { beforeAll, describe, expect, test } from 'vitest';

import { LOCALES, type Locale } from '../../src/contracts/locales.js';
import {
	RAW_ASSET_LINK,
	RAW_PAGE_LINK,
	type BundleManifest,
	type PageRecord,
} from '../../src/contracts/manifest.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import { indexableLanguages } from '../../src/site/route.js';
import { docsServer, type DocsSources } from '../../src/site/serve.js';
import {
	fixtureBundle,
	fixtureSite,
	fixtureSources,
	globKey,
	type FixtureBundle,
} from '../support/bundle.js';

let bundle: FixtureBundle;
let site: DocsSiteConfig;
let sources: DocsSources;

beforeAll(() => {
	bundle = fixtureBundle();
	site = fixtureSite(bundle);
	sources = fixtureSources(bundle, site);
}, 60_000);

const url = (path: string): URL => new URL(path, 'http://docs.test');

/** What a thrown value was, so a refusal is asserted by status rather than by `toThrow`. */
async function thrown(promise: Promise<unknown>): Promise<Response> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Response) return error;
		throw error;
	}
	throw new Error('expected a thrown Response, and the promise resolved');
}

/** The sources with one manifest swapped, for the refusal cases. */
function withManifest(manifest: unknown): DocsSources {
	return { ...sources, manifests: { [globKey(site, 'manifest.json')]: manifest } };
}

/** A manifest whose bundle carries no translation in one locale, kept consistent. */
function withoutLocale(manifest: BundleManifest, locale: Locale): BundleManifest {
	const pages: Record<string, PageRecord> = {};
	for (const [slug, record] of Object.entries(manifest.pages)) {
		const locales = { ...record.locales };
		delete locales[locale];
		pages[slug] = { ...record, locales };
	}
	const drop = <T>(record: Partial<Record<Locale, T>>): Partial<Record<Locale, T>> => {
		const copy = { ...record };
		delete copy[locale];
		return copy;
	};
	return {
		...manifest,
		locales: manifest.locales.filter((one) => one !== locale),
		pages,
		search: drop(manifest.search),
		llms: drop(manifest.llms),
		coverage: drop(manifest.coverage),
		counts: { ...manifest.counts, locales: manifest.locales.length - 1 },
	};
}

describe('page()', () => {
	test('serves a page with its seo answer, its data and the site theme class', async () => {
		const loaded = await docsServer(sources).page(url('/fixture-app/docs/guide/first-tag'));
		expect(loaded.seo).toEqual({ indexable: true, languages: [...LOCALES] });
		expect(loaded.data.page.slug).toBe('guide/first-tag');
		expect(loaded.data.bundleBase).toBe(`/_docs/fixture-app/${site.versions[0]?.label}`);
		expect(loaded.themeClass).toBe('app-fixture');
	});

	test('omits the theme class when the config has none', async () => {
		const plain = { ...site, themeClass: undefined };
		delete plain.themeClass;
		const loaded = await docsServer({ ...sources, configs: [plain] }).page(
			url('/fixture-app/docs'),
		);
		expect('themeClass' in loaded).toBe(false);
	});

	test('serves the English payload at a language with no translation, not indexable', async () => {
		const loaded = await docsServer(sources).page(
			url('/fr/fixture-app/docs/developer/architecture'),
		);
		expect(loaded.data.page.locale).toBe('en');
		expect(loaded.data.notice).toEqual({ state: 'fallback', requested: 'fr' });
		expect(loaded.seo).toEqual({ indexable: false, languages: ['en'] });
	});

	test('is indexable only at the canonical spelling, one trailing slash allowed', async () => {
		// React Router answers every one of these from the same row, so the loader is the
		// only thing that can tell a duplicate from the address.
		const server = docsServer(sources);
		const spellings: [string, boolean][] = [
			['/fixture-app/docs/guide', true],
			['/fixture-app/docs/guide/', true],
			['/fixture-app/docs/guide//', false],
			['/Fixture-App/docs/guide', false],
			['/fixture-app/docs/gu%69de', false],
			['/ja/fixture-app/docs/guide/', true],
		];
		for (const [path, indexable] of spellings) {
			const loaded = await server.page(url(path));
			expect({ path, indexable: loaded.seo.indexable }).toEqual({ path, indexable });
			expect(loaded.data.page.slug).toBe('guide/index');
		}
	});

	test('throws a 404 for an address the table does not know', async () => {
		const server = docsServer(sources);
		for (const path of [
			'/fixture-app/docs/typo',
			'/',
			'/banana/fixture-app/docs/guide',
			'/zh-hans/fixture-app/docs/guide',
			'/pt_br/fixture-app/docs/guide',
			'/hi/fixture-app/docs/guide',
			'/ja/fixture-app/docs/typo',
			'/fixture-app/docs/%E0%A4%A',
		]) {
			const response = await thrown(server.page(url(path)));
			expect({ path, status: response.status }).toEqual({ path, status: 404 });
		}
	});

	test('throws a 301 to the bare path for /en and to the canonical casing, query kept', async () => {
		const server = docsServer(sources);
		const cases: [string, string][] = [
			['/en/fixture-app/docs/guide?x=1', '/fixture-app/docs/guide?x=1'],
			['/EN/fixture-app/docs', '/fixture-app/docs'],
			['/en', '/'],
			['/pt-br/fixture-app/docs/guide?x=1', '/pt-BR/fixture-app/docs/guide?x=1'],
			['/JA', '/ja'],
		];
		for (const [path, location] of cases) {
			const response = await thrown(server.page(url(path)));
			expect({ path, status: response.status, location: response.headers.get('Location') }).toEqual(
				{ path, status: 301, location },
			);
		}
	});

	test('throws a 301 from a redirect source to its target, in the requested language', async () => {
		const server = docsServer(sources);
		const bare = await thrown(server.page(url('/fixture-app/docs/first-tag?ref=a')));
		expect([bare.status, bare.headers.get('Location')]).toEqual([
			301,
			'/fixture-app/docs/guide/first-tag?ref=a',
		]);
		const japanese = await thrown(server.page(url('/ja/fixture-app/docs/first-tag')));
		expect(japanese.headers.get('Location')).toBe('/ja/fixture-app/docs/guide/first-tag');
	});

	test('a redirect the manifest carries for a slug the config still lists as a page is followed', async () => {
		// A config written before the rename, so the router has a page row for the old name.
		const stale = { ...site, pages: [...site.pages, 'first-tag'], redirects: {} };
		const response = await thrown(
			docsServer({ ...sources, configs: [stale] }).page(url('/fixture-app/docs/first-tag?q=1')),
		);
		expect([response.status, response.headers.get('Location')]).toEqual([
			301,
			'/fixture-app/docs/guide/first-tag?q=1',
		]);
	});

	test('a page the config lists and the bundle lacks is a 404, not a 500', async () => {
		const ahead = { ...site, pages: [...site.pages, 'guide/ghost'] };
		const response = await thrown(
			docsServer({ ...sources, configs: [ahead] }).page(url('/fixture-app/docs/guide/ghost')),
		);
		expect(response.status).toBe(404);
	});

	test('a payload the glob does not have, or cannot load, or that is not a page, is a 500', async () => {
		const key = globKey(site, 'pages/en/guide/first-tag.json');
		const missing = { ...sources.pages };
		delete missing[key];
		const variants: [string, DocsSources['pages']][] = [
			['missing', missing],
			[
				'rejected',
				{
					...sources.pages,
					[key]: async () => {
						throw new Error('chunk gone');
					},
				},
			],
			['not a page', { ...sources.pages, [key]: async () => ({ slug: 'x' }) }],
			[
				'another ast',
				{
					...sources.pages,
					[key]: async () => ({ ...((await sources.pages[key]?.()) as object), ast: 2 }),
				},
			],
		];
		for (const [name, pages] of variants) {
			const response = await thrown(
				docsServer({ ...sources, pages }).page(url('/fixture-app/docs/guide/first-tag')),
			);
			const body = await response.text();
			expect({ name, status: response.status, names: body.includes('hexdocs prefetch') }).toEqual({
				name,
				status: 500,
				names: true,
			});
		}
	});
});

describe('a bundle that cannot be served', () => {
	/** Every refusal, by what makes it and a phrase only its message carries. */
	const refusals = (): [string, DocsSources, string][] => {
		const manifest = bundle.manifest;
		const noDefault = {
			...site,
			versions: site.versions.map((entry) => ({ ...entry, default: undefined })),
		} as DocsSiteConfig;
		return [
			['no manifest at all', { ...sources, manifests: {} }, 'manifest.json was found'],
			[
				'objects and no manifest',
				{ ...sources, manifests: { '../docs/manifest.json': manifest } },
				'manifest.json was found',
			],
			['a manifest that is a string', withManifest('manifest'), 'is not an object'],
			['a manifest that is null', withManifest(null), 'is not an object'],
			['an empty object', withManifest({}), 'manifest version is undefined'],
			['another ast major', withManifest({ ...manifest, ast: 2 }), 'ast-2'],
			[
				'another project',
				withManifest({ ...manifest, project: 'other-app' }),
				'project "other-app"',
			],
			[
				'another commit',
				withManifest({ ...manifest, commit: 'f'.repeat(40) }),
				`the label names ${manifest.commit}`,
			],
			[
				'identity and nothing else',
				withManifest({ manifest: 1, ast: 1, project: manifest.project, commit: manifest.commit }),
				'not shaped like a manifest',
			],
			[
				'a count that does not recount',
				withManifest({ ...manifest, counts: { ...manifest.counts, pages: 1 } }),
				'counts.pages is 1',
			],
			['no default version', { ...sources, configs: [noDefault] }, 'has no default version'],
		];
	};

	test('is a 500 naming hexdocs prefetch from page(), resource() and sitemap(), never a throw of anything else', async () => {
		let checked = 0;
		for (const [name, broken, phrase] of refusals()) {
			const server = docsServer(broken);
			const page = await thrown(server.page(url('/fixture-app/docs/guide/first-tag')));
			const resource = await server.resource(url('/fixture-app/docs/llms.txt'));
			let sitemap: unknown;
			try {
				server.sitemap();
			} catch (error) {
				sitemap = error;
			}
			for (const [where, response] of [
				['page', page],
				['resource', resource],
				['sitemap', sitemap as Response],
			] as const) {
				expect(response, `${name}: ${where} did not refuse with a Response`).toBeInstanceOf(
					Response,
				);
				const body = await response.text();
				expect({
					name,
					where,
					status: response.status,
					type: response.headers.get('Content-Type'),
					phrase: body.includes(phrase),
					prefetch: body.includes('hexdocs prefetch'),
				}).toEqual({
					name,
					where,
					status: 500,
					type: 'text/plain; charset=utf-8',
					phrase: true,
					prefetch: true,
				});
			}
			checked += 1;
		}
		expect(checked).toBe(refusals().length);
	});

	test('is checked once per site, however many requests ask', async () => {
		let reads = 0;
		const counted = new Proxy(bundle.manifest, {
			get(target, key, receiver) {
				if (key === 'pages') reads += 1;
				return Reflect.get(target, key, receiver);
			},
		});
		const server = docsServer(withManifest(counted));
		await server.page(url('/fixture-app/docs'));
		const afterFirst = reads;
		await server.page(url('/fixture-app/docs'));
		await server.resource(url('/fixture-app/docs/llms.txt'));
		server.sitemap();
		// The later requests read `pages` for their own answers and never re-run the whole
		// shape check, which reads it once per page record and more.
		expect(afterFirst).toBeGreaterThan(5);
		expect(reads - afterFirst).toBeLessThan(afterFirst);
	});

	test('a config that cannot be routed is a 500 from every method, not a throw at construction', async () => {
		const bad = { ...site, pages: ['Guide/First-Tag'] };
		const server = docsServer({ ...sources, configs: [bad] });
		const page = await thrown(server.page(url('/fixture-app/docs')));
		const resource = await server.resource(url('/fixture-app/docs/llms.txt'));
		let sitemap: unknown;
		try {
			server.sitemap();
		} catch (error) {
			sitemap = error;
		}
		for (const response of [page, resource, sitemap as Response]) {
			expect(response.status).toBe(500);
			expect(await response.text()).toMatch(/cannot be routed.*docsHref/);
		}
	});

	test('glob keys that name no bundle are ignored rather than misread', async () => {
		const noisy: DocsSources = {
			...sources,
			manifests: {
				...sources.manifests,
				'../docs/_bundles/fixture-app/manifest.json': {},
				'elsewhere.json': {},
			},
			pages: { ...sources.pages, '../docs/stray.json': async () => ({}) },
			text: { ...sources.text, '../docs/_bundles/x.txt': async () => 'x' },
		};
		const server = docsServer(noisy);
		expect((await server.page(url('/fixture-app/docs'))).data.page.slug).toBe('index');
		expect((await server.resource(url('/fixture-app/docs/llms.txt'))).status).toBe(200);
	});
});

describe('resource()', () => {
	test('serves llms.txt as plain text with the machine headers and the served language', async () => {
		const response = await docsServer(sources).resource(url('/fixture-app/docs/llms.txt'));
		expect(response.status).toBe(200);
		expect(Object.fromEntries(response.headers)).toEqual({
			'content-type': 'text/plain; charset=utf-8',
			'x-content-type-options': 'nosniff',
			'x-robots-tag': 'noindex',
			'content-language': 'en',
		});
		expect(await response.text()).toBe(bundle.objects.get('llms/en.txt'));
	});

	test("serves a language's own llms.txt, and the source one for a language the bundle lacks", async () => {
		const japanese = await docsServer(sources).resource(url('/ja/fixture-app/docs/llms.txt'));
		expect(japanese.headers.get('Content-Language')).toBe('ja');
		expect(await japanese.text()).toBe(bundle.objects.get('llms/ja.txt'));

		const thin = docsServer(withManifest(withoutLocale(bundle.manifest, 'fr')));
		const french = await thin.resource(url('/fr/fixture-app/docs/llms.txt'));
		expect(french.status).toBe(200);
		expect(french.headers.get('Content-Language')).toBe('en');
		expect(await french.text()).toBe(bundle.objects.get('llms/en.txt'));
	});

	test('serves raw markdown at both mounts, falling back per page, with the served language', async () => {
		const server = docsServer(sources);
		const cases: [string, Locale, string][] = [
			['/fixture-app/docs/index.md', 'en', 'raw/en/index.md'],
			['/ja/fixture-app/docs/index.md', 'ja', 'raw/ja/index.md'],
			['/ja/fixture-app/docs/developer/architecture.md', 'en', 'raw/en/developer/architecture.md'],
			// Scaffolded: a file under a translation's name that is still English, so the
			// source file carries the same words and the right header.
			['/es/fixture-app/docs/reference/chip-support.md', 'en', 'raw/en/reference/chip-support.md'],
			['/zh/fixture-app/docs/reference/chip-support.md', 'zh', 'raw/zh/reference/chip-support.md'],
		];
		for (const [path, language, object] of cases) {
			const response = await server.resource(url(path));
			expect({
				path,
				status: response.status,
				type: response.headers.get('Content-Type'),
				language: response.headers.get('Content-Language'),
				robots: response.headers.get('X-Robots-Tag'),
				body: await response.text(),
			}).toEqual({
				path,
				status: 200,
				type: 'text/markdown; charset=utf-8',
				language,
				robots: 'noindex',
				body: bundle.objects.get(object),
			});
		}
		expect(bundle.manifest.pages['reference/chip-support']?.locales.es?.state).toBe('scaffolded');
	});

	test('serves llms-full.txt as every page in llmsOrder, each in its served language, one blank line apart', async () => {
		const server = docsServer(sources);
		for (const locale of ['en', 'ja', 'ar'] as const) {
			const response = await server.resource(
				url(
					locale === 'en'
						? '/fixture-app/docs/llms-full.txt'
						: `/${locale}/fixture-app/docs/llms-full.txt`,
				),
			);
			const served = new Set<Locale>();
			const expected = bundle.manifest.llmsOrder
				.map((slug) => {
					const own = bundle.manifest.pages[slug]?.locales[locale];
					const language = own !== undefined && own.state !== 'scaffolded' ? locale : 'en';
					served.add(language);
					return (bundle.objects.get(`raw/${language}/${slug}.md`) as string).replace(/\n+$/, '');
				})
				.join('\n\n');
			expect(await response.text()).toBe(`${expected}\n`);
			// In LOCALES order, not in the order the pages happened to fall back.
			expect(response.headers.get('Content-Language')).toBe(
				LOCALES.filter((one) => served.has(one)).join(', '),
			);
		}
		// The hidden page is published, so it is in the full text.
		const english = await (await server.resource(url('/fixture-app/docs/llms-full.txt'))).text();
		expect(english).toContain(bundle.manifest.pages['reference/api']?.locales.en?.title);
	});

	test('answers 404 for an address that is not a resource, and never throws', async () => {
		const server = docsServer(sources);
		for (const path of [
			'/fixture-app/docs/guide',
			'/fixture-app/docs/typo.md',
			'/banana/fixture-app/docs/llms.txt',
			'/zh-hans/fixture-app/docs/llms.txt',
			'/fixture-app/docs/first-tag.md',
		]) {
			const response = await server.resource(url(path));
			expect({
				path,
				status: response.status,
				sniff: response.headers.get('X-Content-Type-Options'),
			}).toEqual({
				path,
				status: 404,
				sniff: 'nosniff',
			});
		}
	});

	test('returns rather than throws its redirects, query kept', async () => {
		const server = docsServer(sources);
		const lower = await server.resource(url('/pt-br/fixture-app/docs/index.md?x=1'));
		expect([lower.status, lower.headers.get('Location')]).toEqual([
			301,
			'/pt-BR/fixture-app/docs/index.md?x=1',
		]);
		const english = await server.resource(url('/EN/fixture-app/docs/llms.txt'));
		expect([english.status, english.headers.get('Location')]).toEqual([
			301,
			'/fixture-app/docs/llms.txt',
		]);
	});

	test('a raw page the config lists and the bundle lacks is a 404', async () => {
		const ahead = { ...site, pages: [...site.pages, 'guide/ghost'] };
		const response = await docsServer({ ...sources, configs: [ahead] }).resource(
			url('/fixture-app/docs/guide/ghost.md'),
		);
		expect(response.status).toBe(404);
	});

	test('an object the text glob lacks, cannot load, or hands over as something other than text, is a 500 naming it', async () => {
		const cases: [string, string, string][] = [
			['/fixture-app/docs/llms.txt', 'llms/en.txt', 'llms/en.txt'],
			[
				'/fixture-app/docs/guide/first-tag.md',
				'raw/en/guide/first-tag.md',
				'raw/en/guide/first-tag.md',
			],
			['/fixture-app/docs/llms-full.txt', 'raw/en/reference/api.md', 'raw/en/reference/api.md'],
		];
		for (const [path, object, named] of cases) {
			const key = globKey(site, object);
			const missing = { ...sources.text };
			delete missing[key];
			const rejecting = {
				...sources.text,
				[key]: async (): Promise<string> => {
					throw new Error('chunk gone');
				},
			};
			// What a glob written without `import: 'default'` resolves to: the module, not its text.
			const moduleObject = {
				...sources.text,
				[key]: async () => ({ default: await sources.text[key]?.() }),
			};
			for (const text of [missing, rejecting, moduleObject]) {
				const response = await docsServer({ ...sources, text }).resource(url(path));
				const body = await response.text();
				expect({ path, status: response.status, named: body.includes(named) }).toEqual({
					path,
					status: 500,
					named: true,
				});
			}
		}
	});

	test('resolves the compiler link tokens to the addresses this mount serves them at', async () => {
		// The compiler writes internal destinations as tokens because only the site knows the
		// locale prefix, the mount and the label. Planted here in one raw file so the
		// substitution is driven whatever the compiler in this tree writes.
		const key = globKey(site, 'raw/ja/guide/index.md');
		const asset = bundle.manifest.assets[0];
		const planted = [
			'# Planted',
			`See [the tag](${RAW_PAGE_LINK}guide/first-tag.md#reading) and [home](${RAW_PAGE_LINK}index.md).`,
			`![scan](${RAW_ASSET_LINK}${asset?.sha256}.${asset?.ext} "The scan sheet")`,
			'The scheme hexdocs:page/ in prose stays as it is written.',
			'',
		].join('\n');
		const server = docsServer({
			...sources,
			text: { ...sources.text, [key]: async () => planted },
		});
		const body = await (await server.resource(url('/ja/fixture-app/docs/guide/index.md'))).text();
		const label = site.versions.find((entry) => entry.default === true)?.label;
		expect(body).toBe(
			[
				'# Planted',
				'See [the tag](/ja/fixture-app/docs/guide/first-tag.md#reading) and [home](/ja/fixture-app/docs/index.md).',
				`![scan](/_docs/fixture-app/${label}/assets/${asset?.sha256}.${asset?.ext} "The scan sheet")`,
				'The scheme hexdocs:page/ in prose stays as it is written.',
				'',
			].join('\n'),
		);
		// The same substitution reaches llms-full, which is assembled from the same files.
		const full = await (await server.resource(url('/ja/fixture-app/docs/llms-full.txt'))).text();
		expect(full).toContain('[the tag](/ja/fixture-app/docs/guide/first-tag.md#reading)');
	});

	test('leaves no link token in any body it serves from the compiled bundle', async () => {
		const server = docsServer(sources);
		let served = 0;
		for (const locale of LOCALES) {
			const prefix = locale === 'en' ? '' : `/${locale}`;
			const paths = [
				`${prefix}/fixture-app/docs/llms.txt`,
				`${prefix}/fixture-app/docs/llms-full.txt`,
				...site.pages.map((slug) => `${prefix}/fixture-app/docs/${slug}.md`),
			];
			for (const path of paths) {
				const response = await server.resource(url(path));
				expect({ path, status: response.status }).toEqual({ path, status: 200 });
				expect((await response.text()).includes(`](${RAW_PAGE_LINK}`) || false).toBe(false);
				served += 1;
			}
		}
		expect(served).toBe(LOCALES.length * (site.pages.length + 2));
	});
});

describe('sitemap()', () => {
	test('lists every page but the hidden ones and the redirect sources, slashless, sorted', () => {
		const rows = docsServer(sources).sitemap();
		const hidden = new Set(site.hidden ?? []);
		expect(rows.map((row) => row.path)).toEqual(
			site.pages
				.filter((slug) => !hidden.has(slug))
				.map((slug) =>
					slug === 'index'
						? '/fixture-app/docs'
						: `/fixture-app/docs/${slug.replace(/\/?index$/, '')}`,
				)
				.sort(),
		);
		expect(rows.some((row) => row.path.endsWith('/api'))).toBe(false);
		expect(rows.some((row) => row.path.endsWith('first-tag') && !row.path.includes('guide'))).toBe(
			false,
		);
	});

	test('names each page in exactly the languages it is indexable in', () => {
		const rows = docsServer(sources).sitemap();
		for (const row of rows) {
			const slug =
				site.pages.find(
					(one) =>
						(one === 'index'
							? '/fixture-app/docs'
							: `/fixture-app/docs/${one.replace(/\/?index$/, '')}`) === row.path,
				) ?? '';
			expect({ path: row.path, languages: row.languages }).toEqual({
				path: row.path,
				languages: indexableLanguages(bundle.manifest.pages[slug] as PageRecord),
			});
		}
		// The page the corpus built for this: Spanish exists and is scaffolded, so it is out.
		const chip = rows.find((row) => row.path === '/fixture-app/docs/reference/chip-support');
		expect(chip?.languages).toEqual(['en', 'zh', 'ar', 'ja']);
	});

	test('weights the home above a section root above a leaf', () => {
		const rows = new Map(
			docsServer(sources)
				.sitemap()
				.map((row) => [row.path, row]),
		);
		expect(rows.get('/fixture-app/docs')?.priority).toBe('0.8');
		expect(rows.get('/fixture-app/docs/guide')?.priority).toBe('0.7');
		expect(rows.get('/fixture-app/docs/guide/first-tag')?.priority).toBe('0.6');
		expect([...rows.values()].every((row) => row.changefreq === 'monthly')).toBe(true);
	});

	test('a config with neither list, as sync writes it when there is nothing to list, hides and redirects nothing', async () => {
		// `hexdocs sync` omits both keys rather than writing empty ones.
		const bare = { ...site };
		delete bare.hidden;
		delete bare.redirects;
		const server = docsServer({ ...sources, configs: [bare] });
		expect(server.sitemap().map((row) => row.path)).toContain('/fixture-app/docs/reference/api');
		const retired = await thrown(server.page(url('/fixture-app/docs/first-tag')));
		expect(retired.status).toBe(404);
	});

	test('skips a page the config lists and the bundle lacks, which page() would 404', () => {
		const ahead = { ...site, pages: [...site.pages, 'guide/ghost'] };
		const rows = docsServer({ ...sources, configs: [ahead] }).sitemap();
		expect(rows.some((row) => row.path.endsWith('ghost'))).toBe(false);
	});

	test('covers every configured site', () => {
		const second = { ...site, basePath: '/second-app/docs' };
		const rows = docsServer({ ...sources, configs: [site, second] }).sitemap();
		expect(rows.filter((row) => row.path.startsWith('/second-app/')).length).toBe(
			rows.filter((row) => row.path.startsWith('/fixture-app/')).length,
		);
	});
});

describe('the languages a page names agree with the pages that are indexable', () => {
	test('for every page in every locale, a locale is named exactly when its page is served indexable', async () => {
		// Swept, with no pair picked by hand, because a hand-picked pair is how the scaffolded
		// Spanish chip matrix would have been named as an alternate while serving noindex.
		const server = docsServer(sources);
		let checked = 0;
		let excluded = 0;
		for (const slug of site.pages) {
			for (const locale of LOCALES) {
				const prefix = locale === 'en' ? '' : `/${locale}`;
				const path = slug === 'index' ? '' : `/${slug.replace(/\/?index$/, '')}`;
				const loaded = await server.page(url(`${prefix}/fixture-app/docs${path}`));
				expect({ slug, locale, named: loaded.seo.languages.includes(locale) }).toEqual({
					slug,
					locale,
					named: loaded.seo.indexable,
				});
				if (!loaded.seo.indexable) excluded += 1;
				checked += 1;
			}
		}
		// The pair the corpus built for this, named: Spanish exists and is scaffolded.
		const chip = await server.page(url('/es/fixture-app/docs/reference/chip-support'));
		expect([chip.seo.indexable, chip.seo.languages.includes('es')]).toEqual([false, false]);
		expect(checked).toBe(site.pages.length * LOCALES.length);
		// Both answers occur, or the agreement above is between two constants.
		expect(excluded).toBeGreaterThan(0);
		expect(excluded).toBeLessThan(checked);
	});

	test('names them in LOCALES order whatever order the record keys are in', () => {
		const record = bundle.manifest.pages['index'] as PageRecord;
		const reversed = Object.fromEntries(Object.entries(record.locales).reverse());
		expect(Object.keys(reversed)[0]).not.toBe('en');
		expect(indexableLanguages({ ...record, locales: reversed })).toEqual(
			LOCALES.filter((locale) => record.locales[locale] !== undefined),
		);
	});

	test('reads the effective state over the page own state', () => {
		// A page current in Japanese that includes a scaffolded snippet is served noindex, and
		// only `effective` says so without loading the payload.
		const record = bundle.manifest.pages['index'] as PageRecord;
		const ja = record.locales.ja as NonNullable<PageRecord['locales']['ja']>;
		const snippetScaffolded = {
			...record,
			locales: {
				...record.locales,
				ja: { ...ja, state: 'current' as const, effective: 'scaffolded' as const },
			},
		};
		expect(indexableLanguages(snippetScaffolded)).not.toContain('ja');
		expect(indexableLanguages(record)).toContain('ja');
	});
});
