import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

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
import {
	FRAGMENTS,
	PROBES,
	declarationProblems,
	declarationsOf,
	findBrowser,
	pixelOf,
	run as runPaint,
	terminatorsOf,
	withFallbacks,
} from '../scripts/check-paint.mjs';
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

	test('a partial status mark in a sentence', () => {
		expect(
			blocks([
				{
					type: 'paragraph',
					children: [
						text('Writing an NTAG424 DNA is '),
						{ type: 'status', value: 'partial' },
						text(' on iOS 18.2.'),
					],
				},
			]),
		).toBe(FRAGMENTS.status);
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
		// banner, and it carries the fences; the chip matrix carries the status marks.
		const rendered = [
			renderPage(await pageData({ manifest, site, locale: 'en', slug: 'guide/first-tag', load })),
			renderPage(
				await pageData({ manifest, site, locale: 'fr', slug: 'developer/architecture', load }),
			),
			renderPage(
				await pageData({ manifest, site, locale: 'ar', slug: 'reference/chip-support', load }),
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

describe('the declarations probe, without a browser', () => {
	// The parser and the substitution run in the page through their source text, so these are
	// the same functions the probe calls, held to the inputs a stylesheet can throw at them.
	const SHEET = [
		'/* a comment carrying ; and { */',
		".a,\n.b { color: red; content: ';{}'; }",
		'@media (min-width: 1px) {',
		'\t.c { background: url(data:image/png;base64,AAAA); transition-duration: 1ms !important }',
		'}',
	].join('\n');

	test('finds every declaration, inside a media query and past a string, a comment and a data url', () => {
		expect(declarationsOf(SHEET)).toEqual([
			{ selector: '.a, .b', property: 'color', value: 'red' },
			{ selector: '.a, .b', property: 'content', value: "';{}'" },
			{ selector: '.c', property: 'background', value: 'url(data:image/png;base64,AAAA)' },
			{ selector: '.c', property: 'transition-duration', value: '1ms' },
		]);
	});

	test('counts terminators without the parser, and a last declaration with none adds to what it finds', () => {
		expect(terminatorsOf(SHEET)).toBe(3);
		expect(declarationsOf(SHEET).length).toBe(4);
		expect(terminatorsOf(STYLESHEET())).toBe(declarationsOf(STYLESHEET()).length);
	});

	test('replaces each var() with its fallback, and gives up on one with none', () => {
		expect(withFallbacks('inset 2px 0 0 var(--hx-accent, #0b76d9)')).toBe('inset 2px 0 0 #0b76d9');
		expect(withFallbacks('var(--hx-font-body, var(--font-body, system-ui, sans-serif))')).toBe(
			'system-ui, sans-serif',
		);
		expect(withFallbacks('calc(var(--a, 1px) + var(--b, var(--c, 2px)))')).toBe('calc(1px + 2px)');
		expect(withFallbacks('color-mix(in srgb, var(--x, red) 12%, transparent)')).toBe(
			'color-mix(in srgb, red 12%, transparent)',
		);
		expect(withFallbacks('1px solid var(--hx-edge)')).toBeUndefined();
		expect(withFallbacks('calc(var(--a, var(--b)) * 2)')).toBeUndefined();
	});

	test('a parser that missed declarations fails, and so does one that validated none', () => {
		const reading = (fields: object): string =>
			JSON.stringify({
				terminators: 3,
				found: 3,
				validated: 3,
				skipped: [],
				invalid: [],
				...fields,
			});
		expect(declarationProblems(reading({}))).toEqual([]);
		const missed = declarationProblems(reading({ terminators: 10 }));
		expect(missed.length).toBe(1);
		expect(missed[0]?.startsWith('The declaration parser found 3')).toBe(true);
		const skipped = declarationProblems(reading({ validated: 0, skipped: [{}, {}, {}] }));
		expect(skipped.length).toBe(1);
		expect(skipped[0]?.startsWith('The declarations probe validated nothing: 3 of 3')).toBe(true);
		expect(declarationProblems(undefined)[0]?.includes('not a measurement')).toBe(true);
	});

	test('reads the colour of a one-pixel PNG, and refuses anything else', () => {
		// Built here rather than taken from a browser, so the decoder is held to the format and
		// not only to what one encoder happened to write: the pixel data is split across two
		// IDAT chunks, and the filter byte is Paeth.
		const chunk = (type: string, body: Buffer): Buffer => {
			const length = Buffer.alloc(4);
			length.writeUInt32BE(body.length);
			return Buffer.concat([length, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]);
		};
		const png = (width: number, colourType: number, raw: number[]): string => {
			const header = Buffer.alloc(13);
			header.writeUInt32BE(width, 0);
			header.writeUInt32BE(1, 4);
			header[8] = 8;
			header[9] = colourType;
			const data = deflateSync(Buffer.from(raw));
			const half = Math.floor(data.length / 2);
			return Buffer.concat([
				Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
				chunk('IHDR', header),
				chunk('IDAT', data.subarray(0, half)),
				chunk('IDAT', data.subarray(half)),
				chunk('IEND', Buffer.alloc(0)),
			]).toString('base64');
		};
		expect(pixelOf(png(1, 2, [4, 11, 118, 217]))).toEqual([11, 118, 217]);
		expect(pixelOf(png(1, 6, [0, 240, 196, 122, 255]))).toEqual([240, 196, 122]);
		expect(() => pixelOf(png(2, 2, [0, 1, 2, 3, 4, 5, 6]))).toThrow(/one-pixel/);
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
		expect(rows[0]?.examined).toBe(23);
		expect(PROBES.length).toBe(23);
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
			// The phone bar pulls out of the layout's inset by exactly that inset and pads back in,
			// so with no inset to pull out of it runs past both edges and its Pages link ends on
			// the edge of the screen. That is the same defect seen from the bar, not a neighbour's.
			expect: ['The gutter-phone probe', 'The gutter-desktop probe', 'The phone-targets probe'],
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
		{
			name: 'the tree list shown while its disclosure is closed',
			edit: (css) =>
				once(
					css,
					'\t.hx-root .hx-tree-disclosure:not([open]) + .hx-tree-list {\n\t\tdisplay: none;\n\t}\n\n',
					'',
				),
			expect: ['The phone-reading probe'],
		},
		{
			name: 'a bar that scrolls away with the article',
			edit: (css) => once(css, '\t\tposition: sticky;\n\t\tinset-block-end: 0;\n', ''),
			expect: ['The phone-foot probe'],
		},
		{
			name: 'an outline panel left at its static position',
			edit: (css) => once(css, '\t\tinset-block-end: 100%;\n', ''),
			expect: ['The phone-foot probe'],
		},
		{
			name: 'a bar label that is small and dim before it has anything to say',
			edit: (css) =>
				once(
					css,
					'\t.hx-root .hx-toc-summary:has(.hx-toc-here:empty) .hx-toc-summary-label {\n\t\tcolor: var(--hx-ink, #f2ede6);\n\t\tfont-size: 0.9375rem;\n\t\tline-height: 1.4;\n\t}\n\n',
					'',
				),
			expect: ['The phone-foot probe'],
		},
		{
			name: 'rows under the 44px floor',
			edit: (css) =>
				once(
					css,
					'\t\tmin-block-size: 2.75rem;\n\t\tpadding-block: 0.5rem;\n',
					'\t\tpadding-block: 0.5rem;\n',
				),
			expect: ['The phone-targets probe'],
		},
		{
			name: 'a Pages chip that states no display of its own at phone width',
			edit: (css) =>
				once(
					css,
					'\t.hx-root .hx-tree-summary {\n\t\tdisplay: flex;\n',
					'\t.hx-root .hx-tree-summary {\n',
				),
			expect: ['The phone-targets probe'],
		},
		{
			name: 'a bar link that stays hidden at phone width',
			edit: (css) =>
				once(
					css,
					'\t.hx-root .hx-foot-pages {\n\t\tdisplay: flex;\n',
					'\t.hx-root .hx-foot-pages {\n',
				),
			expect: ['The phone-targets probe'],
		},
		{
			name: 'a bar that bleeds to the edge and never pads back in',
			edit: (css) =>
				once(
					css,
					'\t\tpadding-inline: var(--hx-shell-inset, clamp(1rem, 2.5vw, 2rem));\n\t\tpadding-block-end:',
					'\t\tpadding-block-end:',
				),
			expect: ['The phone-targets probe'],
		},
	];

	/**
	 * The declarations probe and the direction probes, failed on purpose.
	 *
	 * One mutation per rule, each chosen so exactly one probe can see it, and then the defect
	 * as it shipped, which four probes see at once. The fallback typo is the case that proves
	 * the substitution is real: `CSS.supports` answers true for any value holding a `var()`,
	 * so a probe that passed values through unchanged would accept `#2a262` and every other
	 * typo inside a token chain.
	 */
	const DIRECTION_BREAKS: { name: string; edit: (css: string) => string; expect: string[] }[] = [
		{
			name: 'a logical keyword a property does not have',
			edit: (css) =>
				once(
					css,
					'\ttext-align: end;\n\tuser-select: none;',
					'\ttext-align: inline-end;\n\tuser-select: none;',
				),
			expect: [
				'A declaration the browser does not accept: `.hx-root .hx-line-number` declares `text-align: inline-end`.',
			],
		},
		{
			name: 'a typo inside a token fallback',
			edit: (css) =>
				once(
					css,
					'.hx-root .hx-step {\n\tborder-inline-start: 2px solid var(--hx-edge, #2a2621);',
					'.hx-root .hx-step {\n\tborder-inline-start: 2px solid var(--hx-edge, #2a262);',
				),
			expect: [
				'A declaration the browser does not accept: `.hx-root .hx-step` declares `border-inline-start: 2px solid var(--hx-edge, #2a262)`, tested as `2px solid #2a262`',
			],
		},
		{
			name: 'a partial mark with no right-to-left mirror',
			edit: (css) =>
				once(
					css,
					'.hx-root .hx-status-half:dir(rtl) { background: linear-gradient(to left, currentColor 50%, transparent 50%); }\n',
					'',
				),
			expect: [
				'The partial status mark in the sides-rtl probe is filled on the left half, where its inline-start half is the right.',
			],
		},
		{
			name: 'a partial mark mirrored on the docs root rather than on the mark',
			edit: (css) =>
				once(css, '.hx-root .hx-status-half:dir(rtl) {', '.hx-root:dir(rtl) .hx-status-half {'),
			expect: [
				'The partial status mark in the sides-fallback probe is filled on the right half, where its inline-start half is the left.',
			],
		},
		{
			name: 'a current-item bar with no right-to-left mirror',
			edit: (css) =>
				once(
					css,
					".hx-root [aria-current='page']:dir(rtl),\n.hx-root [aria-current='true']:dir(rtl) {\n\tbox-shadow: inset -2px 0 0 var(--hx-accent, #0b76d9);\n}\n",
					'',
				),
			expect: [
				'The current-item bar in the sides-rtl probe belongs on the right edge, and it is on the left edge of the tree link and the left edge of the table of contents link.',
			],
		},
		{
			name: 'a current-item bar on the right in both directions',
			edit: (css) =>
				once(
					css,
					'\tcolor: var(--hx-accent-link, #5ba3f5);\n\tbox-shadow: inset 2px 0 0',
					'\tcolor: var(--hx-accent-link, #5ba3f5);\n\tbox-shadow: inset -2px 0 0',
				),
			expect: [
				'The current-item bar in the sides-ltr probe belongs on the left edge, and it is on the right edge of the tree link and the right edge of the table of contents link.',
			],
		},
		{
			name: 'the partial mark as it shipped, with a gradient direction no engine parses',
			edit: (css) =>
				once(
					css,
					'.hx-root .hx-status-half { background: linear-gradient(to right, currentColor 50%, transparent 50%); }\n.hx-root .hx-status-half:dir(rtl) { background: linear-gradient(to left, currentColor 50%, transparent 50%); }',
					'.hx-root .hx-status-half { background: linear-gradient(to inline-end, currentColor 50%, transparent 50%); }',
				),
			expect: [
				'A declaration the browser does not accept: `.hx-root .hx-status-half` declares `background: linear-gradient(to inline-end, currentColor 50%, transparent 50%)`.',
				'The partial status mark in the sides-rtl probe computes background-image none',
				'The partial status mark in the sides-fallback probe computes background-image none',
				'The partial status mark in the sides-ltr probe computes background-image none',
			],
		},
	];

	test.each([...LAYOUT_BREAKS, ...DIRECTION_BREAKS])(
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
