/**
 * `hexdocs pages`, against a corpus whose history has been replayed.
 *
 * Running this against `fixtures/app` on disk would prove nothing about the thing it is
 * for. Every file there carries this repository's own single commit date, so nothing is
 * newer than anything and the whole table reads `current`, which is the shallow-clone
 * failure by accident. `materialiseCorpus` replays the declared dates, and only then do
 * the four translation states exist to be counted.
 *
 * The property this file exists to hold is the two-state cell. `state` is the page's own
 * and is what `coverage` counts, because a translator opens files by it; `effectiveState`
 * is the worst of the page and everything it transcludes, because that is what a reader
 * gets. Measured on this corpus, they disagree on six cells out of fifty-one, and every
 * one of them is `index`. A single field would be right about the other forty-five, which
 * is exactly how a report ends up with one number and two meanings, so the differing set
 * is asserted **as a set** in both directions: a change that made the two fields identical
 * fails naming the six, and a change that made a seventh cell disagree fails naming that.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus } from '../../../fixtures/index.js';
import { LOCALES } from '../../../src/contracts/locales.js';
import type { BundleManifest } from '../../../src/contracts/manifest.js';
import { buildBundle } from '../../src/compile/build.js';
import { writeBundle } from '../../src/compile/bundle.js';
import { pages, type PagesReport } from '../../src/commands/pages.js';
import { invoke, type Ctx } from '../../src/registry/command.js';

const KIT_VERSION = '@hex-pro/docs-kit@0.0.0';

let root: string;
let corpus: string;
/** The `ast-N` directory of a bundle written out of the same tree. */
let prefix: string;
let manifest: BundleManifest;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'hexdocs-pages-'));
	corpus = materialiseCorpus(join(root, 'repo')).root;
	const built = buildBundle(corpus, { generator: KIT_VERSION });
	// A build whose own manifest invariants complain would make every column below
	// meaningless, since the whole report is derived from the manifest.
	expect(built.manifestProblems).toEqual([]);
	manifest = built.manifest;
	const out = join(root, 'out');
	mkdirSync(out, { recursive: true });
	prefix = writeBundle(out, built.manifest, built.objects).prefix;
}, 60_000);

afterAll(() => {
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function ctx(cwd: string): Ctx {
	return {
		cwd,
		kitVersion: KIT_VERSION,
		exec: () => {
			throw new Error('pages ran a process. It compiles in memory or reads a bundle.');
		},
		write: null,
		now: () => new Date('2026-01-01T00:00:00Z'),
		log: () => {},
	};
}

async function report(input: Record<string, unknown>): Promise<PagesReport> {
	const out = await invoke(pages, input, ctx(root));
	expect(out.rows).toEqual([]);
	return out.data as unknown as PagesReport;
}

/** Every cell, as `slug/locale`, so a set difference names the page and the language. */
function cells(one: PagesReport): string[] {
	return one.pages.flatMap((page) =>
		Object.keys(page.locales).map((locale) => `${page.slug}/${locale}`),
	);
}

/** The cells where the page's own state and the effective state disagree. */
function disagreeing(one: PagesReport): string[] {
	const found: string[] = [];
	for (const page of one.pages) {
		for (const [locale, cell] of Object.entries(page.locales)) {
			if (cell.state !== cell.effectiveState) found.push(`${page.slug}/${locale}`);
		}
	}
	return found.sort();
}

/**
 * The six cells that must disagree, measured rather than assumed.
 *
 * `index` transcludes a snippet whose translation is stale in every language, so the page
 * is `current` on its own terms and `stale` to a reader. The source locale is not in the
 * list: English is its own source, so there is nothing for it to be stale against.
 */
const DISAGREEING = ['index/ar', 'index/es', 'index/fr', 'index/ja', 'index/pt-BR', 'index/zh'];

describe('the coverage table', () => {
	test('is the manifest own numbers, per locale, in both directions', async () => {
		const one = await report({ root: corpus });

		expect(one.project).toBe(manifest.project);
		expect(one.locales).toEqual([...manifest.locales]);
		expect(Object.keys(one.coverage).sort()).toEqual([...manifest.locales].sort());
		for (const locale of manifest.locales) {
			const declared = manifest.coverage[locale];
			expect(declared).toBeDefined();
			expect(one.coverage[locale]).toEqual({
				pages: declared?.pages,
				translated: declared?.translated,
				stale: declared?.stale,
				scaffolded: declared?.scaffolded,
			});
		}
	});

	test('counts the page own state, so the four states are all reached', async () => {
		const one = await report({ root: corpus });

		// A corpus where every page is current would satisfy every assertion above and
		// prove nothing about the counting, so the states themselves are checked here.
		const declared = new Set(
			one.pages.flatMap((page) => Object.values(page.locales).map((cell) => cell.state)),
		);
		expect([...declared].sort()).toEqual(['current', 'missing', 'scaffolded', 'source', 'stale']);

		const stale = [...manifest.locales].reduce(
			(total, locale) => total + (manifest.coverage[locale]?.stale ?? 0),
			0,
		);
		expect(stale).toBeGreaterThan(0);
	});
});

describe('state and effectiveState', () => {
	test('disagree on exactly the six cells the corpus was built to produce', async () => {
		const one = await report({ root: corpus });

		// Both directions. The first assertion fails if the two fields are folded into one,
		// or if a transclusion stops dragging the effective state down; the second fails if
		// a seventh cell starts disagreeing, which would mean the corpus changed under the
		// claim rather than the code.
		expect(disagreeing(one)).toEqual(DISAGREEING);

		for (const key of DISAGREEING) {
			const [slug, locale] = [
				key.slice(0, key.lastIndexOf('/')),
				key.slice(key.lastIndexOf('/') + 1),
			];
			const page = one.pages.find((entry) => entry.slug === slug);
			expect(page, key).toBeDefined();
			const cell = page?.locales[locale];
			expect(cell?.state, key).toBe('current');
			expect(cell?.effectiveState, key).toBe('stale');
		}
	});

	test('agree everywhere else, and every other cell carries a state at all', async () => {
		const one = await report({ root: corpus });
		const differ = new Set(disagreeing(one));

		for (const page of one.pages) {
			for (const [locale, cell] of Object.entries(page.locales)) {
				if (differ.has(`${page.slug}/${locale}`)) continue;
				// `null` is not agreement. It is what a bundle with no payload returns, and a
				// source tree always has the compiled page in hand.
				expect(cell.effectiveState, `${page.slug}/${locale}`).not.toBeNull();
				expect(cell.effectiveState, `${page.slug}/${locale}`).toBe(cell.state);
			}
		}
	});
});

describe('the table is rectangular', () => {
	test('every page has a cell in every column, whether or not the file exists', async () => {
		const one = await report({ root: corpus });

		expect(one.pages.length).toBeGreaterThan(0);
		for (const page of one.pages) {
			expect(Object.keys(page.locales).sort(), page.slug).toEqual([...one.locales].sort());
		}
		expect(cells(one)).toHaveLength(one.pages.length * one.locales.length);
	});

	test('a language with no file for a page reads missing rather than being absent', async () => {
		const one = await report({ root: corpus });

		// `developer/architecture` is the English-only page. An absent key is how the
		// manifest says this, and it is the wrong answer in a report a translator reads to
		// decide what to open next: the row they need is the one that would be missing.
		const page = one.pages.find((entry) => entry.slug === 'developer/architecture');
		expect(page).toBeDefined();
		const missing = Object.entries(page?.locales ?? {}).filter(
			([, cell]) => cell.state === 'missing',
		);
		expect(missing.length).toBeGreaterThan(0);
		for (const [locale, cell] of missing) {
			expect(locale).not.toBe(manifest.sourceLocale);
			expect(cell.effectiveState).toBe('missing');
			expect(cell.title).toBeNull();
			expect(cell.translationUpdated).toBeNull();
			// The source date is still there, which is what makes the cell actionable: it
			// says what the translation would be catching up with.
			expect(cell.sourceUpdated).not.toBeNull();
		}
	});

	test('a locale filter narrows the columns and keeps every row', async () => {
		const one = await report({ root: corpus, locale: ['ja'] });
		const whole = await report({ root: corpus });

		expect(one.locales).toEqual(['ja']);
		expect(one.pages.map((page) => page.slug)).toEqual(whole.pages.map((page) => page.slug));
		for (const page of one.pages) expect(Object.keys(page.locales)).toEqual(['ja']);
		expect(Object.keys(one.coverage)).toEqual(['ja']);
	});
});

describe('reading a compiled bundle', () => {
	test('answers the same as reading the source tree', async () => {
		const fromSource = await report({ root: corpus });
		const fromBundle = await report({ root: corpus, bundle: prefix });

		// Every field, not a chosen subset. The two modes reach `effectiveState` by
		// different routes, the compiled page in memory against a gzip member read back off
		// disk, and that field is the one a second implementation would get wrong quietly.
		expect(fromBundle).toEqual(fromSource);
		expect(disagreeing(fromBundle)).toEqual(DISAGREEING);
	});

	test('a directory with no manifest is a not-run row, not an empty page list', async () => {
		const out = await invoke(pages, { root: corpus, bundle: join(root, 'out') }, ctx(root));

		expect(out.rows).toHaveLength(1);
		expect(out.rows[0]?.status).toBe('not-run');
		expect(out.rows[0]?.id).toBe('pages');
		expect(out.rows[0]?.note).toContain('manifest.json');
		expect((out.data as { listed: boolean }).listed).toBe(false);
	});
});

describe('the locale scope', () => {
	test('is the project languages when no filter is given', async () => {
		const one = await report({ root: corpus });
		// Both directions against the contract's own list, so a locale the project builds
		// and this report drops fails here rather than showing up as a shorter table.
		expect(one.locales.every((locale) => (LOCALES as readonly string[]).includes(locale))).toBe(
			true,
		);
		expect(one.locales).toEqual([...manifest.locales]);
	});
});
