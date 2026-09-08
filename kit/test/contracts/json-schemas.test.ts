import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { emitHouseRules, emitJsonSchemas } from '../../src/contracts/emit-json-schemas.js';

const OUT = mkdtempSync(join(tmpdir(), 'hexdocs-schema-'));
const WRITTEN = emitJsonSchemas(OUT);
const RULES = emitHouseRules(OUT);

describe('the emitted JSON Schemas', () => {
	test('cover every file a human or an agent writes', () => {
		expect(readdirSync(OUT).sort()).toEqual([
			'docs-1.json',
			'frontmatter-1.json',
			'house-rules.json',
			'nav-1.json',
			'private-1.json',
			'site-1.json',
		]);
		expect(WRITTEN.length).toBe(5);
	});

	test.each(WRITTEN)('%s is valid JSON with an id, a title and a description', (path) => {
		const document = JSON.parse(readFileSync(path, 'utf8'));
		expect(document.$id).toMatch(/-1\.json$/);
		expect(document.title.length).toBeGreaterThan(0);
		expect(document.description.length).toBeGreaterThan(20);
		expect(document.$schema).toContain('json-schema.org');
	});

	test('each is closed, so a typo is a red squiggle in the editor rather than a no-op', () => {
		for (const path of WRITTEN) {
			const document = JSON.parse(readFileSync(path, 'utf8'));
			expect(document.additionalProperties).toBe(false);
		}
	});

	test('every root accepts $schema, so the tool does not reject the files it generates', () => {
		for (const path of WRITTEN) {
			const document = JSON.parse(readFileSync(path, 'utf8'));
			if (path.endsWith('frontmatter-1.json')) continue; // YAML, no $schema key
			expect(document.properties.$schema).toBeDefined();
		}
	});

	test('the recursive nav resolves through $defs rather than blowing up', () => {
		const nav = JSON.parse(readFileSync(join(OUT, 'nav-1.json'), 'utf8'));
		expect(Object.keys(nav.$defs ?? {}).length).toBeGreaterThan(0);
		expect(JSON.stringify(nav)).toContain('$ref');
	});

	test('emitting twice writes identical bytes', () => {
		const first = WRITTEN.map((path) => readFileSync(path, 'utf8'));
		emitJsonSchemas(OUT);
		const second = WRITTEN.map((path) => readFileSync(path, 'utf8'));
		expect(second).toEqual(first);
	});

	test('the committed copies in kit/schema match what the generator produces now', () => {
		// Zod is the single source. If these diverge, somebody edited the generated
		// file instead of the schema, and the validator and the editor now disagree.
		for (const path of [...WRITTEN, RULES]) {
			const name = path.slice(path.lastIndexOf('/') + 1);
			const committed = readFileSync(new URL(`../../schema/${name}`, import.meta.url), 'utf8');
			expect(readFileSync(path, 'utf8')).toBe(committed);
		}
	});
});

describe('the house rule pack', () => {
	const pack = JSON.parse(readFileSync(RULES, 'utf8'));

	test('carries the banned characters as code points, never as literals', () => {
		// The pack has to be scannable by the very rule it describes, and a literal set
		// would make the file that declares the rule the one file exempt from it.
		expect(pack.bannedCharacters.length).toBeGreaterThan(10);
		for (const entry of pack.bannedCharacters) {
			expect(Number.isInteger(entry.codePoint)).toBe(true);
			expect(entry.name.length).toBeGreaterThan(2);
		}
		expect(readFileSync(RULES, 'utf8')).not.toMatch(/[\u2013\u2014\u2015]/u);
	});

	test('carries the rule ids a consuming script needs to agree with', () => {
		expect(pack.protectedRules.length).toBeGreaterThan(3);
		expect(pack.houseStyleRules).toContain('no-em-dash');
		expect(pack.lintRuleIds.length).toBeGreaterThan(30);
		expect(pack.checkIds).toContain('wiring-allow-paths');
	});

	test('every protected rule is a real lint rule', () => {
		const known = new Set(pack.lintRuleIds);
		for (const rule of pack.protectedRules) expect(known.has(rule)).toBe(true);
	});
});
