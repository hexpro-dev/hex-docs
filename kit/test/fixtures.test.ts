import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
	CONTAINER_DIRECTIVE_PATTERN,
	DIRECTIVE_CLOSE_PATTERN,
	LEAF_DIRECTIVE_PATTERN,
	SNIPPET_INCLUDE_NAME,
	isContainerDirective,
	parseFenceInfo,
	parseHighlightLines,
} from '../../src/contracts/source.js';
import { PLAIN_CODE_LANGUAGE } from '../../src/contracts/project.js';
import type { DocsProjectConfig } from '../../src/contracts/project.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';

import {
	FIXTURE_PAGES,
	FIXTURE_PROJECT,
	FIXTURE_SNIPPETS,
	SITE_ROOT,
	APP_ROOT,
	CONSUMER_ROOT,
	appFiles,
	contentPath,
	parseFixtureFrontMatter,
	readAppFile,
	snippetPath,
} from '../../fixtures/index.js';
import {
	denyListSchema,
	describeForbiddenKey,
	docsProjectConfigSchema,
	docsSiteConfigSchema,
	frontMatterSchema,
	navTreeSchema,
	protectedRuleViolations,
	snippetFrontMatterSchema,
	versionTableProblems,
} from '../src/contracts/index.js';

const raw = (path: string): unknown => JSON.parse(readFileSync(join(SITE_ROOT, path), 'utf8'));

/** Every markdown file in the corpus, page and snippet alike, relative to `docs/site`. */
const markdown = appFiles()
	.filter((path) => /^docs\/site\/(content|snippets)\/.*\.md$/.test(path))
	.map((path) => path.replace('docs/site/', ''));

const bodyOf = (path: string): string =>
	parseFixtureFrontMatter(readAppFile(join('docs', 'site', path)), path).body;

/**
 * Markdown the corpus ships that is not a page or a snippet.
 *
 * `docs/CLAUDE.md` is the first file an agent handed this tree reads, and until it was
 * scanned it documented a snippet-include spelling the contract refuses. It has no front
 * matter, so it cannot go through `bodyOf`, which is exactly why it fell outside every
 * list.
 */
const GUIDES = ['docs/CLAUDE.md'];

/**
 * The body's lines with everything inside a code fence removed.
 *
 * Directive markers are scanned against these rather than against the raw body, because
 * a fence can legitimately contain a line of colons and a scan that counted it would
 * report a mismatched directive on a page that has none.
 */
function proseLines(path: string): string[] {
	const source = GUIDES.includes(path) ? readAppFile(path) : bodyOf(path);
	const found: string[] = [];
	let inside = false;
	for (const line of source.split('\n')) {
		if (line.startsWith('```')) {
			inside = !inside;
			continue;
		}
		if (!inside) found.push(line);
	}
	return found;
}

describe('the config files validate against the schemas that will reject them at publish time', () => {
	test('docs.json is a DocsProjectConfig', () => {
		const result = docsProjectConfigSchema.safeParse(raw('docs.json'));
		expect(result.error?.issues ?? []).toEqual([]);
		expect(result.success).toBe(true);
	});

	test('docs.json lowers no protected rule', () => {
		const config = docsProjectConfigSchema.parse(raw('docs.json')) as DocsProjectConfig;
		expect(protectedRuleViolations(config)).toEqual([]);
	});

	test('nav.json is a NavTree', () => {
		const result = navTreeSchema.safeParse(raw('nav.json'));
		expect(result.error?.issues ?? []).toEqual([]);
		expect(result.success).toBe(true);
	});

	test('the deny list validates, and it is the file outside the publishable root', () => {
		const result = denyListSchema.safeParse(JSON.parse(readAppFile('docs/docs.private.json')));
		expect(result.error?.issues ?? []).toEqual([]);
		expect(result.success).toBe(true);
	});

	test('the consuming config is a DocsSiteConfig with a sound version table', () => {
		const parsed = docsSiteConfigSchema.safeParse(
			JSON.parse(readFileSync(join(CONSUMER_ROOT, `${FIXTURE_PROJECT}.docs.json`), 'utf8')),
		);
		expect(parsed.error?.issues ?? []).toEqual([]);
		expect(versionTableProblems(parsed.data as DocsSiteConfig)).toEqual([]);
	});

	test('every root config declares a $schema that resolves to an emitted file', () => {
		// A relative $schema is what gives an editor completion with nothing hosted
		// anywhere, and every schema here is strict, so a tool that rejected the files it
		// generates itself would be worse than one with no completion at all.
		const cases: [string, string][] = [
			[join(SITE_ROOT, 'docs.json'), SITE_ROOT],
			[join(SITE_ROOT, 'nav.json'), SITE_ROOT],
			[join(APP_ROOT, 'docs', 'docs.private.json'), join(APP_ROOT, 'docs')],
			[join(CONSUMER_ROOT, `${FIXTURE_PROJECT}.docs.json`), CONSUMER_ROOT],
		];
		for (const [file, base] of cases) {
			const declared = (JSON.parse(readFileSync(file, 'utf8')) as { $schema?: string }).$schema;
			expect(declared, file).toBeDefined();
			expect(readFileSync(join(base, declared as string), 'utf8').length, file).toBeGreaterThan(0);
		}
	});
});

describe('front matter', () => {
	test.each(markdown.filter((path) => path.startsWith('content/')))(
		'%s validates as page front matter',
		(path) => {
			const { data } = parseFixtureFrontMatter(readAppFile(join('docs', 'site', path)), path);
			const result = frontMatterSchema.safeParse(data);
			expect(result.error?.issues ?? []).toEqual([]);
		},
	);

	test.each(markdown.filter((path) => path.startsWith('snippets/')))(
		'%s validates as snippet front matter',
		(path) => {
			const { data } = parseFixtureFrontMatter(readAppFile(join('docs', 'site', path)), path);
			const result = snippetFrontMatterSchema.safeParse(data);
			expect(result.error?.issues ?? []).toEqual([]);
		},
	);

	test('no page declares a key that has an owner somewhere else', () => {
		for (const path of markdown) {
			const { keys } = parseFixtureFrontMatter(readAppFile(join('docs', 'site', path)), path);
			for (const key of keys) {
				const reason = describeForbiddenKey(key);
				expect(reason === undefined, `${path} declares ${key}: ${reason ?? ''}`).toBe(true);
			}
		}
	});

	test('every title and description is inside the budget the project set for itself', () => {
		const config = docsProjectConfigSchema.parse(raw('docs.json')) as DocsProjectConfig;
		for (const path of markdown.filter((entry) => entry.startsWith('content/'))) {
			const { data } = parseFixtureFrontMatter(readAppFile(join('docs', 'site', path)), path);
			expect((data['title'] as string).length, `${path} title`).toBeLessThanOrEqual(
				config.budgets.titleMax,
			);
			expect((data['description'] as string).length, `${path} description`).toBeLessThanOrEqual(
				config.budgets.descriptionMax,
			);
		}
	});

	test('the Japanese descriptions are shorter than the English ones, which is why there is no floor', () => {
		// A single global minimum of fifty characters rejects correct Japanese, where
		// character density is roughly double. The corpus is what makes that concrete
		// rather than a claim in a comment.
		const english = parseFixtureFrontMatter(
			readAppFile(join('docs', 'site', contentPath('en', 'index'))),
			'en',
		).data['description'] as string;
		const japanese = parseFixtureFrontMatter(
			readAppFile(join('docs', 'site', contentPath('ja', 'index'))),
			'ja',
		).data['description'] as string;
		expect(japanese.length).toBeLessThan(english.length);
	});

	test('every tag a page uses is in the project vocabulary', () => {
		// A closed list, because free tags rot and cannot be translated. Measured against
		// the corpus rather than trusted: a tag added to a page and not to the vocabulary
		// is a filter that silently matches nothing.
		const config = docsProjectConfigSchema.parse(raw('docs.json')) as DocsProjectConfig;
		const vocabulary = new Set(config.taxonomy?.tags ?? []);
		const used = new Set<string>();
		for (const path of markdown.filter((entry) => entry.startsWith('content/'))) {
			const { data } = parseFixtureFrontMatter(readAppFile(join('docs', 'site', path)), path);
			for (const tag of (data['tags'] ?? []) as string[]) used.add(tag);
		}
		expect([...used].filter((tag) => !vocabulary.has(tag))).toEqual([]);
		expect(used.size).toBeGreaterThan(2);
	});
});

describe('the source spellings the compiler will look for', () => {
	test('every container directive in the corpus has a name this AST major understands', () => {
		const seen = new Set<string>();
		for (const path of [...markdown, ...GUIDES]) {
			for (const line of proseLines(path)) {
				const open = CONTAINER_DIRECTIVE_PATTERN.exec(line);
				if (open === null) continue;
				seen.add(open[2] as string);
				expect(isContainerDirective(open[2] as string), `${path}: ${line}`).toBe(true);
			}
		}
		// Measured, not asserted. If this ever counted one, the corpus would have stopped
		// exercising the grammar and every assertion above it would still pass.
		expect(seen.size).toBeGreaterThanOrEqual(7);
	});

	test('every container directive is closed, at the colon count it opened with', () => {
		for (const path of markdown) {
			const stack: string[] = [];
			for (const line of proseLines(path)) {
				const close = DIRECTIVE_CLOSE_PATTERN.exec(line);
				const open = CONTAINER_DIRECTIVE_PATTERN.exec(line);
				if (open !== null) {
					stack.push(open[1] as string);
				} else if (close !== null) {
					expect(stack.pop(), `${path}: ${line} closes nothing of that width`).toBe(close[1]);
				}
			}
			expect(stack, `${path} leaves a directive open`).toEqual([]);
		}
	});

	test('the authoring guide documents a spelling the grammar accepts', () => {
		// It told an author to write `:::include <id>`, which the contract refuses:
		// transclusion is a leaf directive and `include` is deliberately not a container
		// name. Nothing read the file, so the corpus shipped instructions for a spelling
		// its own compiler would reject.
		for (const path of GUIDES) {
			const source = readAppFile(path);
			expect(source).toContain('::include[');
			expect(source).not.toMatch(/:::include/);
		}
	});

	test('every leaf directive is a snippet include naming a snippet that exists', () => {
		const ids = new Set(FIXTURE_SNIPPETS.map((snippet) => snippet.id));
		let found = 0;
		for (const path of [...markdown, ...GUIDES]) {
			for (const line of proseLines(path)) {
				const leaf = LEAF_DIRECTIVE_PATTERN.exec(line);
				if (leaf === null) continue;
				found += 1;
				expect(leaf[1]).toBe(SNIPPET_INCLUDE_NAME);
				// The guide included. Its example names a real snippet rather than a
				// placeholder, so the instruction an author reads first is one that works.
				expect(ids.has(leaf[2] as string), `${path}: ${line}`).toBe(true);
			}
		}
		expect(found).toBeGreaterThan(0);
	});

	test('every fence carries a language from the allowlist, or none at all', () => {
		const config = docsProjectConfigSchema.parse(raw('docs.json')) as DocsProjectConfig;
		const allowed = new Set(config.code.languages);
		expect(allowed.has(PLAIN_CODE_LANGUAGE)).toBe(true);

		const used = new Set<string>();
		let fences = 0;
		for (const path of markdown) {
			let inside = false;
			for (const line of bodyOf(path).split('\n')) {
				if (!line.startsWith('```')) continue;
				if (inside) {
					inside = false;
					continue;
				}
				inside = true;
				fences += 1;
				const info = parseFenceInfo(line.slice(3));
				expect(info.problems, `${path}: ${line}`).toEqual([]);
				if (info.lang === undefined) continue;
				used.add(info.lang);
				expect(allowed.has(info.lang), `${path}: ${info.lang}`).toBe(true);
			}
			expect(inside, `${path} leaves a code fence open`).toBe(false);
		}
		expect(fences).toBeGreaterThan(4);
		expect(used.size).toBeGreaterThan(1);
	});

	test('every highlight range on a fence is readable', () => {
		let checked = 0;
		for (const path of markdown) {
			for (const line of bodyOf(path).split('\n')) {
				if (!line.startsWith('```')) continue;
				const highlight = parseFenceInfo(line.slice(3)).options.highlight;
				if (typeof highlight !== 'string') continue;
				checked += 1;
				expect(parseHighlightLines(highlight), `${path}: ${line}`).not.toBeUndefined();
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	test('the corpus declares an allowlist entry for every language it actually uses', () => {
		// The other direction. An entry nothing uses is dead config, and the reason to
		// notice is that a typo like ```swfit produces an error only because the allowlist
		// is narrow. A list that grew to cover mistakes stops catching them.
		const config = docsProjectConfigSchema.parse(raw('docs.json')) as DocsProjectConfig;
		const used = new Set<string>();
		for (const path of markdown) {
			for (const line of bodyOf(path).split('\n')) {
				if (!line.startsWith('```')) continue;
				const info = parseFenceInfo(line.slice(3));
				if (info.lang !== undefined) used.add(info.lang);
			}
		}
		const unused = config.code.languages.filter(
			(language) => language !== PLAIN_CODE_LANGUAGE && !used.has(language),
		);
		expect(unused, 'declared and never used in the corpus').toEqual([]);
	});
});

describe('the declared inventory agrees with what the schemas accept', () => {
	test('every page in the table has a file for every locale it claims', () => {
		for (const page of FIXTURE_PAGES) {
			for (const locale of Object.keys(page.locales)) {
				const path = join('docs', 'site', contentPath(locale as never, page.slug));
				expect(readAppFile(path).length, path).toBeGreaterThan(0);
			}
		}
	});

	test('every snippet in the table has a file for every locale it claims', () => {
		for (const snippet of FIXTURE_SNIPPETS) {
			for (const locale of Object.keys(snippet.locales)) {
				const path = join('docs', 'site', snippetPath(locale as never, snippet.id));
				expect(readAppFile(path).length, path).toBeGreaterThan(0);
			}
		}
	});

	test('the project publishes exactly the locales the tree contains', () => {
		const config = docsProjectConfigSchema.parse(raw('docs.json')) as DocsProjectConfig;
		const directories = new Set(
			appFiles()
				.filter((path) => path.startsWith('docs/site/content/'))
				.map((path) => path.split('/')[3] as string),
		);
		expect([...directories].sort()).toEqual([...config.i18n.locales].sort());
	});
});
