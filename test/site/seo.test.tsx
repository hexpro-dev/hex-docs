/**
 * What the consuming site's root reads, through a real render.
 *
 * `docsSeoFromMatches` is three lines of logic, and the reason it is tested through React
 * Router rather than with hand-built arrays is the error render. Measured against hex-web's
 * installed handler: when the docs loader throws, or the `:lang` parent refuses the
 * language, the docs match is still in `useMatches()` with its handle and no data, and a root
 * that reads the data unguarded throws inside its own render. React Router answers that
 * with a plain-text 500: no HTML, no content security policy, for every mistyped docs URL.
 * A hand-built array says what the author believed the matches look like; this says what
 * the router hands the root.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { createStaticRouter, Outlet, StaticRouterProvider, useMatches } from 'react-router';
import { beforeAll, describe, expect, test } from 'vitest';

import { LOCALES } from '../../src/contracts/locales.js';
import { docsRouteRows } from '../../src/site/address.js';
import { DOCS_HANDLE, docsSeoFromMatches } from '../../src/site/seo.js';
import { docsServer, type DocsServer } from '../../src/site/serve.js';
import { fixtureBundle, fixtureSite, fixtureSources } from '../support/bundle.js';
import {
	createStaticHandler,
	dataRoutes,
	hexWebRoutes,
	langLoader,
	type RouteModule,
} from '../support/router.js';

/** What the root's layout does with the answer: writes it where the markup can be read. */
function Probe() {
	const seo = docsSeoFromMatches(useMatches());
	return <pre id="seo">{seo === undefined ? 'not a docs page' : JSON.stringify(seo)}</pre>;
}

let render: (path: string) => Promise<{ status: number; seo: string }>;
let DOCS: DocsServer;

beforeAll(() => {
	const bundle = fixtureBundle();
	// One page the config lists and the bundle lacks, so the docs loader itself throws a 404.
	const base = fixtureSite(bundle, '/hex-nfc/docs');
	const site = { ...base, pages: [...base.pages, 'guide/ghost'] };
	DOCS = docsServer({ ...fixtureSources(bundle, base), configs: [site] });
	const modules: Record<string, RouteModule> = {
		'root.tsx': {
			loader: () => null,
			Component: () => (
				<>
					<Probe />
					<Outlet />
				</>
			),
			ErrorBoundary: () => <Probe />,
		},
		'routes/lang.tsx': { loader: langLoader, Component: () => <Outlet /> },
		'routes/docs.tsx': {
			loader: ({ request }) => DOCS.page(new URL(request.url)),
			handle: DOCS_HANDLE,
			Component: () => <p>docs</p>,
		},
	};
	const routes = dataRoutes(hexWebRoutes(docsRouteRows([site])), modules);
	const handler = createStaticHandler(routes);
	render = async (path) => {
		const context = await handler.query(new Request(`http://docs.test${path}`));
		if (context instanceof Response)
			throw new Error(`${path} redirected to ${context.headers.get('Location')}`);
		const router = createStaticRouter(handler.dataRoutes, context);
		const html = renderToStaticMarkup(<StaticRouterProvider router={router} context={context} />);
		const seo = /<pre id="seo">([^<]*)<\/pre>/.exec(html)?.[1] ?? '(the probe did not render)';
		return { status: context.statusCode, seo: seo.replaceAll('&quot;', '"') };
	};
}, 60_000);

describe('docsSeoFromMatches, read by the root in a real render', () => {
	test('a docs page that loaded hands up its own answer', async () => {
		expect(await render('/hex-nfc/docs/guide/first-tag')).toEqual({
			status: 200,
			seo: JSON.stringify({ indexable: true, languages: [...LOCALES] }),
		});
		expect(await render('/fr/hex-nfc/docs/developer/architecture')).toEqual({
			status: 200,
			seo: JSON.stringify({ indexable: false, languages: ['en'] }),
		});
	});

	test('a docs loader that threw a 404 still has its match, and the root reads noindex', async () => {
		expect(await render('/hex-nfc/docs/guide/ghost')).toEqual({
			status: 404,
			seo: JSON.stringify({ indexable: false, languages: [] }),
		});
	});

	test('a language the :lang parent refused still has the docs match, and the root reads noindex', async () => {
		expect(await render('/banana/hex-nfc/docs/guide/first-tag')).toEqual({
			status: 404,
			seo: JSON.stringify({ indexable: false, languages: [] }),
		});
	});

	test('an address no route matched is not a docs page, and neither is the host own page', async () => {
		// The root keeps its own rule for both: a no-match is noindex there already, and a
		// host page answers from `LOCALISED_PATHS`.
		expect(await render('/hex-nfc/docs/typo')).toEqual({ status: 404, seo: 'not a docs page' });
		expect(await render('/hex-nfc')).toEqual({ status: 200, seo: 'not a docs page' });
	});
});

describe('docsSeoFromMatches, on the shapes a render cannot produce', () => {
	const seo = { indexable: true, languages: ['en', 'ja'] };

	test('recognises the handle by value, so one that crossed the wire as data still matches', () => {
		expect(docsSeoFromMatches([{ handle: { hexdocs: 1 }, data: { seo } }])).toEqual(seo);
		expect(Object.isFrozen(DOCS_HANDLE)).toBe(true);
	});

	test('ignores a handle that is not the docs handle', () => {
		for (const handle of [undefined, null, 'hexdocs', 1, { hexdocs: 2 }, { hexdocs: '1' }]) {
			expect(docsSeoFromMatches([{ handle, data: { seo } }])).toBeUndefined();
		}
	});

	test('fails closed on data that is not an SEO answer', () => {
		const closed = { indexable: false, languages: [] };
		for (const data of [
			undefined,
			null,
			'page',
			{},
			{ seo: null },
			{ seo: 'yes' },
			{ seo: { indexable: 'true', languages: [] } },
			{ seo: { indexable: true } },
			{ seo: { indexable: true, languages: 'en' } },
			{ seo: { indexable: true, languages: ['en', 'hi'] } },
		]) {
			expect(docsSeoFromMatches([{ handle: DOCS_HANDLE, data }])).toEqual(closed);
		}
	});

	test('reads the deepest docs match, and hands back a copy of its languages', () => {
		const outer = { indexable: false, languages: ['en'] };
		const languages = ['en', 'zh'];
		const inner = { indexable: true, languages };
		const read = docsSeoFromMatches([
			{ handle: DOCS_HANDLE, data: { seo: outer } },
			{ handle: undefined, data: undefined },
			{ handle: DOCS_HANDLE, data: { seo: inner } },
		]);
		expect(read).toEqual(inner);
		expect(read?.languages).not.toBe(languages);
	});
});
