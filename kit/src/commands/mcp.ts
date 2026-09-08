/**
 * `hexdocs mcp`: serve the read-only tool surface over stdio.
 *
 * CLI only, and `tool: null` is not a technicality. A tool that starts the server is a
 * server calling itself, and the `Command` union would have allowed it: this command
 * writes nothing, so it could have carried a tool name. The null is the one place in the
 * registry where the reason is the shape of the surface rather than the `writes` field.
 *
 * **`run` blocks for the life of the process**, which is unlike every other command in the
 * registry, and it is worth saying plainly rather than leaving somebody to discover it.
 * Every other `run` computes an answer and returns; this one resolves only when stdin
 * ends, which is when the client has gone. The consequences are real and they are
 * accepted here rather than designed around:
 *
 *   * `main.ts` renders and exits after `run` resolves, so its rendering is dead code for
 *     this command in every session that matters. That is why the output below is empty.
 *   * `exitCodeFor` sees no rows and no envelope, so `hexdocs mcp` exits 0 whatever the
 *     session contained. A tool call that failed is reported to the client as a JSON-RPC
 *     error, which is where a client can act on it; an exit code nobody waits for is not.
 *   * A test cannot call this without supplying streams, so `kit/test/mcp/transport.test.ts`
 *     drives `startServer` directly with a pair of in-memory streams and this module is
 *     three lines of wiring over it.
 *
 * The alternative, a separate `kit/src/mcp/main.ts` outside the registry, was rejected for
 * one reason: the launcher is `bin/hexdocs`, `.mcp.json` spells the command as
 * `hexdocs mcp`, and a subcommand that the registry does not know about is a subcommand
 * `--help` does not list and the dispatcher answers with "there is no command called mcp".
 */

import { serverContext, startServer } from '../mcp/server.js';
import { defineCommand } from '../registry/command.js';

export const mcp = defineCommand({
	name: 'mcp',
	tool: null,
	writes: 'nothing',
	summary: 'Serve the hexdocs read-only tools over stdio as an MCP server.',
	detail:
		'Speaks JSON-RPC on stdin and stdout and exposes every read-only hexdocs command as a tool. Every diagnostic line goes to stderr, because stdout is the protocol and one stray line on it is a parse error the client reports as a broken server with no cause attached. This is what a .mcp.json entry runs; nothing else should invoke it.',
	params: {},
	positionals: [],
	taughtBy: ['docs-install-site'],
	async run(_input, ctx) {
		// `process.stdin` and `process.stdout` rather than anything injected, because this is
		// the process shell: the streams are what `.mcp.json` connected the client to, and a
		// context field for them would be a field with exactly one possible value on the one
		// code path that reads it. `startServer` takes them as an argument, so the test does
		// not go through here at all.
		await startServer(
			{ input: process.stdin, output: process.stdout },
			serverContext(ctx.cwd, ctx.kitVersion),
		);

		// Nothing to say, and saying nothing is load-bearing on this command alone. `lines`
		// is empty so the renderer emits no text, which keeps stdout clean for the protocol
		// that just finished using it. `--json` is the one hole left: the dispatcher prints
		// `data` to stdout when it is passed, so `hexdocs mcp --json` writes one `null` after
		// the stream has closed. That is after the client has disconnected and is never
		// interleaved with a frame, but it is not nothing, and nobody should pass `--json`
		// here.
		return { data: null, lines: [], envelope: null, rows: [] };
	},
});
