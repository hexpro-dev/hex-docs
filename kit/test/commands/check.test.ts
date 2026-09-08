/**
 * `hexdocs check`, and the one function it owns.
 *
 * Two things are pinned here and they fail in opposite directions.
 *
 * `filterEnvelope` is the whole reason `check` does not hand `runLint`'s envelope
 * straight back. `runLint` computes the summary, the next action and `truncated` over
 * every finding it produced, so an envelope that kept those three after `--severity
 * error` would report thirty-two warnings it does not contain and tell a reader to start
 * with a finding it dropped. None of that throws and none of it is visible in a golden
 * file, because the golden is the unfiltered list.
 *
 * The other direction is the tree that could not be read. A run that examined nothing
 * has to be a `not-run` row, and the reason is specific rather than procedural: freshness
 * is a comparison of commit dates, so a check that answered anything at all over a tree
 * with no history would be answering out of a fabricated commit, and every page in it
 * would read `current`. That is the shallow-clone failure, and the honest output is no
 * verdict.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus } from '../../../fixtures/index.js';
import type { DiagnosticEnvelope, Finding, Severity } from '../../../src/contracts/diagnostics.js';
import { check, filterEnvelope } from '../../src/commands/check.js';
import { exitCodeFor, invoke, type Ctx } from '../../src/registry/command.js';

const KIT_VERSION = '@hex-pro/docs-kit@0.0.0';

let root: string;
/** The corpus with its declared history replayed, which is the only tree that has one. */
let corpus: string;
/** The same tree with `.git` removed, which is the shallow-clone shape. */
let bare: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'hexdocs-check-'));
	corpus = materialiseCorpus(join(root, 'repo')).root;
	bare = join(root, 'bare');
	cpSync(corpus, bare, { recursive: true, dereference: false, verbatimSymlinks: true });
	rmSync(join(bare, '.git'), { recursive: true, force: true });
}, 60_000);

afterAll(() => {
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/**
 * A context with no writer, which is also an assertion: `check` is declared
 * `writes: 'nothing'`, so a call that reached for one would throw here rather than
 * writing into the corpus copy.
 */
function ctx(cwd: string): Ctx {
	return {
		cwd,
		kitVersion: KIT_VERSION,
		exec: () => {
			throw new Error('check ran a process. It reads a tree and compiles it in memory.');
		},
		write: null,
		now: () => new Date('2026-01-01T00:00:00Z'),
		log: () => {},
	};
}

function finding(rule: string, severity: Severity, message: string): Finding {
	return {
		rule,
		severity,
		category: 'house-style',
		location: { kind: 'file', file: `content/en/${rule}.md`, line: 3, column: 1 },
		locale: 'en',
		message,
		consequence: 'Something a reader sees.',
		remediation: null,
		suggestion: null,
		excerpt: null,
	};
}

/** Three findings, one of each severity, so a filter always has something to drop. */
function envelope(truncated: boolean): DiagnosticEnvelope {
	const findings = [
		finding('no-em-dash', 'error', 'An em dash in prose.'),
		finding('australian-spelling', 'warning', 'A spelling.'),
		finding('title-length', 'info', 'A long title.'),
	];
	return {
		kitVersion: KIT_VERSION,
		summary: { errors: 1, warnings: 1, infos: 1, passing: 12 },
		findings,
		truncated,
		nextAction: {
			kind: 'command',
			argv: ['hexdocs', 'check'],
			why: 'Start with no-em-dash: An em dash in prose.',
		},
	};
}

describe('filterEnvelope', () => {
	test('the summary counts what the envelope kept, not what it was handed', () => {
		const kept = filterEnvelope(envelope(false), (one) => one.severity === 'warning');

		expect(kept.findings.map((one) => one.rule)).toEqual(['australian-spelling']);
		expect(kept.summary).toEqual({ errors: 0, warnings: 1, infos: 0, passing: 12 });
	});

	test('a filter that keeps everything changes nothing about the counts', () => {
		const all = filterEnvelope(envelope(false), () => true);

		expect(all.summary).toEqual({ errors: 1, warnings: 1, infos: 1, passing: 12 });
		expect(all.findings).toHaveLength(3);
	});

	test('nextAction names a finding the envelope still contains', () => {
		const kept = filterEnvelope(envelope(false), (one) => one.severity === 'info');

		expect(kept.nextAction.kind).toBe('command');
		const rules = kept.findings.map((one) => one.rule);
		// The unfiltered action names `no-em-dash`, which this envelope dropped. An action
		// pointing at a finding the caller cannot see is a remedy for a problem the report
		// does not contain, and it reads as the worst one because it was.
		expect(rules).toContain('title-length');
		expect(kept.nextAction.why).toContain('title-length');
		expect(kept.nextAction.why).not.toContain('no-em-dash');
	});

	test('nothing matched is said out loud, not reported as a clean run', () => {
		const none = filterEnvelope(envelope(false), () => false);

		expect(none.findings).toEqual([]);
		expect(none.summary).toEqual({ errors: 0, warnings: 0, infos: 0, passing: 12 });
		expect(none.nextAction.kind).toBe('none');
		expect(none.nextAction.why).toContain('not the same as nothing being wrong');
	});

	test('truncated is re-derived: a filter that dropped something clears it', () => {
		// `truncated` published on a filtered list is a claim about a different list. The
		// original said "there were more findings after these three"; after a filter that
		// dropped two of the three, carrying it through says "there were more warnings",
		// which nothing measured.
		const dropped = filterEnvelope(envelope(true), (one) => one.severity === 'error');
		expect(dropped.findings).toHaveLength(1);
		expect(dropped.truncated).toBe(false);

		const untouched = filterEnvelope(envelope(true), () => true);
		expect(untouched.truncated).toBe(true);

		const wasNotTruncated = filterEnvelope(envelope(false), () => true);
		expect(wasNotTruncated.truncated).toBe(false);
	});
});

/**
 * The seven errors the corpus plants, by rule.
 *
 * Read out of the run rather than written here as a count. The interesting property is
 * which rules fire, because a count alone is satisfied by seven of anything.
 */
const PLANTED_ERRORS = [
	'code-fence-language',
	'internal-leak',
	'no-banned-phrase',
	'no-competitor-name',
	'no-decorative-unicode',
	'no-em-dash',
	'no-en-dash-prose',
];

describe('over the fixture corpus', () => {
	test('the seven planted errors are found and the run exits 3', async () => {
		const out = await invoke(check, { root: corpus }, ctx(root));

		expect(out.envelope).not.toBeNull();
		const found = out.envelope as DiagnosticEnvelope;
		const errors = found.findings.filter((one) => one.severity === 'error');
		expect([...new Set(errors.map((one) => one.rule))].sort()).toEqual(PLANTED_ERRORS);
		expect(found.summary.errors).toBe(7);

		// The corpus has to compile with errors in it, because refusing is the publisher's
		// job. What must not happen is a clean exit over them.
		expect(exitCodeFor(out)).toBe(3);

		// One row, and it is the public mirror allowlist. Everything about the compiled
		// tree reports through the envelope; the allowlist is a shell script outside that
		// tree, so folding it into the envelope would make `passing` and `truncated`
		// describe two different populations. The corpus has no mirror script, so the row
		// is `skipped` with the reason, which is the one direction this check must never
		// degrade in: "nothing here to read" and "what is here is fine" are different
		// answers, and only one of them is a pass.
		expect(out.rows.map((one) => one.id)).toEqual(['wiring-allow-paths']);
		expect(out.rows[0]?.status).toBe('skipped');
		expect(out.rows[0]?.note).toContain('not a pass');
	});

	test('--severity error re-counts rather than reporting the whole run', async () => {
		const whole = await invoke(check, { root: corpus }, ctx(root));
		const filtered = await invoke(check, { root: corpus, severity: 'error' }, ctx(root));

		const all = whole.envelope as DiagnosticEnvelope;
		const errors = filtered.envelope as DiagnosticEnvelope;

		// The warnings are what makes this a real filter: they outnumber the errors, so a
		// summary carried through would be wrong by a wide margin rather than subtly.
		expect(all.summary.warnings).toBeGreaterThan(0);
		expect(errors.summary.warnings).toBe(0);
		expect(errors.summary.errors).toBe(all.summary.errors);
		expect(errors.findings).toHaveLength(all.summary.errors);
		expect(errors.findings.every((one) => one.severity === 'error')).toBe(true);
		expect(exitCodeFor(filtered)).toBe(3);
	});

	test('a category filter drops the findings it excludes from the summary too', async () => {
		const brand = await invoke(check, { root: corpus, category: ['brand'] }, ctx(root));
		const envelopeOut = brand.envelope as DiagnosticEnvelope;

		expect(envelopeOut.findings.length).toBeGreaterThan(0);
		expect(envelopeOut.findings.every((one) => one.category === 'brand')).toBe(true);
		const counted =
			envelopeOut.summary.errors + envelopeOut.summary.warnings + envelopeOut.summary.infos;
		expect(counted).toBe(envelopeOut.findings.length);
	});
});

describe('a tree with no git history', () => {
	test('is a not-run row, and no verdict at all', async () => {
		const out = await invoke(check, { root: bare }, ctx(root));

		expect(out.rows).toHaveLength(1);
		const row = out.rows[0] as (typeof out.rows)[number];
		expect(row.status).toBe('not-run');
		expect(row.id).toBe('check');
		expect(row.examined).toBe(0);
		expect(row.note).toContain('not a git repository');
		expect(exitCodeFor(out)).toBe(3);
	});

	test('fabricates no commit and no finding', async () => {
		const out = await invoke(check, { root: bare }, ctx(root));

		// The failure carries three keys and none of them is a commit, a timestamp or a
		// translation state. A synthetic commit here would date every file the same, which
		// makes every translation read `current`: a green report over a tree nothing was
		// measured against.
		expect(Object.keys(out.data as Record<string, unknown>).sort()).toEqual([
			'checked',
			'root',
			'why',
		]);
		expect((out.data as { checked: boolean }).checked).toBe(false);
		// An envelope with no findings, not `null`. The arm used to carry none, which made
		// this the one shape with no `nextAction` at all, in the state where an agent most
		// needs to be told what to do next. What it must not carry is a finding: a tree
		// with no history has nothing measured against anything.
		expect(out.envelope?.findings).toEqual([]);
		expect(out.envelope?.nextAction.kind).toBe('command');
		expect(JSON.stringify(out.data)).not.toContain('current');
	});
});
