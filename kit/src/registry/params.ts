/**
 * One argument, on every surface at once.
 *
 * **The key of the record is the field name in the command's input.** That is the whole
 * reason there is no argument binder in this package. The design this replaces carried a
 * JSON pointer per argument, `into: '/options/locale'`, so a CLI flag could write
 * anywhere inside a separately hand-written Zod schema; writing that resolver and its
 * tests is more code than the CLI it serves, and the two declarations drift. Here the
 * schema is derived from this table, so there is nowhere for a pointer to point and
 * nothing for it to go stale against.
 *
 * Five things come out of one entry: the Zod schema that validates a CLI invocation, the
 * JSON Schema an agent reads before calling the tool, the `parseArgs` options row, the
 * `--help` column, and the flag set the skill validator checks a `SKILL.md` against.
 *
 * `help` is not decoration for that reason. It is the JSON Schema `description`, which
 * is the only thing a model reads before deciding what to send.
 */

import { z } from 'zod';

export interface Param {
	/** One line, present tense, no trailing full stop. */
	readonly help: string;
	readonly type: 'string' | 'boolean' | 'integer';
	/** Repeatable on the CLI (`--locale en --locale ja`), an array over MCP. */
	readonly many?: true;
	readonly required?: true;
	/** A closed set. Becomes `z.enum`, and the CLI refuses anything outside it. */
	readonly values?: readonly [string, ...string[]];
	/**
	 * Applied by the schema and printed in `--help`, so the default is one value.
	 *
	 * A handler carrying its own `?? '.'` would be a second declaration of the default in
	 * a place `--help` and the JSON Schema cannot see, which is how a tool's documented
	 * default and its real one diverge.
	 */
	readonly fallback?: string | number | boolean;
}

export type Params = Readonly<Record<string, Param>>;

type Value<P extends Param> = P extends { type: 'boolean' }
	? boolean
	: P extends { type: 'integer' }
		? number
		: P extends { values: readonly (infer V extends string)[] }
			? V
			: string;

type One<P extends Param> = P extends { many: true } ? Value<P>[] : Value<P>;

/**
 * Keys a handler may read without narrowing.
 *
 * A `fallback` counts, and that is what having one is for: `page.limit` is declared with
 * one so the handler reads `input.limit` as a `number`.
 */
type Provided<P extends Params> = {
	[K in keyof P]-?: P[K] extends { required: true }
		? K
		: P[K] extends { fallback: string | number | boolean }
			? K
			: never;
}[keyof P];

/** What a command's `run` receives, computed from its own parameter table. */
export type Input<P extends Params> = {
	readonly [K in Provided<P>]: One<P[K]>;
} & {
	readonly [K in Exclude<keyof P, Provided<P>>]?: One<P[K]>;
};

/**
 * The Zod shape: the MCP tool's input schema and the CLI's validator, one definition.
 *
 * Every constraint here survives into the JSON Schema a model reads, measured against
 * zod 4.5's `toJSONSchema(schema, { io: 'input' })`: `minLength`, `enum`, `minItems`,
 * `description` and `default` all appear. Two surfaces cannot disagree about what a
 * valid call is, because there is one definition of it.
 */
export function shapeOf(params: Params): Record<string, z.ZodType> {
	const shape: Record<string, z.ZodType> = {};
	for (const [name, param] of Object.entries(params)) {
		let leaf: z.ZodType =
			param.type === 'boolean'
				? z.boolean()
				: param.type === 'integer'
					? z.int().min(0)
					: param.values === undefined
						? z.string().min(1)
						: z.enum(param.values);
		if (param.many === true) leaf = z.array(leaf).min(1);
		const described = leaf.describe(param.help);
		shape[name] =
			param.required === true
				? described
				: param.fallback === undefined
					? described.optional()
					: // The cast is unavoidable and narrow: `Param.fallback` is a union across
						// every parameter kind, and this line has already selected the kind.
						described.default(param.fallback as never);
	}
	return shape;
}

/** The JSON Schema a tool advertises. One object, `type: "object"` at the root. */
export function jsonSchemaOf(params: Params): Record<string, unknown> {
	return z.toJSONSchema(z.object(shapeOf(params)), { io: 'input' }) as Record<string, unknown>;
}
