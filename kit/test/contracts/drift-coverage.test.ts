import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import * as astSchemas from '../../src/contracts/ast.schema.js';
import * as bundleSchemas from '../../src/contracts/bundle.schema.js';
import * as configSchemas from '../../src/contracts/config.schema.js';
import * as diagnosticSchemas from '../../src/contracts/diagnostics.schema.js';
import * as primitiveSchemas from '../../src/contracts/primitives.js';

const DRIFT = readFileSync(
	fileURLToPath(new URL('../../src/contracts/drift.ts', import.meta.url)),
	'utf8',
);

/**
 * Schemas with no hand-written twin to drift from, each with the reason.
 *
 * Every `*Schema` export of a module.
 */
function schemaNames(module: Record<string, unknown>): string[] {
	return Object.entries(module)
		.filter(([name, value]) => name.endsWith('Schema') && value instanceof z.ZodType)
		.map(([name]) => name);
}

/**
 * The `*Schema` exports of primitives.ts that really are leaf primitives.
 *
 * The test is `instanceof`, not the module a schema is exported from. Exempting the
 * whole namespace was a heuristic wearing an explicit list's docstring: appending
 * `export const smuggledSchema = z.strictObject({ a: z.string(), b: z.number() })` to
 * primitives.ts left this file green, with an object schema carrying no drift assertion
 * and an exemption reason that was untrue of it. Anything that is not a string or a
 * number falls through to `EXEMPT` and has to be named there with its own reason.
 */
function leafPrimitives(module: Record<string, unknown>): string[] {
	return Object.entries(module)
		.filter(([name, value]) => name.endsWith('Schema'))
		.filter(([, value]) => {
			// `.refine()` and `.min()` wrap the base type, so unwrap to whatever the
			// schema ultimately validates rather than looking at the outermost node.
			let current = value;
			while (current instanceof z.ZodType) {
				const inner = (current as { def?: { innerType?: unknown; schema?: unknown } }).def;
				const next = inner?.innerType ?? inner?.schema;
				if (!(next instanceof z.ZodType)) break;
				current = next;
			}
			return current instanceof z.ZodString || current instanceof z.ZodNumber;
		})
		.map(([name]) => name);
}

const LEAF_PRIMITIVE =
	'A leaf primitive from primitives.ts. It refines a string or a number and has no hand-written interface to drift from; what it enforces is covered by the round-trip tests.';

/**
 * Schemas with no drift assertion, and why each needs none.
 *
 * An explicit list rather than a heuristic, because the whole value of this test is
 * that adding a schema without a drift assertion is noticed. Growing this list is a
 * deliberate act with a justification beside it. The one bulk entry is
 * `leafPrimitives`, which tests what a schema validates rather than where it lives, so
 * putting a composite schema in primitives.ts does not exempt it.
 */
const EXEMPT: Readonly<Record<string, string>> = {
	...Object.fromEntries(leafPrimitives(primitiveSchemas).map((name) => [name, LEAF_PRIMITIVE])),
	localeSchema:
		'z.enum(LOCALES) over the same const tuple `Locale` is derived from, so there is no second declaration for it to drift from. It surfaced when the blanket primitives exemption was narrowed to string and number leaves, which is the narrowing working.',
	linkSchema:
		'A union member rather than a node type of its own. Covered by the registry assertion in ast.schema.ts, which reports whole members by name.',
	navItemSchema:
		'A recursive union reached through navTreeSchema, which is asserted. Asserting it alone would be satisfied by its own annotation.',
	objectKeySchema:
		'A leaf constraint on a string field, with no interface behind it. What it refuses is covered by the round-trip cases in bundle.schema.test.ts.',
};

/** Which namespace each schema is exported from, so the needle can be exact. */
const MODULE_OF: Record<string, string> = {
	...Object.fromEntries(schemaNames(astSchemas).map((name) => [name, 'ast'])),
	...Object.fromEntries(schemaNames(bundleSchemas).map((name) => [name, 'bundle'])),
	...Object.fromEntries(schemaNames(configSchemas).map((name) => [name, 'config'])),
	...Object.fromEntries(schemaNames(diagnosticSchemas).map((name) => [name, 'diagnostics'])),
};

/**
 * All whitespace removed, because prettier wraps the longer assertions across lines
 * and does it in more than one shape. Matching the raw text, or even a
 * single-space normalisation, reports correctly-asserted schemas as unasserted.
 */
const FLAT = DRIFT.replace(/\s+/g, '');

const ALL = [
	...new Set([
		...schemaNames(primitiveSchemas),
		...schemaNames(astSchemas),
		...schemaNames(bundleSchemas),
		...schemaNames(configSchemas),
		...schemaNames(diagnosticSchemas),
	]),
].sort();

describe('every schema is either drift-checked or exempt with a reason', () => {
	test('there are schemas to check at all', () => {
		// A check that examined zero things is a failure, not a pass.
		expect(ALL.length).toBeGreaterThan(30);
	});

	test.each(ALL)('%s', (name) => {
		// The needle is the whole wrapper, not just the schema name. A bare substring
		// match could not tell `Expect<AssertExact<Of<typeof x.fooSchema>, Foo>>` from
		// the same line with the `Expect<` deleted, which is what somebody does to get
		// past a drift error while debugging, and which makes the assertion inert.
		const module = MODULE_OF[name];
		const asserted =
			module !== undefined &&
			(FLAT.includes(`Expect<AssertExact<Of<typeof${module}.${name}>`) ||
				FLAT.includes(`Expect<AssertExactUnion<Of<typeof${module}.${name}>`));
		const exempt = EXEMPT[name];
		expect(
			asserted || exempt !== undefined,
			`${name} has no drift assertion in drift.ts and no exemption. Add one, or add an entry to EXEMPT saying why it needs none.`,
		).toBe(true);
		if (exempt !== undefined) expect(exempt.length).toBeGreaterThan(20);
	});

	test('the exemption list has not gone stale', () => {
		const known = new Set(ALL);
		for (const name of Object.keys(EXEMPT)) {
			expect(
				known.has(name),
				`EXEMPT names "${name}", which is no longer an exported schema.`,
			).toBe(true);
		}
	});

	test('drift.ts carries at least one assertion per non-exempt schema', () => {
		const assertions = DRIFT.match(/AssertExact(Union)?</g)?.length ?? 0;
		const expected = ALL.filter((name) => EXEMPT[name] === undefined).length;
		expect(assertions).toBeGreaterThanOrEqual(expected);
	});

	test('every assertion is wrapped, so none of them is inert', () => {
		// `AssertExact<A, B>` on its own is a type alias nobody evaluates. Only the
		// `Expect<>` wrapper turns a mismatch into a compile error.
		const asserts = FLAT.match(/AssertExact(?:Union)?</g)?.length ?? 0;
		const wrapped = FLAT.match(/Expect<AssertExact(?:Union)?</g)?.length ?? 0;
		expect(asserts).toBeGreaterThan(30);
		expect(wrapped).toBe(asserts);
	});
});
