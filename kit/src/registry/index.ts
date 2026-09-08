/**
 * The registry: one flat array, and five things derived from it.
 *
 * The CLI dispatch map, `--help`, the MCP tool list, the MCP dispatch map and the skill
 * validator's vocabulary all come from here, and nothing is written twice. That is the
 * one idea worth keeping from the design pass this replaces, and the framework around it
 * is not: there is no `reads: ReadScope[]`, no `roles`, no `cli.render`, no `cli.exit`
 * and no JSON pointer binding a flag to a field inside a separately hand-written schema.
 * The parameter key is the field name, so the schema is derived and there is nowhere for
 * a pointer to point.
 *
 * Sixteen commands, nine tools. Seven have no tool: the six that write, which the
 * `Command` union refuses to give a tool name, and `mcp`, which writes nothing and is the
 * server itself. Counting it among the writers would have been a sentence that reads as a
 * guarantee and is wrong by one, so the exception is named here and pinned by name in
 * `registry.test.ts` rather than restated.
 */

import type { AnyCommand } from './command.js';

import { bundle } from '../commands/bundle.js';
import { build } from '../commands/build.js';
import { check } from '../commands/check.js';
import { doctor } from '../commands/doctor.js';
import { init } from '../commands/init.js';
import { install } from '../commands/install.js';
import { label } from '../commands/label.js';
import { mcp } from '../commands/mcp.js';
import { page } from '../commands/page.js';
import { pages } from '../commands/pages.js';
import { prefetch } from '../commands/prefetch.js';
import { publish } from '../commands/publish.js';
import { scaffold } from '../commands/scaffold.js';
import { skills } from '../commands/skills.js';
import { sync } from '../commands/sync.js';
import { verifyInstall } from '../commands/verify-install.js';

/**
 * Ordered as `--help` prints them: diagnose, read, then the ones that write.
 *
 * The order is not alphabetical on purpose. `doctor` is first because it is the "run
 * this first" command, and a person scanning the list should meet the read-only surface
 * before the one that edits their repository.
 */
export const COMMANDS: readonly AnyCommand[] = [
	doctor,
	check,
	pages,
	page,
	bundle,
	label,
	scaffold,
	skills,
	verifyInstall,
	init,
	build,
	install,
	sync,
	publish,
	prefetch,
	mcp,
];

export const BY_NAME: ReadonlyMap<string, AnyCommand> = new Map(
	COMMANDS.map((command) => [command.name, command]),
);

/** The MCP surface, derived. There is no second list. */
export const TOOLS: readonly AnyCommand[] = COMMANDS.filter((command) => command.tool !== null);

export const BY_TOOL: ReadonlyMap<string, AnyCommand> = new Map(
	TOOLS.map((command) => [command.tool as string, command]),
);
