/**
 * The five bundled skills, read off disk.
 *
 * The path is resolved from `import.meta.url` and never from the working directory.
 * `bin/hexdocs` deliberately does not cd into the kit, so `$PWD` during `hexdocs skills`
 * is hex-nfc or hex-web, and a loader that joined `.claude/skills` onto the working
 * directory would look for the skills in the repository that has none and answer that
 * there are none. `cli/main.ts` reads the toolchain's own version the same way and for
 * the same reason.
 *
 * A missing or unreadable file throws. The skills ship with this package, so their
 * absence is a broken install rather than a bad call, and the alternative is worse than
 * an exception: answering with four skills and no complaint hands an agent an incomplete
 * instruction set that looks complete. That matters most in exactly the repository this
 * command exists for. hex-nfc gitignores `.claude/` by policy, so MCP is the only route
 * to a skill there and there is no second copy to notice the gap against.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SKILL_IDS, type SkillId } from './ids.js';

/**
 * A skill as the loader read it.
 *
 * `name` is carried even though `docs_skills` does not return it, because the check that
 * it equals the directory name belongs in `kit/test/skills.test.ts`, where the failure
 * can name the directory and the file together. Refusing a mismatch here would take the
 * whole tool down at runtime for something a build-time assertion catches, and nothing
 * that reads a skill through this loader keys off `name`: the id is the directory.
 */
export interface LoadedSkill {
	readonly id: SkillId;
	readonly name: string;
	readonly description: string;
	/** Everything after the closing front matter delimiter. */
	readonly body: string;
	readonly path: string;
}

/** A skill file this loader will not read, with the reason in the message. */
export class SkillError extends Error {}

/**
 * `<repository root>/.claude/skills/`.
 *
 * Three levels up from `kit/src/skills/`, which is the same arithmetic `cli/main.ts`
 * does two levels up from `kit/src/cli/` to reach `kit/package.json`. Exported so the
 * skills test can list the directory and compare it against `SKILL_IDS` in both
 * directions without repeating the resolution and getting it half right.
 */
export function skillsRoot(): string {
	return fileURLToPath(new URL('../../../.claude/skills/', import.meta.url));
}

export function skillPath(id: SkillId): string {
	return join(skillsRoot(), id, 'SKILL.md');
}

const DELIMITER = '---';

/**
 * A key line and a list item.
 *
 * A hyphen is allowed in a key here and is not in the compiler's reader, because Claude
 * Code's own skill front matter uses `allowed-tools`. Nothing below reads that key; the
 * pattern accepts it so that a skill declaring one is loadable rather than refused for a
 * key this loader does not care about.
 */
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/;
const LIST_ITEM = /^[ \t]+-[ \t]+(.*)$/;

interface Refusal {
	readonly pattern: RegExp;
	/** What YAML does with it, so the author's next question is already answered. */
	readonly what: string;
	readonly fix: string;
}

const QUOTE_IT = 'Wrap the value in double quotes, or rewrite it without that character.';

const WRITE_IT_OUT = 'Write the value out. This reader resolves nothing for you.';

/**
 * Everything a bare scalar may not contain.
 *
 * The first match wins, for the reason the compiler's reader gives: a value that trips
 * three of these has one mistake in it.
 *
 * The colon-and-space entry is the one that will actually be hit, and it is worth knowing
 * before writing a skill: a `description` reading `Use when: something` is a YAML error
 * rather than a string, so it has to be double quoted. Accepting it here would mean this
 * reader and every real YAML parser disagreed about the front matter of a file Claude
 * Code itself loads.
 */
const BARE_SCALAR_REFUSALS: readonly Refusal[] = [
	{
		pattern: /^'/,
		what: 'is a single-quoted scalar, which YAML reads with its own doubling rule for a quote inside',
		fix: 'Use a double-quoted scalar, which is the only quoting this reader implements.',
	},
	{
		pattern: /^\[/,
		what: 'opens a flow sequence, which YAML reads as an inline list',
		fix: 'Write the list as indented `- item` lines under the key.',
	},
	{
		pattern: /^\{/,
		what: 'opens a flow mapping, which YAML reads as a nested map',
		fix: 'Skill front matter is one level deep here. There is nowhere for a nested map to go.',
	},
	{
		pattern: /^&/,
		what: 'opens an anchor, which YAML records for a later alias to reuse',
		fix: WRITE_IT_OUT,
	},
	{
		pattern: /^\*/,
		what: 'is an alias, which YAML replaces with the value of the anchor it names',
		fix: WRITE_IT_OUT,
	},
	{
		pattern: /^[|>]/,
		what:
			'opens with a block scalar indicator, which YAML reads as a value carrying on over the ' +
			'lines below it',
		fix: 'Write the value on one line.',
	},
	{
		pattern: /^[!%@`]/,
		what:
			'opens with a YAML indicator character, which YAML reserves for tags, directives and ' +
			'its own future use',
		fix: QUOTE_IT,
	},
	{
		pattern: /:\s/,
		what: 'contains a colon followed by a space, which YAML reads as a nested mapping',
		fix: QUOTE_IT,
	},
	{
		pattern: /^#/,
		what: 'opens with a #, which YAML reads as a comment, leaving the key with no value at all',
		fix: QUOTE_IT,
	},
	{
		pattern: /\s#/,
		what: 'contains a # after whitespace, which YAML reads as a trailing comment and drops',
		fix: QUOTE_IT,
	},
];

function refuse(path: string, line: number, what: string, fix: string): never {
	throw new SkillError(`${path}:${line}: ${what} ${fix}`);
}

/**
 * One scalar: `true`, `false`, a double-quoted string with no escapes, or a bare string.
 *
 * A bare `true` inside a list stays a string, which is what the compiler's reader does
 * with the same shape. Nothing here narrows a value's type beyond that: `loadSkill` is
 * where `name` and `description` are required to be non-empty strings, and a reader that
 * decided which keys were strings would be a second, weaker schema sitting where nothing
 * compares it against the first.
 */
function readScalar(text: string, path: string, line: number): string | boolean {
	if (text === 'true') return true;
	if (text === 'false') return false;

	if (text.startsWith('"')) {
		if (text.length < 2 || !text.endsWith('"')) {
			refuse(
				path,
				line,
				`${JSON.stringify(text)} is an unterminated double-quoted scalar. YAML carries on past the end of the line looking for the closing quote and takes the lines below it into the value.`,
				'Close the quote, or drop both quotes and write a bare scalar.',
			);
		}
		const inner = text.slice(1, -1);
		if (inner.includes('"')) {
			refuse(
				path,
				line,
				`${JSON.stringify(text)} has a quote inside a double-quoted scalar. YAML needs it escaped, and this reader implements no escapes, so the two would disagree about the value.`,
				'Escape nothing and quote nothing: write the value bare, or reword it.',
			);
		}
		if (inner.includes('\\')) {
			refuse(
				path,
				line,
				`${JSON.stringify(text)} has a backslash inside a double-quoted scalar. YAML expands escapes there and this reader does not, so the two would disagree about the value.`,
				'Write the value bare, where a backslash is a backslash.',
			);
		}
		return inner;
	}

	for (const refusal of BARE_SCALAR_REFUSALS) {
		if (!refusal.pattern.test(text)) continue;
		refuse(path, line, `${JSON.stringify(text)} ${refusal.what}.`, refusal.fix);
	}

	return text;
}

interface FrontMatter {
	readonly data: Readonly<Record<string, string | boolean | string[]>>;
	readonly body: string;
}

/**
 * The front matter block and the body.
 *
 * This is a second narrow reader, and the duplication with `kit/src/compile/frontmatter.ts`
 * is deliberate rather than an oversight.
 *
 * That one refuses `FORBIDDEN_FRONT_MATTER_KEYS`, which are page concerns: `slug` is
 * refused because the slug is the filename, `date` because dates come from git. Neither
 * sentence means anything about a skill, and sharing the table would make a change to
 * what a documentation page may declare change what a skill may declare. That one also
 * reports through `RawFinding` and `runLint`, which is right for an author's mistake in a
 * tree being linted and wrong here: there is no page to attach a finding to, no locale,
 * and a skill that will not parse is a broken install rather than a documentation
 * problem.
 *
 * What the duplication costs, stated rather than glossed over: two readers over the same
 * grammar can drift apart. The bound is that this one reads five files that live in this
 * repository, and `kit/test/skills.test.ts` reads all five through it. It refuses
 * everything it is not certain of rather than guessing, so a drift shows up as a refusal
 * naming a construct, not as a value the two readers disagree about.
 *
 * The subset: `key: scalar`, and `key:` followed by indented `- item` lines. Nothing
 * nested, no block scalars, no flow collections, no anchors, no comments.
 */
function readFrontMatter(source: string, path: string): FrontMatter {
	const lines = source.split(/\r?\n/);

	if (lines[0] !== DELIMITER) {
		refuse(
			path,
			1,
			`The file does not open with a ${DELIMITER} delimiter, so it has no front matter. YAML is read between the delimiters and nowhere else, so the skill has no name and no description.`,
			'Open the file with a front matter block declaring a name and a description.',
		);
	}

	const close = lines.indexOf(DELIMITER, 1);
	if (close === -1) {
		refuse(
			path,
			1,
			`The front matter opens on line 1 and is never closed. YAML would read the rest of the file as front matter, so the skill would be all header and no body.`,
			`Close the block with a ${DELIMITER} line.`,
		);
	}

	const data: Record<string, string | boolean | string[]> = {};
	const lists = new Map<string, string[]>();
	let current: string | undefined;

	for (let index = 1; index < close; index += 1) {
		const line = lines[index] as string;
		const lineNumber = index + 1;
		if (line.trim() === '') continue;

		const item = LIST_ITEM.exec(line);
		if (item !== null) {
			if (current === undefined) {
				refuse(
					path,
					lineNumber,
					`${JSON.stringify(line.trim())} is a list item with no key above it. YAML reads a sequence where the block expects a mapping key, and refuses the document.`,
					'Put the item under a key, indented beneath it.',
				);
			}
			const list = lists.get(current);
			if (list === undefined) {
				refuse(
					path,
					lineNumber,
					`\`${current}\` already has a scalar value, so the list item below it has nothing to attach to. YAML refuses a mapping whose value is a scalar and a sequence at once.`,
					`Either give \`${current}\` a scalar or give it a list, not both.`,
				);
			}
			list.push(String(readScalar((item[1] as string).trim(), path, lineNumber)));
			continue;
		}

		const entry = KEY_LINE.exec(line);
		if (entry === null) {
			refuse(
				path,
				lineNumber,
				`${JSON.stringify(line)} is neither a \`key: value\` line nor a \`- item\` line. YAML would either fold it into the value above it as a plain scalar carrying on over several lines, or refuse the document, and this reader guesses at neither.`,
				'Write it as a key with a value, or indent it as an item under the key above.',
			);
		}

		const key = entry[1] as string;
		const text = (entry[2] as string).trim();

		// `Object.hasOwn` rather than `in` or a bare index, for the reason the compiler's
		// reader gives: `in` finds `constructor` on the prototype and reports a first
		// declaration that is not there.
		if (Object.hasOwn(data, key)) {
			refuse(
				path,
				lineNumber,
				`\`${key}\` is declared twice. YAML forbids a duplicate key, and the parsers that allow one keep the last and silently discard the first.`,
				'Delete one of them.',
			);
		}

		if (text === '') {
			const next = lines.slice(index + 1, close).find((candidate) => candidate.trim() !== '');
			if (next === undefined || LIST_ITEM.exec(next) === null) {
				refuse(
					path,
					lineNumber,
					`\`${key}\` has no value and no list under it. YAML reads that as null, and this reader will not guess between null and an empty list.`,
					`Give \`${key}\` a value, or indented \`- item\` lines, or delete it.`,
				);
			}
			const list: string[] = [];
			lists.set(key, list);
			data[key] = list;
			current = key;
			continue;
		}

		data[key] = readScalar(text, path, lineNumber);
		current = key;
	}

	const after = lines.slice(close + 1);
	// One blank line after the closing delimiter is the convention every skill follows and
	// it is not part of the body. Removing exactly one keeps a deliberate second blank
	// line, which is the same rule the compiler's reader applies to a page.
	const body = (after[0] === '' ? after.slice(1) : after).join('\n');

	return { data, body };
}

/** A front matter value that has to be a non-empty string, or a refusal naming the key. */
function requireText(
	data: Readonly<Record<string, string | boolean | string[]>>,
	key: string,
	path: string,
): string {
	const value = data[key];
	if (typeof value !== 'string' || value.trim() === '') {
		throw new SkillError(
			`${path}: the front matter has no usable \`${key}\`. It must be a non-empty string: it is what an agent reads before deciding whether this skill is the one it needs.`,
		);
	}
	return value;
}

/**
 * Everything `loadSkill` does except read the file.
 *
 * Split out so the refusals above are reachable from a test with a string, which is the
 * difference between a covered refusal table and a decorative one: the five files on disk
 * are all well formed, so driving this through `loadSkill` alone would exercise the happy
 * path and leave every arm of `BARE_SCALAR_REFUSALS` untested. The `path` is a parameter
 * rather than derived from `id` for the same reason, so a test can name a file that does
 * not exist and still assert the message points at it.
 */
export function parseSkill(source: string, id: SkillId, path: string): LoadedSkill {
	const { data, body } = readFrontMatter(source, path);
	if (body.trim() === '') {
		throw new SkillError(
			`${path} has front matter and no body. A skill with nothing after the front matter teaches nothing, and it would be returned by \`docs_skills\` looking exactly like one that does.`,
		);
	}

	return {
		id,
		name: requireText(data, 'name', path),
		description: requireText(data, 'description', path),
		body,
		path,
	};
}

export function loadSkill(id: SkillId): LoadedSkill {
	const path = skillPath(id);

	let source: string;
	try {
		source = readFileSync(path, 'utf8');
	} catch (error) {
		// The path is in the message because the resolution is the thing most likely to be
		// wrong: it is relative to this module, not to the working directory, so a reader
		// looking for the file needs to be told where the loader actually looked.
		throw new SkillError(
			`No readable skill file at ${path}. The five skills ship with this package, so an absent one is a broken install rather than a mistake in the call. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	return parseSkill(source, id, path);
}

/** All five, in `SKILL_IDS` order, so two callers cannot get two orderings. */
export function loadAllSkills(): LoadedSkill[] {
	return SKILL_IDS.map((id) => loadSkill(id));
}
