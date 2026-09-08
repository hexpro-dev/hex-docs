/**
 * The registry, pinned by what it produces rather than by what it says.
 *
 * Five surfaces are derived from `COMMANDS`: the CLI dispatch map, `--help`, the MCP tool
 * list, the MCP dispatch map and the vocabulary the skill validator checks a `SKILL.md`
 * against. Nothing is written twice, which means a single wrong entry here is wrong on
 * all five at once and wrong in the same words, so none of them contradicts another and
 * nothing catches it.
 *
 * The rules this file enforces are the ones `command.ts` states in prose and does not
 * type, and it says so at each of them: "asserted in `registry.test.ts` rather than
 * typed". Two are worth naming here because their failure is silent rather than loud.
 *
 * **The key-set proof.** `invoke` carries the one cast in the package, `parsed as never`,
 * because Zod cannot see `Input<P>`. The comment at that cast promises this file asserts
 * for every command that the key set the schema accepts is exactly the key set the params
 * declare. Without it the cast is a claim: a `shapeOf` that dropped a key, or a schema
 * that let an undeclared one through, would hand a handler an argument object that does
 * not match the type it was compiled against, and TypeScript would have signed off.
 *
 * **The tool-and-writes partition.** `Command`'s union makes a writer with a tool name
 * unrepresentable, which is a typecheck and therefore only as strong as the `as const` on
 * `writes`. The runtime sweep below is the second closure, and `kit/test/exec/no-write.test.ts`
 * walking the import graph is the third.
 */

import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { CHECK_STATES, type CheckRow } from '../../../src/contracts/diagnostics.js';
import type { DiagnosticEnvelope } from '../../../src/contracts/diagnostics.js';
import { DISPATCHER_TOKENS } from '../../src/cli/args.js';
import {
	exitCodeFor,
	invoke,
	type AnyCommand,
	type CommandOutput,
	type Ctx,
} from '../../src/registry/command.js';
import { BY_NAME, BY_TOOL, COMMANDS, TOOLS } from '../../src/registry/index.js';
import { shapeOf, type Param } from '../../src/registry/params.js';
import { SKILL_IDS } from '../../src/skills/ids.js';

/**
 * The counts `kit/src/registry/index.ts` states in its own opening paragraph.
 *
 * Pinned so that sentence cannot go stale quietly. A command dropped from the array is
 * otherwise invisible: every derived surface simply stops mentioning it, `--help` gets one
 * line shorter, and the MCP tool list gets one entry smaller, all of which read as correct.
 */
const EXPECTED_COMMANDS = 16;
const EXPECTED_TOOLS = 9;

const named = COMMANDS.map((command) => [command.name, command] as const);

/** A value the parameter's own schema accepts, so a full call can be assembled. */
function sampleFor(param: Param): unknown {
	const leaf =
		param.type === 'boolean'
			? true
			: param.type === 'integer'
				? 1
				: (param.values?.[0] ?? 'sample');
	return param.many === true ? [leaf] : leaf;
}

function row(status: CheckRow['status']): CheckRow {
	return { id: 'probe', status, examined: 1, unit: 'things', findings: [], note: null };
}

function envelope(errors: number): DiagnosticEnvelope {
	return {
		kitVersion: '@hex-pro/docs-kit@0.0.0',
		summary: { errors, warnings: 2, infos: 3, passing: 4 },
		findings: [],
		truncated: false,
		nextAction: { kind: 'none', why: 'Nothing to do.' },
	};
}

function output(parts: Partial<CommandOutput>): CommandOutput {
	return { data: null, lines: [], envelope: null, rows: [], ...parts };
}

describe('names and tools', () => {
	test('there are sixteen commands and nine tools', () => {
		expect(COMMANDS.length).toBe(EXPECTED_COMMANDS);
		expect(TOOLS.length).toBe(EXPECTED_TOOLS);
	});

	test('every name is kebab case and unique', () => {
		const names = COMMANDS.map((command) => command.name);
		const wrong = names.filter((name) => !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name));
		expect(wrong, 'not kebab case').toEqual([]);
		expect(new Set(names).size, 'a name is used twice').toBe(names.length);
	});

	test('every tool name is docs_ prefixed snake case and unique', () => {
		const tools = TOOLS.map((command) => command.tool as string);
		const wrong = tools.filter((tool) => !/^docs_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(tool));
		expect(wrong, 'not a docs_ snake case tool name').toEqual([]);
		expect(new Set(tools).size, 'a tool name is used twice').toBe(tools.length);
	});

	test('the two maps hold every entry', () => {
		// A duplicate name would not throw: `new Map` keeps the last entry, so the map is
		// one shorter than the array and the shadowed command is simply unreachable from
		// the CLI while still appearing in `--help`.
		expect(BY_NAME.size).toBe(COMMANDS.length);
		expect(BY_TOOL.size).toBe(TOOLS.length);
		for (const command of COMMANDS) expect(BY_NAME.get(command.name)).toBe(command);
		for (const command of TOOLS) expect(BY_TOOL.get(command.tool as string)).toBe(command);
	});

	test('TOOLS is exactly the commands carrying a tool name, in both directions', () => {
		expect(TOOLS.map((command) => command.name)).toEqual(
			COMMANDS.filter((command) => command.tool !== null).map((command) => command.name),
		);
		const toolLess = COMMANDS.filter((command) => command.tool === null).map((c) => c.name);
		expect(TOOLS.some((command) => toolLess.includes(command.name))).toBe(false);
	});
});

describe('the dispatcher owns three tokens and no command may shadow them', () => {
	// Derived from `DISPATCHER_TOKENS` rather than written out, so a token added to that
	// array is checked here without anybody remembering to add it. The shadowing failure is
	// not a crash: `stripDispatcherTokens` consumes `--json` before `bind` runs, so a
	// command declaring a `json` parameter would find it always absent, and the precedence
	// question ("did the caller mean the dispatcher's flag or mine?") has no answer written
	// anywhere.
	const forbidden = DISPATCHER_TOKENS.map((token) => token.replace(/^-+/, ''));

	test('the token list is not empty and every token is a flag spelling', () => {
		expect(DISPATCHER_TOKENS.length).toBeGreaterThan(0);
		for (const token of DISPATCHER_TOKENS) expect(token.startsWith('-')).toBe(true);
		expect(forbidden).toEqual(['json', 'help', 'h']);
	});

	test.each(named)('%s declares none of them', (_name, command) => {
		const shadowed = Object.keys(command.params).filter((key) => forbidden.includes(key));
		expect(shadowed, `${command.name} shadows a dispatcher token`).toEqual([]);
	});
});

describe('positionals', () => {
	test.each(named)('%s: every positional is a key of params', (_name, command) => {
		const unknown = command.positionals.filter((key) => command.params[key] === undefined);
		expect(unknown, `${command.name}: positional names no parameter`).toEqual([]);
	});

	test.each(named)('%s: no positional is repeatable', (_name, command) => {
		// `parseArgs` puts positionals in one flat array, so a repeatable positional has no
		// spelling: `bind` assigns by index and the second value would land on the next
		// positional's key.
		const repeatable = command.positionals.filter((key) => command.params[key]?.many === true);
		expect(repeatable, `${command.name}: a positional declares many`).toEqual([]);
	});

	test.each(named)('%s: only the last positional may be optional', (_name, command) => {
		// The rule `command.ts` states and declines to type. `bind` fills positionals by
		// index, so an optional one in front of a required one silently rebinds every
		// argument after it: `hexdocs page guide/first-tag` with `['root', 'slug']` would
		// read the slug as a root and report a missing slug on a call that supplied one.
		const leading = command.positionals.slice(0, -1);
		const optional = leading.filter((key) => command.params[key]?.required !== true);
		expect(optional, `${command.name}: optional positional before a required one`).toEqual([]);
	});

	test('at least one command declares two positionals', () => {
		// Naming the limit rather than implying more: with every command declaring one
		// positional or none, the ordering rule above is vacuously true everywhere and this
		// whole block would pass with `slice(0, -1)` replaced by `[]`.
		const many = COMMANDS.filter((command) => command.positionals.length > 1);
		expect(many.map((command) => command.name)).toEqual(['page']);
	});
});

describe('a command exposed over MCP cannot write', () => {
	test.each(named)('%s declares tool and writes consistently', (_name, command) => {
		// The runtime half of the union in `command.ts`. The type says a `tool` string forces
		// `writes: 'nothing'`, and that is only as strong as the `as const` the author wrote:
		// drop it and `writes` widens to `string`, the union member stops applying, and the
		// typecheck goes quiet.
		if (command.tool !== null) {
			expect(command.writes, `${command.name} has a tool and claims to write`).toBe('nothing');
		}
		expect(['nothing', 'files', 'network']).toContain(command.writes);
	});

	test('the tool-less commands are the writers plus mcp, and mcp alone', () => {
		// `registry/index.ts` opens by saying "the seven with no tool are exactly the seven
		// that write". Measured, that sentence is wrong by one: `mcp` has no tool and writes
		// nothing, because it is the server itself and cannot be a tool of the server it
		// starts. The exception is pinned here so a second one cannot be added without a
		// decision, and so the sentence cannot drift further from the table it describes.
		const quietAndToolLess = COMMANDS.filter(
			(command) => command.tool === null && command.writes === 'nothing',
		).map((command) => command.name);
		expect(quietAndToolLess).toEqual(['mcp']);

		const writers = COMMANDS.filter((command) => command.writes !== 'nothing');
		expect(writers.every((command) => command.tool === null)).toBe(true);
		expect(writers.length).toBe(COMMANDS.length - TOOLS.length - 1);
	});
});

describe('every command is taught, and every skill teaches', () => {
	test.each(named)('%s names at least one real skill', (_name, command) => {
		expect(command.taughtBy.length, `${command.name} is taught by nothing`).toBeGreaterThan(0);
		const unknown = command.taughtBy.filter((id) => !(SKILL_IDS as readonly string[]).includes(id));
		expect(unknown, `${command.name} names a skill that does not exist`).toEqual([]);
		expect(new Set(command.taughtBy).size, `${command.name} names a skill twice`).toBe(
			command.taughtBy.length,
		);
	});

	test('every skill teaches at least one command', () => {
		// The other direction. A skill nothing points at is a document with no route into
		// it from the tool surface, which is the same failure as a command no skill teaches
		// seen from the other end.
		//
		// The limit, named rather than implied: every skill is currently named by at least
		// two commands, so no single `taughtBy` edit can turn this red. Measured, the
		// mutation it does catch is a skill added to `SKILL_IDS` that nothing points at,
		// which is the order the work actually happens in.
		const taught = new Set(COMMANDS.flatMap((command) => command.taughtBy));
		const idle = SKILL_IDS.filter((id) => !taught.has(id));
		expect(idle, 'these skills teach no command').toEqual([]);
	});
});

describe('the prose a person and a model both read', () => {
	test.each(named)('%s has a summary and a detail that differ', (_name, command) => {
		expect(command.summary.trim().length, `${command.name}: empty summary`).toBeGreaterThan(0);
		expect(command.detail.trim().length, `${command.name}: empty detail`).toBeGreaterThan(0);
		// The MCP tool title and its description come from these two. Identical text is a
		// tool whose description repeats its title and tells a model nothing extra, which is
		// what `detail` exists to avoid.
		expect(command.summary).not.toBe(command.detail);
		expect(command.detail.length).toBeGreaterThan(command.summary.length);
	});

	test.each(named)('%s summary is one line ending in a full stop', (_name, command) => {
		expect(command.summary).not.toMatch(/\n/);
		expect(command.summary.endsWith('.'), `${command.name}: ${command.summary}`).toBe(true);
		expect(command.detail.endsWith('.'), `${command.name}: detail does not end a sentence`).toBe(
			true,
		);
	});

	test.each(named)('%s: every parameter help is a fragment with no full stop', (_name, command) => {
		for (const [key, param] of Object.entries(command.params)) {
			const where = `${command.name} --${key}`;
			expect(param.help.trim().length, `${where}: empty help`).toBeGreaterThan(0);
			expect(param.help, `${where}: help is not trimmed`).toBe(param.help.trim());
			expect(param.help, `${where}: help spans lines`).not.toMatch(/\n/);
			// `Param.help` is documented as "one line, present tense, no trailing full stop".
			// It is the JSON Schema `description` and the `--help` column at once, so a
			// sentence here reads as a sentence in one place and as a stray dot in the other.
			expect(param.help.endsWith('.'), `${where}: "${param.help}"`).toBe(false);
			expect(/^[a-z]/.test(param.help), `${where}: does not open lower case`).toBe(true);
		}
	});
});

describe('the schema accepts exactly the keys the table declares', () => {
	// The runtime proof standing in for the cast in `invoke`, which `command.ts` promises
	// exists here by name. Both directions in one test, because either alone is satisfied
	// by a schema that is wrong in the other: a schema that dropped a key still accepts an
	// undeclared one, and a passthrough schema still carries every declared key.

	/** A call every parameter of the command supplies a legal value for. */
	function fullCall(command: AnyCommand): Record<string, unknown> {
		return Object.fromEntries(
			Object.entries(command.params).map(([key, param]) => [key, sampleFor(param)]),
		);
	}

	test.each(named)('%s, through shapeOf', (_name, command) => {
		const parsed = z
			.object(shapeOf(command.params))
			.safeParse({ ...fullCall(command), undeclaredFlag: 'x' });
		expect(parsed.success, `${command.name}: refused a call built from its own table`).toBe(true);
		if (!parsed.success) return;
		expect(
			Object.keys(parsed.data).sort(),
			`${command.name}: the key set the schema accepts is not the key set it declares`,
		).toEqual(Object.keys(command.params).sort());
	});

	/**
	 * The same proof through the real `invoke`, which is where the cast actually is.
	 *
	 * The test above builds its own `z.object`, so it says what `shapeOf` produces and
	 * nothing about how `invoke` uses it: swap that line for `z.looseObject` and every
	 * undeclared key in a tool call would reach a handler typed to have none, with the
	 * assertion above still green. Driving `invoke` against a stand-in command whose `run`
	 * records what it was handed is the only way to see the object the handler receives.
	 */
	const CTX: Ctx = {
		cwd: '/nowhere',
		kitVersion: '@hex-pro/docs-kit@0.0.0',
		exec: () => {
			throw new Error('no command run here should reach the exec boundary');
		},
		write: null,
		now: () => new Date(0),
		log: () => undefined,
	};

	test.each(named)('%s, through invoke', async (_name, command) => {
		let seen: Record<string, unknown> | null = null;
		const probe = {
			...command,
			async run(input: never): Promise<CommandOutput> {
				seen = input as Record<string, unknown>;
				return { data: null, lines: [], envelope: null, rows: [] };
			},
		} as AnyCommand;

		await invoke(probe, { ...fullCall(command), undeclaredFlag: 'x' }, CTX);
		expect(seen, `${command.name}: run was never reached`).not.toBeNull();
		expect(
			Object.keys(seen ?? {}).sort(),
			`${command.name}: invoke handed the handler a key set its own table does not declare`,
		).toEqual(Object.keys(command.params).sort());
	});

	test('invoke refuses a call the table does not allow, rather than passing it on', async () => {
		// So the assertion above cannot be satisfied by an `invoke` that skips the parse.
		// `scaffold` declares `kind` as a required enum, which is the narrowest thing in the
		// registry to be wrong about.
		const scaffold = BY_NAME.get('scaffold') as AnyCommand;
		let reached = false;
		const probe = {
			...scaffold,
			async run(): Promise<CommandOutput> {
				reached = true;
				return { data: null, lines: [], envelope: null, rows: [] };
			},
		} as AnyCommand;

		await expect(invoke(probe, { kind: 'not-a-kind' }, CTX)).rejects.toThrow();
		await expect(invoke(probe, {}, CTX)).rejects.toThrow();
		expect(reached, 'invoke ran the handler over an input it should have refused').toBe(false);
	});
});

describe('exitCodeFor', () => {
	// Four row states and two envelope shapes, with the state list checked against the
	// contract in both directions so a fifth state cannot arrive with no verdict attached.
	const BY_STATE: Record<CheckRow['status'], 0 | 3> = {
		pass: 0,
		// Deliberately not run, with a reason, which is a decision rather than a gap.
		skipped: 0,
		fail: 3,
		// "Should have run and did not." Dark is indistinguishable from green to an exit
		// code, which is exactly why this one is 3.
		'not-run': 3,
	};

	test('the covered states are exactly CHECK_STATES', () => {
		expect(Object.keys(BY_STATE).sort()).toEqual([...CHECK_STATES].sort());
	});

	test.each(Object.entries(BY_STATE))('a single %s row exits %d', (status, code) => {
		expect(exitCodeFor(output({ rows: [row(status as CheckRow['status'])] }))).toBe(code);
	});

	test('one failing row among passes still fails', () => {
		expect(exitCodeFor(output({ rows: [row('pass'), row('not-run'), row('pass')] }))).toBe(3);
		expect(exitCodeFor(output({ rows: [row('pass'), row('skipped')] }))).toBe(0);
	});

	test('an envelope with errors fails and one without does not', () => {
		expect(exitCodeFor(output({ envelope: envelope(1) }))).toBe(3);
		// Warnings and infos are not failures. `summary` carries two of each here, so a
		// check that read the wrong counter would still come back 3.
		expect(exitCodeFor(output({ envelope: envelope(0) }))).toBe(0);
	});

	test('a clean envelope beside a failing row still fails', () => {
		expect(exitCodeFor(output({ envelope: envelope(0), rows: [row('fail')] }))).toBe(3);
	});

	test('nothing at all is clean', () => {
		// `build` returning no rows and no envelope is a real shape, and there is no verdict
		// to report from it. The usage code 2 is `main.ts`'s and never a command's.
		expect(exitCodeFor(output({}))).toBe(0);
	});
});

describe('the shape of every command, committed', () => {
	/**
	 * The regression this exists for is the one the failure catalogue's row 8 names from
	 * the other side: a flag renamed in the registry and not in the five skills. The skill
	 * validator reads the registry, so it moves with the rename and stays green; the
	 * `SKILL.md` files still name the old flag and nothing here would notice. A committed
	 * shape means the rename shows up in a diff beside the skill files, which is where a
	 * reviewer can see that one changed and the others did not.
	 *
	 * Parameter keys are sorted rather than left in declaration order, because declaration
	 * order is `--help`'s business and reordering a table is not a change to the surface.
	 */
	function shape(command: AnyCommand): string {
		const keys = Object.keys(command.params).sort();
		return [
			command.name.padEnd(15),
			(command.tool ?? '-').padEnd(20),
			command.writes.padEnd(8),
			`[${command.positionals.join(' ')}]`.padEnd(14),
			keys.join(' '),
		]
			.join(' ')
			.trimEnd();
	}

	test('names, tools, positionals and flags', () => {
		expect(COMMANDS.map(shape).join('\n')).toMatchInlineSnapshot(`
			"doctor          docs_doctor          nothing  [root]         bundle root site
			check           docs_check           nothing  [root]         category include-drafts locale root severity
			pages           docs_pages           nothing  [root]         bundle locale root
			page            docs_page            nothing  [slug root]    bundle format limit locale offset root slug
			bundle          docs_bundle          nothing  [path]         against path
			label           docs_label           nothing  []             cache commit project released root source-repo version
			scaffold        docs_scaffold        nothing  [kind]         kind locale product-name project repo root site slug title
			skills          docs_skills          nothing  [id]           id
			verify-install  docs_verify_install  nothing  [root]         mount root site
			init            -                    files    [root]         locale product-name project repo root write
			build           -                    files    [root]         include-drafts out root
			install         -                    files    [root]         mount root site write
			sync            -                    files    [root]         cache project root site
			publish         -                    network  [bundle]       bucket bundle profile region
			prefetch        -                    files    [root]         bucket cache offline profile region root site
			mcp             -                    nothing  []"
		`);
	});
});
