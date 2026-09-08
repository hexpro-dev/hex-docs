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
import { compilePage } from '../../src/compile/page.js';
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
		services: services(),
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
