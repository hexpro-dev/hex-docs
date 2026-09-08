/**
 * `hexdocs bundle`: the rows it surfaces and the diff it computes.
 *
 * The rows are the point of the first half. `verifyBundle` is the reader the compiler and
 * the publisher already trust, and this command adds nothing to it: a second
 * implementation living in the CLI is how the CLI and the publisher end up disagreeing
 * about whether a bundle is publishable. So the rows are compared against a direct call
 * rather than against a list of ids written down here, which is the difference between
 * pinning the output and pinning the claim that there is one implementation.
 *
 * **The row ids here are not `CheckId`s**, and that is asserted rather than left in a
 * comment. `CheckRow.id` is a row id, free to be any string; `Finding.rule` is the closed
 * union of `LINT_RULE_IDS` and `CHECK_IDS`. `verifyBundle` has emitted `bundle-manifest`,
 * `bundle-objects`, `bundle-digests` and `bundle-payloads` as row ids since step 3 and not
 * one of them is a `CheckId`. A both-directions sweep of `CHECK_IDS` against these row ids
 * would fail against the compiler's own correct output, and the only way to make it pass
 * would be to invent check ids that nothing reports findings under.
 *
 * The diff's failure is quieter. It is read by an agent that runs the command again after
 * a change and compares, so an unordered list or a digest read off the wrong side makes a
 * release note that describes a change nobody made.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus } from '../../../fixtures/index.js';
import { CHECK_IDS } from '../../../src/contracts/lint.js';
import type { BundleManifest } from '../../../src/contracts/manifest.js';
import { buildBundle } from '../../src/compile/build.js';
import { verifyBundle, writeBundle } from '../../src/compile/bundle.js';
import { bundle, diffManifests } from '../../src/commands/bundle.js';
import { readBundle } from '../../src/commands/pages.js';
import { exitCodeFor, invoke, type Ctx } from '../../src/registry/command.js';

const KIT_VERSION = '@hex-pro/docs-kit@0.0.0';

let root: string;
let corpus: string;
/** Two writes of two separate compiles of the same commit. */
let first: string;
let second: string;
/** The same tree with one English page edited and committed. */
let edited: string;

function writeAt(name: string, from: string): string {
	const out = join(root, name);
	mkdirSync(out, { recursive: true });
	const built = buildBundle(from, { generator: KIT_VERSION });
	expect(built.manifestProblems).toEqual([]);
	return writeBundle(out, built.manifest, built.objects).prefix;
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'hexdocs-bundle-cmd-'));
	corpus = materialiseCorpus(join(root, 'repo')).root;

	// Two compiles rather than one compile written twice. A diff over one build's manifest
	// against itself is arithmetic; a diff over two builds is also the byte-reproducibility
	// claim, which is what the write-once refusal depends on.
	first = writeAt('out-1', corpus);
	second = writeAt('out-2', corpus);

	appendFileSync(
		join(corpus, 'docs', 'site', 'content', 'en', 'guide', 'troubleshooting.md'),
		'\nOne more paragraph, so the payload digest moves.\n',
		'utf8',
	);
	execFileSync('git', ['add', '-A'], { cwd: corpus, stdio: 'ignore' });
	execFileSync('git', ['commit', '-m', 'edit one page', '--no-verify'], {
		cwd: corpus,
		stdio: 'ignore',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'Fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
			GIT_AUTHOR_DATE: '2026-07-01T00:00:00Z',
			GIT_COMMITTER_DATE: '2026-07-01T00:00:00Z',
		},
	});
	edited = writeAt('out-3', corpus);
}, 120_000);

afterAll(() => {
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function ctx(cwd: string): Ctx {
	return {
		cwd,
		kitVersion: KIT_VERSION,
		exec: () => {
			throw new Error('bundle ran a process. It reads a directory.');
		},
		write: null,
		now: () => new Date('2026-01-01T00:00:00Z'),
		log: () => {},
	};
}

/**
 * The same manifest with every key order reversed, slugs and locales alike.
 *
 * Nothing about a bundle changes: it is the same pages with the same digests. What
 * changes is the order a `for ... of Object.entries` walk meets them in, which is the only
 * way to tell a sorted result from one that inherited the input's order.
 */
function reversed(manifest: BundleManifest): BundleManifest {
	const pages = Object.fromEntries(
		[...Object.entries(manifest.pages)].reverse().map(([slug, record]) => [
			slug,
			{
				...record,
				locales: Object.fromEntries([...Object.entries(record.locales)].reverse()),
			},
		]),
	);
	return { ...manifest, pages } as BundleManifest;
}

interface Against {
	addedSlugs: string[];
	removedSlugs: string[];
	addedPages: { slug: string; locale: string }[];
	removedPages: { slug: string; locale: string }[];
	changedPages: { slug: string; locale: string; from: string; to: string }[];
	terms: { locale: string; from: number | null; to: number | null; delta: number | null }[];
	notes: string[];
}

async function describeBundle(
	path: string,
	against?: string,
): Promise<{ data: Record<string, unknown>; rows: readonly { id: string; status: string }[] }> {
	const out = await invoke(bundle, against === undefined ? { path } : { path, against }, ctx(root));
	return {
		data: out.data as Record<string, unknown>,
		rows: out.rows as readonly { id: string; status: string }[],
	};
}

describe('the verify rows', () => {
	test('are exactly what verifyBundle returns, not a re-derivation', async () => {
		const direct = verifyBundle(first);
		const out = await invoke(bundle, { path: first }, ctx(root));

		// Deep equality over the whole row, findings included. Comparing ids alone would
		// pass against a command that re-counted `examined` or re-worded a finding, which is
		// exactly the drift the single implementation exists to stop.
		expect(out.rows).toEqual(direct);
		expect(direct.length).toBeGreaterThan(0);
		expect(direct.every((row) => row.status === 'pass')).toBe(true);
		expect(exitCodeFor(out)).toBe(0);
	});

	test('carry row ids that are deliberately not CheckIds', () => {
		const ids = verifyBundle(first).map((row) => row.id);
		const checks = new Set<string>(CHECK_IDS);

		// The four that have been emitted since step 3. If one of these ever becomes a
		// `CheckId`, this fails and the two namespaces have to be reconciled deliberately
		// rather than by a sweep that quietly starts passing.
		for (const id of ['bundle-manifest', 'bundle-objects', 'bundle-digests', 'bundle-payloads']) {
			expect(ids, id).toContain(id);
			expect(checks.has(id), id).toBe(false);
		}
	});

	test('a path that is not a directory is refused before verifyBundle sees it', async () => {
		const out = await invoke(bundle, { path: join(root, 'nothing-here') }, ctx(root));

		expect(out.rows).toHaveLength(1);
		expect(out.rows[0]?.id).toBe('bundle-path');
		expect(out.rows[0]?.status).toBe('not-run');
		// "There is no bundle here" and "you passed the parent of the ast-N directory" send
		// an operator to two different places, and the second is what actually happens.
		expect(out.rows[0]?.note).toContain('ast-N directory');
		expect(exitCodeFor(out)).toBe(3);
	});
});

describe('the diff', () => {
	test('between two builds of the same corpus is empty', async () => {
		const out = await describeBundle(first, second);
		const against = out.data['against'] as Against;

		expect(against.addedSlugs).toEqual([]);
		expect(against.removedSlugs).toEqual([]);
		expect(against.addedPages).toEqual([]);
		expect(against.removedPages).toEqual([]);
		expect(against.changedPages).toEqual([]);
		expect(against.notes).toEqual([]);
		// Every locale is present with a zero delta rather than absent. A locale that
		// dropped out of a bundle would otherwise be invisible in the table that exists to
		// say what changed.
		expect(against.terms.length).toBeGreaterThan(0);
		expect(against.terms.every((term) => term.delta === 0)).toBe(true);
		expect(out.rows.every((row) => row.status === 'pass')).toBe(true);
	});

	test('after a real content change names the changed slug', async () => {
		const out = await describeBundle(edited, first);
		const against = out.data['against'] as Against;

		expect(against.changedPages.length).toBeGreaterThan(0);
		// One page was edited, so one slug changed. The locale set is wider than the file
		// that was touched, because editing the English source is what makes its
		// translations stale, and a translation state is part of the payload a reader gets.
		expect([...new Set(against.changedPages.map((one) => one.slug))]).toEqual([
			'guide/troubleshooting',
		]);
		expect(against.changedPages.map((one) => one.locale)).toContain('en');
		for (const change of against.changedPages) {
			expect(change.from).not.toBe(change.to);
			expect(change.from).toMatch(/^[0-9a-f]{64}$/);
			expect(change.to).toMatch(/^[0-9a-f]{64}$/);
		}

		// No page was added or removed, which is what says a digest change and a slug change
		// are two different release notes.
		expect(against.addedSlugs).toEqual([]);
		expect(against.removedSlugs).toEqual([]);
		expect(against.addedPages).toEqual([]);
		expect(against.removedPages).toEqual([]);
	});

	test('is ordered, so a second run of the same comparison reads the same', async () => {
		const one = await describeBundle(edited, first);
		const two = await describeBundle(edited, first);
		expect(two.data['against']).toEqual(one.data['against']);

		// Measured, and worth knowing before trusting the assertion above: over a real
		// manifest this passes with the sort deleted. Canonical JSON writes both the slug
		// keys and the locale keys in code point order, so the insertion order already is
		// the sorted order and nothing here can tell the two apart. The next test is the
		// one that can.
		const changed = (one.data['against'] as Against).changedPages;
		const sorted = [...changed].sort((a, b) =>
			a.slug === b.slug ? (a.locale < b.locale ? -1 : 1) : a.slug < b.slug ? -1 : 1,
		);
		expect(changed).toEqual(sorted);
	});

	test('is sorted rather than left in insertion order', () => {
		const current = readBundle(root, edited);
		const other = readBundle(root, first);
		expect(current.ok && other.ok).toBe(true);
		if (!current.ok || !other.ok) return;

		// The same comparison over a manifest whose keys arrive back to front. An
		// implementation that returned the map's iteration order would come back descending
		// here and ascending above, which is a diff that reorders itself depending on which
		// bundle it was handed: an agent comparing two runs sees an unrelated change.
		const diff = diffManifests(reversed(current.manifest), other.manifest);
		const keys = diff.changedPages.map((one) => `${one.slug} ${one.locale}`);
		expect(keys.length).toBeGreaterThan(1);
		expect(keys).toEqual([...keys].sort());
	});

	test('that was asked for and could not run is a not-run row, not an empty diff', async () => {
		const out = await invoke(
			bundle,
			{ path: first, against: join(root, 'no-such-bundle') },
			ctx(root),
		);

		// An empty diff and a diff that never ran look identical in JSON, and the whole
		// reason `--against` was passed is that somebody wants to know what changed.
		expect(out.rows.some((row) => row.id === 'bundle-against' && row.status === 'not-run')).toBe(
			true,
		);
		expect((out.data as { against: unknown }).against).toBeNull();
		expect(exitCodeFor(out)).toBe(3);
	});
});

describe('the description', () => {
	test('reports the manifest own counts and marks the hidden page', async () => {
		const out = await describeBundle(first);
		const data = out.data;

		expect(data['described']).toBe(true);
		expect(data['project']).toBe('fixture-app');
		expect(data['commit']).toMatch(/^[0-9a-f]{40}$/);

		const listed = data['pages'] as { slug: string; hidden: boolean; locales: string[] }[];
		// `reference/api` is the corpus's published-but-hidden page. It stays in the list,
		// because `nav` and `llmsOrder` have to keep answering the same question, and the
		// flag is what the sidebar reads.
		const hidden = listed.filter((one) => one.hidden).map((one) => one.slug);
		expect(hidden).toEqual(['reference/api']);
		expect(listed.every((one) => one.locales.length > 0)).toBe(true);
	});
});
