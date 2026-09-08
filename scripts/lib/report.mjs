/**
 * The check ladder.
 *
 * Every guard in this repository reports through here, in four states, and every row
 * carries a count of what it examined. The count is the point:
 * `kcalc-web/front/scripts/verify.mjs` established the rule and this enforces it, so
 * a checker that walked an empty directory and exited 0 is reported as a FAIL rather
 * than a PASS. A guard that examined nothing is not a guard, and the failure mode is
 * always the same, a glob that stopped matching after a directory moved.
 *
 * Zero dependencies, plain `.mjs`, because these run from a `prebuild` hook on a
 * machine that may not have installed anything yet.
 */

/** @typedef {'PASS' | 'FAIL' | 'SKIPPED' | 'NOT RUN'} CheckState */

/**
 * @typedef {object} CheckResult
 * @property {string} name
 * @property {CheckState} state
 * @property {number} examined How many things this check actually looked at.
 * @property {string} unit     What it counted, plural. "files", "imports", "pages".
 * @property {string[]} [problems] One line per problem, printed under the row.
 * @property {string} [note]   Why it was skipped, or what the count means.
 */

const COLOUR = process.stdout.isTTY && !process.env['NO_COLOR'];

const PAINT = {
	PASS: (s) => (COLOUR ? `\u001b[32m${s}\u001b[0m` : s),
	FAIL: (s) => (COLOUR ? `\u001b[31m${s}\u001b[0m` : s),
	SKIPPED: (s) => (COLOUR ? `\u001b[33m${s}\u001b[0m` : s),
	'NOT RUN': (s) => (COLOUR ? `\u001b[90m${s}\u001b[0m` : s),
	dim: (s) => (COLOUR ? `\u001b[90m${s}\u001b[0m` : s),
	bold: (s) => (COLOUR ? `\u001b[1m${s}\u001b[0m` : s),
};

/**
 * Builds a result, converting a passing check that examined nothing into a failure.
 *
 * Callers pass the count they actually measured rather than a boolean, so this is
 * the only place the rule lives and no individual check can forget it.
 *
 * @param {string} name
 * @param {number} examined
 * @param {string} unit
 * @param {string[]} problems
 * @param {{ note?: string, allowZero?: boolean }} [options]
 * @returns {CheckResult}
 */
export function check(name, examined, unit, problems, options = {}) {
	const failed = problems.length > 0;
	if (failed) {
		return { name, state: 'FAIL', examined, unit, problems };
	}
	if (examined === 0 && options.allowZero !== true) {
		return {
			name,
			state: 'FAIL',
			examined,
			unit,
			problems: [
				`Examined zero ${unit}. A check that looked at nothing has not passed. ` +
					`Either the glob stopped matching or the directory moved.`,
			],
		};
	}
	const result = { name, state: /** @type {CheckState} */ ('PASS'), examined, unit };
	if (options.note !== undefined) return { ...result, note: options.note };
	return result;
}

/**
 * A check that deliberately did not run, with the reason.
 *
 * Distinct from PASS so a report cannot claim coverage it does not have, and distinct
 * from NOT RUN because this state is a decision somebody made and wrote down, not a
 * failure. A run of nothing but SKIPPED rows is still `ok`.
 *
 * @param {string} name
 * @param {string} unit
 * @param {string} reason
 * @returns {CheckResult}
 */
export function skipped(name, unit, reason) {
	return { name, state: 'SKIPPED', examined: 0, unit, note: reason };
}

/**
 * A check that should have run and did not, because something before it failed or the
 * data it needed was missing.
 *
 * This is a failing state. `render` returns `ok: false` for a run containing one, and
 * that is the whole point: without it, deleting the house rule pack makes every row
 * NOT RUN, the summary reads "all clear", and the guard exits 0 having checked
 * nothing. Use `skipped` for the deliberate case.
 *
 * @param {string} name
 * @param {string} unit
 * @param {string} reason
 * @returns {CheckResult}
 */
export function notRun(name, unit, reason) {
	return { name, state: 'NOT RUN', examined: 0, unit, note: reason };
}

/**
 * @param {string} title
 * @param {CheckResult[]} results
 * @returns {{ ok: boolean, failed: number, ran: number, notRun: number }}
 */
export function render(title, results) {
	const width = results.reduce((max, r) => Math.max(max, r.name.length), 0);

	process.stdout.write(`\n${PAINT.bold(title)}\n\n`);

	for (const result of results) {
		const label = result.name.padEnd(width);
		const state = PAINT[result.state](result.state.padEnd(7));
		const count =
			result.state === 'PASS' || result.state === 'FAIL'
				? PAINT.dim(`${result.examined} ${result.unit}`)
				: PAINT.dim(result.note ?? '');
		process.stdout.write(`  ${label}  ${state}  ${count}\n`);

		if (result.state === 'PASS' && result.note !== undefined) {
			process.stdout.write(`  ${' '.repeat(width)}  ${' '.repeat(7)}  ${PAINT.dim(result.note)}\n`);
		}
		for (const problem of result.problems ?? []) {
			for (const line of problem.split('\n')) {
				process.stdout.write(`  ${' '.repeat(width)}  ${PAINT.FAIL('|')}  ${line}\n`);
			}
		}
	}

	const failed = results.filter((r) => r.state === 'FAIL').length;
	const notRunCount = results.filter((r) => r.state === 'NOT RUN').length;
	const ran = results.filter((r) => r.state === 'PASS' || r.state === 'FAIL').length;
	const examined = results.reduce((total, r) => total + r.examined, 0);

	// A NOT RUN row fails the run. Counting only failures was how a report in which
	// nothing executed printed "all clear" and exited 0: delete the rule pack and every
	// row in the house lint becomes NOT RUN, or break the first step of the
	// verification ladder and every later step does. Both states are indistinguishable
	// from success to the exit code, and CI runs nothing but the exit code.
	const ok = failed === 0 && notRunCount === 0;

	// A run of nothing but SKIPPED rows is still `ok`, which is what the state means, and
	// the exit code above is unchanged. What it must not print is "all clear": nothing ran,
	// and those two words above a column of SKIPPED tell a reader the opposite of what
	// happened. `kit/src/cli/render.ts` renders the same rows and says the same thing, and
	// `kit/test/cli/render.test.ts` runs both over one row set to keep them saying it.
	const skippedCount = results.filter((r) => r.state === 'SKIPPED').length;
	const verdict =
		failed > 0
			? PAINT.FAIL(`${failed} failed`)
			: notRunCount > 0
				? PAINT.FAIL(`${notRunCount} did not run`)
				: skippedCount === results.length && results.length > 0
					? PAINT.SKIPPED('nothing ran')
					: PAINT.PASS('all clear');

	process.stdout.write(
		`\n  ${verdict} ` +
			PAINT.dim(`(${ran}/${results.length} checks ran, ${examined} things examined)`) +
			'\n\n',
	);

	return { ok, failed, ran, notRun: notRunCount };
}

/**
 * Renders and exits. Splitting this out keeps `render` callable from a test.
 *
 * @param {string} title
 * @param {CheckResult[]} results
 */
export function renderAndExit(title, results) {
	const { ok } = render(title, results);
	process.exit(ok ? 0 : 1);
}
