/**
 * `--json` puts exactly one JSON object on stdout and every human-readable line on stderr.
 *
 * For every command in the registry, in both directions, so a command added tomorrow
 * cannot skip it. This is the stray-`console.log` guard: a tool that mixes the two surfaces
 * cannot be parsed by the consumer's `check-docs.mjs` shim or by an agent, and the failure
 * is a `JSON.parse` error naming a byte offset in what is otherwise a perfectly good
 * report. One `console.log` added while debugging, in any module any command reaches, and
 * the shim that runs from `prebuild` on every deploy stops being able to read the answer.
 *
 * The stdout assertion is a round trip rather than a `JSON.parse` that throws away its
 * result. `JSON.parse` already refuses trailing text, but re-serialising and comparing is
 * what also catches a second document, a leading banner and a trailing blank object: the
 * whole of stdout has to be the serialisation of one value and nothing else.
 *
 * The plain-mode assertion is the other half and is easy to forget. Without `--json`,
 * stderr must be empty: a human surface that wrote diagnostics to stderr anyway would make
 * `hexdocs check 2>/dev/null` silently drop half the report.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { CONSUMER_ROOT, materialiseCorpus } from '../../../fixtures/index.js';
import { materialiseConsumerWithConfig, removeConsumer } from '../../../fixtures/consumers.js';
import type { Consumer } from '../../../fixtures/consumers.js';
import { defaultContext, run } from '../../src/cli/main.js';
import { build } from '../../src/commands/build.js';
import { invoke } from '../../src/registry/command.js';
import { COMMANDS } from '../../src/registry/index.js';
import type { Ctx } from '../../src/registry/command.js';
import type { RunResult } from '../../src/exec/run.js';

interface Env {
	readonly scratch: string;
	readonly corpus: string;
	readonly consumer: Consumer;
	readonly bundleDir: string;
}

/**
 * A command this file can drive, or one it cannot, with the reason.
 *
 * `excluded` is a named state rather than an absence, because a silent skip is exactly the
 * shape this repository refuses everywhere else: a command missing from the table would
 * otherwise be indistinguishable from a command nobody thought about.
 */
type Plan =
	| {
			readonly kind: 'run';
			readonly argv: (env: Env) => string[];
			/**
			 * Whether the two runs can be compared line for line.
			 *
			 * Only `build` opts out, and the reason is in its entry: it writes, so the second
			 * run over one output directory reports what the first one already put there.
			 */
			readonly crossCheck?: false;
			readonly why?: string;
	  }
	| { readonly kind: 'excluded'; readonly why: string };

const INVOCATIONS: Readonly<Record<string, Plan>> = {
	doctor: { kind: 'run', argv: (env) => ['doctor', env.corpus] },
	check: { kind: 'run', argv: (env) => ['check', env.corpus] },
	pages: { kind: 'run', argv: (env) => ['pages', env.corpus] },
	page: { kind: 'run', argv: (env) => ['page', 'index', env.corpus] },
	bundle: { kind: 'run', argv: (env) => ['bundle', env.bundleDir] },
	label: {
		kind: 'run',
		argv: (env) => [
			'label',
			'--root',
			env.consumer.root,
			'--project',
			'fixture-app',
			'--commit',
			'a'.repeat(40),
			'--version',
			'9.9.9',
			'--released',
			'2026-01-01',
		],
		why: 'The date is passed rather than taken from the clock, so the two runs produce the same entry.',
	},
	scaffold: {
		kind: 'run',
		argv: (env) => [
			'scaffold',
			'page',
			'--root',
			env.corpus,
			'--slug',
			'guide/a-new-page',
			'--title',
			'A new page',
		],
	},
	skills: { kind: 'run', argv: () => ['skills'] },
	'verify-install': {
		kind: 'run',
		argv: (env) => ['verify-install', env.consumer.root, '--site', env.consumer.site],
	},
	init: {
		kind: 'run',
		argv: (env) => [
			'init',
			join(env.scratch, 'fresh'),
			'--project',
			'fixture-app',
			'--product-name',
			'Fixture App',
			'--repo',
			'hexpro-dev/fixture-app',
		],
		why: 'No --write, so this is the dry run and the tree is untouched by both invocations.',
	},
	build: {
		kind: 'run',
		argv: (env) => ['build', env.corpus, '--out', join(env.scratch, 'json-out')],
		crossCheck: false,
		why: 'It writes. The first run reports 93 keys written and the second reports the same 93 already present, so the two texts differ for a reason that has nothing to do with the surfaces.',
	},
	install: {
		kind: 'run',
		argv: (env) => ['install', env.consumer.root, '--site', env.consumer.site],
		why: 'No --write, so the plan is produced by the applying code path and nothing is written.',
	},
	sync: {
		kind: 'run',
		argv: (env) => [
			'sync',
			env.consumer.root,
			'--site',
			env.consumer.site,
			'--project',
			'fixture-app',
			'--cache',
			join(env.scratch, 'empty-cache'),
		],
		why: 'The cache is empty, so this is the refusal path. It still has to obey both surfaces.',
	},
	publish: {
		kind: 'run',
		argv: (env) => ['publish', env.bundleDir, '--bucket', 'fixture-bucket'],
		why: 'The context carries a recording exec, so nothing is spawned and no bucket is reached.',
	},
	prefetch: {
		kind: 'run',
		argv: (env) => [
			'prefetch',
			env.consumer.root,
			'--site',
			env.consumer.site,
			'--offline',
			'--cache',
			join(env.scratch, 'empty-cache'),
		],
		why: '--offline makes no network call at all, so a missing bundle fails rather than downloading.',
	},
	mcp: {
		kind: 'excluded',
		why: '`run` blocks for the life of the process: it resolves only when stdin ends, which is when the MCP client has gone. Driving it here would hang the suite, and the surface it owns is the JSON-RPC framing rather than these two streams. kit/test/mcp drives startServer with in-memory streams instead.',
	},
};

let env: Env;
let ctx: Ctx;

beforeAll(async () => {
	const scratch = mkdtempSync(join(tmpdir(), 'hexdocs-json-'));
	const corpus = materialiseCorpus(join(scratch, 'app')).root;
	const consumer = materialiseConsumerWithConfig(
		'glob-workspace',
		join(CONSUMER_ROOT, 'fixture-app.docs.json'),
	);

	// Nothing here spawns anything. `label` asks the bucket when AWS credentials happen to
	// be configured on the machine running the suite, and `publish` would upload, so the
	// exec is replaced rather than left to the environment: a test whose behaviour depends
	// on whether the developer has an AWS profile is a test that passes for the wrong
	// reason on one machine and fails on the other.
	const exec = (): RunResult => ({
		status: 1,
		stdout: '',
		stderr: 'An error occurred (404) when calling the HeadObject operation: Not Found',
	});

	const base = defaultContext(scratch);
	ctx = { ...base, exec };

	// Through `invoke` rather than through `run --json`, deliberately. The fixture must not
	// be built by the surface under test: parsing the dispatcher's stdout here would make a
	// mutation to `run` fail this file as a broken hook with sixty-four skipped rows, and a
	// skipped row reads like a decision rather than like the defect it is.
	const built = await invoke(build, { root: corpus, out: join(scratch, 'out') }, ctx);
	const bundleDir = (built.data as { prefix: string }).prefix;
	env = { scratch, corpus, consumer, bundleDir };
});

afterAll(() => {
	rmSync(env.scratch, { recursive: true, force: true });
	removeConsumer(env.consumer);
});

function parses(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

interface Streams {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	/** Anything that reached the process's own stdout, going around `run` entirely. */
	readonly leaked: string;
}

/**
 * One invocation, with the process's stdout watched as well as the returned strings.
 *
 * The watch is the half that makes this a `console.log` guard rather than a shape check.
 * `run` builds its two strings and returns them, so a `console.log` anywhere under a
 * command handler misses both of them and lands on the process's own stdout, where the MCP
 * client and the consumer's shim are reading.
 *
 * **Both spellings are watched, and the second one is not obvious.** vitest replaces the
 * console with its own reporter-bound implementation, so a `console.log` never reaches
 * `process.stdout.write` under the suite. Measured: with `console.log('leaked')` planted in
 * `check`'s handler, a `process.stdout.write` spy alone saw nothing and every assertion
 * here passed. The console spy is what catches the debugging line somebody left in; the
 * stream spy is what catches a module that writes to the descriptor directly, which is
 * what the MCP server does with the protocol.
 */
async function invoked(argv: readonly string[]): Promise<Streams> {
	const leaked: string[] = [];
	const collect = (chunk: unknown): void => {
		leaked.push(typeof chunk === 'string' ? chunk : JSON.stringify(chunk));
	};
	const stream = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		collect(chunk);
		return true;
	});
	const spies = (['log', 'info', 'debug', 'dir', 'table'] as const).map((method) =>
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			for (const arg of args) collect(arg);
		}),
	);
	try {
		const result = await run(argv, ctx);
		return { ...result, leaked: leaked.join('') };
	} finally {
		stream.mockRestore();
		for (const spy of spies) spy.mockRestore();
	}
}

describe('the table covers the registry', () => {
	test('every command has a plan, and every plan names a command', () => {
		// Both directions, so a command added to the registry lands in `missing` until
		// somebody decides how to drive it, and a plan for a command that has been deleted
		// fails rather than sitting there describing nothing.
		const names = COMMANDS.map((command) => command.name);
		const planned = Object.keys(INVOCATIONS);
		expect(names.filter((name) => INVOCATIONS[name] === undefined)).toEqual([]);
		expect(planned.filter((name) => !names.includes(name))).toEqual([]);
		expect(planned.length).toBe(names.length);
	});

	test('every exclusion carries a reason worth reading', () => {
		// A one-word reason is an exemption nobody decided on, which is the shape
		// `fixtures/planted.json` refuses on the other exemption mechanism in this package.
		for (const [name, plan] of Object.entries(INVOCATIONS)) {
			if (plan.kind !== 'excluded') continue;
			expect(
				plan.why.length,
				`${name}'s exclusion reason is too short to be a decision`,
			).toBeGreaterThan(80);
		}
	});

	test('most of the registry is actually driven, not excluded', () => {
		// The count that stops this file being satisfied by excluding everything.
		const runnable = Object.values(INVOCATIONS).filter((plan) => plan.kind === 'run');
		expect(runnable.length).toBeGreaterThanOrEqual(COMMANDS.length - 1);
	});
});

const RUNNABLE = COMMANDS.map(
	(command) => [command.name, INVOCATIONS[command.name]] as const,
).filter((entry): entry is readonly [string, Extract<Plan, { kind: 'run' }>] => {
	return entry[1]?.kind === 'run';
});

describe('--json puts exactly one JSON document on stdout', () => {
	test.each(RUNNABLE)('%s', async (_name, plan) => {
		const result = await invoked([...plan.argv(env), '--json']);

		// Nothing reached the process's own stdout on the way. This is the assertion a stray
		// `console.log` fails, and it is the only one that can: `run` returns strings it built
		// itself, so a direct write is invisible to every other check in this file.
		expect(result.leaked, 'something wrote to stdout or the console around `run`').toBe('');
		expect(parses(result.stdout), `stdout is not JSON:\n${result.stdout.slice(0, 400)}`).toBe(true);
		const value: unknown = JSON.parse(result.stdout);
		// The round trip. `JSON.parse` refuses trailing text on its own; this also refuses a
		// leading banner, a second document and anything printed between the two.
		expect(result.stdout).toBe(`${JSON.stringify(value, null, 2)}\n`);
	});
});

describe('--json puts every human line on stderr', () => {
	test.each(RUNNABLE)('%s', async (_name, plan) => {
		const result = await invoked([...plan.argv(env), '--json']);
		expect(result.stderr, 'a command that printed nothing for a person to read').not.toBe('');
		// And the human text is not also on stdout, which is the failure that reads as a
		// working tool right up to the moment something parses it.
		expect(parses(result.stderr)).toBe(false);
	});
});

describe('without --json, stdout carries the human text and stderr carries nothing', () => {
	test.each(RUNNABLE)('%s', async (_name, plan) => {
		const result = await invoked(plan.argv(env));
		expect(result.leaked, 'something wrote to stdout or the console around `run`').toBe('');
		expect(result.stdout).not.toBe('');
		expect(parses(result.stdout), 'the human surface printed JSON').toBe(false);
		// stderr empty, so `hexdocs check 2>/dev/null` cannot silently drop half a report.
		expect(result.stderr).toBe('');
	});
});

describe('the two surfaces carry the same text', () => {
	const comparable = RUNNABLE.filter(([, plan]) => plan.crossCheck !== false);

	test('there are commands left to compare', () => {
		expect(comparable.length).toBeGreaterThanOrEqual(RUNNABLE.length - 1);
	});

	test.each(comparable)('%s: --json stderr is exactly the plain stdout', async (_name, plan) => {
		// One renderer, two destinations. If these ever diverged, the person reading a
		// terminal and the agent reading the JSON would be looking at two descriptions of one
		// run, which is the drift `CommandOutput` exists as a single shape to prevent.
		const withJson = await run([...plan.argv(env), '--json'], ctx);
		const plain = await run(plan.argv(env), ctx);
		expect(withJson.stderr).toBe(plain.stdout);
	});
});

describe('the dispatcher owns --json wherever it appears', () => {
	test('before the command name and after it produce the same streams', async () => {
		// `stripDispatcherTokens` walks the whole of argv, and `registry.test.ts` asserts no
		// command declares a parameter with one of these names, so there is no precedence
		// question to answer and this is what says so behaviourally.
		const before = await run(['--json', 'skills'], ctx);
		const after = await run(['skills', '--json'], ctx);
		expect(before.stdout).toBe(after.stdout);
		expect(before.stderr).toBe(after.stderr);
		expect(before.code).toBe(after.code);
	});
});
