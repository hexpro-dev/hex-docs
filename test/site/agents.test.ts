/**
 * The agent interface: MCP over Streamable HTTP, the JSON search and the Server Card.
 *
 * Driven through `docsServer` with real `Request`s over the compiled fixture corpus, which is
 * what a consuming site's resource routes hand it, and with a clock the test owns so the token
 * bucket is measured rather than slept on. `kit/test/mcp/agents.test.ts` drives the same
 * handler with the SDK's own client over a real socket; this file is every rule one at a time.
 *
 * Each HTTP rule is here with the status the specification gives it, because a client decides
 * what to do next from the status alone: a 2026-07-28 client falls back to `initialize` on a
 * 400 whose body is not a modern error, and a 2025 client treats a 404 as a lost session.
 */

import { beforeAll, describe, expect, test } from 'vitest';

import type { DocsCatalogueApp, DocsHostFacts } from '../../src/contracts/host.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import {
	clientKey,
	createAgents,
	LEGACY_PROTOCOL_VERSIONS,
	MAX_REQUEST_BYTES,
	MODERN_PROTOCOL_VERSIONS,
	PAGE_WINDOW,
	SERVER_CARD_SCHEMA,
	tokenBuckets,
	type AgentLibrary,
} from '../../src/site/agents.js';
import { docsServer, type DocsServer, type DocsServerOptions } from '../../src/site/serve.js';
import {
	fixtureBundle,
	fixtureSite,
	fixtureSources,
	globKey,
	type FixtureBundle,
} from '../support/bundle.js';

const ORIGIN = 'https://docs.example';
const LICENCE = { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' };
const AGENTS = {
	name: 'example.docs/docs',
	title: 'Example docs',
	description: 'Search and read the example documentation.',
	website: 'https://docs.example',
	mcp: '/mcp',
	search: '/docs/search.json',
	serverCard: '/mcp/server-card',
};
const PUBLISHER = { name: 'Example', legalName: 'Example Pty Ltd', url: 'https://example.com' };

const APPS: DocsCatalogueApp[] = [
	{
		id: 'alarm',
		name: 'Alarm',
		description: 'An alarm clock for iPhone.',
		publisher: PUBLISHER,
		platforms: [{ name: 'iPhone', minimumOs: 'iOS 17' }],
		pricing: { model: 'Free with an optional subscription', prices: ['A$2.99 a month'] },
		status: 'near-release',
		productUrl: 'https://docs.example/alarm',
		privacyUrl: 'https://docs.example/alarm/privacy',
	},
	{
		id: 'fixture',
		project: 'fixture-app',
		name: 'Fixture App',
		description: 'Reads and rewrites NFC tags on an iPhone.',
		publisher: PUBLISHER,
		platforms: [{ name: 'iPhone', minimumOs: 'iOS 17' }],
		pricing: { model: 'Free' },
		status: 'released',
		productUrl: 'https://docs.example/fixture',
		appStoreUrl: 'https://apps.apple.com/app/id1',
	},
	{
		id: 'elsewhere',
		project: 'not-mounted-here',
		name: 'Elsewhere',
		description: 'Documented on its own site.',
		publisher: PUBLISHER,
		platforms: [],
		pricing: { model: 'Free' },
		status: 'in-development',
		productUrl: 'https://elsewhere.example',
		llmsUrl: 'https://elsewhere.example/llms.txt',
	},
];
const HOST: DocsHostFacts = { apps: () => APPS };

let bundle: FixtureBundle;
let site: DocsSiteConfig;
let now = 0;

function server(extra: Partial<DocsServerOptions> = {}): DocsServer {
	return docsServer({
		...fixtureSources(bundle, site),
		origin: ORIGIN,
		licence: LICENCE,
		agents: AGENTS,
		clock: () => now,
		...extra,
	});
}

beforeAll(() => {
	bundle = fixtureBundle();
	site = fixtureSite(bundle);
}, 60_000);

/** A POST to the MCP endpoint, with the headers a client sends unless a test says otherwise. */
function post(body: unknown, headers: Record<string, string | null> = {}): Request {
	const base: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
		'CF-Connecting-IP': '203.0.113.1',
	};
	for (const [key, value] of Object.entries(headers)) {
		if (value === null) delete base[key];
		else base[key] = value;
	}
	return new Request(`${ORIGIN}/mcp`, {
		method: 'POST',
		headers: base,
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

type Reply = { status: number; json: Record<string, any> | null; headers: Headers };

async function call(docs: DocsServer, request: Request, host?: DocsHostFacts): Promise<Reply> {
	const response = await docs.mcp(request, host);
	const text = await response.text();
	let json: Record<string, any> | null = null;
	try {
		json = text === '' ? null : (JSON.parse(text) as Record<string, any>);
	} catch {
		json = null;
	}
	return { status: response.status, json, headers: response.headers };
}

const MODERN = MODERN_PROTOCOL_VERSIONS[0];
const meta = {
	'io.modelcontextprotocol/protocolVersion': MODERN,
	'io.modelcontextprotocol/clientCapabilities': {},
};

/** A 2026-07-28 request: per-request `_meta` and the mirrored headers. */
function modern(
	method: string,
	params: Record<string, unknown> = {},
	headers: Record<string, string | null> = {},
): Request {
	const name = typeof params['name'] === 'string' ? { 'Mcp-Name': params['name'] as string } : {};
	return post(
		{ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } },
		{ 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method, ...name, ...headers },
	);
}

/** A tool call in the earlier revisions: no `_meta`, the version header after `initialize`. */
function legacyTool(name: string, args?: unknown): Request {
	return post(
		{
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: { name, ...(args === undefined ? {} : { arguments: args }) },
		},
		{ 'MCP-Protocol-Version': '2025-11-25' },
	);
}

async function tool(docs: DocsServer, name: string, args?: unknown, host: DocsHostFacts = HOST) {
	const reply = await call(docs, legacyTool(name, args), host);
	expect(reply.status).toBe(200);
	return reply.json?.['result'] as {
		content: { type: string; text: string }[];
		structuredContent?: Record<string, any>;
		isError: boolean;
	};
}

describe('the HTTP rules', () => {
	test('GET and DELETE are 405 with Allow: POST, because there is no session and no stream', async () => {
		for (const method of ['GET', 'DELETE']) {
			const response = await server().mcp(new Request(`${ORIGIN}/mcp`, { method }));
			expect([method, response.status, response.headers.get('Allow')]).toEqual([
				method,
				405,
				'POST',
			]);
		}
	});

	test('a present Origin that is not the site is refused with 403, and an absent one is served', async () => {
		const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
		const docs = server();
		expect((await call(docs, post(ping, { Origin: 'https://evil.example' }))).status).toBe(403);
		expect((await call(docs, post(ping, { Origin: 'null' }))).status).toBe(403);
		expect((await call(docs, post(ping, { Origin: ORIGIN }))).status).toBe(200);
		expect((await call(docs, post(ping))).status).toBe(200);
		// With no origin configured there is nothing to compare with, so every present one is refused.
		const bare = server({ origin: undefined });
		expect((await call(bare, post(ping, { Origin: ORIGIN }))).status).toBe(403);
		expect((await call(bare, post(ping))).status).toBe(200);
	});

	test('the body must be JSON by its media type, and the client must accept JSON', async () => {
		const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
		const docs = server();
		expect((await call(docs, post(ping, { 'Content-Type': 'text/plain' }))).status).toBe(415);
		expect((await call(docs, post(ping, { 'Content-Type': null }))).status).toBe(415);
		// Bytes carry no media type of their own, so this request has no Content-Type at all.
		const untyped = new Request(`${ORIGIN}/mcp`, {
			method: 'POST',
			body: new TextEncoder().encode(JSON.stringify(ping)),
		});
		expect(untyped.headers.get('Content-Type')).toBeNull();
		expect((await docs.mcp(untyped)).status).toBe(415);
		expect(
			(await call(docs, post(ping, { 'Content-Type': 'Application/JSON; charset=utf-8' }))).status,
		).toBe(200);
		expect((await call(docs, post(ping, { Accept: 'text/html' }))).status).toBe(406);
		expect((await call(docs, post(ping, { Accept: null }))).status).toBe(200);
		expect((await call(docs, post(ping, { Accept: '*/*' }))).status).toBe(200);
		expect((await call(docs, post(ping, { Accept: 'application/*;q=0.5' }))).status).toBe(200);
	});

	test('a body over 64 KB is a 413, whether it says so in Content-Length or not', async () => {
		const big = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'ping',
			params: { pad: 'x'.repeat(MAX_REQUEST_BYTES) },
		});
		const docs = server();
		const declared = await call(docs, post(big, { 'Content-Length': String(big.length) }));
		expect(declared.status).toBe(413);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const chunk = new TextEncoder().encode(big);
				controller.enqueue(chunk.slice(0, 40_000));
				controller.enqueue(chunk.slice(40_000));
				controller.close();
			},
		});
		const undeclared = new Request(`${ORIGIN}/mcp`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: stream,
			duplex: 'half',
		} as RequestInit);
		expect((await docs.mcp(undeclared)).status).toBe(413);
	});

	test('a body that is not UTF-8, not JSON or empty is a 400 parse error with a null id', async () => {
		const docs = server();
		const bytes = new Request(`${ORIGIN}/mcp`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: new Uint8Array([0x7b, 0xff, 0x7d]),
		});
		for (const request of [bytes, post('{"jsonrpc": "2.0",'), post('')]) {
			const reply = await call(docs, request);
			expect([reply.status, reply.json?.['error']?.code, reply.json?.['id']]).toEqual([
				400,
				-32700,
				null,
			]);
		}
		const empty = await docs.mcp(
			new Request(`${ORIGIN}/mcp`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		expect(empty.status).toBe(400);
	});

	test('a batch, a non-object, a request without a method and a bad id are 400 invalid requests', async () => {
		const docs = server();
		const cases: unknown[] = [
			[{ jsonrpc: '2.0', id: 1, method: 'ping' }],
			'"ping"',
			{ id: 1, method: 'ping' },
			{ jsonrpc: '2.0', id: 1 },
			{ jsonrpc: '2.0', id: null, method: 'ping' },
			{ jsonrpc: '2.0', id: 1.5, method: 'ping' },
			{ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' },
		];
		for (const message of cases) {
			const reply = await call(docs, post(message));
			expect({ message, status: reply.status, code: reply.json?.['error']?.code }).toEqual({
				message,
				status: 400,
				code: -32600,
			});
		}
		const batch = await call(docs, post(cases[0]));
		expect(batch.json?.['error']?.message).toMatch(/batch/);
		const array = await call(docs, post({ jsonrpc: '2.0', id: 1, method: 'ping', params: [1] }));
		expect([array.status, array.json?.['error']?.code, array.json?.['id']]).toEqual([
			400, -32602, 1,
		]);
	});

	test('a notification and a stray response are accepted with 202 and no body', async () => {
		const docs = server();
		for (const message of [
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 3, result: {} },
			{ jsonrpc: '2.0', id: 3, error: { code: 1, message: 'x' } },
		]) {
			const response = await docs.mcp(post(message));
			expect([response.status, await response.text()]).toEqual([202, '']);
		}
	});

	test('the token bucket refuses a client that spent its burst, with Retry-After, and refills', async () => {
		now = 1_000_000;
		const docs = server({ rateLimit: { mcp: { capacity: 2, refillPerSecond: 0.5 } } });
		const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
		expect((await call(docs, post(ping))).status).toBe(200);
		expect((await call(docs, post(ping))).status).toBe(200);
		const refused = await call(docs, post(ping));
		expect([refused.status, refused.headers.get('Retry-After')]).toEqual([429, '2']);
		// Another client has its own bucket.
		expect((await call(docs, post(ping, { 'CF-Connecting-IP': '203.0.113.2' }))).status).toBe(200);
		now += 2_000;
		expect((await call(docs, post(ping))).status).toBe(200);
		expect((await call(docs, post(ping))).status).toBe(429);
	});

	test('a client is keyed on CF-Connecting-IP, then the first X-Forwarded-For hop, then one shared key', () => {
		expect(
			clientKey(
				new Headers({ 'CF-Connecting-IP': ' 198.51.100.7 ', 'X-Forwarded-For': '10.0.0.1' }),
			),
		).toBe('198.51.100.7');
		expect(clientKey(new Headers({ 'X-Forwarded-For': ' 198.51.100.8 , 10.0.0.1' }))).toBe(
			'198.51.100.8',
		);
		expect(clientKey(new Headers({ 'CF-Connecting-IP': ' ', 'X-Forwarded-For': '' }))).toBe(
			'shared',
		);
		expect(clientKey(new Headers({ 'CF-Connecting-IP': 'x'.repeat(100) }))).toHaveLength(64);
	});

	test('the bucket table evicts the least recently used client when it is full', () => {
		const take = tokenBuckets({ capacity: 1, refillPerSecond: 0.001 }, () => 0, 2);
		expect(take('a')).toBe(0);
		expect(take('b')).toBe(0);
		// `a` is out of tokens and is now the most recently used.
		expect(take('a')).toBeGreaterThan(0);
		// `c` is new and the table is full, so `b`, the least recently used, is forgotten.
		expect(take('c')).toBe(0);
		// `a` was kept, and is still refused.
		expect(take('a')).toBeGreaterThan(0);
		// `b` starts again with a full bucket.
		expect(take('b')).toBe(0);
	});

	test('an origin that is not one is a 500 naming it, from every handler', async () => {
		const docs = server({ origin: 'https://docs.example/' });
		for (const response of [
			await docs.mcp(post({ jsonrpc: '2.0', id: 1, method: 'ping' })),
			await docs.search(new Request(`${ORIGIN}/docs/search.json?q=tag`)),
			await docs.serverCard(new Request(`${ORIGIN}/mcp/server-card`)),
		]) {
			expect(response.status).toBe(500);
			expect(await response.text()).toMatch(
				/The docs origin option "https:\/\/docs.example\/" is not an origin/,
			);
		}
	});
});

describe('the earlier revisions, which open with initialize', () => {
	test('initialize echoes a version it speaks and otherwise answers with its newest of that era', async () => {
		const docs = server();
		for (const [asked, answered] of [
			['2025-06-18', '2025-06-18'],
			['2025-03-26', '2025-03-26'],
			['2024-11-05', LEGACY_PROTOCOL_VERSIONS[0]],
			[MODERN, LEGACY_PROTOCOL_VERSIONS[0]],
			[undefined, LEGACY_PROTOCOL_VERSIONS[0]],
		] as const) {
			const reply = await call(
				docs,
				post({
					jsonrpc: '2.0',
					id: 'init',
					method: 'initialize',
					params:
						asked === undefined
							? undefined
							: {
									protocolVersion: asked,
									capabilities: {},
									clientInfo: { name: 't', version: '1' },
								},
				}),
			);
			expect([asked, reply.status, reply.json?.['result']?.protocolVersion]).toEqual([
				asked,
				200,
				answered,
			]);
		}
	});

	test('initialize names the server, offers tools only, says what it covers and the licence, and mints no session', async () => {
		const response = await server().mcp(
			post({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2025-11-25' },
			}),
		);
		expect(response.headers.get('Mcp-Session-Id')).toBeNull();
		expect(response.headers.get('Content-Type')).toBe('application/json');
		const result = ((await response.json()) as Record<string, any>)['result'];
		expect(result.capabilities).toEqual({ tools: {} });
		expect(result.serverInfo).toEqual({
			name: 'example.docs/docs',
			title: 'Example docs',
			version: '1.0.0',
			websiteUrl: 'https://docs.example',
		});
		expect(result.instructions).toContain('published on https://docs.example');
		expect(result.instructions).toContain(`licensed under CC BY 4.0 (${LICENCE.url})`);

		const bare = await call(
			server({ agents: undefined, licence: undefined }),
			post({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
		);
		expect(bare.json?.['result']?.serverInfo).toEqual({
			name: 'hexdocs',
			title: 'Documentation',
			version: '1.0.0',
		});
		expect(bare.json?.['result']?.instructions).not.toMatch(/licensed|published on/);
	});

	test('ping, tools/list and an unknown method, all with a 200', async () => {
		const docs = server();
		const ping = await call(docs, post({ jsonrpc: '2.0', id: 2, method: 'ping' }));
		expect(ping.json).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
		const list = await call(docs, post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
		const tools = list.json?.['result']?.tools as Record<string, any>[];
		expect(tools.map((one) => one['name'])).toEqual([
			'list_apps',
			'get_app',
			'search_docs',
			'get_page',
		]);
		for (const one of tools) {
			expect(one['inputSchema'].type).toBe('object');
			expect(one['outputSchema'].type).toBe('object');
			expect(one['annotations']).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false,
			});
		}
		const unknown = await call(docs, post({ jsonrpc: '2.0', id: 4, method: 'resources/list' }));
		expect([unknown.status, unknown.json?.['error']?.code]).toEqual([200, -32601]);
	});

	test('a version header this server does not speak is a 400', async () => {
		const reply = await call(
			server(),
			post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '2024-01-01' }),
		);
		expect([reply.status, reply.json?.['error']?.code]).toEqual([400, -32600]);
		expect(reply.json?.['error']?.message).toContain(MODERN);
	});

	test('a call with no tool name or an unknown tool is a protocol error; bad arguments are a tool error', async () => {
		const docs = server();
		const noName = await call(
			docs,
			post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }),
		);
		expect([noName.status, noName.json?.['error']?.code]).toEqual([200, -32602]);
		const unknown = await call(docs, legacyTool('delete_everything'));
		expect([unknown.json?.['error']?.code, unknown.json?.['error']?.message]).toEqual([
			-32602,
			'Unknown tool: delete_everything. This server has list_apps, get_app, search_docs, get_page.',
		]);
		const notObject = await tool(docs, 'list_apps', [1]);
		expect([notObject.isError, notObject.content[0]?.text, notObject.structuredContent]).toEqual([
			true,
			'The arguments must be an object.',
			undefined,
		]);
		const extra = await tool(docs, 'list_apps', { verbose: true });
		expect(extra.content[0]?.text).toBe(
			'Unknown argument "verbose". This tool takes no arguments.',
		);
		const extraGet = await tool(docs, 'get_app', { app: 'fixture', x: 1, y: 2 });
		expect(extraGet.content[0]?.text).toBe('Unknown argument "x", "y". This tool takes app.');
	});
});

describe('2026-07-28, which carries the version and capabilities on every request', () => {
	test('server/discover names every version, the capabilities, the instructions and how long to keep them', async () => {
		const reply = await call(server(), modern('server/discover'));
		expect(reply.status).toBe(200);
		expect(reply.json?.['result']).toEqual({
			resultType: 'complete',
			supportedVersions: [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS],
			capabilities: { tools: {} },
			instructions: expect.stringContaining('list_apps'),
			ttlMs: 3_600_000,
			cacheScope: 'public',
			_meta: {
				'io.modelcontextprotocol/serverInfo': {
					name: 'example.docs/docs',
					title: 'Example docs',
					version: '1.0.0',
					websiteUrl: 'https://docs.example',
				},
			},
		});
	});

	test('ping, tools/list and tools/call carry resultType and the server, and an unknown method is a 404', async () => {
		const docs = server();
		const ping = await call(docs, modern('ping'));
		expect(ping.json?.['result']?.resultType).toBe('complete');
		const list = await call(docs, modern('tools/list'));
		expect([list.json?.['result']?.tools.length, list.json?.['result']?.ttlMs]).toEqual([
			4, 3_600_000,
		]);
		const called = await call(
			docs,
			modern('tools/call', { name: 'list_apps', arguments: {} }),
			HOST,
		);
		expect(called.json?.['result']).toMatchObject({ resultType: 'complete', isError: false });
		expect(called.json?.['result']?._meta).toBeDefined();
		const unknownTool = await call(docs, modern('tools/call', { name: 'nope' }));
		expect([unknownTool.status, unknownTool.json?.['error']?.code]).toEqual([200, -32602]);
		const missing = await call(docs, modern('prompts/list'));
		expect([missing.status, missing.json?.['error']?.code]).toEqual([404, -32601]);
	});

	test('a version this server does not speak is a 400 naming the ones it does', async () => {
		const request = post(
			{
				jsonrpc: '2.0',
				id: 9,
				method: 'tools/list',
				params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } },
			},
			{ 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' },
		);
		const reply = await call(server(), request);
		expect(reply.status).toBe(400);
		expect(reply.json?.['error']).toEqual({
			code: -32022,
			message: 'Unsupported protocol version',
			data: {
				supported: [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS],
				requested: '2099-01-01',
			},
		});
	});

	test('a request missing its version or its capabilities is a 400 invalid params', async () => {
		const docs = server();
		const noVersion = post(
			{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
			{ 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/list' },
		);
		const reply = await call(docs, noVersion);
		expect([reply.status, reply.json?.['error']?.code]).toEqual([400, -32602]);
		const numeric = post(
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: { _meta: { 'io.modelcontextprotocol/protocolVersion': 20260728 } },
			},
			{ 'Mcp-Method': 'tools/list' },
		);
		expect((await call(docs, numeric)).json?.['error']?.code).toBe(-32602);
		const noCapabilities = post(
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } },
			},
			{ 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/list' },
		);
		const missing = await call(docs, noCapabilities);
		expect([missing.status, missing.json?.['error']?.code]).toEqual([400, -32602]);
	});

	test('a header that disagrees with the body, or is missing, is a 400 HeaderMismatch', async () => {
		const docs = server();
		const cases: [string, Request][] = [
			['no version header', modern('tools/list', {}, { 'MCP-Protocol-Version': null })],
			['another method', modern('tools/list', {}, { 'Mcp-Method': 'tools/call' })],
			['no method header', modern('tools/list', {}, { 'Mcp-Method': null })],
			['another tool', modern('tools/call', { name: 'list_apps' }, { 'Mcp-Name': 'get_app' })],
			['no name header', modern('tools/call', { name: 'list_apps' }, { 'Mcp-Name': null })],
			[
				'broken base64',
				modern('tools/call', { name: 'list_apps' }, { 'Mcp-Name': '=?base64?***?=' }),
			],
		];
		for (const [name, request] of cases) {
			const reply = await call(docs, request);
			expect({ name, status: reply.status, code: reply.json?.['error']?.code }).toEqual({
				name,
				status: 400,
				code: -32020,
			});
		}
		const encoded = modern(
			'tools/call',
			{ name: 'list_apps' },
			{ 'Mcp-Name': `=?base64?${btoa('list_apps')}?=` },
		);
		expect((await call(docs, encoded, HOST)).json?.['result']?.isError).toBe(false);
	});
});

describe('list_apps', () => {
	test('lists every app the host sells, with docs or without, and every project the host forgot', async () => {
		const result = await tool(server(), 'list_apps');
		const apps = result.structuredContent?.['apps'] as Record<string, any>[];
		expect(apps.map((app) => [app['id'], app['hasDocs']])).toEqual([
			['alarm', false],
			['fixture', true],
			['elsewhere', false],
		]);
		expect(apps[0]).toEqual({ id: 'alarm', ...APPS[0], hasDocs: false });
		expect(apps[1]?.['docs']).toEqual({
			home: 'https://docs.example/fixture-app/docs',
			llms: 'https://docs.example/fixture-app/docs/llms.txt',
			llmsFull: 'https://docs.example/fixture-app/docs/llms-full.txt',
			version: '1.1.0',
			updatedAt: '2026-04-02T10:45:00Z',
			pages: 8,
			languages: [...bundle.manifest.locales],
		});
		expect(apps[1]?.['llmsUrl']).toBe('https://docs.example/fixture-app/docs/llms.txt');
		expect(apps[2]?.['llmsUrl']).toBe('https://elsewhere.example/llms.txt');
		expect(result.content[0]?.text).toContain('## Alarm (app: alarm)');
		expect(result.content[0]?.text).toContain('- Documentation: none on this site yet');
		expect(result.content[0]?.text).toContain(
			'- Documentation: https://docs.example/fixture-app/docs, version 1.1.0, 8 pages, updated 2026-04-02.',
		);

		// A catalogue that does not mention the documented project still gets it.
		const partial = await tool(server(), 'list_apps', undefined, {
			apps: () => [APPS[0] as DocsCatalogueApp],
		});
		const ids = (partial.structuredContent?.['apps'] as Record<string, any>[]).map(
			(app) => app['id'],
		);
		expect(ids).toEqual(['alarm', 'fixture-app']);
	});

	test('with no host facts, lists the documented projects under the name the bundle gives', async () => {
		const result = await tool(server({ origin: undefined }), 'list_apps', {}, {});
		expect(result.structuredContent?.['apps']).toEqual([
			expect.objectContaining({
				id: 'fixture-app',
				name: 'Fixture App',
				hasDocs: true,
				llmsUrl: '/fixture-app/docs/llms.txt',
			}),
		]);
	});

	test('describe wins over the catalogue for a documented app', async () => {
		const describe = () => ({ ...(APPS[1] as DocsCatalogueApp), description: 'Described.' });
		const result = await tool(server(), 'list_apps', {}, { apps: () => APPS, describe });
		expect((result.structuredContent?.['apps'] as Record<string, any>[])[1]?.['description']).toBe(
			'Described.',
		);
		const alone = await tool(server(), 'list_apps', {}, { describe });
		expect((alone.structuredContent?.['apps'] as Record<string, any>[])[0]).toMatchObject({
			id: 'fixture-app',
			description: 'Described.',
		});
	});

	test('a documented project whose bundle cannot be served is a tool error naming hexdocs prefetch', async () => {
		const sources = fixtureSources(bundle, site);
		const broken = server({ manifests: {}, pages: sources.pages });
		const result = await tool(broken, 'list_apps');
		expect([result.isError, result.content[0]?.text]).toEqual([
			true,
			expect.stringContaining('hexdocs prefetch'),
		]);
	});
});

describe('get_app', () => {
	test("gives a documented app's facts and its outline, by id or by project, in any case", async () => {
		const docs = server();
		for (const name of ['fixture', 'FIXTURE-APP', ' fixture-app ']) {
			const result = await tool(docs, 'get_app', { app: name });
			expect(result.isError).toBe(false);
			const outline = result.structuredContent?.['outline'] as {
				title: string;
				pages: Record<string, any>[];
			}[];
			expect(outline.map((section) => section.title)).toEqual([
				'Fixture App documentation',
				'Guide',
				'Reference',
				'Developer documentation',
			]);
			expect(outline[1]?.pages[1]).toEqual({
				slug: 'guide/first-tag',
				title: bundle.manifest.pages['guide/first-tag']?.locales.en?.title,
				description: bundle.manifest.pages['guide/first-tag']?.locales.en?.description,
				url: 'https://docs.example/fixture-app/docs/guide/first-tag',
				markdownUrl: 'https://docs.example/fixture-app/docs/guide/first-tag.md',
				audience: 'user',
			});
			expect(result.content[0]?.text).toContain('### Guide');
			expect(result.content[0]?.text).toContain('(slug: guide/first-tag)');
		}
	});

	test('an app without developer pages has no developer section', async () => {
		const sources = fixtureSources(bundle, site);
		const manifest = structuredClone(bundle.manifest);
		for (const slug of ['reference/api', 'developer/architecture']) {
			(manifest.pages[slug] as { audience: string }).audience = 'user';
		}
		const result = await tool(
			server({ manifests: { [globKey(site, 'manifest.json')]: manifest }, pages: sources.pages }),
			'get_app',
			{ app: 'fixture' },
		);
		const outline = result.structuredContent?.['outline'] as { title: string }[];
		expect(outline.map((section) => section.title)).not.toContain('Developer documentation');
	});

	test('an app with no docs is described without an outline, and an unknown one lists the names', async () => {
		const docs = server();
		const alarm = await tool(docs, 'get_app', { app: 'alarm' });
		expect(alarm.structuredContent).toEqual({ id: 'alarm', ...APPS[0], hasDocs: false });
		const unknown = await tool(docs, 'get_app', { app: 'banana' });
		expect([unknown.isError, unknown.content[0]?.text]).toEqual([
			true,
			'No app is called "banana". These are: alarm, fixture, elsewhere. list_apps describes each one.',
		]);
		for (const app of [undefined, '', '   ', 7, 'x'.repeat(101)]) {
			const bad = await tool(docs, 'get_app', app === undefined ? {} : { app });
			expect(bad.content[0]?.text).toBe('"app" must be a string of 1 to 100 characters.');
		}
	});
});

describe('search_docs', () => {
	test('finds sections, best first, each with its page, heading, both addresses and a snippet', async () => {
		const result = await tool(server(), 'search_docs', { query: 'scan tag' });
		expect(result.isError).toBe(false);
		const structured = result.structuredContent as Record<string, any>;
		expect([structured['query'], structured['language']]).toEqual(['scan tag', 'en']);
		const hits = structured['results'] as Record<string, any>[];
		expect(hits.length).toBeGreaterThan(1);
		expect(hits.length).toBeLessThanOrEqual(8);
		for (const hit of hits) {
			expect(hit['app']).toBe('fixture');
			expect(hit['url']).toMatch(/^https:\/\/docs\.example\/fixture-app\/docs/);
			expect(hit['markdownUrl']).toBe(`https://docs.example/fixture-app/docs/${hit['slug']}.md`);
			expect(hit['url'].endsWith(hit['anchor'] === '_top' ? '' : `#${hit['anchor']}`)).toBe(true);
		}
		const scores = hits.map((hit) => hit['score'] as number);
		expect([...scores].sort((a, b) => b - a)).toEqual(scores);
		expect(hits.some((hit) => (hit['snippet'] as string).length > 0)).toBe(true);
		expect(result.content[0]?.text).toMatch(/^1\. .+ \(fixture\)\n {3}https:/);
	});

	test('narrows by app, language, audience and limit, and says when nothing matched', async () => {
		const docs = server();
		const limited = await tool(docs, 'search_docs', { query: 'tag', limit: 1, app: 'fixture' });
		expect((limited.structuredContent?.['results'] as unknown[]).length).toBe(1);
		const developer = await tool(docs, 'search_docs', { query: 'tag', audience: 'developer' });
		for (const hit of developer.structuredContent?.['results'] as Record<string, any>[]) {
			expect([
				'reference/api',
				'developer/architecture',
				'index',
				'guide/index',
				'reference/index',
				'reference/chip-support',
			]).toContain(hit['slug']);
		}
		const japanese = await tool(docs, 'search_docs', { query: 'タグ', lang: 'JA' });
		const jaHits = japanese.structuredContent?.['results'] as Record<string, any>[];
		expect(japanese.structuredContent?.['language']).toBe('ja');
		expect(jaHits.length).toBeGreaterThan(0);
		expect(jaHits[0]?.['url']).toMatch(/^https:\/\/docs\.example\/ja\/fixture-app\/docs/);
		const nothing = await tool(docs, 'search_docs', { query: 'zzqqxx' });
		expect(nothing.content[0]?.text).toBe('Nothing in the documentation matches "zzqqxx".');
	});

	test('searches the source index for a language the bundle has no index for', async () => {
		const sources = fixtureSources(bundle, site);
		const manifest = structuredClone(bundle.manifest);
		delete manifest.search.fr;
		const docs = server({
			manifests: { [globKey(site, 'manifest.json')]: manifest },
			pages: sources.pages,
		});
		// A manifest whose search table lacks a locale fails the shape check, so the arm is
		// measured through the library directly rather than through a served bundle.
		const result = await tool(docs, 'search_docs', { query: 'tag', lang: 'fr' });
		expect(result.isError).toBe(true);
		const library = libraryOver({ ...fixtureLibraryBundle(), manifest });
		const agents = createAgents(library, {
			mcp: { capacity: 9, refillPerSecond: 1 },
			search: { capacity: 9, refillPerSecond: 1 },
			clock: () => 0,
		});
		const reply = await agents.search(new Request(`${ORIGIN}/docs/search.json?q=tag&lang=fr`));
		const body = (await reply.json()) as Record<string, any>;
		expect(reply.status).toBe(200);
		expect(body['results'][0]['url']).toMatch(/^https:\/\/docs\.example\/fr\//);
	});

	test('refuses every argument it cannot use, in a sentence naming it', async () => {
		const docs = server();
		const cases: [Record<string, unknown>, string][] = [
			[{}, '"query" must be a string of 1 to 200 characters.'],
			[{ query: 'x'.repeat(201) }, '"query" must be a string of 1 to 200 characters.'],
			[{ query: 'tag', lang: 'hi' }, '"lang" must be one of en, zh, ar, es, ja, fr, pt-BR.'],
			[{ query: 'tag', audience: 'both' }, '"audience" must be "user" or "developer".'],
			[{ query: 'tag', limit: 0 }, '"limit" must be a whole number from 1 to 20.'],
			[{ query: 'tag', limit: 2.5 }, '"limit" must be a whole number from 1 to 20.'],
			[{ query: 'tag', limit: '3' }, '"limit" must be a whole number from 1 to 20.'],
			[{ query: 'tag', app: 'alarm' }, 'Alarm has no documentation on this site yet.'],
		];
		for (const [args, message] of cases) {
			const result = await tool(docs, 'search_docs', args);
			expect({ args, error: result.isError, text: result.content[0]?.text }).toEqual({
				args,
				error: true,
				text: message,
			});
		}
	});

	test('a search index this build does not have, or cannot trust, is a tool error naming the fix', async () => {
		const sources = fixtureSources(bundle, site);
		const key = globKey(site, 'search/en.idx.json');
		const index = JSON.parse(bundle.objects.get('search/en.idx.json') as string) as Record<
			string,
			unknown
		>;
		const variants: [string, Record<string, () => Promise<unknown>>, string][] = [
			['missing', {}, 'search/en.idx.json was found'],
			['not an object', { [key]: async () => 'index' }, 'search/en.idx.json was found'],
			[
				'another tokeniser',
				{ [key]: async () => ({ ...index, tokeniser: 99 }) },
				'tokeniser is 99',
			],
			['truncated', { [key]: async () => ({ ...index, df: [] }) }, 'df has 0 entries'],
			[
				'another commit',
				{ [key]: async () => ({ ...index, bundle: 'f'.repeat(40) }) },
				`it is commit ${'f'.repeat(40)}`,
			],
			[
				'shapeless',
				{
					[key]: async () => ({
						kind: 'hexdocs.index',
						v: 1,
						ast: 1,
						tokeniser: 2,
						norm: 'NFKC',
						stem: false,
						match: 'or-coord',
					}),
				},
				'cannot be read',
			],
		];
		for (const [name, search, phrase] of variants) {
			const result = await tool(server({ search, pages: sources.pages }), 'search_docs', {
				query: 'tag',
			});
			expect({
				name,
				error: result.isError,
				phrase: result.content[0]?.text.includes(phrase),
				prefetch: result.content[0]?.text.includes('hexdocs prefetch'),
			}).toEqual({ name, error: true, phrase: true, prefetch: true });
		}
	});

	test('a hit whose page payload is missing still answers, with an empty snippet', async () => {
		const sources = fixtureSources(bundle, site);
		const result = await tool(server({ pages: {}, search: sources.search }), 'search_docs', {
			query: 'tag',
			limit: 3,
		});
		const hits = result.structuredContent?.['results'] as Record<string, any>[];
		expect(hits.length).toBe(3);
		expect(hits.every((hit) => hit['snippet'] === '')).toBe(true);
	});
	test('a snippet reads a status mark as its words, and cuts a long run with no spaces at the limit', async () => {
		const result = await tool(server(), 'search_docs', { query: 'supported chip', limit: 20 });
		const snippets = (result.structuredContent?.['results'] as Record<string, any>[]).map(
			(hit) => hit['snippet'] as string,
		);
		expect(snippets.some((snippet) => /Supported|Partial|Not supported/.test(snippet))).toBe(true);

		const sources = fixtureSources(bundle, site);
		const key = globKey(site, 'pages/en/guide/first-tag.json');
		const page = JSON.parse(
			bundle.objects.get('pages/en/guide/first-tag.json') as string,
		) as Record<string, any>;
		const long = {
			...page,
			body: [{ type: 'paragraph', children: [{ type: 'text', value: 'x'.repeat(400) }] }],
		};
		const docs = server({ pages: { ...sources.pages, [key]: async () => long } });
		const hits = (await tool(docs, 'search_docs', { query: 'scan first tag', limit: 20 }))
			.structuredContent?.['results'] as Record<string, any>[];
		const top = hits.find((hit) => hit['slug'] === 'guide/first-tag' && hit['anchor'] === '_top');
		expect(top?.['snippet']).toBe(`${'x'.repeat(280)}…`);
	});

	test('orders equal scores by address, so the same query gives the same order every time', async () => {
		const second = { ...site, basePath: '/second-app/docs' };
		const docs = server({ configs: [site, second] });
		const hits = (await tool(docs, 'search_docs', { query: 'tag', limit: 6 }, {}))
			.structuredContent?.['results'] as Record<string, any>[];
		// The same section scores the same under both mounts, and the earlier address comes first.
		expect(hits[0]?.['score']).toBe(hits[1]?.['score']);
		expect([hits[0]?.['url'], hits[1]?.['url']].sort()).toEqual([
			hits[0]?.['url'],
			hits[1]?.['url'],
		]);
		expect(hits[0]?.['url']).toMatch(/fixture-app/);
		expect(hits[1]?.['url']).toMatch(/second-app/);
	});

	test('a site that passes no search glob answers a search with a tool error naming the glob', async () => {
		const { search: _search, ...withoutSearch } = fixtureSources(bundle, site);
		const docs = docsServer({ ...withoutSearch, origin: ORIGIN });
		const result = await tool(docs, 'search_docs', { query: 'tag' });
		expect([result.isError, result.content[0]?.text]).toEqual([
			true,
			expect.stringContaining('Pass the search glob to docsServer'),
		]);
	});
});

describe('get_page', () => {
	test('reads a page as markdown with its header, by any spelling of its slug', async () => {
		const docs = server();
		for (const [slug, wire] of [
			['guide/first-tag', 'guide/first-tag'],
			['/guide/first-tag.md', 'guide/first-tag'],
			['GUIDE', 'guide/index'],
			['guide/', 'guide/index'],
			['/', 'index'],
			['index', 'index'],
			['first-tag', 'guide/first-tag'],
		] as const) {
			const result = await tool(docs, 'get_page', { app: 'fixture', slug });
			expect({ slug, error: result.isError, wire: result.structuredContent?.['slug'] }).toEqual({
				slug,
				error: false,
				wire,
			});
		}
		const page = await tool(docs, 'get_page', {
			app: 'fixture',
			slug: 'guide/first-tag',
			lang: 'ja',
		});
		const structured = page.structuredContent as Record<string, any>;
		expect(structured).toMatchObject({
			app: 'fixture',
			slug: 'guide/first-tag',
			language: 'ja',
			url: 'https://docs.example/ja/fixture-app/docs/guide/first-tag',
			markdownUrl: 'https://docs.example/ja/fixture-app/docs/guide/first-tag.md',
			offset: 0,
			title: bundle.manifest.pages['guide/first-tag']?.locales.ja?.title,
		});
		expect(structured['nextOffset']).toBeUndefined();
		expect(structured['text']).toMatch(/^---\ntitle: /);
		expect(structured['text']).toContain('product: "Fixture App"');
		expect(structured['totalLength']).toBe((structured['text'] as string).length);
		expect(page.content[0]?.text).toBe(structured['text']);
		// A page with no translation is the source's, and says so.
		const fallback = await tool(docs, 'get_page', {
			app: 'fixture',
			slug: 'developer/architecture',
			lang: 'fr',
		});
		expect(fallback.structuredContent).toMatchObject({
			language: 'en',
			url: 'https://docs.example/fixture-app/docs/developer/architecture',
		});
	});

	test('refuses a page that does not exist, an app with no docs and a bad offset', async () => {
		const docs = server();
		const cases: [Record<string, unknown>, string][] = [
			[
				{ app: 'fixture', slug: 'guide/nope' },
				'There is no page "guide/nope" in this documentation. get_app lists every page.',
			],
			[{ app: 'alarm', slug: 'index' }, 'Alarm has no documentation on this site yet.'],
			[
				{ app: 'fixture', slug: 'index', offset: -1 },
				`"offset" must be a whole number from 0 to ${Number.MAX_SAFE_INTEGER}.`,
			],
			[
				{ app: 'fixture', slug: 'index', offset: 10_000_000 },
				'"offset" is past the end of the page',
			],
			[
				{ app: 'fixture', slug: 'index', lang: 7 },
				'"lang" must be a string of 1 to 16 characters.',
			],
		];
		for (const [args, message] of cases) {
			const result = await tool(docs, 'get_page', args);
			expect({
				args,
				error: result.isError,
				starts: result.content[0]?.text.startsWith(message),
			}).toEqual({ args, error: true, starts: true });
		}
		const noRedirects = { ...site };
		delete noRedirects.redirects;
		const sources = fixtureSources(bundle, noRedirects);
		const retired = await tool(
			server({ configs: [noRedirects], pages: sources.pages }),
			'get_page',
			{ app: 'fixture', slug: 'first-tag' },
		);
		expect(retired.isError).toBe(true);
	});

	test('a raw page the build lacks is a tool error naming hexdocs prefetch', async () => {
		const sources = fixtureSources(bundle, site);
		const text = { ...sources.text };
		delete text[globKey(site, 'raw/en/index.md')];
		const result = await tool(server({ text }), 'get_page', { app: 'fixture', slug: 'index' });
		expect([result.isError, result.content[0]?.text]).toEqual([
			true,
			expect.stringContaining('raw/en/index.md is missing'),
		]);
	});

	test('a long page comes in windows that end between lines, and never inside a character', async () => {
		const sources = fixtureSources(bundle, site);
		const key = globKey(site, 'raw/en/guide/troubleshooting.md');
		const line = `${'word '.repeat(19)}end\n`;
		const lined = line.repeat(Math.ceil((PAGE_WINDOW * 2.5) / line.length));
		const docs = server({ origin: undefined, text: { ...sources.text, [key]: async () => lined } });
		const parts: string[] = [];
		let offset: number | undefined = 0;
		let windows = 0;
		while (offset !== undefined) {
			const result = await tool(docs, 'get_page', {
				app: 'fixture',
				slug: 'guide/troubleshooting',
				offset,
			});
			const structured = result.structuredContent as Record<string, any>;
			const text = structured['text'] as string;
			expect(text.length).toBeLessThanOrEqual(PAGE_WINDOW);
			if (structured['nextOffset'] !== undefined) {
				expect(text.endsWith('\n')).toBe(true);
				expect(result.content[0]?.text).toContain(
					`Call get_page with offset ${structured['nextOffset']} for the rest.`,
				);
			}
			parts.push(text);
			offset = structured['nextOffset'] as number | undefined;
			windows += 1;
		}
		expect(windows).toBe(3);
		expect(parts.join('')).toBe(lined);

		// No line break at all in the second half: the window is cut at the limit, then pulled
		// back one unit rather than splitting a surrogate pair.
		const solid = `${'a'.repeat(PAGE_WINDOW - 1)}😀${'b'.repeat(50)}`;
		const unbroken = server({
			origin: undefined,
			text: { ...sources.text, [key]: async () => solid },
		});
		const first = await tool(unbroken, 'get_page', {
			app: 'fixture',
			slug: 'guide/troubleshooting',
		});
		expect(first.structuredContent?.['nextOffset']).toBe(PAGE_WINDOW - 1);
		const second = await tool(unbroken, 'get_page', {
			app: 'fixture',
			slug: 'guide/troubleshooting',
			offset: PAGE_WINDOW - 1,
		});
		expect((second.structuredContent?.['text'] as string).startsWith('😀')).toBe(true);
		const early = `${'a'.repeat(100)}\n${'c'.repeat(PAGE_WINDOW + 10)}`;
		const breakEarly = server({
			origin: undefined,
			text: { ...sources.text, [key]: async () => early },
		});
		const cut = await tool(breakEarly, 'get_page', {
			app: 'fixture',
			slug: 'guide/troubleshooting',
		});
		expect(cut.structuredContent?.['nextOffset']).toBe(PAGE_WINDOW);
	});
});

describe('the JSON search', () => {
	const get = (query: string, headers: Record<string, string> = {}, method = 'GET') =>
		new Request(`${ORIGIN}/docs/search.json${query}`, { method, headers });

	test('answers a query with the same results as the tool, as public, cacheable, cross-origin JSON', async () => {
		const docs = server();
		const response = await docs.search(get('?q=scan+tag&limit=3'), HOST);
		expect(response.status).toBe(200);
		expect(Object.fromEntries(response.headers)).toEqual({
			'content-type': 'application/json; charset=utf-8',
			'x-content-type-options': 'nosniff',
			'cache-control': 'public, max-age=3600',
			etag: expect.stringMatching(/^"[0-9a-f]{32}"$/),
			'access-control-allow-origin': '*',
			'content-signal': 'search=yes, ai-input=yes, ai-train=yes',
			'x-robots-tag': 'noindex',
		});
		const body = (await response.json()) as Record<string, any>;
		const fromTool = await tool(docs, 'search_docs', { query: 'scan tag', limit: 3 });
		expect(body).toEqual(fromTool.structuredContent);

		const again = await docs.search(
			get('?q=scan+tag&limit=3', { 'If-None-Match': response.headers.get('ETag') as string }),
			HOST,
		);
		expect([again.status, again.body]).toEqual([304, null]);
	});

	test('refuses a bad query with a 400 naming the URL parameter, and a broken build with a 500', async () => {
		const docs = server();
		const missing = await docs.search(get(''));
		expect([missing.status, await missing.json()]).toEqual([
			400,
			{ error: '"q" must be a string of 1 to 200 characters.' },
		]);
		expect(missing.headers.get('Access-Control-Allow-Origin')).toBe('*');
		const limit = await docs.search(get('?q=tag&limit=many'));
		expect(((await limit.json()) as Record<string, string>)['error']).toBe(
			'"limit" must be a whole number from 1 to 20.',
		);
		const sources = fixtureSources(bundle, site);
		const broken = await server({ search: {}, pages: sources.pages }).search(get('?q=tag'));
		expect(broken.status).toBe(500);
	});

	test('a failure that is not a refusal is left for the router to answer', async () => {
		const library = libraryOver(fixtureLibraryBundle());
		library.searchIndex = () => {
			throw new TypeError('a bug');
		};
		const agents = createAgents(library, {
			mcp: { capacity: 9, refillPerSecond: 1 },
			search: { capacity: 9, refillPerSecond: 1 },
			clock: () => 0,
		});
		await expect(agents.search(get('?q=tag'))).rejects.toThrow('a bug');
	});

	test('answers a preflight, refuses other methods, and has its own bucket', async () => {
		now = 5_000_000;
		const docs = server({ rateLimit: { search: { capacity: 1, refillPerSecond: 1 } } });
		const preflight = await docs.search(get('?q=tag', {}, 'OPTIONS'));
		expect([preflight.status, preflight.headers.get('Access-Control-Allow-Methods')]).toEqual([
			204,
			'GET, HEAD',
		]);
		const post_ = await docs.search(get('?q=tag', {}, 'POST'));
		expect([post_.status, post_.headers.get('Allow')]).toEqual([405, 'GET, HEAD, OPTIONS']);
		expect((await docs.search(get('?q=tag', {}, 'HEAD'))).status).toBe(200);
		const limited = await docs.search(get('?q=tag'));
		expect([limited.status, limited.headers.get('Retry-After')]).toEqual([429, '1']);
		// The MCP endpoint's bucket is untouched.
		expect((await call(docs, post({ jsonrpc: '2.0', id: 1, method: 'ping' }))).status).toBe(200);
	});
});

describe('the Server Card', () => {
	const card = (method = 'GET', headers: Record<string, string> = {}) =>
		new Request(`${ORIGIN}/mcp/server-card`, { method, headers });

	test('describes the remote endpoint by the SEP-2127 schema, with open CORS and a validator', async () => {
		const docs = server();
		const response = await docs.serverCard(card());
		expect(response.status).toBe(200);
		expect(Object.fromEntries(response.headers)).toEqual({
			'content-type': 'application/mcp-server-card+json',
			'x-content-type-options': 'nosniff',
			'cache-control': 'public, max-age=3600',
			etag: expect.stringMatching(/^"[0-9a-f]{32}"$/),
			'access-control-allow-origin': '*',
			'access-control-allow-methods': 'GET',
			'access-control-allow-headers': 'Content-Type, If-None-Match',
			'access-control-expose-headers': 'ETag',
		});
		expect(await response.json()).toEqual({
			$schema: SERVER_CARD_SCHEMA,
			name: 'example.docs/docs',
			version: '1.0.0',
			title: 'Example docs',
			description: 'Search and read the example documentation.',
			websiteUrl: 'https://docs.example',
			remotes: [
				{
					type: 'streamable-http',
					url: 'https://docs.example/mcp',
					supportedProtocolVersions: [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS],
				},
			],
		});
		const again = await docs.serverCard(
			card('GET', { 'If-None-Match': response.headers.get('ETag') as string }),
		);
		expect(again.status).toBe(304);
		const versioned = await server({ agents: { ...AGENTS, version: '2.1.0' } }).serverCard(card());
		expect(((await versioned.json()) as Record<string, string>)['version']).toBe('2.1.0');
	});

	test('answers a preflight and refuses other methods', async () => {
		const docs = server();
		expect((await docs.serverCard(card('OPTIONS'))).status).toBe(204);
		const refused = await docs.serverCard(card('DELETE'));
		expect([refused.status, refused.headers.get('Allow')]).toEqual([405, 'GET, HEAD, OPTIONS']);
	});

	test('is a 500 naming what is missing when there is nothing valid to describe', async () => {
		const cases: [Partial<DocsServerOptions>, string][] = [
			[{ agents: undefined }, 'no agents option'],
			[{ origin: undefined }, 'no origin'],
			[{ agents: { ...AGENTS, name: 'docs' } }, 'exactly one slash'],
			[{ agents: { ...AGENTS, description: 'x'.repeat(101) } }, '1 to 100 characters'],
			[{ agents: { ...AGENTS, description: '' } }, '1 to 100 characters'],
		];
		for (const [options, phrase] of cases) {
			const response = await server(options).serverCard(card());
			expect([response.status, (await response.text()).includes(phrase)]).toEqual([500, true]);
		}
	});
});

// ---------------------------------------------------------------------------
// A library over the fixture bundle, for the arms a served bundle cannot reach
// ---------------------------------------------------------------------------

function fixtureLibraryBundle() {
	const sources = fixtureSources(bundle, site);
	const docs = docsServer(sources);
	void docs;
	return {
		manifest: bundle.manifest,
		label: '1.1.0',
		bundleBase: '/_docs/fixture-app/1.1.0',
		files: {
			pages: new Map(
				Object.entries(sources.pages).map(([key, load]) => [
					key.split('/1.1.0/')[1] as string,
					load,
				]),
			),
			text: new Map(
				Object.entries(sources.text).map(([key, load]) => [
					key.split('/1.1.0/')[1] as string,
					load,
				]),
			),
			search: new Map(
				Object.entries(sources.search).map(([key, load]) => [
					key.split('/1.1.0/')[1] as string,
					load,
				]),
			),
		},
	};
}

function libraryOver(checked: ReturnType<typeof fixtureLibraryBundle>): AgentLibrary {
	return {
		configs: [site],
		bundleFor: () => ({ ok: true, ...checked }),
		options: { origin: ORIGIN },
		broken: () => undefined,
		async searchIndex(_served, locale) {
			const load = checked.files.search.get(`search/${locale}.idx.json`);
			return { ok: true, index: (await (load as () => Promise<unknown>)()) as never };
		},
		productName: async () => 'Fixture App',
	};
}
