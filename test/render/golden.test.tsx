import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { AST_NODE_TYPES } from '../../src/contracts/ast.js';
import type { Locale } from '../../src/contracts/locales.js';
import type { CompiledPage } from '../../src/contracts/page.js';
import { NO_EMIT } from '../../src/render/context.js';
import { PlainLink, renderBlocks } from '../../src/render/nodes.js';
import { GOLDEN_ROOT, REPO_ROOT, goldenPage } from '../support/golden.js';
import { formatMarkup } from '../support/render.js';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The pages whose rendered body is goldened, and what each is here to cover.
 *
 * The set is small on purpose: a golden nobody reads is a golden that gets accepted, and
 * eight bodies is already several thousand lines. What keeps it honest is the assertion
 * below, which checks the union of node types these pages contain against
 * `AST_NODE_TYPES` in both directions. A corpus edit that moves the only fence out of
 * `developer/architecture` regenerates every golden cleanly and takes the `code` arm out
 * of coverage with nothing naming it; that assertion is what names it.
 */
const BODIES: { locale: Locale; slug: string; why: string }[] = [
	{
		locale: 'en',
		slug: 'index',
		why: 'Every inline kind on one page: all four link kinds, a hard break, emphasis, strong and a thematic break.',
	},
	{
		locale: 'en',
		slug: 'guide/first-tag',
		why: 'The only pages with a figure and an ordered procedure, which are the two node types with no instance in the real corpus.',
	},
	{
		locale: 'en',
		slug: 'guide/troubleshooting',
		why: 'Blockquote, strikethrough and a heading the compiler filtered out of the table of contents.',
	},
	{
		locale: 'en',
		slug: 'reference/chip-support',
		why: 'The support matrix: a wide table and every one of the four status values.',
	},
	{
		locale: 'en',
		slug: 'reference/api',
		why: 'A fence with startLine 12 and highlight 2,5-7, which is the coordinate system three of four designs got backwards.',
	},
	{
		locale: 'en',
		slug: 'developer/architecture',
		why: 'The second highlighted fence, at startLine 48, and a box-drawing diagram in an unlabelled one.',
	},
	{
		locale: 'ar',
		slug: 'index',
		why: 'Right to left, with Latin identifiers inside Arabic sentences, which is what the bidi isolation is for.',
	},
	{
		locale: 'ja',
		slug: 'reference/chip-support',
		why: 'The same matrix in Japanese: status labels are read from the reader locale, not from the content.',
	},
];

const RENDER_GOLDEN = join(REPO_ROOT, 'test', 'golden', 'render');
const UPDATE = process.env.UPDATE_RENDER_GOLDEN === '1';

interface RenderGolden {
	/**
	 * sha256 of the compiled page file this was produced from.
	 *
	 * The renderer's goldens are produced from the compiler's goldens, so a kit
	 * regeneration that nobody re-ran this suite against would leave every assertion here
	 * green about yesterday's compiler. With the digest, an update run over stale input
	 * fails naming the file instead of writing the wrong answer into something that then
	 * looks like evidence.
	 */
	source: string;
	html: string;
}

/**
 * Non-ASCII escaped, exactly as the compiler's goldens are.
 *
 * Two reasons, and the second is the better one. The house lint reads every file in this
 * repository and the corpus plants an en dash, an em dash and an arrow on purpose, and the
 * exemption mechanism is scoped to `fixtures/`; widening it to reach a test directory would
 * be the hole it exists to refuse. And a golden is the one place an invisible character has
 * to be visible: U+FE0F and U+200F are load-bearing in this corpus and a reviewer cannot
 * see either of them in a diff.
 */
function escapeGolden(value: RenderGolden): string {
	const escaped = JSON.stringify(value, null, '\t').replace(
		/[\u0080-\uffff]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
	);
	return `${escaped}\n`;
}

function readGolden(path: string): RenderGolden | undefined {
	return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as RenderGolden) : undefined;
}

function writeGolden(path: string, value: RenderGolden): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, escapeGolden(value), 'utf8');
}

/** Every node type this body contains, so the set can be checked against the union. */
function typesIn(value: unknown, found: Set<string>): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) typesIn(item, found);
	} else if (typeof value === 'object' && value !== null) {
		const type = (value as { type?: unknown }).type;
		if (typeof type === 'string') found.add(type);
		for (const item of Object.values(value)) typesIn(item, found);
	}
	return found;
}

/** One page's body, rendered the one way this suite renders a body. */
function renderBody(page: CompiledPage, locale: Locale): string {
	return formatMarkup(
		renderToStaticMarkup(
			<>
				{renderBlocks(page.body, {
					locale,
					contentLocale: page.locale,
					address: { basePath: '/fixture-app/docs', locale },
					bundleBase: '/_docs/fixture-app/1.1.0',
					Link: PlainLink,
					emit: NO_EMIT,
				})}
			</>,
		),
	);
}

describe('the rendered body of every goldened page', () => {
	test.each(BODIES)('$locale/$slug: $why', ({ locale, slug }) => {
		const source = goldenPage(locale, slug);
		const html = renderBody(source.page, locale);
		const path = join(RENDER_GOLDEN, 'body', locale, `${slug}.json`);
		const existing = readGolden(path);

		if (UPDATE) {
			writeGolden(path, { source: source.digest, html });
			return;
		}

		// A first write during an ordinary run is a failure, not a pass. Otherwise a new
		// case arrives with a golden nobody looked at, which is the whole failure mode
		// goldens exist to prevent.
		expect(
			existing,
			`No golden at ${path}. Run UPDATE_RENDER_GOLDEN=1 and read the diff.`,
		).toBeDefined();

		// The currency check, before the comparison. A mismatch here means the compiler's
		// golden changed and this one was not regenerated, so the diff below would be
		// about the wrong thing.
		expect(
			existing?.source,
			`${source.file} has changed since this golden was written. Regenerate with UPDATE_RENDER_GOLDEN=1.`,
		).toBe(source.digest);

		expect(html).toBe(existing?.html);
	});

	test('the goldened pages together contain every node type, in both directions', () => {
		// The lesson `fixtures/nodes.ts` was written for, one step along. Without this, a
		// corpus edit that moves the only instance of a node type out of a goldened page
		// regenerates cleanly and silently stops exercising that arm.
		const found = new Set<string>();
		for (const entry of BODIES) typesIn(goldenPage(entry.locale, entry.slug).page.body, found);
		const covered = [...found].filter((type) =>
			(AST_NODE_TYPES as readonly string[]).includes(type),
		);
		expect(covered.sort()).toEqual([...AST_NODE_TYPES].sort());
		// And nothing in the bodies is a type the union does not declare, which would mean
		// a payload compiled at a major this runtime does not know.
		expect(
			[...found].filter((type) => !(AST_NODE_TYPES as readonly string[]).includes(type)),
		).toEqual([]);
		expect(covered.length).toBe(AST_NODE_TYPES.length);
	});

	test('every goldened body claims a distinct reason for being goldened', () => {
		const reasons = BODIES.map((entry) => entry.why);
		expect(new Set(reasons).size).toBe(reasons.length);
		for (const why of reasons) expect(why.length).toBeGreaterThan(40);
	});

	test('no golden is too large for a person to read', () => {
		// A three hundred kilobyte golden is a golden nobody reads, and a golden nobody
		// reads is a golden that gets accepted.
		for (const entry of BODIES) {
			const path = join(RENDER_GOLDEN, 'body', entry.locale, `${entry.slug}.json`);
			const golden = readGolden(path);
			if (golden === undefined) continue;
			const bytes = escapeGolden(golden).length;
			expect({ path, tooLarge: bytes > 120_000 }).toEqual({ path, tooLarge: false });
		}
	});

	test('no golden carries a path from the machine that wrote it', () => {
		// A golden that differs per machine fails for the next person and gets regenerated
		// rather than read, which is how a golden stops being evidence.
		for (const entry of BODIES) {
			const path = join(RENDER_GOLDEN, 'body', entry.locale, `${entry.slug}.json`);
			const golden = readGolden(path);
			if (golden === undefined) continue;
			expect(golden.html).not.toContain(REPO_ROOT);
			expect(golden.html).not.toContain('node_modules');
		}
	});

	test('rendering the same page twice produces the same bytes', () => {
		// This replaces a scan for an ISO timestamp, which refused the wrong thing: the
		// corpus contains one, in the API reference, as documentation content, and it is as
		// deterministic as the rest of the page. Rendering twice is the property that scan
		// was reaching for, and it also catches a random id, an iteration order that depends
		// on insertion and anything else that would make a golden differ between runs.
		let compared = 0;
		for (const entry of BODIES) {
			const source = goldenPage(entry.locale, entry.slug);
			const once = renderBody(source.page, entry.locale);
			const twice = renderBody(source.page, entry.locale);
			expect({ page: `${entry.locale}/${entry.slug}`, same: once === twice }).toEqual({
				page: `${entry.locale}/${entry.slug}`,
				same: true,
			});
			compared += 1;
		}
		expect(compared).toBe(BODIES.length);
	});
});

describe('the golden directory', () => {
	test('sits beside the compiler goldens it is produced from', () => {
		expect(existsSync(GOLDEN_ROOT)).toBe(true);
	});
});
