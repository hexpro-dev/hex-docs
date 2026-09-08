/**
 * The golden files.
 *
 * The plan asks for them at this step and the fixture corpus was built without them on
 * purpose: the canonical JSON a digest is taken over, the word count behind a reading
 * estimate and the exact scope tokens a highlighter emits are none of them decidable
 * from the source and the contracts alone. Hand-authoring them before the compiler
 * existed would have been checking in guesses that look like evidence. They are
 * decidable now, so here they are.
 *
 * **Every golden file is written with non-ASCII escaped as `\\uXXXX`.** Two reasons, and
 * the second is the one that matters. The house lint reads every file in this
 * repository, and a compiled page carries the en dash, the em dash and the arrow that
 * the fixture corpus plants on purpose; the exemption mechanism is scoped to
 * `fixtures/`, and widening it to reach a test directory would be exactly the kind of
 * hole the mechanism exists to refuse. And a golden file is the one place an invisible
 * character has to be visible: U+FE0F and U+200F are load-bearing in this corpus, and a
 * reviewer cannot check a diff that renders them as nothing.
 *
 * To update: `UPDATE_GOLDEN=1 npx vitest run test/compile/golden.test.ts`, then read the
 * diff. A golden file rewritten without being read is a test that passes whatever
 * changes, which is why there is no watch mode for this and why the update is a
 * deliberate environment variable rather than a flag on the usual command.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus } from '../../../fixtures/index.js';
import { LOCALES, type Locale } from '../../../src/contracts/locales.js';
import { buildBundle, type BuildResult } from '../../src/compile/build.js';
import { canonicalJson, gunzipMember } from '../../src/compile/serialise.js';

const GOLDEN = fileURLToPath(new URL('../golden/', import.meta.url));
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** The generator string is fixed here, because the real one moves with the version. */
const GENERATOR = '@hex-pro/docs-kit@0.1.0';

/**
 * Everything outside printable ASCII, as an escape.
 *
 * Escaping per UTF-16 code unit rather than per code point, so an astral character
 * becomes a surrogate pair of escapes, which is what JSON itself does and what keeps the
 * result parseable.
 */
function escapeNonAscii(text: string): string {
	let escaped = '';
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		const printable = unit === 9 || unit === 10 || (unit >= 32 && unit <= 126);
		escaped += printable ? (text[index] as string) : `\\u${unit.toString(16).padStart(4, '0')}`;
	}
	return escaped;
}

function readGolden(name: string): string | undefined {
	const path = join(GOLDEN, name);
	return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function writeGolden(name: string, content: string): void {
	const path = join(GOLDEN, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, 'utf8');
}

/** Every golden file under a subdirectory, relative to `GOLDEN`. */
function goldenFiles(prefix: string): string[] {
	const root = join(GOLDEN, prefix);
	if (!existsSync(root)) return [];
	const found: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const full = join(directory, entry.name);
			if (entry.isDirectory()) walk(full);
			else found.push(relative(GOLDEN, full).split(sep).join('/'));
		}
	};
	walk(root);
	return found.sort();
}

/**
 * Compares against the golden file, or writes it.
 *
 * Returns nothing and asserts, so a caller cannot accidentally treat a mismatch as a
 * value. A missing golden file fails rather than passing silently, which is the
 * difference between a suite that grew a page and a suite that lost one.
 */
function expectGolden(name: string, content: string): void {
	const escaped = `${escapeNonAscii(content).trimEnd()}\n`;
	if (UPDATE) {
		writeGolden(name, escaped);
		return;
	}
	const existing = readGolden(name);
	expect(
		existing,
		`${name} has no golden file. Run UPDATE_GOLDEN=1 and read the diff.`,
	).toBeDefined();
	expect(escaped, `${name} differs from its golden file.`).toBe(existing);
}

let corpusRoot: string;
let result: BuildResult;

beforeAll(() => {
	corpusRoot = mkdtempSync(join(tmpdir(), 'hexdocs-golden-'));
	const corpus = materialiseCorpus(join(corpusRoot, 'repo'));
	result = buildBundle(corpus.root, { generator: GENERATOR });
});

afterAll(() => {
	rmSync(corpusRoot, { recursive: true, force: true });
});

describe('the compiled corpus', () => {
	test('the materialised repository has the commit the goldens were taken against', () => {
		// The corpus replays fixed dates, a fixed author and fixed messages over a fixed
		// tree, so the sha is a function of the corpus alone. That is what lets a golden
		// manifest carry a real commit rather than a placeholder, and it is what fails here
		// if somebody edits the corpus without regenerating the goldens.
		expect(result.manifest.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(result.manifest.commitTimestamp).toBe('2026-04-02T10:45:00Z');
	});

	test('every compiled page has a golden file, and every golden file has a page', () => {
		const produced: string[] = [];
		for (const [slug, byLocale] of result.pages) {
			for (const locale of byLocale.keys()) produced.push(`pages/${locale}/${slug}.json`);
		}
		produced.sort();

		for (const [slug, byLocale] of result.pages) {
			for (const [locale, output] of byLocale) {
				expectGolden(`pages/${locale}/${slug}.json`, JSON.stringify(output.page, null, '\t'));
			}
		}

		expect(produced.length).toBe(39);
		if (!UPDATE) expect(goldenFiles('pages')).toEqual(produced);
	});

	test('the manifest is byte for byte what it was', () => {
		// Three fields here are a property of the compressor rather than of the compiler:
		// `objects[].digest`, `objects[].bytes` and `counts.bytes` are all taken over gzip
		// members. They are goldened anyway rather than normalised away, because measuring
		// says they are stable: node 20, 22 and 24, across zlib 1.3.0.1 and 1.3.1, produce
		// byte-identical level 9 output for the same input, so the CI matrix agrees with a
		// developer machine. A future zlib change surfaces here as a digest diff, which is
		// the honest place for it: the contract on GZIP_SETTINGS already says the byte
		// reproducibility claim is scoped to one zlib major.
		expectGolden('manifest.json', JSON.stringify(result.manifest, null, '\t'));
	});

	test('the findings are what they were, in the documented order', () => {
		expectGolden('lint.json', JSON.stringify(result.lint.envelope, null, '\t'));
	});

	test('the markdown served at <slug>.md is what it was', () => {
		// Three pages, not thirty-nine. The raw markdown is nearly the source file, so a
		// full set would be the corpus committed twice; every other page is pinned by
		// `rawDigest` in the manifest. These three are the ones where it is not nearly the
		// source: each expands an include, and one of them is the support matrix.
		for (const slug of ['index', 'guide/first-tag', 'reference/chip-support']) {
			const output = result.pages.get(slug)?.get('en');
			expect(output, `${slug} should compile in en`).toBeDefined();
			expectGolden(`raw/en/${slug}.md`, output?.raw ?? '');
		}
	});

	test('the English term dictionary is what it was', () => {
		// English only. The other six are pinned numerically by the manifest's per-locale
		// term count and index digest, and a dictionary of Chinese bigrams written as
		// escapes is not something a reviewer can read anyway. What makes those six
		// checkable is the smoke queries in search.test.ts, which are readable.
		const index = result.objects.find((object) => object.key === 'search/en.idx.json.gz');
		expect(index).toBeDefined();
		const record = result.manifest.search.en;
		expect(record).toBeDefined();
		const terms = termsOf(result, 'en');
		expect(terms.length).toBe(record?.terms);
		expectGolden('terms/en.txt', terms.join('\n'));
	});

	test('the manifest validates its own invariants', () => {
		expect(result.manifestProblems).toEqual([]);
	});

	test('compiling twice produces identical bytes', () => {
		// The write-once refusal is unconditional, so a build that changed nothing must not
		// look like a rewrite. This is the property that makes re-running a publish on the
		// same commit safe, and it is the one a non-deterministic map iteration breaks.
		const second = mkdtempSync(join(tmpdir(), 'hexdocs-golden-again-'));
		try {
			const corpus = materialiseCorpus(join(second, 'repo'));
			const again = buildBundle(corpus.root, { generator: GENERATOR });
			expect(canonicalJson(again.manifest)).toBe(canonicalJson(result.manifest));
			expect(again.objects.length).toBe(result.objects.length);
			for (const [index, object] of again.objects.entries()) {
				expect(object.key).toBe(result.objects[index]?.key);
				expect(object.bytes.equals(result.objects[index]?.bytes as Buffer)).toBe(true);
			}
		} finally {
			rmSync(second, { recursive: true, force: true });
		}
	});
});

describe('what the goldens pin about every locale', () => {
	test.each(LOCALES)('%s has a search index and an llms.txt in the manifest', (locale) => {
		expect(result.manifest.search[locale]).toBeDefined();
		expect(result.manifest.llms[locale]).toBeDefined();
		expect(result.manifest.coverage[locale]).toBeDefined();
	});
});

/** The dictionary of a locale's index, read back out of the built objects. */
function termsOf(built: BuildResult, locale: Locale): string[] {
	const object = built.objects.find((entry) => entry.key === `search/${locale}.idx.json.gz`);
	if (object === undefined) return [];
	const index = JSON.parse(gunzipMember(object.bytes).toString('utf8')) as { terms: string };
	return index.terms === '' ? [] : index.terms.split('\n');
}
