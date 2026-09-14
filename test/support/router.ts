/**
 * A consuming site's route table, built the way hex-web builds it, and run through the
 * installed React Router.
 *
 * Step 5's route rows passed every text-based test while React Router matched `*.md` only
 * as its own literal spelling and threw on a duplicate id at config load. Both failures are
 * properties of the router, so the only test worth having runs the router: `matchRoutes` to
 * say which row a URL reaches, and `createStaticHandler` to say what the loaders answer and
 * to refuse a table with two routes under one id, which `matchRoutes` alone never does.
 *
 * Two pieces are transcribed rather than imported, and each says what it copies:
 *
 * - `route` and `index` are `@react-router/dev/routes`, which is not installed here. They
 *   pass `path`, `id`, `index` and `caseSensitive` through untouched, a trailing slash and
 *   an asterisk included, and the id defaults to the module path without its extension,
 *   which is what makes two machine rows sharing one module collide.
 * - `hexWebRoutes` is the shape of hex-web's `app/routes.ts`: pages registered in a tuple
 *   and mounted twice by `pages("en/")` and `pages("lang/")`, `robots.txt` and
 *   `sitemap.xml` top level, and the `:lang` parent whose loader is `routes/lang.tsx`. The
 *   docs rows go in the two ways the install instruction prints: page rows into the
 *   registry, machine rows top level with their own id.
 */

import {
	createStaticHandler,
	matchRoutes,
	redirect,
	type LoaderFunctionArgs,
	type RouteObject,
	type StaticHandler,
} from 'react-router';

import { LOCALES, SOURCE_LOCALE } from '../../src/contracts/locales.js';
import type { DocsRouteRow } from '../../src/site/address.js';

export interface RouteConfigEntry {
	id?: string;
	path?: string;
	index?: boolean;
	caseSensitive?: boolean;
	file: string;
	children?: RouteConfigEntry[];
}

type RouteOptions = { id?: string; index?: boolean; caseSensitive?: boolean };

/** `route()` from `@react-router/dev/routes` 7.13, transcribed. */
export function route(
	path: string | null | undefined,
	file: string,
	optionsOrChildren?: RouteOptions | RouteConfigEntry[],
	children?: RouteConfigEntry[],
): RouteConfigEntry {
	let options: RouteOptions = {};
	let nested = children;
	if (Array.isArray(optionsOrChildren) || optionsOrChildren === undefined) {
		nested = optionsOrChildren;
	} else {
		options = optionsOrChildren;
	}
	const picked: RouteOptions = {};
	for (const key of ['id', 'index', 'caseSensitive'] as const) {
		if (key in options) Object.assign(picked, { [key]: options[key] });
	}
	return { file, children: nested, path: path ?? undefined, ...picked };
}

/** `index()` from the same module. */
export function index(file: string, options: { id?: string } = {}): RouteConfigEntry {
	return { file, index: true, ...('id' in options ? { id: options.id } : {}) };
}

/**
 * hex-web's `app/routes.ts`, with the docs rows spliced in.
 *
 * `machineIds` exists for the one test that takes the ids away, to show what they are for.
 */
export function hexWebRoutes(
	docs: readonly DocsRouteRow[],
	{ machineIds = true }: { machineIds?: boolean } = {},
): RouteConfigEntry[] {
	const PAGES: [path: string, file: string][] = [
		['hex-nfc', 'routes/hex-nfc.tsx'],
		['hex-nfc/costs', 'routes/hex-nfc.costs.tsx'],
		...docs
			.filter((row) => row.kind === 'page')
			.map((row) => [row.path.slice(1), row.file] as [string, string]),
	];
	const pages = (idPrefix: string): RouteConfigEntry[] => [
		index('routes/home.tsx', { id: `${idPrefix}home` }),
		...PAGES.map(([path, file]) => route(path, file, { id: `${idPrefix}${path}` })),
	];
	return [
		...pages('en/'),
		route('robots.txt', 'routes/robots[.]txt.tsx'),
		route('sitemap.xml', 'routes/sitemap[.]xml.tsx'),
		...docs
			.filter((row) => row.kind === 'machine')
			.map((row) => route(row.path.slice(1), row.file, machineIds ? { id: row.id } : {})),
		route(':lang', 'routes/lang.tsx', pages('lang/')),
	];
}

/** What a route module exports, as far as the router is concerned. */
export interface RouteModule {
	loader?: (args: LoaderFunctionArgs) => unknown;
	/** A default export. Without one a leaf is a resource route. */
	Component?: () => unknown;
	ErrorBoundary?: () => unknown;
	handle?: unknown;
}

/**
 * hex-web's `routes/lang.tsx` loader, transcribed: 404 an unknown language, 301 `en` to the
 * bare path, 301 a wrong casing, and keep the query string on both.
 */
export function langLoader({ params, request }: LoaderFunctionArgs): Response | null {
	const segment = params.lang ?? '';
	const lang = LOCALES.find((code) => code.toLowerCase() === segment.toLowerCase());
	if (lang === undefined) throw new Response('Not Found', { status: 404 });
	const url = new URL(request.url);
	const rest = url.pathname.split('/').filter(Boolean).slice(1).join('/');
	if (lang === SOURCE_LOCALE) return redirect(`/${rest}${url.search}`, 301);
	if (segment !== lang) return redirect(`/${lang}${rest ? `/${rest}` : ''}${url.search}`, 301);
	return null;
}

const stub = (): null => null;

/**
 * The config entries as data routes, under a root, with each file's module attached.
 *
 * The root is `id: "root"` with an empty path, which is what framework mode puts above
 * `routes.ts`. The id of an entry without one is its file without the extension, which is
 * `createRouteId` in `@react-router/dev`.
 */
export function dataRoutes(
	entries: readonly RouteConfigEntry[],
	modules: Record<string, RouteModule>,
): RouteObject[] {
	const convert = (entry: RouteConfigEntry): RouteObject => {
		const module = modules[entry.file] ?? { loader: stub, Component: stub };
		const id = entry.id ?? entry.file.replace(/\.[a-z0-9]+$/i, '');
		const base = {
			id,
			caseSensitive: entry.caseSensitive,
			loader: module.loader,
			handle: module.handle,
			Component: module.Component as RouteObject['Component'],
			ErrorBoundary: module.ErrorBoundary as RouteObject['ErrorBoundary'],
		};
		return entry.index === true
			? { ...base, index: true }
			: { ...base, path: entry.path, children: entry.children?.map(convert) };
	};
	const root = modules['root.tsx'] ?? { loader: stub, Component: stub };
	return [
		{
			id: 'root',
			path: '',
			loader: root.loader,
			Component: root.Component as RouteObject['Component'],
			ErrorBoundary: root.ErrorBoundary as RouteObject['ErrorBoundary'],
			children: entries.map(convert),
		},
	];
}

export interface Answer {
	/** The leaf route id `matchRoutes` reached, or null for no match. */
	route: string | null;
	status: number;
	location?: string;
	contentType?: string;
	contentLanguage?: string;
	/** For a page: whether the docs loader said indexable. */
	indexable?: boolean;
	body?: string;
}

/**
 * One request, dispatched the way the server handler does it.
 *
 * A leaf whose module has no default export goes to `queryRoute`, which runs that route's
 * loader alone; everything else goes to `query`, which runs every matched loader. No match
 * is a 404 before any loader runs, the root's included.
 */
export async function dispatch(
	handler: StaticHandler,
	routes: RouteObject[],
	url: string,
): Promise<Answer> {
	const request = new Request(new URL(url, 'http://docs.test'));
	const matches = matchRoutes(routes, new URL(request.url).pathname);
	if (matches === null) return { route: null, status: 404 };
	const leaf = matches[matches.length - 1]?.route as RouteObject;
	const id = leaf.id as string;

	if (leaf.Component === undefined) {
		const response = (await handler.queryRoute(request, { routeId: id })) as Response;
		return {
			route: id,
			status: response.status,
			...(response.headers.has('Location')
				? { location: response.headers.get('Location') as string }
				: {}),
			...(response.headers.has('Content-Type')
				? { contentType: response.headers.get('Content-Type') as string }
				: {}),
			...(response.headers.has('Content-Language')
				? { contentLanguage: response.headers.get('Content-Language') as string }
				: {}),
			body: await response.text(),
		};
	}

	const result = await handler.query(request);
	if (result instanceof Response) {
		return { route: id, status: result.status, location: result.headers.get('Location') as string };
	}
	const data = result.loaderData[id] as { seo?: { indexable: boolean } } | undefined;
	return {
		route: id,
		status: result.statusCode,
		...(data?.seo === undefined ? {} : { indexable: data.seo.indexable }),
	};
}

export { createStaticHandler };
