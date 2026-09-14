import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Fragment, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { CONSUMER_ROOT } from '../fixtures/index.js';
import type { Block } from '../src/contracts/ast.js';
import type { Locale } from '../src/contracts/locales.js';
import type { CompiledPage } from '../src/contracts/page.js';
import type { DocsSiteConfig } from '../src/contracts/site.js';
import { NO_EMIT } from '../src/render/context.js';
import { PlainLink, renderBlocks } from '../src/render/nodes.js';

// A zero-dependency guard, written as .mjs like the others, typed by its own JSDoc:
// `tsconfig.test.json` sets `allowJs` so the compiler reads it, and leaves `checkJs` off
// so nothing in it is held to the compiler. Turn that flag off and this import is an
// implicit `any` and the row assertions below stop being checked against anything.
import { FRAGMENTS, PROBES, findBrowser, run as runPaint } from '../scripts/check-paint.mjs';
import type { CheckResult } from '../scripts/lib/report.mjs';
import { REPO_ROOT, goldenManifest, goldenPages } from './support/golden.js';
import { pageData, renderPage } from './support/render.js';

const BROWSER = findBrowser() as string | undefined;

const STYLESHEET = (): string => readFileSync(join(REPO_ROOT, 'src', 'render', 'docs.css'), 'utf8');

/**
 * Runs the paint check against an edited copy of the stylesheet.
 *
 * The edit has to change something, and that is asserted rather than assumed: a
 * replacement whose search text stopped matching returns the stylesheet untouched, the row
 * comes back green, and a test expecting a failure then fails for a reason that names
 * nothing. That happened once already, to the alias case below, when the prose link rule
 * grew a second selector.
 */
async function paintWith(edit: (css: string) => string): Promise<CheckResult[]> {
	const original = STYLESHEET();
	const css = edit(original);
	expect(css).not.toBe(original);
	const target = mkdtempSync(join(tmpdir(), 'hexdocs-paint-'));
	try {
		const path = join(target, 'src', 'render', 'docs.css');
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, css, 'utf8');
		return (await runPaint(target)) as CheckResult[];
	} finally {
		rmSync(target, { recursive: true, force: true });
	}
}

/** Replaces text that must occur exactly once, so a stale search string fails here by name. */
function once(css: string, from: string, to: string): string {
	expect({ from, occurrences: css.split(from).length - 1 }).toEqual({ from, occurrences: 1 });
	return css.replace(from, to);
}

describe('the probe markup is the markup the renderer emits', () => {
	// A layout probe that runs against hand-written markup checks the stylesheet against
	// markup nobody ships the day the renderer changes shape. These tie the two together
	// without a browser, so the tie holds on a machine that skips the paint row.
	const context = {
		locale: 'en' as const,
		contentLocale: 'en' as const,
		address: { basePath: '/fixture-app/docs', locale: 'en' as const },
		bundleBase: '/_docs/fixture-app/1.1.0',
		Link: PlainLink,
		emit: NO_EMIT,
	};
	const blocks = (nodes: Block[]): string =>
		renderToStaticMarkup(createElement(Fragment, null, renderBlocks(nodes, context)));
	const text = (value: string) => ({ type: 'text' as const, value });
	const image = (alt: string, width: number, height: number) => ({
		type: 'image' as const,
		src: 'assets/0000.png',
		alt,
		width,
		height,
	});

	test('a task list, with a plain item before the task items', () => {
		expect(
			blocks([
				{
					type: 'list',
					style: 'bullet',
					tight: true,
					children: [
						{
							type: 'listItem',
							children: [{ type: 'paragraph', children: [text('An NTAG 213 tag')] }],
						},
						{
							type: 'listItem',
							checked: true,
							children: [
								{
									type: 'paragraph',
									children: [text('An iPhone 7 or later running iOS 16 or newer')],
								},
							],
						},
						{
							type: 'listItem',
							checked: false,
							children: [{ type: 'paragraph', children: [text('A case thinner than 3 mm')] }],
						},
					],
				},
			]),
		).toBe(FRAGMENTS.taskList);
	});

	test('an image in a paragraph, and an image in a figure', () => {
		expect(
			blocks([
				{
					type: 'paragraph',
					children: [
						text('The Scan sheet shows '),
						image('the radio badge', 16, 16),
						text(' in its top corner.'),
					],
				},
			]),
		).toBe(FRAGMENTS.inlineImage);
		expect(
			blocks([
				{
					type: 'figure',
					image: image('The Scan sheet', 320, 180),
					caption: [text('The Scan sheet, open')],
				},
			]),
		).toBe(FRAGMENTS.figure);
	});

	test('the skip link, and every class any probe selects on, appear in rendered pages', async () => {
		const site = JSON.parse(
			readFileSync(join(CONSUMER_ROOT, 'fixture-app.docs.json'), 'utf8'),
		) as DocsSiteConfig;
		const manifest = goldenManifest();
		const pages = new Map(
			goldenPages().map((entry) => [`${entry.locale}/${entry.slug}`, entry.page]),
		);
		const load = (locale: Locale, slug: string): CompiledPage | undefined =>
			pages.get(`${locale}/${slug}`);
		// The first scan guide carries the task list, the figures, the breadcrumb and the edit
		// link; the French architecture page is an English fallback, which is what renders a
		// banner, and it carries the fences.
		const rendered = [
			renderPage(await pageData({ manifest, site, locale: 'en', slug: 'guide/first-tag', load })),
			renderPage(
				await pageData({ manifest, site, locale: 'fr', slug: 'developer/architecture', load }),
			),
		].join('\n');
		expect(rendered).toContain(FRAGMENTS.skip);

		const emitted = new Set(
			[...rendered.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
				(match[1] as string).split(/\s+/),
			),
		);
		const probed = new Set(
			(PROBES as { body: string }[]).flatMap((probe) =>
				[...probe.body.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
					(match[1] as string).split(/\s+/).filter((name) => name.startsWith('hx-')),
				),
			),
		);
		expect(probed.size).toBeGreaterThan(30);
		expect([...probed].filter((name) => !emitted.has(name))).toEqual([]);
	});
});

describe('finding a browser', () => {
	test('honours an explicit path', () => {
		process.env.HEXDOCS_CHROME = '/definitely/not/here';
		try {
			// An explicit path that does not exist is not a reason to go looking elsewhere.
			// Somebody who set the variable meant that browser, and silently using a
			// different one would make the row report on something they did not ask for.
			expect(findBrowser()).toBeUndefined();
		} finally {
			delete process.env.HEXDOCS_CHROME;
		}
	});

	test('finds one on this machine, or says so', () => {
		// Not an assertion that a browser exists: this suite runs on machines where none
		// does, and that is the state the skip below is for.
		expect(BROWSER === undefined || BROWSER.length > 0).toBe(true);
	});
});

describe('when there is no browser', () => {
	test('the row is skipped, because a developer without one has not broken anything', async () => {
		process.env.HEXDOCS_CHROME = '/definitely/not/here';
		const ci = process.env.CI;
		delete process.env.CI;
		try {
			const rows = (await runPaint()) as CheckResult[];
			expect(rows.length).toBe(1);
			expect(rows[0]?.state).toBe('SKIPPED');
			// A skip carries its reason in the note rather than in a problem, which is the
			// difference between the two states: a problem is something to fix.
			expect(rows[0]?.note ?? '').toContain('HEXDOCS_CHROME');
			expect(rows[0]?.problems ?? []).toEqual([]);
		} finally {
			delete process.env.HEXDOCS_CHROME;
			if (ci !== undefined) process.env.CI = ci;
		}
	});

	test('the same state in CI is a failure, because the runner image ships one', async () => {
		// The distinction that keeps SKIPPED meaning "deliberate". A paint row that found no
		// browser on a runner means the image changed under the check, and the check that
		// catches the theming defect would otherwise go quiet without anybody noticing.
		process.env.HEXDOCS_CHROME = '/definitely/not/here';
		const ci = process.env.CI;
		process.env.CI = 'true';
		try {
			const rows = (await runPaint()) as CheckResult[];
			expect(rows[0]?.state).toBe('FAIL');
			expect(rows[0]?.problems?.[0] ?? '').toContain('broken environment');
		} finally {
			delete process.env.HEXDOCS_CHROME;
			if (ci === undefined) delete process.env.CI;
			else process.env.CI = ci;
		}
	});
});

describe.skipIf(BROWSER === undefined)('with a browser', () => {
	test('every probe resolves and the token contract holds', async () => {
		// The same work the ladder's own row does, run once here so the harness has a
		// covered failure path rather than only a green one on a runner. The ladder is the
		// gate; this is the evidence that the code behind it works when called.
		const rows = (await runPaint()) as CheckResult[];
		expect(rows.length).toBe(1);
		expect(rows[0]?.problems ?? []).toEqual([]);
		expect(rows[0]?.state).toBe('PASS');
		// A literal, so a deleted probe is a failure here rather than a smaller number on the
		// ladder, which does not fail.
		expect(rows[0]?.examined).toBe(16);
		expect(PROBES.length).toBe(16);
		expect(rows[0]?.unit).toBe('probes');
	}, 60_000);

	/**
	 * The failure path, driven against a deliberately broken stylesheet.
	 *
	 * This is how the other guards prove they can fail, and it is the only way to know that
	 * a green paint row means anything. The break is the real one: declare the chain once
	 * on the docs root and read the short name at the point of use, which is the
	 * optimisation the design pass proposed. It passes the check the token contract
	 * prescribes and fails only for a rebinding at or below the root, so a check without
	 * the descendant probe would have signed it off.
	 */
	test('an alias declared on the docs root is caught, and the message names the case', async () => {
		const rows = await paintWith((css) =>
			once(
				once(
					css,
					'.hx-root {\n\tcolor: var(--hx-ink, #f2ede6);',
					'.hx-root {\n\t--_link: var(--hx-accent-link, #5ba3f5);\n\tcolor: var(--hx-ink, #f2ede6);',
				),
				'.hx-root .hx-prose a,\n.hx-root .hx-banner a {\n\tcolor: var(--hx-accent-link, #5ba3f5);',
				'.hx-root .hx-prose a,\n.hx-root .hx-banner a {\n\tcolor: var(--_link);',
			),
		);
		expect(rows[0]?.state).toBe('FAIL');
		// Exactly one problem, and it is the descendant. The two placements the token
		// contract's own prescribed check uses still pass on the broken version, which is
		// the whole finding: a check without this probe would have signed it off.
		const problems = rows[0]?.problems ?? [];
		expect(problems.length).toBe(1);
		expect(problems[0]?.startsWith('An override on the descendant')).toBe(true);
	}, 60_000);

	/**
	 * Each layout probe, failed on purpose.
	 *
	 * Every edit puts back what the stylesheet said before step 8's fixes, or the nearest
	 * plausible wrong fix, and the problems that come back are exactly the ones naming that
	 * probe. "Exactly" is the point: a probe that only failed because a neighbour's edit
	 * broke the page too would pass here with a count check alone.
	 */
	const LAYOUT_BREAKS: { name: string; edit: (css: string) => string; expect: string[] }[] = [
		{
			name: 'a skip link hidden by moving it above the docs root',
			edit: (css) =>
				once(
					once(css, '.hx-root .hx-sr,\n.hx-root .hx-skip:not(:focus) {', '.hx-root .hx-sr {'),
					'transform: translateY(-0.5rem);',
					'transform: translateY(-120%);',
				),
			expect: ['The skip link paints'],
		},
		{
			name: 'a task paragraph left as a block',
			edit: (css) => once(css, '.hx-root .hx-task + p {\n\tdisplay: inline;\n}\n\n', ''),
			expect: ['A task list item does not read as one line'],
		},
		{
			name: 'a task item that lost the end margin its paragraph used to give',
			edit: (css) => once(css, '.hx-root li.hx-task-item {\n\tmargin-block-end: 1rem;\n}\n\n', ''),
			expect: ['A task list item does not read as one line'],
		},
		{
			name: 'an image display left to the host',
			edit: (css) =>
				once(
					css,
					'.hx-root .hx-image {\n\tdisplay: inline-block;\n\tvertical-align: middle;\n',
					'.hx-root .hx-image {\n',
				),
			expect: ['An image in a paragraph'],
		},
		{
			name: 'a shell with no inset of its own',
			edit: (css) =>
				once(css, '\tpadding-inline: var(--hx-shell-inset, clamp(1rem, 2.5vw, 2rem));\n}', '}'),
			expect: ['The gutter-phone probe', 'The gutter-desktop probe'],
		},
		{
			name: 'a shell sized to the viewport, which a padded host scrolls sideways',
			edit: (css) =>
				once(
					css,
					'\tmargin-inline: auto;\n\tpadding-inline:',
					'\tmargin-inline: auto;\n\tinline-size: 100vw;\n\tpadding-inline:',
				),
			expect: ['The gutter-padded-host probe'],
		},
		{
			name: 'a list marker left to the host',
			edit: (css) => once(css, '.hx-root ol.hx-list {\n\tlist-style-type: decimal;\n}\n\n', ''),
			expect: ['A host base layer changed the number:'],
		},
	];

	test.each(LAYOUT_BREAKS)(
		'$name is caught, and only that probe fails',
		async (entry) => {
			const rows = await paintWith(entry.edit);
			expect(rows[0]?.state).toBe('FAIL');
			const problems = rows[0]?.problems ?? [];
			expect({ problems, count: problems.length }).toMatchObject({ count: entry.expect.length });
			entry.expect.forEach((prefix, index) => {
				expect(problems[index]?.startsWith(prefix)).toBe(true);
			});
		},
		60_000,
	);
});
