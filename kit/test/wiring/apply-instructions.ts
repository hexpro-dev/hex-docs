/**
 * The by-hand edits `install` prints, applied to the fixture consumers from the constants.
 *
 * A person reads the printed instruction and pastes. These helpers paste the exported
 * constants the instruction is rendered from, at the anchors the instruction names, into the
 * real bytes of both consumers, so a wired fixture is wired by the same text a person gets.
 * Step 5's checks-fire test carried its own spelling of the routes spread, and it and the
 * printed instruction both omitted the route ids, which is the defect a second spelling
 * exists to hide.
 *
 * Every anchor is asserted to be present exactly once before it is used. An anchor that moved
 * in a fixture refresh would otherwise make the paste a silent no-op and every mutation that
 * depends on it would be red for the wrong reason.
 */

import {
	DOCS_PAGES_BARE,
	DOCS_PAGES_HELPER,
	LANG_CHILDREN_WITH_DOCS,
	MACHINE_ROUTES_SPREAD,
	PAGE_TUPLES_SPREAD,
	ROOT_DECISION,
	ROOT_IMPORT,
	ROOT_PREFIXED_FILTER,
	ROUTES_IMPORT,
	SITEMAP_IMPORT,
	SITEMAP_JOIN,
	routesUseTuples,
	sitemapDocsBlock,
	sitemapEscapes,
} from '../../src/wiring/instructions.js';

/** Replaces the one occurrence of `anchor`, or throws naming it. */
export function once(text: string, anchor: string, replacement: string): string {
	const first = text.indexOf(anchor);
	if (first === -1 || text.indexOf(anchor, first + 1) !== -1) {
		throw new Error(`anchor ${JSON.stringify(anchor)} is not in the text exactly once`);
	}
	return `${text.slice(0, first)}${replacement}${text.slice(first + anchor.length)}`;
}

/** Every line prefixed, as a snippet lands inside a block. */
export function indent(code: string, depth: number): string {
	const prefix = '\t'.repeat(depth);
	return code
		.split('\n')
		.map((line) => (line === '' ? line : `${prefix}${line}`))
		.join('\n');
}

function afterLastImport(text: string, line: string): string {
	const imports = [...text.matchAll(/^import [^;]*;$/gm)];
	const last = imports[imports.length - 1];
	if (last?.index === undefined) throw new Error('no import statement to insert after');
	const end = last.index + last[0].length;
	return `${text.slice(0, end)}\n${line}${text.slice(end)}`;
}

export function applyRoutes(text: string): string {
	let next = afterLastImport(text, ROUTES_IMPORT);
	if (routesUseTuples(text)) {
		const pagesAt = next.indexOf('const PAGES');
		const close = next.indexOf('\n];', pagesAt);
		if (pagesAt === -1 || close === -1) throw new Error('no PAGES array to append to');
		next = `${next.slice(0, close)}\n${indent(PAGE_TUPLES_SPREAD, 1)}${next.slice(close)}`;
	} else {
		next = once(next, '\nexport default [', `\n${DOCS_PAGES_HELPER}\n\nexport default [`);
		next = once(next, '\t...pages("en/"),\n', `\t...pages("en/"),\n\t${DOCS_PAGES_BARE}\n`);
		next = once(next, 'pages("lang/"))', `${LANG_CHILDREN_WITH_DOCS})`);
	}
	return once(next, '\troute(":lang",', `${indent(MACHINE_ROUTES_SPREAD, 1)}\n\troute(":lang",`);
}

export function applyRoot(text: string): string {
	let next = once(text, '} from "react-router";', '\tuseMatches,\n} from "react-router";');
	next = afterLastImport(next, ROOT_IMPORT);
	next = once(next, '\tconst translated = isLocalisedPath(path);', indent(ROOT_DECISION, 1));
	return once(next, 'PREFIXED_LANGUAGES.map(', ROOT_PREFIXED_FILTER);
}

export function applySitemap(text: string): string {
	let next = afterLastImport(text, SITEMAP_IMPORT);
	next = once(
		next,
		'\tconst xml = `',
		`${indent(sitemapDocsBlock(sitemapEscapes(text)), 1)}\n\n\tconst xml = \``,
	);
	return once(next, '${urls.join("\\n")}', SITEMAP_JOIN);
}
