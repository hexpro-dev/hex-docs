import { describe, expect, test } from 'vitest';

import {
	CHECK_STATES,
	checkRow,
	compareFindings,
	FINDING_CATEGORIES,
	SEVERITIES,
	type Finding,
} from '../../src/contracts/diagnostics.js';

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		rule: 'no-em-dash',
		severity: 'error',
		category: 'house-style',
		location: { kind: 'file', file: 'content/en/index.md', line: 4 },
		locale: 'en',
		message: 'An em dash is used as prose punctuation.',
		consequence: 'It is banned in everything the estate ships.',
		remediation: 'Use a comma, a colon or two sentences.',
		suggestion: null,
		// Escaped, so this file carries no literal em dash for the house lint to find.
		excerpt: 'fast, simple \u2014 and secure',
		...overrides,
	};
}

describe('severities', () => {
	test('there are exactly three, and heading parity is why', () => {
		// An error when the translation is current, a warning when it is already stale.
		// Two levels would deadlock a project into retranslating six pages before it
		// could publish a typo fix.
		expect([...SEVERITIES]).toEqual(['error', 'warning', 'info']);
	});
});

describe('ordering', () => {
	test('worst first, then by category, then by position, then by rule', () => {
		const sorted = [
			finding({ severity: 'info', rule: 'no-triad' }),
			finding({ severity: 'error', rule: 'no-em-dash' }),
			finding({ severity: 'warning', rule: 'no-hedging-stack' }),
		].sort(compareFindings);
		expect(sorted.map((f) => f.severity)).toEqual(['error', 'warning', 'info']);
	});

	test('is stable across input order, which is what lets an agent re-run and see the same first line', () => {
		const findings = [
			finding({ category: 'links', rule: 'link-resolves' }),
			finding({ category: 'structure', rule: 'no-h1-in-body' }),
			finding({ category: 'house-style', rule: 'no-em-dash' }),
		];
		const a = [...findings].sort(compareFindings).map((f) => f.rule);
		const b = [...findings]
			.reverse()
			.sort(compareFindings)
			.map((f) => f.rule);
		expect(a).toEqual(b);
		expect(a[0]).toBe('no-h1-in-body');
	});

	test('sorts by line within one file', () => {
		const sorted = [
			finding({ location: { kind: 'file', file: 'a.md', line: 20 }, rule: 'no-triad' }),
			finding({ location: { kind: 'file', file: 'a.md', line: 2 }, rule: 'no-em-dash' }),
		].sort(compareFindings);
		expect(sorted[0]?.rule).toBe('no-em-dash');
	});

	test('a project-level finding sorts before any file', () => {
		const sorted = [
			finding({ location: { kind: 'file', file: 'a.md' } }),
			finding({ location: { kind: 'project' } }),
		].sort(compareFindings);
		expect(sorted[0]?.location.kind).toBe('project');
	});

	test('every category is orderable', () => {
		expect(new Set(FINDING_CATEGORIES).size).toBe(FINDING_CATEGORIES.length);
	});
});

describe('checkRow', () => {
	test('has four states, so a skipped check cannot read as a pass', () => {
		expect([...CHECK_STATES]).toEqual(['pass', 'fail', 'skipped', 'not-run']);
	});

	test('a clean check that examined something passes', () => {
		const row = checkRow('wiring-tsconfig-path', 1, 'entries', []);
		expect(row.status).toBe('pass');
		expect(row.examined).toBe(1);
	});

	test('a clean check that examined nothing FAILS, and says why', () => {
		// The rule lives here rather than in a renderer because three renderers read
		// this data and one of them holding the rule means the other two disagree.
		const row = checkRow('wiring-routes', 0, 'routes', []);
		expect(row.status).toBe('fail');
		expect(row.note).toContain('Examined zero routes');
	});

	test('an error finding fails the row regardless of the count', () => {
		const row = checkRow('wiring-routes', 12, 'routes', [finding()]);
		expect(row.status).toBe('fail');
	});

	test('a warning does not fail the row', () => {
		const row = checkRow('wiring-routes', 12, 'routes', [finding({ severity: 'warning' })]);
		expect(row.status).toBe('pass');
	});

	test('the unit is carried so the message can name what was counted', () => {
		expect(checkRow('x', 0, 'submodule entries', []).note).toContain('submodule entries');
	});
});

describe('the null convention for diagnostics', () => {
	test('an absent suggestion is null rather than an empty string', () => {
		// An agent must be able to tell "there is no suggested fix" from "the suggested
		// fix is to delete this text".
		const f = finding();
		expect(f.suggestion).toBeNull();
		expect('suggestion' in f).toBe(true);
	});
});
