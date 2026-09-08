import { describe, expect, test } from 'vitest';

import type { VerifyInstallReport } from '../../../src/contracts/diagnostics.js';
import {
	checkRowSchema,
	findingSchema,
	nextActionSchema,
	verifyInstallReportSchema,
	zeroExaminedPasses,
} from '../../src/contracts/diagnostics.schema.js';

const FINDING = {
	rule: 'no-em-dash',
	severity: 'error',
	category: 'house-style',
	location: { kind: 'file', file: 'content/en/index.md', line: 4, column: 12 },
	locale: 'en',
	message: 'An em dash is used as prose punctuation.',
	consequence: 'It is banned in everything the estate ships.',
	remediation: 'Use a comma, a colon, or two sentences.',
	suggestion: null,
	// Escaped, so this file carries no literal em dash for the house lint to find.
	excerpt: 'fast, simple \u2014 and secure',
};

describe('a finding', () => {
	test('validates', () => {
		expect(findingSchema.safeParse(FINDING).success).toBe(true);
	});

	test('an empty suggestion is refused, so "none" and "delete this" stay distinct', () => {
		expect(findingSchema.safeParse({ ...FINDING, suggestion: '' }).success).toBe(false);
		expect(findingSchema.safeParse({ ...FINDING, suggestion: null }).success).toBe(true);
		expect(findingSchema.safeParse({ ...FINDING, suggestion: 'a comma' }).success).toBe(true);
	});

	test('every nullable field is present, so an absent key cannot mean "old toolchain"', () => {
		const { suggestion: _s, ...withoutSuggestion } = FINDING;
		expect(findingSchema.safeParse(withoutSuggestion).success).toBe(false);
	});

	test('a rule id with a doubled or trailing hyphen is refused', () => {
		for (const rule of ['no--em-dash', '-no-em-dash', 'no-em-dash-', 'No-Em-Dash']) {
			expect(findingSchema.safeParse({ ...FINDING, rule }).success).toBe(false);
		}
	});

	test.each([
		{ kind: 'project' },
		{ kind: 'file', file: 'a.md' },
		{ kind: 'pointer', file: 'docs.json', pointer: '/lint/rules/no-em-dash' },
		{ kind: 'ast', file: 'a.md', path: ['body', 3, 'children', 0] },
	])('%o is a location', (location) => {
		expect(findingSchema.safeParse({ ...FINDING, location }).success).toBe(true);
	});

	test('a bare string is not a location, so a renderer never has to parse one apart', () => {
		expect(findingSchema.safeParse({ ...FINDING, location: 'a.md:4:12' }).success).toBe(false);
	});

	test('a pointer to the whole document is the empty string, which is legal', () => {
		expect(
			findingSchema.safeParse({
				...FINDING,
				location: { kind: 'pointer', file: 'x.json', pointer: '' },
			}).success,
		).toBe(true);
	});
});

describe('next action', () => {
	test('a command is an argv array, never a shell string', () => {
		expect(
			nextActionSchema.safeParse({ kind: 'command', argv: ['hexdocs', 'lint', '--fix'], why: 'x' })
				.success,
		).toBe(true);
		expect(
			nextActionSchema.safeParse({ kind: 'command', argv: 'hexdocs lint --fix', why: 'x' }).success,
		).toBe(false);
	});

	test('every arm requires a reason', () => {
		expect(nextActionSchema.safeParse({ kind: 'none' }).success).toBe(false);
		expect(nextActionSchema.safeParse({ kind: 'none', why: 'Nothing to do.' }).success).toBe(true);
	});

	test('a tool action carries its arguments, so the agent does not have to guess them', () => {
		expect(
			nextActionSchema.safeParse({
				kind: 'tool',
				tool: 'lint_docs',
				args: { locale: 'ja' },
				why: 'x',
			}).success,
		).toBe(true);
		expect(nextActionSchema.safeParse({ kind: 'tool', tool: 'lint_docs', why: 'x' }).success).toBe(
			false,
		);
	});
});

describe('the verify-install report', () => {
	const report: VerifyInstallReport = {
		kitVersion: '0.1.0',
		site: 'apps/front',
		rows: [
			{
				id: 'wiring-submodule',
				status: 'pass',
				examined: 1,
				unit: 'entries',
				findings: [],
				note: null,
			},
		],
		summary: { errors: 0, warnings: 0, infos: 0, passing: 1 },
		notCheckedHere: ['Whether the bundle content is correct. That is `hexdocs verify`.'],
		nextAction: { kind: 'none', why: 'The install is complete.' },
		exitCode: 0,
	};

	test('validates', () => {
		expect(verifyInstallReportSchema.safeParse(report).success).toBe(true);
	});

	test('carries every string the shim prints, including what it does not check', () => {
		expect(report.notCheckedHere.length).toBeGreaterThan(0);
		expect(
			verifyInstallReportSchema.safeParse({ ...report, notCheckedHere: undefined }).success,
		).toBe(false);
	});

	test('the exit code is 0 or 3, so a spawn failure is distinguishable from findings', () => {
		expect(verifyInstallReportSchema.safeParse({ ...report, exitCode: 1 }).success).toBe(false);
		expect(verifyInstallReportSchema.safeParse({ ...report, exitCode: 3 }).success).toBe(true);
	});

	test('a report with no rows is refused: it would print as a clean sweep', () => {
		expect(verifyInstallReportSchema.safeParse({ ...report, rows: [] }).success).toBe(false);
	});

	test('a row that passed having examined nothing is caught on the way out too', () => {
		const bad = { ...report, rows: [{ ...report.rows[0], examined: 0 }] } as VerifyInstallReport;
		const problems = zeroExaminedPasses(bad);
		expect(problems.length).toBe(1);
		expect(problems[0]).toContain('examined zero entries');
		expect(zeroExaminedPasses(report)).toEqual([]);
	});

	test('a check row has four states', () => {
		for (const status of ['pass', 'fail', 'skipped', 'not-run']) {
			expect(checkRowSchema.safeParse({ ...report.rows[0], status }).success).toBe(true);
		}
		expect(checkRowSchema.safeParse({ ...report.rows[0], status: 'unknown' }).success).toBe(false);
	});
});
