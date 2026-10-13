/**
 * A public, read-only interface for AI agents: MCP over Streamable HTTP, a JSON search URL, and
 * the Server Card that describes the MCP endpoint before anybody connects to it.
 *
 * Every handler takes a `Request` and returns a `Response`, and the host mounts each one as a
 * resource route. Nothing here imports anything: no SDK, no router, no node module. The kit's
 * stdio server proved that a tools-only MCP server is a few hundred lines of JSON-RPC, and it
 * proved it against the SDK's own client; `kit/test/mcp/agents.test.ts` does the same for this
 * one over HTTP. The dispatch is ported from `kit/src/mcp/protocol.ts` rather than imported,
 * because `kit/` is never imported by a website and this file runs inside one.
 *
 * ## Two eras of the protocol, on one endpoint
 *
 * MCP 2026-07-28 removed the `initialize` handshake: every request carries its protocol version
 * and the client's capabilities in `params._meta`, mirrored into `MCP-Protocol-Version`,
 * `Mcp-Method` and `Mcp-Name` headers that the server must check against the body. The
 * revisions up to 2025-11-25 open with `initialize` and send nothing per request but the version
 * header. Clients of both are in use, and the specification describes a dual-era server, which
 * is what this is:
 *
 * - `initialize` selects the earlier behaviour, negotiated the way those revisions say: echo the
 *   requested version when it is one of ours, and otherwise answer with our latest of that era.
 * - A request whose `_meta` names a protocol version is served by the 2026-07-28 rules: version,
 *   capabilities and headers checked, with the status codes that revision assigns to each
 *   refusal, `server/discover` answered, and `resultType` and the server's identity on results.
 * - Anything else is a request after an `initialize`, which needs no state to answer because
 *   nothing a client negotiates changes what a read-only tool returns. So there is no session,
 *   no `Mcp-Session-Id`, and `GET` and `DELETE` are 405, which is what the 2026-07-28 binding
 *   asks of a server that receives an earlier client's stream and session requests, and what the
 *   earlier revisions allow a server with nothing to stream.
 *
 * ## What it refuses, before anything is parsed
 *
 * React Router checks an action's `Origin` for document and data requests and not for a
 * resource route, so the check the MCP binding requires against DNS rebinding is here and
 * nowhere else: a present `Origin` that is not the configured origin is a 403, and an absent one
 * is a server-side client. Then the method, the media type, a 64 KB body, and a token bucket
 * per client address. The bucket lives in this process and forgets on a deploy; it is a second
 * line behind the host's own rate limit at the edge, which is the real one, and `CLAUDE.md`
 * says so.
 */

import { AUDIENCE_MASK, PAGE_ROOT_ANCHOR, type AudienceMask } from '../contracts/search.js';
import { type Block } from '../contracts/ast.js';
import {
	APP_STATUSES,
	type DocsAgentConfig,
	type DocsAppFacts,
	type DocsCatalogueApp,
	type DocsHostFacts,
} from '../contracts/host.js';
import { LOCALES, matchLocale, type Locale } from '../contracts/locales.js';
import { pageKey, type PageRecord } from '../contracts/manifest.js';
import type { CompiledPage } from '../contracts/page.js';
import type { SearchIndex } from '../contracts/search.js';
import type { DocsSiteConfig } from '../contracts/site.js';
import { blockText } from '../ast/text.js';
import { searchIndex } from '../search/query.js';
import { statusLabel } from '../ui/status.js';
import { readObject, type Bundle } from './bundle.js';
import {
	CONTENT_SIGNAL,
	endpointUrl,
	etagOf,
	factLines,
	isoDate,
	machineUrl,
	markdownUrl,
	newestUpdate,
	notModified,
	outlineOf,
	pageMarkdown,
	pageUrl,
	servedRecord,
	type MachineOptions,
	type Served,
} from './machine.js';
import { looksLikePage, servedLocale } from './route.js';

/** The tool surface's own version, which a host may override. */
export const DOCS_AGENT_VERSION = '1.0.0';

/** The revision with per-request metadata. */
export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const;

/**
 * The `initialize` revisions this server answers, newest first.
 *
 * Not 2024-11-05, whose HTTP transport was HTTP+SSE: Streamable HTTP arrived in 2025-03-26, so a
 * client asking for 2024-11-05 over this transport is answered with 2025-11-25, which the
 * negotiation rules allow and which the client then accepts or declines.
 */
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

/** A JSON-RPC message is a few hundred bytes. Anything near this is not a docs question. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** One window of a page, in UTF-16 code units, which is what `String.prototype.slice` counts. */
export const PAGE_WINDOW = 20_000;

export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 20;

/** The longest snippet a search hit carries, in characters. */
const SNIPPET_LENGTH = 280;

export interface RateLimit {
	/** The burst a client may spend at once. */
	capacity: number;
	/** How many tokens come back each second. */
	refillPerSecond: number;
}

/** A burst of 60 and one a second after it, per client address, per handler. */
export const DEFAULT_RATE_LIMIT: RateLimit = { capacity: 60, refillPerSecond: 1 };

/** The Server Card schema SEP-2127's extension publishes. */
export const SERVER_CARD_SCHEMA =
	'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';

const ALL_VERSIONS = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS];

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';

/** JSON-RPC and MCP error codes, only the ones this server produces. */
const RPC = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	headerMismatch: -32020,
	unsupportedVersion: -32022,
} as const;

/** What the handlers need from the server that owns the bundles. */
export interface AgentLibrary {
	configs: readonly DocsSiteConfig[];
	bundleFor(site: DocsSiteConfig): Bundle;
	options: MachineOptions;
	/** Why the server cannot answer anything, such as an origin that is not one. */
	broken(): string | undefined;
	searchIndex(
		served: Served,
		locale: Locale,
	): Promise<{ ok: true; index: SearchIndex } | { ok: false; message: string }>;
	productName(served: Served): Promise<string>;
}

export interface DocsAgents {
	/** The MCP endpoint, for both `loader` and `action` of its resource route. */
	mcp(request: Request, host?: DocsHostFacts): Promise<Response>;
	/** The JSON search, for a resource route's `loader`. */
	search(request: Request, host?: DocsHostFacts): Promise<Response>;
	/** The Server Card, for a resource route's `loader`, and its `action` for a preflight. */
	serverCard(request: Request): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function plain(status: number, body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'no-store',
			...headers,
		},
	});
}

/**
 * A token bucket per client, in this process.
 *
 * Least recently used first out when the table is full, so a flood of new addresses evicts the
 * quiet ones rather than growing without bound. Returns 0 when the request may go ahead and the
 * whole seconds to wait otherwise, which is the `Retry-After` value.
 */
export function tokenBuckets(
	limit: RateLimit,
	clock: () => number,
	maxKeys = 10_000,
): (key: string) => number {
	const buckets = new Map<string, { tokens: number; at: number }>();
	return (key) => {
		const now = clock();
		const bucket = buckets.get(key);
		const tokens =
			bucket === undefined
				? limit.capacity
				: Math.min(
						limit.capacity,
						bucket.tokens + ((now - bucket.at) / 1000) * limit.refillPerSecond,
					);
		buckets.delete(key);
		if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value as string);
		if (tokens < 1) {
			buckets.set(key, { tokens, at: now });
			return Math.ceil((1 - tokens) / limit.refillPerSecond);
		}
		buckets.set(key, { tokens: tokens - 1, at: now });
		return 0;
	};
}

/**
 * Who is asking: Cloudflare's client address, then the first `X-Forwarded-For` hop, then one key
 * every unidentified request shares. Cut to 64 characters, so a forged header cannot grow the
 * table's keys.
 */
export function clientKey(headers: Headers): string {
	const cloudflare = (headers.get('CF-Connecting-IP') ?? '').trim();
	if (cloudflare !== '') return cloudflare.slice(0, 64);
	const forwarded = ((headers.get('X-Forwarded-For') ?? '').split(',')[0] as string).trim();
	if (forwarded !== '') return forwarded.slice(0, 64);
	return 'shared';
}

/** The body, read no further than the cap, or the status that refuses it. */
async function readBody(
	request: Request,
): Promise<{ ok: true; text: string } | { ok: false; status: 400 | 413 }> {
	const declared = Number(request.headers.get('Content-Length') ?? '0');
	if (declared > MAX_REQUEST_BYTES) return { ok: false, status: 413 };
	if (request.body === null) return { ok: true, text: '' };
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = request.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_REQUEST_BYTES) {
			await reader.cancel();
			return { ok: false, status: 413 };
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	try {
		return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
	} catch {
		return { ok: false, status: 400 };
	}
}

/** The media type of a header value, without its parameters. */
function mediaType(value: string | null): string {
	return ((value ?? '').split(';')[0] as string).trim().toLowerCase();
}

/** Whether an `Accept` header admits a JSON response. Absent admits everything. */
function acceptsJson(accept: string | null): boolean {
	if (accept === null) return true;
	return accept
		.split(',')
		.map((part) => mediaType(part))
		.some((type) => type === 'application/json' || type === 'application/*' || type === '*/*');
}

/** `=?base64?...?=` decoded, as the 2026-07-28 binding encodes a header that is not ASCII. */
function headerValue(value: string | null): string | null {
	const encoded = /^=\?base64\?(.*)\?=$/.exec(value ?? '')?.[1];
	if (encoded === undefined) return value;
	try {
		const binary = atob(encoded);
		return new TextDecoder('utf-8', { fatal: true }).decode(
			Uint8Array.from(binary, (character) => character.charCodeAt(0)),
		);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// The catalogue: every app the host sells, and which of them this site documents
// ---------------------------------------------------------------------------

interface Entry {
	id: string;
	facts?: DocsAppFacts;
	site?: DocsSiteConfig;
}

/** A tool failure the model can read and correct, rather than a protocol error. */
class ToolError extends Error {}

/**
 * A failure that is the site's and not the caller's: a bundle or a search index this build
 * does not have. Still a tool result over MCP, and a 500 rather than a 400 from the JSON search.
 */
class Unavailable extends ToolError {}

/**
 * The host's catalogue, with every documented project in it.
 *
 * A project the host's list does not name is still listed, under its own id, so documentation
 * never disappears from the interface because a registry fell behind. `describe` wins over the
 * catalogue entry for a documented app, because it is the more specific answer.
 */
function catalogue(configs: readonly DocsSiteConfig[], host: DocsHostFacts | undefined): Entry[] {
	const byProject = new Map(configs.map((site) => [site.project, site]));
	const describe = host?.describe;
	const entries: Entry[] = [];
	const claimed = new Set<string>();
	for (const app of host?.apps?.() ?? []) {
		const site = app.project === undefined ? undefined : byProject.get(app.project);
		if (site === undefined) {
			entries.push({ id: app.id, facts: factsOnly(app) });
			continue;
		}
		claimed.add(site.project);
		entries.push({ id: app.id, facts: factsOnly(describe?.(site.project) ?? app), site });
	}
	for (const site of configs) {
		if (claimed.has(site.project)) continue;
		const described = describe?.(site.project);
		const facts = described === undefined ? undefined : factsOnly(described);
		entries.push({ id: site.project, site, ...(facts === undefined ? {} : { facts }) });
	}
	return entries;
}

/**
 * The facts alone, without the catalogue's `id` and `project`. A host that answers `describe`
 * with its catalogue entry is passing exactly that, and an `id` spread over a summary would
 * rename the app.
 */
function factsOnly(value: DocsAppFacts | DocsCatalogueApp): DocsAppFacts {
	const {
		id: _id,
		project: _project,
		...facts
	} = value as Partial<DocsCatalogueApp> & DocsAppFacts;
	return facts;
}

/** One app by the name an agent used: the catalogue id or the docs project, in any case. */
function findApp(entries: readonly Entry[], name: string): Entry {
	const wanted = name.trim().toLowerCase();
	const found = entries.find(
		(entry) => entry.id.toLowerCase() === wanted || entry.site?.project.toLowerCase() === wanted,
	);
	if (found === undefined) {
		throw new ToolError(
			`No app is called "${name}". These are: ${entries.map((entry) => entry.id).join(', ')}. list_apps describes each one.`,
		);
	}
	return found;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function argumentsOf(value: unknown, allowed: readonly string[]): Json {
	const args = value === undefined ? {} : value;
	if (!isObject(args)) throw new ToolError('The arguments must be an object.');
	const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		throw new ToolError(
			`Unknown argument ${unknown.map((key) => `"${key}"`).join(', ')}. This tool takes ${allowed.length === 0 ? 'no arguments' : allowed.join(', ')}.`,
		);
	}
	return args;
}

function stringArgument(args: Json, name: string, max: number, required: true): string;
function stringArgument(args: Json, name: string, max: number, required: false): string | undefined;
function stringArgument(args: Json, name: string, max: number, required: boolean) {
	const value = args[name];
	if (value === undefined && !required) return undefined;
	if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
		throw new ToolError(`"${name}" must be a string of 1 to ${max} characters.`);
	}
	return value.trim();
}

function integerArgument(args: Json, name: string, min: number, max: number): number | undefined {
	const value = args[name];
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
		throw new ToolError(`"${name}" must be a whole number from ${min} to ${max}.`);
	}
	return value;
}

function languageArgument(args: Json): Locale {
	const value = stringArgument(args, 'lang', 16, false);
	if (value === undefined) return 'en';
	const match = matchLocale(value);
	if (!match.ok) {
		throw new ToolError(`"lang" must be one of ${LOCALES.join(', ')}.`);
	}
	return match.locale;
}

function audienceArgument(args: Json): AudienceMask | undefined {
	const value = stringArgument(args, 'audience', 16, false);
	if (value === undefined) return undefined;
	if (value !== 'user' && value !== 'developer') {
		throw new ToolError('"audience" must be "user" or "developer".');
	}
	return AUDIENCE_MASK[value];
}

// ---------------------------------------------------------------------------
// What the tools return
// ---------------------------------------------------------------------------

interface DocsSummary {
	home: string;
	llms: string;
	llmsFull: string;
	version: string;
	updatedAt: string;
	pages: number;
	languages: Locale[];
}

interface AppSummary {
	id: string;
	name: string;
	hasDocs: boolean;
	[field: string]: unknown;
}

const STRING = { type: 'string' } as const;

const APP_SCHEMA = {
	type: 'object',
	required: ['id', 'name', 'hasDocs'],
	properties: {
		id: { type: 'string', description: 'The name to pass as "app" to the other tools.' },
		name: STRING,
		description: STRING,
		publisher: {
			type: 'object',
			required: ['name', 'url'],
			properties: { name: STRING, url: STRING, legalName: STRING },
		},
		platforms: {
			type: 'array',
			items: {
				type: 'object',
				required: ['name'],
				properties: { name: STRING, minimumOs: STRING },
			},
		},
		pricing: {
			type: 'object',
			required: ['model'],
			properties: { model: STRING, prices: { type: 'array', items: STRING } },
		},
		status: { type: 'string', enum: [...APP_STATUSES] },
		productUrl: STRING,
		privacyUrl: STRING,
		appStoreUrl: STRING,
		llmsUrl: STRING,
		hasDocs: { type: 'boolean' },
		docs: {
			type: 'object',
			required: ['home', 'llms', 'llmsFull', 'version', 'updatedAt', 'pages', 'languages'],
			properties: {
				home: STRING,
				llms: STRING,
				llmsFull: STRING,
				version: STRING,
				updatedAt: STRING,
				pages: { type: 'integer' },
				languages: { type: 'array', items: STRING },
			},
		},
	},
} as const;

const PAGE_ENTRY_SCHEMA = {
	type: 'object',
	required: ['slug', 'title', 'description', 'url', 'markdownUrl', 'audience'],
	properties: {
		slug: STRING,
		title: STRING,
		description: STRING,
		url: STRING,
		markdownUrl: STRING,
		audience: { type: 'string', enum: ['user', 'developer', 'both'] },
	},
} as const;

/** The served bundle for an entry, or the tool error a missing or broken one is. */
function servedOf(library: AgentLibrary, entry: Entry): Served {
	const site = entry.site;
	if (site === undefined) {
		// An entry with no site came from the host's catalogue, which always carries its facts.
		throw new ToolError(
			`${(entry.facts as DocsAppFacts).name} has no documentation on this site yet.`,
		);
	}
	const bundle = library.bundleFor(site);
	if (!bundle.ok) throw new Unavailable(bundle.message);
	return { site, bundle };
}

async function summaryOf(library: AgentLibrary, entry: Entry): Promise<AppSummary> {
	const origin = library.options.origin;
	const facts = entry.facts;
	if (entry.site === undefined) {
		return { id: entry.id, ...(facts as DocsAppFacts), hasDocs: false };
	}
	const served = servedOf(library, entry);
	const { manifest, label } = served.bundle;
	const docs: DocsSummary = {
		home: pageUrl(origin, served, 'en', 'index'),
		llms: machineUrl(origin, served, 'en', 'llms.txt'),
		llmsFull: machineUrl(origin, served, 'en', 'llms-full.txt'),
		version: label,
		updatedAt: newestUpdate(manifest),
		pages: Object.keys(manifest.pages).length,
		languages: [...manifest.locales],
	};
	return {
		id: entry.id,
		...(facts ?? { name: await library.productName(served) }),
		llmsUrl: docs.llms,
		hasDocs: true,
		docs,
	};
}

function summaryText(app: AppSummary): string {
	const known = app as AppSummary & Partial<DocsAppFacts> & { docs?: DocsSummary };
	const lines = [`## ${app.name} (app: ${app.id})`, ''];
	if (known.publisher !== undefined) {
		lines.push((known as DocsAppFacts).description, '', ...factLines(known as DocsAppFacts));
	}
	lines.push(
		known.docs === undefined
			? '- Documentation: none on this site yet'
			: `- Documentation: ${known.docs.home}, version ${known.docs.version}, ${known.docs.pages} pages, updated ${isoDate(known.docs.updatedAt)}. Index for agents: ${known.docs.llms}`,
	);
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface Hit {
	app: string;
	slug: string;
	title: string;
	heading: string;
	anchor: string;
	url: string;
	markdownUrl: string;
	snippet: string;
	score: number;
}

/**
 * The words under one heading, from the compiled page, cut to a snippet.
 *
 * Sections are split the way the compiler splits them for the index, on top-level headings, so
 * the snippet is the text the hit was scored on. Code is left out, because a snippet is for
 * deciding whether to open the page and a line of code says less there than the prose around it.
 */
function snippetOf(page: CompiledPage, anchor: string, locale: Locale): string {
	const blocks: Block[] = [];
	let inside = anchor === PAGE_ROOT_ANCHOR;
	for (const block of page.body) {
		if (block.type === 'heading') {
			if (inside) break;
			inside = block.id === anchor;
			continue;
		}
		if (inside) blocks.push(block);
	}
	const text = blockText(blocks, { status: (value) => statusLabel(locale, value) })
		.replace(/\s+/g, ' ')
		.trim();
	if (text.length <= SNIPPET_LENGTH) return text;
	const cut = text.slice(0, SNIPPET_LENGTH);
	const space = cut.lastIndexOf(' ');
	return `${space > SNIPPET_LENGTH / 2 ? cut.slice(0, space) : cut}…`;
}

interface SearchInput {
	query: string;
	app?: string;
	lang: Locale;
	audience?: AudienceMask;
	limit: number;
}

function searchInput(args: Json): SearchInput {
	const query = stringArgument(args, 'query', 200, true);
	const app = stringArgument(args, 'app', 100, false);
	const lang = languageArgument(args);
	const audience = audienceArgument(args);
	return {
		query,
		...(app === undefined ? {} : { app }),
		lang,
		...(audience === undefined ? {} : { audience }),
		limit: integerArgument(args, 'limit', 1, MAX_SEARCH_LIMIT) ?? DEFAULT_SEARCH_LIMIT,
	};
}

async function runSearch(
	library: AgentLibrary,
	entries: readonly Entry[],
	input: SearchInput,
): Promise<Hit[]> {
	const chosen =
		input.app === undefined
			? entries.filter((entry) => entry.site !== undefined)
			: [findApp(entries, input.app)];
	const origin = library.options.origin;
	const hits: Hit[] = [];
	for (const entry of chosen) {
		const served = servedOf(library, entry);
		const { manifest } = served.bundle;
		const indexLocale =
			manifest.search[input.lang] === undefined ? manifest.sourceLocale : input.lang;
		const loaded = await library.searchIndex(served, indexLocale);
		if (!loaded.ok) throw new Unavailable(loaded.message);
		const found = searchIndex(loaded.index, input.query, {
			...(input.audience === undefined ? {} : { audience: input.audience }),
			limit: input.limit,
		});
		for (const hit of found) {
			const { slug, anchor } = hit.doc;
			const record = manifest.pages[slug] as PageRecord;
			const language = servedLocale(record, indexLocale, manifest.sourceLocale);
			const payload = await readObject(served.bundle.files.pages, pageKey(language, slug));
			const fragment = anchor === PAGE_ROOT_ANCHOR ? '' : `#${anchor}`;
			hits.push({
				app: entry.id,
				slug,
				title: hit.doc.title,
				heading: hit.doc.heading,
				anchor,
				url: `${pageUrl(origin, served, input.lang, slug)}${fragment}`,
				markdownUrl: markdownUrl(origin, served, input.lang, slug),
				snippet: looksLikePage(payload) ? snippetOf(payload, anchor, language) : '',
				score: Math.round(hit.score * 1000) / 1000,
			});
		}
	}
	// Score, then address by code unit, so equal scores come out in one order on every runtime.
	hits.sort((a, b) => b.score - a.score || Number(a.url > b.url) - Number(a.url < b.url));
	return hits.slice(0, input.limit);
}

function searchText(query: string, hits: readonly Hit[]): string {
	if (hits.length === 0) return `Nothing in the documentation matches "${query}".`;
	return hits
		.map((hit, at) => {
			const where = hit.heading === '' ? hit.title : `${hit.title}, ${hit.heading}`;
			return `${at + 1}. ${where} (${hit.app})\n   ${hit.url}\n   Markdown: ${hit.markdownUrl}\n   ${hit.snippet}`;
		})
		.join('\n\n');
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

interface ToolResult {
	structured: Json;
	text: string;
}

interface Tool {
	name: string;
	title: string;
	description: string;
	inputSchema: Json;
	outputSchema: Json;
	run(args: unknown, context: { library: AgentLibrary; entries: Entry[] }): Promise<ToolResult>;
}

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const APP_ARGUMENT = {
	type: 'string',
	minLength: 1,
	maxLength: 100,
	description: 'The app, by the id list_apps gives, such as "hex-nfc".',
} as const;

const LANG_ARGUMENT = {
	type: 'string',
	enum: [...LOCALES],
	description:
		'The language to read in. English is the default; a page with no translation is served in English.',
} as const;

const TOOLS: readonly Tool[] = [
	{
		name: 'list_apps',
		title: 'List the apps',
		description:
			'Every app the publisher sells, with its maker, platforms, price, release status, product page and, where it has one, its documentation. Apps without documentation are listed too.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		outputSchema: {
			type: 'object',
			required: ['apps'],
			properties: { apps: { type: 'array', items: APP_SCHEMA } },
		},
		async run(args, { library, entries }) {
			argumentsOf(args, []);
			const apps: AppSummary[] = [];
			for (const entry of entries) apps.push(await summaryOf(library, entry));
			return { structured: { apps }, text: apps.map(summaryText).join('\n\n') };
		},
	},
	{
		name: 'get_app',
		title: 'Describe one app',
		description:
			"One app's facts and the outline of its documentation: every page, under the groups the documentation uses, with its web address and its Markdown address.",
		inputSchema: {
			type: 'object',
			required: ['app'],
			properties: { app: APP_ARGUMENT },
			additionalProperties: false,
		},
		outputSchema: {
			type: 'object',
			required: [...APP_SCHEMA.required],
			properties: {
				...APP_SCHEMA.properties,
				outline: {
					type: 'array',
					items: {
						type: 'object',
						required: ['title', 'pages'],
						properties: { title: STRING, pages: { type: 'array', items: PAGE_ENTRY_SCHEMA } },
					},
				},
			},
		},
		async run(args, { library, entries }) {
			const input = argumentsOf(args, ['app']);
			const entry = findApp(entries, stringArgument(input, 'app', 100, true));
			const summary = await summaryOf(library, entry);
			if (entry.site === undefined) return { structured: summary, text: summaryText(summary) };
			const served = servedOf(library, entry);
			const { manifest } = served.bundle;
			const origin = library.options.origin;
			const pageEntry = (slug: string) => {
				const record = manifest.pages[slug] as PageRecord;
				const { record: served_ } = servedRecord(manifest, record, 'en');
				return {
					slug,
					title: served_.title,
					description: served_.description,
					url: pageUrl(origin, served, 'en', slug),
					markdownUrl: markdownUrl(origin, served, 'en', slug),
					audience: record.audience,
				};
			};
			const shape = outlineOf(manifest, 'en');
			const outline = [
				...shape.sections.map((section) => ({
					title: section.label,
					pages: section.slugs.map(pageEntry),
				})),
				...(shape.optional.length === 0
					? []
					: [{ title: 'Developer documentation', pages: shape.optional.map(pageEntry) }]),
			];
			const text = [
				summaryText(summary),
				...outline.map(
					(section) =>
						`\n### ${section.title}\n\n${section.pages
							.map(
								(page) =>
									`- [${page.title}](${page.url}) (slug: ${page.slug}): ${page.description}`,
							)
							.join('\n')}`,
				),
			].join('\n');
			return { structured: { ...summary, outline }, text };
		},
	},
	{
		name: 'search_docs',
		title: 'Search the documentation',
		description:
			'Finds the sections of the documentation that match a query, best first. Each result carries the page title, the heading, the web address to cite, the Markdown address and a snippet. Read a whole page with get_page.',
		inputSchema: {
			type: 'object',
			required: ['query'],
			properties: {
				query: {
					type: 'string',
					minLength: 1,
					maxLength: 200,
					description: 'The words to look for.',
				},
				app: {
					...APP_ARGUMENT,
					description: 'Search one app only. All documented apps when left out.',
				},
				lang: LANG_ARGUMENT,
				audience: {
					type: 'string',
					enum: ['user', 'developer'],
					description: 'Only the user guide, or only the developer documentation.',
				},
				limit: {
					type: 'integer',
					minimum: 1,
					maximum: MAX_SEARCH_LIMIT,
					description: `How many results, ${DEFAULT_SEARCH_LIMIT} when left out.`,
				},
			},
			additionalProperties: false,
		},
		outputSchema: {
			type: 'object',
			required: ['query', 'language', 'results'],
			properties: {
				query: STRING,
				language: STRING,
				results: {
					type: 'array',
					items: {
						type: 'object',
						required: [
							'app',
							'slug',
							'title',
							'heading',
							'anchor',
							'url',
							'markdownUrl',
							'snippet',
							'score',
						],
						properties: {
							app: STRING,
							slug: STRING,
							title: STRING,
							heading: STRING,
							anchor: STRING,
							url: STRING,
							markdownUrl: STRING,
							snippet: STRING,
							score: { type: 'number' },
						},
					},
				},
			},
		},
		async run(args, { library, entries }) {
			const input = searchInput(argumentsOf(args, ['query', 'app', 'lang', 'audience', 'limit']));
			const hits = await runSearch(library, entries, input);
			return {
				structured: { query: input.query, language: input.lang, results: hits },
				text: searchText(input.query, hits),
			};
		},
	},
	{
		name: 'get_page',
		title: 'Read a page',
		description: `One page of the documentation as Markdown, with a header naming its title, its web address and when it was last updated. Long pages come in windows of ${PAGE_WINDOW} characters: when the result has nextOffset, call again with that offset for the rest.`,
		inputSchema: {
			type: 'object',
			required: ['app', 'slug'],
			properties: {
				app: APP_ARGUMENT,
				slug: {
					type: 'string',
					minLength: 1,
					maxLength: 200,
					description:
						'The page, as get_app or search_docs give it, such as "guide/scan-a-tag". "index" is the documentation home.',
				},
				lang: LANG_ARGUMENT,
				offset: {
					type: 'integer',
					minimum: 0,
					description: 'Where to start reading, from nextOffset.',
				},
			},
			additionalProperties: false,
		},
		outputSchema: {
			type: 'object',
			required: [
				'app',
				'slug',
				'title',
				'language',
				'url',
				'markdownUrl',
				'offset',
				'totalLength',
				'text',
			],
			properties: {
				app: STRING,
				slug: STRING,
				title: STRING,
				language: STRING,
				url: STRING,
				markdownUrl: STRING,
				offset: { type: 'integer' },
				totalLength: { type: 'integer' },
				nextOffset: { type: 'integer' },
				text: STRING,
			},
		},
		async run(args, { library, entries }) {
			const input = argumentsOf(args, ['app', 'slug', 'lang', 'offset']);
			const entry = findApp(entries, stringArgument(input, 'app', 100, true));
			const asked = stringArgument(input, 'slug', 200, true);
			const lang = languageArgument(input);
			const offset = integerArgument(input, 'offset', 0, Number.MAX_SAFE_INTEGER) ?? 0;
			const served = servedOf(library, entry);
			const slug = slugOf(served, asked);
			const facts = entry.facts;
			const page = await pageMarkdown(served, slug, lang, facts, library.options);
			if (!page.ok) {
				throw new Unavailable(
					`The page ${slug} cannot be read: ${page.missing} is missing from this site's build. Run hexdocs prefetch for this site, then rebuild.`,
				);
			}
			const total = page.text.length;
			if (offset > 0 && offset >= total) {
				throw new ToolError(
					`"offset" is past the end of the page, which is ${total} characters long.`,
				);
			}
			const end = windowEnd(page.text, offset);
			const language = page.languages[0] as Locale;
			const record = servedRecord(
				served.bundle.manifest,
				served.bundle.manifest.pages[slug] as PageRecord,
				lang,
			).record;
			const origin = library.options.origin;
			const structured: Json = {
				app: entry.id,
				slug,
				title: record.title,
				language,
				url: pageUrl(origin, served, language, slug),
				markdownUrl: markdownUrl(origin, served, language, slug),
				offset,
				totalLength: total,
				...(end < total ? { nextOffset: end } : {}),
				text: page.text.slice(offset, end),
			};
			const note =
				end < total
					? `\n\n[Characters ${offset} to ${end} of ${total}. Call get_page with offset ${end} for the rest.]`
					: '';
			return { structured, text: `${structured['text'] as string}${note}` };
		},
	},
];

/**
 * The page a slug names, in any of the spellings an agent is likely to write: the wire slug, its
 * address path, either with a leading slash or a `.md`, a retired slug, or nothing for the home.
 */
function slugOf(served: Served, asked: string): string {
	const pages = served.site.pages;
	const cleaned = asked.toLowerCase().replace(/^\/+/, '').replace(/\.md$/, '').replace(/\/+$/, '');
	const candidates = [cleaned === '' ? 'index' : cleaned, `${cleaned}/index`];
	for (const candidate of candidates) {
		if (pages.includes(candidate) && served.bundle.manifest.pages[candidate] !== undefined) {
			return candidate;
		}
	}
	const target = served.site.redirects?.[cleaned];
	if (target !== undefined) return target;
	throw new ToolError(
		`There is no page "${asked}" in this documentation. get_app lists every page.`,
	);
}

/**
 * Where a window ends: at most `PAGE_WINDOW` on from the offset, pulled back to the last line
 * break in its second half so a window ends between lines, and never between the two halves of
 * a surrogate pair, which would put a broken character at the end of one window and the start
 * of the next.
 */
function windowEnd(text: string, offset: number): number {
	let end = Math.min(text.length, offset + PAGE_WINDOW);
	if (end === text.length) return end;
	const line = text.lastIndexOf('\n', end - 1);
	if (line + 1 > offset + PAGE_WINDOW / 2) end = line + 1;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return end;
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

type Id = string | number | null;

interface Answer {
	status: number;
	/** `null` is a 202 with no body. */
	body: Json | null;
}

const answer = (status: number, id: Id, result: Json): Answer => ({
	status,
	body: { jsonrpc: '2.0', id, result },
});

const failure = (status: number, id: Id, code: number, message: string, data?: Json): Answer => ({
	status,
	body: {
		jsonrpc: '2.0',
		id,
		error: { code, message, ...(data === undefined ? {} : { data }) },
	},
});

interface Dispatch {
	library: AgentLibrary;
	host: DocsHostFacts | undefined;
	headers: Headers;
}

function serverInfo(agents: DocsAgentConfig | undefined): Json {
	return {
		name: agents?.name ?? 'hexdocs',
		title: agents?.title ?? 'Documentation',
		version: agents?.version ?? DOCS_AGENT_VERSION,
		...(agents === undefined ? {} : { websiteUrl: agents.website }),
	};
}

function instructions(library: AgentLibrary): string {
	const { agents, licence } = library.options;
	const where = agents === undefined ? '' : ` published on ${agents.website}`;
	const licensed =
		licence === undefined
			? ''
			: ` The documentation is licensed under ${licence.name} (${licence.url}).`;
	return `Read-only documentation for the apps${where}. list_apps names every app with its price, platforms and release status, including apps that have no documentation yet. search_docs finds sections of the documentation, and get_page reads a page as Markdown, in windows. Cite the web addresses the results carry.${licensed}`;
}

function toolList(): Json[] {
	return TOOLS.map((tool) => ({
		name: tool.name,
		title: tool.title,
		description: tool.description,
		inputSchema: tool.inputSchema,
		outputSchema: tool.outputSchema,
		annotations: { title: tool.title, ...READ_ONLY },
	}));
}

type Called = { ok: true; result: Json } | { ok: false; code: number; message: string };

/**
 * A tool call: a result whether the tool succeeded or failed, and a protocol error only for a
 * request that names no tool or a tool that does not exist, which is what every revision says.
 */
async function callTool(params: Json | undefined, context: Dispatch): Promise<Called> {
	const name = params?.['name'];
	if (typeof name !== 'string') {
		return { ok: false, code: RPC.invalidParams, message: 'tools/call needs a tool name.' };
	}
	const tool = TOOLS.find((one) => one.name === name);
	if (tool === undefined) {
		return {
			ok: false,
			code: RPC.invalidParams,
			message: `Unknown tool: ${name}. This server has ${TOOLS.map((one) => one.name).join(', ')}.`,
		};
	}
	try {
		const entries = catalogue(context.library.configs, context.host);
		const result = await tool.run(params?.['arguments'], { library: context.library, entries });
		return {
			ok: true,
			result: {
				content: [{ type: 'text', text: result.text }],
				structuredContent: result.structured,
				isError: false,
			},
		};
	} catch (error) {
		// A tool that refused its arguments, or found an app with no documentation, ran: the
		// model reads the sentence and corrects itself. Reported as a result, as every revision
		// asks, rather than as a protocol error a client may not show the model at all. A
		// structured result is left out, because a client checks one against the output schema.
		return {
			ok: true,
			result: { content: [{ type: 'text', text: (error as Error).message }], isError: true },
		};
	}
}

async function legacy(
	method: string,
	id: Id,
	params: Json | undefined,
	context: Dispatch,
): Promise<Answer> {
	const header = context.headers.get('MCP-Protocol-Version');
	if (header !== null && !(LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(header)) {
		return failure(
			400,
			id,
			RPC.invalidRequest,
			`Unsupported protocol version ${header}. This server speaks ${ALL_VERSIONS.join(', ')}.`,
		);
	}
	if (method === 'initialize') {
		const asked = params?.['protocolVersion'];
		const version =
			typeof asked === 'string' && (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
				? asked
				: LEGACY_PROTOCOL_VERSIONS[0];
		return answer(200, id, {
			protocolVersion: version,
			capabilities: { tools: {} },
			serverInfo: serverInfo(context.library.options.agents),
			instructions: instructions(context.library),
		});
	}
	if (method === 'ping') return answer(200, id, {});
	if (method === 'tools/list') return answer(200, id, { tools: toolList() });
	if (method === 'tools/call') {
		const called = await callTool(params, context);
		return called.ok
			? answer(200, id, called.result)
			: failure(200, id, called.code, called.message);
	}
	return failure(200, id, RPC.methodNotFound, `This server does not implement "${method}".`);
}

async function modern(
	method: string,
	id: Id,
	params: Json | undefined,
	context: Dispatch,
): Promise<Answer> {
	const meta = isObject(params?.['_meta']) ? (params?.['_meta'] as Json) : {};
	const version = meta[META_VERSION];
	if (typeof version !== 'string') {
		return failure(400, id, RPC.invalidParams, `The request has no _meta "${META_VERSION}".`);
	}
	if (!(MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
		return failure(400, id, RPC.unsupportedVersion, 'Unsupported protocol version', {
			supported: ALL_VERSIONS,
			requested: version,
		});
	}
	if (!isObject(meta[META_CAPABILITIES])) {
		return failure(400, id, RPC.invalidParams, `The request has no _meta "${META_CAPABILITIES}".`);
	}
	const headers = context.headers;
	const mismatch = (header: string, expected: string): Answer =>
		failure(
			400,
			id,
			RPC.headerMismatch,
			`Header mismatch: ${header} is ${JSON.stringify(headers.get(header))} and the body says ${JSON.stringify(expected)}.`,
		);
	if (headers.get('MCP-Protocol-Version') !== version)
		return mismatch('MCP-Protocol-Version', version);
	if (headers.get('Mcp-Method') !== method) return mismatch('Mcp-Method', method);
	if (method === 'tools/call') {
		const name = String(params?.['name']);
		if (headerValue(headers.get('Mcp-Name')) !== name) return mismatch('Mcp-Name', name);
	}

	const complete = (result: Json): Json => ({
		resultType: 'complete',
		...result,
		_meta: { [META_SERVER]: serverInfo(context.library.options.agents) },
	});
	const cached = { ttlMs: 3_600_000, cacheScope: 'public' };
	if (method === 'server/discover') {
		return answer(
			200,
			id,
			complete({
				supportedVersions: ALL_VERSIONS,
				capabilities: { tools: {} },
				instructions: instructions(context.library),
				...cached,
			}),
		);
	}
	if (method === 'ping') return answer(200, id, complete({}));
	if (method === 'tools/list') return answer(200, id, complete({ tools: toolList(), ...cached }));
	if (method === 'tools/call') {
		const called = await callTool(params, context);
		return called.ok
			? answer(200, id, complete(called.result))
			: failure(200, id, called.code, called.message);
	}
	return failure(404, id, RPC.methodNotFound, `This server does not implement "${method}".`);
}

/**
 * One parsed message, answered.
 *
 * Pure but for the tools, so every rule is testable without HTTP. The status travels with the
 * body because the 2026-07-28 binding gives several JSON-RPC errors their own status, and the
 * earlier revisions answer every request with a 200.
 */
export async function dispatch(message: unknown, context: Dispatch): Promise<Answer> {
	// `Array.isArray` first, and not tidiness: a JSON array is a batch, `typeof []` is
	// `'object'`, and without the test an array falls through to the notification arm and is
	// dropped with a 202. Batching left MCP in 2025-06-18; it is refused by name.
	if (Array.isArray(message)) {
		return failure(
			400,
			null,
			RPC.invalidRequest,
			'This server does not accept JSON-RPC batches. Send one message per request.',
		);
	}
	if (!isObject(message) || message['jsonrpc'] !== '2.0') {
		return failure(400, null, RPC.invalidRequest, 'A message must be a JSON-RPC 2.0 object.');
	}
	const method = message['method'];
	const hasId = 'id' in message;
	if (typeof method !== 'string') {
		// A response to a request this server never sent. The earlier revisions say to accept it;
		// there is nothing to do with it.
		if (hasId && ('result' in message || 'error' in message)) return { status: 202, body: null };
		return failure(400, null, RPC.invalidRequest, 'A request must carry a method.');
	}
	// No id is a notification, which is never answered.
	if (!hasId) return { status: 202, body: null };
	const id = message['id'];
	if (!(typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id)))) {
		return failure(400, null, RPC.invalidRequest, 'A request id must be a string or an integer.');
	}
	const raw = message['params'];
	if (raw !== undefined && !isObject(raw)) {
		return failure(400, id, RPC.invalidParams, 'params must be an object.');
	}
	const params = raw as Json | undefined;
	const meta = params?.['_meta'];
	const header = context.headers.get('MCP-Protocol-Version');
	const isModern =
		method !== 'initialize' &&
		((isObject(meta) && META_VERSION in meta) ||
			(header !== null && (MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(header)));
	return isModern ? modern(method, id, params, context) : legacy(method, id, params, context);
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

const CORS = { 'Access-Control-Allow-Origin': '*' };

export function createAgents(
	library: AgentLibrary,
	limits: { mcp: RateLimit; search: RateLimit; clock: () => number },
): DocsAgents {
	const mcpLimit = tokenBuckets(limits.mcp, limits.clock);
	const searchLimit = tokenBuckets(limits.search, limits.clock);

	const json = (status: number, body: Json, headers: Record<string, string> = {}): Response =>
		new Response(JSON.stringify(body), {
			status,
			headers: {
				'Content-Type': 'application/json',
				'X-Content-Type-Options': 'nosniff',
				'Cache-Control': 'no-store',
				...headers,
			},
		});

	/** A public JSON body with a strong validator, or the 304 its validator earned. */
	const cacheable = async (
		request: Request,
		body: Json,
		type: string,
		headers: Record<string, string>,
	): Promise<Response> => {
		const text = JSON.stringify(body);
		const etag = await etagOf(text);
		const out = {
			'Content-Type': type,
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'public, max-age=3600',
			ETag: etag,
			...headers,
		};
		if (notModified(request.headers, etag))
			return new Response(null, { status: 304, headers: out });
		return new Response(text, { status: 200, headers: out });
	};

	return {
		async mcp(request, host) {
			if (request.method !== 'POST') {
				return plain(
					405,
					'The MCP endpoint answers POST only. There are no sessions and no stream to open.',
					{
						Allow: 'POST',
					},
				);
			}
			const broken = library.broken();
			if (broken !== undefined) return plain(500, broken);
			const origin = request.headers.get('Origin');
			if (origin !== null && origin !== library.options.origin) {
				return plain(
					403,
					`Requests from ${origin} are not accepted. This server is for agents, not for pages on other sites.`,
				);
			}
			const wait = mcpLimit(clientKey(request.headers));
			if (wait > 0) {
				return plain(429, 'Too many requests. Wait and try again.', {
					'Retry-After': String(wait),
				});
			}
			if (mediaType(request.headers.get('Content-Type')) !== 'application/json') {
				return plain(415, 'Send the JSON-RPC message with Content-Type: application/json.');
			}
			if (!acceptsJson(request.headers.get('Accept'))) {
				return plain(406, 'This server answers with application/json. Include it in Accept.');
			}
			const body = await readBody(request);
			if (!body.ok) {
				return body.status === 413
					? plain(413, `A message may be at most ${MAX_REQUEST_BYTES} bytes.`)
					: json(400, failure(400, null, RPC.parseError, 'The body is not UTF-8.').body as Json);
			}
			let message: unknown;
			try {
				message = JSON.parse(body.text);
			} catch {
				return json(400, failure(400, null, RPC.parseError, 'The body is not JSON.').body as Json);
			}
			const reply = await dispatch(message, { library, host, headers: request.headers });
			if (reply.body === null) {
				return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
			}
			return json(reply.status, reply.body);
		},

		async search(request, host) {
			const cors = {
				...CORS,
				'Access-Control-Allow-Methods': 'GET, HEAD',
				'Access-Control-Allow-Headers': 'If-None-Match',
			};
			if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				return plain(405, 'The search answers GET only.', { Allow: 'GET, HEAD, OPTIONS', ...CORS });
			}
			const broken = library.broken();
			if (broken !== undefined) return plain(500, broken, CORS);
			const wait = searchLimit(clientKey(request.headers));
			if (wait > 0) {
				return json(
					429,
					{ error: 'Too many requests. Wait and try again.' },
					{ ...CORS, 'Retry-After': String(wait) },
				);
			}
			const query = new URL(request.url).searchParams;
			const args: Json = {};
			for (const name of ['q', 'app', 'lang', 'audience', 'limit']) {
				const value = query.get(name);
				if (value === null) continue;
				args[name === 'q' ? 'query' : name] =
					name === 'limit' && /^\d+$/.test(value) ? Number(value) : value;
			}
			let input: SearchInput;
			let hits: Hit[];
			try {
				input = searchInput(args);
				hits = await runSearch(library, catalogue(library.configs, host), input);
			} catch (error) {
				if (!(error instanceof ToolError)) throw error;
				// The JSON names the parameter as the URL spells it.
				const message = error.message.replace('"query"', '"q"');
				return json(error instanceof Unavailable ? 500 : 400, { error: message }, CORS);
			}
			return cacheable(
				request,
				{ query: input.query, language: input.lang, results: hits },
				'application/json; charset=utf-8',
				{ ...CORS, 'Content-Signal': CONTENT_SIGNAL, 'X-Robots-Tag': 'noindex' },
			);
		},

		async serverCard(request) {
			const cors = {
				...CORS,
				'Access-Control-Allow-Methods': 'GET',
				'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
				'Access-Control-Expose-Headers': 'ETag',
			};
			if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				return plain(405, 'The Server Card answers GET only.', {
					Allow: 'GET, HEAD, OPTIONS',
					...cors,
				});
			}
			const { agents, origin } = library.options;
			const problems = [
				library.broken(),
				agents === undefined
					? 'docsServer was given no agents option, so there is no server to describe.'
					: undefined,
				origin === undefined
					? 'docsServer was given no origin, and a Server Card needs the absolute address of the MCP endpoint.'
					: undefined,
				agents !== undefined && !/^[^/]+\/[^/]+$/.test(agents.name)
					? `The agents name "${agents.name}" must be reverse-DNS with exactly one slash, such as "com.example/docs".`
					: undefined,
				agents !== undefined && (agents.description.length < 1 || agents.description.length > 100)
					? 'The agents description must be 1 to 100 characters, which is the Server Card limit.'
					: undefined,
			].filter((problem): problem is string => problem !== undefined);
			if (problems.length > 0) return plain(500, problems.join(' '), cors);
			const config = agents as DocsAgentConfig;
			const card = {
				$schema: SERVER_CARD_SCHEMA,
				name: config.name,
				version: config.version ?? DOCS_AGENT_VERSION,
				title: config.title,
				description: config.description,
				websiteUrl: config.website,
				remotes: [
					{
						type: 'streamable-http',
						url: endpointUrl(origin, config.mcp),
						supportedProtocolVersions: ALL_VERSIONS,
					},
				],
			};
			return cacheable(request, card, 'application/mcp-server-card+json', cors);
		},
	};
}
