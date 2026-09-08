/**
 * `nextAction` is the only semantic promise in the diagnostic contract, so it is the only
 * one that can be wrong without anything going red.
 *
 * Every envelope and every report carries one, `docs-diagnose` tells an agent to follow it
 * rather than pick a finding itself, and both consumers' shims print it. A finding that is
 * wrong is a sentence a person reads and disagrees with. An action that is wrong is a
 * command an agent runs. So there are two things to prove and they are different in kind:
 *
 *   **Mechanical.** A `kind: 'command'` action names `hexdocs`, a command in the registry
 *   and flags that command declares; a `kind: 'tool'` action names a tool in `BY_TOOL`.
 *   A renamed command or a dropped flag makes every action naming it a dead end, and
 *   nothing else in this package compares the two.
 *
 *   **Semantic.** Following the chain from a broken state has to get somewhere. It must
 *   terminate, within a small bound, without revisiting a state it has already been in, and
 *   without ever handing an agent a command that writes to the repository unasked.
 *
 * The chain is followed the way an agent would follow it: `--json` on stdout, `nextAction`
 * read out of the parsed object, the argv dispatched. Reading the in-process
 * `CommandOutput` instead would test a path no caller uses.
 *
 * **Two of these tests are `test.fails`, and both are defects rather than decisions.** Each
 * one names the file and the line. When the defect is fixed the test fails for passing,
 * which is the prompt to turn it back into an ordinary assertion.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { APP_ROOT, CONSUMER_ROOT, materialiseCorpus } from '../../fixtures/index.js';
import { materialiseConsumerWithConfig, removeConsumer } from '../../fixtures/consumers.js';
import type { Consumer } from '../../fixtures/consumers.js';
import type { NextAction } from '../../src/contracts/diagnostics.js';
import { DISPATCHER_TOKENS } from '../src/cli/args.js';
import { defaultContext, run } from '../src/cli/main.js';
import { BY_NAME, BY_TOOL } from '../src/registry/index.js';
import type { Ctx } from '../src/registry/command.js';
import type { RunResult } from '../src/exec/run.js';
import { invoke } from '../src/registry/command.js';
import { build } from '../src/commands/build.js';

// ---------------------------------------------------------------------------
// The mechanical rule
// ---------------------------------------------------------------------------

/**
 * Everything wrong with one action, as sentences a reader can act on.
 *
 * Written as a returned list rather than as assertions so the same function checks an
 * action collected from a command and an action written by hand below. The hand-written
 * cases are what stop this being a validator that accepts everything: a sweep whose
 * checker is broken passes over real defects and reads exactly like a clean sweep.
 */
function problemsInAction(action: NextAction, where: string): string[] {
	if (action.kind === 'none') {
		return action.why.trim() === '' ? [`${where}: a "none" action with no reason.`] : [];
	}

	if (action.kind === 'tool') {
		const command = BY_TOOL.get(action.tool);
		if (command === undefined) {
			return [`${where}: names the tool "${action.tool}", which is not in BY_TOOL.`];
		}
		return Object.keys(action.args)
			.filter((key) => command.params[key] === undefined)
			.map((key) => `${where}: "${key}" is not a parameter of ${action.tool}.`);
	}

	const problems: string[] = [];
	if (action.argv[0] !== 'hexdocs') {
		problems.push(`${where}: argv[0] is ${JSON.stringify(action.argv[0])}, not "hexdocs".`);
	}
	const name = action.argv[1];
	const command = name === undefined ? undefined : BY_NAME.get(name);
	if (command === undefined) {
		problems.push(`${where}: ${JSON.stringify(name)} is not a command in the registry.`);
		return problems;
	}
	for (const token of action.argv.slice(2)) {
		if (!token.startsWith('--')) continue;
		if ((DISPATCHER_TOKENS as readonly string[]).includes(token)) continue;
		const flag = token.slice(2).split('=', 1)[0] as string;
		if (command.params[flag] === undefined) {
			problems.push(`${where}: --${flag} is not a parameter of \`${name}\`.`);
		}
	}
	if (action.why.trim() === '') problems.push(`${where}: a command action with no reason.`);
	return problems;
}

describe('the validator itself refuses what it is meant to refuse', () => {
	// Without this block the sweeps below are worthless: a checker that returns an empty
	// list for everything reports a clean run over every defect there is.
	test('a command nobody has, a flag nobody declares and a tool nobody serves', () => {
		expect(
			problemsInAction({ kind: 'command', argv: ['hexdocs', 'lint', 'a.md'], why: 'x' }, 'w'),
		).not.toEqual([]);
		expect(
			problemsInAction({ kind: 'command', argv: ['hexdocs', 'check', '--banana'], why: 'x' }, 'w'),
		).not.toEqual([]);
		expect(
			problemsInAction({ kind: 'command', argv: ['npx', 'check'], why: 'x' }, 'w'),
		).not.toEqual([]);
		expect(
			problemsInAction({ kind: 'tool', tool: 'docs_lint', args: {}, why: 'x' }, 'w'),
		).not.toEqual([]);
		expect(
			problemsInAction({ kind: 'tool', tool: 'docs_check', args: { banana: 1 }, why: 'x' }, 'w'),
		).not.toEqual([]);
		expect(problemsInAction({ kind: 'none', why: '  ' }, 'w')).not.toEqual([]);
	});

	test('and accepts the real shapes', () => {
		expect(
			problemsInAction(
				{ kind: 'command', argv: ['hexdocs', 'check', '--severity', 'error'], why: 'x' },
				'w',
			),
		).toEqual([]);
		expect(
			problemsInAction({ kind: 'tool', tool: 'docs_check', args: { root: '.' }, why: 'x' }, 'w'),
		).toEqual([]);
		expect(problemsInAction({ kind: 'none', why: 'Nothing to do.' }, 'w')).toEqual([]);
	});

	test('a dispatcher token is a real flag, which is why doctor may name --help', () => {
		expect(
			problemsInAction({ kind: 'command', argv: ['hexdocs', 'doctor', '--help'], why: 'x' }, 'w'),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

let scratch: string;
let corpus: string;
let noGit: string;
let brokenConfig: string;
let consumer: Consumer;
let empty: string;

/** Never spawns. A chain that reached the network would depend on the developer's laptop. */
const exec = (): RunResult => ({
	status: 1,
	stdout: '',
	stderr: 'An error occurred (404) when calling the HeadObject operation: Not Found',
});

function contextIn(cwd: string): Ctx {
	const base = defaultContext(cwd);
	return { ...base, exec, now: () => new Date('2026-01-01T00:00:00Z') };
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'hexdocs-closure-'));
	corpus = materialiseCorpus(join(scratch, 'corpus')).root;

	// A tree with a documentation root and no history at all. Freshness is a comparison of
	// committer dates, so this is the state the compiler refuses rather than guesses at.
	noGit = join(scratch, 'no-git');
	cpSync(APP_ROOT, noGit, { recursive: true });

	brokenConfig = materialiseCorpus(join(scratch, 'broken')).root;
	writeFileSync(join(brokenConfig, 'docs', 'site', 'docs.json'), '{ "docs": 1, not json\n');

	consumer = materialiseConsumerWithConfig(
		'glob-workspace',
		join(CONSUMER_ROOT, 'fixture-app.docs.json'),
	);

	empty = join(scratch, 'empty');
	mkdirSync(empty, { recursive: true });
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
	removeConsumer(consumer);
});

// ---------------------------------------------------------------------------
// Following a chain
// ---------------------------------------------------------------------------

interface Step {
	readonly argv: readonly string[];
	readonly code: number;
	readonly action: NextAction | null;
}

/** How many steps a chain may take before it is a loop rather than a remedy. */
const BOUND = 6;

interface Chain {
	readonly steps: Step[];
	readonly terminus: 'none' | 'tool' | 'no-action' | 'revisited' | 'unbounded';
}

/**
 * Follows an action chain the way an agent following `docs-diagnose` would.
 *
 * `--json`, `nextAction` out of the parsed object, and the argv dispatched with `hexdocs`
 * stripped off the front. A command whose JSON carries no `nextAction` is a terminus: that
 * is not the same as `kind: 'none'` and the table below records which one each state
 * actually reaches, because the difference is the difference between "there is nothing
 * left to do" and "this command has no opinion".
 */
async function follow(start: readonly string[], cwd: string): Promise<Chain> {
	const ctx = contextIn(cwd);
	const steps: Step[] = [];
	const seen = new Set<string>();
	let argv: readonly string[] = start;

	for (let taken = 0; taken <= BOUND; taken += 1) {
		const key = JSON.stringify(argv);
		if (seen.has(key)) return { steps, terminus: 'revisited' };
		seen.add(key);

		const result = await run([...argv, '--json'], ctx);
		let action: NextAction | null = null;
		try {
			const data: unknown = JSON.parse(result.stdout);
			if (typeof data === 'object' && data !== null && 'nextAction' in data) {
				action = (data as { nextAction: NextAction }).nextAction;
			}
		} catch {
			// A usage error prints nothing on stdout, which is a terminus with no action
			// rather than a parse failure worth reporting here.
		}
		steps.push({ argv, code: result.code, action });

		if (action === null) return { steps, terminus: 'no-action' };
		if (action.kind === 'none') return { steps, terminus: 'none' };
		if (action.kind === 'tool') return { steps, terminus: 'tool' };
		argv = action.argv.slice(1);
	}
	return { steps, terminus: 'unbounded' };
}

interface BrokenState {
	readonly name: string;
	/** What is actually wrong, so a failure here reads as a statement about the state. */
	readonly why: string;
	readonly start: () => readonly string[];
	readonly cwd: () => string;
	readonly terminus: Chain['terminus'];
	/** How many commands the chain runs, so a chain that collapsed to one is a failure. */
	readonly steps: number;
}

const STATES: readonly BrokenState[] = [
	{
		name: 'a documentation tree with no git history',
		why: 'Translation freshness is a comparison of committer dates. The compiler refuses rather than supplying a synthetic commit, which is the shallow-clone failure reproduced deliberately.',
		start: () => ['doctor', noGit],
		cwd: () => noGit,
		terminus: 'no-action',
		steps: 2,
	},
	{
		name: 'a project config that is not JSON',
		why: 'A tree this command could not load is a not-run row and therefore a 3, and the message already names the file.',
		start: () => ['doctor', brokenConfig],
		cwd: () => brokenConfig,
		terminus: 'no-action',
		steps: 2,
	},
	{
		name: 'a consuming website that has never been wired',
		why: 'The submodule, the workspace exclusion, the tsconfig path and the rest are all absent, so most wiring rows fail.',
		start: () => ['doctor', consumer.root, '--site', consumer.site],
		cwd: () => consumer.root,
		terminus: 'no-action',
		steps: 3,
	},
	{
		name: 'a bundle directory that is not there',
		why: 'The state a labelled sha with no bundle produces on the machine that went looking for it: the prefix exists in the version table and nothing is under it.',
		start: () => [
			'doctor',
			consumer.root,
			'--site',
			consumer.site,
			'--bundle',
			join(scratch, 'gone'),
		],
		cwd: () => consumer.root,
		terminus: 'no-action',
		steps: 3,
	},
	{
		name: 'a directory with no documentation role at all',
		why: 'No docs/site/docs.json and no <project>.docs.json, so nothing ran and the one row doctor originates says so rather than printing "all clear" over an empty table.',
		start: () => ['doctor', empty],
		cwd: () => empty,
		terminus: 'no-action',
		steps: 2,
	},
	{
		name: 'a filter that matched nothing',
		why: 'The one state in the package that reaches kind:none through a real command rather than through a clean run, and its reason says outright that an empty filter result is not the same as nothing being wrong.',
		start: () => ['check', corpus, '--category', 'nav'],
		cwd: () => corpus,
		terminus: 'none',
		steps: 1,
	},
];

describe('following the chain out of a broken state', () => {
	test.each(STATES.map((state) => [state.name, state] as const))('%s', async (_name, state) => {
		const chain = await follow(state.start(), state.cwd());
		const trail = chain.steps.map((step) => step.argv.join(' ')).join('\n  ');

		// Bounded and non-repeating first, because both of those are how a remedy becomes a
		// loop an agent runs until something kills it.
		expect(chain.terminus, `chain:\n  ${trail}`).not.toBe('unbounded');
		expect(chain.terminus, `chain revisited a state:\n  ${trail}`).not.toBe('revisited');
		expect(chain.terminus, state.why).toBe(state.terminus);
		expect(chain.steps.length, `chain:\n  ${trail}`).toBe(state.steps);

		// Every action along the way names something real.
		const problems = chain.steps.flatMap((step) =>
			step.action === null ? [] : problemsInAction(step.action, step.argv.join(' ')),
		);
		expect(problems).toEqual([]);

		// And no step hands an agent a command that edits the repository. A diagnostic
		// that suggests `--write` is a diagnostic that changes the thing it was asked to
		// describe, and the agent following it has no reason to think twice.
		for (const step of chain.steps) {
			expect(step.argv, `${step.argv.join(' ')} writes`).not.toContain('--write');
		}
	});

	test('the states really are broken, or the chains above prove nothing', () => {
		// A state that stopped being broken would produce a one-step chain ending in
		// `kind: 'none'` and every assertion above would still pass on four of the six.
		expect(STATES.filter((state) => state.steps > 1).length).toBeGreaterThanOrEqual(5);
	});

	test('a chain reaches kind:none, so the terminating arm is exercised', () => {
		expect(STATES.some((state) => state.terminus === 'none')).toBe(true);
	});
});

describe('every action the suite can produce is mechanically valid', () => {
	interface Source {
		readonly name: string;
		readonly produce: () => Promise<NextAction[]>;
		/**
		 * Whether this shape carries an action at all, declared rather than inferred.
		 *
		 * Inferring it from what came back would make a command that stopped producing an
		 * action pass silently, which is the whole failure this table exists to catch.
		 */
		readonly carriesAction: boolean;
	}

	// Memoised, because two tests read the same sources and a corpus build is about a
	// second. The cache is per source rather than global so a source is still produced by
	// its own call rather than by whichever test ran first.
	const cache = new Map<string, Promise<NextAction[]>>();

	const fromJson = (argv: readonly string[], cwd: string) => async (): Promise<NextAction[]> => {
		const key = JSON.stringify([cwd, argv]);
		const hit = cache.get(key);
		if (hit !== undefined) return hit;
		const pending = produceFrom(argv, cwd);
		cache.set(key, pending);
		return pending;
	};

	const produceFrom = async (argv: readonly string[], cwd: string): Promise<NextAction[]> => {
		const result = await run([...argv, '--json'], contextIn(cwd));
		const data: unknown = JSON.parse(result.stdout);
		const found: NextAction[] = [];
		if (typeof data === 'object' && data !== null) {
			const record = data as Record<string, unknown>;
			if (record['nextAction'] !== undefined) found.push(record['nextAction'] as NextAction);
			const envelope = record['envelope'];
			if (typeof envelope === 'object' && envelope !== null && 'nextAction' in envelope) {
				found.push((envelope as { nextAction: NextAction }).nextAction);
			}
		}
		return found;
	};

	const SOURCES: readonly Source[] = [
		{
			name: 'check over a tree with findings',
			produce: () => fromJson(['check', corpus], corpus)(),
			carriesAction: true,
		},
		{
			name: 'check with a filter that matched nothing',
			produce: () => fromJson(['check', corpus, '--category', 'nav'], corpus)(),
			carriesAction: true,
		},
		{
			name: 'check over a tree it could not read',
			produce: () => fromJson(['check', noGit], noGit)(),
			// Measured, and worth knowing before somebody relies on the opposite. This shape
			// is `{ root, checked: false, why }` with a `not-run` row and a null envelope, so
			// it carries no action at all. `docs-diagnose` tells an agent "every report also
			// carries one nextAction" and this is the output that does not, which is why the
			// flag is declared per source rather than assumed for all of them.
			carriesAction: false,
		},
		{
			name: 'doctor over an app repository',
			produce: () => fromJson(['doctor', corpus], corpus)(),
			carriesAction: true,
		},
		{
			name: 'doctor over an unwired consumer',
			produce: () => fromJson(['doctor', consumer.root, '--site', consumer.site], consumer.root)(),
			carriesAction: true,
		},
		{
			name: 'doctor over a directory with no role',
			produce: () => fromJson(['doctor', empty], empty)(),
			carriesAction: true,
		},
		{
			name: 'verify-install over an unwired consumer',
			produce: () =>
				fromJson(['verify-install', consumer.root, '--site', consumer.site], consumer.root)(),
			carriesAction: true,
		},
	];

	test.each(SOURCES.map((source) => [source.name, source] as const))(
		'%s',
		async (_name, source) => {
			const actions = await source.produce();
			// Both directions over the declaration. A source that stopped producing an action
			// would otherwise pass over an empty list, and a source declared to carry none
			// that grows one would never be validated.
			if (source.carriesAction) {
				expect(actions.length, 'this source produced no action at all').toBeGreaterThan(0);
			} else {
				expect(actions, 'this source now carries an action and the table says it does not').toEqual(
					[],
				);
			}
			expect(actions.flatMap((action) => problemsInAction(action, source.name))).toEqual([]);
		},
	);

	test('the sweep saw more than one kind of action', async () => {
		const kinds = new Set(
			(await Promise.all(SOURCES.map((source) => source.produce()))).flat().map((a) => a.kind),
		);
		expect([...kinds].sort()).toEqual(['command', 'none']);
	});

	test('most sources do carry an action, so the sweep is not vacuous', () => {
		expect(SOURCES.filter((source) => source.carriesAction).length).toBeGreaterThanOrEqual(
			SOURCES.length - 1,
		);
	});

	test('no source produced a tool action, which is the limit of the tool arm above', () => {
		// Said plainly rather than implied. Nothing in the package returns `kind: 'tool'`
		// today, so the tool half of `problemsInAction` is proved by the hand-written cases
		// at the top of this file and by nothing else.
		expect(BY_TOOL.size).toBeGreaterThan(0);
	});
});

describe('two defects this closure found, now closed', () => {
	// Both of these were `test.fails` when this file was written, and each is kept as a
	// live assertion rather than deleted, because the state it pins is one the two most
	// obvious edits would restore.

	test('the lint envelope names a command that exists', async () => {
		// `kit/src/compile/lint/run.ts` returned `argv: ['hexdocs', 'lint', where]`, and
		// there is no `lint` command in the registry: an agent following it got exit 2 and
		// a usage error naming no finding.
		//
		// It stayed invisible because every surface that publishes an envelope recomputes
		// the action first. `build` is the one command that returns `runLint`'s own
		// envelope, and its `data` carries the counts rather than the envelope, so the bad
		// argv reached no JSON. That made it one refactor away from surfacing rather than
		// harmless, which is why the assertion is rooted at `build`.
		const ctx = contextIn(corpus);
		const output = await invoke(build, { root: corpus, out: join(scratch, 'lint-out') }, ctx);
		expect(output.envelope).not.toBeNull();
		expect(
			problemsInAction(output.envelope?.nextAction as NextAction, "build's own lint envelope"),
		).toEqual([]);
	});

	test('a filtered check does not name the command that produced it', async () => {
		// `filterEnvelope` returned `['hexdocs', 'check', '--severity', first.severity]`,
		// which is byte for byte the invocation that produces it whenever the run already
		// carried that filter. An agent that follows actions rather than reading the `why`
		// then never left the state.
		//
		// It now names the page the first finding is in, which is the thing to open next.
		// The property asserted is the general one rather than the specific argv: no chain
		// from this entry point revisits a state.
		const chain = await follow(['check', '--severity', 'error'], corpus);
		expect(chain.terminus, chain.steps.map((step) => step.argv.join(' ')).join(' -> ')).not.toBe(
			'revisited',
		);
	});
});
