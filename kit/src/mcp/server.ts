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
 * There are no resources and no prompts. A resource catalogue is a second list keyed by
 * URI that has to be kept in step with the registry by hand, which is the drift the
 * registry exists to remove, and everything the original design's seventeen resources
 * carried is reachable through `docs_skills` and `docs_pages`.
 */

import { NO_EXEC, runRecipe } from '../exec/run.js';
import { jsonSchemaOf } from '../registry/params.js';
import { TOOLS, BY_TOOL } from '../registry/index.js';
import { invoke, type Ctx } from '../registry/command.js';
import { serve, type ServerInfo, type Streams, type ToolDescriptor } from './protocol.js';

/**
 * What the server advertises.
 *
 * Every annotation here is a fact rather than a hint, because the `Command` union makes
 * the alternative unrepresentable: `readOnlyHint` is true because a tool-bearing command
 * declares `writes: 'nothing'` and could not declare otherwise.
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
			openWorldHint: false as const,
		},
	}));
}

/**
 * A context for the server: reads allowed, writes impossible.
 *
 * The exec is the read half of the recipe table. `NO_EXEC` is not used here because two
 * read-only tools genuinely need git (`docs_check` reads commit dates, `docs_label`
 * resolves ancestry), and refusing those would make the server answer differently from
 * the CLI about the same tree. The write recipes are unreachable from this module by
 * import rather than by a flag, which is what the graph walk asserts.
 */
export function serverContext(cwd: string, kitVersion: string): Ctx {
	return {
		cwd,
		kitVersion,
		exec: (id, holes, options) => {
			if (!(id in BY_TOOL_SAFE_RECIPES)) {
				throw new Error(
					`The MCP server does not run "${id}". It reads; the CLI is the only writer.`,
				);
			}
			return runRecipe(id, holes, options);
		},
		write: null,
		now: () => new Date(),
		// stderr. Under `hexdocs mcp` stdout is the protocol, and one stray line on it is a
		// parse error the client reports as a broken server with no cause attached.
		log: (line) => process.stderr.write(`${line}\n`),
	};
}

/**
 * The read recipes, as a set, so the server's exec refuses by name rather than by trust.
 *
 * Belt and braces over the import-graph walk: the walk proves the write recipes are not
 * reachable from here, and this proves that even a future module that did reach them
 * could not run one through this context.
 */
const BY_TOOL_SAFE_RECIPES: Record<string, true> = {
	'git.head': true,
	'git.head-date': true,
	'git.is-shallow': true,
	'git.log-walk': true,
	'git.ls-files-stage': true,
	'git.merge-base-is-ancestor': true,
	'gh.api': true,
	'aws.head-object': true,
	'aws.list-objects': true,
	'aws.list-objects-page': true,
	'aws.get-object': true,
};

export { NO_EXEC };

/** Runs one tool call and returns the text the client receives. */
export async function callTool(
	name: string,
	args: Record<string, unknown>,
	ctx: Ctx,
): Promise<string> {
	const command = BY_TOOL.get(name);
	if (command === undefined) throw new Error(`No tool named "${name}".`);
	const output = await invoke(command, args, ctx);
	return JSON.stringify(output.data, null, 2);
}

export function startServer(streams: Streams, ctx: Ctx): Promise<void> {
	const info: ServerInfo = { name: 'hexdocs', version: ctx.kitVersion };
	return serve(streams, info, toolDescriptors(), (name, args) => callTool(name, args, ctx));
}
