/**
 * The hand-written MCP server, driven by the reference implementation's own client.
 *
 * `kit/src/mcp/protocol.ts` is about two hundred lines instead of a hundred packages, and
 * the whole justification for writing it here is that the protocol claim can be proved
 * against the SDK without shipping the SDK. `@modelcontextprotocol/sdk` is a devDependency
 * and `bin/hexdocs` installs production dependencies only, so this file is the only place
 * in the repository that imports it.
 *
 * Two routes are driven, and both go through the real launcher rather than around it.
 *
 *   * The SDK's `Client` over `StdioClientTransport`, spawning `kit/bin/hexdocs mcp` as a
 *     child process. That is the transport `.mcp.json` connects, so the handshake, the
 *     framing, the tool listing and the tool call are all the reference implementation's
 *     code talking to this server's, and the launcher is exercised on the way.
 *   * A raw child process with hand-written frames, for the four cases the SDK's client
 *     will not produce: a malformed line, a notification, an unknown method, and the one
 *     that matters most, whether anything other than a response ever reaches stdout.
 *
 * A third block drives `serve()` in process over a pair of streams, which is where the
 * framing itself is testable: two frames in one chunk, one frame split across two, and a
 * CRLF terminator.
 *
 * The stdout assertion is the reason the launcher redirects install chatter to stderr and
 * the reason `Ctx.log` is stderr, and nothing else in the repository tests it. One stray
 * byte there is a parse error the client reports as a broken server with no cause
 * attached, which is the least debuggable failure this package can produce.
 */

import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SUPPORTED_PROTOCOL_VERSIONS as SDK_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
	PROTOCOL_VERSION,
	RPC,
	SUPPORTED_PROTOCOL_VERSIONS,
	serve,
	type ToolDescriptor,
} from '../../src/mcp/protocol.js';
import { toolDescriptors } from '../../src/mcp/server.js';
import { TOOLS } from '../../src/registry/index.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const LAUNCHER = join(REPO_ROOT, 'kit', 'bin', 'hexdocs');
/** An application repository, so a tool call has a real tree to answer about. */
const APP = join(REPO_ROOT, 'fixtures', 'app');

/** Every tool name the registry advertises, which is what the listing is checked against. */
const REGISTRY_TOOL_NAMES = TOOLS.map((command) => command.tool as string).sort();

/* -------------------------------------------------------------------------- */
/* a raw session, for the frames a client will not send                        */
/* -------------------------------------------------------------------------- */

interface RawSession {
	stdout: string;
	stderr: string;
	code: number | null;
}

/**
 * Writes every line, closes stdin, and collects what came back.
 *
 * Closing stdin immediately is deterministic rather than a race: `serve` splits on `data`
 * events and resolves on `end`, and `end` cannot fire before the data already written has
 * been delivered. The reply queue is chained inside `serve`, so the replies arrive in the
 * order the requests did.
 */
function rawSession(lines: readonly string[]): Promise<RawSession> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(LAUNCHER, ['mcp'], {
			cwd: APP,
			env: { ...process.env, HEXDOCS_PROJECT_ROOT: APP },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.on('error', reject);
		child.on('close', (code) => {
			resolvePromise({ stdout, stderr, code });
		});
		child.stdin.write(lines.map((line) => `${line}\n`).join(''));
		child.stdin.end();
	});
}

const frame = (value: unknown): string => JSON.stringify(value);

interface Reply {
	jsonrpc?: unknown;
	id?: unknown;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

/* -------------------------------------------------------------------------- */
/* the SDK client, over the real launcher                                      */
/* -------------------------------------------------------------------------- */

describe('the reference client against the real launcher', () => {
	let client: Client;
	let listed: { name: string; inputSchema: Record<string, unknown>; description?: string }[] = [];
	/**
	 * Why the handshake did not happen, or `null`.
	 *
	 * Caught rather than thrown, and the reason is this repository's own rule about a check
	 * that examined nothing. A `beforeAll` that throws makes vitest report every test in its
	 * block as SKIPPED, and a skipped test reads like a decision somebody made. Measured on
	 * the raw-frames block below rather than argued: with its parse left inside the hook, one
	 * line of chatter written to stdout turned all eleven of its rows into skips and the file
	 * still read as passing. This hook spawns a process that can fail to start for reasons
	 * that have nothing to do with the protocol, so it gets the same treatment.
	 */
	let setupError: string | null = null;

	beforeAll(async () => {
		const transport = new StdioClientTransport({
			command: LAUNCHER,
			args: ['mcp'],
			cwd: APP,
			env: { ...process.env, HEXDOCS_PROJECT_ROOT: APP } as Record<string, string>,
			stderr: 'pipe',
		});
		client = new Client({ name: 'hexdocs-protocol-test', version: '0.0.0' }, { capabilities: {} });
		try {
			// `connect` performs the whole handshake and throws if the reply is not one this
			// client recognises, so reaching the next line is already the initialize assertion.
			await client.connect(transport);
			listed = (await client.listTools()).tools as typeof listed;
		} catch (error) {
			setupError = error instanceof Error ? error.message : String(error);
		}
	});

	afterAll(async () => {
		try {
			await client.close();
		} catch {
			// A transport that never connected has nothing to close, and a failure here would
			// replace the diagnosis below with one about teardown.
		}
	});

	test('the SDK client completed the handshake', () => {
		expect(setupError, 'the reference client could not talk to this server').toBeNull();
		expect(listed.length, 'the handshake succeeded and listed nothing').toBeGreaterThan(0);
	});

	test('the handshake reports this server and its capabilities', () => {
		expect(client.getServerVersion()).toEqual({ name: 'hexdocs', version: expect.any(String) });
		// Tools and nothing else. A resource catalogue would be a second list keyed by URI
		// that has to be kept in step with the registry by hand, and advertising a capability
		// this server does not implement is how a client is told to ask for something that
		// answers with method-not-found.
		expect(client.getServerCapabilities()).toEqual({ tools: {} });
	});

	test('this server latest version is one the SDK accepts', () => {
		// The claim in `protocol.ts` line by line, checked against the reference list rather
		// than recalled. A version bumped here without checking would make every client
		// refuse the handshake with a message about the version and nothing about the cause.
		expect(SDK_VERSIONS).toContain(PROTOCOL_VERSION);
		for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
			expect(SDK_VERSIONS, `${version} is not a version this SDK knows`).toContain(version);
		}
	});

	test('listTools returns exactly the registry tool names, in both directions', () => {
		expect(listed.map((tool) => tool.name).sort()).toEqual(REGISTRY_TOOL_NAMES);
		// Not vacuous, and the number is the one `registry/index.ts` states in prose: sixteen
		// commands, nine tools.
		expect(REGISTRY_TOOL_NAMES.length).toBe(9);
	});

	test("every tool's schema is an object schema whose required set is the declared one", () => {
		const problems: string[] = [];
		for (const command of TOOLS) {
			const name = command.tool as string;
			const tool = listed.find((candidate) => candidate.name === name);
			if (tool === undefined) {
				problems.push(`${name} was not listed`);
				continue;
			}
			if (tool.inputSchema['type'] !== 'object') {
				problems.push(`${name}: inputSchema type is ${String(tool.inputSchema['type'])}`);
			}
			// Derived from the parameter table, in both directions. A parameter that lost its
			// `required` flag is a tool a model calls with nothing and gets a validation error
			// from, and a parameter that gained one silently is a tool a model stops being able
			// to call at all.
			const declared = Object.entries(command.params)
				.filter(([, param]) => param.required === true)
				.map(([key]) => key)
				.sort();
			const advertised = [...((tool.inputSchema['required'] as string[] | undefined) ?? [])].sort();
			if (JSON.stringify(declared) !== JSON.stringify(advertised)) {
				problems.push(
					`${name}: declares [${declared.join(', ')}] and advertises [${advertised.join(', ')}]`,
				);
			}
			// Every parameter reaches the schema, so a flag that exists on the CLI and not over
			// MCP cannot happen. `properties` is where a model looks before deciding what to
			// send, and `help` is the description it reads.
			const properties = Object.keys(
				(tool.inputSchema['properties'] as Record<string, unknown> | undefined) ?? {},
			).sort();
			if (JSON.stringify(properties) !== JSON.stringify(Object.keys(command.params).sort())) {
				problems.push(`${name}: properties are [${properties.join(', ')}]`);
			}
		}
		expect(problems).toEqual([]);
	});

	test('every tool is annotated read-only, and the annotation is a fact', () => {
		// `readOnlyHint` is true because a tool-bearing command declares `writes: 'nothing'`
		// and the `Command` union gives it no other type to have. The assertion is over the
		// descriptors this package builds rather than over the wire, because the wire copy
		// would pass with a hard-coded quartet.
		for (const descriptor of toolDescriptors() as ToolDescriptor[]) {
			expect(descriptor.annotations).toEqual({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			});
		}
		for (const command of TOOLS) expect(command.writes).toBe('nothing');
	});

	test('ping answers', async () => {
		expect(await client.ping()).toEqual({});
	});

	test('a tool call comes back as text the client can read', async () => {
		const result = await client.callTool({
			name: 'docs_skills',
			arguments: { id: 'docs-diagnose' },
		});
		const content = result.content as { type: string; text: string }[];
		expect(content).toHaveLength(1);
		expect(content[0]?.type).toBe('text');
		expect(result.isError).not.toBe(true);
		const data = JSON.parse(content[0]?.text ?? '') as { skills: { id: string }[] };
		expect(data.skills.map((skill) => skill.id)).toEqual(['docs-diagnose']);
	});

	test('a missing required argument is an error the client can read', async () => {
		// Not a hang and not a protocol error the client swallows. A tool that found twelve
		// problems ran perfectly; only a handler that threw is a tool failure, and it comes
		// back as a result with `isError` so the model sees the message rather than the
		// client seeing a broken server.
		const result = await client.callTool({ name: 'docs_page', arguments: {} });
		expect(result.isError).toBe(true);
		const content = result.content as { type: string; text: string }[];
		expect(content[0]?.text).toContain('slug');
	});

	test('an unknown tool is a JSON-RPC error rather than a result', async () => {
		// The other side of the same line. A name nothing dispatches is a caller mistake the
		// protocol has a code for, and answering it with an empty result would let an agent
		// believe it had called something.
		await expect(client.callTool({ name: 'docs_publish', arguments: {} })).rejects.toThrow(
			/docs_publish/,
		);
	});
});

/* -------------------------------------------------------------------------- */
/* the raw frames                                                              */
/* -------------------------------------------------------------------------- */

describe('one session of raw frames', () => {
	let session: RawSession;
	const replies: Reply[] = [];
	/** Lines on stdout that are not JSON at all, which is what the purity test reads. */
	const junk: string[] = [];

	beforeAll(async () => {
		session = await rawSession([
			frame({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2024-11-05',
					capabilities: {},
					clientInfo: { name: 'raw', version: '0' },
				},
			}),
			frame({ jsonrpc: '2.0', method: 'notifications/initialized' }),
			frame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
			frame({ jsonrpc: '2.0', id: 3, method: 'ping' }),
			// A tool call that reads the tree, so the stdout assertion covers a handler doing
			// real work rather than only the handshake.
			frame({
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: { name: 'docs_pages', arguments: { root: APP } },
			}),
			'{ this is not json',
			frame({ jsonrpc: '2.0', id: 5, method: 'no/such/method' }),
			frame({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'docs_nothing' } }),
			frame({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} }),
			// After everything else, so a reply to it proves the server survived the malformed
			// line rather than merely answering it.
			frame({ jsonrpc: '2.0', id: 8, method: 'ping' }),
			'   ',
			frame({
				jsonrpc: '2.0',
				id: 9,
				method: 'initialize',
				params: { protocolVersion: 'not-a-version', capabilities: {} },
			}),
		]);
		// Parsed leniently, and the leniency is the point. Parsing inside the hook would make a
		// single stray line on stdout throw here, and vitest reports every test in a block
		// whose hook threw as SKIPPED rather than as failed. Measured: with the parse in the
		// hook, printing one line of chatter from `commands/mcp.ts` turned all eleven of these
		// rows into skips and the file still read as passing.
		for (const line of session.stdout.split('\n')) {
			if (line === '') continue;
			try {
				replies.push(JSON.parse(line) as Reply);
			} catch {
				junk.push(line);
			}
		}
	});

	test('not one byte of non-protocol output reaches stdout', () => {
		// The failure the launcher's stderr redirect exists for, and the only test of it. The
		// whole stream is parsed rather than searched: a progress line, a `console.log` left
		// in a handler, a deprecation warning printed by a dependency and a stack trace all
		// fail here, and every one of them reaches a client as "the server is broken" with
		// nothing saying why.
		expect(junk, 'a line on stdout that is not JSON').toEqual([]);
		expect(session.stdout.endsWith('\n')).toBe(true);
		for (const parsed of replies) {
			const shown = JSON.stringify(parsed).slice(0, 80);
			expect(parsed.jsonrpc, `not JSON-RPC: ${shown}`).toBe('2.0');
			expect(
				parsed.result === undefined ? parsed.error : parsed.result,
				`neither a result nor an error: ${shown}`,
			).toBeDefined();
		}
		expect(session.code).toBe(0);
	});

	test('the reply count is exactly the request count', () => {
		// Ten requests carried an id; the notification and the blank line carried none. A
		// notification that was answered is not harmless: the client has no pending request
		// to match the reply to and reports an unsolicited response.
		expect(replies).toHaveLength(10);
		expect(replies.filter((reply) => reply.id === 0)).toHaveLength(1);
		expect(replies.map((reply) => reply.id)).toEqual([1, 2, 3, 4, 0, 5, 6, 7, 8, 9]);
	});

	test('initialize echoes a version this server supports', () => {
		expect(replies[0]?.result?.['protocolVersion']).toBe('2024-11-05');
		expect(replies[0]?.result?.['serverInfo']).toMatchObject({ name: 'hexdocs' });
	});

	test('initialize answers an unknown version with its own latest', () => {
		// The spec allows it and the SDK's client accepts it as long as it recognises the
		// reply, which the version assertion in the block above is what checks.
		expect(replies[9]?.result?.['protocolVersion']).toBe(PROTOCOL_VERSION);
	});

	test('tools/list over the raw wire matches the registry, in both directions', () => {
		const tools = replies[1]?.result?.['tools'] as { name: string }[];
		expect(tools.map((tool) => tool.name).sort()).toEqual(REGISTRY_TOOL_NAMES);
	});

	test('a malformed line is answered rather than fatal', () => {
		const parseError = replies[4];
		expect(parseError?.error?.code).toBe(RPC.parseError);
		// The line after it was still answered, and so was the ping sent three frames later.
		// A server that died on a bad frame takes the whole session with it for one bug in
		// one message.
		expect(replies[5]?.error?.code).toBe(RPC.methodNotFound);
		expect(replies[8]?.result).toEqual({});
	});

	test('an unknown method is method-not-found and names the method', () => {
		expect(replies[5]?.error?.code).toBe(RPC.methodNotFound);
		expect(replies[5]?.error?.message).toContain('no/such/method');
	});

	test('a tools/call for a tool that does not exist is method-not-found', () => {
		expect(replies[6]?.error?.code).toBe(RPC.methodNotFound);
		expect(replies[6]?.error?.message).toContain('docs_nothing');
	});

	test('a tools/call with no tool name is invalid-params', () => {
		// A different code from the one above, because the two are different mistakes: a name
		// this server does not have, and a call with no name at all.
		expect(replies[7]?.error?.code).toBe(RPC.invalidParams);
	});

	test('a real tool call answered with the compiled report', () => {
		const content = replies[3]?.result?.['content'] as { type: string; text: string }[];
		expect(content[0]?.type).toBe('text');
		const data = JSON.parse(content[0]?.text ?? '') as { project: string; pages: unknown[] };
		expect(data.project).toBe('fixture-app');
		expect(data.pages.length).toBeGreaterThan(0);
	});

	test('the diagnostics went to stderr, or nowhere', () => {
		// `Ctx.log` writes to stderr under the server, so this is allowed to be non-empty. The
		// assertion is only that nothing here was needed to make stdout parse.
		expect(typeof session.stderr).toBe('string');
	});
});

/* -------------------------------------------------------------------------- */
/* the transport, in process                                                   */
/* -------------------------------------------------------------------------- */

describe('serve() framing', () => {
	const INFO = { name: 'test', version: '0' };
	const TOOLS_FOR_SERVE: ToolDescriptor[] = [
		{
			name: 'echo',
			title: 'Echo',
			description: 'Echo',
			inputSchema: { type: 'object', properties: {} },
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
	];

	/** Drives `serve` over a pair of streams and returns every line it wrote. */
	async function run(
		chunks: readonly string[],
		call: (name: string, args: Record<string, unknown>) => Promise<string> = async () => 'ok',
	): Promise<Reply[]> {
		const input = new PassThrough();
		const output = new PassThrough();
		let written = '';
		output.on('data', (chunk: Buffer) => {
			written += chunk.toString('utf8');
		});
		const finished = serve({ input, output }, INFO, TOOLS_FOR_SERVE, call);
		for (const chunk of chunks) input.write(chunk);
		input.end();
		await finished;
		return written
			.split('\n')
			.filter((line) => line !== '')
			.map((line) => JSON.parse(line) as Reply);
	}

	test('two frames in one chunk are two replies', () => {
		// Newline-delimited JSON is a framing, not a line-per-write. A reader that assumed one
		// message per chunk would drop the second half of every batched write, which is what a
		// client sending `initialize` and `notifications/initialized` together produces.
		return expect(
			run([
				`${frame({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n${frame({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`,
			]),
		).resolves.toHaveLength(2);
	});

	test('one frame split across two chunks is one reply', async () => {
		const line = frame({ jsonrpc: '2.0', id: 1, method: 'ping' });
		const replies = await run([line.slice(0, 12), `${line.slice(12)}\n`]);
		expect(replies).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
	});

	test('a CRLF terminator is stripped', async () => {
		// `shared/stdio.js` in the SDK writes `\n`, but a transport on the other side of a
		// pipe on Windows, or anything that went through a text-mode filter, sends `\r\n`. A
		// trailing carriage return left on the line makes `JSON.parse` fail on a frame that
		// was perfectly well formed.
		const replies = await run([`${frame({ jsonrpc: '2.0', id: 7, method: 'ping' })}\r\n`]);
		expect(replies).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }]);
	});

	test('a scalar message is an invalid request', async () => {
		const replies = await run(['"a string"\n', '42\n', 'null\n']);
		expect(replies.map((reply) => reply.error?.code)).toEqual([
			RPC.invalidRequest,
			RPC.invalidRequest,
			RPC.invalidRequest,
		]);
	});

	/**
	 * A defect this file found, since closed. The reasoning is kept because it is the whole
	 * argument for the guard, and the guard is one `Array.isArray` that reads like tidiness.
	 *
	 * `handleMessage` opens with `typeof message !== 'object' || message === null`, and its
	 * error says "A message must be a JSON object." An array passes that test: `typeof []`
	 * is `'object'`. Execution then falls through to the notification arm, because an array
	 * has no `id`, and the frame is dropped with no reply and no error at all.
	 *
	 * A JSON array on this wire is a JSON-RPC batch. Batching was removed from MCP in
	 * 2025-06-18 and is permitted in 2025-03-26 and 2024-11-05, both of which this server
	 * echoes back from `initialize` and therefore offers. So a client that negotiates one of
	 * those two and batches its requests gets silence: every request in the batch hangs
	 * until the client's own timeout, with nothing on the wire saying why. Measured against
	 * the reference implementation on disk, `@modelcontextprotocol/sdk@1.30.0` never sends a
	 * batch over stdio, so this is not reachable from the client the rest of this file
	 * drives; it is reachable from a conforming client of an offered version.
	 *
	 * The guard now carries that `Array.isArray`, and the refusal names batching rather than
	 * a malformed frame, because a client that batched deliberately needs to know which of
	 * the two it met. Nothing in this package wants to implement batching; it wants to say
	 * so out loud rather than fall silent.
	 */
	test('a JSON array is refused as an invalid request', async () => {
		const replies = await run(['[1,2,3]\n']);
		expect(replies[0]?.error?.code).toBe(RPC.invalidRequest);
		// The message says which of the two refusals this is, because a client that batched
		// deliberately needs to know batching is unimplemented rather than that its frame
		// was malformed.
		expect(replies[0]?.error?.message).toContain('batching');
	});

	test('an object with no id is still dropped, which is what a notification is', async () => {
		// The other half, kept so the array guard cannot be widened into dropping every
		// frame that has no id. A notification takes no reply and an array is not one, and
		// the two used to be the same code path.
		await expect(
			run([`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`]),
		).resolves.toEqual([]);
	});

	test('a request with no method is an invalid request', async () => {
		const replies = await run([`${frame({ jsonrpc: '2.0', id: 4 })}\n`]);
		expect(replies[0]?.error?.code).toBe(RPC.invalidRequest);
	});

	test('a handler that threw is a result with isError, not a protocol error', async () => {
		const replies = await run(
			[`${frame({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo' } })}\n`],
			async () => {
				throw new Error('the tree could not be read');
			},
		);
		expect(replies[0]?.error).toBeUndefined();
		expect(replies[0]?.result?.['isError']).toBe(true);
		expect((replies[0]?.result?.['content'] as { text: string }[])[0]?.text).toBe(
			'the tree could not be read',
		);
	});

	test('replies are chained, so two slow calls cannot interleave a line', async () => {
		// The first call resolves after the second, which is the shape that produces a
		// half-written line when writes are raced instead of queued. Both replies still land
		// in request order and both parse.
		let first = true;
		const replies = await run(
			[
				`${frame({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } })}\n`,
				`${frame({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo' } })}\n`,
			],
			async () => {
				const slow = first;
				first = false;
				await new Promise((done) => setTimeout(done, slow ? 30 : 0));
				return slow ? 'first' : 'second';
			},
		);
		expect(replies.map((reply) => reply.id)).toEqual([1, 2]);
		expect((replies[0]?.result?.['content'] as { text: string }[])[0]?.text).toBe('first');
	});

	test('the promise resolves when the input ends', async () => {
		// What `hexdocs mcp` waits on. A `serve` that never resolved would leave the process
		// alive after the client disconnected, which on a long-lived agent session is one
		// orphaned node per restart.
		await expect(run([])).resolves.toEqual([]);
	});
});
