/**
 * The MCP surface, derived from the registry.
 *
 * There is no second list of tools and no `mcpTools` array: `TOOLS` is
 * `COMMANDS.filter(c => c.tool !== null)`, and the type refuses to give a tool name to a
 * command that writes. So "the MCP server never mutates anything" is a property of the
 * registry rather than a claim in a comment, and the three things that hold it up are
 * that union, `Ctx.write === null` here, and the import-graph walk in
 * `kit/test/exec/no-write.test.ts`.
 *
 * Writing nothing is not the same as running nothing, and step 8 is where that difference
 * was measured. Two tools start a binary in a directory their arguments name, so every call
 * has its paths confined to the project before it runs (`confine.ts`), runs only the
 * recipes its command declares, and is annotated from those recipes rather than from a
 * constant.
 *
 * There are no resources and no prompts. A resource catalogue is a second list keyed by
 * URI that has to be kept in step with the registry by hand, which is the drift the
 * registry exists to remove, and everything the original design's seventeen resources
 * carried is reachable through `docs_skills` and `docs_pages`.
 */

import { READ_RECIPES, type ReadRecipeId, type Recipe } from '../exec/recipes.js';
import { NO_EXEC, runRecipe, type Exec } from '../exec/run.js';
import { jsonSchemaOf } from '../registry/params.js';
import { TOOLS, BY_TOOL } from '../registry/index.js';
import { invoke, type AnyCommand, type Ctx } from '../registry/command.js';

import { confinementRefusal } from './confine.js';
import { serve, type ServerInfo, type Streams, type ToolDescriptor } from './protocol.js';

/**
 * Whether a binary reaches past the repository a tool was pointed at.
 *
 * `Record` over the `bin` union, so a fifth binary added to the recipe table does not
 * typecheck until somebody decides which side of this it is on.
 *
 * `git` is the one closed binary: every git recipe reads the repository at a root that
 * `confine.ts` has already held inside the project. `aws` and `gh` are the network.
 * `react-router` reads no network and is still open, because it executes the consuming
 * site's route config and everything that imports, which is code this package did not
 * write and cannot bound.
 */
export const OPEN_WORLD: Readonly<Record<Recipe['bin'], boolean>> = {
	git: false,
	aws: true,
	gh: true,
	'./node_modules/.bin/react-router': true,
};

/** A tool's recipes, which is what its annotations and its gate are both derived from. */
function runsOf(command: AnyCommand): readonly ReadRecipeId[] {
	return command.tool === null ? [] : command.runs;
}

/**
 * What the server advertises.
 *
 * `readOnlyHint`, `destructiveHint` and `idempotentHint` are the same for every tool, and
 * each is a consequence of the `Command` union: a tool-bearing command declares `writes:
 * 'nothing'` and could not declare otherwise. `openWorldHint` is not a constant. It is
 * true for a tool whose declared recipes include a binary `OPEN_WORLD` calls open, and the
 * declaration is what the gate in `callTool` holds a call to, so the hint cannot promise a
 * closed world for a tool that can reach AWS, GitHub or a consuming site's own code.
 *
 * These are hints to a client, and a client may approve a call on them. That is why the
 * value is derived rather than written, and why a root is confined whatever they say.
 */
export function toolDescriptors(): ToolDescriptor[] {
	return TOOLS.map((command) => ({
		name: command.tool as string,
		title: command.summary,
		description: `${command.summary}\n\n${command.detail}`,
		inputSchema: jsonSchemaOf(command.params),
		annotations: {
			readOnlyHint: true as const,
			destructiveHint: false as const,
			idempotentHint: true as const,
			openWorldHint: runsOf(command).some((id) => OPEN_WORLD[(READ_RECIPES[id] as Recipe).bin]),
		},
	}));
}

/**
 * Every recipe any tool declares, which is every recipe this context will run.
 *
 * Derived rather than listed. It used to be a hand-written set, and that set carried
 * `aws.get-object`, whose third hole is a local path s3api writes, under a comment saying
 * this context could not write. No tool reached it; the set allowed it anyway. A recipe is
 * here now only because a tool's `runs` names it, and `runs` is typed `ReadRecipeId[]`, so
 * the fetch and the puts cannot be named at all.
 *
 * A function rather than a module-level constant, because this module and the registry
 * import each other through `commands/mcp.ts`: at the moment this file is evaluated
 * `TOOLS` has not been assigned yet, and a constant here throws on load.
 */
export function mcpRecipes(): ReadonlySet<ReadRecipeId> {
	return new Set(TOOLS.flatMap(runsOf));
}

/**
 * A context for the server: no writer, and an exec that runs only what a tool declares.
 *
 * `NO_EXEC` is not used here because four read-only tools genuinely need a recipe
 * (`docs_check` reads commit dates, `docs_label` resolves ancestry, `docs_verify_install`
 * and `docs_doctor` read the gitlink and the route table), and refusing those would make
 * the server answer differently from the CLI about the same tree. The fetch and the
 * write recipes cannot enter the set this context runs from, by type, and the import-graph
 * walk asserts the write table is not imported by anything a tool reaches.
 */
export function serverContext(cwd: string, kitVersion: string): Ctx {
	return {
		cwd,
		kitVersion,
		exec: gated(runRecipe, mcpRecipes(), 'The MCP server'),
		write: null,
		now: () => new Date(),
		// stderr. Under `hexdocs mcp` stdout is the protocol, and one stray line on it is a
		// parse error the client reports as a broken server with no cause attached.
		log: (line) => process.stderr.write(`${line}\n`),
	};
}

/** An exec that refuses, by name, any recipe outside `allowed`. */
function gated(exec: Exec, allowed: ReadonlySet<string>, who: string): Exec {
	return (id, holes, options) => {
		if (!allowed.has(id)) {
			throw new Error(
				`${who} does not run "${id}". A tool runs only the recipes its command declares, and the CLI is the only writer.`,
			);
		}
		return exec(id, holes, options);
	};
}

export { NO_EXEC };

/**
 * Runs one tool call and returns the text the client receives.
 *
 * Two things happen before the command, in this order. The call's `root` and `site` are
 * held inside `ctx.cwd`, and a call that leaves it throws a `ToolRefusal` carrying the
 * finding, which the protocol reports as a tool error, before anything is read or started.
 * Then the context's exec is narrowed to this command's own `runs`, so a tool cannot start
 * a recipe another tool declared.
 */
export async function callTool(
	name: string,
	args: Record<string, unknown>,
	ctx: Ctx,
): Promise<string> {
	const command = BY_TOOL.get(name);
	if (command === undefined) throw new Error(`No tool named "${name}".`);
	const refusal = confinementRefusal(command, args, ctx.cwd, ctx.kitVersion);
	if (refusal !== null) throw refusal;
	const narrowed: Ctx = { ...ctx, exec: gated(ctx.exec, new Set(runsOf(command)), name) };
	const output = await invoke(command, args, narrowed);
	return JSON.stringify(output.data, null, 2);
}

export function startServer(streams: Streams, ctx: Ctx): Promise<void> {
	const info: ServerInfo = { name: 'hexdocs', version: ctx.kitVersion };
	return serve(streams, info, toolDescriptors(), (name, args) => callTool(name, args, ctx));
}
