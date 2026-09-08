/**
 * argv in, exit code out, and the exit code is never the command's to choose.
 *
 * Four codes and a rule behind each: 0 clean, 1 the toolchain threw, 2 the call was never
 * made, 3 the run found something. The one that costs the most to get wrong is the
 * boundary between 2 and 3. A tree hexdocs could not read is deliberately **not** a usage
 * error: "I could not read the registry" and "the registry is broken" are both "no
 * verdict, and it is not clean", and a 2 there would tell a workflow that nothing needed
 * looking at.
 *
 * The assertion this file is built around is the last block. Every code is recomputed from
 * the command's own `CommandOutput` with `exitCodeFor` and compared against what the
 * dispatcher returned, so a command that decided its own code, or a dispatcher that grew a
 * special case for one of them, fails here. A command that could set its own code could
 * report a clean run over a failing envelope, which is the one thing every guard in this
 * repository exists to make impossible.
 *
 * `run` is driven directly rather than through a spawned process. The process shell is
 * three lines over it and is covered by the spawn test; everything interesting about
 * dispatch is a function of argv and a context, and injecting the context is what makes
 * the exit-1 case reachable at all.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { materialiseCorpus } from '../../../fixtures/index.js';
import { bind, stripDispatcherTokens } from '../../src/cli/args.js';
import { defaultContext, run } from '../../src/cli/main.js';
import { BY_NAME } from '../../src/registry/index.js';
import { exitCodeFor, invoke, type Ctx } from '../../src/registry/command.js';

let scratch: string;
let corpus: string;
let bundleDir: string;
let ctx: Ctx;

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), 'hexdocs-dispatch-'));
	corpus = materialiseCorpus(join(scratch, 'app')).root;
	ctx = defaultContext(scratch);
	// A real bundle, so the clean case is a command that examined something and found
	// nothing rather than a command with no rows at all. `hexdocs bundle` over a bundle
	// `hexdocs build` just wrote is the smallest honest zero in the package.
	const built = await run(['build', corpus, '--out', join(scratch, 'out'), '--json'], ctx);
	bundleDir = (JSON.parse(built.stdout) as { prefix: string }).prefix;
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

interface Case {
	readonly name: string;
	readonly argv: () => string[];
	readonly code: number;
	/** What a wrong answer here would cost, in the words a reader of a failure wants. */
	readonly why: string;
	/** A line the message has to carry, when the message is the whole remedy. */
	readonly stderr?: RegExp;
	/**
	 * False when the dispatcher answers without reaching a command at all.
	 *
	 * `--help` is the only such case and it is marked rather than inferred from the code:
	 * inferring it from `code === 0` would silently drop a real command out of the
	 * recomputation block the day one of them starts exiting 0 for the wrong reason.
	 */
	readonly reachesCommand?: false;
}

const CASES: readonly Case[] = [
	{
		name: 'no command at all',
		argv: () => [],
		code: 2,
		why: 'A script that called hexdocs with nothing has not done what it meant to, even though the help printed.',
		stderr: /hexdocs <command> \[options\]/,
	},
	{
		name: '--help on its own',
		argv: () => ['--help'],
		code: 0,
		why: 'Asking for the help is not a usage error, and a wrapper that gated on the code would report every --help as a failure.',
		reachesCommand: false,
	},
	{
		name: '--help for one command',
		argv: () => ['check', '--help'],
		code: 0,
		why: 'The per-command help is derived from the registry and is the only help text there is.',
		stderr: /hexdocs check \[root\] \[options\]/,
		reachesCommand: false,
	},
	{
		name: 'a command nobody has',
		argv: () => ['banana'],
		code: 2,
		why: 'Nothing was examined, so a 3 would name a problem in the documentation that does not exist.',
		stderr: /there is no command called "banana"/,
	},
	{
		name: 'a flag the command does not declare',
		argv: () => ['check', '--banana'],
		code: 2,
		why: 'An unknown flag means the call was never made. Reporting a clean run would be a lie.',
		stderr: /^hexdocs check: /,
	},
	{
		name: 'a required argument that is missing',
		argv: () => ['build', corpus],
		code: 2,
		why: '`--out` has no default, and a schema failure is the same class as an unknown flag: the call was never made.',
		stderr: /^hexdocs build: /,
	},
	{
		name: 'one positional too many',
		argv: () => ['check', corpus, 'and-another'],
		code: 2,
		why: 'Dropping the extra would check one directory and say nothing at all about the other, which reads as a clean run over a directory nobody asked about.',
		stderr: /takes 1 positional argument\(s\)/,
	},
	{
		name: 'a clean run over a real bundle',
		argv: () => ['bundle', bundleDir],
		code: 0,
		why: 'Rows that examined something and found nothing.',
	},
	{
		name: 'a tree with findings',
		argv: () => ['check', corpus],
		code: 3,
		why: 'The fixture corpus carries seven planted errors on purpose, and an envelope with errors is a 3.',
	},
	{
		name: 'a build that wrote the bundle and still found errors',
		argv: () => ['build', corpus, '--out', join(scratch, 'again')],
		code: 3,
		why: 'The bundle is written even when the lint has errors, and the exit code still reports them, so a workflow that gates on it stops.',
	},
	{
		name: 'a tree that is not in a git repository',
		argv: () => ['check', join(scratch, 'nothing-here')],
		code: 3,
		why: 'An input hexdocs could not read is a not-run row and therefore a 3, never a usage error: "I could not read it" and "it is broken" are both "no verdict, and it is not clean".',
	},
];

describe('exit codes', () => {
	test.each(CASES.map((one) => [`${one.name} exits ${one.code}`, one] as const))(
		'%s',
		async (_name, one) => {
			const result = await run(one.argv(), ctx);
			expect(result.code, one.why).toBe(one.code);
			if (one.stderr !== undefined) {
				expect(result.stderr).toMatch(one.stderr);
			}
		},
	);

	test('a command that throws is a 1, with its stack, and not a 3', async () => {
		// Injected through the context rather than by stubbing a registry entry, because
		// that is what `Ctx` is for: `label` stamps a release date from `ctx.now()` before it
		// reads anything, so a clock that throws is the smallest reachable bug in hexdocs.
		// The distinction is the point. A 3 says the documentation is wrong; a 1 says this
		// tool is, and sends the reader to a different repository.
		const broken: Ctx = {
			...ctx,
			now: () => {
				throw new Error('the clock exploded');
			},
		};
		const result = await run(
			['label', '--project', 'fixture-app', '--commit', 'a'.repeat(40), '--version', '1.0.0'],
			broken,
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('This is a bug in hexdocs.');
		expect(result.stderr).toContain('the clock exploded');
		expect(result.stdout).toBe('');
	});
});

describe('a call that was never made prints no result', () => {
	test.each(CASES.filter((one) => one.code === 2).map((one) => [one.name, one] as const))(
		'%s writes nothing to stdout',
		async (_name, one) => {
			// stdout is the machine surface. A usage error that printed a partial object there
			// would be parsed by the consumer's shim as a report, and half a report reads as a
			// run in which most things passed.
			const result = await run(one.argv(), ctx);
			expect(result.stdout).toBe('');
			expect(result.stderr).not.toBe('');
		},
	);

	test('--json does not change that', async () => {
		const result = await run(['banana', '--json'], ctx);
		expect(result.code).toBe(2);
		expect(result.stdout).toBe('');
	});
});

describe('no command decides its own exit code', () => {
	// The cases that actually reach a command, so the code can be recomputed from what the
	// command returned. A dispatcher special case for one command, or a command that
	// reported a clean run over a failing envelope, fails here and nowhere else: every
	// other assertion in this file would be satisfied by a hard-coded table.
	const reaching = CASES.filter(
		(one) => one.reachesCommand !== false && (one.code === 0 || one.code === 3),
	);

	test('there are cases reaching a command, or this block proves nothing', () => {
		expect(reaching.length).toBeGreaterThan(2);
	});

	test.each(reaching.map((one) => [one.name, one] as const))(
		'%s: the code is exactly exitCodeFor of what the command returned',
		async (_name, one) => {
			const argv = one.argv();
			const { rest } = stripDispatcherTokens(argv);
			const command = BY_NAME.get(rest[0] as string);
			expect(command, `${argv[0]} is not a command`).toBeDefined();
			if (command === undefined) return;

			const output = await invoke(command, bind(command, rest.slice(1)), ctx);
			const expected = exitCodeFor(output);
			const result = await run(argv, ctx);
			expect(result.code).toBe(expected);
			// And the recomputation has to be the interesting one rather than always 0, or
			// the comparison above is satisfied by a dispatcher that returns 0 for everything.
			expect(expected).toBe(one.code);
		},
	);

	test('exitCodeFor turns a not-run row into a 3, the same as a failing one', () => {
		// The rule the whole ladder rests on, asserted at the function rather than through a
		// command: delete the thing a check reads and every row goes dark, and dark is
		// indistinguishable from green to an exit code.
		const base = { data: null, lines: [], envelope: null } as const;
		const one = (status: 'pass' | 'fail' | 'skipped' | 'not-run') => ({
			id: 'x',
			status,
			examined: status === 'pass' || status === 'fail' ? 1 : 0,
			unit: 'files',
			findings: [],
			note: null,
		});
		expect(exitCodeFor({ ...base, rows: [one('pass')] })).toBe(0);
		expect(exitCodeFor({ ...base, rows: [one('skipped')] })).toBe(0);
		expect(exitCodeFor({ ...base, rows: [one('fail')] })).toBe(3);
		expect(exitCodeFor({ ...base, rows: [one('not-run')] })).toBe(3);
	});
});
