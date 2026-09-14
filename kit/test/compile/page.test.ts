/**
 * Compiling one page, and the checks that need more than one.
 *
 * The golden files cover what a page compiles to. This covers the decisions that
 * produced it: which anchor a heading answers to, what reaches the table of contents,
 * what the markdown served at `<slug>.md` looks like, and what the project-level rules
 * say when the tree is wrong. The last of those is tested by breaking a copy of the
 * corpus, because the corpus itself is correct and a rule with only a passing case is a
 * rule nobody has seen work.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus, SITE_ROOT } from '../../../fixtures/index.js';
import { MAX_NAV_DEPTH } from '../../../src/contracts/nav.js';
import type { DocsProjectConfig } from '../../../src/contracts/project.js';
import { buildBundle } from '../../src/compile/build.js';
import { highlight } from '../../src/compile/highlight/index.js';
import {
	compilePage,
	rawDestination,
	rawSnippetBody,
	rewriteDestinations,
} from '../../src/compile/page.js';
import { createImageResolver, createLinkResolver } from '../../src/compile/links.js';
import { RAW_ASSET_LINK, RAW_PAGE_LINK } from '../../../src/contracts/manifest.js';
import { deriveHeadingId, slugifyHeading } from '../../src/compile/markdown/blocks.js';
import type { ParseServices } from '../../src/compile/types.js';

const CONFIG = JSON.parse(readFileSync(join(SITE_ROOT, 'docs.json'), 'utf8')) as DocsProjectConfig;

function services(): ParseServices {
	return {
		highlight,
		resolveLink: (href) => ({
			ok: true,
			link: { type: 'link', kind: 'external', href: `https://example.com/${href}` },
		}),
		resolveImage: () => ({ ok: true, src: `assets/${'b'.repeat(64)}.png`, width: 4, height: 4 }),
		resolveInclude: () => ({
			ok: true,
			blocks: [{ type: 'paragraph', children: [{ type: 'text', value: 'From the snippet.' }] }],
		}),
	};
}

interface CompileOptions {
	config?: DocsProjectConfig;
	sourceHeadingIds?: readonly string[];
	front?: Record<string, string>;
	snippetBodies?: Map<string, string>;
	locale?: 'en' | 'ja';
	services?: ParseServices;
}

function compile(body: string, options: CompileOptions = {}) {
	const front = { title: 'A page', description: 'One sentence.', ...(options.front ?? {}) };
	const text = `---\n${Object.entries(front)
		.map(([key, value]) => `${key}: ${value}`)
		.join('\n')}\n---\n\n${body}\n`;
	const locale = options.locale ?? 'en';
	return compilePage({
		config: options.config ?? CONFIG,
		slug: 'guide/example',
		locale,
		document: {
			file: `content/${locale}/guide/example.md`,
			repoPath: `docs/site/content/${locale}/guide/example.md`,
			locale,
			id: 'guide/example',
			text,
		},
		services: options.services ?? services(),
		translation: { state: 'source', sourceUpdated: '2026-01-05T09:00:00Z' },
		...(options.sourceHeadingIds === undefined
			? {}
			: { sourceHeadingIds: options.sourceHeadingIds }),
		...(options.snippetBodies === undefined ? {} : { snippetBodies: options.snippetBodies }),
	});
}

describe('heading anchors', () => {
	test('an id comes from the heading text, lower cased and hyphenated', () => {
		expect(slugifyHeading('What you need')).toBe('what-you-need');
		expect(slugifyHeading('The `TagSession` type')).toBe('the-tagsession-type');
		expect(slugifyHeading('  Spaces  ')).toBe('spaces');
	});

	test('letters in any script survive, because an id from text is locale-dependent', () => {
		// This is the constraint the corpus disproved: an ASCII-only anchor is not a
		// stricter rule, it is a rule four of the seven languages cannot satisfy.
		expect(slugifyHeading('你需要什么')).toBe('你需要什么');
		expect(slugifyHeading('ガイド')).toBe('ガイド');
	});

	test('a heading of nothing but punctuation still gets an id', () => {
		expect(slugifyHeading('...')).toBe('section');
		expect(slugifyHeading('')).toBe('section');
	});

	test('an explicit id beats every other rule, in either mode', () => {
		expect(deriveHeadingId('Module graph', 'module-graph', 'slug')).toEqual({
			id: 'module-graph',
			source: 'explicit',
		});
		expect(deriveHeadingId('4. Termination', 'clause-four', 'section-number')).toEqual({
			id: 'clause-four',
			source: 'explicit',
		});
	});

	test('a section number wins under a project configured for it', () => {
		expect(deriveHeadingId('4. Termination', undefined, 'section-number')).toEqual({
			id: 'section-4',
			source: 'section-number',
		});
		expect(deriveHeadingId('4.2 Refunds', undefined, 'section-number')).toEqual({
			id: 'section-4-2',
			source: 'section-number',
		});
		// The same heading under the default mode is slugified, which is why the mode is a
		// project decision rather than something derived per heading: a legal document needs
		// one anchor per clause in every language, and a manual does not.
		expect(deriveHeadingId('4. Termination', undefined, 'slug')).toEqual({
			id: '4-termination',
			source: 'slug',
		});
	});

	test('two headings with the same text get numbered ids, in document order', () => {
		const output = compile('## Errors\n\nOne.\n\n## Errors\n\nTwo.\n\n## Errors\n\nThree.');
		expect(output.headings.map((heading) => heading.id)).toEqual([
			'errors',
			'errors-2',
			'errors-3',
		]);
		// Stability is the reason: a deep link pasted into a support reply has to keep
		// working, so the first heading keeps `errors` when a third one is added.
		expect(output.anchors.has('errors')).toBe(true);
	});

	test('a translation answers to the source anchor as well as its own', () => {
		const output = compile('## 你需要什么\n\nText.', {
			sourceHeadingIds: ['what-you-need'],
			locale: 'ja',
		});
		const heading = output.page.body[0];
		expect(heading?.type).toBe('heading');
		if (heading?.type === 'heading') {
			expect(heading.id).toBe('你需要什么');
			expect(heading.aliases).toEqual(['what-you-need']);
		}
		expect(output.anchors.has('what-you-need')).toBe(true);
	});

	test('no alias is assigned when the two pages have different heading counts', () => {
		// A positional match across a structural difference would point a deep link at the
		// wrong section, silently. `heading-set-matches-source` is what reports the
		// difference; this is what stops the compiler papering over it.
		const output = compile('## One\n\nText.\n\n## Two\n\nText.', {
			sourceHeadingIds: ['only-one'],
		});
		for (const heading of output.page.body) {
			if (heading.type === 'heading') expect(heading.aliases).toBeUndefined();
		}
	});

	test('a skipped heading level is reported with a line', () => {
		const output = compile('## Errors\n\nText.\n\n#### Retry\n\nText.');
		const finding = output.findings.find((entry) => entry.rule === 'heading-order');
		expect(finding).toBeDefined();
		// Line 10: four lines of front matter, a blank, then the body. The position is
		// absolute rather than relative to the body, which is what `bodyLine` is for.
		expect(
			'line' in (finding?.location ?? {}) && (finding?.location as { line: number }).line,
		).toBe(10);
	});
});

describe('the table of contents', () => {
	test('it carries every heading down to maxDepth and no deeper', () => {
		const output = compile('## Two\n\nA.\n\n### Three\n\nB.\n\n#### Four\n\nC.');
		expect(output.page.headings.map((entry) => entry.depth)).toEqual([2, 3]);
		// Every heading is still in the manifest record, because heading parity is graded
		// against all of them and an anchor exists whether or not the contents lists it.
		expect(output.headings.map((entry) => entry.depth)).toEqual([2, 3, 4]);
	});

	test('a page with fewer headings than the minimum has no contents', () => {
		expect(compile('## One\n\nA.\n\n## Two\n\nB.').page.toc).toBe(false);
		expect(compile('## One\n\nA.\n\n## Two\n\nB.\n\n## Three\n\nC.').page.toc).toBe(true);
	});

	test('front matter can suppress it and cannot ask for it', () => {
		const body = '## One\n\nA.\n\n## Two\n\nB.\n\n## Three\n\nC.';
		expect(compile(body, { front: { toc: 'false' } }).page.toc).toBe(false);
		// There is no positive spelling on purpose: the project config owns the default, so
		// a page cannot silently agree with a default that later changes.
		expect(compile(body).page.toc).toBe(true);
	});

	test('the contents text is flattened, so a link inside a heading is not a link', () => {
		const output = compile('## The [matrix](chip.md) explained\n\nA.\n\n## B\n\nb.\n\n## C\n\nc.');
		expect(output.page.headings[0]?.text).toBe('The matrix explained');
	});
});

describe('the reading estimate', () => {
	test('it counts prose and not code', () => {
		const prose = compile(`${'word '.repeat(400)}`);
		const withCode = compile(`${'word '.repeat(400)}\n\n\`\`\`text\n${'x '.repeat(400)}\n\`\`\``);
		expect(prose.page.reading.words).toBe(400);
		// A two hundred line listing is not four hundred words of reading, and counting it
		// makes every developer page claim to take twenty minutes.
		expect(withCode.page.reading.words).toBe(prose.page.reading.words);
		expect(withCode.page.reading.minutes).toBe(2);
	});

	test('a page shorter than a minute still reads as one', () => {
		expect(compile('One short line.').page.reading.minutes).toBe(1);
	});
});

describe('the markdown served at <slug>.md', () => {
	test('it carries the title as a heading, because front matter is not published', () => {
		const output = compile('Body text.', { front: { title: 'Scan your first tag' } });
		expect(output.raw.startsWith('# Scan your first tag\n')).toBe(true);
	});

	test('an include is expanded, because a fragment reference is meaningless to a reader', () => {
		const output = compile('Before.\n\n::include[safety-note]\n\nAfter.', {
			snippetBodies: new Map([['safety-note', 'The snippet body.']]),
		});
		expect(output.raw).toContain('The snippet body.');
		expect(output.raw).not.toContain('::include');
	});

	test('a suppression comment never reaches it', () => {
		// The parse strips comments from the tree and this text is built from the source,
		// so it is stripped twice. Without the second one a suppression reaches <slug>.md
		// and llms-full.txt while never appearing in a page payload, which is the half of
		// the leak nobody would think to look for.
		const output = compile(
			'<!-- hexdocs-disable-next-line no-em-dash: quoting the original -->\nA line.',
		);
		expect(output.raw).not.toContain('hexdocs-disable');
		expect(output.parsed.disables.length).toBe(1);
	});
});

describe('where a link in <slug>.md goes', () => {
	const ASSET = `assets/${'c'.repeat(64)}.png`;

	/**
	 * The real resolvers over a small project, so what is rewritten is decided by the same
	 * code that decides it in a build, and the page under test sits two directories down
	 * where a relative path is most obviously wrong from anywhere else.
	 */
	function real(): ParseServices {
		const targets = {
			slugs: new Set(['guide/first-tag', 'guide/troubleshooting', 'reference/chip-support']),
			redirects: new Map([['guide/old-name', 'guide/first-tag']]),
			withheld: new Map(),
			assets: new Map([['assets/scan-screen.png', { src: ASSET, width: 4, height: 4 }]]),
		};
		const file = 'content/en/guide/example.md';
		return {
			highlight,
			resolveLink: createLinkResolver(file, targets),
			resolveImage: createImageResolver(file, targets),
			resolveInclude: () => ({ ok: true, blocks: [] }),
		};
	}

	const rawOf = (body: string): string =>
		compile(body, { services: real() }).raw.split('\n').slice(2).join('\n').trimEnd();

	test('a page link becomes the page token and keeps the anchor the author typed', () => {
		expect(rawOf('See [the matrix](../reference/chip-support.md#ntag-21x).')).toBe(
			`See [the matrix](${RAW_PAGE_LINK}reference/chip-support.md#ntag-21x).`,
		);
	});

	test('only the destination changes: the label, the title and the text around it do not', () => {
		expect(
			rawOf(
				'A *[linked phrase](first-tag.md "The first scan")* and ![a tag](../../../assets/scan-screen.png \'A tag\') here.',
			),
		).toBe(
			`A *[linked phrase](${RAW_PAGE_LINK}guide/first-tag.md "The first scan")* and ![a tag](${RAW_ASSET_LINK}${'c'.repeat(64)}.png 'A tag') here.`,
		);
	});

	test('a link through a redirect goes to the page it redirects to', () => {
		expect(rawOf('[Old](old-name.md)')).toBe(`[Old](${RAW_PAGE_LINK}guide/first-tag.md)`);
	});

	test('the token always follows the paren, whatever the author put between them', () => {
		// A site substitutes on `](` followed by the prefix and on nothing else, so a token
		// behind a kept `<`, a space or a line break is never substituted and reaches a
		// reader as `hexdocs:page/...`. The angle brackets go, the escape in the path goes
		// with the path, and the fragment after it stays exactly as typed, escape included.
		expect(
			rawOf(
				'[One](<first-tag.md#step>), [two](first\\-tag.md\\#step), [three]( <first-tag.md>) and [four](\nfirst-tag.md "T").',
			),
		).toBe(
			`[One](${RAW_PAGE_LINK}guide/first-tag.md#step), [two](${RAW_PAGE_LINK}guide/first-tag.md\\#step), [three](${RAW_PAGE_LINK}guide/first-tag.md) and [four](${RAW_PAGE_LINK}guide/first-tag.md\n "T").`,
		);
	});

	test('a link in a heading, a table cell, a list, a quote and a callout body is rewritten', () => {
		const body = [
			'## See [the fix](troubleshooting.md)',
			'',
			'| Page | Where |',
			'| --- | --- |',
			'| Matrix | [here](../reference/chip-support.md) |',
			'',
			'- A [list item](first-tag.md)',
			'',
			'> A [quote](first-tag.md)',
			'',
			':::note[Read this]',
			'Body and [this](first-tag.md).',
			':::',
		].join('\n');
		const raw = rawOf(body);
		expect(raw).not.toMatch(/\]\((?!hexdocs:)/);
		expect(raw.match(/hexdocs:page\//g)?.length).toBe(5);
	});

	test('external, mailto, same-page and unresolved destinations are left as typed', () => {
		const body =
			'[Site](https://example.com/a.md), [mail](mailto:docs@example.com), [up](#what-you-need) and [gone](nowhere.md).';
		expect(rawOf(body)).toBe(body);
	});

	test('a link written in a code span or a fence is never rewritten', () => {
		// The mutation this holds is a rewrite that reads the lines rather than the parse. A
		// pattern over the text finds `](first-tag.md)` inside backticks as readily as outside
		// them, and a page documenting its own link syntax would then publish a sample that
		// no longer shows what to type.
		const body = [
			'Write `[the guide](first-tag.md)` to link a page, and [this](first-tag.md) is one.',
			'',
			'```markdown',
			'[the guide](first-tag.md)',
			'![a tag](../../../assets/scan-screen.png)',
			'```',
		].join('\n');
		const raw = rawOf(body);
		expect(raw).toContain('`[the guide](first-tag.md)`');
		expect(raw).toContain(
			'\n[the guide](first-tag.md)\n![a tag](../../../assets/scan-screen.png)\n',
		);
		expect(raw).toContain(`[this](${RAW_PAGE_LINK}guide/first-tag.md) is one.`);
	});

	test('a snippet body carries its own rewrites, and its comments are still removed', () => {
		const parsed = compile('Before.\n\n[x](first-tag.md)\n\n<!-- a note -->\nAfter.', {
			services: real(),
		}).parsed;
		expect(
			rawSnippetBody(parsed.frontMatter.body, parsed.frontMatter.bodyLine, parsed.destinations),
		).toBe(`Before.\n\n[x](${RAW_PAGE_LINK}guide/first-tag.md)\n\n\nAfter.`);
	});

	test('the asset token is the bundle filename, not the path the key sits under', () => {
		expect(rawDestination({ kind: 'asset', src: ASSET })).toBe(
			`${RAW_ASSET_LINK}${'c'.repeat(64)}.png`,
		);
		expect(rawDestination({ kind: 'page', slug: 'guide/index' })).toBe(
			`${RAW_PAGE_LINK}guide/index.md`,
		);
	});

	test('a destination folded across a wrap between wide characters is rewritten once', () => {
		// No joiner is inserted between two wide characters, so the path runs on into the
		// next line and has a removal on each. The token goes after the paren and both halves
		// of the path are removed, which keeps the line count.
		const services = real();
		const output = compile('[\u6307\u5357](\u6307\n\u5357.md)', {
			services: {
				...services,
				resolveLink: (href, title) =>
					href === '\u6307\u5357.md'
						? { ok: true, link: { type: 'link', kind: 'internal', slug: 'guide/first-tag' } }
						: services.resolveLink(href, title),
			},
		});
		expect(output.parsed.destinations[0]?.remove.length).toBe(2);
		expect(output.raw.split('\n').slice(2).join('\n').trimEnd()).toBe(
			`[\u6307\u5357](${RAW_PAGE_LINK}guide/first-tag.md\n)`,
		);
	});

	test('an edit that does not fit the text is thrown over rather than applied', () => {
		// Every edit comes from a parse of the same text, so a misfit is a disagreement
		// between the two, and applying it would splice a link into whatever is really there.
		const target = { kind: 'page', slug: 'guide/first-tag' } as const;
		const token = `${RAW_PAGE_LINK}guide/first-tag.md`;
		const at = (column: number, remove: [number, number][], line = 1) => ({
			at: { line, column },
			remove: remove.map(([from, length]) => ({ line, column: from, length })),
			target,
		});
		expect(() => rewriteDestinations('short', 1, [at(3, [[3, 9]])])).toThrow(/does not fit/);
		expect(() => rewriteDestinations('short', 1, [at(1, [[1, 1]], 2)])).toThrow(/does not fit/);
		expect(() => rewriteDestinations('short', 1, [at(7, [])])).toThrow(/does not fit/);
		expect(() => rewriteDestinations('abcdefgh', 1, [at(1, [[1, 4]]), at(3, [[3, 4]])])).toThrow(
			/does not fit/,
		);
		// At one column the removal runs first, so the token is not removed with the path.
		expect(rewriteDestinations('(ab) (cd)', 1, [at(2, [[2, 2]]), at(7, [[7, 2]])])).toBe(
			`(${token}) (${token})`,
		);
	});
});

describe('the rules that need the whole project', () => {
	let root: string;
	let repo: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'hexdocs-project-rules-'));
		repo = materialiseCorpus(join(root, 'repo')).root;
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** Rebuilds the corpus with `nav.json` replaced, so a nav rule has a failing case. */
	function withNav(mutate: (nav: Record<string, unknown>) => void) {
		const path = join(repo, 'docs', 'site', 'nav.json');
		const original = readFileSync(path, 'utf8');
		try {
			const nav = JSON.parse(original) as Record<string, unknown>;
			mutate(nav);
			writeFileSync(path, JSON.stringify(nav, null, '\t'), 'utf8');
			return buildBundle(repo, { generator: '@hex-pro/docs-kit@0.1.0' });
		} finally {
			writeFileSync(path, original, 'utf8');
		}
	}

	test('a page missing from the nav is an orphan', () => {
		const result = withNav((nav) => {
			nav.items = (nav.items as unknown[]).filter(
				(item) => (item as { doc?: string }).doc !== 'index',
			);
		});
		const orphans = result.lint.envelope.findings.filter((entry) => entry.rule === 'orphan-page');
		expect(orphans.length).toBe(1);
		expect(orphans[0]?.message).toContain('index');
	});

	test('the same page twice in the nav is a duplicate', () => {
		const result = withNav((nav) => {
			nav.items = [...(nav.items as unknown[]), { doc: 'index' }];
		});
		const duplicates = result.lint.envelope.findings.filter(
			(entry) => entry.rule === 'nav-duplicate',
		);
		expect(duplicates.length).toBe(1);
		expect(duplicates[0]?.excerpt).toBe('index');
	});

	test('a nav entry naming no page is reported as a link that does not resolve', () => {
		const result = withNav((nav) => {
			nav.items = [...(nav.items as unknown[]), { doc: 'guide/nowhere' }];
		});
		const dead = result.lint.envelope.findings.filter(
			(entry) => entry.rule === 'link-resolves' && entry.excerpt === 'guide/nowhere',
		);
		expect(dead.length).toBe(1);
	});

	test('a fourth level of groups is over the depth limit', () => {
		const result = withNav((nav) => {
			const label = {
				en: 'Deep',
				zh: 'Deep',
				ar: 'Deep',
				es: 'Deep',
				ja: 'Deep',
				fr: 'Deep',
				'pt-BR': 'Deep',
			};
			nav.items = [
				...(nav.items as unknown[]),
				{
					group: 'a',
					label,
					items: [
						{
							group: 'b',
							label,
							items: [
								{ group: 'c', label, items: [{ group: 'd', label, items: [{ doc: 'index' }] }] },
							],
						},
					],
				},
			];
		});
		const depth = result.lint.envelope.findings.filter((entry) => entry.rule === 'nav-depth');
		expect(depth.length).toBe(1);
		expect(depth[0]?.message).toContain(String(MAX_NAV_DEPTH));
	});

	test('the corpus itself trips none of them', () => {
		const clean = buildBundle(repo, { generator: '@hex-pro/docs-kit@0.1.0' });
		const navRules = new Set(['orphan-page', 'nav-duplicate', 'nav-depth', 'anchor-resolves']);
		expect(clean.lint.envelope.findings.filter((entry) => navRules.has(entry.rule))).toEqual([]);
	});
});
