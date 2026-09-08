/**
 * The compiler against the fixture corpus, with every expectation derived from what the
 * corpus declares about itself.
 *
 * `fixtures/corpus.ts` states what the tree is supposed to be and `fixtures/planted.ts`
 * states what it carries on purpose. Reading those rather than hand-writing the answers
 * is what makes this suite move when the corpus does: a page added with a declared
 * translation state fails here until the compiler produces it, and a page deleted fails
 * here rather than quietly reducing what is covered.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
	APP_ROOT,
	FIXTURE_ASSETS,
	FIXTURE_PAGES,
	FIXTURE_PROJECT,
	FIXTURE_SNIPPETS,
	PLANTED_PROSE,
	PLANTED_SUPPRESSIONS,
	REJECTED_ASSETS,
	REJECTED_ROOT,
	materialiseCorpus,
} from '../../../fixtures/index.js';

import type { TranslationState } from '../../../src/contracts/frontmatter.js';
import { LOCALES, SOURCE_LOCALE, type Locale } from '../../../src/contracts/locales.js';
import { probeAsset } from '../../src/compile/assets.js';
import { buildBundle, type BuildResult } from '../../src/compile/build.js';

const GENERATOR = '@hex-pro/docs-kit@0.1.0';

/** Worst first, the same order the compiler folds a page's snippets in with. */
const STATE_ORDER: readonly TranslationState[] = [
	'source',
	'current',
	'stale',
	'scaffolded',
	'missing',
];

function worst(a: TranslationState, b: TranslationState): TranslationState {
	return STATE_ORDER.indexOf(a) >= STATE_ORDER.indexOf(b) ? a : b;
}

let root: string;
let result: BuildResult;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'hexdocs-corpus-'));
	const corpus = materialiseCorpus(join(root, 'repo'));
	result = buildBundle(corpus.root, { generator: GENERATOR });
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('what compiled, against what the corpus declares', () => {
	test('every declared page and locale compiled, and nothing else did', () => {
		const declared: string[] = [];
		for (const page of FIXTURE_PAGES) {
			for (const locale of Object.keys(page.locales)) declared.push(`${page.slug}@${locale}`);
		}
		const compiled: string[] = [];
		for (const [slug, byLocale] of result.pages) {
			for (const locale of byLocale.keys()) compiled.push(`${slug}@${locale}`);
		}
		expect(declared.length).toBe(39);
		expect(compiled.sort()).toEqual(declared.sort());
	});

	test('the project id in the manifest is the one both configs join on', () => {
		expect(result.manifest.project).toBe(FIXTURE_PROJECT);
	});

	test('the draft is compiled and not published', () => {
		const draft = FIXTURE_PAGES.find((page) => page.draft === true);
		expect(draft).toBeDefined();
		const slug = draft?.slug as string;
		// Both halves matter and they are what the corpus says this page exists to prove:
		// a draft is excluded from a bundle and still read by the linter, so the em dash
		// planted in it has to be reported while the page has no object.
		expect(result.pages.has(slug)).toBe(true);
		expect(Object.keys(result.manifest.pages)).not.toContain(slug);
		expect(result.objects.some((object) => object.key.includes(slug))).toBe(false);
	});

	test('a draft is not an orphan, and every other page is in the nav', () => {
		const orphans = result.lint.envelope.findings.filter(
			(finding) => finding.rule === 'orphan-page',
		);
		expect(orphans).toEqual([]);
	});
});

describe('translation state, derived from the declarations', () => {
	const published = FIXTURE_PAGES.filter((page) => page.draft !== true);

	test.each(
		published.flatMap((page) =>
			Object.entries(page.locales).map(([locale, state]) => [page.slug, locale, state] as const),
		),
	)('the manifest records %s in %s as its own state, %s', (slug, locale, state) => {
		const record = result.manifest.pages[slug]?.locales[locale as Locale];
		expect(record).toBeDefined();
		expect(record?.state).toBe(state);
	});

	test.each(
		published.flatMap((page) =>
			Object.entries(page.locales).map(([locale, state]) => {
				const includes = page.includes ?? [];
				const effective = includes.reduce<TranslationState>((current, id) => {
					const snippet = FIXTURE_SNIPPETS.find((entry) => entry.id === id);
					const snippetState: TranslationState = snippet?.locales[locale as Locale] ?? 'missing';
					return worst(current, snippetState);
				}, state as TranslationState);
				return [page.slug, locale, effective, includes.length] as const;
			}),
		),
	)(
		'the compiled page for %s in %s shows the effective state %s, folding in %i snippets',
		(slug, locale, effective) => {
			const page = result.pages.get(slug)?.get(locale as Locale)?.page;
			expect(page).toBeDefined();
			expect(page?.translation.state).toBe(effective);
		},
	);

	test('a page can be effectively stale while its own timestamps say current', () => {
		// This is the pair the corpus was built for, and it is the one case where the two
		// states in the bundle deliberately differ. `index` in zh is current by its own
		// dates, and the snippet it transcludes is not, so the reader's notice says stale
		// while the coverage table a translator reads still counts the page as translated.
		const record = result.manifest.pages['index']?.locales['zh'];
		const page = result.pages.get('index')?.get('zh')?.page;
		expect(record?.state).toBe('current');
		expect(page?.translation.state).toBe('stale');
		expect(page?.translation.translationUpdated).toBeDefined();
		expect(
			(page?.translation.translationUpdated as string) >
				(page?.translation.sourceUpdated as string),
		).toBe(true);
	});

	test('the scaffolded page is counted separately from translated and from stale', () => {
		const scaffolded = FIXTURE_PAGES.flatMap((page) =>
			Object.entries(page.locales)
				.filter(([, state]) => state === 'scaffolded')
				.map(([locale]) => locale as Locale),
		);
		expect(scaffolded.length).toBe(1);
		const locale = scaffolded[0] as Locale;
		expect(result.manifest.coverage[locale]?.scaffolded).toBe(1);
	});

	test('coverage recounts to what the declarations say, for every locale', () => {
		for (const locale of LOCALES) {
			const records = FIXTURE_PAGES.filter((page) => page.draft !== true)
				.map((page) => page.locales[locale])
				.filter((state): state is TranslationState => state !== undefined);
			expect(result.manifest.coverage[locale]).toEqual({
				pages: records.length,
				translated: records.filter((state) => state === 'source' || state === 'current').length,
				stale: records.filter((state) => state === 'stale').length,
				scaffolded: records.filter((state) => state === 'scaffolded').length,
			});
		}
	});
});

describe('what the corpus plants', () => {
	test('every planted violation is reported, and the suppressed one is not', () => {
		const findings = result.lint.envelope.findings;
		let checked = 0;
		for (const planted of PLANTED_PROSE) {
			const matching = findings.filter(
				(finding) =>
					finding.rule === planted.rule &&
					'file' in finding.location &&
					finding.location.file === planted.file,
			);
			checked += 1;
			if (planted.suppressed === true) {
				expect(
					matching,
					`${planted.rule} in ${planted.file} is suppressed and must not be reported`,
				).toEqual([]);
				continue;
			}
			expect(matching.length, `${planted.rule} in ${planted.file}`).toBeGreaterThan(0);
			// Every finding carries a line, because a diagnostic without one is a diagnostic
			// somebody has to go looking for.
			for (const finding of matching) {
				expect('line' in finding.location && finding.location.line).toBeGreaterThan(0);
			}
		}
		expect(checked).toBe(PLANTED_PROSE.length);
		expect(checked).toBeGreaterThan(4);
	});

	test('the corpus produces exactly the planted errors and nothing else', () => {
		const errors = result.lint.envelope.findings
			.filter((finding) => finding.severity === 'error')
			.map(
				(finding) => `${finding.rule} ${'file' in finding.location ? finding.location.file : ''}`,
			)
			.sort();
		expect(errors).toEqual([
			'code-fence-language content/en/reference/api.md',
			'internal-leak content/en/developer/architecture.md',
			'no-banned-phrase content/en/developer/architecture.md',
			'no-competitor-name content/en/developer/architecture.md',
			'no-decorative-unicode content/en/reference/api.md',
			'no-em-dash content/en/notes/scratch.md',
			'no-en-dash-prose content/en/developer/architecture.md',
		]);
	});

	test('the one suppression is used, so nothing reports it as stale', () => {
		expect(PLANTED_SUPPRESSIONS.length).toBe(1);
		expect(result.lint.unusedDisables).toEqual([]);
		const stale = result.lint.envelope.findings.filter((finding) =>
			finding.message.includes('matched nothing'),
		);
		expect(stale).toEqual([]);
	});

	test('the suppression count is under the cap the project sets', () => {
		const overCap = result.lint.envelope.findings.filter((finding) =>
			finding.message.includes('suppression comments and its cap'),
		);
		expect(overCap).toEqual([]);
	});
});

describe('assets', () => {
	test('every declared asset is published, with dimensions and a colour probe', () => {
		expect(result.manifest.assets.length).toBe(FIXTURE_ASSETS.length);
		for (const asset of result.manifest.assets) {
			expect(asset.width).toBeGreaterThan(0);
			expect(asset.height).toBeGreaterThan(0);
			expect(asset.colour.space).toBe('srgb');
			// Always null in this version, and the reason is on ProbedAsset: every encoder
			// available here varies by build, and the manifest has to be byte-reproducible
			// from the commit alone.
			expect(asset.lqip).toBeNull();
		}
	});

	test.each(REJECTED_ASSETS)('$path is refused under $rule', (rejected) => {
		const bytes = readFileSync(join(REJECTED_ROOT, rejected.path));
		const probe = probeAsset(bytes, rejected.path);
		expect(probe.ok).toBe(false);
		if (!probe.ok) expect(probe.rule).toBe(rejected.rule);
	});

	test('a refused asset is not in the tree the compiler has to build', () => {
		// The rejected assets live outside app/ on purpose: a tree the compiler is asked to
		// build must build, so an asset that must be refused belongs beside the declaration
		// of why rather than inside the corpus that has to succeed. Asserted rather than
		// trusted, because moving one in would make the corpus fail with no sign of why.
		expect(REJECTED_ASSETS.length).toBeGreaterThan(0);
		for (const rejected of REJECTED_ASSETS) {
			expect(existsSync(join(APP_ROOT, 'docs', 'site', 'assets', rejected.path))).toBe(false);
			expect(existsSync(join(REJECTED_ROOT, rejected.path))).toBe(true);
		}
	});
});

describe('the bundle the corpus produces', () => {
	test('the nav order and llmsOrder are the same reading order', () => {
		expect(result.manifest.llmsOrder).toEqual(result.manifest.nav.map((node) => node.slug));
		expect(result.manifest.llmsOrder.length).toBeGreaterThan(0);
	});

	test('a hidden page is published, addressable and still in the nav', () => {
		// `reference/api` is hidden from the sidebar and published. Hidden is not draft: it
		// keeps its object and its place in reading order, which is what stops it being
		// reported as an orphan.
		expect(result.manifest.pages['reference/api']).toBeDefined();
		expect(result.manifest.llmsOrder).toContain('reference/api');
	});

	test('redirectFrom becomes a redirect, and no redirect shadows a page', () => {
		const declared = FIXTURE_PAGES.flatMap((page) =>
			(page.redirectFrom ?? []).map((from) => [from, page.slug] as const),
		);
		expect(declared.length).toBeGreaterThan(0);
		for (const [from, to] of declared) {
			expect(result.manifest.redirects[from]).toBe(to);
			expect(Object.keys(result.manifest.pages)).not.toContain(from);
		}
	});

	test('every page that declares an include records it, and no other page does', () => {
		let checked = 0;
		for (const page of FIXTURE_PAGES) {
			const compiled = result.pages.get(page.slug)?.get(SOURCE_LOCALE);
			expect(compiled).toBeDefined();
			expect(compiled?.page.snippets ?? []).toEqual([...(page.includes ?? [])]);
			checked += 1;
		}
		expect(checked).toBe(FIXTURE_PAGES.length);
	});

	test('every locale has a search index, an llms.txt and a coverage row', () => {
		for (const locale of LOCALES) {
			expect(result.manifest.search[locale]?.records).toBeGreaterThan(0);
			expect(result.manifest.llms[locale]?.bytes).toBeGreaterThan(0);
			expect(result.manifest.coverage[locale]).toBeDefined();
		}
	});

	test('the object list is exactly the objects that were produced', () => {
		expect(result.manifest.objects.map((object) => object.key)).toEqual(
			result.objects.map((object) => object.key),
		);
		expect(result.manifest.counts.objects).toBe(result.objects.length);
		expect(result.manifest.counts.bytes).toBe(
			result.objects.reduce((total, object) => total + object.bytes.length, 0),
		);
	});
});
