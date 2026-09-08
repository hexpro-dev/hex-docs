/**
 * Every command, tool and flag a bundled skill names, validated against the registry.
 *
 * A skill is instructions an agent follows without checking them, in a repository whose
 * `.claude/` is gitignored and where MCP is the only route to the text. A renamed flag in
 * a skill is therefore not a documentation defect: it is an agent running a command that
 * exits 2 and then deciding what to do about a usage error it was told to expect nothing
 * of. So the registry is the authority and the prose is checked against it, in both
 * directions, and nothing here is satisfied by a sentence saying a skill covers something.
 *
 * **The unfenced-mention rule is what makes the rest mean anything.** Without it the
 * guarantee is "every command we can see is real", and that is satisfied by seeing none:
 * move an invocation out of its fence and into a paragraph and the validator has nothing
 * to validate while the skill goes on teaching it. So a bare `hexdocs ` or `docs_` token
 * anywhere in a body has to be inside a fence or an inline code span, and it is validated
 * wherever it is.
 *
 * **The honest limit.** This proves every token a skill names exists: the command, the
 * tool, the flag, the closed-set value. It proves nothing about the sequence. A skill that
 * told an agent to publish before building would pass every assertion in this file, and
 * nothing in this repository checks that. The front matter is also outside the mention
 * rule, deliberately: `description` is the sentence an agent reads to decide whether the
 * skill applies at all, it carries no fences, and `docs-diagnose` legitimately says "any
 * hexdocs command" there, which is prose about the toolchain rather than an invocation.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { BY_NAME, BY_TOOL, COMMANDS } from '../../src/registry/index.js';
import type { AnyCommand } from '../../src/registry/command.js';
import { DISPATCHER_TOKENS } from '../../src/cli/args.js';
import { SKILL_IDS, type SkillId } from '../../src/skills/ids.js';
import { loadSkill, skillsRoot } from '../../src/skills/load.js';

const SKILLS = SKILL_IDS.map((id) => ({ id, loaded: loadSkill(id) }));

// ---------------------------------------------------------------------------
// Reading a skill body
// ---------------------------------------------------------------------------

interface FencedLine {
	readonly skill: SkillId;
	/** The info string of the fence this line is in. */
	readonly lang: string;
	readonly text: string;
	/** 1-based, within the body, which is what a reader counts from the top of the file. */
	readonly line: number;
}

interface Body {
	readonly skill: SkillId;
	readonly fenced: FencedLine[];
	/** Every line outside a fence, with its inline code spans pulled out. */
	readonly prose: { text: string; line: number; spans: string[] }[];
}

function readBody(skill: SkillId, body: string): Body {
	const fenced: FencedLine[] = [];
	const prose: Body['prose'] = [];
	let lang: string | null = null;

	body.split('\n').forEach((text, index) => {
		const line = index + 1;
		const fence = /^```(.*)$/.exec(text);
		if (fence !== null) {
			// A fence opens with an info string and closes with a bare one. Nothing here
			// supports an indented fence, and neither does any skill in the set.
			lang = lang === null ? (fence[1] as string).trim() : null;
			return;
		}
		if (lang !== null) {
			fenced.push({ skill, lang, text, line });
			return;
		}
		prose.push({
			text,
			line,
			spans: [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string),
		});
	});

	return { skill, fenced, prose };
}

const BODIES = SKILLS.map(({ id, loaded }) => readBody(id, loaded.body));

// ---------------------------------------------------------------------------
// Reading one invocation
// ---------------------------------------------------------------------------

/** Whitespace separated, with double-quoted runs kept whole. */
function tokenise(line: string): string[] {
	return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map(
		(match) => (match[1] ?? match[2] ?? '') as string,
	);
}

/** A value a skill wrote as a placeholder rather than as a real argument. */
function isPlaceholder(value: string | undefined): boolean {
	return value === undefined || value.startsWith('<') || value.startsWith('$');
}

/**
 * Everything wrong with one `hexdocs ...` line, as sentences.
 *
 * The walk mirrors `parseArgs`: a `--flag` whose parameter is not boolean consumes the
 * token after it, so what is left over is the positionals. Doing it any other way reads
 * `--category house-style` as a flag and a positional and then reports `hexdocs check` as
 * taking an argument it does not take.
 */
function problemsInCli(line: string): string[] {
	const tokens = tokenise(line);
	if (tokens[0] !== 'hexdocs') {
		return [`"${line}" is inside a hexdocs-cli fence and is not a hexdocs invocation.`];
	}
	const name = tokens[1];
	if (name === undefined) return [`"${line}" names no command.`];
	const command = BY_NAME.get(name);
	if (command === undefined) {
		return [`"${line}" names "${name}", which is not a command in the registry.`];
	}

	const problems: string[] = [];
	const positionals: string[] = [];
	const declared = command.positionals as readonly string[];

	for (let at = 2; at < tokens.length; at += 1) {
		const token = tokens[at] as string;
		if (!token.startsWith('--')) {
			positionals.push(token);
			continue;
		}
		const [flag, inline] = token.slice(2).split('=', 2) as [string, string | undefined];
		if ((DISPATCHER_TOKENS as readonly string[]).includes(token)) continue;
		const param = command.params[flag];
		if (param === undefined) {
			problems.push(`"${line}": --${flag} is not a parameter of \`${name}\`.`);
			continue;
		}
		if (declared.includes(flag)) {
			// A positional passed as a flag parses, and then `--help` and the JSON Schema
			// describe a call nobody makes. The skill is what an agent copies, so it has to
			// spell the invocation the way the command declares it.
			problems.push(
				`"${line}": --${flag} is a positional of \`${name}\`, so it is written without the flag.`,
			);
		}
		let value = inline;
		if (param.type !== 'boolean' && value === undefined) {
			at += 1;
			value = tokens[at];
			if (value === undefined) {
				problems.push(`"${line}": --${flag} takes a value and none follows it.`);
				continue;
			}
		}
		if (param.values !== undefined && !isPlaceholder(value)) {
			if (!param.values.includes(value as string)) {
				problems.push(
					`"${line}": --${flag} is ${JSON.stringify(value)}, which is not one of ${param.values.join(', ')}.`,
				);
			}
		}
	}

	if (positionals.length > declared.length) {
		problems.push(
			`"${line}" passes ${positionals.length} positional(s) and \`${name}\` takes ${declared.length}.`,
		);
	}
	positionals.forEach((value, index) => {
		const param = command.params[declared[index] as string];
		if (param?.values === undefined || isPlaceholder(value)) return;
		if (!param.values.includes(value)) {
			problems.push(
				`"${line}": ${JSON.stringify(value)} is not one of ${param.values.join(', ')} for \`${name}\`.`,
			);
		}
	});

	return problems;
}

/** Everything wrong with one `docs_tool {json}` line. */
function problemsInMcp(line: string): string[] {
	const at = line.indexOf('{');
	const tool = (at === -1 ? line : line.slice(0, at)).trim();
	const command = BY_TOOL.get(tool);
	if (command === undefined) {
		return [`"${line}" names "${tool}", which is not a tool in the registry.`];
	}
	if (at === -1) return [`"${line}" names a tool with no argument object.`];

	let args: unknown;
	try {
		args = JSON.parse(line.slice(at));
	} catch (error) {
		return [`"${line}" carries an argument object that is not JSON: ${(error as Error).message}`];
	}
	if (typeof args !== 'object' || args === null || Array.isArray(args)) {
		return [`"${line}" carries an argument value that is not an object.`];
	}
	return Object.keys(args)
		.filter((key) => command.params[key] === undefined)
		.map((key) => `"${line}": "${key}" is not a parameter of \`${tool}\`.`);
}

/** Whether a body names a command, by its CLI name or by its tool name. */
function mentions(body: Body, command: AnyCommand): boolean {
	const cli = new RegExp(`hexdocs\\s+${command.name}(?![\\w-])`);
	const tool = command.tool === null ? null : new RegExp(`${command.tool}(?![\\w])`);
	const lines = [
		...body.fenced.map((entry) => entry.text),
		...body.prose.flatMap((entry) => entry.spans),
	];
	return lines.some((text) => cli.test(text) || (tool !== null && tool.test(text)));
}

// ---------------------------------------------------------------------------

describe('the skill set', () => {
	test('SKILL_IDS is exactly the directory listing, in both directions', () => {
		const onDisk = readdirSync(skillsRoot(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		expect(onDisk).toEqual([...SKILL_IDS].sort());

		// And each directory really holds the file the loader looks for, so a renamed
		// SKILL.md fails here rather than at runtime in the one repository that has no
		// second copy of these instructions to notice the gap against.
		for (const id of SKILL_IDS) {
			expect(readdirSync(join(skillsRoot(), id))).toContain('SKILL.md');
		}
	});

	test('each skill has a body with something in it', () => {
		// The sweeps below all iterate over parsed bodies, so an empty one would make every
		// one of them pass over nothing.
		for (const body of BODIES) {
			expect(
				body.fenced.length + body.prose.length,
				`${body.skill} parsed as nothing`,
			).toBeGreaterThan(0);
		}
		expect(BODIES.some((body) => body.fenced.length > 0)).toBe(true);
	});
});

describe('every invocation inside a fence resolves', () => {
	const cli = BODIES.flatMap((body) =>
		body.fenced.filter((entry) => entry.lang === 'hexdocs-cli' && entry.text.trim() !== ''),
	);
	const mcp = BODIES.flatMap((body) =>
		body.fenced.filter((entry) => entry.lang === 'hexdocs-mcp' && entry.text.trim() !== ''),
	);

	test('there are fences of both kinds to check', () => {
		expect(cli.length).toBeGreaterThan(0);
		expect(mcp.length).toBeGreaterThan(0);
	});

	test('every hexdocs-cli line names a real command with real flags', () => {
		const problems = cli.flatMap((entry) =>
			problemsInCli(entry.text.trim()).map((problem) => `${entry.skill}:${entry.line} ${problem}`),
		);
		expect(problems).toEqual([]);
	});

	test('every hexdocs-mcp line names a real tool with real arguments', () => {
		const problems = mcp.flatMap((entry) =>
			problemsInMcp(entry.text.trim()).map((problem) => `${entry.skill}:${entry.line} ${problem}`),
		);
		expect(problems).toEqual([]);
	});
});

describe('nothing names a command outside a fence or a code span', () => {
	test('a bare hexdocs or docs_ token in a paragraph is itself a failure', () => {
		// Moving an invocation into prose is how a skill keeps teaching a command while
		// escaping every check above it. The span requirement is also what makes the
		// resolution test below able to see the mention at all.
		const problems: string[] = [];
		for (const body of BODIES) {
			for (const entry of body.prose) {
				const outside = entry.text.replace(/`[^`]+`/g, '');
				for (const match of outside.matchAll(/hexdocs\s+\S|docs_\w/g)) {
					problems.push(
						`${body.skill}:${entry.line} names a command outside a fence and outside a code span: ${JSON.stringify(
							outside.slice(Math.max(0, (match.index ?? 0) - 20), (match.index ?? 0) + 40),
						)}`,
					);
				}
			}
		}
		expect(problems).toEqual([]);
	});

	test('every command named in an inline code span resolves in the registry', () => {
		const problems: string[] = [];
		let examined = 0;
		for (const body of BODIES) {
			for (const entry of body.prose) {
				for (const span of entry.spans) {
					const cli = /^hexdocs\s+([\w-]+)/.exec(span);
					if (cli !== null) {
						examined += 1;
						if (!BY_NAME.has(cli[1] as string)) {
							problems.push(`${body.skill}:${entry.line} \`${span}\` names no such command.`);
						}
						problems.push(
							...problemsInCli(span).map((problem) => `${body.skill}:${entry.line} ${problem}`),
						);
						continue;
					}
					const tool = /^(docs_[\w]+)/.exec(span);
					if (tool !== null) {
						examined += 1;
						if (!BY_TOOL.has(tool[1] as string)) {
							problems.push(`${body.skill}:${entry.line} \`${span}\` names no such tool.`);
						}
					}
				}
			}
		}
		expect(problems).toEqual([]);
		// A sweep that matched nothing would pass over an empty list, which is the failure
		// every count in this repository exists to refuse.
		expect(examined, 'no inline mention was examined').toBeGreaterThan(0);
	});
});

describe('taughtBy', () => {
	test('every command is taught by at least one skill, and the ids are real', () => {
		const problems: string[] = [];
		for (const command of COMMANDS) {
			if (command.taughtBy.length === 0) {
				problems.push(`${command.name} is taught by nothing, so no agent finds it.`);
			}
			if (new Set(command.taughtBy).size !== command.taughtBy.length) {
				problems.push(`${command.name} names a skill twice in taughtBy.`);
			}
			for (const id of command.taughtBy) {
				if (!(SKILL_IDS as readonly string[]).includes(id)) {
					problems.push(`${command.name} is taught by "${id}", which is not a skill.`);
				}
			}
		}
		expect(problems).toEqual([]);
	});

	test('every claimed skill really mentions the command it claims', () => {
		// The direction that catches a rename. A command renamed in the registry keeps its
		// `taughtBy` and the skills go on naming the old spelling, so the claim stays and
		// the instruction stops working.
		const problems: string[] = [];
		let claims = 0;
		for (const command of COMMANDS) {
			for (const id of command.taughtBy) {
				const body = BODIES.find((one) => one.skill === id);
				if (body === undefined) continue;
				claims += 1;
				if (!mentions(body, command)) {
					problems.push(
						`${command.name} claims to be taught by ${id}, whose body names neither \`hexdocs ${command.name}\` nor ${command.tool ?? 'a tool for it'}.`,
					);
				}
			}
		}
		expect(problems).toEqual([]);
		expect(claims).toBeGreaterThanOrEqual(COMMANDS.length);
	});

	test('every skill is named by at least one command', () => {
		// The other direction over the same relation. A skill nothing routes to is a skill
		// `--help` never mentions and an agent reaches only by listing all five.
		const claimed = new Set(COMMANDS.flatMap((command) => [...command.taughtBy]));
		const orphans = SKILL_IDS.filter((id) => !claimed.has(id));
		expect(orphans, 'no command names these skills in taughtBy').toEqual([]);
	});
});
