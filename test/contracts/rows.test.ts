/**
 * The four states, and which constructor can actually reach each of them.
 *
 * `scripts/lib/report.mjs` has had `PASS`, `FAIL`, `SKIPPED` and `NOT RUN` since step 1
 * and `src/contracts/diagnostics.ts` could construct only two of them, so the CLI and the
 * ladder could not have described the same run. `skippedRow`, `notRunRow` and `failedRow`
 * close that, and the closure is only real if every state is reachable: a contract
 * declaring four states and offering constructors for two is the same false green as a
 * report whose rows all went dark.
 *
 * The reachability sweep below is what makes that checkable rather than asserted. Each
 * constructor claims the states it produces, the claims are checked against
 * `CHECK_STATES` in both directions, and every claim is proved by calling the
 * constructor rather than by naming it. Delete `skippedRow` and the union is short one
 * member; add a fifth state to `CHECK_STATES` and nothing reaches it until something is
 * written that does.
 *
 * `checkRow`'s individual arms (the error gate, the warning gate, the unit in the note)
 * are pinned in `test/contracts/diagnostics.test.ts` and are not repeated here. What is
 * repeated is the zero-examined coercion, because it is the one arm this file's table
 * depends on to reach `fail` from `checkRow` at all.
 */

import { describe, expect, test } from 'vitest';

import {
	CHECK_STATES,
	checkRow,
	failedRow,
	notRunRow,
	skippedRow,
	type CheckRow,
	type CheckState,
	type Finding,
} from '../../src/contracts/diagnostics.js';

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		rule: 'wiring-tsconfig-path',
		severity: 'error',
		category: 'wiring',
		location: { kind: 'file', file: 'apps/front/tsconfig.json' },
		locale: null,
		message: 'There is no path mapping for the docs package.',
		consequence: 'Every import of the package fails to resolve at build time.',
		remediation: null,
		suggestion: null,
		excerpt: null,
		...overrides,
	};
}

describe('skippedRow', () => {
	test('is skipped, carries the reason as its note, and examined nothing', () => {
		const row = skippedRow(
			'wiring-allow-paths',
			'allowlist entries',
			'This repository has no scripts/sync-public.sh, so there is no public mirror to widen.',
		);
		expect(row.status).toBe('skipped');
		expect(row.examined).toBe(0);
		expect(row.unit).toBe('allowlist entries');
		expect(row.findings).toEqual([]);
		// The reason is the note and not a separate field: a skip whose reason is absent is
		// indistinguishable from a check somebody switched off, and the renderer prints the
		// note in the column a pass uses for its count.
		expect(row.note).toContain('no public mirror');
	});
});

describe('notRunRow', () => {
	test('is not-run, which is the failing half of the two zero-examined states', () => {
		const row = notRunRow('check', 'documentation trees', 'The tree is not in a git repository.');
		expect(row.status).toBe('not-run');
		expect(row.examined).toBe(0);
		expect(row.findings).toEqual([]);
		expect(row.note).toBe('The tree is not in a git repository.');
	});

	test('is a different state from skipped, given the same three arguments', () => {
		// The pair is the whole point. If these ever collapsed into one state, deleting the
		// thing a check reads would produce a row that reads as a decision somebody made.
		const same = ['id', 'files', 'the same reason'] as const;
		expect(notRunRow(...same).status).not.toBe(skippedRow(...same).status);
	});
});

describe('failedRow', () => {
	test('fails with a note and no findings, which is what it exists for', () => {
		// A config file that is not JSON has no rule id to name. `checkRow` would report it
		// as a pass with a count, and synthesising a finding would put a rule in
		// `Finding.rule` that nothing else in the package reports under.
		const row = failedRow('label-shape', 5, 'assertions', '"1.0.0 " is not a version label.');
		expect(row.status).toBe('fail');
		expect(row.findings).toEqual([]);
		expect(row.note).toContain('not a version label');
		// The count is kept rather than zeroed, so a failure still reports what it looked at.
		expect(row.examined).toBe(5);
	});
});

describe('checkRow still refuses to pass a check that examined nothing', () => {
	test('zero examined and no findings is a failure, not a pass', () => {
		const row = checkRow('wiring-routes', 0, 'routes', []);
		expect(row.status).toBe('fail');
		expect(row.note).toContain('Examined zero routes');
	});

	test('and the same call with something examined passes', () => {
		expect(checkRow('wiring-routes', 3, 'routes', []).status).toBe('pass');
	});
});

/**
 * Every state, claimed by the constructor that reaches it and proved by calling it.
 *
 * The `why` is not decoration: it is the sentence a reader needs when a claim starts
 * failing, and it is what stops this table being satisfied by four calls to `checkRow`
 * with four different arguments.
 */
interface Reach {
	readonly state: CheckState;
	readonly constructor: string;
	readonly why: string;
	readonly build: () => CheckRow;
}

const REACHES: readonly Reach[] = [
	{
		state: 'pass',
		constructor: 'checkRow',
		why: 'A check that ran, examined something and found nothing.',
		build: () => checkRow('wiring-submodule', 2, 'submodule entries', []),
	},
	{
		state: 'fail',
		constructor: 'checkRow',
		why: 'An error finding, which is the ordinary way a check fails.',
		build: () => checkRow('wiring-submodule', 2, 'submodule entries', [finding()]),
	},
	{
		state: 'fail',
		constructor: 'failedRow',
		why: 'A failure with no rule to name, such as a config file that is not JSON.',
		build: () => failedRow('wiring-tsconfig-path', 1, 'tsconfig files', 'It is not JSON.'),
	},
	{
		state: 'skipped',
		constructor: 'skippedRow',
		why: 'Nothing to examine, and somebody decided that is correct here.',
		build: () => skippedRow('wiring-allow-paths', 'allowlist entries', 'There is no mirror.'),
	},
	{
		state: 'not-run',
		constructor: 'notRunRow',
		why: 'Something this check needed was missing, so it has no verdict to give.',
		build: () => notRunRow('bundle-manifest', 'manifests', 'There is no manifest.json here.'),
	},
];

describe('every state in the contract is reachable through a constructor', () => {
	test.each(
		REACHES.map((reach) => [`${reach.constructor} reaches ${reach.state}`, reach] as const),
	)('%s', (_name, reach) => {
		// Proved by construction rather than by a sentence saying so. A claim that named a
		// state and never built one would be satisfied by a constructor that had been
		// deleted, which is the shape this whole file exists to refuse.
		expect(reach.build().status, reach.why).toBe(reach.state);
	});

	test('the claimed states are exactly CHECK_STATES, in both directions', () => {
		const claimed = new Set(REACHES.map((reach) => reach.state));
		const missing = CHECK_STATES.filter((state) => !claimed.has(state));
		expect(missing, 'no constructor in this table reaches these states').toEqual([]);

		const unknown = [...claimed].filter(
			(state) => !(CHECK_STATES as readonly string[]).includes(state),
		);
		expect(unknown, 'claimed by the table and not in CHECK_STATES').toEqual([]);
		expect(claimed.size).toBe(CHECK_STATES.length);

		// And the same over what the constructors actually produced, rather than over what
		// the table says they produce. Without this line the union check is a statement about
		// a literal in this file: measured, making `skippedRow` return `pass` leaves it green
		// and only the per-entry test above goes red.
		const produced = new Set(REACHES.map((reach) => reach.build().status));
		expect([...produced].sort()).toEqual([...CHECK_STATES].sort());
	});

	test('no state is reachable only through checkRow', () => {
		// The direction that catches the gap step 5 closed. Before `skippedRow` and
		// `notRunRow` existed, a table like this one could have been written with four
		// entries all calling `checkRow`, and it would have proved nothing: `checkRow`
		// reaches two of the four states and there was no third and fourth constructor.
		const beyondCheckRow = new Set(
			REACHES.filter((reach) => reach.constructor !== 'checkRow').map((reach) => reach.state),
		);
		expect([...beyondCheckRow].sort()).toEqual(['fail', 'not-run', 'skipped']);
	});
});
