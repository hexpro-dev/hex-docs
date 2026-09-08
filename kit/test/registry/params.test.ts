/**
 * One parameter kind, five surfaces, and the two that a test can reach.
 *
 * `Param` is a table entry, and `shapeOf` turns it into a Zod leaf while `jsonSchemaOf`
 * turns that leaf into the JSON Schema a model reads before it decides what to send.
 * Nothing else in the package validates a tool call, so a kind whose Zod arm is wrong
 * produces a tool that accepts what it should refuse and advertises a schema that says so.
 * That failure is silent on both surfaces at once: the CLI takes the bad value, the model
 * is told the bad value is legal, and the first sign of it is a handler reading a field
 * that is not the type its own mapped `Input<P>` promised.
 *
 * Two things make the sweep below more than a set of examples.
 *
 * The **kind signature** is derived from the entry rather than named, so every distinct
 * combination of `type`, `many`, `required`, `values` and `fallback` that any command in
 * the registry actually declares has to be claimed by a case here. A parameter kind
 * introduced by a new command lands in `uncovered` until somebody writes down what its
 * schema is supposed to do with it, which is the direction that catches a kind added with
 * no Zod arm of its own: `shapeOf` falls through to the string branch for any `type` it
 * does not recognise, and a string schema over a number is a tool that quietly accepts
 * anything a string can hold.
 *
 * And the **refusal sweep** runs over every parameter of every command rather than over
 * this file's table. A plain object is refused by all five leaves `shapeOf` can build, so
 * `z.any()` in place of any one of them is the one mutation that would turn every schema
 * in the package permissive at once, and it fails here naming the command and the flag.
 */

import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { jsonSchemaOf, shapeOf, type Param, type Params } from '../../src/registry/params.js';
import { COMMANDS } from '../../src/registry/index.js';

/**
 * What distinguishes one parameter kind from another, derived from the entry.
 *
 * Named by hand it would be a label somebody keeps in step; derived, a command that
 * declares a combination nobody has thought about names itself.
 */
function signature(param: Param): string {
	return [
		param.type,
		param.values === undefined ? null : 'values',
		param.many === true ? 'many' : null,
		param.required === true ? 'required' : null,
		param.fallback === undefined ? null : 'fallback',
	]
		.filter((part) => part !== null)
		.join('+');
}

interface Kind {
	/** What this kind is, in the words a reader of a failure would want. */
	readonly name: string;
	readonly param: Param;
	/**
	 * Whether some command declares this combination today.
	 *
	 * A case that claims to mirror the registry and no longer does is a failure, and a
	 * case that deliberately covers a shape nothing declares yet has to say why.
	 */
	readonly inRegistry: boolean;
	readonly why: string | null;
	/** Values the leaf has to take. */
	readonly accepts: readonly unknown[];
	/** Values the leaf has to refuse. Empty is not allowed: a leaf that refuses nothing is `z.any()`. */
	readonly rejects: readonly unknown[];
	/** What the JSON Schema property has to carry, checked as a subset. */
	readonly json: Record<string, unknown>;
	/** Whether the key lands in the JSON Schema `required` array. */
	readonly jsonRequired: boolean;
	/** What `z.object(shape).parse({})` puts at this key, or `undefined` for absent. */
	readonly whenAbsent: unknown;
}

const KINDS: readonly Kind[] = [
	{
		name: 'a required string',
		param: { help: 'the directory to write the bundle under', type: 'string', required: true },
		inRegistry: true,
		why: null,
		accepts: ['out', ' '],
		// The empty string is the one that matters. `required` in Zod means the key is
		// present, and a present key holding `''` is a path that resolves to the working
		// directory, so `.min(1)` is what stands between `--out ''` and a bundle written
		// over the repository root.
		rejects: ['', 3, null, undefined, {}],
		json: { type: 'string', minLength: 1, description: 'the directory to write the bundle under' },
		jsonRequired: true,
		whenAbsent: undefined,
	},
	{
		name: 'an optional string',
		param: { help: 'a second bundle directory to compare this one with', type: 'string' },
		inRegistry: true,
		why: null,
		accepts: ['../other'],
		rejects: ['', 0, {}],
		json: {
			type: 'string',
			minLength: 1,
			description: 'a second bundle directory to compare this one with',
		},
		jsonRequired: false,
		whenAbsent: undefined,
	},
	{
		name: 'a string with a fallback',
		param: {
			help: 'repository root; defaults to the working directory',
			type: 'string',
			fallback: '.',
		},
		inRegistry: true,
		why: null,
		accepts: ['/tmp/app'],
		rejects: ['', {}],
		json: {
			type: 'string',
			minLength: 1,
			default: '.',
			description: 'repository root; defaults to the working directory',
		},
		// A default makes the key readable without narrowing, which is what `Provided<P>`
		// promises the handler. It does not make it required over the wire, and the JSON
		// Schema has to say so or a model sends a value it was told it had to send.
		jsonRequired: false,
		whenAbsent: '.',
	},
	{
		name: 'a string with a closed set of values',
		param: {
			help: 'restrict to this severity and worse',
			type: 'string',
			values: ['error', 'warning', 'info'],
		},
		inRegistry: true,
		why: null,
		accepts: ['error', 'info'],
		// `severe` is the point: an enum that lost its `values` is a plain string, which
		// takes every one of these and hands the handler a severity nothing switches on.
		rejects: ['severe', '', 'Error', {}],
		json: {
			type: 'string',
			enum: ['error', 'warning', 'info'],
			description: 'restrict to this severity and worse',
		},
		jsonRequired: false,
		whenAbsent: undefined,
	},
	{
		name: 'a required string with a closed set of values',
		param: { help: 'what to scaffold', type: 'string', required: true, values: ['page', 'source'] },
		inRegistry: true,
		why: null,
		accepts: ['page', 'source'],
		rejects: ['site', '', undefined, {}],
		json: { type: 'string', enum: ['page', 'source'], description: 'what to scaffold' },
		jsonRequired: true,
		whenAbsent: undefined,
	},
	{
		name: 'a string with a closed set of values and a fallback',
		param: { help: 'the language to read', type: 'string', values: ['en', 'ja'], fallback: 'en' },
		inRegistry: true,
		why: null,
		accepts: ['en', 'ja'],
		rejects: ['de', {}],
		json: {
			type: 'string',
			enum: ['en', 'ja'],
			default: 'en',
			description: 'the language to read',
		},
		jsonRequired: false,
		whenAbsent: 'en',
	},
	{
		name: 'a repeatable string with a closed set of values',
		param: {
			help: 'restrict to these locales; repeat the flag for more than one',
			type: 'string',
			values: ['en', 'ja'],
			many: true,
		},
		inRegistry: true,
		why: null,
		accepts: [['en'], ['en', 'ja']],
		// The bare string is the one worth having. `--locale en` arrives from `parseArgs`
		// as `['en']` only because `optionsFor` set `multiple`, and a `many` parameter whose
		// array wrapper was dropped would take the bare string here and give the handler a
		// value it iterates one character at a time.
		rejects: ['en', [], ['de'], [''], {}],
		json: {
			type: 'array',
			minItems: 1,
			items: { type: 'string', enum: ['en', 'ja'] },
			description: 'restrict to these locales; repeat the flag for more than one',
		},
		jsonRequired: false,
		whenAbsent: undefined,
	},
	{
		name: 'a boolean',
		param: { help: 'apply the plan; without it nothing is written', type: 'boolean' },
		inRegistry: true,
		why: null,
		accepts: [true, false],
		// `'false'` is the string a shell hands over, and a boolean arm that fell through to
		// the string branch would take it and read as true at every `=== true` in the package.
		rejects: ['false', 'true', 0, 1, {}],
		json: { type: 'boolean', description: 'apply the plan; without it nothing is written' },
		jsonRequired: false,
		whenAbsent: undefined,
	},
	{
		name: 'an integer with a fallback',
		param: { help: 'start this many code points in', type: 'integer', fallback: 0 },
		inRegistry: true,
		why: null,
		accepts: [0, 12000],
		// `'12'` is what `parseArgs` produces, so the coercion in `bind` is the only thing
		// between the CLI and this refusal, and `-1` and `1.5` are both offsets that would
		// index a string nowhere.
		rejects: ['12', -1, 1.5, Number.NaN, {}],
		json: {
			type: 'integer',
			minimum: 0,
			default: 0,
			description: 'start this many code points in',
		},
		jsonRequired: false,
		whenAbsent: 0,
	},

	// -------------------------------------------------------------------------
	// Shapes `shapeOf` can build that no command declares today
	// -------------------------------------------------------------------------
	{
		name: 'a required integer',
		param: { help: 'how many pages to return', type: 'integer', required: true },
		inRegistry: false,
		why: 'Every integer in the registry carries a fallback. The required arm is reachable from the same table and would ship with no test behind it.',
		accepts: [0, 7],
		rejects: [undefined, '7', -1, {}],
		json: { type: 'integer', minimum: 0, description: 'how many pages to return' },
		jsonRequired: true,
		whenAbsent: undefined,
	},
	{
		name: 'a repeatable string with no closed set',
		param: { help: 'a glob to exclude', type: 'string', many: true },
		inRegistry: false,
		why: 'Every `many` parameter in the registry also carries `values`, so the array wrapper and the enum are only ever exercised together and neither is pinned on its own.',
		accepts: [['a'], ['a', 'b']],
		rejects: [[], [''], 'a', {}],
		json: {
			type: 'array',
			minItems: 1,
			items: { type: 'string', minLength: 1 },
			description: 'a glob to exclude',
		},
		jsonRequired: false,
		whenAbsent: undefined,
	},
];

/** One kind, alone, so a failure names the kind rather than a table row. */
function only(kind: Kind): Params {
	return { value: kind.param };
}

describe('shapeOf builds one leaf per parameter kind', () => {
	test.each(KINDS.map((kind) => [kind.name, kind] as const))(
		'%s accepts and refuses',
		(_name, kind) => {
			const schema = z.object(shapeOf(only(kind)));

			for (const value of kind.accepts) {
				const parsed = schema.safeParse({ value });
				expect(parsed.success, `${kind.name}: refused ${JSON.stringify(value)}`).toBe(true);
				if (parsed.success) expect(parsed.data['value']).toEqual(value);
			}

			// A leaf that refuses nothing is `z.any()`, which is the whole failure this file
			// exists for, so the case is required to name at least one refusal.
			expect(kind.rejects.length, `${kind.name}: claims no refusal`).toBeGreaterThan(0);
			for (const value of kind.rejects) {
				const parsed = schema.safeParse({ value });
				expect(
					parsed.success,
					`${kind.name}: accepted ${JSON.stringify(value) ?? 'undefined'}`,
				).toBe(false);
			}
		},
	);

	test.each(KINDS.map((kind) => [kind.name, kind] as const))(
		'%s is present or absent from an empty call as declared',
		(_name, kind) => {
			const schema = z.object(shapeOf(only(kind)));
			const parsed = schema.safeParse({});
			if (kind.jsonRequired) {
				expect(parsed.success, `${kind.name}: an empty call was accepted`).toBe(false);
				return;
			}
			expect(parsed.success).toBe(true);
			if (!parsed.success) return;
			// `whenAbsent: undefined` means the key is not there at all, which is not the
			// same as a key holding undefined: `Input<P>` marks it optional, and a handler
			// that reads it has to narrow.
			if (kind.whenAbsent === undefined) {
				expect(Object.hasOwn(parsed.data, 'value'), `${kind.name}: invented a key`).toBe(false);
			} else {
				expect(parsed.data['value']).toEqual(kind.whenAbsent);
			}
		},
	);

	test('shapeOf returns exactly the declared keys, in declaration order', () => {
		const params: Params = Object.fromEntries(
			KINDS.map((kind, index) => [`p${index}`, kind.param]),
		);
		expect(Object.keys(shapeOf(params))).toEqual(Object.keys(params));
	});
});

describe('jsonSchemaOf keeps every constraint a model reads', () => {
	test.each(KINDS.map((kind) => [kind.name, kind] as const))(
		'%s survives into the schema',
		(_name, kind) => {
			const schema = jsonSchemaOf(only(kind)) as {
				type: string;
				properties: Record<string, Record<string, unknown>>;
				required?: string[];
			};
			expect(schema.type, 'the MCP tool schema has to be an object at the root').toBe('object');

			const property = schema.properties['value'];
			expect(property, `${kind.name}: no property in the schema`).toBeDefined();
			// A subset match rather than equality, because zod adds `maximum` to an integer and
			// `$schema` to the document, and pinning those would make this file a change detector
			// for a zod upgrade rather than a check on the constraints the parameter declares.
			expect(property).toMatchObject(kind.json);

			// `description` is not decoration: it is the only sentence a model sees before it
			// decides what to send, so an entry whose help stopped reaching the schema is a tool
			// documented by its key name alone.
			expect(property?.['description']).toBe(kind.param.help);

			expect(schema.required ?? []).toEqual(kind.jsonRequired ? ['value'] : []);
		},
	);

	test('an empty parameter table is still an object schema', () => {
		// `hexdocs mcp` declares no parameters and `docs_*` tools are advertised with this
		// document verbatim. A schema that came back without `type: "object"` is rejected by
		// clients that validate the tool list before they call anything.
		const schema = jsonSchemaOf({}) as { type: string; properties?: unknown };
		expect(schema.type).toBe('object');
		expect(schema.properties ?? {}).toEqual({});
	});
});

describe('the kinds this file covers are the kinds the registry declares', () => {
	const declared = new Map<string, string[]>();
	for (const command of COMMANDS) {
		for (const [name, param] of Object.entries(command.params)) {
			const key = signature(param);
			declared.set(key, [...(declared.get(key) ?? []), `${command.name} --${name}`]);
		}
	}

	test('every parameter kind some command declares has a case here', () => {
		const covered = new Set(KINDS.map((kind) => signature(kind.param)));
		const uncovered = [...declared]
			.filter(([key]) => !covered.has(key))
			.map(([key, where]) => `${key} (${where.join(', ')})`);
		expect(uncovered, 'declared by a command and covered by no case in this file').toEqual([]);
	});

	test('every case claiming to mirror the registry still does', () => {
		// The other direction, and the one that keeps this file honest as the registry
		// shrinks: a case whose kind no longer exists anywhere is coverage of nothing, and
		// it reads as coverage of something.
		const orphaned = KINDS.filter(
			(kind) => kind.inRegistry && !declared.has(signature(kind.param)),
		);
		expect(
			orphaned.map((kind) => `${kind.name}: ${signature(kind.param)}`),
			'claims inRegistry and no command declares it',
		).toEqual([]);
	});

	test('every case that covers a shape nothing declares says why', () => {
		for (const kind of KINDS.filter((entry) => !entry.inRegistry)) {
			expect(declared.has(signature(kind.param)), `${kind.name} is in the registry now`).toBe(
				false,
			);
			// A sentence, not a word. An exemption whose reason is "future" is an exemption
			// nobody decided on, which is the shape `fixtures/planted.json` refuses.
			expect((kind.why ?? '').length, `${kind.name}: no reason`).toBeGreaterThan(40);
		}
	});
});

describe('no arm of shapeOf silently accepts anything', () => {
	// The sweep over the real registry rather than over this file's table, and it is the
	// one assertion here that a mutation to any single arm turns red. Every leaf `shapeOf`
	// can build (string, enum, boolean, integer, array) refuses a plain object, so a `z.any()`
	// anywhere in that chain is caught for every parameter it reaches at once.
	test.each(COMMANDS.map((command) => [command.name, command] as const))(
		'%s refuses an object at every parameter',
		(_name, command) => {
			const schema = z.object(shapeOf(command.params));
			const permissive: string[] = [];
			for (const name of Object.keys(command.params)) {
				if (schema.safeParse({ [name]: { unexpected: true } }).success) permissive.push(name);
			}
			expect(permissive, `${command.name}: these parameters accept an arbitrary object`).toEqual(
				[],
			);
		},
	);

	test('every advertised tool schema describes every one of its parameters', () => {
		// Both directions, over the real registry: a property with no description is a flag
		// a model has to guess at, and a property with no parameter behind it is a flag that
		// exists only in the schema.
		for (const command of COMMANDS) {
			const schema = jsonSchemaOf(command.params) as {
				type: string;
				properties?: Record<string, { description?: string }>;
			};
			expect(schema.type, `${command.name}: not an object schema`).toBe('object');
			const properties = schema.properties ?? {};
			expect(Object.keys(properties).sort()).toEqual(Object.keys(command.params).sort());
			for (const [name, property] of Object.entries(properties)) {
				expect(property.description, `${command.name} --${name}: no description`).toBe(
					command.params[name]?.help,
				);
			}
		}
	});
});
