/**
 * The public agent interface in `src/site/agents.ts`, driven by the reference implementation's
 * own HTTP client over a real socket.
 *
 * The runtime half may import nothing, so it cannot use the SDK and cannot prove its protocol
 * claim against it in its own suite. This file can, for the same reason
 * `protocol.test.ts` can: the SDK is a devDependency of `kit/` and nothing a website installs.
 * The handler is mounted on a plain `node:http` server the way a resource route mounts it, a
 * `Request` in and a `Response` out, and the SDK's `Client` connects with its
 * `StreamableHTTPClientTransport`, which opens with `initialize`, sends the version header on
 * every later request, tries to open a GET stream and closes the session it never received.
 *
 * What only this can show: that a real client accepts the negotiated version, survives the 405
 * on its stream request, and validates every `structuredContent` against the tool's
 * `outputSchema`, which the SDK does with a real JSON Schema validator. A schema that
 * disagreed with what a tool returns is a thrown error here and a broken tool for every
 * client that checks.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { DocsCatalogueApp } from '../../../src/contracts/host.js';
import { LEGACY_PROTOCOL_VERSIONS } from '../../../src/site/agents.js';
import { docsServer, type DocsServer } from '../../../src/site/serve.js';
import { fixtureBundle, fixtureSite, fixtureSources } from '../../../test/support/bundle.js';

const ORIGIN = 'https://docs.example';
const APPS: DocsCatalogueApp[] = [
	{
		id: 'alarm',
		name: 'Alarm',
		description: 'An alarm clock for iPhone.',
		publisher: { name: 'Example', url: 'https://example.com' },
		platforms: [{ name: 'iPhone', minimumOs: 'iOS 17' }],
		pricing: { model: 'Free with an optional subscription', prices: ['A$2.99 a month'] },
		status: 'near-release',
		productUrl: 'https://docs.example/alarm',
	},
	{
		id: 'fixture',
		project: 'fixture-app',
		name: 'Fixture App',
		description: 'Reads and rewrites NFC tags on an iPhone.',
		publisher: { name: 'Example', legalName: 'Example Pty Ltd', url: 'https://example.com' },
		platforms: [{ name: 'iPhone', minimumOs: 'iOS 17' }],
		pricing: { model: 'Free' },
		status: 'released',
		productUrl: 'https://docs.example/fixture',
		privacyUrl: 'https://docs.example/fixture/privacy',
	},
];

let docs: DocsServer;
let http: Server;
let endpoint: URL;
const seen: { method: string; session: string | undefined }[] = [];

/** A `node:http` request as the `Request` a React Router resource route would be handed. */
async function toRequest(incoming: IncomingMessage): Promise<Request> {
	const chunks: Buffer[] = [];
	for await (const chunk of incoming) chunks.push(chunk as Buffer);
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		if (typeof value === 'string') headers.set(name, value);
	}
	const method = incoming.method ?? 'GET';
	return new Request(`http://127.0.0.1${incoming.url ?? '/'}`, {
		method,
		headers,
		...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
	});
}

async function answer(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
	seen.push({
		method: incoming.method ?? '',
		session: incoming.headers['mcp-session-id'] as string | undefined,
	});
	const request = await toRequest(incoming);
	const response = await docs.mcp(request, { apps: () => APPS });
	outgoing.writeHead(response.status, Object.fromEntries(response.headers));
	outgoing.end(Buffer.from(await response.arrayBuffer()));
}

beforeAll(async () => {
	const bundle = fixtureBundle();
	const site = fixtureSite(bundle);
	docs = docsServer({
		...fixtureSources(bundle, site),
		origin: ORIGIN,
		licence: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
		agents: {
			name: 'example.docs/docs',
			title: 'Example docs',
			description: 'Search and read the example documentation.',
			website: ORIGIN,
			mcp: '/mcp',
		},
	});
	http = createServer((incoming, outgoing) => {
		void answer(incoming, outgoing);
	});
	await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
	endpoint = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
}, 120_000);

afterAll(async () => {
	await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe('the SDK client over Streamable HTTP', () => {
	let client: Client;

	beforeAll(async () => {
		client = new Client({ name: 'hexdocs-test', version: '1.0.0' });
		await client.connect(new StreamableHTTPClientTransport(endpoint));
	});

	afterAll(async () => {
		await client.close();
	});

	test('connects, negotiates a version both speak, and is never given a session', () => {
		expect(client.getServerVersion()).toMatchObject({
			name: 'example.docs/docs',
			version: '1.0.0',
		});
		expect(client.getServerCapabilities()).toEqual({ tools: {} });
		expect(client.getInstructions()).toContain('CC BY 4.0');
		expect(LEGACY_PROTOCOL_VERSIONS).toContain(
			(client as unknown as { _transport: { protocolVersion?: string } })._transport
				.protocolVersion,
		);
		expect(seen.every((request) => request.session === undefined)).toBe(true);
	});

	test('lists the four read-only tools, each with an output schema', async () => {
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual([
			'list_apps',
			'get_app',
			'search_docs',
			'get_page',
		]);
		for (const tool of tools) {
			expect(tool.outputSchema).toBeDefined();
			expect(tool.annotations?.readOnlyHint).toBe(true);
		}
	});

	test('every tool answers with structured content the client validates against its schema', async () => {
		const apps = await client.callTool({ name: 'list_apps', arguments: {} });
		expect(apps.isError).toBe(false);
		expect(
			(apps.structuredContent as { apps: { id: string }[] }).apps.map((app) => app.id),
		).toEqual(['alarm', 'fixture']);

		const app = await client.callTool({ name: 'get_app', arguments: { app: 'fixture' } });
		expect((app.structuredContent as { outline: unknown[] }).outline.length).toBeGreaterThan(0);

		const search = await client.callTool({
			name: 'search_docs',
			arguments: { query: 'scan tag', limit: 3 },
		});
		const results = (
			search.structuredContent as { results: { url: string; markdownUrl: string }[] }
		).results;
		expect(results.length).toBe(3);
		expect(results[0]?.url.startsWith(`${ORIGIN}/fixture-app/docs`)).toBe(true);

		const page = await client.callTool({
			name: 'get_page',
			arguments: { app: 'fixture', slug: 'guide/first-tag' },
		});
		const text = (page.structuredContent as { text: string }).text;
		expect(text.startsWith('---\ntitle: ')).toBe(true);
		expect((page.content as { text: string }[])[0]?.text).toBe(text);
	});

	test('a refused argument is a tool result the model can read, not a protocol error', async () => {
		const result = await client.callTool({
			name: 'get_page',
			arguments: { app: 'fixture', slug: 'nope' },
		});
		expect(result.isError).toBe(true);
		expect((result.content as { text: string }[])[0]?.text).toContain('There is no page "nope"');
	});

	test('the stream the client asked for was refused with a 405, and it carried on', () => {
		expect(seen.some((request) => request.method === 'GET')).toBe(true);
		expect(seen.filter((request) => request.method === 'POST').length).toBeGreaterThan(4);
	});
});
