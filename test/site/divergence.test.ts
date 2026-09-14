/**
 * `docsServer` over a bundle the committed corpus cannot produce.
 *
 * `serve.test.ts` answers every request over the corpus as committed, and two served
 * properties are invisible there however many requests it makes. The corpus's only
 * scaffolded page is a byte copy of its English source with `translated: false` added, so
 * serving the Spanish file and serving the English one put the same words on the page. And
 * every record whose effective state differs from its own is `current` against `stale`,
 * which stays indexable, so a reader of either state names the same alternates.
 *
 * So this file perturbs a materialised copy the way `kit/test/compile/divergence.test.ts`
 * does, compiles it with the real compiler and asks the server. Both perturbations share one
 * bundle, because each compile replays the corpus history and costs a couple of seconds.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { beforeAll, describe, expect, test } from 'vitest';

import { scaffold } from '../../kit/src/commands/scaffold.js';
import { NO_EXEC } from '../../kit/src/exec/run.js';
import { invoke } from '../../kit/src/registry/command.js';
import { TODO_TRANSLATE_PAGE } from '../../kit/src/templates/page.js';
import { LOCALES } from '../../src/contracts/locales.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import { docsServer, type DocsServer } from '../../src/site/serve.js';
import {
	fixtureSources,
	languageSweep,
	perturbedBundle,
	perturbedSite,
	type FixtureBundle,
} from '../support/bundle.js';

/** A page with no French file in the corpus, so `hexdocs scaffold` returns one for it. */
const STUBBED = 'guide/troubleshooting';

let bundle: FixtureBundle;
let site: DocsSiteConfig;
let server: DocsServer;

beforeAll(async () => {
	bundle = await perturbedBundle(async (repo) => {
		// The real command rather than a hand-written stub, so the file is whatever the
		// scaffolder writes today. It writes nothing itself; the caller applies what it returns.
		const output = await invoke(
			scaffold,
			{ kind: 'page', root: repo, slug: STUBBED, locale: ['fr'] },
			{
				cwd: repo,
				kitVersion: '@hex-pro/docs-kit@0.0.0-test',
				exec: NO_EXEC,
				write: null,
				now: () => new Date('2026-06-01T00:00:00Z'),
				log: () => undefined,
			},
		);
		const files = (output.data as { files: { path: string; contents: string }[] }).files;
		expect(files.map((file) => file.path)).toEqual([`docs/site/content/fr/${STUBBED}.md`]);
		for (const file of files) {
			mkdirSync(dirname(join(repo, file.path)), { recursive: true });
			writeFileSync(join(repo, file.path), file.contents);
		}

		// A Chinese legend scaffolded by copying the English one, which makes the Chinese chip
		// matrix current in its own right and scaffolded in effect.
		const legend = (locale: string): string =>
			join(repo, 'docs/site/snippets', locale, 'legend.md');
		const english = readFileSync(legend('en'), 'utf8');
		const body = english.slice(english.indexOf('---', 3) + 3);
		writeFileSync(legend('zh'), `---\ntitle: 图例\ntranslated: false\n---\n${body}`);
	});
	site = perturbedSite(bundle);
	server = docsServer(fixtureSources(bundle, site));
}, 60_000);

const url = (path: string): URL => new URL(path, 'http://docs.test');

describe('a page hexdocs scaffold wrote', () => {
	test('is in the bundle as the stub, so what follows meets the stub rather than an absence', () => {
		expect(bundle.manifest.pages[STUBBED]?.locales.fr?.state).toBe('scaffolded');
		expect(bundle.objects.get(`pages/fr/${STUBBED}.json`)).toContain(TODO_TRANSLATE_PAGE);
		expect(bundle.objects.get(`raw/fr/${STUBBED}.md`)).toContain(TODO_TRANSLATE_PAGE);
	});

	test('is served as its source page under the fallback notice, not as a page of TODO markers', async () => {
		// The notice tells the reader the page has not been translated and links to the
		// English one. Served from the French record, the page under that notice was the
		// scaffolder's headings with a TODO under each, and the raw markdown at the same
		// address was already the English source.
		const loaded = await server.page(url(`/fr/fixture-app/docs/${STUBBED}`));
		expect(loaded.data.page).toEqual(
			JSON.parse(bundle.objects.get(`pages/en/${STUBBED}.json`) as string),
		);
		expect(loaded.data.notice).toEqual({ state: 'fallback', requested: 'fr' });
		expect(loaded.seo.indexable).toBe(false);
		expect(loaded.seo.languages).not.toContain('fr');
		expect(JSON.stringify(loaded.data.page)).not.toContain(TODO_TRANSLATE_PAGE);
	});

	test('answers its markdown and llms-full.txt in the source language too', async () => {
		const raw = await server.resource(url(`/fr/fixture-app/docs/${STUBBED}.md`));
		expect(raw.headers.get('Content-Language')).toBe('en');
		expect(await raw.text()).not.toContain(TODO_TRANSLATE_PAGE);

		const full = await server.resource(url('/fr/fixture-app/docs/llms-full.txt'));
		expect(await full.text()).not.toContain(TODO_TRANSLATE_PAGE);
	});
});

describe('the languages a page names agree with the pages that are indexable', () => {
	test('over a bundle where the effective state takes a locale out and the own state does not', async () => {
		const swept = await languageSweep(server, site);
		for (const address of swept) {
			expect(address).toEqual({ ...address, named: address.indexable });
		}
		expect(swept.length).toBe(site.pages.length * LOCALES.length);

		// What makes the agreement above worth having here. The Chinese chip matrix is
		// `current` in its own right, which is indexable, and is served `noindex` because of
		// the snippet, so a reader of `state` alone names it and a reader of `effective` does
		// not. Without at least one such address the sweep agrees whichever one a reader reads.
		const divergent = swept.filter((address) => {
			const entry = bundle.manifest.pages[address.slug]?.locales[address.locale];
			return (
				entry !== undefined &&
				(entry.state === 'current' || entry.state === 'stale') &&
				!address.indexable
			);
		});
		expect(divergent.map((address) => `${address.locale}/${address.slug}`)).toEqual([
			'zh/reference/chip-support',
		]);
	});
});
