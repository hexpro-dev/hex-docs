/**
 * `serve()`, the fifteen lines between the message handler and the process.
 *
 * `kit/test/mcp/protocol.test.ts` proves the protocol two ways: the reference SDK's
 * `Client` against a spawned `kit/bin/hexdocs mcp`, and a raw child process for the frames
 * that client will not send. Both of those run the transport in another process, where the
 * coverage instrument cannot see it, and the parts of `handleMessage` that only a real
 * session reaches went with them. Measured before this file existed: `mcp/protocol.ts` sat
 * at 51 of 61 statements and 30 of 47 branches, and the ten missing statements were the
 * whole `initialize` arm, `tools/list`, both `tools/call` refusals, the unknown-method
 * arm, the parse-error arm and the internal-fault arm. Nine of those are answers the
 * spawned server gives on every session; the last two are answers nothing had ever asked
 * for.
 *
 * So this file owns the transport, in process, over a pair of streams. It does not repeat
 * what protocol.test.ts asserts about what any one reply says: the claim here is that the
 * transport is a pipe, and the table in the first block proves it by comparing `serve`'s
 * bytes against `handleMessage`'s own answers for the same frames rather than against a
 * hand-written literal. A dispatch changed in either half fails here naming the frame.
 *
 * Deliberately not covered, each because a test of it would assert nothing:
 *
 *   * Back pressure. `serve` ignores what `output.write` returns. The only sink in
 *     production is `process.stdout` on a pipe, node buffers what the pipe will not take,
 *     and a test that filled that buffer would be measuring node.
 *   * An `error` event on the input stream. `serve` registers no handler, so the event is
 *     unhandled and throws. That is a decision about the process, not an arm of this
 *     module, and nothing here can distinguish it from the same code without the decision.
 *   * The `typeof chunk === 'string'` arm is exercised below for the compatibility claim,
 *     and it is honestly not mutation-provable: a JavaScript string's `toString` ignores
 *     its argument and returns the string, so both naive collapses of that ternary still
 *     frame an ASCII stream correctly. What the test proves instead is where the
 *     multi-byte defect below actually lives.
 *   * `.replace(/\r$/, '')` is exercised and is likewise not mutation-provable, because a
 *     carriage return is JSON whitespace and the line goes nowhere but `JSON.parse`.
 *     Measured by deleting it: nineteen rows here stay green, and so does protocol.test.ts.
 *     It is kept in the differential table because it is what the reference reader does,
 *     and the day something other than `JSON.parse` reads a line it starts mattering.
 */

import { PassThrough, Writable } from 'node:stream';

import { ReadBuffer } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { describe, expect, test } from 'vitest';

import {
	handleMessage,
	RPC,
	serve,
	type ServerInfo,
	type ToolDescriptor,
	type ToolHandler,
} from '../../src/mcp/protocol.js';

const INFO: ServerInfo = { name: 'transport-test', version: '0' };

const ECHO: ToolDescriptor = {
	name: 'echo',
	title: 'Echo',
	description: 'Echoes its arguments back as JSON.',
	inputSchema: { type: 'object', properties: {} },
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
};

/**
 * Deterministic, because the same frames are driven through `serve` and through
 * `handleMessage` and the two byte strings are compared.
 */
const echo: ToolHandler = (name, args) => Promise.resolve(JSON.stringify({ name, args }));

interface Reply {
	jsonrpc?: unknown;
	id?: unknown;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

interface Session {
	/** Every call to `output.write`, in order, as the transport made it. */
	readonly writes: string[];
	/** How many writes had happened at the instant `serve`'s promise resolved. */
	readonly writesAtResolve: number;
	readonly replies: Reply[];
}

interface DriveOptions {
	readonly call?: ToolHandler;
	readonly tools?: readonly ToolDescriptor[];
	/** Set to make the readable side deliver strings rather than Buffers. */
	readonly encoding?: BufferEncoding;
	readonly onWrite?: (text: string) => void;
}

/**
 * Drives `serve` over a pair of in-memory streams and returns what it wrote.
 *
 * The sink is a `Writable` whose `_write` records synchronously and calls back
 * immediately, which is what makes `writesAtResolve` a measurement rather than a race: the
 * transport's writes are chained microtasks, each one completes inside the `write` call
 * that made it, and so the count taken on the line after `await finished` is exactly what
 * had been written when the promise settled. A `PassThrough` sink would defer its `data`
 * events and turn that number into whatever the event loop felt like.
 */
async function drive(
	chunks: readonly (string | Buffer)[],
	options: DriveOptions = {},
): Promise<Session> {
	const input = new PassThrough();
	if (options.encoding !== undefined) input.setEncoding(options.encoding);
	const writes: string[] = [];
	const output = new Writable({
		write(chunk: Buffer | string, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			writes.push(text);
			options.onWrite?.(text);
			done();
		},
	});
	const finished = serve({ input, output }, INFO, options.tools ?? [ECHO], options.call ?? echo);
	for (const chunk of chunks) input.write(chunk);
	input.end();
	await finished;
	const writesAtResolve = writes.length;
	// One more turn of the loop, so the assertion on the count above reads "resolve waited"
	// rather than "resolve happened to come last".
	await new Promise((done) => {
		setImmediate(done);
	});
	// Split over the joined text rather than per write, so a transport that wrote a reply
	// in two calls still yields the right reply list and only the one-line-per-write
	// assertion catches it.
	const replies = writes
		.join('')
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line) as Reply);
	return { writes, writesAtResolve, replies };
}

const frame = (message: unknown): string => `${JSON.stringify(message)}\n`;
const ping = (id: number): string => frame({ jsonrpc: '2.0', id, method: 'ping' });

/* -------------------------------------------------------------------------- */
/* the transport is a pipe                                                     */
/* -------------------------------------------------------------------------- */

describe('serve reproduces handleMessage, frame for frame', () => {
	/**
	 * One realistic session, covering every arm of the handler a client reaches.
	 *
	 * The assertion is equality with `handleMessage` rather than a literal per reply,
	 * because what this file owns is the transport. What each of these answers says is
	 * protocol.test.ts's subject, and duplicating it here would give two places to edit
	 * when a message changes and one of them would be missed.
	 */
	const FRAMES: readonly { readonly what: string; readonly message: unknown }[] = [
		{
			what: 'initialize asking for a version this server offers',
			message: {
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2024-11-05', capabilities: {} },
			},
		},
		{
			what: 'initialize asking for one it does not',
			message: {
				jsonrpc: '2.0',
				id: 2,
				method: 'initialize',
				params: { protocolVersion: 'not-a-version', capabilities: {} },
			},
		},
		{
			what: 'initialize with no params at all',
			message: { jsonrpc: '2.0', id: 3, method: 'initialize' },
		},
		{
			what: 'the notification that follows it, which takes no reply',
			message: { jsonrpc: '2.0', method: 'notifications/initialized' },
		},
		{ what: 'tools/list', message: { jsonrpc: '2.0', id: 4, method: 'tools/list' } },
		{ what: 'ping', message: { jsonrpc: '2.0', id: 5, method: 'ping' } },
		{
			what: 'tools/call carrying an arguments object',
			message: {
				jsonrpc: '2.0',
				id: 6,
				method: 'tools/call',
				params: { name: 'echo', arguments: { slug: 'guide/index' } },
			},
		},
		{
			what: 'tools/call with no arguments key',
			message: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo' } },
		},
		{
			what: 'tools/call with no params key',
			message: { jsonrpc: '2.0', id: 8, method: 'tools/call' },
		},
		{
			what: 'tools/call naming a tool this server does not have',
			message: {
				jsonrpc: '2.0',
				id: 9,
				method: 'tools/call',
				params: { name: 'docs_nothing' },
			},
		},
		{
			what: 'tools/call whose name is not a string',
			message: { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 7 } },
		},
		{
			what: 'a method nothing dispatches',
			message: { jsonrpc: '2.0', id: 11, method: 'no/such/method' },
		},
		{ what: 'a request with no method', message: { jsonrpc: '2.0', id: 12 } },
	];

	/** The whole table as one chunk, which is what a client that never waits writes. */
	const SESSION = FRAMES.map(({ message }) => frame(message)).join('');

	test('every byte written is the answer handleMessage gives that frame', async () => {
		const expected: string[] = [];
		/** The label of the frame each expected line came from, for the report below. */
		const from: string[] = [];
		for (const { what, message } of FRAMES) {
			const handled = await handleMessage(message, INFO, [ECHO], echo);
			if (handled.reply === null) continue;
			expected.push(`${handled.reply}\n`);
			from.push(what);
		}
		const session = await drive([SESSION]);
		// Named before compared, because a bare array diff of thirteen JSON lines does not
		// say which frame the transport got wrong.
		const first = expected.findIndex((line, index) => session.writes[index] !== line);
		expect(
			first === -1 ? 'none' : from[first],
			'the transport did not reproduce this frame answer',
		).toBe('none');
		expect(session.writes).toEqual(expected);
	});

	test('the table is not satisfied by agreeing on nothing', async () => {
		// The equality above would pass over a transport that wrote nothing and a handler
		// that answered nothing, so the shape of the session is pinned separately. The ids
		// are every request in the table, in order, with the notification absent.
		const session = await drive([SESSION]);
		expect(session.replies.map((reply) => reply.id)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
		]);
		expect(session.replies).toHaveLength(FRAMES.length - 1);
		// Both kinds of answer are present, so neither half of `handleMessage` is untested by
		// an equality that only ever compared errors or only ever compared results. The five
		// errors are the four refusals plus `tools/call` with no params key, whose missing
		// name is invalid-params rather than a call with no arguments.
		expect(session.replies.filter((reply) => reply.result !== undefined).length).toBe(7);
		expect(
			session.replies.filter((reply) => reply.error !== undefined).map((reply) => reply.id),
		).toEqual([8, 9, 10, 11, 12]);
	});

	test('one write per reply, and every write is one whole line', async () => {
		// What stops a reply being split across two writes, where a second writer on the same
		// stream could land between them. `serve` builds the whole line and writes it once.
		const session = await drive([SESSION]);
		expect(session.writes).toHaveLength(FRAMES.length - 1);
		for (const write of session.writes) {
			expect(write.endsWith('\n'), `not one line: ${write.slice(0, 60)}`).toBe(true);
			expect(write.split('\n').filter((part) => part !== '')).toHaveLength(1);
		}
	});
});

/* -------------------------------------------------------------------------- */
/* framing                                                                     */
/* -------------------------------------------------------------------------- */

describe('framing', () => {
	/** Reads a byte stream the way `shared/stdio.js` does, for the differential below. */
	function sdkFrames(chunks: readonly string[]): unknown[] {
		const buffer = new ReadBuffer();
		const messages: unknown[] = [];
		for (const chunk of chunks) {
			buffer.append(Buffer.from(chunk, 'utf8'));
			for (;;) {
				const message = buffer.readMessage();
				if (message === null) break;
				messages.push(message);
			}
		}
		return messages;
	}

	test('serve and the SDK reader put the frame boundaries in the same places', async () => {
		// The module comment claims framing is what `shared/stdio.js` does: split on `\n`,
		// strip a trailing `\r`. Read on disk rather than recalled, `ReadBuffer.readMessage`
		// is `this._buffer.indexOf('\n')` then `.replace(/\r$/, '')`, so the claim is true,
		// and this asserts it by running both readers over the same bytes rather than by
		// repeating the sentence.
		//
		// One honest qualification, measured by deleting the `.replace(/\r$/, '')` and
		// re-running: this table stays green without it. A carriage return is JSON
		// whitespace, so `JSON.parse('{"id":1}\r')` succeeds, and the only consumer of the
		// line here is `JSON.parse`. The strip is unobservable through this transport, and
		// what the table actually pins is where the frame boundaries fall. That is
		// mutation-provable: splitting on the last newline in the buffer rather than the
		// first fails the first case naming it.
		const a = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
		const b = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
		const cases: readonly { readonly what: string; readonly chunks: readonly string[] }[] = [
			{ what: 'two frames in one chunk', chunks: [`${a}\n${b}\n`] },
			{ what: 'two frames with CRLF terminators', chunks: [`${a}\r\n${b}\r\n`] },
			{ what: 'one frame split mid-token', chunks: [a.slice(0, 11), `${a.slice(11)}\n`] },
			{ what: 'a frame split from its terminator', chunks: [a, '\n'] },
			{ what: 'a CRLF split across the chunk boundary', chunks: [`${a}\r`, '\n'] },
			{ what: 'a frame followed by an unterminated one', chunks: [`${a}\n${b}`] },
		];
		let sawTwo = false;
		for (const { what, chunks } of cases) {
			const session = await drive(chunks);
			const sdk = sdkFrames(chunks).map((message) => (message as { id?: unknown }).id);
			expect(
				session.replies.map((reply) => reply.id),
				`${what}: this server framed it differently from the reference reader`,
			).toEqual(sdk);
			if (sdk.length === 2) sawTwo = true;
		}
		// Not vacuous: a reader that found no frame in any of these would agree with a
		// reference reader that found none either.
		expect(sawTwo, 'no case in this table produced two frames').toBe(true);
	});

	test('a blank line is ignored rather than answered', async () => {
		// A client that writes a heartbeat newline, or a shell that appends one, must not
		// produce a parse error the client reports as a broken server. Without the
		// `line.trim()` guard each of the three blank lines below is `JSON.parse('')` or
		// `JSON.parse('   ')`, and each answers with a parse error nobody asked for.
		const session = await drive(['\n', '   \n', '\t\n', ping(1)]);
		expect(session.replies).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
	});

	test('the SDK reader would have thrown on that blank line, and the divergence is deliberate', () => {
		// Pinned rather than described, because the two readers agree everywhere else and
		// this is the one place they do not. `deserializeMessage('')` is `JSON.parse('')`,
		// which throws, and `StdioClientTransport` turns that into a transport error that
		// ends the session. Being lenient in this direction costs nothing: a blank line
		// carries no request, so there is nothing to answer and nobody waiting.
		const buffer = new ReadBuffer();
		buffer.append(Buffer.from('\n', 'utf8'));
		expect(() => buffer.readMessage()).toThrow();
	});

	test('a frame with no terminator before end is not processed', async () => {
		// Right, and it is the reference reader's answer too: the wire format is newline
		// delimited, so a frame with no newline is an incomplete frame rather than a short
		// one. Answering it would mean guessing that a client which was cut off mid-write
		// had finished, and the reply would go to a client that is not there. The stream
		// still ends cleanly, which is what stops `hexdocs mcp` hanging on a truncated write.
		const session = await drive([ping(1), '{"jsonrpc":"2.0","id":2,"method":"ping"']);
		expect(session.replies.map((reply) => reply.id)).toEqual([1]);
		expect(sdkFrames([ping(1), '{"jsonrpc":"2.0","id":2,"method":"ping"'])).toHaveLength(1);
	});
});

/* -------------------------------------------------------------------------- */
/* multi-byte frames                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A defect in `kit/src/mcp/protocol.ts`, marked rather than fixed, with the current
 * behaviour pinned beside it.
 *
 * `serve` decodes each chunk on its own: `chunk.toString('utf8')`, then appends to a
 * string buffer. The reference reader the module comment cites does the opposite. It
 * concatenates Buffers and decodes only the bytes up to a newline, so an incomplete UTF-8
 * sequence at the end of a chunk is still incomplete rather than decoded.
 *
 * Decoding per chunk means a multi-byte character split across a chunk boundary becomes
 * U+FFFD replacement characters. It is silent: replacement characters are valid inside a
 * JSON string, so the frame still parses and the tool is still called, with a corrupted
 * argument. A `docs_page` for a Japanese slug or a `docs_search` for an Arabic phrase
 * comes back "no such page" with nothing on the wire saying why.
 *
 * It is reachable in production. `commands/mcp.ts` passes `process.stdin` with no
 * encoding, so the transport gets raw Buffers chunked by the pipe read size, and any
 * boundary inside dense CJK text lands mid-character most of the time.
 *
 * Two one-line fixes exist and neither is this file's to make: `process.stdin.setEncoding('utf8')`
 * in `commands/mcp.ts`, which puts node's own `StringDecoder` in front of the transport,
 * or a `StringDecoder` inside `serve`. The third test below is what says those would work.
 */
describe('a frame split inside a multi-byte character', () => {
	/** Japanese for "search", the kind of argument `docs_search` is given. */
	const QUERY = '\u691c\u7d22';

	const MESSAGE = {
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name: 'echo', arguments: { q: QUERY } },
	};

	/** The frame's bytes, cut one byte into the first three-byte character. */
	function splitBytes(): readonly [Buffer, Buffer] {
		const bytes = Buffer.from(frame(MESSAGE), 'utf8');
		const cut = bytes.indexOf(Buffer.from(QUERY, 'utf8')) + 1;
		return [bytes.subarray(0, cut), bytes.subarray(cut)];
	}

	/** What the tool handler was actually called with, which is where the corruption shows. */
	function recordingCall(seen: Record<string, unknown>[]): ToolHandler {
		return (_name, args) => {
			seen.push(args);
			return Promise.resolve('ok');
		};
	}

	test('the handler is called with the characters the client sent', async () => {
		// This was a marked failure, and it is the regression test for what it found.
		//
		// `serve` decoded each chunk on its own, so a character split across a chunk
		// boundary became replacement characters. The failure was silent rather than loud:
		// U+FFFD is legal inside a JSON string, so the frame parsed, the tool dispatched,
		// and the handler was called with a different argument from the one that was sent.
		// No parse error, no refusal, nothing on stderr.
		//
		// stdin arrives as raw Buffers chunked by the pipe read size, so this is ordinary
		// rather than exotic, and it lands in four of the seven languages this package
		// ships: any `docs_page` slug or search query long enough to cross a read.
		const seen: Record<string, unknown>[] = [];
		const [first, second] = splitBytes();
		await drive([first, second], { call: recordingCall(seen) });
		expect(seen[0]?.['q']).toBe(QUERY);
	});

	test('and it answers the request normally, with no replacement character anywhere', async () => {
		// The other half, so a half-fix that stopped corrupting the argument and started
		// refusing the frame would fail here rather than pass. The right answer is the
		// ordinary one: one reply, no error, the query intact.
		const seen: Record<string, unknown>[] = [];
		const [first, second] = splitBytes();
		const session = await drive([first, second], { call: recordingCall(seen) });
		expect(session.replies.map((reply) => reply.id)).toEqual([1]);
		expect(session.replies[0]?.error).toBeUndefined();
		expect(JSON.stringify(seen)).not.toContain('\ufffd');
	});

	test('the same split is correct when the stream carries strings, which locates the defect', async () => {
		// `setEncoding` puts node's `StringDecoder` on the readable side, and that holds an
		// incomplete sequence back until the rest of it arrives. It is how the defect above
		// was located: identical bytes, right answer, so the fault was in `serve` and
		// nowhere else. `serve` now uses a decoder of its own, which is the fix that works
		// whether or not a caller sets an encoding. This case stays because it is also the
		// compatibility claim for the string arm of that ternary: a stream that yields
		// strings frames the same way and must keep doing so.
		const seen: Record<string, unknown>[] = [];
		const [first, second] = splitBytes();
		const session = await drive([first, second], {
			call: recordingCall(seen),
			encoding: 'utf8',
		});
		expect(session.replies.map((reply) => reply.id)).toEqual([1]);
		expect(seen[0]?.['q']).toBe(QUERY);
	});

	test('the reference reader handles the same split', () => {
		// So this is a difference from `shared/stdio.js`, not a property of the wire format.
		const buffer = new ReadBuffer();
		const [first, second] = splitBytes();
		buffer.append(first);
		expect(buffer.readMessage()).toBeNull();
		buffer.append(second);
		expect(buffer.readMessage()).toEqual(MESSAGE);
	});
});

/* -------------------------------------------------------------------------- */
/* one frame at a time                                                         */
/* -------------------------------------------------------------------------- */

describe('the reply queue', () => {
	test('a handler does not start until the previous reply has been written', async () => {
		// The property the promise chain actually buys, which is stronger than ordering and
		// is what a "simplification" to `void (async () => { ... })()` would take away. The
		// handlers sleep for 30ms, 0ms and 10ms, so under concurrent dispatch they would
		// finish 2, 3, 1 and the log below would interleave. Chained, each one starts after
		// the previous reply is on the wire, and the log has no overlap anywhere.
		const log: string[] = [];
		const call: ToolHandler = async (_name, args) => {
			const id = String(args['id']);
			log.push(`start:${id}`);
			await new Promise((done) => {
				setTimeout(done, [30, 0, 10][Number(id) - 1]);
			});
			log.push(`end:${id}`);
			return id;
		};
		const session = await drive(
			[1, 2, 3].map((id) =>
				frame({
					jsonrpc: '2.0',
					id,
					method: 'tools/call',
					params: { name: 'echo', arguments: { id } },
				}),
			),
			{
				call,
				onWrite: (text) => {
					log.push(`write:${String((JSON.parse(text) as Reply).id)}`);
				},
			},
		);
		expect(log).toEqual([
			'start:1',
			'end:1',
			'write:1',
			'start:2',
			'end:2',
			'write:2',
			'start:3',
			'end:3',
			'write:3',
		]);
		expect(session.replies.map((reply) => reply.id)).toEqual([1, 2, 3]);
	});

	test('a frame that takes no reply keeps its place without producing one', async () => {
		// A notification between two calls. The queue still runs it, in order, and writes
		// nothing for it, so the reply the client is waiting for does not arrive early and
		// the client is not handed a response it has no request for.
		const order: string[] = [];
		const call: ToolHandler = (_name, args) => {
			order.push(String(args['id']));
			return Promise.resolve('ok');
		};
		const session = await drive(
			[
				frame({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'echo', arguments: { id: 1 } },
				}),
				frame({ jsonrpc: '2.0', method: 'notifications/cancelled' }),
				frame({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'echo', arguments: { id: 2 } },
				}),
			],
			{ call },
		);
		expect(order).toEqual(['1', '2']);
		expect(session.writes).toHaveLength(2);
		expect(session.replies.map((reply) => reply.id)).toEqual([1, 2]);
	});
});

/* -------------------------------------------------------------------------- */
/* the failure arms                                                            */
/* -------------------------------------------------------------------------- */

describe('a frame the transport cannot get an answer for', () => {
	test('a line that is not JSON is a parse error and the session continues', async () => {
		// The reason the catch is there rather than nothing: a client that sent one bad
		// frame is still connected, and killing the server takes the whole session for one
		// bug in one message. Both halves are asserted, because answering the bad line and
		// then dying would satisfy only the first.
		const session = await drive(['{ this is not json\n', ping(2), 'also not json\n', ping(3)]);
		expect(session.replies.map((reply) => reply.id)).toEqual([0, 2, 0, 3]);
		expect(session.replies[0]?.error?.code).toBe(RPC.parseError);
		expect(session.replies[2]?.error?.code).toBe(RPC.parseError);
		expect(session.replies[1]?.result).toEqual({});
		expect(session.replies[3]?.result).toEqual({});
	});

	test('a handler that threw something that is not an Error is still reported', async () => {
		// `String(error)` rather than `error.message`, which would be `undefined` and would
		// reach the model as a tool that failed with no reason. A thrown string is what a
		// hand-written `throw 'no project here'` produces, and the model reads this text.
		const session = await drive(
			[frame({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } })],
			{
				call: () => {
					throw 'no docs/site directory here';
				},
			},
		);
		expect(session.replies[0]?.error).toBeUndefined();
		expect(session.replies[0]?.result?.['isError']).toBe(true);
		expect((session.replies[0]?.result?.['content'] as { text: string }[])[0]?.text).toBe(
			'no docs/site directory here',
		);
	});

	/**
	 * `handleMessage` itself throwing, which is the arm nothing had ever reached.
	 *
	 * It matters more than its size suggests. Without the catch, the thrown value rejects
	 * `queue`, every later `queue.then` is skipped, and `queue.then(resolve)` on `end`
	 * never runs: the server stops answering and the process never exits. So the assertion
	 * in both cases below is not only that an internal error is reported, but that the next
	 * frame is still answered and the promise still resolves.
	 */
	describe('an internal fault inside the handler', () => {
		test('a descriptor that cannot be serialised is an internal error, not a dead session', async () => {
			// A circular `inputSchema` is the realistic shape: `jsonSchemaOf` builds these from
			// the parameter table, and `JSON.stringify` is where a cycle shows up. The reply is
			// still exactly one line even though the message node writes has newlines in it,
			// which is the property that keeps a fault inside the handler from breaking the
			// framing on the way out.
			const circular: Record<string, unknown> = { type: 'object' };
			circular['self'] = circular;
			const session = await drive(
				[frame({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ping(2)],
				{
					tools: [{ ...ECHO, inputSchema: circular }],
				},
			);
			expect(session.replies[0]?.id).toBe(0);
			expect(session.replies[0]?.error?.code).toBe(RPC.internalError);
			expect(session.replies[0]?.error?.message).toContain('circular');
			expect(session.replies[1]?.id).toBe(2);
			expect(session.writes).toHaveLength(2);
			for (const write of session.writes) {
				expect(write.split('\n').filter((part) => part !== '')).toHaveLength(1);
			}
		});

		test('a fault that is not an Error is reported too', async () => {
			// Deliberately synthetic, and worth saying so: nothing in `mcp/server.ts` can
			// throw a bare string today. The arm exists because `String(error)` is the only
			// thing between a non-Error fault and a JSON-RPC error whose message is missing,
			// and the descriptor list is the one input `handleMessage` reads without checking.
			const hostile = { ...ECHO } as { name: string };
			Object.defineProperty(hostile, 'name', {
				get(): string {
					throw 'a descriptor whose name getter threw';
				},
			});
			const session = await drive(
				[frame({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } }), ping(2)],
				{ tools: [hostile as unknown as ToolDescriptor] },
			);
			expect(session.replies[0]?.error?.code).toBe(RPC.internalError);
			expect(session.replies[0]?.error?.message).toBe('a descriptor whose name getter threw');
			expect(session.replies[1]?.result).toEqual({});
		});
	});
});

/* -------------------------------------------------------------------------- */
/* lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

describe('when serve resolves', () => {
	test('it resolves only after the last queued reply has been written', async () => {
		// `hexdocs mcp` awaits this promise and then the process exits. Resolving on `end`
		// rather than on the drained queue loses the reply to the last request of every
		// session, which is the reply to whatever the agent asked immediately before
		// disconnecting. The handler sleeps, so `end` fires long before the write.
		const session = await drive(
			[frame({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } })],
			{
				call: async () => {
					await new Promise((done) => {
						setTimeout(done, 25);
					});
					return 'late';
				},
			},
		);
		expect(session.writesAtResolve).toBe(1);
		expect(session.writes).toHaveLength(1);
		expect((session.replies[0]?.result?.['content'] as { text: string }[])[0]?.text).toBe('late');
	});

	test('it resolves on a stream that carried nothing', async () => {
		// A client that connected and went away. Not resolving here leaves one node process
		// per restart on a long-lived agent session.
		const session = await drive([]);
		expect(session.writes).toEqual([]);
		expect(session.writesAtResolve).toBe(0);
	});
});
