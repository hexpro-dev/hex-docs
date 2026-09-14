/**
 * Which directory a tool call may point at, and the refusal when it points somewhere else.
 *
 * On the CLI a root is a path a person typed, and it is theirs to choose. Over MCP the
 * same parameter is filled by a model, which can be steered by anything it read, and two
 * of the nine tools execute code the target directory controls: `docs_verify_install` and
 * `docs_doctor` run `./node_modules/.bin/react-router` with the site as the working
 * directory, which is a binary chosen by that directory and a route config it loads, and
 * git, which runs whatever `core.fsmonitor` or hook the repository's own config names.
 * Measured in the step 8 review: a planted `node_modules/.bin/react-router` under an
 * absolute root outside the server's project ran, from a tool annotated read-only and
 * closed-world.
 *
 * So every tool call's `root`, and its `site` where it takes one, has to resolve inside the
 * project the server was started in, which is `Ctx.cwd`: `bin/hexdocs` captures `$PWD` into
 * `HEXDOCS_PROJECT_ROOT` and `cli/main.ts` reads it back. A value with a `..` segment is
 * refused however it resolves, because a path that climbs and comes back down is either a
 * mistake or a probe, and neither should be answered by working out which. The comparison
 * is between real paths, so a symbolic link inside the project that leads out of it is
 * outside.
 *
 * What is deliberately not confined, and why each is safe to leave. `docs_label`'s
 * `source-repo` is a sibling clone of the app repository by design, and the only recipe
 * run in it is `git merge-base --is-ancestor`, which the review measured does not invoke
 * `core.fsmonitor`. `bundle`, `path`, `against`, `cache` and `mount` are read as files by
 * the tools that take them and nothing is started in them.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { Finding } from '../../../src/contracts/diagnostics.js';
import { checkFindings } from '../compile/lint/checks.js';
import { raw } from '../compile/types.js';
import type { AnyCommand } from '../registry/command.js';

/**
 * A path with every symbolic link resolved, as far as the path exists.
 *
 * The part that does not exist yet is joined back on unresolved, because it cannot be a
 * link. Without this a root naming a directory that is not there would be compared as
 * written while its existing parent was compared resolved, and `/var` against
 * `/private/var` on macOS would put every temporary directory outside itself.
 */
function realpathOf(path: string): string {
	let existing = path;
	const rest: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return path;
		rest.unshift(basename(existing));
		existing = parent;
	}
	return join(realpathSync(existing), ...rest);
}

function isInside(path: string, root: string): boolean {
	const between = relative(root, path);
	return (
		between === '' || (between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between))
	);
}

/** Whether a value names a `..` segment, in either separator. */
function climbs(value: string): boolean {
	return value.split(/[\\/]/).includes('..');
}

/**
 * What is wrong with a tool call's paths, one sentence each, or nothing.
 *
 * Only `root` and `site` are read, and only when the command declares them. A value that
 * is not a string is left for the schema, which refuses it before anything runs.
 */
export function pathProblems(
	command: AnyCommand,
	args: Readonly<Record<string, unknown>>,
	projectRoot: string,
): string[] {
	const problems: string[] = [];
	const project = realpathOf(resolve(projectRoot));

	const rootArgument = 'root' in command.params ? args['root'] : undefined;
	const root = typeof rootArgument === 'string' ? rootArgument : '.';
	const rootPath = resolve(projectRoot, root);

	const check = (name: string, value: string, resolved: string): void => {
		if (climbs(value)) {
			problems.push(
				`${name} ${JSON.stringify(value)} has a ".." segment, which a tool call is refused however it resolves.`,
			);
			return;
		}
		const real = realpathOf(resolved);
		if (!isInside(real, project)) {
			problems.push(
				`${name} ${JSON.stringify(value)} resolves to ${real}, which is outside the project this server was started in, ${project}.`,
			);
		}
	};

	check('root', root, rootPath);
	const site = 'site' in command.params ? args['site'] : undefined;
	if (typeof site === 'string') check('site', site, resolve(rootPath, site));
	return problems;
}

/** A tool call refused before its command ran, carrying the finding that says why. */
export class ToolRefusal extends Error {
	readonly findings: readonly Finding[];

	constructor(tool: string, findings: readonly Finding[]) {
		// The message is the JSON a client shows the model, because a tool error reaches it as
		// text and nothing else. A finding is the shape every other refusal in this package
		// takes, so the model reads a rule, a consequence and a remediation rather than a
		// sentence it has to guess the fix from.
		super(JSON.stringify({ tool, refused: true, findings }, null, 2));
		this.name = 'ToolRefusal';
		this.findings = findings;
	}
}

/** The refusal for a call whose paths leave the project, or `null` when they do not. */
export function confinementRefusal(
	command: AnyCommand,
	args: Readonly<Record<string, unknown>>,
	projectRoot: string,
	kitVersion: string,
): ToolRefusal | null {
	const problems = pathProblems(command, args, projectRoot);
	if (problems.length === 0) return null;
	const findings = checkFindings(
		[
			raw('mcp-path-outside-project', { kind: 'project' }, null, problems.join(' '), {
				remediation:
					'Call the tool with a root and a site inside the directory the server was started in, or start the server from the repository you mean to check. From a terminal, the hexdocs CLI takes any path, because a person typing a path chose it.',
			}),
		],
		kitVersion,
	);
	return new ToolRefusal(command.tool ?? command.name, findings);
}
