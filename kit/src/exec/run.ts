/**
 * The only place this package starts a process.
 *
 * One spawn site, asserted by a source scan in `kit/test/exec/one-spawn-site.test.ts`,
 * because a second one would sit outside every guarantee `recipes.ts` makes while
 * looking exactly like a call that does not. hex-terraform has precisely that defect
 * live: `mcp/src/context.ts` reaches for `execSync` over an interpolated path while
 * `lib/exec.ts` beside it carries the allowlist.
 *
 * `spawnSync` with an argv array and `shell: false`. No string is ever handed to a shell:
 * the guarantee is that the template is a literal in `recipes.ts` and a hole is one argv
 * element. `REFUSED_IN_ARGV` below refuses the NUL and nothing else, and the paragraph
 * there says why the rest of the class it used to be went.
 */

import { spawnSync } from 'node:child_process';

import { ALL_RECIPES, HOLE, type Recipe, type RecipeId } from './recipes.js';

export interface RunOptions {
	readonly cwd: string;
	readonly timeoutMs?: number;
	/** Bytes. A `git log` over a large history is the one call that needs headroom. */
	readonly maxBuffer?: number;
}

export interface RunResult {
	/** `null` when the process was killed by a signal or never started. */
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Anything that can run a recipe.
 *
 * Injected rather than imported at every call site, so a test drives `publish` and
 * `prefetch` against a recording fake and asserts the exact argv, and so the MCP
 * server's context can supply one that refuses the write recipes outright.
 */
export interface Exec {
	(id: RecipeId, holes: readonly string[], options: RunOptions): RunResult;
}

/**
 * The one character refused in a caller-supplied value.
 *
 * Only the holes are checked. The template is a literal in `recipes.ts` and cannot carry
 * one, and a hole is a path, a sha, a bucket name, a content type or a key out of a
 * config file.
 *
 * The NUL is written as an escape because it has to be. It stood here as a raw byte,
 * invisible in every diff and every review, which is exactly the failure the house rule
 * about writing non-ASCII as an escape exists to stop, in the one file where a reviewer
 * most needs to read the characters literally.
 *
 * **This used to be a class of shell metacharacters, and step 6 deleted the rest of it.**
 * The reason is worth the paragraph, because the deletion reads like a control being
 * removed and is the opposite.
 *
 * `spawnSync` below is called with an argv array and `shell: false`, so no value here is
 * ever parsed by a shell: the fixed template is the guarantee and the class was belt and
 * braces over it. The class already carried one exception, for the space, on the grounds
 * that refusing it would break a repository checked out under an ordinary macOS path. The
 * first publish against a real bucket found the same argument one step along and settled
 * it: `s3/keys.ts` sends `text/plain; charset=utf-8` as the content type for `llms/*.txt`
 * and `text/markdown; charset=utf-8` for the raw markdown, both of them literals this
 * repository chose, and the semicolon refused both. Two objects went up and the publish
 * stopped. Nothing in the suite could see it, because every test injects a fake `Exec` and
 * never reaches this function.
 *
 * The general form of that defect is not the semicolon. A cache directory named with an
 * ampersand, a repository under a path with a backtick, a Windows-style backslash: each is
 * a legitimate value the class would have refused, and each would have surfaced as a
 * publish or a prefetch that stopped halfway with a message about a shell that is not
 * there. A tripwire that refuses correct input more often than it catches anything is not
 * defence in depth, it is a second, worse guarantee competing with the real one.
 *
 * What is left after the shell is the program the value is handed to, which reads its own
 * argv, and the deleted class covered none of that either. Measured on aws-cli 2.36.19: a
 * value beginning with `file://` is replaced by the contents of that file before the
 * request is built, on `--key` and on `--bucket` alike, and a value that looks like a flag
 * is taken as one, so `--key --debug` turns the CLI's own debug logging on and exits on a
 * usage error. `gh api` separately substitutes `{owner}`, `{repo}` and `{branch}` in its
 * endpoint argument from the repository at the cwd, and that argument is the `gh.api`
 * recipe's only hole. None of it is reachable today, because every hole is a computed key,
 * a content type from a table, a local path, a digest, a sha or a bucket name out of a
 * config file this repository owns. The one value that comes from outside is
 * `--starting-token`, which is the continuation token S3 itself just returned, and base64
 * carries neither a colon nor a leading dash. That inventory is the sentence to check when
 * a hole is next filled from somewhere else, a pull request title or an action input, and
 * the check
 * belongs where the value enters rather than here: a `file://` refusal in this function
 * would be the deleted class's mistake again, refusing a legitimate value shape no caller
 * produces, in the wrong place.
 *
 * The NUL stays, and for a different reason from the rest. Node refuses it itself, with a
 * `TypeError` out of `spawnSync` naming neither the recipe nor the value, so this is a
 * named refusal in place of a stack trace rather than a security control.
 */
const REFUSED_IN_ARGV = /\u0000/;

export class ExecRefusal extends Error {}

/**
 * Fills a recipe's holes and runs it.
 *
 * The arity check is in both directions on purpose. Too few values would leave a flag
 * with the following flag as its value, which for `--key --output` is a request for an
 * object literally named `--output`; too many means the caller is holding a different
 * template in their head from the one in the table, and the extra value would be
 * silently dropped.
 */
export function runRecipe(id: RecipeId, holes: readonly string[], options: RunOptions): RunResult {
	const recipe = ALL_RECIPES[id] as Recipe;
	const argv: string[] = [];
	let next = 0;
	for (const slot of recipe.argv) {
		if (slot !== HOLE) {
			argv.push(slot);
			continue;
		}
		const value = holes[next];
		next += 1;
		if (value === undefined) {
			throw new ExecRefusal(
				`Recipe "${id}" has ${recipe.argv.filter((s) => s === HOLE).length} values to fill and was given ${holes.length}.`,
			);
		}
		argv.push(value);
	}
	if (next !== holes.length) {
		throw new ExecRefusal(
			`Recipe "${id}" takes ${next} values and was given ${holes.length}. The extra ones would be dropped silently.`,
		);
	}
	for (const value of holes) {
		if (REFUSED_IN_ARGV.test(value)) {
			throw new ExecRefusal(
				`Refusing "${id}": a value contains a NUL, which cannot be passed in an argv: ${JSON.stringify(value)}.`,
			);
		}
	}

	const result = spawnSync(recipe.bin, argv, {
		cwd: options.cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: false,
		timeout: options.timeoutMs ?? 120_000,
		maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
	});

	// A binary that is not installed arrives as `error` with no status, and the honest
	// answer is a non-zero status with the message on stderr rather than a throw: every
	// caller of this either has a `skipped` row for a missing tool or fails on the exit
	// code, and neither wants an exception from a child process.
	if (result.error !== undefined) {
		return { status: null, stdout: '', stderr: result.error.message };
	}
	return {
		status: result.status,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

/**
 * An `Exec` that refuses everything, with the reason.
 *
 * What the MCP server's context carries. Every command bound to a tool declares that it
 * writes nothing and the type refuses to give a writer a tool name, so nothing should
 * reach this; it is here so that if something does, it fails loudly in a transcript
 * rather than running.
 */
export const NO_EXEC: Exec = (id) => {
	throw new ExecRefusal(
		`Refusing to run "${id}": this context has no exec. The MCP server reads and never runs anything that writes.`,
	);
};
