/**
 * A `CommandOutput` as text, in the house voice.
 *
 * The second renderer over `CheckRow` in this repository, `scripts/lib/report.mjs` being
 * the first, and the duplication is deliberate and bounded rather than accidental. That
 * one is a zero-dependency `.mjs` that runs from a `prebuild` hook on a machine with
 * nothing installed, and `kit/tsconfig.json` does not include `../scripts`, so the two
 * cannot be one module. What is shared is the thing that matters: both read the same four
 * states off the same rows, and `kit/test/cli/render.test.ts` runs both over one row set
 * and asserts they reach the same verdict, so the copy cannot grow its own opinion about
 * what `not-run` means.
 *
 * Colour is decided the same way `report.mjs` decides it, and for the same reason: a
 * pipe, a log file and CI all want plain text, and `verify.mjs` spawns every step with
 * `NO_COLOR` set.
 */

import type { CheckRow, DiagnosticEnvelope, Finding } from '../../../src/contracts/diagnostics.js';
import type { CommandOutput } from '../registry/command.js';

const COLOUR = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

const PAINT = {
	pass: (s: string) => (COLOUR ? `\u001b[32m${s}\u001b[0m` : s),
	fail: (s: string) => (COLOUR ? `\u001b[31m${s}\u001b[0m` : s),
	skipped: (s: string) => (COLOUR ? `\u001b[33m${s}\u001b[0m` : s),
	'not-run': (s: string) => (COLOUR ? `\u001b[90m${s}\u001b[0m` : s),
	dim: (s: string) => (COLOUR ? `\u001b[90m${s}\u001b[0m` : s),
	bold: (s: string) => (COLOUR ? `\u001b[1m${s}\u001b[0m` : s),
} as const;

const LABEL: Record<CheckRow['status'], string> = {
	pass: 'PASS',
	fail: 'FAIL',
	skipped: 'SKIPPED',
	'not-run': 'NOT RUN',
};

/** Where a finding is, as one clickable string. */
export function locationText(finding: Finding): string {
	const location = finding.location;
	switch (location.kind) {
		case 'project':
			return '(project)';
		case 'file':
			return [location.file, location.line, location.column]
				.filter((p) => p !== undefined)
				.join(':');
		case 'pointer':
			return `${location.file}#${location.pointer}`;
		case 'ast':
			return location.line === undefined
				? `${location.file} (${location.path.join('.')})`
				: `${location.file}:${location.line}`;
	}
}

export function renderFindings(envelope: DiagnosticEnvelope): string[] {
	const lines: string[] = [];
	for (const finding of envelope.findings) {
		const severity =
			finding.severity === 'error'
				? PAINT.fail('error')
				: finding.severity === 'warning'
					? PAINT.skipped('warning')
					: PAINT.dim('info');
		lines.push(`${severity}  ${locationText(finding)}  ${PAINT.dim(finding.rule)}`);
		lines.push(`       ${finding.message}`);
		if (finding.remediation !== null) lines.push(`       ${PAINT.dim(finding.remediation)}`);
		if (finding.suggestion !== null)
			lines.push(`       ${PAINT.dim(`suggested: ${finding.suggestion}`)}`);
	}
	const { errors, warnings, infos, passing } = envelope.summary;
	lines.push('');
	lines.push(
		`${errors} error(s), ${warnings} warning(s), ${infos} note(s), ` +
			`${passing} rule(s) reported nothing` +
			(envelope.truncated ? '. The list was truncated.' : '.'),
	);
	return lines;
}

export function renderRows(rows: readonly CheckRow[]): string[] {
	if (rows.length === 0) return [];
	const width = rows.reduce((max, row) => Math.max(max, row.id.length), 0);
	const lines: string[] = [];
	for (const row of rows) {
		const state = PAINT[row.status](LABEL[row.status].padEnd(7));
		// A pass or a fail reports what it examined; a skip or a non-run has nothing to
		// count and carries its reason instead. That is the same layout `report.mjs` uses,
		// and it is what stops a zero in the count column reading as a measurement.
		const tail =
			row.status === 'pass' || row.status === 'fail'
				? PAINT.dim(`${row.examined} ${row.unit}`)
				: PAINT.dim(row.note ?? '');
		lines.push(`  ${row.id.padEnd(width)}  ${state}  ${tail}`);
		if ((row.status === 'pass' || row.status === 'fail') && row.note !== null) {
			lines.push(`  ${' '.repeat(width)}  ${' '.repeat(7)}  ${PAINT.dim(row.note)}`);
		}
		for (const finding of row.findings) {
			lines.push(`  ${' '.repeat(width)}  ${PAINT.fail('|')}  ${finding.message}`);
			if (finding.remediation !== null) {
				lines.push(`  ${' '.repeat(width)}  ${PAINT.fail('|')}  ${PAINT.dim(finding.remediation)}`);
			}
		}
	}
	return lines;
}

/**
 * The verdict over a row set.
 *
 * Exported so `render.test.ts` can put it beside `report.mjs`'s and assert the two agree.
 * A `not-run` row fails, which is the one line of this file that has to match the other
 * renderer exactly: counting only failures is how a report in which nothing executed
 * prints "all clear" and exits 0.
 */
export function verdict(rows: readonly CheckRow[]): {
	ok: boolean;
	failed: number;
	notRun: number;
} {
	const failed = rows.filter((row) => row.status === 'fail').length;
	const notRun = rows.filter((row) => row.status === 'not-run').length;
	return { ok: failed === 0 && notRun === 0, failed, notRun };
}

export function renderOutput(out: CommandOutput): string[] {
	const lines = [...out.lines];
	if (out.rows.length > 0) {
		if (lines.length > 0) lines.push('');
		lines.push(...renderRows(out.rows));
		const { ok, failed, notRun } = verdict(out.rows);
		lines.push('');
		// A run of nothing but skips is `ok`, and `report.mjs` says so in its own comment,
		// so the two renderers agree about the exit code. What they must not do is print
		// "all clear" over it: nothing ran, and a reader who sees those two words above a
		// column of SKIPPED has been told the opposite of what happened. The verdict is a
		// third string rather than a fourth state, because inventing a state here would put
		// this renderer's vocabulary out of step with the contract's.
		const skipped = out.rows.filter((row) => row.status === 'skipped').length;
		lines.push(
			`  ${
				failed > 0
					? PAINT.fail(`${failed} failed`)
					: notRun > 0
						? PAINT.fail(`${notRun} did not run`)
						: skipped === out.rows.length
							? PAINT.skipped('nothing ran')
							: PAINT.pass('all clear')
			} ${PAINT.dim(`(${out.rows.length} checks, ${skipped} skipped)`)}`,
		);
		void ok;
	}
	if (out.envelope !== null && out.envelope.findings.length > 0) {
		if (lines.length > 0) lines.push('');
		lines.push(...renderFindings(out.envelope));
	}
	return lines;
}

export { PAINT };
