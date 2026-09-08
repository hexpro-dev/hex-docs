/**
 * What a command is, and what it may do.
 *
 * One shape drives both front doors. The CLI dispatches on `name`, the MCP server on
 * `tool`, and both go through `invoke`, so `hexdocs check --json` and the `docs_check`
 * tool cannot describe different runs. `src/contracts/diagnostics.ts` opens by saying why
 * that matters: two finding shapes with two renderers is the drift this package exists to
 * stop happening to documentation, and it would be embarrassing to reintroduce it in the
 * tool that reports on it.
 */

import { z } from 'zod';

import type { CheckRow, DiagnosticEnvelope } from '../../../src/contracts/diagnostics.js';
import type { JsonValue } from '../compile/serialise.js';
import type { Exec } from '../exec/run.js';
import type { SkillId } from '../skills/ids.js';

import { shapeOf, type Input, type Params } from './params.js';

/**
 * Everything a command may touch, injected.
 *
 * Injected rather than imported so a test can drive `publish` against a recording fake
 * and assert the exact argv, and so the MCP server can hand over a context that cannot
 * write. Nothing here reaches for `process` or the clock directly.
 */
export interface Ctx {
	/** The consuming project. `bin/hexdocs` sets it from $PWD. */
	readonly cwd: string;
	/**
	 * `@hex-pro/docs-kit@<version>`, read once from `kit/package.json`.
	 *
	 * The manifest's `generator`, every envelope's `kitVersion` and every report's
	 * `kitVersion` come from here and nowhere else, so a stale submodule is visible in
	 * the output and one bundle cannot carry two version strings.
	 */
	readonly kitVersion: string;
	readonly exec: Exec;
	/**
	 * `null` over MCP, and that is a boundary rather than a convention.
	 *
	 * Every filesystem write in this package goes through it, so a writer reached from
	 * the server throws instead of writing. It is the runtime half of a guarantee whose
	 * other halves are the `Command` union below, which refuses to give a writer a tool
	 * name, and the import-graph walk in `kit/test/exec/no-write.test.ts`. hex-terraform
	 * makes the same claim and backs it with a source scan its own exec module is exempt
	 * from.
	 */
	readonly write: Writer | null;
	/** Injected so `label` can stamp a release date without reaching for the clock. */
	readonly now: () => Date;
	/** stderr, always. Under `hexdocs mcp`, stdout is the protocol. */
	readonly log: (line: string) => void;
}

export interface Writer {
	/** Creates parent directories. Returns false when the bytes were already there. */
	write(path: string, contents: string): boolean;
	exists(path: string): boolean;
	read(path: string): string | undefined;
	/** Every path this writer actually changed, in call order. */
	readonly written: readonly string[];
}

/**
 * One output shape, not a union.
 *
 * `data` is what `--json` prints and what the MCP tool returns; `lines` is what a person
 * reads. Both are produced in one pass by one function, so the two cannot describe
 * different runs. `VerifyInstallReport.notCheckedHere` already makes this argument from
 * the other side: a renderer holding its own copy of what happened goes stale the first
 * time a check is added, and it goes stale in the reassuring direction.
 *
 * `envelope` and `rows` are fields rather than variants because a command can produce
 * both: `build` returns a lint envelope beside a written-object count.
 */
export interface CommandOutput {
	readonly data: JsonValue;
	readonly lines: readonly string[];
	/** Empty is not absent: a clean lint has an envelope with no findings. */
	readonly envelope: DiagnosticEnvelope | null;
	readonly rows: readonly CheckRow[];
}

/**
 * Never decided by a command.
 *
 * A command that set its own exit code could report a clean run over a failing envelope,
 * which is the one thing every guard in this repository exists to make impossible.
 * `not-run` fails for the reason `scripts/lib/report.mjs` gives at length: delete the
 * thing a check reads and every row goes dark, and dark is indistinguishable from green
 * to an exit code.
 */
export function exitCodeFor(out: CommandOutput): 0 | 3 {
	if (out.envelope !== null && out.envelope.summary.errors > 0) return 3;
	if (out.rows.some((row) => row.status === 'fail' || row.status === 'not-run')) return 3;
	return 0;
}

/** What a command may touch. Declared, and checked by the union below. */
export type Writes = 'nothing' | 'files' | 'network';

interface CommandBase<P extends Params> {
	/** The CLI name. Kebab case, unique, never reused. */
	readonly name: string;
	/** One sentence. `--help`, the MCP tool title, and what a skill is validated against. */
	readonly summary: string;
	/** Why a model would pick this over another tool. The description's second paragraph. */
	readonly detail: string;
	readonly params: P;
	/**
	 * Which parameters are CLI positionals, in order.
	 *
	 * Every name is a key of `params`, and only the last may be optional. Both are
	 * asserted in `registry.test.ts` rather than typed: expressing "optional only at the
	 * end" costs more type machinery than the rule is worth.
	 */
	readonly positionals: readonly Extract<keyof P, string>[];
	/** Non-empty. A command no skill teaches is a command no agent finds. */
	readonly taughtBy: readonly [SkillId, ...SkillId[]];
	/**
	 * A method, not a property, and the difference is load-bearing.
	 *
	 * Method shorthand is checked bivariantly, which is what lets a command whose input
	 * type is its own narrow mapped type be held in the erased array below. Declared as a
	 * property it would be checked contravariantly and nothing would fit. The design this
	 * replaces wrote `as const satisfies readonly Operation<never, never>[]`, which does
	 * not compile at all, and it was the load-bearing snippet of its first section.
	 */
	run(input: Input<P>, ctx: Ctx): Promise<CommandOutput>;
}

/**
 * A command exposed over MCP cannot declare that it writes.
 *
 * The union is the enforcement: `{ tool: 'docs_publish', writes: 'network' }` has no
 * type to be. `Ctx.write === null` under MCP is the runtime half, and the import-graph
 * walk is the third. Three independent closures on one fact, because this is the
 * boundary that lets the server need no write audit, no path-safety story and no undo.
 */
export type Command<P extends Params = Params> =
	| (CommandBase<P> & { readonly tool: string; readonly writes: 'nothing' })
	| (CommandBase<P> & { readonly tool: null; readonly writes: Writes });

export function defineCommand<const P extends Params>(command: Command<P>): Command<P> {
	return command;
}

/**
 * A command with its parameter table erased, which is what the registry holds.
 *
 * `Command<P>` is the type an author writes: `run` receives `Input<P>`, so a handler
 * reading a flag nobody declared is a compile error at the definition site, which is the
 * whole reason the parameter table exists.
 *
 * That type cannot also be the array's element type, and it took a compile failure to
 * establish why rather than an assumption. `Input<Params>` collapses: `Params` is an
 * index signature, so `Provided<Params>` is `never` and every value widens to `string`.
 * So `Input<{ offset: integer }>` is assignable to `Input<Params>` in neither direction,
 * and method bivariance, which needs one of the two, does not save it.
 *
 * `never` does. Every input type is a supertype of `never`, so every `Command<P>` is
 * assignable to this, and the erasure states exactly the truth `invoke`'s comment
 * already gives: the relationship between the table and the handler's argument is
 * checked at the definition site by the type and at the call site by the schema, and
 * there is no third place where a `Command` from the array can be called with a
 * fabricated argument, because `never` has no values.
 */
interface AnyCommandBase {
	readonly name: string;
	readonly summary: string;
	readonly detail: string;
	readonly params: Params;
	readonly positionals: readonly string[];
	readonly taughtBy: readonly [SkillId, ...SkillId[]];
	run(input: never, ctx: Ctx): Promise<CommandOutput>;
}

/** The same union, so a writer with a tool name is still unrepresentable after erasure. */
export type AnyCommand =
	| (AnyCommandBase & { readonly tool: string; readonly writes: 'nothing' })
	| (AnyCommandBase & { readonly tool: null; readonly writes: Writes });

/**
 * The one cast in the package, and why it is a cast rather than a solved problem.
 *
 * Zod cannot see `Input<P>`. `shapeOf` assembles a schema from a `Params` record at
 * runtime, so its inferred output is `Record<string, unknown>` however the shape was
 * built. Typing it back would need a mapped `ZodObject` whose optional keys survive an
 * explicit annotation, and they do not: the equality would come out wrong in exactly the
 * direction that matters, marking every argument required.
 *
 * So the cast is one line, both front doors go through it, and `registry.test.ts` asserts
 * for every command that the key set the schema accepts is exactly the key set the params
 * declare. That is a runtime proof of the thing the type cannot state, which is honest,
 * where a type-level proof of the wrong proposition would not be.
 */
export async function invoke(command: AnyCommand, raw: unknown, ctx: Ctx): Promise<CommandOutput> {
	const parsed = z.object(shapeOf(command.params)).parse(raw);
	return command.run(parsed as never, ctx);
}
