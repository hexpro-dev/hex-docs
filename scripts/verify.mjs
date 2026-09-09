#!/usr/bin/env node
/**
 * The whole ladder, in one command.
 *
 * `pnpm verify` is what a person or an agent runs to answer "is this repository in a
 * good state", and it is the only place that answer is assembled. Every row carries a
 * count of what it examined and a state, and a row that could not run says so rather
 * than being left out, because a report that quietly omits a check reads as a clean
 * sweep.
 *
 * Each step spawns the real command rather than reimplementing it. A verifier with its
 * own idea of how to typecheck would eventually disagree with `pnpm typecheck`, and the
 * one that gets trusted would be the wrong one.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, notRun, render } from './lib/report.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Every tsconfig in the repository, which is what `pnpm typecheck` has to cover.
 *
 * Derived rather than listed. The point of the typecheck row is that `kit/tsconfig.json`
 * is the only thing that compiles the drift assertions, which have no runtime statements
 * and no test importing them, so a run that quietly skips it proves nothing about them.
 *
 * @returns {{ expected: number, what: string }}
 */
function countTsconfigs() {
	const names = [
		...readdirSync(ROOT).filter((name) => /^tsconfig(\..+)?\.json$/.test(name)),
		...readdirSync(join(ROOT, 'kit'))
			.filter((name) => /^tsconfig(\..+)?\.json$/.test(name))
			.map((name) => `kit/${name}`),
	].sort();
	return { expected: names.length, what: names.join(', ') };
}

/**
 * @typedef {object} Step
 * @property {string} name
 * @property {string[]} argv
 * @property {string} unit
 * @property {(output: string) => number} count  How many things the command examined.
 * @property {() => { expected: number, what: string }} [expect]  A count measured from
 *   somewhere other than the command's own output, so a step that runs a subset of what
 *   it should reports a shortfall rather than a smaller number.
 * @property {(output: string) => { ran: number, expected: number, what: string }} [subset]
 *   A second pair of numbers, for a step whose headline count is not the thing that can
 *   silently shrink. A test row counts tests, and a suite the runner never collected makes
 *   that number smaller rather than making the row fail; the number of files collected is
 *   what can be compared against the disk.
 * @property {boolean} [allowZero]  Whether a row that examined nothing may still pass.
 *   True for `paint` alone. `check-paint.mjs` produces a single row, and with no browser
 *   installed that row is `skipped(...)`, so the whole guard really does exit 0 having
 *   examined zero probes; in CI the same state is a failure, because the runner image ships
 *   Chrome. Measured against the other candidate: `check-infra.mjs`'s first row is pure
 *   JavaScript, runs on every machine and counts one assertion per thing it checked, so
 *   `HEXDOCS_TERRAFORM=/nonexistent/terraform` gives a full invariants row and three SKIPPED
 *   rows rather than a zero. A zero from that guard would mean a checkout with no
 *   `infra/*.tf` in it, which is a failure and must stay one, so it carries no flag.
 *   Every other row that examined nothing has stopped examining something.
 * @property {string} [note]
 */

/** Pulls "Tests  226 passed" out of vitest's summary. */
export const countTests = (output) => Number(/Tests\s+(\d+)\s+passed/.exec(output)?.[1] ?? 0);

/** Pulls "Test Files  18 passed" out of the same summary. */
export const countTestFiles = (output) =>
	Number(/Test Files\s+(\d+)\s+passed/.exec(output)?.[1] ?? 0);

/**
 * Every test file on disk under a directory.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function testFilesIn(dir) {
	/** @type {string[]} */
	const found = [];
	/** @type {string[]} */
	const queue = [dir];
	while (queue.length > 0) {
		const current = /** @type {string} */ (queue.pop());
		/** @type {import('node:fs').Dirent[]} */
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
				queue.push(full);
			} else if (/\.test\.tsx?$/.test(entry.name)) {
				found.push(full);
			}
		}
	}
	return found.sort();
}

/**
 * How many test files a suite should have collected, measured from the disk.
 *
 * The headline count for these two rows is the number of tests, and that number cannot
 * report a gap: a test file the runner never collected simply makes it smaller, and
 * smaller is not failing. The failure this closes is real and was reachable here.
 * `vitest.config.ts` matched `test/**\/*.test.ts` and not `.tsx`, so a whole suite written
 * as a component test would have collected nothing while the ladder printed PASS.
 *
 * @param {string} dir
 * @returns {(output: string) => { ran: number, expected: number, what: string }}
 */
function expectTestFiles(dir) {
	return (output) => {
		const files = testFilesIn(join(ROOT, dir));
		return {
			ran: countTestFiles(output),
			expected: files.length,
			what: `${files.length} test files under ${dir}/`,
		};
	};
}

/** Pulls "N things examined" out of this package's own report footer. */
export const countExamined = (output) => Number(/(\d+) things examined/.exec(output)?.[1] ?? 0);

/**
 * How much of the command surface the guard actually reached, against the registry.
 *
 * The headline count cannot answer this. It adds four rows in four different units,
 * commands plus findings plus tools plus launchers, so a guard that stopped exercising
 * the MCP handshake entirely would report a smaller number and smaller is not failing.
 * That is the same shape as the test rows, which is why this uses `subset` rather than
 * `expect`.
 *
 * The two numbers compared are the two that can shrink silently and mean something: the
 * commands `--help` lists and the tools the server advertises, both against the emitted
 * catalogue. The findings count is a fact about the fixture corpus rather than about the
 * registry, and the launcher count is two, so neither belongs here.
 *
 * @param {string} output
 * @returns {{ ran: number, expected: number, what: string }}
 */
function surfaceSubset(output) {
	const catalogue = JSON.parse(readFileSync(join(ROOT, 'kit', 'schema', 'tools-1.json'), 'utf8'));
	const commands = catalogue.commands.length;
	const tools = catalogue.commands.filter((command) => command.tool !== null).length;
	const listed = Number(/help\s+PASS\s+(\d+) commands/.exec(output)?.[1] ?? 0);
	const advertised = Number(/mcp handshake\s+PASS\s+(\d+) tools/.exec(output)?.[1] ?? 0);
	return {
		ran: listed + advertised,
		expected: commands + tools,
		what: `${commands} commands and ${tools} tools in kit/schema/tools-1.json`,
	};
}

/** @type {Step[]} */
export const STEPS = [
	{
		name: 'typecheck',
		// The verbose variant, for the same reason the formatting step uses one: the
		// count has to be measured rather than asserted. A literal `3` here reported
		// three configurations after `-p kit/tsconfig.json` was dropped from the script,
		// and that third configuration is the only thing that compiles the drift
		// assertions, which have no runtime statements and no test importing them. The
		// ladder's own note claims they ran, which is what made the wrong count harmful.
		argv: ['pnpm', 'typecheck:verbose'],
		unit: 'configurations',
		count: (output) => (output.match(/^Files:/gm) ?? []).length,
		// Measuring the count was not enough on its own. Dropping the kit invocation
		// made the row report two configurations and still PASS, with a note that went
		// on naming three. The expected number comes off the disk, so adding a tsconfig
		// and forgetting to typecheck it fails here too.
		expect: countTsconfigs,
	},
	{
		name: 'runtime tests',
		argv: ['pnpm', 'test:coverage'],
		unit: 'tests',
		count: countTests,
		subset: expectTestFiles('test'),
	},
	{
		name: 'toolchain tests',
		argv: ['pnpm', 'test:kit:coverage'],
		unit: 'tests',
		count: countTests,
		subset: expectTestFiles('kit/test'),
	},
	{
		name: 'cli surface',
		// The only row that runs the launcher. Everything else about the CLI is a vitest
		// test importing the modules, which never executes `kit/bin/hexdocs`, never
		// resolves tsx through it, and never proves stdout stays clean while the same
		// launcher is serving a protocol. That is the path every consumer uses and the
		// only one with a shell script in it.
		argv: ['pnpm', 'check:cli'],
		unit: 'things',
		count: countExamined,
		// Measured against the registry rather than against the guard's own output, so a
		// smoke case deleted from the guard reports a shortfall naming what should have
		// run instead of simply reporting a smaller number. Same lesson as the typecheck
		// row's `countTsconfigs`, applied to the surface rather than to the configs.
		subset: surfaceSubset,
	},
	{
		name: 'dependency gate',
		argv: ['pnpm', 'check:deps'],
		unit: 'things',
		count: countExamined,
	},
	{
		name: 'house lint',
		argv: ['pnpm', 'lint'],
		unit: 'things',
		count: countExamined,
	},
	{
		name: 'paint',
		// The one property of this package that only a CSS engine has an opinion about:
		// whether a token override actually reaches the element it is meant to. The script
		// says at length why a DOM library cannot answer it, and both of the two that were
		// measured get it wrong in a way that passes on the broken stylesheet.
		argv: ['pnpm', 'paint'],
		unit: 'probes',
		count: countExamined,
		allowZero: true,
	},
	{
		name: 'terraform',
		// The infrastructure half, offline. `terraform fmt` needs nothing at all, and
		// `validate` and `test` need neither network nor credentials once
		// `init -backend=false` has run, which is what keeps this row inside the
		// `permissions: contents: read` the CI job already declares. The credentialled
		// verification is `pnpm check:stack`, and it is deliberately not here: a row that
		// cannot run reports NOT RUN, NOT RUN fails the run, and a row needing an AWS profile
		// would fail this ladder on every machine that does not have one.
		argv: ['pnpm', 'check:infra'],
		unit: 'things',
		count: countExamined,
		// No `allowZero`, deliberately, and this is the note that stops it coming back. The
		// guard's own first row is pure JavaScript and always runs: with no terraform binary at
		// all it still reports its whole invariants row and three SKIPPED rows. The only way
		// this step can reach zero is a checkout with nothing under `infra/`, and `stackInvariants`
		// answers that with a FAIL rather than an empty pass, so the guard exits 1 and this row
		// is built from the exit code before any exemption is consulted. The flag was here for
		// a state the guard cannot produce, which is a disarm sitting ready for the day
		// somebody softens that arm.
	},
	{
		name: 'formatting',
		// The verbose variant, because `prettier --check` prints no file count and,
		// worse, exits 0 when its pattern matched nothing at all. That is exactly the
		// failure this ladder's counting rule exists to catch, so the ladder needs a
		// number prettier will only give at debug level: one `resolve config from` line
		// per file it actually read.
		argv: ['pnpm', 'format:check:verbose'],
		unit: 'files',
		count: (output) => (output.match(/resolve config from/g) ?? []).length,
		note: 'prettier',
	},
];

/**
 * @param {Step[]} [steps]
 * @returns {import('./lib/report.mjs').CheckResult[]}
 */
export function run(steps = STEPS) {
	/** @type {import('./lib/report.mjs').CheckResult[]} */
	const results = [];
	let blocked = false;

	for (const step of steps) {
		if (blocked) {
			results.push(notRun(step.name, step.unit, 'An earlier step failed.'));
			continue;
		}

		const [command, ...args] = step.argv;
		const spawned = spawnSync(/** @type {string} */ (command), args, {
			cwd: ROOT,
			encoding: 'utf8',
			env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
		});

		const output = `${spawned.stdout ?? ''}${spawned.stderr ?? ''}`;

		if (spawned.error !== undefined) {
			results.push(notRun(step.name, step.unit, `Could not run ${step.argv.join(' ')}.`));
			blocked = true;
			continue;
		}

		if (spawned.status !== 0) {
			results.push(
				check(step.name, step.count(output), step.unit, [
					`\`${step.argv.join(' ')}\` exited ${spawned.status}.`,
					// Debug noise is how a step gets a useful count; it is not how a
					// failure gets read.
					...output
						.split('\n')
						.filter((line) => !line.startsWith('[debug]'))
						.join('\n')
						.trimEnd()
						.split('\n')
						.slice(-25),
				]),
			);
			blocked = true;
			continue;
		}

		const measured = step.count(output);
		/** @type {string[]} */
		const shortfall = [];
		let note = step.note;
		if (step.expect !== undefined) {
			const { expected, what } = step.expect();
			note = what;
			if (measured !== expected) {
				shortfall.push(
					`ran ${measured} of ${expected}. ${what}. A step that examined a subset of ` +
						`what it should is a gap, not a smaller number.`,
				);
			}
		}
		if (step.subset !== undefined) {
			const { ran, expected, what } = step.subset(output);
			note = note === undefined ? what : `${note}, ${what}`;
			if (ran !== expected) {
				shortfall.push(
					`collected ${ran} of ${expected}. ${what}. A suite the runner never ` +
						`collected lowers the count above rather than failing, which is why this ` +
						`number is compared against the disk.`,
				);
			}
		}
		const options = {
			...(note === undefined ? {} : { note }),
			...(step.allowZero === true ? { allowZero: true } : {}),
		};
		results.push(check(step.name, measured, step.unit, shortfall, options));
	}

	return results;
}

/**
 * Whether this file is the program, resolved through symlinks on both sides.
 *
 * The text comparison the other guards here use, `import.meta.url` against
 * `pathToFileURL(argv[1]).href`, is false through any symlink: node resolves
 * `import.meta.url` through realpath and argv keeps the path the shell was given. The
 * script then prints nothing and exits 0.
 *
 * That is a latent trap in the other guards and a live one here, which is why only this
 * file is changed. Every other guard is spawned as `pnpm <script>` with a relative path,
 * where the comparison cannot fire, and if one ever did go silent its ladder row would read
 * zero and `check()` turns a zero into a FAIL. This file is the ladder. Nothing wraps it, it
 * is the one a person or a CI step invokes by whatever path they happen to have, and a
 * silent exit 0 from it is the whole verification reporting success having run nothing.
 */
function isProgram() {
	const argv = process.argv[1];
	if (argv === undefined) return false;
	try {
		return realpathSync(argv) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isProgram()) {
	const { ok } = render('hex-docs verification', run());
	process.exit(ok ? 0 : 1);
}
