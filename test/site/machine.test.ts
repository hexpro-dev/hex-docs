/**
 * The machine text, composed: `llms.txt`, a page's markdown, `llms-full.txt`, and the HTTP each
 * is served with.
 *
 * `serve.test.ts` drives these through `resource()` the way a consuming site does. This file
 * holds the composition rules themselves, against the compiled fixture corpus, so each rule is
 * stated once with the input that decides it: the llmstxt.org shape, the outline's grouping, the
 * front matter's quoting, and RFC 9110's conditional rules.
 */

import { beforeAll, describe, expect, test } from 'vitest';

import type { DocsAppFacts } from '../../src/contracts/host.js';
import type { BundleManifest, PageRecord } from '../../src/contracts/manifest.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import { checkBundle, indexSources } from '../../src/site/bundle.js';
import {
	absoluteCompiledLlms,
	composeLlms,
	endpointUrl,
	etagOf,
	factLines,
	frontMatter,
	fullText,
	httpDate,
	machineResponse,
	newestUpdate,
	notModified,
	outlineOf,
	pageMarkdown,
	productNameOf,
	yamlString,
	type Served,
} from '../../src/site/machine.js';
import {
	fixtureBundle,
	fixtureSite,
	fixtureSources,
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
};

const FACTS: DocsAppFacts = {
	name: 'Fixture App',
	description: 'Reads and rewrites NFC tags on an iPhone.',
	publisher: { name: 'Example', legalName: 'Example Pty Ltd', url: 'https://example.com' },
	platforms: [{ name: 'iPhone', minimumOs: 'iOS 17' }, { name: 'Mac' }],
	pricing: {
		model: 'Free with an optional subscription',
		prices: ['A$2.99 a month', 'A$24.99 a year'],
	},
	status: 'near-release',
	productUrl: 'https://example.com/fixture-app',
	privacyUrl: 'https://example.com/fixture-app/privacy',
	appStoreUrl: 'https://apps.apple.com/app/id1',
};

let bundle: FixtureBundle;
let site: DocsSiteConfig;
let served: Served;

/** The fixture bundle as the server holds it, optionally with its text glob changed. */
function servedWith(
	text?: (
		current: Record<string, () => Promise<unknown>>,
	) => Record<string, () => Promise<unknown>>,
): Served {
	const sources = fixtureSources(bundle, site);
	const checked = checkBundle(
		site,
		indexSources({ ...sources, text: text === undefined ? sources.text : text(sources.text) }),
	);
	if (!checked.ok) throw new Error(checked.message);
	return { site, bundle: checked };
}

beforeAll(() => {
	bundle = fixtureBundle();
	site = fixtureSite(bundle);
	served = servedWith();
}, 60_000);

describe('small pieces', () => {
	test('a YAML scalar is always double quoted, so nothing in a title can be misread', () => {
		expect(yamlString('Plain')).toBe('"Plain"');
		expect(yamlString('Key: value # not a comment')).toBe('"Key: value # not a comment"');
		expect(yamlString('Say "hi"\nthen go')).toBe('"Say \\"hi\\"\\nthen go"');
		expect(yamlString('［角括弧］から始まる')).toBe('"［角括弧］から始まる"');
	});

	test('front matter leaves an absent field out rather than writing it empty', () => {
		expect(
			frontMatter([
				['title', 'A'],
				['product', undefined],
				['language', 'en'],
			]),
		).toBe('---\ntitle: "A"\nlanguage: "en"\n---\n');
	});

	test('an endpoint path is made absolute with the origin, and an absolute URL is left alone', () => {
		expect(endpointUrl(ORIGIN, '/mcp')).toBe('https://docs.example/mcp');
		expect(endpointUrl(undefined, '/mcp')).toBe('/mcp');
		expect(endpointUrl(ORIGIN, 'https://mcp.example/mcp')).toBe('https://mcp.example/mcp');
	});

	test('the newest update is the newest record in any locale, and never older than the commit', () => {
		expect(newestUpdate(bundle.manifest)).toBe('2026-04-02T10:45:00Z');
		const later: BundleManifest = structuredClone(bundle.manifest);
		(later.pages['guide/first-tag'] as PageRecord).locales.ja!.updatedAt = '2026-09-01T00:00:00Z';
		expect(newestUpdate(later)).toBe('2026-09-01T00:00:00Z');
	});

	test('an HTTP date from a stored timestamp', () => {
		expect(httpDate('2026-04-02T10:45:00Z')).toBe('Thu, 02 Apr 2026 10:45:00 GMT');
	});
});

describe('the facts block', () => {
	test('names the maker with the company behind it, every platform, the prices and the store', () => {
		expect(factLines(FACTS)).toEqual([
			'- Maker: Example (Example Pty Ltd), https://example.com',
			'- Platforms: iPhone (iOS 17 or later), Mac',
			'- Price: Free with an optional subscription. A$2.99 a month, A$24.99 a year',
			'- Status: Near release, and not yet available to download',
			'- Product page: https://example.com/fixture-app',
			'- Privacy policy: https://example.com/fixture-app/privacy',
			'- App Store: https://apps.apple.com/app/id1',
		]);
	});

	test('leaves out what the host did not give, and says each status in words', () => {
		const bare: DocsAppFacts = {
			name: 'Bare',
			description: 'A bare app.',
			publisher: { name: 'Example', url: 'https://example.com' },
			platforms: [],
			pricing: { model: 'Free' },
			status: 'released',
			productUrl: 'https://example.com/bare',
		};
		expect(factLines(bare)).toEqual([
			'- Maker: Example, https://example.com',
			'- Price: Free',
			'- Status: Released',
			'- Product page: https://example.com/bare',
		]);
		expect(
			factLines({ ...bare, status: 'in-development', pricing: { model: 'Free', prices: [] } }),
		).toContain('- Status: In development, and not yet available');
	});
});

describe('the outline', () => {
	test('puts pages under their nav group in nav order, a page in no group under its section, and developer pages apart', () => {
		const outline = outlineOf(bundle.manifest, 'en');
		expect(outline).toEqual({
			sections: [
				{ label: 'Fixture App documentation', slugs: ['index'] },
				{ label: 'Guide', slugs: ['guide/index', 'guide/first-tag', 'guide/troubleshooting'] },
				{ label: 'Reference', slugs: ['reference/index', 'reference/chip-support'] },
			],
			optional: ['reference/api', 'developer/architecture'],
		});
	});

	test("labels in the reader's language, and a page title in the language the page is served in", () => {
		const japanese = outlineOf(bundle.manifest, 'ja');
		expect(japanese.sections.map((section) => section.label)).toEqual([
			bundle.manifest.pages['index']?.locales.ja?.title,
			'ガイド',
			'リファレンス',
		]);
	});

	test('a page in no group sits under its section root, or under the docs home when the section has none', () => {
		const manifest: BundleManifest = structuredClone(bundle.manifest);
		manifest.nav = [
			{ slug: 'index' },
			{ slug: 'guide/first-tag' },
			{ slug: 'reference/chip-support' },
			{ slug: 'guide/troubleshooting' },
		];
		delete manifest.pages['reference/index'];
		expect(outlineOf(manifest, 'en').sections).toEqual([
			{ label: 'Fixture App documentation', slugs: ['index'] },
			{ label: 'Guide', slugs: ['guide/first-tag', 'guide/troubleshooting'] },
			{ label: 'Fixture App documentation', slugs: ['reference/chip-support'] },
		]);
	});
});

describe('llms.txt', () => {
	test('follows llmstxt.org: an H1, a blockquote, facts that are not headings, H2 lists, and Optional last', () => {
		const text = composeLlms(served, 'en', FACTS, {
			origin: ORIGIN,
			licence: LICENCE,
			agents: AGENTS,
		});
		const lines = text.split('\n');
		expect(lines.slice(0, 3)).toEqual(['# Fixture App', '', `> ${FACTS.description}`]);
		const headings = lines.filter((line) => line.startsWith('#'));
		expect(headings).toEqual([
			'# Fixture App',
			'## Fixture App documentation',
			'## Guide',
			'## Reference',
			'## Optional',
		]);
		// Every list line under a heading is `- [name](url): notes`, and every URL is absolute.
		const firstSection = lines.indexOf('## Fixture App documentation');
		const entries = lines.slice(firstSection).filter((line) => line.startsWith('- '));
		for (const entry of entries) expect(entry).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)]+\): \S/);
		expect(text).toContain(
			'- [Scan your first tag](https://docs.example/fixture-app/docs/guide/first-tag.md): ',
		);
		expect(text).toContain('- Documentation: version 1.1.0, updated 2026-04-02, 8 pages');
		expect(text).toContain(`- Licence: CC BY 4.0, ${LICENCE.url}`);
		const optional = text.slice(text.indexOf('## Optional'));
		expect(optional).toContain(
			'[Tag session API](https://docs.example/fixture-app/docs/reference/api.md)',
		);
		expect(optional).toContain('[Full text](https://docs.example/fixture-app/docs/llms-full.txt)');
		expect(optional).toContain('[MCP server](https://docs.example/mcp)');
		expect(optional).toContain(
			'[Search](https://docs.example/docs/search.json?app=fixture-app&q=)',
		);
		expect(optional).toContain(`[CC BY 4.0](${LICENCE.url})`);
		expect(text.endsWith('\n')).toBe(true);
	});

	test('links relative to its own address without an origin, which is what the compiled file does', () => {
		const text = composeLlms(served, 'ja', FACTS, {});
		expect(text).toContain('](guide/first-tag.md): ');
		expect(text).toContain('[Full text](llms-full.txt)');
		expect(text).not.toContain('MCP server');
		expect(text).not.toContain('Licence');
		expect(text).not.toContain('https://docs.example');
	});

	test('names the MCP endpoint without a search link when the host mounts no search', () => {
		const { search: _search, ...withoutSearch } = AGENTS;
		const text = composeLlms(served, 'en', FACTS, { origin: ORIGIN, agents: withoutSearch });
		expect(text).toContain('[MCP server]');
		expect(text).not.toContain('[Search]');
	});

	test('quotes every line of a description that runs over two', () => {
		const text = composeLlms(served, 'en', { ...FACTS, description: 'One line.\nTwo lines.' }, {});
		expect(text.split('\n').slice(2, 4)).toEqual(['> One line.', '> Two lines.']);
	});

	test('the compiled file gets absolute page links and nothing else changes', () => {
		const compiled =
			'# App\n\n- [Home](index.md): about index.md\n- [Tag](guide/first-tag.md): x\n';
		expect(absoluteCompiledLlms(compiled, served, 'ja', ORIGIN)).toBe(
			'# App\n\n- [Home](https://docs.example/ja/fixture-app/docs/index.md): about index.md\n- [Tag](https://docs.example/ja/fixture-app/docs/guide/first-tag.md): x\n',
		);
	});
});

describe('a page as markdown', () => {
	test('without an origin, is the raw body with its links resolved, as before', async () => {
		const page = await pageMarkdown(served, 'guide/first-tag', 'en', FACTS, {});
		expect(page).toEqual({
			ok: true,
			text: bundle.objects
				.get('raw/en/guide/first-tag.md')
				?.replaceAll('](hexdocs:page/', '](/fixture-app/docs/')
				.replaceAll('](hexdocs:asset/', '](/_docs/fixture-app/1.1.0/assets/'),
			languages: ['en'],
			lastModified: '2026-03-15T08:15:00Z',
		});
	});

	test('with an origin, opens with front matter naming the page, the product and both addresses', async () => {
		const page = await pageMarkdown(served, 'guide/first-tag', 'ja', FACTS, {
			origin: ORIGIN,
			licence: LICENCE,
		});
		if (!page.ok) throw new Error('expected a page');
		const record = bundle.manifest.pages['guide/first-tag']?.locales.ja;
		expect(
			page.text.startsWith(
				[
					'---',
					`title: ${JSON.stringify(record?.title)}`,
					`description: ${JSON.stringify(record?.description)}`,
					'product: "Fixture App"',
					'canonical: "https://docs.example/ja/fixture-app/docs/guide/first-tag"',
					'markdown: "https://docs.example/ja/fixture-app/docs/guide/first-tag.md"',
					'updatedAt: "2026-02-10T11:30:00Z"',
					'version: "1.1.0"',
					'language: "ja"',
					'licence: "CC BY 4.0"',
					`licenceUrl: "${LICENCE.url}"`,
					'---',
					'',
					'# ',
				].join('\n'),
			),
		).toBe(true);
		expect(page.canonical).toBe('https://docs.example/ja/fixture-app/docs/guide/first-tag');
		expect(page.text).not.toContain('](/ja/fixture-app');
		expect(page.text).toContain('](https://docs.example/');
	});

	test("a fallback names the source page as canonical, because those are the page's words", async () => {
		const page = await pageMarkdown(served, 'developer/architecture', 'fr', undefined, {
			origin: ORIGIN,
		});
		if (!page.ok) throw new Error('expected a page');
		expect(page.canonical).toBe('https://docs.example/fixture-app/docs/developer/architecture');
		expect(page.languages).toEqual(['en']);
		expect(page.text).not.toContain('product:');
		expect(page.text).not.toContain('licence:');
	});

	test('a raw object the build lacks is named', async () => {
		const broken = servedWith((text) => {
			const copy = { ...text };
			for (const key of Object.keys(copy)) if (key.endsWith('raw/en/index.md')) delete copy[key];
			return copy;
		});
		expect(await pageMarkdown(broken, 'index', 'en', undefined, {})).toEqual({
			ok: false,
			missing: 'raw/en/index.md',
		});
	});
});

describe('llms-full.txt', () => {
	test('without an origin, is the pages joined by a blank line, as before', async () => {
		const full = await fullText(served, 'en', FACTS, 'Fixture App', {});
		if (!full.ok) throw new Error('expected text');
		expect(full.text.startsWith('# Fixture App documentation\n')).toBe(true);
		expect(full.text).not.toContain('\n---\ntitle:');
		expect(full.languages).toEqual(['en']);
		expect(full.lastModified).toBe('2026-04-02T10:45:00Z');
	});

	test('with an origin, opens with a preamble and puts a delimiter carrying both addresses before every page', async () => {
		const full = await fullText(served, 'ja', FACTS, 'Fixture App', {
			origin: ORIGIN,
			licence: LICENCE,
		});
		if (!full.ok) throw new Error('expected text');
		const text = full.text;
		expect(text.split('\n').slice(0, 3)).toEqual([
			'# Fixture App documentation, full text',
			'',
			`> ${FACTS.description}`,
		]);
		expect(text).toContain('- Maker: Example (Example Pty Ltd), https://example.com');
		expect(text).toContain(
			`- Documentation: version 1.1.0, generated from commit ${bundle.manifest.commit.slice(0, 7)} of 2026-04-02, 8 pages`,
		);
		expect(text).toContain('- Language: en, ja');
		expect(text).toContain(`- Licence: CC BY 4.0, ${LICENCE.url}`);
		expect(text).toContain('- Index: https://docs.example/ja/fixture-app/docs/llms.txt');
		// One delimiter per page, in `llmsOrder`, each naming the address of the words under it.
		const delimiters = [...text.matchAll(/^---\ntitle: .*\n(?:.*\n)*?---\n/gm)].map(
			(match) => match[0],
		);
		expect(delimiters.length).toBe(bundle.manifest.llmsOrder.length);
		expect(delimiters[2]).toContain(
			'url: "https://docs.example/ja/fixture-app/docs/guide/first-tag"',
		);
		expect(delimiters[2]).toContain(
			'markdown: "https://docs.example/ja/fixture-app/docs/guide/first-tag.md"',
		);
		expect(delimiters[7]).toContain(
			'url: "https://docs.example/fixture-app/docs/developer/architecture"',
		);
		expect(delimiters[7]).toContain('language: "en"');
	});

	test('describes the docs home when the host described nothing, and leaves the facts out', async () => {
		const full = await fullText(served, 'en', undefined, 'Fixture App', { origin: ORIGIN });
		if (!full.ok) throw new Error('expected text');
		expect(full.text).toContain(`> ${bundle.manifest.pages['index']?.locales.en?.description}`);
		expect(full.text).not.toContain('- Maker:');
		expect(full.text).not.toContain('- Licence:');
	});

	test('dates itself by the newest page when a page is newer than the commit', async () => {
		const later = servedWith();
		const manifest: BundleManifest = structuredClone(later.bundle.manifest);
		(manifest.pages['index'] as PageRecord).locales.en!.updatedAt = '2026-12-01T00:00:00Z';
		const full = await fullText(
			{ site, bundle: { ...later.bundle, manifest } },
			'en',
			undefined,
			'X',
			{},
		);
		expect(full.ok && full.lastModified).toBe('2026-12-01T00:00:00Z');
	});

	test('names the first raw object the build lacks', async () => {
		const broken = servedWith((text) => {
			const copy = { ...text };
			for (const key of Object.keys(copy))
				if (key.endsWith('raw/en/reference/api.md')) delete copy[key];
			return copy;
		});
		expect(await fullText(broken, 'en', undefined, 'X', {})).toEqual({
			ok: false,
			missing: 'raw/en/reference/api.md',
		});
	});
});

describe('the product name', () => {
	test("is the compiled llms.txt's H1, or the project when there is no H1 or no file", async () => {
		expect(await productNameOf(served)).toBe('Fixture App');
		const noHeading = servedWith((text) => {
			const copy = { ...text };
			for (const key of Object.keys(copy))
				if (key.endsWith('llms/en.txt')) copy[key] = async () => 'no heading\n';
			return copy;
		});
		expect(await productNameOf(noHeading)).toBe('fixture-app');
		const noFile = servedWith((text) => {
			const copy = { ...text };
			for (const key of Object.keys(copy)) if (key.endsWith('llms/en.txt')) delete copy[key];
			return copy;
		});
		expect(await productNameOf(noFile)).toBe('fixture-app');
	});
});

describe('HTTP', () => {
	test('the validator is a strong tag over the body, the same for the same bytes and different for different ones', async () => {
		const tag = await etagOf('body');
		expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
		expect(await etagOf('body')).toBe(tag);
		expect(await etagOf('body.')).not.toBe(tag);
	});

	test('If-None-Match wins, compares weakly, and takes a list or a star', () => {
		const at = '2026-04-02T10:45:00Z';
		const headers = (values: Record<string, string>) => new Headers(values);
		expect(notModified(headers({ 'If-None-Match': '"a"' }), '"a"', at)).toBe(true);
		expect(notModified(headers({ 'If-None-Match': 'W/"a"' }), '"a"', at)).toBe(true);
		expect(notModified(headers({ 'If-None-Match': '"b", "a"' }), '"a"', at)).toBe(true);
		expect(notModified(headers({ 'If-None-Match': '*' }), '"a"', at)).toBe(true);
		// A tag that does not match is a full answer even when the date would have matched.
		expect(
			notModified(
				headers({ 'If-None-Match': '"b"', 'If-Modified-Since': httpDate(at) }),
				'"a"',
				at,
			),
		).toBe(false);
	});

	test('If-Modified-Since compares whole seconds, and means nothing unparsed or without a date', () => {
		const at = '2026-04-02T10:45:00Z';
		const since = (value: string) => new Headers({ 'If-Modified-Since': value });
		expect(notModified(since(httpDate(at)), '"a"', at)).toBe(true);
		expect(notModified(since('Fri, 03 Apr 2026 00:00:00 GMT'), '"a"', at)).toBe(true);
		expect(notModified(since('Wed, 01 Apr 2026 00:00:00 GMT'), '"a"', at)).toBe(false);
		expect(notModified(since('yesterday'), '"a"', at)).toBe(false);
		expect(notModified(new Headers(), '"a"', at)).toBe(false);
		expect(notModified(since(httpDate(at)), '"a"')).toBe(false);
	});

	test('a machine response carries every header, and a 304 carries the same ones with no body', async () => {
		const text = {
			body: 'hello\n',
			type: 'text/markdown; charset=utf-8',
			languages: ['en', 'ja'] as const,
			lastModified: '2026-04-02T10:45:00Z',
			link: '<https://docs.example/x>; rel="canonical"',
			noindex: false,
		};
		const full = await machineResponse(text, undefined);
		const headers = Object.fromEntries(full.headers);
		expect(headers).toEqual({
			'content-type': 'text/markdown; charset=utf-8',
			'x-content-type-options': 'nosniff',
			'content-language': 'en, ja',
			'content-signal': 'search=yes, ai-input=yes, ai-train=yes',
			'cache-control': 'public, max-age=3600',
			etag: await etagOf('hello\n'),
			'last-modified': 'Thu, 02 Apr 2026 10:45:00 GMT',
			link: '<https://docs.example/x>; rel="canonical"',
		});
		expect(await full.text()).toBe('hello\n');

		const cached = await machineResponse(
			{ ...text, link: undefined, noindex: true },
			new Headers({ 'If-None-Match': headers['etag'] as string }),
		);
		expect(cached.status).toBe(304);
		expect(cached.body).toBeNull();
		expect(cached.headers.get('ETag')).toBe(headers['etag']);
		expect(cached.headers.get('X-Robots-Tag')).toBe('noindex');
		expect(cached.headers.get('Link')).toBeNull();
	});
});
