/**
 * `hexdocs page`, and the window it cuts.
 *
 * The pagination is the whole of the risk here, and the failure it exists to stop is
 * invisible to whoever asked for the window. A byte offset lands in the middle of a
 * Japanese or an Arabic character and produces mojibake at the seam; a UTF-16 offset
 * lands between the halves of a surrogate pair and produces two replacement characters
 * that rejoining the windows does not put back. Neither throws, neither is visible in
 * English, and the six languages it breaks are the six nobody in this repository can
 * proofread. So the round trip is driven over the real Japanese and Arabic pages by
 * name, in windows small enough that a wrong cut has many chances to happen.
 *
 * The walk runs in `--bundle` mode, which is a saving and also the mode worth walking:
 * it is the published-docs interface, the text comes back off disk as a gzip member
 * rather than out of a compiler that has the string in hand, and a source-tree call is
 * asserted to return the same document so the two cannot drift.
 *
 * **What the corpus cannot prove**, stated rather than glossed: it contains no astral
 * character, so no page in it can catch a `String.prototype.slice` cut. The corpus proves
 * the byte case and the paragraph snap; `windowOf` is driven directly with a synthetic
 * surrogate pair for the other half, and that case names the exact index a UTF-16 slice
 * would break at.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus } from '../../../fixtures/index.js';
import type { Locale } from '../../../src/contracts/locales.js';
import { buildBundle } from '../../src/compile/build.js';
import { writeBundle } from '../../src/compile/bundle.js';
import { nearestSlugs, page, windowOf, type PageResult } from '../../src/commands/page.js';
import { exitCodeFor, invoke, type Ctx } from '../../src/registry/command.js';

const KIT_VERSION = '@hex-pro/docs-kit@0.0.0';

let root: string;
let corpus: string;
/** The `ast-N` directory of a bundle written out of the same tree. */
let prefix: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'hexdocs-page-'));
	corpus = materialiseCorpus(join(root, 'repo')).root;
	const built = buildBundle(corpus, { generator: KIT_VERSION });
	expect(built.manifestProblems).toEqual([]);
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
			throw new Error('page ran a process. It compiles in memory or reads a bundle.');
		},
		write: null,
		now: () => new Date('2026-01-01T00:00:00Z'),
		log: () => {},
	};
}

/** One window out of the written bundle, which needs no compile and no network. */
async function read(input: Record<string, unknown>): Promise<PageResult> {
	const out = await invoke(page, { root: corpus, bundle: prefix, ...input }, ctx(root));
	expect(out.rows, JSON.stringify(out.data)).toEqual([]);
	return out.data as unknown as PageResult;
}

/** The same window, compiled out of the source tree instead. */
async function readSource(input: Record<string, unknown>): Promise<PageResult> {
	const out = await invoke(page, { root: corpus, ...input }, ctx(root));
	expect(out.rows, JSON.stringify(out.data)).toEqual([]);
	return out.data as unknown as PageResult;
}

/**
 * A lone surrogate anywhere in the text, which is what a UTF-16 cut leaves behind.
 *
 * Written as a code point range rather than a literal so the file carries no unpaired
 * surrogate of its own, and so the test says what it is looking for rather than matching
 * a character somebody would have to decode by hand.
 */
function hasLoneSurrogate(text: string): boolean {
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return true;
		}
	}
	return false;
}

/** Just after a blank line, which is where a markdown window is allowed to end. */
const PARAGRAPH_BREAK = /\n[ \t\r]*\n/;

/**
 * The two pages this file is about, named because the property is about their script.
 *
 * Both are multi-byte in UTF-8 throughout, which is what makes a byte cut and a code
 * point cut different answers rather than the same one. The assertion that they really
 * are is in the round trip, so a corpus edit that replaced them with Latin text fails
 * here instead of leaving the walk passing over nothing.
 *
 * `reference/chip-support` earns its place separately: it is one long table with no blank
 * line in it for hundreds of code points, which is the case where the snap finds nothing
 * to snap to and the window has to fall back to the hard limit.
 */
const NON_LATIN: readonly { slug: string; locale: Locale }[] = [
	{ slug: 'guide/troubleshooting', locale: 'ja' },
	{ slug: 'guide/troubleshooting', locale: 'ar' },
	{ slug: 'reference/chip-support', locale: 'ja' },
	{ slug: 'reference/chip-support', locale: 'ar' },
];

/** Small enough that each page needs several windows, large enough to clear a paragraph. */
const LIMIT = 400;

describe('windowOf', () => {
	test('an astral character is one unit, at the index a UTF-16 slice would split', () => {
		const text = `a\u{1F600}b`;

		// The premise, measured rather than asserted: this string is three code points and
		// four UTF-16 units, so index 2 is the middle of the pair.
		expect(Array.from(text)).toHaveLength(3);
		expect(text.length).toBe(4);
		expect(hasLoneSurrogate(text.slice(0, 2))).toBe(true);

		const first = windowOf(text, 0, 2, false);
		expect(first.text).toBe(`a\u{1F600}`);
		expect(first.total).toBe(3);
		expect(first.nextOffset).toBe(2);
		expect(hasLoneSurrogate(first.text)).toBe(false);

		const second = windowOf(text, first.nextOffset as number, 2, false);
		expect(second.text).toBe('b');
		expect(second.nextOffset).toBeNull();
		expect(first.text + second.text).toBe(text);
	});

	test('the start is never snapped, so two windows never overlap', () => {
		const text = 'one\n\ntwo\n\nthree\n\nfour\n';
		const window = windowOf(text, 5, 4, true);
		// An offset typed by hand gets exactly the offset it asked for. Snapping it back to
		// the paragraph above would make an agent concatenating windows duplicate a
		// paragraph, and a run of pages would come back longer than the pages are.
		expect(window.offset).toBe(5);
		expect(window.text.startsWith('two')).toBe(true);
	});

	test('the end of the document is not snapped backwards', () => {
		const text = 'one\n\ntwo\n';
		const whole = windowOf(text, 0, 1000, true);
		expect(whole.text).toBe(text);
		expect(whole.nextOffset).toBeNull();
		expect(whole.truncated).toBe(false);
	});
});

describe('paging a non-Latin page', () => {
	for (const { slug, locale } of NON_LATIN) {
		test(`${slug} in ${locale} round trips through nextOffset`, async () => {
			const whole = await read({ slug, locale, limit: 1_000_000 });
			expect(whole.truncated).toBe(false);
			expect(whole.nextOffset).toBeNull();

			// The premise. A page that is ASCII would make every assertion below pass while
			// proving nothing about the cut, because bytes, UTF-16 units and code points would
			// all be the same number.
			expect(Buffer.byteLength(whole.text, 'utf8')).toBeGreaterThan(whole.total);

			const windows: string[] = [];
			let offset: number | null = 0;
			let guard = 0;
			while (offset !== null) {
				guard += 1;
				expect(guard).toBeLessThan(100);
				const one: PageResult = await read({ slug, locale, offset, limit: LIMIT });
				expect(one.offset).toBe(offset);
				expect(one.total).toBe(whole.total);
				expect(hasLoneSurrogate(one.text)).toBe(false);
				// A window that came back empty would page forever, and the loop guard above
				// would be the only thing that noticed.
				expect(Array.from(one.text).length).toBeGreaterThan(0);

				if (one.nextOffset !== null) {
					// Where there was a paragraph break to cut at, the window ends at one. Where
					// there was not, and the chip matrix is a table long enough that there is
					// not, the window ends at the hard limit and carries no break at all: a
					// window holding a break somewhere other than its end is a snap that did not
					// happen.
					const snapped = PARAGRAPH_BREAK.test(one.text);
					expect(snapped ? /\n[ \t\r]*\n$/.test(one.text) : true, `${slug}/${locale}`).toBe(true);
					if (!snapped) expect(Array.from(one.text)).toHaveLength(LIMIT);
				}

				windows.push(one.text);
				offset = one.nextOffset;
			}

			// More than one window, or the round trip is a single call and proves nothing.
			expect(windows.length).toBeGreaterThan(1);
			expect(windows.join('')).toBe(whole.text);
		});
	}

	test('a page with paragraphs really does snap, on both scripts', async () => {
		// The assertion inside the walk allows the no-break fallback, so on its own it is
		// satisfied by an implementation that never snaps at all. This is the other half:
		// the two prose pages must produce at least one window that ended at a break.
		for (const locale of ['ja', 'ar'] as const) {
			let offset: number | null = 0;
			let snapped = 0;
			while (offset !== null) {
				const one: PageResult = await read({
					slug: 'guide/troubleshooting',
					locale,
					offset,
					limit: LIMIT,
				});
				if (one.nextOffset !== null && /\n[ \t\r]*\n$/.test(one.text)) snapped += 1;
				offset = one.nextOffset;
			}
			expect(snapped, locale).toBeGreaterThan(0);
		}
	});

	test('the bundle and the source tree return the same document', async () => {
		for (const { slug, locale } of NON_LATIN) {
			const fromBundle = await read({ slug, locale, limit: 1_000_000 });
			const fromSource = await readSource({ slug, locale, limit: 1_000_000 });
			expect(fromSource.text, `${slug}/${locale}`).toBe(fromBundle.text);
			expect(fromSource.total).toBe(fromBundle.total);
		}
	});
});

describe('the AST format', () => {
	const AST = { slug: 'guide/troubleshooting', locale: 'ja', format: 'ast' } as const;

	test('is not snapped, and its windows concatenate to the payload', async () => {
		const whole = await read({ ...AST, limit: 1_000_000 });
		// Canonical JSON carries no literal newline at all, so a paragraph snap could only
		// ever fail here. `windowOf` is called with `snap` off rather than left to fall back,
		// and the observable consequence is that a window ends exactly at the limit.
		expect(whole.text).not.toContain('\n');

		const first = await read({ ...AST, limit: 200 });
		expect(first.nextOffset).toBe(200);
		expect(Array.from(first.text)).toHaveLength(200);

		const rest = await read({ ...AST, offset: 200, limit: 1_000_000 });
		expect(first.text + rest.text).toBe(whole.text);
		expect(JSON.parse(whole.text)).toBeTypeOf('object');
	});
});

describe('nearestSlugs', () => {
	test('ranks a dropped section prefix above an edit-distance match', () => {
		const candidates = ['guide/first-tag', 'guide/index', 'reference/index', 'index'];
		// Containment first, because the commonest mistake is a slug with its section
		// dropped, and edit distance ranks that badly: the missing prefix costs six edits.
		expect(nearestSlugs('first-tag', candidates)[0]).toBe('guide/first-tag');
		expect(nearestSlugs('guide/indx', candidates)).toContain('guide/index');
	});

	test('a query that resembles nothing returns nothing', () => {
		expect(nearestSlugs('qqqqqqqqqqqq', ['guide/first-tag', 'index'])).toEqual([]);
	});
});

describe('a slug that does not exist', () => {
	test('is a not-run row naming the near matches, never an empty page', async () => {
		const out = await invoke(page, { slug: 'first-tag', root: corpus }, ctx(root));

		expect(out.rows).toHaveLength(1);
		const row = out.rows[0] as (typeof out.rows)[number];
		expect(row.status).toBe('not-run');
		expect(row.id).toBe('page');
		expect(row.unit).toBe('pages');
		expect(row.note).toContain('guide/first-tag');
		expect(exitCodeFor(out)).toBe(3);

		// An empty success is the one answer this command must never give, because it is
		// indistinguishable from a page that is genuinely empty. The refusal carries no
		// `text` key at all rather than an empty one.
		const data = out.data as Record<string, unknown>;
		expect(data['read']).toBe(false);
		expect(Object.keys(data)).not.toContain('text');
	});

	test('is refused the same way out of a bundle, naming the bundle', async () => {
		const out = await invoke(page, { slug: 'first-tag', root: corpus, bundle: prefix }, ctx(root));

		expect(out.rows[0]?.status).toBe('not-run');
		expect(out.rows[0]?.note).toContain('guide/first-tag');
		expect(out.rows[0]?.note).toContain(prefix);
		expect(exitCodeFor(out)).toBe(3);
	});

	test('a locale with no file for a real page is refused too, naming the ones that exist', async () => {
		const out = await invoke(
			page,
			{ slug: 'developer/architecture', root: corpus, locale: 'ja' },
			ctx(root),
		);

		expect(out.rows[0]?.status).toBe('not-run');
		// Returning the English text under a Japanese address is what the site does for a
		// reader, with a notice. An agent gets no notice, so it would read English and
		// believe it had read Japanese.
		expect(out.rows[0]?.note).toContain('en');
		expect(exitCodeFor(out)).toBe(3);
	});

	test('a limit of zero is refused rather than clamped', async () => {
		const out = await invoke(page, { slug: 'index', root: corpus, limit: 0 }, ctx(root));

		expect(out.rows[0]?.status).toBe('not-run');
		expect(out.rows[0]?.note).toContain('page forever');
		expect(exitCodeFor(out)).toBe(3);
	});
});
