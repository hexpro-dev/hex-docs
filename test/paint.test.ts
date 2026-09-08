import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, test } from 'vitest';

// @ts-expect-error -- a zero-dependency guard, written as .mjs like the others
import { findBrowser, run as runPaint } from '../scripts/check-paint.mjs';
import type { CheckResult } from '../scripts/lib/report.mjs';
import { REPO_ROOT } from './support/golden.js';

const BROWSER = findBrowser() as string | undefined;

describe('finding a browser', () => {
	test('honours an explicit path', () => {
		process.env.HEXDOCS_CHROME = '/definitely/not/here';
		try {
			// An explicit path that does not exist is not a reason to go looking elsewhere.
			// Somebody who set the variable meant that browser, and silently using a
			// different one would make the row report on something they did not ask for.
			expect(findBrowser()).toBeUndefined();
		} finally {
			delete process.env.HEXDOCS_CHROME;
		}
	});

	test('finds one on this machine, or says so', () => {
		// Not an assertion that a browser exists: this suite runs on machines where none
		// does, and that is the state the skip below is for.
		expect(BROWSER === undefined || BROWSER.length > 0).toBe(true);
	});
});

describe('when there is no browser', () => {
	test('the row is skipped, because a developer without one has not broken anything', async () => {
		process.env.HEXDOCS_CHROME = '/definitely/not/here';
		const ci = process.env.CI;
		delete process.env.CI;
		try {
			const rows = (await runPaint()) as CheckResult[];
			expect(rows.length).toBe(1);
			expect(rows[0]?.state).toBe('SKIPPED');
			// A skip carries its reason in the note rather than in a problem, which is the
			// difference between the two states: a problem is something to fix.
			expect(rows[0]?.note ?? '').toContain('HEXDOCS_CHROME');
			expect(rows[0]?.problems ?? []).toEqual([]);
		} finally {
			delete process.env.HEXDOCS_CHROME;
			if (ci !== undefined) process.env.CI = ci;
		}
	});

	test('the same state in CI is a failure, because the runner image ships one', async () => {
		// The distinction that keeps SKIPPED meaning "deliberate". A paint row that found no
		// browser on a runner means the image changed under the check, and the check that
		// catches the theming defect would otherwise go quiet without anybody noticing.
		process.env.HEXDOCS_CHROME = '/definitely/not/here';
		const ci = process.env.CI;
		process.env.CI = 'true';
		try {
			const rows = (await runPaint()) as CheckResult[];
			expect(rows[0]?.state).toBe('FAIL');
			expect(rows[0]?.problems?.[0] ?? '').toContain('broken environment');
		} finally {
			delete process.env.HEXDOCS_CHROME;
			if (ci === undefined) delete process.env.CI;
			else process.env.CI = ci;
		}
	});
});

describe.skipIf(BROWSER === undefined)('with a browser', () => {
	test('every probe resolves and the token contract holds', async () => {
		// The same work the ladder's own row does, run once here so the harness has a
		// covered failure path rather than only a green one on a runner. The ladder is the
		// gate; this is the evidence that the code behind it works when called.
		const rows = (await runPaint()) as CheckResult[];
		expect(rows.length).toBe(1);
		expect(rows[0]?.problems ?? []).toEqual([]);
		expect(rows[0]?.state).toBe('PASS');
		expect(rows[0]?.examined).toBe(7);
		expect(rows[0]?.unit).toBe('probes');
	}, 60_000);

	/**
	 * The failure path, driven against a deliberately broken stylesheet.
	 *
	 * This is how the other guards prove they can fail, and it is the only way to know that
	 * a green paint row means anything. The break is the real one: declare the chain once
	 * on the docs root and read the short name at the point of use, which is the
	 * optimisation the design pass proposed. It passes the check the token contract
	 * prescribes and fails only for a rebinding at or below the root, so a check without
	 * the descendant probe would have signed it off.
	 */
	test('an alias declared on the docs root is caught, and the message names the case', async () => {
		const target = mkdtempSync(join(tmpdir(), 'hexdocs-paint-'));
		try {
			const css = readFileSync(join(REPO_ROOT, 'src', 'render', 'docs.css'), 'utf8')
				.replace(
					'.hx-root {\n\tcolor: var(--hx-ink, #f2ede6);',
					'.hx-root {\n\t--_link: var(--hx-accent-link, #5ba3f5);\n\tcolor: var(--hx-ink, #f2ede6);',
				)
				.replace(
					'.hx-root .hx-prose a {\n\tcolor: var(--hx-accent-link, #5ba3f5);',
					'.hx-root .hx-prose a {\n\tcolor: var(--_link);',
				);
			expect(css).toContain('--_link');
			const path = join(target, 'src', 'render', 'docs.css');
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, css, 'utf8');

			const rows = (await runPaint(target)) as CheckResult[];
			expect(rows[0]?.state).toBe('FAIL');
			// Exactly one problem, and it is the descendant. The two placements the token
			// contract's own prescribed check uses still pass on the broken version, which
			// is the whole finding: a check without this probe would have signed it off.
			const problems = rows[0]?.problems ?? [];
			expect(problems.length).toBe(1);
			expect(problems[0]?.startsWith('An override on the descendant')).toBe(true);
		} finally {
			rmSync(target, { recursive: true, force: true });
		}
	}, 60_000);
});
