/**
 * argv to a validated input object, derived from the command's own parameter table.
 *
 * `node:util`'s `parseArgs`, with no dependency and no hand-written tokeniser.
 */

import { parseArgs } from 'node:util';

import type { AnyCommand } from '../registry/command.js';

/**
 * A call that was never made, as against a run that found something wrong.
 *
 * Separate from every other failure because it exits 2 and reports no verdict: an
 * unknown flag means nothing was examined, so reporting a clean run would be a lie and
 * reporting a failing one would name a problem in the documentation that does not exist.
 */
export class UsageError extends Error {}

/**
 * `parseArgs` options, derived. Positionals are omitted: they arrive as positionals.
 *
 * There is no integer type in `parseArgs`, so an integer parameter is declared as a
 * string here and coerced in `bind`. It is deliberately not coerced in the schema
 * either: `z.coerce.number()` infers `unknown` as its input, and the JSON Schema built
 * from that is the only thing a model reads before deciding what to send.
 */
export function optionsFor(
	command: AnyCommand,
): Record<string, { type: 'string' | 'boolean'; multiple?: true }> {
	const options: Record<string, { type: 'string' | 'boolean'; multiple?: true }> = {};
	for (const [name, param] of Object.entries(command.params)) {
		if ((command.positionals as readonly string[]).includes(name)) continue;
		options[name] = {
			type: param.type === 'boolean' ? 'boolean' : 'string',
			...(param.many === true ? { multiple: true as const } : {}),
		};
	}
	return options;
}

/**
 * Everything after the subcommand, bound to that command's table.
 *
 * Two phase on purpose. A single global parse has to declare every subcommand's options
 * up front, and a string option still swallows the token after it even when that token
 * is the subcommand: measured, `parseArgs` on `['--project', 'build', 'sync']` returns
 * `{ project: 'build' }` with `sync` as the only positional. Reading `argv[0]` as the
 * command name first and parsing the rest against that command's own table removes the
 * whole class.
 */
export function bind(command: AnyCommand, argv: readonly string[]): unknown {
	let parsed;
	try {
		parsed = parseArgs({
			args: [...argv],
			options: optionsFor(command),
			allowPositionals: true,
			strict: true,
		});
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}

	// An extra positional is a usage error, never something to drop. `hexdocs check a b`
	// with one declared positional would otherwise check `a` and say nothing at all about
	// `b`, which reads as a clean run over a directory nobody asked about.
	//
	// It is also most of what happens to `--`, and the qualifier matters: `parseArgs` merges
	// everything after the terminator into `positionals` indistinguishably, so the tokens
	// are refused only once they overflow the declared count. `hexdocs check -- --force`
	// binds `root` to the string `--force` and is not refused here. It is not a silent pass
	// either, because no such directory exists and the run reports a `not-run` row, but the
	// refusal is the count rather than the terminator and saying otherwise would overstate
	// it. No command here takes pass-through arguments, which is why this is where it ends.
	if (parsed.positionals.length > command.positionals.length) {
		throw new UsageError(
			`hexdocs ${command.name} takes ${command.positionals.length} positional argument(s) ` +
				`(${command.positionals.join(', ') || 'none'}) and was given ${parsed.positionals.length}.`,
		);
	}

	const merged: Record<string, unknown> = { ...parsed.values };
	command.positionals.forEach((name, index) => {
		const value = parsed.positionals[index];
		if (value !== undefined) merged[name] = value;
	});

	for (const [name, param] of Object.entries(command.params)) {
		if (param.type !== 'integer') continue;
		const raw = merged[name];
		if (typeof raw !== 'string') continue;
		if (!/^\d+$/.test(raw)) {
			throw new UsageError(`--${name} takes a whole number, and was given "${raw}".`);
		}
		merged[name] = Number(raw);
	}

	return merged;
}

/**
 * Tokens the dispatcher owns, stripped before `bind` sees argv.
 *
 * `registry.test.ts` asserts no command declares a parameter with one of these names, so
 * a command cannot shadow them and there is no precedence question to answer.
 */
export const DISPATCHER_TOKENS = ['--json', '--help', '-h'] as const;

export interface Stripped {
	readonly rest: string[];
	readonly json: boolean;
	readonly help: boolean;
}

export function stripDispatcherTokens(argv: readonly string[]): Stripped {
	const rest: string[] = [];
	let json = false;
	let help = false;
	for (const token of argv) {
		if (token === '--json') json = true;
		else if (token === '--help' || token === '-h') help = true;
		else rest.push(token);
	}
	return { rest, json, help };
}
