/**
 * A read-only MCP server over stdio, written here rather than taken as a dependency.
 *
 * The reasoning is the same one that made the markdown parser, the BM25 index, the
 * syntax highlighter and the stylesheet generator all live in this repository, and it is
 * stronger here than in any of those cases. `@modelcontextprotocol/sdk@1.30.0` declares
 * seventeen direct dependencies, including express, hono, cors, jose and ajv, and lands
 * roughly a hundred packages in a `kit/` that has two. That weight travels: every app
 * repository mounts this submodule, `.mcp.json` points at `bin/hexdocs`, and hex-nfc is a
 * Swift repository whose first agent session pays for the install before the server
 * answers `initialize`. None of that weight is transport this server uses.
 *
 * What a tools-only stdio server actually owes a client, measured against the SDK on
 * disk rather than recalled:
 *
 *   * Framing is newline-delimited JSON. `shared/stdio.js` is exactly
 *     `JSON.stringify(message) + '\n'`, and the reader splits on `\n` and strips a
 *     trailing `\r`.
 *   * `initialize` must answer with a `protocolVersion` the client supports.
 *     `client/index.js` sends its own latest and then checks the reply is a member of
 *     `SUPPORTED_PROTOCOL_VERSIONS`, so echoing a supported request and otherwise
 *     answering with this server's own latest is correct.
 *   * `notifications/initialized` arrives with no id and takes no reply.
 *   * `tools/list` returns `{ tools }` where each tool's `inputSchema` is a JSON Schema
 *     object with `type: "object"` at its root, which is what `z.toJSONSchema` emits.
 *   * `tools/call` returns `{ content: [{ type: 'text', text }] }`, and a handler that
 *     threw is reported as a result with `isError: true` rather than as a protocol error.
 *   * `ping` answers `{}`.
 *
 * The claim that this is right is not left as prose. `kit/test/mcp/protocol.test.ts`
 * drives this server with the real SDK's `Client`, which is a devDependency and never
 * ships: `bin/hexdocs` installs production dependencies only. So the protocol is proved
 * against the reference implementation while the reference implementation stays out of
 * every consumer's tree.
 *
 * Nothing here writes to stdout except a response. That is why `Ctx.log` is stderr and
 * why the launcher redirects install chatter: one stray line on stdout is a parse error
 * the client reports as a broken server with no cause attached.
 */

import { StringDecoder } from 'node:string_decoder';

/** This server's own latest. In `SUPPORTED_PROTOCOL_VERSIONS` for SDK 1.30. */
export const PROTOCOL_VERSION = '2025-11-25';

/**
 * Versions this server will echo back when a client asks for one of them.
 *
 * A client that asks for something else is answered with `PROTOCOL_VERSION`, which the
 * spec allows and which the SDK's client accepts as long as it recognises the reply.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
	'2025-11-25',
	'2025-06-18',
	'2025-03-26',
	'2024-11-05',
] as const;

export interface ToolDescriptor {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly annotations: {
		readonly readOnlyHint: true;
		readonly destructiveHint: false;
		readonly idempotentHint: true;
		readonly openWorldHint: false;
	};
}

export interface ServerInfo {
	readonly name: string;
	readonly version: string;
}

export interface ToolHandler {
	(name: string, args: Record<string, unknown>): Promise<string>;
}

type Id = string | number;

interface Request {
	jsonrpc: '2.0';
	id?: Id;
	method?: unknown;
	params?: unknown;
}

/** JSON-RPC 2.0 codes. Only the four a server of this shape can produce. */
export const RPC = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
} as const;

function result(id: Id, value: unknown): string {
	return JSON.stringify({ jsonrpc: '2.0', id, result: value });
}

function failure(id: Id, code: number, message: string): string {
	return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

export interface Handled {
	/** The line to write to stdout, or `null` for a notification, which takes no reply. */
	readonly reply: string | null;
}

/**
 * Answers one parsed message.
 *
 * Pure but for the tool handler, so the whole protocol is testable without a process and
 * the transport below is fifteen lines with nothing to get wrong.
 */
export async function handleMessage(
	message: unknown,
	info: ServerInfo,
	tools: readonly ToolDescriptor[],
	call: ToolHandler,
): Promise<Handled> {
	// `Array.isArray` is not tidiness. A JSON array on this wire is a JSON-RPC batch, and
	// `typeof [] === 'object'`, so without it an array passes the object test, falls through
	// to the notification arm because it has no `id`, and is dropped with no reply and no
	// error at all. Batching was removed from MCP in 2025-06-18 and is permitted in
	// 2025-03-26 and 2024-11-05, both of which this server offers, so a conforming client
	// that negotiated one of those and batched its requests would hang until its own
	// timeout with nothing on the wire saying why. Nothing here wants to implement
	// batching; it wants to say so out loud.
	if (typeof message !== 'object' || message === null || Array.isArray(message)) {
		return {
			reply: failure(
				0,
				RPC.invalidRequest,
				Array.isArray(message)
					? 'This server does not implement JSON-RPC batching. Send one request per line.'
					: 'A message must be a JSON object.',
			),
		};
	}
	const request = message as Request;
	const method = typeof request.method === 'string' ? request.method : undefined;

	// No id means a notification. The spec says a notification is never answered, and
	// answering one is not harmless: the client has no pending request to match it to and
	// reports an unsolicited response.
	if (request.id === undefined) {
		return { reply: null };
	}
	const id = request.id;

	if (method === undefined) {
		return { reply: failure(id, RPC.invalidRequest, 'A request must carry a method.') };
	}

	if (method === 'initialize') {
		const asked = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
		const version =
			typeof asked === 'string' &&
			(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
				? asked
				: PROTOCOL_VERSION;
		return {
			reply: result(id, {
				protocolVersion: version,
				capabilities: { tools: {} },
				serverInfo: info,
			}),
		};
	}

	if (method === 'ping') return { reply: result(id, {}) };

	if (method === 'tools/list') return { reply: result(id, { tools }) };

	if (method === 'tools/call') {
		const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
		if (typeof params.name !== 'string') {
			return { reply: failure(id, RPC.invalidParams, 'tools/call needs a tool name.') };
		}
		if (!tools.some((tool) => tool.name === params.name)) {
			return { reply: failure(id, RPC.methodNotFound, `No tool named "${params.name}".`) };
		}
		const args =
			typeof params.arguments === 'object' && params.arguments !== null
				? (params.arguments as Record<string, unknown>)
				: {};
		try {
			const text = await call(params.name, args);
			return { reply: result(id, { content: [{ type: 'text', text }] }) };
		} catch (error) {
			// A tool that found twelve errors ran perfectly; the tool did not fail. Only a
			// thrown handler is a tool failure, and it is reported as a result the model can
			// read rather than as a protocol error the client swallows.
			return {
				reply: result(id, {
					content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
					isError: true,
				}),
			};
		}
	}

	return { reply: failure(id, RPC.methodNotFound, `This server does not implement "${method}".`) };
}

export interface Streams {
	readonly input: NodeJS.ReadableStream;
	readonly output: NodeJS.WritableStream;
}

/**
 * The transport: split stdin on newlines, answer each line, write each reply.
 *
 * A malformed line is answered rather than fatal. A client that sent one is still there,
 * and killing the server takes the session with it for a bug in one frame.
 */
export function serve(
	streams: Streams,
	info: ServerInfo,
	tools: readonly ToolDescriptor[],
	call: ToolHandler,
): Promise<void> {
	return new Promise((resolve) => {
		let buffer = '';
		// Replies are chained rather than raced, so two overlapping tool calls cannot
		// interleave their writes into one line.
		let queue: Promise<void> = Promise.resolve();

		const push = (line: string): void => {
			queue = queue.then(async () => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					streams.output.write(`${failure(0, RPC.parseError, 'Not JSON.')}\n`);
					return;
				}
				let handled: Handled;
				try {
					handled = await handleMessage(parsed, info, tools, call);
				} catch (error) {
					handled = {
						reply: failure(
							0,
							RPC.internalError,
							error instanceof Error ? error.message : String(error),
						),
					};
				}
				if (handled.reply !== null) streams.output.write(`${handled.reply}\n`);
			});
		};

		// A `StringDecoder` rather than `chunk.toString('utf8')`, and it is not tidiness.
		//
		// stdin arrives as raw Buffers chunked by the pipe read size, so a multi-byte
		// character lands across a chunk boundary as a matter of course. Decoding each
		// chunk on its own turns the split sequence into replacement characters, and the
		// failure is silent rather than loud: U+FFFD is legal inside a JSON string, so the
		// frame parses, the tool dispatches, and the handler is called with a different
		// argument from the one that was sent. Measured on a boundary one byte into a
		// Japanese query: the handler received three replacement characters followed by the
		// second character, replied normally, and nothing reached stderr.
		//
		// It is reachable in four of the seven languages this package ships, on any
		// `docs_page` slug or search query long enough to cross a read. The decoder holds
		// the incomplete tail until the rest of it arrives, which is what the reference
		// implementation gets for free by concatenating Buffers and decoding only up to the
		// newline.
		const decoder = new StringDecoder('utf8');
		streams.input.on('data', (chunk: Buffer | string) => {
			buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
			for (;;) {
				const index = buffer.indexOf('\n');
				if (index === -1) break;
				const line = buffer.slice(0, index).replace(/\r$/, '');
				buffer = buffer.slice(index + 1);
				if (line.trim() !== '') push(line);
			}
		});
		streams.input.on('end', () => {
			void queue.then(resolve);
		});
	});
}
