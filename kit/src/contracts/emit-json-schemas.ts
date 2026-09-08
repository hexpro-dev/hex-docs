/**
 * Emits the generated contract artifacts: JSON Schemas for the files a human or an
 * agent writes, and the house rule pack as data.
 *
 * Zod is the single source: the schemas here are generated from it, so drift between
 * a committed `.json` schema and the validator is not expressible. An earlier design
 * had `hexdocs schema emit` writing copies into each app repository with a CI byte-diff
 * gate holding them in sync, which is a guard for a problem created by having two
 * copies.
 *
 * They are referenced by **relative path** from an app repository, not by URL:
 * `"$schema": "../../hex-docs/kit/schema/docs-1.json"`. Editors resolve a relative
 * `$schema` against the file, so completion works with nothing hosted. A URL would
 * have to point at a host that does not exist, and a 404 there means the completion
 * simply never appears and nothing says why.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { STYLESHEET_PATH, emitStylesheet } from '../theme/stylesheet.js';

import {
	BANNED_CHARACTERS,
	CHECK_IDS,
	EM_DASH_CODE_POINTS,
	LINT_RULE_IDS,
	PROTECTED_RULES,
	houseStyleRules,
} from '../../../src/contracts/lint.js';
import {
	denyListSchema,
	docsProjectConfigSchema,
	docsSiteConfigSchema,
	frontMatterSchema,
	navTreeSchema,
} from './config.schema.js';

const OUT = resolve(fileURLToPath(new URL('../../schema', import.meta.url)));

const SCHEMAS = [
	[
		'docs-1',
		docsProjectConfigSchema,
		"A documented project's own configuration: docs/site/docs.json",
	],
	[
		'nav-1',
		navTreeSchema,
		'Documentation order and the set of pages that exist: docs/site/nav.json',
	],
	['site-1', docsSiteConfigSchema, 'A docs mount in a consuming website: <project>.docs.json'],
	[
		'private-1',
		denyListSchema,
		'Strings that must never appear in anything published: docs/docs.private.json',
	],
	[
		'frontmatter-1',
		frontMatterSchema,
		'Page front matter: everything about a page that is not the page itself.',
	],
] as const;

/**
 * The house rule pack, as data.
 *
 * Emitted so a zero-dependency `.mjs` guard can read it: `scripts/lint.mjs` here, and
 * `check-locales.mjs` in hex-web, which today re-derives its banned-character set from
 * a CLAUDE.md. Two hand-maintained copies of that set is how one of them ends up a
 * subset of the other and quietly passes an en dash.
 *
 * Characters are code points, never literals, so this file can itself be scanned by
 * the rule it describes.
 */
function houseRules(): unknown {
	return {
		bannedCharacters: BANNED_CHARACTERS.map((entry) => ({ ...entry })),
		emDashCodePoints: [...EM_DASH_CODE_POINTS],
		protectedRules: [...PROTECTED_RULES],
		houseStyleRules: houseStyleRules(),
		lintRuleIds: [...LINT_RULE_IDS],
		checkIds: [...CHECK_IDS],
	};
}

export function emitJsonSchemas(outDir: string = OUT): string[] {
	mkdirSync(outDir, { recursive: true });
	const written: string[] = [];

	for (const [name, schema, description] of SCHEMAS) {
		const json = z.toJSONSchema(schema, { io: 'input' });
		const document = { $id: `${name}.json`, title: name, description, ...json };
		const path = join(outDir, `${name}.json`);
		writeFileSync(path, `${JSON.stringify(document, null, '\t')}\n`, 'utf8');
		written.push(path);
	}

	return written;
}

/** Separate from the schemas: it is data, not a JSON Schema, and the suite checks both differently. */
export function emitHouseRules(outDir: string = OUT): string {
	mkdirSync(outDir, { recursive: true });
	const path = join(outDir, 'house-rules.json');
	writeFileSync(path, `${JSON.stringify(houseRules(), null, '\t')}\n`, 'utf8');
	return path;
}

/**
 * The renderer's stylesheet, generated from the same tables.
 *
 * It joins this script rather than getting one of its own because it is the same kind of
 * artifact and needs the same gate: one command regenerates every generated file, and CI
 * fails on a diff afterwards. A second script would be a second thing to remember, and the
 * one nobody runs is the one that goes stale.
 *
 * It writes outside `kit/`, which nothing else here does, so the path is resolved from the
 * repository root rather than from `outDir`.
 */
export function emitStylesheetFile(root: string = resolve(OUT, '..', '..')): string {
	const path = join(root, STYLESHEET_PATH);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, emitStylesheet(), 'utf8');
	return path;
}

export function emitAll(outDir: string = OUT): string[] {
	return [...emitJsonSchemas(outDir), emitHouseRules(outDir), emitStylesheetFile()];
}

if (
	process.argv[1] !== undefined &&
	import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
) {
	const written = emitAll();
	for (const path of written) process.stdout.write(`${path}\n`);
	process.stdout.write(`${written.length} generated artifacts\n`);
}
