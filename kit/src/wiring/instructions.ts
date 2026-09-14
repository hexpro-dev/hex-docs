/**
 * The edits `install` prints and never writes, as code a person pastes.
 *
 * Three files: the route table, the sitemap and `root.tsx`. All three are hand-authored,
 * roughly half prose comment, and different in each consumer, so `install` prints the
 * insertions and leaves the placing to a person. What it prints is built from the exported
 * constants below and nothing else, and the same constants are what
 * `kit/test/wiring/checks-fire.test.ts` applies to the real bytes of both consumers to build
 * its wired baseline. Step 5 shipped a machine spread with no route ids because the printed
 * instruction and the test's own spread were two spellings, and both omitted them.
 *
 * Insertions only, never a whole `export default`. The step-5 registry arm printed one, and
 * copying it literally deleted kcalc's `robots.txt`, `sitemap.xml` and admin routes.
 *
 * Every snippet is tab indented and double quoted, in the consumers' style, and every value
 * import in `routes.ts` is relative: React Router evaluates that file with no Vite plugins,
 * so `~/` does not resolve there, where it does in the sitemap and in `root.tsx`.
 */

import { stripComments } from './needles.js';

/** One change to a file, in the words a person follows and the code they paste. */
export interface Change {
	readonly where: string;
	readonly code: string;
}

function render(heading: string, changes: readonly Change[], closing: readonly string[]): string {
	const lines = [heading, ''];
	for (const change of changes) {
		lines.push(`${change.where}:`, '');
		for (const line of change.code.split('\n')) lines.push(line === '' ? '' : `  ${line}`);
		lines.push('');
	}
	return [...lines, ...closing].join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// routes.ts
// ---------------------------------------------------------------------------

export const ROUTES_IMPORT = 'import { DOCS_ROUTES } from "./lib/docs.server";';

/**
 * The machine rows, top level, each with the id its row carries.
 *
 * Top level because a leaf with no default export is dispatched to `queryRoute`, which runs
 * that route's loader and no parent's, so under `:lang` nothing validates the language. The
 * id because every machine row names the same module, React Router defaults an id to the
 * module path, and its config loader refuses two routes with one id.
 */
export const MACHINE_ROUTES_SPREAD = [
	'...DOCS_ROUTES.filter((row) => row.kind === "machine").map((row) =>',
	'\troute(row.path.slice(1), row.file, { id: row.id }),',
	'),',
].join('\n');

/** The page rows, into a `[path, file]` tuple array that the site's own `pages()` mounts twice. */
export const PAGE_TUPLES_SPREAD = [
	'...DOCS_ROUTES.filter((row) => row.kind === "page").map(',
	'\t(row) => [row.path.slice(1), row.file] as [string, string],',
	'),',
].join('\n');

/**
 * The page rows for a site whose page list is a registry rather than a tuple array.
 *
 * kcalc's `pages()` maps `PAGES` from `lib/pages.ts`, whose `key` is a closed union with an
 * exhaustive scope record behind it, so a docs page cannot join that registry without
 * widening a union in the consumer's own source. The helper sits beside it and takes the
 * same id prefix, which is what keeps the bare and `:lang` copies of one page apart.
 */
export const DOCS_PAGES_HELPER = [
	'function docsPages(idPrefix: string): RouteConfigEntry[] {',
	'\treturn DOCS_ROUTES.filter((row) => row.kind === "page").map((row) =>',
	'\t\troute(row.path.slice(1), row.file, { id: `${idPrefix}${row.path.slice(1)}` }),',
	'\t);',
	'}',
].join('\n');

export const DOCS_PAGES_BARE = '...docsPages("en/"),';

export const LANG_CHILDREN_WITH_DOCS = '[...pages("lang/"), ...docsPages("lang/")]';

const ROUTES_CLOSING = [
	'Neither docs route module may export `headers`. React Router copies only Set-Cookie from',
	'a parent, so a child `headers` export replaces the root policy for every docs page: no',
	'Content-Security-Policy on a site that sets it there, and no Vary or cache policy on one',
	"that sets those. `hexdocs verify-install` then reads this table through the site's own",
	'`react-router routes --json`, so a spread in the wrong place fails that row by name.',
];

/** Whether `routes.ts` holds its pages as a local `[path, file]` tuple array, as hex-web does. */
export function routesUseTuples(text: string | null): boolean {
	return text !== null && /PAGES\s*:\s*\[\s*path\s*:\s*string/.test(stripComments(text));
}

export function routesChanges(text: string | null): Change[] {
	const machine: Change = {
		where:
			'In the default export, after the bare page mount and before `route(":lang", ...)`, beside `robots.txt` and `sitemap.xml`',
		code: MACHINE_ROUTES_SPREAD,
	};
	const importLine: Change = { where: 'After the last import', code: ROUTES_IMPORT };
	if (routesUseTuples(text)) {
		return [
			importLine,
			{ where: 'As the last entries of `PAGES`', code: PAGE_TUPLES_SPREAD },
			machine,
		];
	}
	return [
		importLine,
		{ where: 'Beside the `pages()` function', code: DOCS_PAGES_HELPER },
		{ where: 'In the default export, directly after `...pages("en/"),`', code: DOCS_PAGES_BARE },
		machine,
		{
			where: 'And give the `:lang` route these children in place of `pages("lang/")`',
			code: LANG_CHILDREN_WITH_DOCS,
		},
	];
}

export function routesInstruction(file: string, text: string | null): string {
	return render(
		`${file}: declare the docs routes from DOCS_ROUTES.`,
		routesChanges(text),
		ROUTES_CLOSING,
	);
}

// ---------------------------------------------------------------------------
// The sitemap
// ---------------------------------------------------------------------------

export const SITEMAP_IMPORT = 'import { DOCS } from "~/lib/docs.server";';

/** The one expression that replaces `urls` inside the XML string. */
export const SITEMAP_JOIN = '${[...urls, ...docsUrls].join("\\n")}';

/**
 * The docs URLs, each listed only in the languages that page is indexable in.
 *
 * Its own block rather than a spread into the site's list, and the reason is kcalc. That
 * sitemap maps its page registry directly and looks up a lastmod by page key, so docs rows
 * joining that list either break the lookup, a TS2339 measured with kcalc's own compiler, or
 * make it conditional and quietly drop `<lastmod>` from every kcalc page. Both sitemaps also
 * list every page in all seven languages with all seven alternates, and a docs page must not
 * be: a fallback translation is served noindex, and a sitemap naming it points a crawler at
 * a page that asks not to be indexed. `x-default` is written only when English is in the set.
 *
 * `escape` is kcalc's `escapeXml`, applied where that file already applies it.
 *
 * Each `<url>` is one template literal on one line, with `\n` escapes, rather than a literal
 * spanning lines as the consumers' own blocks are. A snippet is pasted at whatever depth the
 * person's editor puts it, and a multi-line literal re-indented on paste carries those tabs
 * into every URL of the sitemap.
 */
export function sitemapDocsBlock(escape: boolean): string {
	const wrap = (value: string): string => (escape ? `escapeXml(${value})` : value);
	return [
		'// Docs pages, each in the languages it is indexable in and no others. A fallback',
		'// translation is served noindex, so naming it here would point a crawler at a page',
		'// that asks not to be indexed. DOCS.sitemap() already leaves hidden pages out.',
		'const docsUrls = DOCS.sitemap().flatMap((entry) => {',
		'\tconst links = entry.languages.map(',
		'\t\t(lang) =>',
		`\t\t\t\`    <xhtml:link rel="alternate" hreflang="\${lang}" href="\${${wrap('localeUrl(lang, entry.path)')}}"/>\`,`,
		'\t);',
		'\tif (entry.languages.includes(DEFAULT_LANGUAGE)) {',
		'\t\tlinks.push(',
		`\t\t\t\`    <xhtml:link rel="alternate" hreflang="x-default" href="\${${wrap('localeUrl(DEFAULT_LANGUAGE, entry.path)')}}"/>\`,`,
		'\t\t);',
		'\t}',
		'\treturn entry.languages.map(',
		'\t\t(lang) =>',
		`\t\t\t\`  <url>\\n    <loc>\${${wrap('localeUrl(lang, entry.path)')}}</loc>\\n\${links.join("\\n")}\\n    <changefreq>\${entry.changefreq}</changefreq>\\n    <priority>\${entry.priority}</priority>\\n  </url>\`,`,
		'\t);',
		'});',
	].join('\n');
}

/** Whether the sitemap already escapes its URLs, as kcalc's does. */
export function sitemapEscapes(text: string | null): boolean {
	return text !== null && /function\s+escapeXml\b/.test(stripComments(text));
}

export function sitemapChanges(text: string | null): Change[] {
	return [
		{ where: 'After the last import', code: SITEMAP_IMPORT },
		{
			where: 'Inside the loader, after `urls` is built and before the XML string',
			code: sitemapDocsBlock(sitemapEscapes(text)),
		},
		{
			where: 'And in the XML string, in place of the `urls` join',
			code: SITEMAP_JOIN,
		},
	];
}

export function sitemapInstruction(file: string, text: string | null): string {
	return render(
		`${file}: list the docs pages from DOCS.sitemap(), in the languages each one names.`,
		sitemapChanges(text),
		[
			'The rows come from the prefetched manifests at build time, so a relabel changes the',
			'sitemap on the next build with no edit here. Hand-listing a docs address instead',
			'advertises hidden pages and every fallback translation.',
		],
	);
}

// ---------------------------------------------------------------------------
// root.tsx
// ---------------------------------------------------------------------------

export const ROOT_IMPORT = 'import { docsSeoFromMatches } from "@hex-pro/docs";';

/**
 * The decision root makes for a docs page, from the docs match's handle.
 *
 * Docs addresses are not added to `LOCALISED_PATHS`. That list has a second reader, the
 * language-cookie redirect, and a docs page left out of it is already exempt, which is the
 * exemption the translation notice needs: its link to the English address would otherwise be
 * redirected straight back. Root instead asks the matched docs route, and for any other page
 * the answer is `isLocalisedPath` exactly as before.
 */
export const ROOT_DECISION = [
	'// A docs page answers for itself through its route handle: whether this language is',
	'// indexable, and which languages its alternates may name. A fallback translation is',
	'// served noindex and is not named. Every other page is decided as before.',
	'const docsSeo = docsSeoFromMatches(useMatches());',
	'const translated = docsSeo ? docsSeo.indexable : isLocalisedPath(path);',
	'const named = (code: SupportedLanguage) => !docsSeo || docsSeo.languages.includes(code);',
].join('\n');

export const ROOT_PREFIXED_FILTER = 'PREFIXED_LANGUAGES.filter(named).map(';

export const ROOT_DEFAULT_GATE = '{named(DEFAULT_LANGUAGE) && (';

export function rootChanges(): Change[] {
	return [
		{
			where: 'Add `useMatches` to the import from "react-router", and after the imports',
			code: ROOT_IMPORT,
		},
		{
			where: 'In `Layout`, in place of `const translated = isLocalisedPath(path);`',
			code: ROOT_DECISION,
		},
		{
			where:
				'In the alternates, filter the prefixed languages, in place of `PREFIXED_LANGUAGES.map(`',
			code: ROOT_PREFIXED_FILTER,
		},
		{
			where:
				'And wrap both the `hrefLang={DEFAULT_LANGUAGE}` link and the `x-default` link, so neither is written for a docs page that has no English',
			code: `${ROOT_DEFAULT_GATE}\n\t<link ... />\n)}`,
		},
	];
}

export function rootInstruction(file: string): string {
	return render(
		`${file}: let a docs page decide its own canonical, alternates and robots tag.`,
		rootChanges(),
		[
			'Root writes the canonical and the alternates above the meta outlet, and a route can add',
			'tags but never remove them, so this is the only place the decision can be made. Without',
			'it a docs page is an address missing from LOCALISED_PATHS and ships noindex.',
		],
	);
}
