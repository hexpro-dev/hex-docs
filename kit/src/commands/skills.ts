/**
 * `hexdocs skills` / `docs_skills`: the bundled instructions, as text.
 *
 * One tool rather than the two the original design carried (`list_skills` and
 * `get_skill`), and the reason is arithmetic rather than taste. The whole set is a few
 * thousand tokens, so a listing call followed by a fetch call spends a round trip to save
 * nothing an agent then has to spend anyway. Splitting them would also put a decision in
 * front of the caller, which is the decision this command exists to remove.
 *
 * It exists at all because of hex-nfc. `.claude/` is gitignored there by policy, so the
 * skills wiring cannot be committed and an agent working in that repository has no local
 * copy of any of this. `.mcp.json` can be committed, so MCP is the only route to a skill,
 * and a documentation toolchain whose instructions are unreachable from the one repository
 * it was built for would be a toolchain nobody uses correctly.
 *
 * The bodies are read fresh on every call rather than cached. Under `hexdocs mcp` the
 * process outlives an editing session, and a cache would answer with the text the server
 * started with while the file on disk says something else.
 */

import type { JsonValue } from '../compile/serialise.js';
import { defineCommand } from '../registry/command.js';
import { SKILL_IDS } from '../skills/ids.js';
import { loadAllSkills, loadSkill } from '../skills/load.js';

export const skills = defineCommand({
	name: 'skills',
	tool: 'docs_skills',
	writes: 'nothing',
	summary: 'Return the bundled hexdocs skills: the instructions for using this toolchain.',
	detail:
		'The bundled skills, as markdown: docs-init-source (set a documentation tree up in an app repository), docs-authoring (write, translate, illustrate and review a page), docs-install-site (wire a consuming website), docs-publish-version (build, publish and label a version) and docs-diagnose (work out what is broken). Call it with no id to get all of them, or with one id for that skill alone. This is the only route to these instructions in a repository whose .claude directory is not committed.',
	params: {
		id: {
			help: 'one skill instead of all five',
			type: 'string',
			// `SKILL_IDS` goes in with no cast, unlike `LOCALES` and `FINDING_CATEGORIES`
			// elsewhere, because it is already a tuple of string literals. That is what lets
			// `input.id` arrive as a `SkillId` rather than a `string`, so `loadSkill` needs no
			// cast and an id this package does not ship cannot reach it. It also becomes an
			// enum in the JSON Schema, so a model that guesses gets a schema violation rather
			// than an empty answer.
			values: SKILL_IDS,
		},
	},
	positionals: ['id'],
	// Both of these are read by an agent that has no local skills directory, which is what
	// this command answers. `kit/test/skills.test.ts` checks the claim in both directions,
	// so each of these two bodies has to mention the command or the tool by name.
	taughtBy: ['docs-install-site', 'docs-init-source'],
	async run(input) {
		// The one skill is held separately from the list rather than read back out of it,
		// so the branch below needs no index and no non-null assertion to know it is there.
		const one = input.id === undefined ? undefined : loadSkill(input.id);
		const loaded = one === undefined ? loadAllSkills() : [one];

		// `data` always carries the whole body, on both surfaces. `lines` is where the two
		// readers differ, and they differ in one place only: a person who asked for all five
		// gets the index, because thirty kilobytes of markdown scrolled past a terminal is
		// not a listing. An agent asked for the text and gets the text.
		const data: JsonValue = {
			skills: loaded.map((skill) => ({
				id: skill.id,
				description: skill.description,
				body: skill.body,
			})),
		};

		const lines =
			one === undefined
				? [
						`${loaded.length} skill(s).`,
						'',
						...loaded.map((skill) => `  ${skill.id}  ${skill.description}`),
						'',
						'Run `hexdocs skills <id>` for the whole text of one.',
					]
				: one.body.split('\n');

		return { data, lines, envelope: null, rows: [] };
	},
});
