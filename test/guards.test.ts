import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// @ts-expect-error -- zero-dependency .mjs guards, deliberately untyped.
import { check, notRun, render, skipped } from '../scripts/lib/report.mjs';
// @ts-expect-error -- see above.
import { run as runImportGate } from '../scripts/check-imports.mjs';
// @ts-expect-error -- see above.
import { REQUIRED_DIRS, run as runHouseLint } from '../scripts/lint.mjs';
// @ts-expect-error -- see above.
import {
	countExamined,
	countTestFiles,
	countTests,
	run as runLadder,
	STEPS,
} from '../scripts/verify.mjs';

type CheckResult = {
	name: string;
	state: 'PASS' | 'FAIL' | 'SKIPPED' | 'NOT RUN';
	examined: number;
	unit: string;
	problems?: string[];
	note?: string;
};

describe('the check ladder', () => {
	test('a clean check that examined something passes', () => {
		expect(check('x', 3, 'files', []).state).toBe('PASS');
	});

	test('a clean check that examined nothing FAILS, with the reason', () => {
		const row = check('x', 0, 'files', []) as CheckResult;
		expect(row.state).toBe('FAIL');
		expect(row.problems?.[0]).toContain('Examined zero files');
		expect(row.problems?.[0]).toContain('glob stopped matching');
	});

	test('zero can be allowed explicitly, which is a decision rather than a default', () => {
		expect((check('x', 0, 'files', [], { allowZero: true }) as CheckResult).state).toBe('PASS');
	});

	test('any problem fails the row regardless of the count', () => {
		expect((check('x', 99, 'files', ['broken']) as CheckResult).state).toBe('FAIL');
	});

	test('skipped and not-run are distinct from pass, so a report cannot claim coverage', () => {
		expect((skipped('x', 'files', 'no network') as CheckResult).state).toBe('SKIPPED');
		expect((notRun('x', 'files', 'an earlier check failed') as CheckResult).state).toBe('NOT RUN');
	});

	test('render reports the failure count and how many checks actually ran', () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const summary = render('t', [
			check('a', 1, 'files', []),
			check('b', 1, 'files', ['nope']),
			skipped('c', 'files', 'why'),
		]);
		write.mockRestore();
		expect(summary).toEqual({ ok: false, failed: 1, ran: 2, notRun: 0 });
	});

	test('a run in which nothing executed is NOT a pass', () => {
		// This is how the whole house lint went dark: delete the rule pack and every row
		// becomes NOT RUN. Counting only failures made that print "all clear" and exit 0,
		// and CI runs nothing but the exit code.
		const chunks: string[] = [];
		const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			chunks.push(String(chunk));
			return true;
		});
		const summary = render('t', [
			notRun('a', 'files', 'an earlier step failed'),
			notRun('b', 'files', 'an earlier step failed'),
		]);
		write.mockRestore();
		expect(summary.ok).toBe(false);
		expect(summary.notRun).toBe(2);
		expect(chunks.join('')).toContain('2 did not run');
		expect(chunks.join('')).not.toContain('all clear');
	});

	test('one NOT RUN row fails an otherwise clean run', () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const summary = render('t', [check('a', 3, 'files', []), notRun('b', 'files', 'why')]);
		write.mockRestore();
		expect(summary.ok).toBe(false);
	});

	test('SKIPPED stays a pass, because it is a decision somebody wrote down', () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const summary = render('t', [check('a', 3, 'files', []), skipped('b', 'files', 'no network')]);
		write.mockRestore();
		expect(summary).toEqual({ ok: true, failed: 0, ran: 1, notRun: 0 });
	});

	test('render prints the problem lines under the row that produced them', () => {
		const chunks: string[] = [];
		const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			chunks.push(String(chunk));
			return true;
		});
		render('t', [check('a', 1, 'files', ['line one\nline two'])]);
		write.mockRestore();
		const output = chunks.join('');
		expect(output).toContain('line one');
		expect(output).toContain('line two');
		expect(output).toContain('1 failed');
	});

	test('an all-clear run says so and counts what it examined', () => {
		const chunks: string[] = [];
		const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			chunks.push(String(chunk));
			return true;
		});
		render('t', [check('a', 7, 'files', [])]);
		write.mockRestore();
		expect(chunks.join('')).toContain('all clear');
		expect(chunks.join('')).toContain('7 things examined');
	});
});

describe('the dependency gate, run against this repository', () => {
	const rows = runImportGate() as CheckResult[];

	test('reports on every check it has', () => {
		expect(rows.length).toBe(5);
	});

	test('all of them pass', () => {
		const failures = rows.filter((row) => row.state !== 'PASS');
		expect(failures.map((row) => `${row.name}: ${(row.problems ?? []).join('; ')}`)).toEqual([]);
	});

	test('the runtime half imports react and nothing else', () => {
		// This read "no package imports at all" until the renderer landed, which was true
		// and is no longer the property worth asserting. React is a peer dependency every
		// consumer already has for its own reasons, and it is the only entry on the gate's
		// allowlist; the bar for a second is that every current and future consumer already
		// depends on it. Naming the set here means a widened allowlist fails a test rather
		// than passing a gate.
		const row = rows.find((r) => r.name === 'src/ imports no packages');
		expect(row?.note).toBe('packages used: react');
		// The count is the point: a gate that walked an empty tree would pass silently
		// without it.
		expect(row?.examined ?? 0).toBeGreaterThan(20);
	});
});

describe('the house lint, run against this repository', () => {
	const rows = runHouseLint() as CheckResult[];

	test('finds no banned character in anything this package emits', () => {
		const row = rows.find((r) => r.name === 'banned characters');
		expect(row?.problems ?? []).toEqual([]);
		expect(row?.examined ?? 0).toBeGreaterThan(20);
	});

	test('finds no AI attribution in source', () => {
		expect(rows.find((r) => r.name === 'no AI attribution in source')?.problems ?? []).toEqual([]);
	});

	test('loads the rule pack rather than restating it', () => {
		const row = rows.find((r) => r.name === 'house rule pack');
		expect(row?.note).toContain('house-rules.json');
		expect(row?.examined ?? 0).toBeGreaterThan(5);
	});

	test('never reports the git history check as a pass when it could not run', () => {
		const row = rows.find((r) => r.name === 'no AI attribution in git history');
		expect(row).toBeDefined();
		if (row?.state === 'NOT RUN') expect(row.note?.length ?? 0).toBeGreaterThan(10);
	});
});

describe('the failure paths, exercised against a deliberately broken fixture', () => {
	const root = mkdtempSync(join(tmpdir(), 'hexdocs-guard-'));

	beforeAll(() => {
		mkdirSync(join(root, 'src', 'nested'), { recursive: true });
		mkdirSync(join(root, 'kit', 'schema'), { recursive: true });

		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({
				name: '@hex-pro/docs',
				dependencies: { lodash: '^4' },
				optionalDependencies: { chalk: '^5' },
				peerDependencies: { react: '^19', 'framer-motion': '^11' },
			}),
		);

		writeFileSync(
			join(root, 'src', 'bad.ts'),
			[
				"import { readFileSync } from 'node:fs';",
				"import lodash from 'lodash';",
				"import { thing } from './nested/thing';",
				"import { kitThing } from '../kit/src/thing.js';",
				"import absolute from '/etc/passwd';",
				'export { readFileSync, lodash, thing, kitThing, absolute };',
			].join('\n'),
		);
		writeFileSync(join(root, 'src', 'nested', 'thing.ts'), 'export const thing = 1;\n');

		copyFileSync(
			new URL('../kit/schema/house-rules.json', import.meta.url),
			join(root, 'kit', 'schema', 'house-rules.json'),
		);
		writeFileSync(
			join(root, 'CLAUDE.md'),
			// Assembled from escapes so this test file stays clean under the very rule
			// the fixture is meant to trip.
			`A line with an em dash \u2014 in it.\nCo-Authored-By: C${'l'}aude <x@y.z>\n`,
		);
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('the dependency gate reports the manifest, the package, the builtin, the extension and the escape', () => {
		const rows = runImportGate(root) as CheckResult[];
		const problems = rows.flatMap((row) => row.problems ?? []);

		expect(rows.filter((row) => row.state === 'FAIL').length).toBe(5);
		expect(
			problems.some((p) => p.includes('"dependencies" must be empty') && p.includes('lodash')),
		).toBe(true);
		expect(problems.some((p) => p.includes('"optionalDependencies" must be empty'))).toBe(true);
		expect(problems.some((p) => p.includes('framer-motion') && p.includes('allowlist'))).toBe(true);
		expect(problems.some((p) => p.includes('imports "lodash"'))).toBe(true);
		expect(problems.some((p) => p.includes('node:fs') && p.includes('browser'))).toBe(true);
		expect(
			problems.some((p) => p.includes('./nested/thing') && p.includes('".js" extension')),
		).toBe(true);
		expect(problems.some((p) => p.includes('outside src/'))).toBe(true);
		expect(problems.some((p) => p.includes('absolute path'))).toBe(true);
	});

	test('every failure names the file and the line, so it is actionable without a search', () => {
		const problems = (runImportGate(root) as CheckResult[])
			.flatMap((row) => row.problems ?? [])
			.filter((p) => p.startsWith('src/'));
		expect(problems.length).toBeGreaterThan(3);
		for (const problem of problems) expect(problem).toMatch(/^src\/bad\.ts:\d+ /);
	});

	test('the house lint catches a banned character and an attribution trailer', () => {
		const rows = runHouseLint(root) as CheckResult[];
		const problems = rows.flatMap((row) => row.problems ?? []);
		expect(problems.some((p) => p.includes('em dash') && p.includes('U+2014'))).toBe(true);
		expect(problems.some((p) => p.includes('co-author trailer'))).toBe(true);
	});

	test('a missing rule pack is NOT RUN rather than a pass, and fails the run', () => {
		rmSync(join(root, 'kit', 'schema', 'house-rules.json'));
		const rows = runHouseLint(root) as CheckResult[];
		expect(rows.every((row) => row.state === 'NOT RUN')).toBe(true);
		expect(rows[0]?.note).toContain('pnpm --dir kit schemas');
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const summary = render('t', rows as never);
		write.mockRestore();
		expect(summary.ok).toBe(false);
		copyFileSync(
			new URL('../kit/schema/house-rules.json', import.meta.url),
			join(root, 'kit', 'schema', 'house-rules.json'),
		);
	});
});

describe('the verification ladder', () => {
	test('every step spawns a script that actually exists in package.json', () => {
		// A renamed script would otherwise make `pnpm verify` spawn a command that does
		// not exist, and the row would read NOT RUN forever rather than failing.
		const manifest = JSON.parse(
			readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
		) as { scripts: Record<string, string> };

		expect(STEPS.length).toBeGreaterThan(4);
		for (const step of STEPS as { name: string; argv: string[]; unit: string }[]) {
			expect(step.argv[0]).toBe('pnpm');
			expect(Object.keys(manifest.scripts)).toContain(step.argv[1]);
			expect(step.unit.length).toBeGreaterThan(2);
		}
	});

	test('the ladder covers typecheck, both suites, the surface, the guards, paint, terraform and formatting', () => {
		const names = (STEPS as { name: string }[]).map((step) => step.name);
		expect(names).toEqual([
			'typecheck',
			'runtime tests',
			'toolchain tests',
			'cli surface',
			'dependency gate',
			'house lint',
			'paint',
			'terraform',
			'formatting',
		]);
	});

	test('only paint may report zero, and terraform is deliberately not beside it', () => {
		// Every other row that examined nothing has stopped examining something, which is the
		// rule this ladder exists to hold. `paint` is the one exception, and it is a real one:
		// `check-paint.mjs` produces a single row, that row is `skipped(...)` with no browser
		// installed, so the guard genuinely exits 0 having examined zero probes. In CI the
		// same state is a failure, because the runner image ships Chrome.
		//
		// `terraform` carried the flag too and could not use it. Measured with
		// `HEXDOCS_TERRAFORM=/nonexistent/terraform`: `check-infra.mjs` still reports a full
		// invariants row, which is pure JavaScript and always runs, plus three SKIPPED rows,
		// and it exits 0 having examined a great deal. The only state that reaches zero is a
		// checkout with nothing under `infra/` to parse, and the guard answers that with a
		// FAIL, so this row is built from the exit code before any exemption is read. It was
		// a disarm sitting ready for the day somebody softens that arm, which is the one
		// thing this ladder exists to refuse. Pinned in both directions, so a second row
		// granted the exemption has to say so in a diff to this test.
		const permissive = (STEPS as { name: string; allowZero?: boolean }[]).filter(
			(step) => step.allowZero === true,
		);
		expect(permissive.map((step) => step.name)).toEqual(['paint']);
	});

	test('the count extractors read real command output', () => {
		expect(countTests('  Test Files  11 passed (11)\n       Tests  226 passed (226)\n')).toBe(226);
		expect(countExamined('  all clear (5/5 checks ran, 119 things examined)\n')).toBe(119);
	});

	test('a count extractor that matches nothing returns zero, which the ladder treats as a failure', () => {
		// The rule holds all the way up: a step reporting zero has not passed.
		expect(countTests('no summary here')).toBe(0);
		expect(check('x', countTests('no summary here'), 'tests', []).state).toBe('FAIL');
	});
});

describe('the ladder runner', () => {
	const passing = {
		name: 'passing',
		argv: ['node', '-e', 'process.stdout.write("Tests  3 passed (3)")'],
		unit: 'tests',
		count: countTests,
	};
	const failing = {
		name: 'failing',
		argv: ['node', '-e', 'process.stdout.write("Tests  1 passed (1)"); process.exit(2)'],
		unit: 'tests',
		count: countTests,
	};
	const missing = {
		name: 'missing',
		argv: ['hexdocs-no-such-binary', '--version'],
		unit: 'things',
		count: () => 0,
	};

	test('a passing step reports its count', () => {
		const [row] = runLadder([passing]) as CheckResult[];
		expect(row?.state).toBe('PASS');
		expect(row?.examined).toBe(3);
	});

	test('a failing step reports the exit code and the tail of its output', () => {
		const [row] = runLadder([failing]) as CheckResult[];
		expect(row?.state).toBe('FAIL');
		expect(row?.problems?.[0]).toContain('exited 2');
		expect(row?.problems?.some((line) => line.includes('Tests  1 passed'))).toBe(true);
	});

	test('everything after a failure is NOT RUN, so the summary cannot read as a clean sweep', () => {
		const rows = runLadder([failing, passing, passing]) as CheckResult[];
		expect(rows.map((row) => row.state)).toEqual(['FAIL', 'NOT RUN', 'NOT RUN']);
		expect(rows[1]?.note).toBe('An earlier step failed.');
	});

	test('a command that cannot be spawned at all is NOT RUN, never a pass', () => {
		const [row] = runLadder([missing]) as CheckResult[];
		expect(row?.state).toBe('NOT RUN');
		expect(row?.note).toContain('hexdocs-no-such-binary');
	});

	test('a step whose note is set carries it through', () => {
		const [row] = runLadder([{ ...passing, note: 'why this step exists' }]) as CheckResult[];
		expect(row?.note).toBe('why this step exists');
	});

	test('a step that examined fewer things than the disk holds is a failure, not a smaller number', () => {
		// The second pair of numbers, driven. A suite the runner never collected lowers the
		// headline count and nothing else, so the shortfall has to be measured against
		// something the command's own output cannot influence.
		const [row] = runLadder([
			{
				...passing,
				subset: () => ({ ran: 2, expected: 5, what: '5 test files under test/' }),
			},
		]) as CheckResult[];
		expect(row?.state).toBe('FAIL');
		expect(row?.problems?.[0]).toContain('collected 2 of 5');
		expect(row?.problems?.[0]).toContain('5 test files under test/');
	});

	test('a step whose two numbers agree passes and says what it compared against', () => {
		const [row] = runLadder([
			{ ...passing, subset: () => ({ ran: 5, expected: 5, what: '5 test files under test/' }) },
		]) as CheckResult[];
		expect(row?.state).toBe('PASS');
		expect(row?.note).toBe('5 test files under test/');
	});

	test('only a step that declares it may report zero and still pass', () => {
		const zero = {
			name: 'zero',
			argv: ['node', '-e', "process.stdout.write('nothing examined')"],
			unit: 'probes',
			count: () => 0,
		};
		expect((runLadder([zero]) as CheckResult[])[0]?.state).toBe('FAIL');
		expect((runLadder([{ ...zero, allowZero: true }]) as CheckResult[])[0]?.state).toBe('PASS');
	});
});

describe('the ladder is still the program through a symlink', () => {
	test('invoked by a symlinked absolute path it prints its report rather than nothing', () => {
		// The trap, measured: `import.meta.url === pathToFileURL(argv[1]).href` is false
		// through any symlink, because node resolves `import.meta.url` through realpath and
		// argv keeps the path the shell was given. The file then prints nothing and exits 0.
		// On this machine that is not hypothetical geometry: `/tmp` is itself a symlink to
		// `private/tmp` and `/var` to `private/var`, so the temporary directory below is
		// symlinked before the deliberate link is added.
		//
		// Fired rather than grepped for. A scan asserting that no file under `scripts/`
		// contains the text comparison is satisfied by a literal in a branch nothing reaches,
		// which is the shape this repository refuses everywhere else.
		//
		// `pnpm` is kept off PATH on purpose, so the ladder's first step cannot be spawned,
		// every row becomes NOT RUN and the whole thing finishes in milliseconds. What is
		// under test is whether the file runs at all, not what it concludes.
		const box = mkdtempSync(join(tmpdir(), 'hexdocs-symlink-'));
		const link = join(box, 'repo');
		symlinkSync(fileURLToPath(new URL('..', import.meta.url)), link, 'dir');
		const bin = join(box, 'bin');
		mkdirSync(bin);
		symlinkSync(process.execPath, join(bin, 'node'));

		const spawned = spawnSync(process.execPath, [join(link, 'scripts', 'verify.mjs')], {
			encoding: 'utf8',
			env: { ...process.env, PATH: bin, NO_COLOR: '1', FORCE_COLOR: '0' },
		});

		expect(spawned.stdout).toContain('hex-docs verification');
		expect(spawned.stdout).toContain('did not run');
		expect(spawned.status).toBe(1);
		rmSync(box, { recursive: true, force: true });
	});
});

describe('the git history check', () => {
	const root = mkdtempSync(join(tmpdir(), 'hexdocs-git-'));

	const git = (...args: string[]) =>
		spawnSync('git', args, {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
		});

	beforeAll(() => {
		mkdirSync(join(root, 'kit', 'schema'), { recursive: true });
		copyFileSync(
			new URL('../kit/schema/house-rules.json', import.meta.url),
			join(root, 'kit', 'schema', 'house-rules.json'),
		);
		writeFileSync(join(root, 'README.md'), 'A clean file.\n');

		git('init', '-q', '-b', 'main');
		git('config', 'user.email', 'test@example.invalid');
		git('config', 'user.name', 'Test');
		git('add', '-A');
		git('commit', '-q', '-m', 'Add the docs contracts');
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('no commits is SKIPPED, not NOT RUN: it is explained and nobody can act on it', () => {
		const empty = mkdtempSync(join(tmpdir(), 'hexdocs-nogit-'));
		mkdirSync(join(empty, 'kit', 'schema'), { recursive: true });
		copyFileSync(
			new URL('../kit/schema/house-rules.json', import.meta.url),
			join(empty, 'kit', 'schema', 'house-rules.json'),
		);
		writeFileSync(join(empty, 'README.md'), 'Clean.\n');
		const rows = runHouseLint(empty) as CheckResult[];
		expect(rows.find((r) => r.name === 'no AI attribution in git history')?.state).toBe('SKIPPED');
		// Both rows, in every state. Two checks come out of this section now, and an early
		// return that pushed only one would quietly lower the "n/n checks ran" footer the
		// four-state report is built on.
		expect(rows.find((r) => r.name === 'no estate identifiers in git history')?.state).toBe(
			'SKIPPED',
		);
		rmSync(empty, { recursive: true, force: true });
	});

	test('a clean history passes, having examined a real commit count', () => {
		const row = (runHouseLint(root) as CheckResult[]).find(
			(r) => r.name === 'no AI attribution in git history',
		);
		expect(row?.state).toBe('PASS');
		expect(row?.examined).toBe(1);
	});

	test('a co-author trailer in a commit message is caught and the sha is named', () => {
		writeFileSync(join(root, 'README.md'), 'A second change.\n');
		git('add', '-A');
		// Assembled so this test file stays clean under the rule it is testing.
		git(
			'commit',
			'-q',
			'-m',
			`Tidy the README\n\nCo-Authored-By: C${'l'}aude <noreply@anthropic.com>`,
		);

		const row = (runHouseLint(root) as CheckResult[]).find(
			(r) => r.name === 'no AI attribution in git history',
		);
		expect(row?.state).toBe('FAIL');
		expect(row?.examined).toBe(2);
		expect(row?.problems?.[0]).toMatch(/^[0-9a-f]{8} contains a co-author trailer\.$/);
	});

	test('an account id in a commit message is caught, and the value is never printed', () => {
		// The gap this closes was measured, not imagined. The history loop iterated
		// `ATTRIBUTION_PATTERNS` and nothing else, so `git commit -m "Apply the bundle store
		// to account <id>"`, which is the natural message for the commit that lands the
		// stack, left the run at exit 0 with every row green. In a public repository a commit
		// message is as visible as a file and far harder to retract, and two of the patterns
		// it skipped are access key ids rather than account ids.
		//
		// Assembled from parts, so this test file stays clean under the rule it drives.
		const planted = ['0123', '4567', '8901'].join('');
		writeFileSync(join(root, 'README.md'), 'A third change.\n');
		git('add', '-A');
		git('commit', '-q', '-m', `Apply the bundle store to account ${planted} in ap-southeast-2`);

		const rows = runHouseLint(root) as CheckResult[];
		const row = rows.find((r) => r.name === 'no estate identifiers in git history');
		expect(row?.state).toBe('FAIL');
		expect(row?.examined).toBe(3);
		expect(row?.problems?.[0]).toMatch(/^[0-9a-f]{8} contains a twelve digit run/);
		// Reported by shape and short sha only. A guard that quotes the value has copied it
		// into a CI log, which is one of the places it was not supposed to reach.
		expect(row?.problems?.[0]).not.toContain(planted);
		// Under its own name, not the attribution row's. An account id reported as an AI
		// attribution is a mislabelled report, which is worse than no report.
		const attribution = rows.find((r) => r.name === 'no AI attribution in git history');
		expect(attribution?.problems?.join(' ')).not.toContain('twelve digit run');
	});
});

describe('the typecheck step measures rather than asserts', () => {
	const manifest = JSON.parse(
		readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
	) as {
		scripts: Record<string, string>;
	};

	/** Every tsconfig a `tsc` invocation in a script names, implicit one included. */
	const configsIn = (script: string) =>
		script
			.split('&&')
			.map((part) => part.trim())
			.filter((part) => part.startsWith('tsc '))
			.map((part) => /-p\s+(\S+)/.exec(part)?.[1] ?? 'tsconfig.json')
			.sort();

	/** Every tsconfig actually on disk, which is what the script has to cover. */
	const onDisk = [
		...readdirSync(new URL('..', import.meta.url)).filter((name) =>
			/^tsconfig(\..+)?\.json$/.test(name),
		),
		...readdirSync(new URL('../kit', import.meta.url))
			.filter((name) => /^tsconfig(\..+)?\.json$/.test(name))
			.map((name) => `kit/${name}`),
	].sort();

	test('the typecheck script covers every tsconfig in the repository', () => {
		// kit/tsconfig.json is the only thing that compiles kit/src/contracts/drift.ts,
		// which has no runtime statements and is imported by no test, so dropping it
		// silently switches off every Zod-against-TypeScript assertion in the package.
		//
		// Compared against the disk rather than a literal list, so a fourth tsconfig
		// added and not typechecked fails here as well.
		expect(onDisk).toContain('kit/tsconfig.json');
		expect(configsIn(manifest.scripts['typecheck'] ?? '')).toEqual(onDisk);
	});

	test('the ladder expects the same set the script covers, so a dropped one fails the row', () => {
		// Measuring the count was not enough: with kit/tsconfig.json dropped, the row
		// reported two configurations and still passed.
		const step = (STEPS as { name: string; expect?: () => { expected: number } }[]).find(
			(s) => s.name === 'typecheck',
		);
		expect(step?.expect?.().expected).toBe(onDisk.length);
	});

	test('the verbose variant runs the same configurations, so the ladder measures the real thing', () => {
		expect(configsIn(manifest.scripts['typecheck:verbose'] ?? '')).toEqual(
			configsIn(manifest.scripts['typecheck'] ?? ''),
		);
	});

	test('the verbose variant asks every invocation for diagnostics, which is where the count comes from', () => {
		const parts = (manifest.scripts['typecheck:verbose'] ?? '')
			.split('&&')
			.map((part) => part.trim())
			.filter((part) => part.startsWith('tsc '));
		expect(parts.length).toBe(onDisk.length);
		for (const part of parts) expect(part).toContain('--extendedDiagnostics');
	});

	test('the ladder counts one configuration per Files: line, not a literal', () => {
		const step = (STEPS as { name: string; count: (output: string) => number }[]).find(
			(s) => s.name === 'typecheck',
		);
		expect(step?.count('Files: 79\nTypes: 3239\nFiles: 91\nFiles: 40\n')).toBe(3);
		expect(step?.count('Files: 79\n')).toBe(1);
		// A step that measured nothing reports zero, which the ladder turns into a
		// failure rather than a pass.
		expect(step?.count('no diagnostics here')).toBe(0);
	});
});

describe('the per-root file count', () => {
	test('names every root separately, so one going missing is visible', () => {
		const row = (runHouseLint() as CheckResult[]).find(
			(r) => r.name === 'every root contributes files',
		);
		expect(row?.state).toBe('PASS');
		// A single total across six roots hides the case this exists for: one root
		// renamed, the count still large, the summary still green.
		for (const dir of ['src', 'kit', 'scripts', 'test']) expect(row?.note).toContain(dir);
	});

	test('names every root the repository actually has, not just the four it listed', () => {
		// The earlier version of the test above accepted any note mentioning src, kit,
		// scripts and test, so REQUIRED_DIRS could shrink to exactly those for free and
		// .github would stop being linted with every row still green.
		const row = (runHouseLint() as CheckResult[]).find(
			(r) => r.name === 'every root contributes files',
		);
		for (const dir of ['src', 'kit', 'scripts', 'test', '.github', '(root files)']) {
			expect(row?.note).toContain(dir);
		}
	});

	test('a directory on disk that is in no list fails, because nothing lints it', () => {
		const root = mkdtempSync(join(tmpdir(), 'hexdocs-unknown-'));
		// Derived from the guard's own list rather than repeated here. A root added to
		// REQUIRED_DIRS used to break this test, which is a test failing for the one
		// reason it is not about.
		for (const dir of REQUIRED_DIRS as string[]) {
			mkdirSync(join(root, dir), { recursive: true });
			writeFileSync(join(root, dir, 'a.ts'), 'export const a = 1;\n');
		}
		mkdirSync(join(root, 'kit', 'schema'), { recursive: true });
		copyFileSync(
			new URL('../kit/schema/house-rules.json', import.meta.url),
			join(root, 'kit', 'schema', 'house-rules.json'),
		);
		// A root nobody added to a list. This is the same failure as a root deleted from
		// REQUIRED_DIRS, seen from the other side: a directory the walk would descend
		// into and no list claims.
		mkdirSync(join(root, 'packages'), { recursive: true });
		writeFileSync(join(root, 'packages', 'b.ts'), 'export const b = 2;\n');
		const row = (runHouseLint(root) as CheckResult[]).find(
			(r) => r.name === 'every root contributes files',
		);
		expect(row?.state).toBe('FAIL');
		expect(row?.problems?.some((p) => p.startsWith('packages/'))).toBe(true);
		expect(row?.problems?.some((p) => p.includes('nothing lints it'))).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	test('an excluded directory is not reported, so the two lists cannot disagree', () => {
		const root = mkdtempSync(join(tmpdir(), 'hexdocs-excluded-'));
		// Derived from the guard's own list rather than repeated here. A root added to
		// REQUIRED_DIRS used to break this test, which is a test failing for the one
		// reason it is not about.
		for (const dir of REQUIRED_DIRS as string[]) {
			mkdirSync(join(root, dir), { recursive: true });
			writeFileSync(join(root, dir, 'a.ts'), 'export const a = 1;\n');
		}
		mkdirSync(join(root, 'kit', 'schema'), { recursive: true });
		copyFileSync(
			new URL('../kit/schema/house-rules.json', import.meta.url),
			join(root, 'kit', 'schema', 'house-rules.json'),
		);
		mkdirSync(join(root, 'node_modules'), { recursive: true });
		mkdirSync(join(root, 'coverage'), { recursive: true });
		const row = (runHouseLint(root) as CheckResult[]).find(
			(r) => r.name === 'every root contributes files',
		);
		expect(row?.state).toBe('PASS');
		rmSync(root, { recursive: true, force: true });
	});

	test('a root file no list names is scanned, because the list comes off the disk', () => {
		// `SCANNED_FILES` used to be the whole statement of what gets read at the top level
		// and it named three files out of eight. Measured: an account id appended to
		// `vitest.config.ts`, thirteen kilobytes of prose comment that already discusses
		// calls against a real AWS account, left the run at exit 0 with every row green. Same
		// for `tsconfig.json`, `tsconfig.test.json`, `pnpm-lock.yaml` and `.prettierrc.json`.
		const root = mkdtempSync(join(tmpdir(), 'hexdocs-rootfile-'));
		for (const dir of REQUIRED_DIRS as string[]) {
			mkdirSync(join(root, dir), { recursive: true });
			writeFileSync(join(root, dir, 'a.ts'), 'export const a = 1;\n');
		}
		mkdirSync(join(root, 'kit', 'schema'), { recursive: true });
		copyFileSync(
			new URL('../kit/schema/house-rules.json', import.meta.url),
			join(root, 'kit', 'schema', 'house-rules.json'),
		);
		// Assembled from parts, so this test file stays clean under the rule it drives.
		const planted = ['0123', '4567', '8901'].join('');
		writeFileSync(join(root, 'vitest.config.ts'), `// measured against account ${planted}\n`);
		const row = (runHouseLint(root) as CheckResult[]).find(
			(r) => r.name === 'no estate identifiers in source',
		);
		expect(row?.state).toBe('FAIL');
		expect(row?.problems?.[0]).toContain('vitest.config.ts:1');
		expect(row?.problems?.[0]).not.toContain(planted);
		rmSync(root, { recursive: true, force: true });
	});

	test('a required root that contributes nothing fails, naming it', () => {
		const root = mkdtempSync(join(tmpdir(), 'hexdocs-roots-'));
		mkdirSync(join(root, 'kit', 'schema'), { recursive: true });
		copyFileSync(
			new URL('../kit/schema/house-rules.json', import.meta.url),
			join(root, 'kit', 'schema', 'house-rules.json'),
		);
		const row = (runHouseLint(root) as CheckResult[]).find(
			(r) => r.name === 'every root contributes files',
		);
		expect(row?.state).toBe('FAIL');
		expect(row?.problems?.some((p) => p.startsWith('src/'))).toBe(true);
		expect(row?.problems?.some((p) => p.includes('no longer linted'))).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});
});

describe('the en dash exemption', () => {
	const root = mkdtempSync(join(tmpdir(), 'hexdocs-endash-'));

	beforeAll(() => {
		mkdirSync(join(root, 'src'), { recursive: true });
		mkdirSync(join(root, 'kit', 'schema'), { recursive: true });
		mkdirSync(join(root, 'scripts'), { recursive: true });
		mkdirSync(join(root, 'test'), { recursive: true });
		mkdirSync(join(root, '.github'), { recursive: true });
		copyFileSync(
			new URL('../kit/schema/house-rules.json', import.meta.url),
			join(root, 'kit', 'schema', 'house-rules.json'),
		);
		for (const dir of ['scripts', 'test', '.github']) {
			writeFileSync(join(root, dir, 'placeholder.md'), 'Clean.\n');
		}
		// A numeric range and two prose en dashes on one line. Scanning only the first
		// occurrence exempted the whole line and shipped both.
		writeFileSync(
			join(root, 'src', 'ranges.ts'),
			`export const years = '2019\u20132024'; // the API \u2013 as documented \u2013 changed\n`,
		);
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('a numeric range on the same line no longer hides the prose dashes after it', () => {
		const row = (runHouseLint(root) as CheckResult[]).find((r) => r.name === 'banned characters');
		expect(row?.problems?.length).toBe(2);
		for (const problem of row?.problems ?? []) expect(problem).toContain('en dash');
	});

	test('a numeric range on its own is still allowed', () => {
		writeFileSync(join(root, 'src', 'ranges.ts'), `export const years = '2019\u20132024';\n`);
		const row = (runHouseLint(root) as CheckResult[]).find((r) => r.name === 'banned characters');
		expect(row?.problems ?? []).toEqual([]);
	});
});

describe('a shallow clone', () => {
	test('is NOT RUN, not a pass: a depth-1 CI checkout would examine one commit', () => {
		const root = mkdtempSync(join(tmpdir(), 'hexdocs-shallow-'));
		const origin = mkdtempSync(join(tmpdir(), 'hexdocs-origin-'));
		const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

		spawnSync('git', ['init', '-q', '-b', 'main', origin], { encoding: 'utf8', env });
		writeFileSync(join(origin, 'README.md'), 'One.\n');
		for (const args of [
			['config', 'user.email', 'test@example.invalid'],
			['config', 'user.name', 'Test'],
			['add', '-A'],
			['commit', '-q', '-m', 'first'],
		]) {
			spawnSync('git', args, { cwd: origin, encoding: 'utf8', env });
		}
		writeFileSync(join(origin, 'README.md'), 'Two.\n');
		spawnSync('git', ['commit', '-q', '-am', 'second'], { cwd: origin, encoding: 'utf8', env });

		rmSync(root, { recursive: true, force: true });
		spawnSync('git', ['clone', '-q', '--depth', '1', `file://${origin}`, root], {
			encoding: 'utf8',
			env,
		});
		mkdirSync(join(root, 'kit', 'schema'), { recursive: true });
		copyFileSync(
			new URL('../kit/schema/house-rules.json', import.meta.url),
			join(root, 'kit', 'schema', 'house-rules.json'),
		);

		const rows = runHouseLint(root) as CheckResult[];
		const row = rows.find((r) => r.name === 'no AI attribution in git history');
		expect(row?.state).toBe('NOT RUN');
		expect(row?.note).toContain('fetch-depth: 0');
		// The same early return has to push both history rows, or a shallow checkout drops
		// one and the footer's count shrinks with nothing saying so.
		const identifiers = rows.find((r) => r.name === 'no estate identifiers in git history');
		expect(identifiers?.state).toBe('NOT RUN');
		expect(identifiers?.note).toContain('fetch-depth: 0');

		rmSync(root, { recursive: true, force: true });
		rmSync(origin, { recursive: true, force: true });
	});
});

describe('the planted-character declaration, exercised in both directions', () => {
	const root = mkdtempSync(join(tmpdir(), 'hexdocs-planted-'));
	const page = join(root, 'fixtures', 'page.md');
	const declaration = join(root, 'fixtures', 'planted.json');

	/** A reason long enough to satisfy the guard's own minimum. */
	const REASON =
		'The corpus carries this on purpose, because the rule that catches it has to have something to catch.';

	const declare = (groups: unknown[]): void => {
		writeFileSync(declaration, JSON.stringify({ why: REASON, scope: REASON, groups }));
	};

	const lint = (): CheckResult[] => runHouseLint(root) as CheckResult[];
	const row = (name: string): CheckResult | undefined => lint().find((r) => r.name === name);
	const problems = (): string[] => lint().flatMap((r) => r.problems ?? []);

	beforeAll(() => {
		mkdirSync(join(root, 'kit', 'schema'), { recursive: true });
		for (const dir of REQUIRED_DIRS as string[]) {
			mkdirSync(join(root, dir), { recursive: true });
			writeFileSync(join(root, dir, 'placeholder.md'), 'Nothing to see.\n');
		}
		copyFileSync(
			new URL('../kit/schema/house-rules.json', import.meta.url),
			join(root, 'kit', 'schema', 'house-rules.json'),
		);
		// Assembled from escapes, so this test file stays clean under the rule the
		// fixture it builds is meant to carry an exception to.
		writeFileSync(page, 'A status glyph \u2705 and an em dash \u2014 in one line.\n');
		declare([
			{
				id: 'status',
				kind: 'data',
				rule: 'status',
				codePoints: ['U+2705', 'U+2014'],
				files: ['fixtures/page.md'],
				why: REASON,
			},
		]);
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('a declared character is allowed, and the row counts what it allowed', () => {
		const characters = row('banned characters');
		expect(characters?.state).toBe('PASS');
		const planted = row('planted fixture characters');
		expect(planted?.state).toBe('PASS');
		expect(planted?.examined).toBe(2);
	});

	test('without the declaration the same characters are reported', () => {
		// The mutation that matters: this is what the mechanism is buying, so it has to be
		// shown to be doing something rather than assumed to be.
		declare([]);
		const found = problems();
		expect(found.some((p) => p.includes('white heavy check mark'))).toBe(true);
		expect(found.some((p) => p.includes('em dash'))).toBe(true);
	});

	test('a declaration whose character has gone fails, naming the code point', () => {
		// The direction that matters more. A planted character quietly deleted leaves the
		// rule it was the only coverage for untested, with every other row still green.
		writeFileSync(page, 'A line with nothing special in it.\n');
		declare([
			{
				id: 'status',
				kind: 'data',
				rule: 'status',
				codePoints: ['U+2705'],
				files: ['fixtures/page.md'],
				why: REASON,
			},
		]);
		const planted = row('planted fixture characters');
		expect(planted?.state).toBe('FAIL');
		expect(planted?.problems?.[0]).toContain('U+2705');
		expect(planted?.problems?.[0]).toContain('does not contain it');
	});

	test('a declaration cannot reach outside the corpus', () => {
		// Without this the mechanism becomes a way to exempt real source, which is the
		// hole the whole no-exemptions rule exists to close.
		declare([
			{
				id: 'escape',
				kind: 'data',
				rule: 'status',
				codePoints: ['U+2705'],
				files: ['src/contracts/lint.ts'],
				why: REASON,
			},
		]);
		const planted = row('planted fixture characters');
		expect(planted?.state).toBe('FAIL');
		expect(planted?.problems?.[0]).toContain('outside fixtures/');
	});

	test('a declaration naming a file that is gone fails rather than exempting nothing quietly', () => {
		declare([
			{
				id: 'stale',
				kind: 'data',
				rule: 'status',
				codePoints: ['U+2705'],
				files: ['fixtures/moved.md'],
				why: REASON,
			},
		]);
		expect(row('planted fixture characters')?.problems?.[0]).toContain('does not exist');
	});

	test('a declaration with no real reason is an exemption nobody decided on', () => {
		declare([
			{
				id: 'terse',
				kind: 'data',
				rule: 'status',
				codePoints: ['U+2705'],
				files: ['fixtures/page.md'],
				why: 'because',
			},
		]);
		expect(row('planted fixture characters')?.problems?.[0]).toContain('no real reason');
	});

	test('a code point written as the character itself is refused', () => {
		// The declaration must never contain the character it declares, or the file that
		// grants the exemption is the next thing to trip the rule.
		declare([
			{
				id: 'literal',
				kind: 'data',
				rule: 'status',
				codePoints: ['\u2705'],
				files: ['fixtures/page.md'],
				why: REASON,
			},
		]);
		expect(row('planted fixture characters')?.problems?.[0]).toContain('is not a code point');
	});

	test('a malformed declaration is NOT RUN with the parse error, and the rest still reports', () => {
		// Three shapes used to throw straight out of `run`: truncated JSON, no `groups`
		// key, and `files` given as a string. The first two killed the process with a
		// stack trace and lost every other row of the report, including the two
		// attribution checks. The third iterated the string's characters and reported one
		// nonsense problem per letter.
		writeFileSync(declaration, '{"groups": [');
		const truncated = lint();
		const truncatedRow = truncated.find((r) => r.name === 'planted fixture characters');
		expect(truncatedRow?.state).toBe('NOT RUN');
		expect(truncatedRow?.note).toContain('could not be read');
		// The rows after it still ran, which is the half that was being lost.
		expect(truncated.some((r) => r.name === 'no AI attribution in source')).toBe(true);

		writeFileSync(declaration, JSON.stringify({ why: REASON, scope: REASON }));
		expect(row('planted fixture characters')?.note).toContain('no "groups" array');

		declare([
			{
				id: 'shape',
				kind: 'data',
				rule: 'status',
				codePoints: 'U+2705',
				files: 'fixtures/page.md',
				why: REASON,
			},
		]);
		const shaped = row('planted fixture characters');
		expect(shaped?.state).toBe('FAIL');
		expect(shaped?.problems?.[0]).toContain('as arrays');
		expect(shaped?.problems).toHaveLength(1);
	});

	test('a missing declaration file is NOT RUN, which fails the run', () => {
		rmSync(declaration);
		writeFileSync(page, 'A status glyph \u2705 on its own.\n');
		const rows = lint();
		const planted = rows.find((r) => r.name === 'planted fixture characters');
		expect(planted?.state).toBe('NOT RUN');
		expect(planted?.note).toContain('planted.json');
		expect(rows.find((r) => r.name === 'banned characters')?.state).toBe('FAIL');
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const summary = render('t', rows as never);
		write.mockRestore();
		expect(summary.ok).toBe(false);
	});
});

describe('the ladder counts test files as well as tests', () => {
	/**
	 * The hole this closes, and it was reachable here.
	 *
	 * A test row's headline count is the number of tests, and that number cannot report a
	 * gap: a suite the runner never collected simply makes it smaller, and smaller is not
	 * failing. `vitest.config.ts` matched `test/**\/*.test.ts` and not `.tsx`, so an entire
	 * component suite would have collected nothing while the ladder printed PASS.
	 */
	test('every test row compares what ran against what is on disk', () => {
		const rows = STEPS.filter((step) => step.unit === 'tests');
		expect(rows.length).toBe(2);
		for (const step of rows) expect(step.subset).toBeDefined();
	});

	test('the file count comes out of vitest own summary', () => {
		expect(countTestFiles(' Test Files  18 passed (18)\n Tests  400 passed (400)')).toBe(18);
		expect(countTestFiles('no summary here')).toBe(0);
		// The two numbers are different things and a reader of the row has to be able to
		// tell them apart.
		expect(countTests(' Test Files  18 passed (18)\n Tests  400 passed (400)')).toBe(400);
	});

	test('the expectation counts the .ts and .tsx files this repository really has', () => {
		const runtime = STEPS.find((step) => step.name === 'runtime tests');
		const measured = runtime?.subset?.(' Test Files  1 passed (1)');
		expect(measured).toBeDefined();
		expect(measured?.ran).toBe(1);
		// Derived from the disk rather than from a literal, and both extensions are really
		// present: a walker that matched only `.ts` would give a smaller number here and
		// the row would then agree with a runner that collected the same subset.
		expect(measured?.expected).toBeGreaterThan(15);
		expect(measured?.what).toContain('test files under test/');

		const kit = STEPS.find((step) => step.name === 'toolchain tests');
		expect(kit?.subset?.('')?.expected).toBeGreaterThan(10);
	});

	test('a shortfall is a failure that names the two numbers', () => {
		// Driven rather than reasoned about. The row passes when the numbers agree and
		// fails when they do not, and the failure has to say what it was expecting.
		const runtime = STEPS.find((step) => step.name === 'runtime tests');
		const expected = runtime?.subset?.('')?.expected as number;
		const short = runtime?.subset?.(` Test Files  ${expected - 1} passed`);
		expect(short?.ran).toBe(expected - 1);
		expect(short?.expected).toBe(expected);
	});
});
