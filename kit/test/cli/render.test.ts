/**
 * Two renderers over the same four states, held to the same verdict.
 *
 * `kit/src/cli/render.ts` and `scripts/lib/report.mjs` cannot be one module and the reason
 * is structural rather than stylistic: the second is a zero-dependency `.mjs` that runs
 * from a `prebuild` hook on a machine with nothing installed, and `kit/tsconfig.json` does
 * not include `../scripts`. So the duplication is deliberate and bounded, and what has to
 * be true is that the copy never grows its own opinion about what a row means. This file
 * runs both over one row set and compares the answers.
 *
 * The line that matters most is the one about `not-run`. Counting only failures is how a
 * report in which nothing executed prints "all clear" and exits 0: delete the thing a check
 * reads and every row goes dark, and dark is indistinguishable from green to an exit code.
 * If the two renderers ever disagreed about that, the CLI and the consumer's `prebuild`
 * shim would give two different answers about the same installation, and the shim is the
 * one that runs unattended.
 *
 * The colour branch is covered here and nowhere else in the repository, because
 * `scripts/verify.mjs` spawns every step with `NO_COLOR` set and vitest is not a TTY. Both
 * modules decide colour once at import, so the only way to reach the other arm is to
 * reimport them with the environment changed, which is what the last block does.
 */

import { describe, expect, test, vi } from 'vitest';

import {
	CHECK_STATES,
	checkRow,
	failedRow,
	notRunRow,
	skippedRow,
	type CheckRow,
	type CheckState,
} from '../../../src/contracts/diagnostics.js';
import { renderOutput, renderRows, verdict } from '../../src/cli/render.js';

// @ts-expect-error -- a zero-dependency guard written as .mjs, outside kit/tsconfig.json's
// program on purpose: it runs on a machine that has installed nothing.
import { check, notRun, render, skipped } from '../../../scripts/lib/report.mjs';
// @ts-expect-error -- the same module, imported for its JSDoc types. `kit/tsconfig.json`
// does not include `../scripts`, so the declaration is not in this program.
import type { CheckResult } from '../../../scripts/lib/report.mjs';

/** The label column is a fixed width in both renderers, which is what makes this readable. */
const STATE_COLUMN = 7;

function row(status: CheckState, id = 'x'): CheckRow {
	switch (status) {
		case 'pass':
			return checkRow(id, 3, 'files', []);
		case 'fail':
			return failedRow(id, 3, 'files', 'The anchor was not there.');
		case 'skipped':
			return skippedRow(id, 'files', 'There is no public mirror here.');
		case 'not-run':
			return notRunRow(id, 'files', 'The registry could not be read.');
	}
}

/**
 * One `CheckRow` as the ladder's own result shape.
 *
 * Derived from the row rather than written twice. A hand-built pair of tables would let
 * the two sides be given different inputs and then be compared, which proves nothing: the
 * comparison is only worth making if both renderers are looking at the same run.
 */
function asResult(one: CheckRow): CheckResult {
	if (one.status === 'skipped') return skipped(one.id, one.unit, one.note ?? '') as CheckResult;
	if (one.status === 'not-run') return notRun(one.id, one.unit, one.note ?? '') as CheckResult;
	const problems =
		one.status === 'fail'
			? one.findings.length > 0
				? one.findings.map((finding) => finding.message)
				: [one.note ?? 'It did not pass.']
			: [];
	return check(one.id, one.examined, one.unit, problems) as CheckResult;
}

interface LadderSummary {
	readonly ok: boolean;
	readonly failed: number;
	readonly ran: number;
	readonly notRun: number;
}

/** Everything `render` wrote, with the verdict it returned. */
function ladder(rows: readonly CheckRow[]): { text: string; summary: LadderSummary } {
	const chunks: string[] = [];
	const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		chunks.push(String(chunk));
		return true;
	});
	try {
		const summary = render('t', rows.map(asResult)) as LadderSummary;
		return { text: chunks.join(''), summary };
	} finally {
		write.mockRestore();
	}
}

interface Scenario {
	readonly name: string;
	readonly rows: readonly CheckRow[];
	/** What both renderers have to say about it, so the expectation is not derived twice. */
	readonly ok: boolean;
}

const SCENARIOS: readonly Scenario[] = [
	{ name: 'everything passed', rows: [row('pass', 'a'), row('pass', 'b')], ok: true },
	{
		name: 'a skip beside a pass, which is still clean',
		rows: [row('pass', 'a'), row('skipped', 'b')],
		ok: true,
	},
	{ name: 'one failure', rows: [row('pass', 'a'), row('fail', 'b')], ok: false },
	{
		name: 'one row that did not run, with everything else green',
		rows: [row('pass', 'a'), row('pass', 'b'), row('not-run', 'c')],
		ok: false,
	},
	{
		name: 'nothing ran at all, which is the report that used to read "all clear"',
		rows: [row('not-run', 'a'), row('not-run', 'b')],
		ok: false,
	},
	{ name: 'every state at once', rows: CHECK_STATES.map((state) => row(state, state)), ok: false },
];

describe('the two renderers reach the same verdict', () => {
	test.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
		'%s',
		(_name, scenario) => {
			const cli = verdict(scenario.rows);
			const { summary } = ladder(scenario.rows);
			expect(cli.ok).toBe(scenario.ok);
			expect(summary.ok).toBe(scenario.ok);
			expect(cli.failed).toBe(summary.failed);
			expect(cli.notRun).toBe(summary.notRun);
		},
	);

	test('a not-run row fails both, and neither says all clear', () => {
		// The one line of `render.ts` that has to match the other renderer exactly. Both are
		// asserted rather than one, because the failure mode is a copy that drifted, and a
		// test that only read the copy would not see it.
		const rows = [row('pass', 'a'), row('not-run', 'b')];
		expect(verdict(rows).ok).toBe(false);

		const cliText = renderOutput({ data: null, lines: [], envelope: null, rows }).join('\n');
		expect(cliText).toContain('1 did not run');
		expect(cliText).not.toContain('nothing ran');

		const { text, summary } = ladder(rows);
		expect(summary.ok).toBe(false);
		expect(text).toContain('1 did not run');
		expect(text).not.toContain('nothing ran');
	});

	test('a skipped-only run says nothing ran in both, and is still clean', () => {
		// The verdict and the words are separate claims and both are asserted. A skip is a
		// decision, so the run is `ok` and the exit code is 0 in both renderers. But "all
		// clear" over a column of SKIPPED tells a reader the opposite of what happened, so
		// both say "nothing ran" instead. Step 5 emits more skips than anything else, which
		// is why this stopped being a hypothetical.
		const rows = [row('skipped', 'a'), row('skipped', 'b')];
		expect(verdict(rows).ok).toBe(true);
		expect(ladder(rows).summary.ok).toBe(true);

		const cliText = renderOutput({ data: null, lines: [], envelope: null, rows }).join('\n');
		expect(cliText).toContain('nothing ran');
		expect(cliText).not.toContain('all clear');

		const { text } = ladder(rows);
		expect(text).toContain('nothing ran');
		expect(text).not.toContain('all clear');
	});
});

/** The state column of the first rendered row, both renderers laying it out identically. */
function labelIn(text: string, id: string): string {
	const line = text.split('\n').find((one) => one.startsWith(`  ${id}  `)) ?? '';
	return line.slice(2 + id.length + 2, 2 + id.length + 2 + STATE_COLUMN).trim();
}

describe('the four state labels', () => {
	const labels = new Map<CheckState, { cli: string; ladder: string }>();
	for (const state of CHECK_STATES) {
		const one = row(state, 'x');
		labels.set(state, {
			cli: labelIn(renderRows([one]).join('\n'), 'x'),
			ladder: labelIn(ladder([one]).text, 'x'),
		});
	}

	test('every state in CHECK_STATES renders a label, and every label maps back to one state', () => {
		const printed = [...labels.values()].map((pair) => pair.cli);
		expect(
			printed.filter((label) => label === ''),
			'a state rendered no label',
		).toEqual([]);
		// Both directions. A label shared by two states is the collapse `CHECK_STATES` exists
		// to prevent: a reader cannot tell a skip from a pass if they print the same word.
		expect(new Set(printed).size).toBe(CHECK_STATES.length);
		expect(printed.length).toBe(CHECK_STATES.length);
	});

	test.each(CHECK_STATES.map((state) => [state] as const))(
		'%s prints the same word in the same column in both renderers',
		(state) => {
			const pair = labels.get(state) as { cli: string; ladder: string };
			expect(pair.cli).toBe(pair.ladder);
		},
	);

	test('the labels are the ones the skills and the shim tell a reader to look for', () => {
		// Named literally in exactly one place, here, because `docs-diagnose` prints this
		// table to an agent and the consumer's shim renders the same words from `prebuild`.
		// Renaming a label is a change to a documented surface, not a rendering tweak.
		expect(CHECK_STATES.map((state) => (labels.get(state) as { cli: string }).cli)).toEqual([
			'PASS',
			'FAIL',
			'SKIPPED',
			'NOT RUN',
		]);
	});
});

describe('colour', () => {
	/**
	 * The SGR code both renderers wrap a state label in, read back out of the output.
	 *
	 * The escape is spelled as a code point rather than typed. A literal ESC is invisible
	 * in a diff and in a review, which is the same reason every non-ASCII character in this
	 * repository's tests and goldens is written out.
	 */
	function codeBefore(text: string, label: string): string | undefined {
		return new RegExp(`\u001b\\[(\\d+)m${label}`).exec(text)?.[1];
	}

	test('a TTY with no NO_COLOR paints each state, and both renderers pick the same colour', async () => {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
		const previous = process.env['NO_COLOR'];
		Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
		delete process.env['NO_COLOR'];
		vi.resetModules();

		try {
			// Both modules read the environment once at import, which is why this is a
			// reimport rather than a flag. It is also the only reason the branch is
			// reachable at all: `verify.mjs` spawns every step with NO_COLOR set.
			const cli = await import('../../src/cli/render.js');
			// @ts-expect-error -- see the import at the top of this file.
			const ladderModule = await import('../../../scripts/lib/report.mjs');

			expect(cli.PAINT.pass('X')).toBe('\u001b[32mX\u001b[0m');
			expect(cli.PAINT.fail('X')).toBe('\u001b[31mX\u001b[0m');
			expect(cli.PAINT.skipped('X')).toBe('\u001b[33mX\u001b[0m');
			expect(cli.PAINT['not-run']('X')).toBe('\u001b[90mX\u001b[0m');

			const rows = CHECK_STATES.map((state) => row(state, state));
			const cliText = cli.renderRows(rows).join('\n');

			const chunks: string[] = [];
			const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
				chunks.push(String(chunk));
				return true;
			});
			ladderModule.render('t', rows.map(asResult));
			write.mockRestore();
			const ladderText = chunks.join('');

			for (const [state, label] of [
				['pass', 'PASS'],
				['fail', 'FAIL'],
				['skipped', 'SKIPPED'],
				['not-run', 'NOT RUN'],
			] as const) {
				const mine = codeBefore(cliText, label);
				const theirs = codeBefore(ladderText, label);
				expect(mine, `${state} was not painted by the CLI renderer`).toBeDefined();
				expect(theirs, `${state} was not painted by the ladder`).toBeDefined();
				expect(mine, `${state} is a different colour in the two renderers`).toBe(theirs);
			}

			// And the two that must never look alike, because colour is the only channel a
			// scanning reader uses on this table.
			expect(codeBefore(cliText, 'PASS')).not.toBe(codeBefore(cliText, 'FAIL'));
			expect(codeBefore(cliText, 'NOT RUN')).not.toBe(codeBefore(cliText, 'PASS'));
		} finally {
			if (descriptor !== undefined) Object.defineProperty(process.stdout, 'isTTY', descriptor);
			if (previous !== undefined) process.env['NO_COLOR'] = previous;
			vi.resetModules();
		}
	});

	test('the statically imported renderer is plain, which is what a pipe and CI get', () => {
		// The other arm, and the one every other test in this repository runs under. It is
		// asserted rather than assumed because the comparisons above would still pass if
		// both renderers emitted escapes into a log file.
		expect(renderRows([row('pass', 'x')]).join('\n')).not.toContain('\u001b[');
	});
});
