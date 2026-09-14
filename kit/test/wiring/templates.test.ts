/**
 * The files `install` writes and the code it prints, read for the properties a consumer's
 * build depends on.
 *
 * Each of these is a property a green wiring row once stood over while the site could not
 * build. The server module imported `@hex-pro/docs`, which React Router's plugin-less route
 * config loader cannot resolve. The machine spread passed no route id, which that loader
 * refuses as a duplicate. A route module with a default export turns a resource route into a
 * document route. They are asserted on the generated text for both consumers, because the
 * relative depth of the one value import differs between them.
 *
 * What the text alone cannot show was run once for real and is recorded rather than
 * re-proved here: both consumers' own `react-router routes --json` loaded their real route
 * configs with these modules and the printed instructions in place, and kcalc's own eslint
 * passed all four templates with `--max-warnings 0`.
 */

import { describe, expect, test } from 'vitest';

import { BUNDLE_TREE, PUBLIC_TREE } from '../../../src/contracts/manifest.js';
import { detectSite, memoryFiles } from '../../src/wiring/detect.js';
import {
	PRESENT,
	docsServerProblems,
	routeModuleProblems,
	rootSeoProblems,
	sitemapProblems,
} from '../../src/wiring/edits.js';
import {
	DOCS_PAGES_HELPER,
	MACHINE_ROUTES_SPREAD,
	PAGE_TUPLES_SPREAD,
	ROOT_DECISION,
	ROUTES_IMPORT,
	SITEMAP_IMPORT,
	rootInstruction,
	routesChanges,
	routesInstruction,
	sitemapDocsBlock,
	sitemapInstruction,
} from '../../src/wiring/instructions.js';
import { exportsDefault, exportsHeaders, valueImportSpecifiers } from '../../src/wiring/needles.js';
import {
	DOCS_SERVER_MODULE,
	joinPosix,
	resolveFrom,
	type SiteDescriptor,
} from '../../src/wiring/site.js';
import {
	GITIGNORE_ENTRIES,
	docsMachineRouteModule,
	docsPageRouteModule,
	docsServerModule,
	packageIndexFrom,
} from '../../src/wiring/templates.js';

const SITES: readonly SiteDescriptor[] = [
	detectSite({ repoRoot: '/r', site: 'apps/front', mount: 'common/docs', files: memoryFiles({}) }),
	detectSite({
		repoRoot: '/r',
		site: 'kcalc-web/front',
		mount: 'kcalc-web/docs',
		files: memoryFiles({}),
	}),
];

const ascii = (text: string): string => text.replace(/[\t\n\x20-\x7e]/g, '');

describe('the server module', () => {
	test.each(SITES.map((site) => [site.site, site] as const))(
		'%s: every value import is relative, extensionless and reaches the package index',
		(_name, site) => {
			const text = docsServerModule(site);
			const specifiers = valueImportSpecifiers(text);
			expect(specifiers.length).toBeGreaterThan(0);
			for (const specifier of specifiers) {
				expect(specifier.startsWith('.'), `${specifier} is not relative`).toBe(true);
				expect(specifier, `${specifier} carries an extension`).not.toMatch(/\.[a-z]+$/);
				// Resolved from the file's own directory, it is the package's node-safe barrel.
				const from = joinPosix(site.site, 'app/lib');
				expect(resolveFrom(from, specifier)).toBe(joinPosix(site.mount, 'src/index'));
			}
			expect(packageIndexFrom(site, DOCS_SERVER_MODULE)).toBe(specifiers[0]);
			expect(text).not.toContain('from "@hex-pro/docs"');
		},
	);

	test.each(SITES.map((site) => [site.site, site] as const))(
		'%s: the globs are literal and name the bundle tree the contract names',
		(_name, site) => {
			const text = docsServerModule(site);
			const globs = [...text.matchAll(/"(\.\.\/docs\/[^"]+)"/g)].map((match) => match[1]);
			expect(globs).toEqual([
				'../docs/*.docs.json',
				`../docs/${BUNDLE_TREE}/*/*/manifest.json`,
				`../docs/${BUNDLE_TREE}/*/*/pages/**/*.json`,
				`../docs/${BUNDLE_TREE}/*/*/raw/**/*.md`,
				`../docs/${BUNDLE_TREE}/*/*/llms/*.txt`,
			]);
			// The raw and llms text arrives as strings, which is the type the server's sources take.
			expect(text).toContain('import.meta.glob<string>(');
			expect(text).toContain('query: "?raw"');
		},
	);

	test.each(SITES.map((site) => [site.site, site] as const))(
		'%s: satisfies its own predicate, and is pure ASCII',
		(_name, site) => {
			const text = docsServerModule(site);
			expect(docsServerProblems(text)).toEqual([]);
			expect(PRESENT.docsServer(text)).toBe(true);
			expect(ascii(text)).toBe('');
		},
	);

	test('an aliased import is named by the predicate, whatever else the module does', () => {
		const text = docsServerModule(SITES[0] as SiteDescriptor).replace(
			/from "[^"]*src\/index";\nimport type/,
			'from "@hex-pro/docs";\nimport type',
		);
		expect(docsServerProblems(text)).toEqual([
			"imports `@hex-pro/docs` for its value, which React Router's route config loader cannot resolve: it runs with no Vite plugins, so only a relative path reaches the package.",
		]);
		// A type-only import is erased before anything resolves it, so it is not refused.
		const typeOnly = docsServerModule(SITES[0] as SiteDescriptor).replace(
			/import type \{ DocsSiteConfig \} from "[^"]*";/,
			'import type { DocsSiteConfig } from "@hex-pro/docs";',
		);
		expect(docsServerProblems(typeOnly)).toEqual([]);
	});

	test('the predicate names each missing piece', () => {
		expect(docsServerProblems('export const DOCS_SITES = [];\n')).toEqual([
			'does not call `docsServer(`.',
			'does not call `docsRouteRows(`.',
			'does not export `DOCS_ROUTES`.',
			'does not export `DOCS`.',
		]);
	});
});

describe('the route modules', () => {
	test('the page module reads DOCS.page, exports the handle and a component, and no headers', () => {
		const text = docsPageRouteModule();
		expect(routeModuleProblems('page', text)).toEqual([]);
		expect(PRESENT.pageRouteModule(text)).toBe(true);
		expect(exportsDefault(text)).toBe(true);
		expect(exportsHeaders(text)).toBe(false);
		expect(valueImportSpecifiers(text)).toContain('../lib/docs.server');
		// root.tsx owns robots, the canonical and the alternates, so meta names nothing else.
		expect(text.replace(/^\/\/.*$/gm, '')).not.toMatch(/robots|canonical|alternate/i);
		expect(ascii(text)).toBe('');
	});

	test('the machine module reads DOCS.resource and has no default export and no headers', () => {
		const text = docsMachineRouteModule();
		expect(routeModuleProblems('machine', text)).toEqual([]);
		expect(PRESENT.machineRouteModule(text)).toBe(true);
		expect(exportsDefault(text)).toBe(false);
		expect(exportsHeaders(text)).toBe(false);
		expect(ascii(text)).toBe('');
	});

	test('each predicate names what it refuses', () => {
		expect(routeModuleProblems('page', 'export function headers() {}\n')).toEqual([
			'does not call `DOCS.page(`.',
			'does not export `DOCS_HANDLE` as its `handle`, so root.tsx cannot tell a docs page from any other address and ships every one noindex.',
			'has no default export, so every docs page is served as a resource route.',
			'exports `headers`.',
		]);
		expect(
			routeModuleProblems(
				'machine',
				'export { loader as default, headers };\nDOCS.resource(url);\n',
			),
		).toEqual([
			'has a default export, so every machine address renders the site shell around plain text.',
			'exports `headers`.',
		]);
		expect(PRESENT.pageRouteModule(null)).toBe(false);
		expect(PRESENT.machineRouteModule(null)).toBe(false);
	});
});

describe('the gitignore entries', () => {
	test('are the two trees the contract names, under the directories prefetch writes them in', () => {
		expect([...GITIGNORE_ENTRIES]).toEqual([`app/docs/${BUNDLE_TREE}/`, `public/${PUBLIC_TREE}/`]);
	});
});

describe('the printed instructions', () => {
	test('the machine spread names each row id, and the page spreads name none', () => {
		// The id is what the route config loader needs, because every machine row names one
		// module. Page rows take the site's own mount prefix instead, which is what keeps the
		// bare and `:lang` copies of one page apart.
		expect(MACHINE_ROUTES_SPREAD).toContain('{ id: row.id }');
		expect(MACHINE_ROUTES_SPREAD).toContain('row.kind === "machine"');
		expect(PAGE_TUPLES_SPREAD).not.toContain('row.id');
		expect(DOCS_PAGES_HELPER).toContain('{ id: `${idPrefix}${row.path.slice(1)}` }');
		expect(DOCS_PAGES_HELPER).not.toContain('row.id');
	});

	test('routes.ts imports relatively, because it is evaluated with no plugins', () => {
		expect(ROUTES_IMPORT).toBe('import { DOCS_ROUTES } from "./lib/docs.server";');
		expect(valueImportSpecifiers(ROUTES_IMPORT)).toEqual(['./lib/docs.server']);
	});

	test('the routes instruction takes its arm from the file and never prints a whole export', () => {
		const tuple = 'const PAGES: [path: string, file: string][] = [\n];\n';
		expect(routesChanges(tuple).map((change) => change.code)).toEqual([
			ROUTES_IMPORT,
			PAGE_TUPLES_SPREAD,
			MACHINE_ROUTES_SPREAD,
		]);
		expect(routesChanges(null).map((change) => change.code)).toContain(DOCS_PAGES_HELPER);
		for (const text of [tuple, null]) {
			const printed = routesInstruction('apps/front/app/routes.ts', text);
			expect(printed.startsWith('apps/front/app/routes.ts: declare the docs routes')).toBe(true);
			expect(printed).not.toContain('export default [');
		}
	});

	test('the sitemap block reads each entry languages and writes x-default only with English', () => {
		for (const escape of [false, true]) {
			const block = sitemapDocsBlock(escape);
			expect(sitemapProblems(`${SITEMAP_IMPORT}\n${block}`)).toEqual([]);
			expect(block).toContain('if (entry.languages.includes(DEFAULT_LANGUAGE)) {');
			expect(block.includes('escapeXml(')).toBe(escape);
			// One line per URL literal, so pasting at any depth puts no tabs into the XML.
			expect(block.split('\n').filter((line) => (line.match(/`/g) ?? []).length % 2 === 1)).toEqual(
				[],
			);
			expect(ascii(block)).toBe('');
		}
		expect(sitemapInstruction('x', 'function escapeXml(value: string) {}')).toContain('escapeXml(');
		expect(sitemapInstruction('x', null)).not.toContain('escapeXml(');
	});

	test('the root decision satisfies the root predicate it is checked by', () => {
		expect(
			rootSeoProblems(`import { docsSeoFromMatches } from "@hex-pro/docs";\n${ROOT_DECISION}`),
		).toEqual([]);
		expect(rootInstruction('apps/front/app/root.tsx')).toContain(
			ROOT_DECISION.split('\n')[3] as string,
		);
		expect(rootSeoProblems('const translated = isLocalisedPath(path);')).toEqual([
			'does not call `docsSeoFromMatches(`, so every docs page ships noindex.',
		]);
	});

	test('the sitemap predicate names each missing piece', () => {
		expect(sitemapProblems('const urls = [];\n')).toEqual([
			'does not call `DOCS.sitemap()`.',
			'does not import `DOCS` from `lib/docs.server`.',
			"never reads an entry's `languages`, so every docs page is listed in every language, fallback translations included.",
		]);
	});
});
