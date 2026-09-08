/**
 * The only place this package starts a process.
 *
 * One spawn site, asserted by a source scan in `kit/test/exec/one-spawn-site.test.ts`,
 * because a second one would sit outside every guarantee `recipes.ts` makes while
 * looking exactly like a call that does not. hex-terraform has precisely that defect
 * live: `mcp/src/context.ts` reaches for `execSync` over an interpolated path while
 * `lib/exec.ts` beside it carries the allowlist.
 *
 * `spawnSync` with an argv array and `shell: false`. No string is ever handed to a
 * shell, which is what makes the metacharacter check below belt and braces rather than
 * the guard: the guard is that the template is a literal and a hole is one argv element.
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
 * Characters refused in a caller-supplied value.
 *
 * Only the holes are checked. The template is a literal in `recipes.ts` and cannot carry
 * one, and a hole is a path, a sha, a bucket name or a key out of a config file.
 *
 * The NUL is written as an escape because it has to be. It stood here as a raw byte,
 * invisible in every diff and every review, which is exactly the failure the house rule
 * about writing non-ASCII as an escape exists to stop, in the one file where a reviewer
 * most needs to read the characters literally.
 *
 * **A space is deliberately not a member.** It is the separator a shell splits on, so it
 * looks like it belongs, and refusing it would break a repository checked out under a
 * path containing one, which on macOS is ordinary. What makes that safe is that this
 * class is not the guarantee: `spawnSync` is called with an argv array and
 * `shell: false`, so no value is ever parsed by anything. The fixed template is the
 * guarantee and this is belt and braces over it.
 */
const METACHARACTER = /[`$;|&><\\\n\r\u0000]/;

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
		if (METACHARACTER.test(value)) {
			throw new ExecRefusal(
				`Refusing "${id}": a value contains a shell metacharacter: ${JSON.stringify(value)}.`,
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
