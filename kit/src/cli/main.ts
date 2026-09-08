/**
 * argv in, exit code out.
 *
 * The one rule this file exists to hold: **`--json` puts exactly one JSON object on
 * stdout and every human-readable line on stderr.** A tool that mixes the two cannot be
 * parsed by the consumer's `check-docs.mjs` shim or by an agent, and the failure is a
 * `JSON.parse` error naming a byte offset in what is otherwise a perfectly good report.
 * `kit/test/cli/json.test.ts` asserts it for every command in the registry, in both
 * directions, so a new command cannot skip it and a stray `console.log` fails the suite.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runRecipe } from '../exec/run.js';
import { fileWriter } from '../io/write.js';
import { BY_NAME } from '../registry/index.js';
import { exitCodeFor, invoke, type Ctx } from '../registry/command.js';

import { UsageError, bind, stripDispatcherTokens } from './args.js';
import { helpFor, topHelp } from './help.js';
import { renderOutput } from './render.js';

/**
 * The one place the toolchain's own version is read.
 *
 * It reaches the manifest's `generator`, every envelope's `kitVersion` and every
 * report's, so a second source would put two version strings in one bundle and make a
 * stale submodule invisible in exactly the output that exists to reveal it.
 */
export function kitVersion(): string {
	const path = fileURLToPath(new URL('../../package.json', import.meta.url));
	const parsed = JSON.parse(readFileSync(path, 'utf8')) as { name: string; version: string };
	return `${parsed.name}@${parsed.version}`;
}

export function defaultContext(cwd: string): Ctx {
	return {
		cwd,
		kitVersion: kitVersion(),
		exec: runRecipe,
		write: fileWriter(),
		now: () => new Date(),
		log: (line) => process.stderr.write(`${line}\n`),
	};
}

export interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * The whole dispatch, as a function of argv, so a test drives it without a process.
 *
 * Exit codes, and there are four:
 *
 *   0  clean.
 *   1  the toolchain threw. A bug in hexdocs, printed with its stack.
 *   2  usage: no command, an unknown one, an unknown flag, a missing argument. Nothing
 *      was examined, so there is no verdict to report.
 *   3  the run found something wrong: an envelope with errors, or a failing or
 *      non-running row.
 *
 * An input hexdocs could not read is deliberately not a usage error. It is a `not-run`
 * row and therefore 3, because "I could not read the registry" and "the registry is
 * broken" are both "no verdict, and it is not clean".
 */
export async function run(argv: readonly string[], ctx: Ctx): Promise<RunResult> {
	const out: string[] = [];
	const err: string[] = [];

	const { rest, json, help } = stripDispatcherTokens(argv);
	const name = rest[0];

	if (help || name === undefined) {
		err.push(...helpFor(name).join('\n').split('\n'));
		// No command at all is a usage error even though the help printed: a script that
		// called hexdocs with nothing has not done what it meant to.
		return { code: name === undefined && !help ? 2 : 0, stdout: '', stderr: `${err.join('\n')}\n` };
	}

	const command = BY_NAME.get(name);
	if (command === undefined) {
		err.push(`hexdocs: there is no command called "${name}".`, '', ...topHelp());
		return { code: 2, stdout: '', stderr: `${err.join('\n')}\n` };
	}

	let output;
	try {
		output = await invoke(command, bind(command, rest.slice(1)), ctx);
	} catch (error) {
		if (error instanceof UsageError) {
			err.push(`hexdocs ${name}: ${error.message}`, '', ...helpFor(name));
			return { code: 2, stdout: '', stderr: `${err.join('\n')}\n` };
		}
		// A Zod failure here is a missing or malformed argument, which is the same class
		// as an unknown flag: the call was never made.
		if (error instanceof Error && error.name === 'ZodError') {
			err.push(`hexdocs ${name}: ${error.message}`, '', ...helpFor(name));
			return { code: 2, stdout: '', stderr: `${err.join('\n')}\n` };
		}
		const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
		err.push(`hexdocs ${name} failed inside the toolchain. This is a bug in hexdocs.`, stack);
		return { code: 1, stdout: '', stderr: `${err.join('\n')}\n` };
	}

	const text = renderOutput(output);
	if (json) {
		out.push(JSON.stringify(output.data, null, 2));
		err.push(...text);
	} else {
		out.push(...text);
	}

	return {
		code: exitCodeFor(output),
		stdout: out.length === 0 ? '' : `${out.join('\n')}\n`,
		stderr: err.length === 0 ? '' : `${err.join('\n')}\n`,
	};
}

/* c8 ignore start -- the process shell: covered by kit/test/cli/spawn.test.ts, which
   runs the real launcher in a child process where v8 collects no coverage. */
async function main(): Promise<void> {
	const cwd = process.env['HEXDOCS_PROJECT_ROOT'] ?? process.cwd();
	const result = await run(process.argv.slice(2), defaultContext(cwd));
	if (result.stdout !== '') process.stdout.write(result.stdout);
	if (result.stderr !== '') process.stderr.write(result.stderr);
	process.exitCode = result.code;
}

/**
 * Whether this module is the program, compared through the filesystem rather than as text.
 *
 * The obvious form, `import.meta.url === pathToFileURL(process.argv[1]).href`, is what
 * every other entry point in this repository uses and it is wrong here, because this one
 * is not invoked with a literal path: `bin/hexdocs` computes `$KIT_DIR` with `cd .. &&
 * pwd` and execs `$KIT_DIR/src/cli/main.ts`. If any component of that path is a symlink,
 * argv carries the path as given and `import.meta.url` carries the resolved one, the
 * comparison is false, `main()` never runs, and the process prints nothing and exits 0.
 *
 * That is not exotic. On macOS `/var` is a symlink to `/private/var`, so it happens for
 * every invocation under a temporary directory, and it happens for anybody whose checkout
 * sits under a symlinked path. The failure is the worst available shape: a CLI that
 * succeeds silently, which a script reads as a clean run.
 *
 * `realpathSync` on both sides removes the whole class. A path that cannot be resolved is
 * not this module, which is the safe answer.
 */
function isProgram(): boolean {
	const argv = process.argv[1];
	if (argv === undefined) return false;
	try {
		return realpathSync(argv) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isProgram()) {
	void main();
}
/* c8 ignore stop */
