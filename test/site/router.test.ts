/**
 * The route rows, in hex-web's table, through the installed React Router, answering real
 * requests from the fixture bundle.
 *
 * Every assertion names the route a URL reached and what the loaders did with it, because
 * both halves have failed separately before: step 5's `*.md` rows reached no route at all,
 * and a row that reaches the right module is still wrong if the module answers the address
 * with somebody else's language.
 *
 * The site is mounted at `/hex-nfc/docs` rather than at the fixture config's own mount, so
 * the host's `/hex-nfc` and `/hex-nfc/costs` pages sit beside the docs rows exactly as they
 * will in hex-web, and a docs row that swallowed either would show here.
 */

import { matchRoutes } from 'react-router';
import { beforeAll, describe, expect, test } from 'vitest';

import { DOCS_MACHINE_MODULE, docsRouteRows, type DocsRouteRow } from '../../src/site/address.js';
import { DOCS_HANDLE } from '../../src/site/seo.js';
import { docsServer, type DocsServer } from '../../src/site/serve.js';
import {
	fixtureBundle,
	fixtureSite,
	fixtureSources,
	type FixtureBundle,
} from '../support/bundle.js';
import {
	createStaticHandler,
	dataRoutes,
	dispatch,
	hexWebRoutes,
	langLoader,
	type Answer,
	type RouteModule,
} from '../support/router.js';

const BASE = '/hex-nfc/docs';

let bundle: FixtureBundle;
let DOCS: DocsServer;
let ROWS: DocsRouteRow[];
let run: (url: string) => Promise<Answer>;

beforeAll(() => {
	bundle = fixtureBundle();
	const site = fixtureSite(bundle, BASE);
	DOCS = docsServer(fixtureSources(bundle, site));
	ROWS = docsRouteRows([site]);
	const modules: Record<string, RouteModule> = {
		'routes/lang.tsx': { loader: langLoader, Component: () => null },
		'routes/docs.tsx': {
			loader: ({ request }) => DOCS.page(new URL(request.url)),
			handle: DOCS_HANDLE,
			Component: () => null,
		},
		// No default export, which is what makes it a resource route.
		'routes/docs.machine.tsx': { loader: ({ request }) => DOCS.resource(new URL(request.url)) },
	};
	const routes = dataRoutes(hexWebRoutes(ROWS), modules);
	const handler = createStaticHandler(routes);
	run = (url) => dispatch(handler, routes, url);
}, 60_000);

/** The parts of an answer a row of the table below states. */
function summary(answer: Answer): Omit<Answer, 'body'> {
	const { body: _body, ...rest } = answer;
	return rest;
}

const PLAIN = 'text/plain; charset=utf-8';
const MARKDOWN = 'text/markdown; charset=utf-8';

describe('the URL table', () => {
	// [url, what the router and the loaders answer]. Written out whole, one row per address,
	// so a changed answer names its address.
	const table: [string, Omit<Answer, 'body'>][] = [
		// The docs home, a leaf and a section root, each with and without a trailing slash.
		['/hex-nfc/docs', { route: 'en/hex-nfc/docs', status: 200, indexable: true }],
		['/hex-nfc/docs/', { route: 'en/hex-nfc/docs', status: 200, indexable: true }],
		[
			'/hex-nfc/docs/guide/first-tag',
			{ route: 'en/hex-nfc/docs/guide/first-tag', status: 200, indexable: true },
		],
		[
			'/hex-nfc/docs/guide/first-tag/',
			{ route: 'en/hex-nfc/docs/guide/first-tag', status: 200, indexable: true },
		],
		['/hex-nfc/docs/guide', { route: 'en/hex-nfc/docs/guide', status: 200, indexable: true }],
		['/hex-nfc/docs/guide/', { route: 'en/hex-nfc/docs/guide', status: 200, indexable: true }],
		// A hidden page is published and indexable; only the sidebar and the sitemap skip it.
		[
			'/hex-nfc/docs/reference/api',
			{ route: 'en/hex-nfc/docs/reference/api', status: 200, indexable: true },
		],
		// Served, and not indexable at a spelling that is not the canonical one.
		[
			'/HEX-NFC/Docs/Guide/First-Tag',
			{ route: 'en/hex-nfc/docs/guide/first-tag', status: 200, indexable: false },
		],

		// A mistyped page reaches no route, so it gets the site's own 404 and no docs loader
		// runs. So do the retired `search.json`, a pinned version and every `.md` that is not
		// a page's.
		['/hex-nfc/docs/typo', { route: null, status: 404 }],
		['/hex-nfc/docs/search.json', { route: null, status: 404 }],
		['/hex-nfc/docs/v/1.0.0/', { route: null, status: 404 }],
		['/hex-nfc/docs/v/1.0.0/guide/first-tag', { route: null, status: 404 }],
		['/hex-nfc/docs/typo.md', { route: null, status: 404 }],
		['/hex-nfc/docs/*.md', { route: null, status: 404 }],
		['/hex-nfc/docs/%2A.md', { route: null, status: 404 }],
		['/hex-nfc/docs/guide.md', { route: null, status: 404 }],

		// The `:lang` mount. The page loader and `lang.tsx` both run, and the host's answer
		// wins wherever it has one.
		[
			'/ja/hex-nfc/docs/guide/first-tag',
			{ route: 'lang/hex-nfc/docs/guide/first-tag', status: 200, indexable: true },
		],
		[
			'/fr/hex-nfc/docs/developer/architecture',
			{ route: 'lang/hex-nfc/docs/developer/architecture', status: 200, indexable: false },
		],
		[
			'/es/hex-nfc/docs/reference/chip-support',
			{ route: 'lang/hex-nfc/docs/reference/chip-support', status: 200, indexable: false },
		],
		[
			'/banana/hex-nfc/docs/guide/first-tag',
			{ route: 'lang/hex-nfc/docs/guide/first-tag', status: 404 },
		],
		[
			'/en/hex-nfc/docs/guide',
			{ route: 'lang/hex-nfc/docs/guide', status: 301, location: '/hex-nfc/docs/guide' },
		],
		[
			'/JA/hex-nfc/docs/guide',
			{ route: 'lang/hex-nfc/docs/guide', status: 301, location: '/ja/hex-nfc/docs/guide' },
		],

		// A renamed page, at both mounts, in one hop to the new name in the reader's language.
		[
			'/hex-nfc/docs/first-tag',
			{
				route: 'en/hex-nfc/docs/first-tag',
				status: 301,
				location: '/hex-nfc/docs/guide/first-tag',
			},
		],
		[
			'/ja/hex-nfc/docs/first-tag?ref=mail',
			{
				route: 'lang/hex-nfc/docs/first-tag',
				status: 301,
				location: '/ja/hex-nfc/docs/guide/first-tag?ref=mail',
			},
		],
		// The host fixes the casing first, and the next request follows the rename.
		[
			'/pt-br/hex-nfc/docs/first-tag',
			{
				route: 'lang/hex-nfc/docs/first-tag',
				status: 301,
				location: '/pt-BR/hex-nfc/docs/first-tag',
			},
		],
		[
			'/pt-BR/hex-nfc/docs/first-tag',
			{
				route: 'lang/hex-nfc/docs/first-tag',
				status: 301,
				location: '/pt-BR/hex-nfc/docs/guide/first-tag',
			},
		],

		// The machine endpoints at both mounts, validating the language themselves.
		[
			'/hex-nfc/docs/llms.txt',
			{
				route: 'docs:/hex-nfc/docs/llms.txt',
				status: 200,
				contentType: PLAIN,
				contentLanguage: 'en',
			},
		],
		[
			'/ja/hex-nfc/docs/llms.txt',
			{
				route: 'docs:/:lang/hex-nfc/docs/llms.txt',
				status: 200,
				contentType: PLAIN,
				contentLanguage: 'ja',
			},
		],
		[
			'/hex-nfc/docs/llms-full.txt',
			{
				route: 'docs:/hex-nfc/docs/llms-full.txt',
				status: 200,
				contentType: PLAIN,
				contentLanguage: 'en',
			},
		],
		[
			'/ja/hex-nfc/docs/llms-full.txt',
			{
				route: 'docs:/:lang/hex-nfc/docs/llms-full.txt',
				status: 200,
				contentType: PLAIN,
				contentLanguage: 'en, ja',
			},
		],
		[
			'/banana/hex-nfc/docs/llms.txt',
			{ route: 'docs:/:lang/hex-nfc/docs/llms.txt', status: 404, contentType: PLAIN },
		],
		[
			'/zh-hans/hex-nfc/docs/llms.txt',
			{ route: 'docs:/:lang/hex-nfc/docs/llms.txt', status: 404, contentType: PLAIN },
		],
		[
			'/EN/hex-nfc/docs/llms.txt',
			{
				route: 'docs:/:lang/hex-nfc/docs/llms.txt',
				status: 301,
				location: '/hex-nfc/docs/llms.txt',
			},
		],

		// Raw markdown at depth one and two, at both mounts, falling back per page.
		[
			'/hex-nfc/docs/index.md',
			{
				route: 'docs:/hex-nfc/docs/index.md',
				status: 200,
				contentType: MARKDOWN,
				contentLanguage: 'en',
			},
		],
		[
			'/hex-nfc/docs/guide/first-tag.md',
			{
				route: 'docs:/hex-nfc/docs/guide/first-tag.md',
				status: 200,
				contentType: MARKDOWN,
				contentLanguage: 'en',
			},
		],
		[
			'/ja/hex-nfc/docs/guide/index.md',
			{
				route: 'docs:/:lang/hex-nfc/docs/guide/index.md',
				status: 200,
				contentType: MARKDOWN,
				contentLanguage: 'ja',
			},
		],
		[
			'/ja/hex-nfc/docs/developer/architecture.md',
			{
				route: 'docs:/:lang/hex-nfc/docs/developer/architecture.md',
				status: 200,
				contentType: MARKDOWN,
				contentLanguage: 'en',
			},
		],
		[
			'/pt-br/hex-nfc/docs/index.md?x=1',
			{
				route: 'docs:/:lang/hex-nfc/docs/index.md',
				status: 301,
				location: '/pt-BR/hex-nfc/docs/index.md?x=1',
			},
		],

		// The host's own pages beside the mount, untouched.
		['/hex-nfc', { route: 'en/hex-nfc', status: 200 }],
		['/hex-nfc/costs', { route: 'en/hex-nfc/costs', status: 200 }],
		['/ja/hex-nfc', { route: 'lang/hex-nfc', status: 200 }],
	];

	test.each(table)('%s', async (url, expected) => {
		expect(summary(await run(url))).toEqual(expected);
	});

	test('every address reaches the same route with the docs rows declared in the opposite order', () => {
		const reversed = [...ROWS].reverse();
		for (const [address, expected] of table) {
			expect({ address, route: leafOf(reversed, address) }).toEqual({
				address,
				route: expected.route,
			});
		}
	});
});

/** The leaf route id a URL reaches through hex-web's table over these rows, or null. */
function leafOf(rows: readonly DocsRouteRow[], address: string): string | null {
	const pathname = new URL(address, 'http://docs.test').pathname;
	const matches = matchRoutes(dataRoutes(hexWebRoutes(rows), {}), pathname);
	return (matches?.at(-1)?.route.id as string | undefined) ?? null;
}

describe('the declaration order of the rows', () => {
	test('decides nothing where a :lang row and a static row both match one URL', () => {
		// A mount at `/docs` with a page at `docs/index`. `/docs/docs` is that page's own
		// address and also the docs home under the `:lang` parent with `lang` set to `docs`,
		// and the raw rows overlap the same way. Neither consumer mounts there today, and a
		// mount named after the thing it holds is the obvious one to reach for.
		const site = { ...fixtureSite(bundle, '/docs'), pages: ['index', 'docs/index'] };
		const rows = docsRouteRows([site]);
		// [address, the static row's path, the route it reaches, the route the `:lang` row reaches]
		const cases: [string, string, string, string][] = [
			['/docs/docs', '/docs/docs', 'en/docs/docs', 'lang/docs'],
			[
				'/docs/docs/index.md',
				'/docs/docs/index.md',
				'docs:/docs/docs/index.md',
				'docs:/:lang/docs/index.md',
			],
		];
		for (const [address, path, route, shadowed] of cases) {
			expect(leafOf(rows, address)).toBe(route);
			expect(leafOf([...rows].reverse(), address)).toBe(route);
			// The `:lang` row matches on its own, so the two answers above are an overlap the
			// score settled rather than two rows that never met.
			expect(
				leafOf(
					rows.filter((row) => row.path !== path),
					address,
				),
			).toBe(shadowed);
		}
	});

	test('can be seen to matter, so the comparison above is not between two constants', () => {
		// Two rows that tie on score and match the same URL. React Router takes the first one
		// declared, which is the property `docsRouteRows` never relies on.
		const planted: DocsRouteRow = {
			path: '/:other/hex-nfc/docs/llms.txt',
			file: DOCS_MACHINE_MODULE,
			kind: 'machine',
			id: 'docs:planted',
		};
		const rows = [...ROWS, planted];
		const address = '/ja/hex-nfc/docs/llms.txt';
		expect(leafOf(rows, address)).toBe('docs:/:lang/hex-nfc/docs/llms.txt');
		expect(leafOf([...rows].reverse(), address)).toBe('docs:planted');
	});
});

describe('a bundle that cannot be served, through the handler', () => {
	test('answers the page with a 500 the root boundary renders, and the resource with a plain 500', async () => {
		// `serve.test.ts` drives every refusal against the server directly. This is the same
		// refusal through React Router, which is where a thrown `Response` becomes a status
		// rather than an exception, and where a thrown `TypeError` would have become a 500 that
		// says nothing.
		const site = fixtureSite(bundle, BASE);
		const broken = docsServer({ ...fixtureSources(bundle, site), manifests: {} });
		const modules: Record<string, RouteModule> = {
			'routes/lang.tsx': { loader: langLoader, Component: () => null },
			'routes/docs.tsx': {
				loader: ({ request }) => broken.page(new URL(request.url)),
				Component: () => null,
			},
			'routes/docs.machine.tsx': { loader: ({ request }) => broken.resource(new URL(request.url)) },
		};
		const routes = dataRoutes(hexWebRoutes(docsRouteRows([site])), modules);
		const handler = createStaticHandler(routes);
		expect(summary(await dispatch(handler, routes, '/ja/hex-nfc/docs/guide'))).toEqual({
			route: 'lang/hex-nfc/docs/guide',
			status: 500,
		});
		const resource = await dispatch(handler, routes, '/hex-nfc/docs/llms.txt');
		expect([resource.status, resource.contentType]).toEqual([500, PLAIN]);
		expect(resource.body).toContain('hexdocs prefetch');
	});
});

describe('the rows in the table', () => {
	test('load without an id collision, and only because the machine rows carry ids', () => {
		// `matchRoutes` resolves a table with duplicate ids without complaint; the route
		// config loader and `createStaticHandler` both refuse it. Every machine row shares
		// `routes/docs.machine.tsx`, so without its own id each one takes the module path.
		expect(() => createStaticHandler(dataRoutes(hexWebRoutes(ROWS), {}))).not.toThrow();
		expect(() =>
			createStaticHandler(dataRoutes(hexWebRoutes(ROWS, { machineIds: false }), {})),
		).toThrow(/route id collision on id "routes\/docs\.machine"/);
	});

	test('every link in every llms.txt reaches a raw row at the mount it is served from, and answers 200', async () => {
		// `llms.txt` links relative to its own address, so the link and the row have to agree
		// on the wire-slug spelling. The home is `index.md` and a section root keeps its
		// `index`; the address path would make them `.md` and `guide.md`, which reach nothing.
		let checked = 0;
		for (const locale of bundle.manifest.locales) {
			const served = locale === 'en' ? `${BASE}/llms.txt` : `/${locale}${BASE}/llms.txt`;
			const answer = await run(served);
			expect({ served, status: answer.status }).toEqual({ served, status: 200 });
			const links = [...(answer.body ?? '').matchAll(/\]\(([^)]+)\)/g)].map(
				(match) => match[1] as string,
			);
			expect(links.length, `${served} carries no links`).toBe(bundle.manifest.llmsOrder.length);
			for (const link of links) {
				const target = new URL(link, `http://docs.test${served}`).pathname;
				const reached = await run(target);
				expect({ link, served, route: reached.route, status: reached.status }).toEqual({
					link,
					served,
					route: `docs:${locale === 'en' ? '' : '/:lang'}${BASE}/${link}`,
					status: 200,
				});
				checked += 1;
			}
		}
		expect(checked).toBe(bundle.manifest.locales.length * bundle.manifest.llmsOrder.length);
	});

	test('every link and image in every served markdown body and llms-full.txt resolves to something the site serves', async () => {
		// The seam between the compiler and this server. A raw page is the author's markdown
		// with its includes expanded, so a destination the author wrote relative to the source
		// file is wrong the moment it is served somewhere else: an image path is not an
		// address at all, and a relative link inside llms-full.txt resolves against the mount
		// rather than against the page it came from. The compiler writes resolved destinations
		// as tokens and `resource()` substitutes them; this resolves every destination in every
		// served body against the URL it was served at and follows it.
		const label = fixtureSite(bundle, BASE).versions.find((entry) => entry.default === true)?.label;
		const assets = `/_docs/fixture-app/${label}/assets/`;
		const published = new Set(
			bundle.manifest.assets.map((asset) => `${asset.sha256}.${asset.ext}`),
		);
		const broken: string[] = [];
		let followed = 0;
		for (const locale of bundle.manifest.locales) {
			const prefix = locale === 'en' ? '' : `/${locale}`;
			const served = [
				`${prefix}${BASE}/llms-full.txt`,
				...bundle.manifest.llmsOrder.map((slug) => `${prefix}${BASE}/${slug}.md`),
			];
			for (const address of served) {
				const body = withoutCode((await run(address)).body ?? '');
				for (const [, destination] of body.matchAll(/\]\(\s*<?([^\s)>]+)/g)) {
					const target = destination as string;
					if (target.startsWith('#') || /^(https?|mailto):/.test(target)) continue;
					const path = new URL(target, `http://docs.test${address}`).pathname;
					followed += 1;
					if (path.startsWith(assets)) {
						if (!published.has(path.slice(assets.length))) broken.push(`${address}: ${target}`);
						continue;
					}
					const reached = await run(path);
					if (reached.route === null || reached.status !== 200)
						broken.push(`${address}: ${target} -> ${path}`);
				}
			}
		}
		expect(broken).toEqual([]);
		expect(followed).toBeGreaterThan(0);
	});
});

/**
 * A markdown body with its fenced blocks and code spans removed, because a destination
 * written inside code is text and is left exactly as written.
 */
function withoutCode(markdown: string): string {
	const kept: string[] = [];
	let fence: string | undefined;
	for (const line of markdown.split('\n')) {
		const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence === undefined && marker !== undefined) {
			fence = marker;
			continue;
		}
		if (fence !== undefined) {
			if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length)
				fence = undefined;
			continue;
		}
		kept.push(line.replace(/(`+)[^`]*?\1/g, ''));
	}
	return kept.join('\n');
}
