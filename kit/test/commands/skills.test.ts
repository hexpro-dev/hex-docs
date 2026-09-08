/**
 * The five bundled skills, and the reader that loads them.
 *
 * `hexdocs skills` exists because of hex-nfc, where `.claude/` is gitignored by policy:
 * MCP is the only route to a skill there, and there is no second copy of the text to
 * notice a gap against. So an absent or unreadable skill has to be an exception rather
 * than an answer with four skills in it, and the set has to be checked against the
 * directory in both directions: a skill added to disk and not to `SKILL_IDS` is a file
 * nothing serves, and an id with no directory is a tool call that throws.
 *
 * The front matter reader is the other half. It is a second narrow reader, deliberately
 * separate from the compiler's, and its whole contract is that it never quietly
 * reinterprets: a value it is not certain of is a refusal naming the construct and saying
 * what YAML would have done with it. The five files on disk are all well formed, so
 * driving `loadSkill` alone would exercise the happy path and leave every refusal arm
 * untested. `parseSkill` takes a string for exactly that reason, and the refusal table
 * below is swept against the implementation's own pattern list, so an arm added there
 * without a case here fails naming the pattern.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { skills } from '../../src/commands/skills.js';
import { SKILL_IDS, isSkillId, type SkillId } from '../../src/skills/ids.js';
import {
	SkillError,
	loadAllSkills,
	loadSkill,
	parseSkill,
	skillPath,
	skillsRoot,
} from '../../src/skills/load.js';
import { invoke, type Ctx } from '../../src/registry/command.js';

const KIT_VERSION = '@hex-pro/docs-kit@0.0.0';

function ctx(): Ctx {
	return {
		cwd: skillsRoot(),
		kitVersion: KIT_VERSION,
		exec: () => {
			throw new Error('skills ran a process. It reads five files.');
		},
		write: null,
		now: () => new Date('2026-01-01T00:00:00Z'),
		log: () => {},
	};
}

/** The id of the first skill, used wherever a case needs one and does not care which. */
const ANY_ID: SkillId = SKILL_IDS[0];

describe('the five that ship', () => {
	test('all load, in SKILL_IDS order, with a body each', () => {
		const loaded = loadAllSkills();

		expect(loaded.map((skill) => skill.id)).toEqual([...SKILL_IDS]);
		for (const skill of loaded) {
			// `name` is what the directory is called and `description` is what an agent reads
			// before deciding whether this is the skill it needs, so an empty one is a skill
			// nothing routes to.
			expect(skill.name, skill.id).toBe(skill.id);
			expect(skill.description.trim(), skill.id).not.toBe('');
			expect(skill.body.trim().length, skill.id).toBeGreaterThan(200);
			expect(skill.path, skill.id).toBe(skillPath(skill.id));
			// The body starts after the closing delimiter, so a loader that returned the whole
			// file would hand an agent the front matter as instructions.
			expect(skill.body.startsWith('---'), skill.id).toBe(false);
		}
	});

	test('SKILL_IDS is the directory listing, in both directions', () => {
		const onDisk = readdirSync(skillsRoot(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();

		// One direction catches a skill added to disk that no command can serve, because
		// `SKILL_IDS` is what `docs_skills` advertises as an enum. The other catches an id
		// with no directory, which throws at the first call.
		expect(onDisk).toEqual([...SKILL_IDS].sort());
		for (const name of onDisk) expect(isSkillId(name), name).toBe(true);
		for (const id of SKILL_IDS) expect(statSync(skillPath(id)).isFile(), id).toBe(true);
	});

	test('every taughtBy on a command names one of them', async () => {
		// The registry is the other side of the same list. A command taught by an id that
		// does not load is a command an agent is told to read about and cannot.
		const { COMMANDS } = await import('../../src/registry/index.js');
		for (const command of COMMANDS) {
			expect(command.taughtBy.length, command.name).toBeGreaterThan(0);
			for (const id of command.taughtBy) expect(isSkillId(id), `${command.name}: ${id}`).toBe(true);
		}
	});
});

describe('the command', () => {
	test('with no id returns all five bodies and an index a person can read', async () => {
		const out = await invoke(skills, {}, ctx());
		const data = out.data as { skills: { id: string; description: string; body: string }[] };

		expect(data.skills.map((skill) => skill.id)).toEqual([...SKILL_IDS]);
		for (const skill of data.skills) expect(skill.body.trim()).not.toBe('');
		// The listing, not thirty kilobytes of markdown scrolled past a terminal. `data`
		// carries the whole text on both surfaces; only `lines` differs.
		expect(out.lines[0]).toContain(`${SKILL_IDS.length} skill(s)`);
		for (const id of SKILL_IDS)
			expect(
				out.lines.some((line) => line.includes(id)),
				id,
			).toBe(true);
		expect(out.rows).toEqual([]);
		expect(out.envelope).toBeNull();
	});

	test('with an id returns that one, and its lines are the body', async () => {
		const out = await invoke(skills, { id: 'docs-diagnose' }, ctx());
		const data = out.data as { skills: { id: string; body: string }[] };

		expect(data.skills.map((skill) => skill.id)).toEqual(['docs-diagnose']);
		expect(out.lines.join('\n')).toBe(loadSkill('docs-diagnose').body);
	});

	test('reads the file fresh on every call rather than caching it', () => {
		// Under `hexdocs mcp` the process outlives an editing session, so a cache would
		// answer with the text the server started with while the file on disk says something
		// else. Two loads of the same file are two reads: the first is compared with the
		// bytes on disk so that a cache seeded at import time cannot satisfy this.
		const first = loadSkill(ANY_ID);
		const source = readFileSync(skillPath(ANY_ID), 'utf8');
		expect(source).toContain(first.description);
		expect(loadSkill(ANY_ID)).not.toBe(first);
	});
});

/**
 * One refused front matter block, with the construct the message has to name.
 *
 * `scalar` is filled in when the case is a bare scalar, so the sweep below can match it
 * against the reader's own refusal patterns. A case with no `scalar` is refused by the
 * block structure rather than by a value.
 */
interface Refusal {
	readonly what: string;
	readonly source: string;
	readonly names: string;
	readonly scalar?: string;
}

const OPEN = '---';

function block(...lines: string[]): string {
	return [OPEN, ...lines, OPEN, '', 'A body, so the body check is not what refuses this.', ''].join(
		'\n',
	);
}

const REFUSALS: readonly Refusal[] = [
	{
		what: 'no front matter at all',
		source: '# A skill with no header\n\nSomething.\n',
		names: 'delimiter',
	},
	{
		what: 'front matter that is never closed',
		source: `${OPEN}\nname: docs-diagnose\ndescription: A description.\n\n# Body\n`,
		names: 'never closed',
	},
	{
		what: 'a key declared twice',
		source: block('name: docs-diagnose', 'description: One.', 'description: Two.'),
		names: 'declared twice',
	},
	{
		what: 'a key with no value and no list',
		source: block('name: docs-diagnose', 'description:'),
		names: 'no value and no list',
	},
	{
		what: 'a list item with no key above it',
		source: block('  - orphaned', 'name: docs-diagnose', 'description: One.'),
		names: 'list item with no key',
	},
	{
		what: 'a list item under a key that already has a scalar',
		source: block('name: docs-diagnose', 'description: One.', '  - two'),
		names: 'already has a scalar value',
	},
	{
		what: 'a line that is neither a key nor a list item',
		source: block('name: docs-diagnose', 'description: One.', 'a continuation line'),
		names: 'neither',
	},
	{
		what: 'an unterminated double-quoted scalar',
		source: block('name: docs-diagnose', 'description: "One.'),
		names: 'unterminated double-quoted scalar',
	},
	{
		what: 'a quote inside a double-quoted scalar',
		source: block('name: docs-diagnose', 'description: "One "two" three"'),
		names: 'quote inside a double-quoted scalar',
	},
	{
		what: 'a backslash inside a double-quoted scalar',
		source: block('name: docs-diagnose', 'description: "One \\n two"'),
		names: 'backslash inside a double-quoted scalar',
	},
	{
		what: 'a colon and a space in a bare scalar',
		source: block('name: docs-diagnose', 'description: Use when: something is wrong.'),
		names: 'colon followed by a space',
		scalar: 'Use when: something is wrong.',
	},
	{
		what: 'a single-quoted scalar',
		source: block('name: docs-diagnose', "description: 'One.'"),
		names: 'single-quoted scalar',
		scalar: "'One.'",
	},
	{
		what: 'a flow sequence',
		source: block('name: docs-diagnose', 'description: [one, two]'),
		names: 'flow sequence',
		scalar: '[one, two]',
	},
	{
		what: 'a flow mapping',
		source: block('name: docs-diagnose', 'description: {one: two}'),
		names: 'flow mapping',
		scalar: '{one: two}',
	},
	{
		what: 'an anchor',
		source: block('name: docs-diagnose', 'description: &anchor One.'),
		names: 'anchor',
		scalar: '&anchor One.',
	},
	{
		what: 'an alias',
		source: block('name: docs-diagnose', 'description: *anchor'),
		names: 'alias',
		scalar: '*anchor',
	},
	{
		what: 'a block scalar indicator',
		source: block('name: docs-diagnose', 'description: |'),
		names: 'block scalar indicator',
		scalar: '|',
	},
	{
		what: 'a folded block scalar indicator',
		source: block('name: docs-diagnose', 'description: > One.'),
		names: 'block scalar indicator',
		scalar: '> One.',
	},
	{
		what: 'a reserved indicator character',
		source: block('name: docs-diagnose', 'description: !tag One.'),
		names: 'YAML indicator character',
		scalar: '!tag One.',
	},
	{
		what: 'a value that opens with a comment',
		source: block('name: docs-diagnose', 'description: # One.'),
		names: 'reads as a comment',
		scalar: '# One.',
	},
	{
		what: 'a trailing comment',
		source: block('name: docs-diagnose', 'description: One. # and a note'),
		names: 'trailing comment',
		scalar: 'One. # and a note',
	},
	{
		what: 'front matter with no body',
		source: `${OPEN}\nname: docs-diagnose\ndescription: One.\n${OPEN}\n\n\n`,
		names: 'no body',
	},
	{
		what: 'a missing description',
		source: block('name: docs-diagnose'),
		names: '`description`',
	},
	{
		what: 'a name that is a boolean rather than a string',
		source: block('name: true', 'description: One.'),
		names: '`name`',
	},
	{
		// A present key whose value is nothing but spaces is the case an absent key does not
		// cover: it is a string, so a check on the type alone lets it through and the tool
		// returns a skill an agent cannot choose between.
		what: 'a description that is only whitespace',
		source: block('name: docs-diagnose', 'description: "  "'),
		names: '`description`',
	},
];

const PATH = '/skills/example/SKILL.md';

describe('the front matter reader refuses by name', () => {
	test('the well formed control parses, so the table is not refusing everything', () => {
		const parsed = parseSkill(
			block('name: docs-diagnose', 'description: A real description.'),
			'docs-diagnose',
			PATH,
		);
		expect(parsed.name).toBe('docs-diagnose');
		expect(parsed.description).toBe('A real description.');
		expect(parsed.body.trim()).toBe('A body, so the body check is not what refuses this.');
	});

	test('a list value is read, since one key in this grammar may have one', () => {
		const parsed = parseSkill(
			block(
				'name: docs-diagnose',
				'description: A real description.',
				'allowed-tools:',
				'  - Read',
			),
			'docs-diagnose',
			PATH,
		);
		// Claude Code's own front matter carries `allowed-tools`, and nothing here reads it.
		// The pattern accepts a hyphen in a key so that a skill declaring one is loadable
		// rather than refused for a key this reader does not care about.
		expect(parsed.description).toBe('A real description.');
	});

	for (const refusal of REFUSALS) {
		test(`refuses ${refusal.what}`, () => {
			let thrown: unknown;
			try {
				parseSkill(refusal.source, ANY_ID, PATH);
			} catch (error) {
				thrown = error;
			}

			expect(thrown, refusal.what).toBeInstanceOf(SkillError);
			const message = (thrown as Error).message;
			// The path is in every message because the resolution is the thing most likely to
			// be wrong: it is relative to the loader module, not to the working directory.
			expect(message, refusal.what).toContain(PATH);
			expect(message, refusal.what).toContain(refusal.names);
			// A refusal that only says no is a refusal an author cannot act on, so each one
			// carries the fix as a second sentence.
			expect(message.length, refusal.what).toBeGreaterThan(80);
		});
	}
});

describe('the refusal table is swept against the reader own patterns', () => {
	/**
	 * The bare-scalar refusal patterns, read out of the module rather than copied.
	 *
	 * `BARE_SCALAR_REFUSALS` is private, which is right: nothing outside the loader has any
	 * business testing a value against it. Reading the source is what makes this check run
	 * in both directions anyway. A list written down here would be satisfied by itself, and
	 * an arm added to the reader with no case in `REFUSALS` would be an unfired refusal with
	 * a green suite, which is the failure `rules-fire.test.ts` exists to stop one directory
	 * over.
	 */
	function declaredPatterns(): RegExp[] {
		const source = readFileSync(
			fileURLToPath(new URL('../../src/skills/load.ts', import.meta.url)),
			'utf8',
		);
		const start = source.indexOf('const BARE_SCALAR_REFUSALS');
		expect(start, 'BARE_SCALAR_REFUSALS moved or was renamed').toBeGreaterThan(-1);
		const end = source.indexOf('\n];', start);
		expect(end, 'the refusal table is no longer a closed array literal').toBeGreaterThan(start);
		const block = source.slice(start, end);
		return [...block.matchAll(/pattern: \/(.+?)\/,/g)].map(
			(match) => new RegExp(match[1] as string),
		);
	}

	test('every declared bare-scalar pattern has a case that trips it', () => {
		const patterns = declaredPatterns();
		expect(patterns.length).toBeGreaterThan(5);

		const scalars = REFUSALS.map((refusal) => refusal.scalar).filter(
			(scalar): scalar is string => scalar !== undefined,
		);
		for (const pattern of patterns) {
			expect(
				scalars.some((scalar) => pattern.test(scalar)),
				`no case in REFUSALS trips ${pattern.source}`,
			).toBe(true);
		}
	});

	test('and every scalar case really is refused by one of them', () => {
		const patterns = declaredPatterns();
		for (const refusal of REFUSALS) {
			if (refusal.scalar === undefined) continue;
			expect(
				patterns.some((pattern) => pattern.test(refusal.scalar as string)),
				`${refusal.what} is not refused by any declared pattern, so it is testing something else`,
			).toBe(true);
		}
	});
});

describe('a skill that is not on disk', () => {
	test('throws naming the path the loader looked at', () => {
		// A broken install rather than a bad call: answering with four skills and no
		// complaint hands an agent an incomplete instruction set that looks complete.
		expect(() => loadSkill('not-a-skill' as SkillId)).toThrow(SkillError);
		try {
			loadSkill('not-a-skill' as SkillId);
		} catch (error) {
			expect((error as Error).message).toContain(skillsRoot());
			expect((error as Error).message).toContain('broken install');
		}
	});
});
