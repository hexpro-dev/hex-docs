/**
 * The text an agent reads: `llms.txt`, `llms-full.txt` and each page's markdown, composed at
 * request time from the prefetched bundle and what the host knows about the app, plus the
 * HTTP every one of them is served with.
 *
 * Composed here rather than in the compiler, and that decides when a change reaches the live
 * site. A serve-time change ships with one gitlink bump in the consuming site and fixes the
 * bundle that is already published; a compile-time change needs every app repository bumped,
 * a republish and a relabel. Everything below is derivable from the manifest, the raw
 * markdown and the host's own facts, so it belongs at serve time.
 *
 * ## Two shapes, and the option that chooses between them
 *
 * With no `origin`, every body is what it was before this module existed: the compiled
 * `llms.txt`, the raw markdown with root-relative links, and `llms-full.txt` as the pages
 * joined by a blank line. kcalc passes nothing and has to keep serving exactly that. With an
 * `origin`, every link is absolute, each page carries a front matter header naming its
 * canonical address, and `llms-full.txt` gains a preamble and a delimiter per page. A
 * relative link inside a file somebody pasted into a chat resolves against nothing, which is
 * why the absolute form is the one worth having, and why it needs the one value this module
 * cannot work out: behind the deploy's tunnel `request.url` says `http://`.
 *
 * `llms.txt` is composed whenever the host describes the app, origin or not, because the
 * compiled file describes the docs home rather than the app and an agent recommending the app
 * needs who makes it, what it costs, what it runs on and where to get it. Without a
 * description the compiled file is served, with its links made absolute when they can be.
 *
 * ## The llms.txt convention, followed to the letter
 *
 * llmstxt.org: an H1 with the name, a blockquote summary, any markdown that is not a heading,
 * then H2 sections whose lists are `- [name](url): notes`. A section named `Optional` holds
 * what an agent with a short context may skip. Developer pages go there, and so do the
 * addresses of the full text and the agent interface, which repeat what the rest of the file
 * already points at. The licence is a fact, so it is stated in the facts block as well, where
 * nothing marks it skippable.
 */

import type { LocalisedLabel } from '../contracts/frontmatter.js';
import type { DocsAgentConfig, DocsAppFacts, DocsLicence } from '../contracts/host.js';
import { LOCALES, type Locale } from '../contracts/locales.js';
import {
	llmsKey,
	RAW_ASSET_LINK,
	RAW_PAGE_LINK,
	rawKey,
	type BundleManifest,
	type PageLocaleRecord,
	type PageRecord,
} from '../contracts/manifest.js';
import type { DocsSiteConfig } from '../contracts/site.js';
import { docsHref, docsRawHref } from './address.js';
import { readText, stored, type Bundle } from './bundle.js';
import { servedLocale } from './route.js';

export const PLAIN_TEXT = 'text/plain; charset=utf-8';
export const MARKDOWN = 'text/markdown; charset=utf-8';

/**
 * Every use is allowed. `Content-Signal` is the Cloudflare and IETF aipref vocabulary, and the
 * same line sits in both sites' `robots.txt`; on a response it states the preference for that
 * one body, which is what a crawler that never reads `robots.txt` can still see.
 */
export const CONTENT_SIGNAL = 'search=yes, ai-input=yes, ai-train=yes';

/**
 * An hour. Machine text changes only on a deploy, which is a relabel or a site change, and an
 * hour is how long a crawler may keep a copy older than the deploy. The validators below make
 * the refetch after it cost a 304. Nothing here is cached at the edge, because neither `.txt`
 * nor `.md` is in Cloudflare's default cached extensions and the consuming site sets no rule.
 */
export const MACHINE_CACHE_CONTROL = 'public, max-age=3600';

/** The options that change what machine text says, resolved once by `docsServer`. */
export interface MachineOptions {
	origin?: string;
	licence?: DocsLicence;
	agents?: DocsAgentConfig;
}

/** One served bundle and the site it is mounted at. */
export interface Served {
	site: DocsSiteConfig;
	bundle: Bundle & { ok: true };
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** A page's HTML address, absolute when the origin is known. */
export function pageUrl(origin: string | undefined, served: Served, locale: Locale, slug: string) {
	return `${origin ?? ''}${docsHref({ basePath: served.site.basePath, locale, slug })}`;
}

/** A page's markdown address, absolute when the origin is known. */
export function markdownUrl(
	origin: string | undefined,
	served: Served,
	locale: Locale,
	slug: string,
): string {
	return `${origin ?? ''}${docsRawHref({ basePath: served.site.basePath, locale, slug })}`;
}

/** `llms.txt` or `llms-full.txt` for a mount, absolute when the origin is known. */
export function machineUrl(
	origin: string | undefined,
	served: Served,
	locale: Locale,
	leaf: 'llms.txt' | 'llms-full.txt',
): string {
	return `${origin ?? ''}${docsHref({ basePath: served.site.basePath, locale, slug: 'index' })}/${leaf}`;
}

/** A host path made absolute, or a URL the host already wrote absolute, as it is. */
export function endpointUrl(origin: string | undefined, path: string): string {
	return path.startsWith('/') ? `${origin ?? ''}${path}` : path;
}

/**
 * The compiler's link tokens, made into addresses.
 *
 * `RAW_PAGE_LINK` becomes `<origin><locale prefix><basePath>/`, so a link in a Japanese body
 * goes to the Japanese raw address, which falls back per page by itself. `RAW_ASSET_LINK`
 * becomes the bundle's public asset directory. The match includes the `](` in front of the
 * prefix, so prose that mentions the scheme is left as written.
 */
export function resolveLinks(
	text: string,
	served: Served,
	locale: Locale,
	origin: string | undefined,
): string {
	const pagePrefix = `${origin ?? ''}${docsHref({ basePath: served.site.basePath, locale, slug: 'index' })}`;
	return text
		.replaceAll(`](${RAW_PAGE_LINK}`, `](${pagePrefix}/`)
		.replaceAll(`](${RAW_ASSET_LINK}`, `](${origin ?? ''}${served.bundle.bundleBase}/assets/`);
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

/**
 * A YAML scalar that cannot be misread.
 *
 * Always double quoted, through `JSON.stringify`, because a JSON string is a YAML double-quoted
 * scalar: every character that means something in YAML is either inside the quotes or escaped.
 * Titles carry colons, descriptions carry `#`, and a Japanese title can begin with a bracket,
 * each of which a hand-written quoting rule eventually misses.
 */
export function yamlString(value: string): string {
	return JSON.stringify(value);
}

/** A front matter block, with every absent field left out rather than written empty. */
export function frontMatter(fields: readonly (readonly [string, string | undefined])[]): string {
	const lines = fields
		.filter((field): field is readonly [string, string] => field[1] !== undefined)
		.map(([key, value]) => `${key}: ${yamlString(value)}`);
	return `---\n${lines.join('\n')}\n---\n`;
}

/** The date part of a stored timestamp. */
export function isoDate(timestamp: string): string {
	return timestamp.slice(0, 10);
}

/** The newest `updatedAt` any page carries in any locale. */
export function newestUpdate(manifest: BundleManifest): string {
	let newest = manifest.commitTimestamp;
	for (const page of Object.values(manifest.pages)) {
		for (const record of Object.values(page.locales)) {
			if (record.updatedAt > newest) newest = record.updatedAt;
		}
	}
	return newest;
}

/** The record a reader at `locale` is served, which is the source's when theirs is absent. */
export function servedRecord(
	manifest: BundleManifest,
	record: PageRecord,
	locale: Locale,
): { locale: Locale; record: PageLocaleRecord } {
	const served = servedLocale(record, locale, manifest.sourceLocale);
	return { locale: served, record: record.locales[served] as PageLocaleRecord };
}

/** A blockquote of any text, each line quoted, so a two-line description stays inside it. */
function quote(text: string): string {
	return text
		.trim()
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n');
}

// ---------------------------------------------------------------------------
// The outline: nav groups, in nav order
// ---------------------------------------------------------------------------

export interface OutlineSection {
	/** The group's label, or a section root's title for pages in no group. */
	label: string;
	slugs: string[];
}

export interface Outline {
	sections: OutlineSection[];
	/** Developer pages, which an agent answering a user's question may skip. */
	optional: string[];
}

/**
 * The pages in reading order, under the `nav.json` groups the author wrote.
 *
 * A page in no group sits under its section root's title, or the docs home's for a page at
 * the top, because a heading over a list is what the format has and the sidebar draws the same
 * rows under the same page. Each group or section is one heading even when its pages are not
 * contiguous, which keeps one heading per group, as the sidebar does within a section. Hidden
 * pages are published, so they are listed: hiding keeps a page out of the sidebar and nowhere
 * else, and `llms-full.txt` has always carried them.
 *
 * Developer pages are collected apart, for `## Optional`. `both` is not developer-only, so it
 * stays in the main list.
 */
export function outlineOf(manifest: BundleManifest, locale: Locale): Outline {
	const titleOf = (slug: string): string | undefined => {
		const record = manifest.pages[slug];
		return record === undefined ? undefined : servedRecord(manifest, record, locale).record.title;
	};
	const sections = new Map<string, OutlineSection>();
	const optional: string[] = [];
	for (const node of manifest.nav) {
		const record = manifest.pages[node.slug] as PageRecord;
		if (record.audience === 'developer') {
			optional.push(node.slug);
			continue;
		}
		const group = node.groups?.[0];
		let key: string;
		let label: string;
		if (group !== undefined) {
			key = `group:${group}`;
			// Indexed without a fallback. `validateManifestShape`, which every served bundle has
			// passed, refuses a group a node names with no label and a label missing a language,
			// so a `??` here would be an arm nothing can reach dressed as a guard.
			const labels = manifest.navGroups as Record<string, LocalisedLabel>;
			label = (labels[group] as LocalisedLabel)[locale];
		} else {
			const top = node.slug.indexOf('/');
			const section = top < 0 ? '' : node.slug.slice(0, top);
			key = `section:${section}`;
			// A section with no root page of its own sits under the docs home's title. The
			// compiler requires the home, so that one is not optional.
			label =
				titleOf(`${section === '' ? '' : `${section}/`}index`) ?? (titleOf('index') as string);
		}
		const existing = sections.get(key);
		if (existing === undefined) sections.set(key, { label, slugs: [node.slug] });
		else existing.slugs.push(node.slug);
	}
	return { sections: [...sections.values()], optional };
}

// ---------------------------------------------------------------------------
// The facts block
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<DocsAppFacts['status'], string> = {
	released: 'Released',
	'near-release': 'Near release, and not yet available to download',
	'in-development': 'In development, and not yet available',
};

/** One app's facts as plain lines, in the order an assistant needs them to recommend it. */
export function factLines(facts: DocsAppFacts): string[] {
	const lines: string[] = [];
	const publisher = facts.publisher;
	const maker =
		publisher.legalName === undefined
			? publisher.name
			: `${publisher.name} (${publisher.legalName})`;
	lines.push(`- Maker: ${maker}, ${publisher.url}`);
	if (facts.platforms.length > 0) {
		const platforms = facts.platforms.map((platform) =>
			platform.minimumOs === undefined
				? platform.name
				: `${platform.name} (${platform.minimumOs} or later)`,
		);
		lines.push(`- Platforms: ${platforms.join(', ')}`);
	}
	const prices = facts.pricing.prices ?? [];
	lines.push(
		`- Price: ${facts.pricing.model}${prices.length === 0 ? '' : `. ${prices.join(', ')}`}`,
	);
	lines.push(`- Status: ${STATUS_TEXT[facts.status]}`);
	lines.push(`- Product page: ${facts.productUrl}`);
	if (facts.privacyUrl !== undefined) lines.push(`- Privacy policy: ${facts.privacyUrl}`);
	if (facts.appStoreUrl !== undefined) lines.push(`- App Store: ${facts.appStoreUrl}`);
	return lines;
}

/** `Licence: CC BY 4.0, <url>`, or nothing when the host named no licence. */
function licenceLine(licence: DocsLicence | undefined): string[] {
	return licence === undefined ? [] : [`- Licence: ${licence.name}, ${licence.url}`];
}

// ---------------------------------------------------------------------------
// llms.txt
// ---------------------------------------------------------------------------

/**
 * `llms.txt` for one mount at one address, composed from the app's facts and the outline.
 *
 * Links are absolute with an origin and relative to this file's own address without one,
 * which is what the compiled file has always done: `guide/scan-a-tag.md` from
 * `/ja/hex-nfc/docs/llms.txt` is the Japanese address, and that falls back per page.
 */
export function composeLlms(
	served: Served,
	locale: Locale,
	facts: DocsAppFacts,
	options: MachineOptions,
): string {
	const { manifest, label } = served.bundle;
	const origin = options.origin;
	const link = (slug: string): string =>
		origin === undefined ? `${slug}.md` : markdownUrl(origin, served, locale, slug);
	const entry = (slug: string): string => {
		const { record } = servedRecord(manifest, manifest.pages[slug] as PageRecord, locale);
		return `- [${record.title}](${link(slug)}): ${record.description}`;
	};
	const outline = outlineOf(manifest, locale);

	const lines: string[] = [`# ${facts.name}`, '', quote(facts.description), ''];
	lines.push(...factLines(facts));
	lines.push(
		`- Documentation: version ${label}, updated ${isoDate(newestUpdate(manifest))}, ${Object.keys(manifest.pages).length} pages`,
	);
	lines.push(...licenceLine(options.licence));
	for (const section of outline.sections) {
		lines.push('', `## ${section.label}`, '', ...section.slugs.map(entry));
	}

	const extras: string[] = [
		`- [Full text](${origin === undefined ? 'llms-full.txt' : machineUrl(origin, served, locale, 'llms-full.txt')}): Every page of this documentation in one file, in reading order.`,
	];
	const agents = options.agents;
	if (agents !== undefined) {
		extras.push(
			`- [MCP server](${endpointUrl(origin, agents.mcp)}): Search and read this documentation from an AI agent, over MCP Streamable HTTP, with no sign-in.`,
		);
		if (agents.search !== undefined) {
			extras.push(
				`- [Search](${endpointUrl(origin, agents.search)}?app=${served.site.project}&q=): The same search as JSON. Put the words to look for after q=.`,
			);
		}
	}
	if (options.licence !== undefined) {
		extras.push(
			`- [${options.licence.name}](${options.licence.url}): The licence this documentation is published under.`,
		);
	}
	lines.push('', '## Optional', '', ...outline.optional.map(entry), ...extras);
	return `${lines.join('\n')}\n`;
}

/**
 * The compiled `llms.txt`, with its page links made absolute.
 *
 * Only the links the compiler writes, `](<wire slug>.md)` for a slug the manifest carries,
 * so a slug-shaped string in a description is left alone.
 */
export function absoluteCompiledLlms(
	text: string,
	served: Served,
	locale: Locale,
	origin: string,
): string {
	let out = text;
	for (const slug of Object.keys(served.bundle.manifest.pages)) {
		out = out.replaceAll(`](${slug}.md)`, `](${markdownUrl(origin, served, locale, slug)})`);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Page markdown, and llms-full.txt
// ---------------------------------------------------------------------------

export type Composed =
	| { ok: true; text: string; languages: Locale[]; lastModified: string }
	| { ok: false; missing: string };

/**
 * One page's markdown at one address: the compiled body with its links resolved, and with an
 * origin a front matter header naming the page and its addresses.
 *
 * The header names the page in the locale it is served in, and the canonical address is that
 * locale's HTML page. A Japanese address serving the English fallback therefore points at the
 * English page, which is the page whose words these are, and not at the Japanese address,
 * which is `noindex` and has no canonical of its own.
 */
export async function pageMarkdown(
	served: Served,
	slug: string,
	locale: Locale,
	facts: DocsAppFacts | undefined,
	options: MachineOptions,
): Promise<Composed & { canonical?: string }> {
	const { manifest, label, files } = served.bundle;
	const { locale: language, record } = servedRecord(
		manifest,
		manifest.pages[slug] as PageRecord,
		locale,
	);
	const key = rawKey(language, slug);
	const text = await readText(files, key);
	if (text === undefined) return { ok: false, missing: stored(key) };
	const origin = options.origin;
	const body = resolveLinks(text, served, locale, origin);
	if (origin === undefined) {
		return { ok: true, text: body, languages: [language], lastModified: record.updatedAt };
	}
	const canonical = pageUrl(origin, served, language, slug);
	const header = frontMatter([
		['title', record.title],
		['description', record.description],
		['product', facts?.name],
		['canonical', canonical],
		['markdown', markdownUrl(origin, served, language, slug)],
		['updatedAt', record.updatedAt],
		['version', label],
		['language', language],
		['licence', options.licence?.name],
		['licenceUrl', options.licence?.url],
	]);
	return {
		ok: true,
		text: `${header}\n${body}`,
		languages: [language],
		lastModified: record.updatedAt,
		canonical,
	};
}

/**
 * `llms-full.txt`: every page in `llmsOrder`, each in the locale `servedLocale` picks.
 *
 * Hidden pages included, because a hidden page is published. Without an origin it is the
 * pages joined by one blank line, as before: every page opens with its own `# Title`. With one,
 * a preamble says what the file is, and each page is preceded by a delimiter carrying its
 * title and both of its addresses, so a model holding a passage can say which page it came
 * from and cite the address a person can open.
 *
 * The preamble's date is the labelled commit's, not the time of the request. A body that
 * changed on every request would make its `ETag` useless and every conditional request a
 * full download.
 */
export async function fullText(
	served: Served,
	locale: Locale,
	facts: DocsAppFacts | undefined,
	productName: string,
	options: MachineOptions,
): Promise<Composed> {
	const { manifest, label, files } = served.bundle;
	const origin = options.origin;
	const bodies: string[] = [];
	const languages = new Set<Locale>();
	let lastModified = manifest.commitTimestamp;
	for (const slug of manifest.llmsOrder) {
		const { locale: language, record } = servedRecord(
			manifest,
			manifest.pages[slug] as PageRecord,
			locale,
		);
		const key = rawKey(language, slug);
		const text = await readText(files, key);
		if (text === undefined) return { ok: false, missing: stored(key) };
		languages.add(language);
		if (record.updatedAt > lastModified) lastModified = record.updatedAt;
		const body = resolveLinks(text, served, locale, origin).replace(/\n+$/, '');
		if (origin === undefined) {
			bodies.push(body);
			continue;
		}
		const delimiter = frontMatter([
			['title', record.title],
			['description', record.description],
			['url', pageUrl(origin, served, language, slug)],
			['markdown', markdownUrl(origin, served, language, slug)],
			['updatedAt', record.updatedAt],
			['language', language],
		]);
		bodies.push(`${delimiter}\n${body}`);
	}
	const ordered = LOCALES.filter((one) => languages.has(one));
	if (origin === undefined) {
		return { ok: true, text: `${bodies.join('\n\n')}\n`, languages: ordered, lastModified };
	}

	const home = servedRecord(manifest, manifest.pages['index'] as PageRecord, locale).record;
	const preamble: string[] = [
		`# ${productName} documentation, full text`,
		'',
		quote(facts?.description ?? home.description),
		'',
		`Every page of the ${productName} documentation in one file, in reading order. Each page starts with a block between two lines of three hyphens giving its title, description, web address, Markdown address and the date it was last updated.`,
		'',
		...(facts === undefined ? [] : factLines(facts)),
		`- Documentation: version ${label}, generated from commit ${manifest.commit.slice(0, 7)} of ${isoDate(manifest.commitTimestamp)}, ${manifest.llmsOrder.length} pages`,
		`- Language: ${ordered.join(', ')}`,
		...licenceLine(options.licence),
		`- Index: ${machineUrl(origin, served, locale, 'llms.txt')}`,
	];
	return {
		ok: true,
		text: `${preamble.join('\n')}\n\n${bodies.join('\n\n')}\n`,
		languages: ordered,
		lastModified,
	};
}

/**
 * The product name the compiler wrote as the H1 of the stored `llms.txt`, which is the
 * project config's `productName` and the only place the bundle carries it.
 */
export async function productNameOf(served: Served): Promise<string> {
	const text = await readText(served.bundle.files, llmsKey(served.bundle.manifest.sourceLocale));
	return /^# (.+)$/m.exec(text ?? '')?.[1]?.trim() ?? served.site.project;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * A strong validator over the bytes as served.
 *
 * SHA-256 through Web Crypto, which Node 22 and every browser carry as a global, so this
 * module still imports nothing. Strong, because the bytes are the whole representation: two
 * bodies that differ in one byte are two different files to a model reading them.
 */
export async function etagOf(body: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return `"${hex.slice(0, 32)}"`;
}

/** An HTTP date, from a stored UTC timestamp. */
export function httpDate(timestamp: string): string {
	return new Date(timestamp).toUTCString();
}

/**
 * Whether a conditional request can be answered with 304, by RFC 9110's rules.
 *
 * `If-None-Match` wins outright when it is present, which is what lets a validator the host
 * cannot date, a changed description, still produce a fresh body. The comparison is the weak
 * one, which is the one a GET uses, so a cache that weakened the tag still matches. Without it,
 * `If-Modified-Since` compares whole seconds, because that is all an HTTP date carries, and a
 * body with no `Last-Modified`, a JSON answer, has nothing to compare it with.
 */
export function notModified(headers: Headers, etag: string, lastModified?: string): boolean {
	const match = headers.get('If-None-Match');
	if (match !== null) {
		const tags = match.split(',').map((tag) => tag.trim().replace(/^W\//, ''));
		return tags.includes('*') || tags.includes(etag);
	}
	if (lastModified === undefined) return false;
	const since = Date.parse(headers.get('If-Modified-Since') ?? '');
	if (Number.isNaN(since)) return false;
	return Math.floor(Date.parse(lastModified) / 1000) * 1000 <= since;
}

export interface MachineText {
	body: string;
	type: string;
	languages: readonly Locale[];
	lastModified: string;
	/** A `Link` header, the canonical and the licence for a page's markdown. */
	link?: string;
	/**
	 * `X-Robots-Tag: noindex`, for the two files that repeat the pages, and for a page's
	 * markdown when no origin gives it a canonical to point at instead.
	 */
	noindex: boolean;
}

/**
 * A machine text response, or the 304 a conditional request earned.
 *
 * The 304 carries the same validators and cache policy as the 200 would, as RFC 9110 asks, so
 * a cache refreshing its copy keeps the same headers.
 */
export async function machineResponse(
	text: MachineText,
	headers: Headers | undefined,
): Promise<Response> {
	const etag = await etagOf(text.body);
	const out: Record<string, string> = {
		'Content-Type': text.type,
		'X-Content-Type-Options': 'nosniff',
		'Content-Language': text.languages.join(', '),
		'Content-Signal': CONTENT_SIGNAL,
		'Cache-Control': MACHINE_CACHE_CONTROL,
		ETag: etag,
		'Last-Modified': httpDate(text.lastModified),
	};
	if (text.link !== undefined) out['Link'] = text.link;
	if (text.noindex) out['X-Robots-Tag'] = 'noindex';
	if (headers !== undefined && notModified(headers, etag, text.lastModified)) {
		return new Response(null, { status: 304, headers: out });
	}
	return new Response(text.body, { status: 200, headers: out });
}
