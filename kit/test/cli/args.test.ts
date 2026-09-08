/**
 * argv to an input object, and the three ways that goes wrong quietly.
 *
 * Every failure this file is about produces a run rather than an error. An unknown flag
 * that `parseArgs` dropped is a run with a default where the caller meant a value; an
 * extra positional that nobody looked at is `hexdocs check a b` reporting a clean tree
 * while saying nothing at all about `b`; and `--limit abc` reaching the schema uncoerced
 * is a Zod message about a string where a number was expected, on a flag the caller
 * spelled correctly. All three exit 0 or 2 with a plausible report attached, which is why
 * they are here rather than left to the schema.
 *
 * The last block is different in kind. `bind`'s own comment claims a measurement, that a
 * single global `parseArgs` swallows the subcommand token after a string option, and the
 * two-phase design is justified by it. A comment that states a measurement nobody re-ran
 * is the shape this repository refuses everywhere else, so it is re-run here against the
 * registry's own flags.
 */

import { parseArgs } from 'node:util';

import { describe, expect, test } from 'vitest';

import {
	DISPATCHER_TOKENS,
	UsageError,
	bind,
	optionsFor,
	stripDispatcherTokens,
} from '../../src/cli/args.js';
import { BY_NAME, COMMANDS } from '../../src/registry/index.js';
import type { AnyCommand } from '../../src/registry/command.js';

function command(name: string): AnyCommand {
	const found = BY_NAME.get(name);
	if (found === undefined) throw new Error(`${name} is not a command; this test is stale.`);
	return found;
}

const check = command('check');
const page = command('page');
const install = command('install');
const mcp = command('mcp');
const sync = command('sync');

/** What `bind` threw, as a message, so a test can assert what it names. */
function usage(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		expect(error, 'not a UsageError').toBeInstanceOf(UsageError);
		return (error as Error).message;
	}
	throw new Error('nothing was thrown');
}

describe('optionsFor is derived from the parameter table', () => {
	test.each(COMMANDS.map((entry) => [entry.name, entry] as const))(
		'%s declares an option for every parameter that is not a positional',
		(_name, entry) => {
			// Both directions. A missing entry makes `parseArgs` reject a flag the command
			// declares, which reads as a typo to whoever typed it; an extra one accepts a
			// flag the schema will then strip, which reads as the flag having no effect.
			const expected = Object.keys(entry.params).filter(
				(key) => !(entry.positionals as readonly string[]).includes(key),
			);
			expect(Object.keys(optionsFor(entry)).sort()).toEqual([...expected].sort());
		},
	);

	test('an integer parameter is declared to parseArgs as a string', () => {
		// There is no integer type in `parseArgs`. Declaring one as a boolean would make
		// `--limit 25` bind `limit: true` and leave `25` sitting in the positionals, where
		// the extra-positional guard would report a usage error naming the wrong thing.
		const options = optionsFor(page);
		expect(page.params['limit']?.type).toBe('integer');
		expect(options['limit']).toEqual({ type: 'string' });
		expect(options['offset']).toEqual({ type: 'string' });
	});

	test('a boolean parameter is declared as a boolean and a repeatable one as multiple', () => {
		expect(optionsFor(install)['write']).toEqual({ type: 'boolean' });
		expect(optionsFor(check)['locale']).toEqual({ type: 'string', multiple: true });
		// The absence matters as much as the presence: `multiple` on a flag the table does
		// not mark `many` hands the schema an array where it wants a scalar, and the enum
		// refuses it with a message about the wrong type.
		expect(optionsFor(check)['severity']).toEqual({ type: 'string' });
	});

	test('a command with no options at all still produces a table', () => {
		expect(optionsFor(mcp)).toEqual({});
	});

	test('every positional is absent from the options table', () => {
		// The one that would be silent: a positional also declared as an option lets the
		// same value arrive twice, and `bind` writes the positional last, so the flag would
		// be the one that loses.
		for (const entry of COMMANDS) {
			const options = Object.keys(optionsFor(entry));
			const both = entry.positionals.filter((name) => options.includes(name));
			expect(both, `${entry.name}: positional also offered as a flag`).toEqual([]);
		}
	});
});

describe('bind refuses a call that was never made', () => {
	test('an unknown flag is a UsageError naming the flag', () => {
		const message = usage(() => bind(check, ['--sevrity', 'error']));
		expect(message).toMatch(/sevrity/);
	});

	test('a boolean flag given a value is a UsageError', () => {
		// `--write=yes` is what somebody types who thinks the flag takes an argument, and
		// `parseArgs` in strict mode is the only thing that says so. Non-strict it would
		// bind `write: true` and drop the `yes`.
		const message = usage(() => bind(install, ['--write=yes']));
		expect(message.length).toBeGreaterThan(0);
	});

	test('an extra positional is a UsageError naming the count', () => {
		// `hexdocs check a b` must not check `a` and say nothing about `b`. The message has
		// to carry both numbers, because "too many arguments" leaves the caller counting.
		const message = usage(() => bind(check, ['a', 'b']));
		expect(message).toContain('hexdocs check takes 1 positional argument(s)');
		expect(message).toContain('(root)');
		expect(message).toContain('was given 2');
	});

	test('a command with no positionals refuses the first one', () => {
		const message = usage(() => bind(mcp, ['extra']));
		expect(message).toContain('takes 0 positional argument(s)');
		expect(message).toContain('none');
		expect(message).toContain('was given 1');
	});

	test('the exact positional count is accepted', () => {
		// The other direction, so the guard cannot be satisfied by refusing everything.
		expect(bind(page, ['guide/first-tag', '/tmp/app'])).toEqual({
			slug: 'guide/first-tag',
			root: '/tmp/app',
		});
	});

	test('an integer flag that is not a whole number is a UsageError naming the flag', () => {
		const message = usage(() => bind(page, ['guide/first-tag', '--limit', 'abc']));
		expect(message).toBe('--limit takes a whole number, and was given "abc".');
	});

	test.each([
		['a decimal', '1.5'],
		['a signed number', '+3'],
		['an empty value', ''],
		['a number with a separator', '12_000'],
	])('an integer flag refuses %s', (_why, value) => {
		expect(() => bind(page, ['guide/first-tag', '--limit', value])).toThrow(UsageError);
	});

	test('a whole number arrives as a number, not a string', () => {
		// The coercion is `bind`'s and deliberately not the schema's: `z.coerce.number()`
		// infers `unknown` as its input, and the JSON Schema built from that is the only
		// thing a model reads before deciding what to send.
		const bound = bind(page, ['guide/first-tag', '--limit', '25', '--offset', '0']) as Record<
			string,
			unknown
		>;
		expect(bound['limit']).toBe(25);
		expect(bound['offset']).toBe(0);
	});

	test('a repeated flag arrives as an array and a single one still does', () => {
		expect(bind(check, ['--locale', 'en', '--locale', 'ja'])).toEqual({ locale: ['en', 'ja'] });
		// `multiple` wraps a lone value too, which is what the `many` schema arm requires.
		expect(bind(check, ['--locale', 'en'])).toEqual({ locale: ['en'] });
	});

	test('nothing at all binds nothing at all', () => {
		// Defaults are the schema's job, not `bind`'s. A `bind` that filled them in would be
		// a second declaration of every default, in a place `--help` and the JSON Schema
		// cannot see.
		expect(bind(check, [])).toEqual({});
	});

	test('a value outside a closed set is not bind refusing it', () => {
		// Naming the limit rather than implying more. `parseArgs` knows nothing about
		// `values`, so `--severity nonsense` binds and the enum refuses it one layer later,
		// where `main.ts` turns a ZodError into the same exit code 2.
		expect(bind(check, ['--severity', 'nonsense'])).toEqual({ severity: 'nonsense' });
	});
});

describe('the argument terminator', () => {
	test('a token after -- is a positional and overflows the count', () => {
		// `parseArgs` merges everything after `--` into `positionals` indistinguishably, so
		// there is no way to tell a pass-through argument from a real one, and no command
		// here takes pass-through arguments. The extra-positional guard is what refuses it.
		const message = usage(() => bind(check, ['.', '--', '--force']));
		expect(message).toContain('was given 2');
	});

	test('every token after -- counts, including one that looks like a flag', () => {
		const message = usage(() => bind(mcp, ['--', '--force', '--rm']));
		expect(message).toContain('was given 2');
	});

	test('a terminator that fills an empty positional slot is not refused', () => {
		// The honest limit of the guard above, stated rather than implied. `hexdocs check --
		// --force` has one token and `check` has one positional, so `--force` binds as the
		// root. That is not a silent pass: the root does not exist and `check` reports a
		// `not-run` row and exits 3. It is written down because the comment at the guard
		// reads as though `--` were refused outright, and it is refused only on overflow.
		expect(bind(check, ['--', '--force'])).toEqual({ root: '--force' });
	});
});

describe('stripDispatcherTokens takes exactly the tokens the dispatcher owns', () => {
	/**
	 * Which field each token sets, cross-checked against `DISPATCHER_TOKENS` below.
	 *
	 * A token added to that array and not here is a token nothing proves is consumed, and
	 * a token here that left the array is one this file claims to cover and does not.
	 */
	const SETS: Record<string, 'json' | 'help'> = {
		'--json': 'json',
		'--help': 'help',
		'-h': 'help',
	};

	test('the table and the array name the same tokens, in both directions', () => {
		expect(Object.keys(SETS).sort()).toEqual([...DISPATCHER_TOKENS].sort());
	});

	test.each(Object.entries(SETS))('%s is consumed and sets %s', (token, field) => {
		const stripped = stripDispatcherTokens(['check', token, '.']);
		expect(stripped.rest, `${token} survived`).toEqual(['check', '.']);
		expect(stripped[field], `${token} did not set ${field}`).toBe(true);
		// And the other field is untouched, so a token cannot set both.
		expect(stripped[field === 'json' ? 'help' : 'json']).toBe(false);
	});

	test('nothing else is consumed', () => {
		// The near misses are the point. `-H`, `--h` and `-help` are what a person types by
		// accident, and consuming any of them here would hide the unknown-flag error that
		// tells them so.
		const rest = ['check', '--jsonl', '-H', '--h', '-help', 'help', 'json', '--', '--json-x'];
		const stripped = stripDispatcherTokens(rest);
		expect(stripped.rest).toEqual(rest);
		expect(stripped.json).toBe(false);
		expect(stripped.help).toBe(false);
	});

	test('order is preserved and a repeat is idempotent', () => {
		const stripped = stripDispatcherTokens(['--json', 'check', '--json', '.', '-h', '--help']);
		expect(stripped.rest).toEqual(['check', '.']);
		expect(stripped.json).toBe(true);
		expect(stripped.help).toBe(true);
	});

	test('a dispatcher token after -- is still consumed', () => {
		// Stated rather than left to be discovered: the strip runs over the whole of argv
		// before `parseArgs` ever sees it, so the terminator does not protect a token. That
		// is correct while no command takes pass-through arguments, and it is the assumption
		// that would have to change first if one ever did.
		expect(stripDispatcherTokens(['check', '--', '--json']).json).toBe(true);
	});
});

describe('the measurement the two-phase design rests on', () => {
	/**
	 * The single global option table the comment in `bind` rejects, built from the real
	 * registry so the measurement is against the flags this CLI actually declares.
	 */
	function globalOptions(): {
		table: Record<string, { type: 'string' | 'boolean'; multiple?: true }>;
		conflicts: string[];
	} {
		const table: Record<string, { type: 'string' | 'boolean'; multiple?: true }> = {};
		const conflicts: string[] = [];
		for (const entry of COMMANDS) {
			for (const [name, option] of Object.entries(optionsFor(entry))) {
				const seen = table[name];
				if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify(option)) {
					conflicts.push(name);
				}
				table[name] = option;
			}
		}
		return { table, conflicts: [...new Set(conflicts)].sort() };
	}

	test('one global table cannot even be built without choosing between two commands', () => {
		// Measured, not assumed. `--locale` is repeatable on check, pages, scaffold and init
		// and a single value on page, so a global table has to pick one spelling and be
		// wrong for the other command. That is a cost the two-phase design does not pay at
		// all, and it is separate from the swallowing below.
		const { conflicts } = globalOptions();
		expect(conflicts).toEqual(['locale']);
		expect(check.params['locale']?.many).toBe(true);
		expect(page.params['locale']?.many).toBeUndefined();
	});

	test('a global parse swallows the subcommand after a string option', () => {
		// The comment's own example, re-run: `--project` is a real flag on `sync` and
		// `build` and `sync` are both real commands, so this argv is one a person could
		// type meaning "build, with --project set".
		expect(BY_NAME.has('build')).toBe(true);
		expect(sync.params['project']?.type).toBe('string');

		const { table } = globalOptions();
		expect(table['project']).toEqual({ type: 'string' });

		const parsed = parseArgs({
			args: ['--project', 'build', 'sync'],
			options: table,
			allowPositionals: true,
			strict: true,
		});
		expect(parsed.values['project']).toBe('build');
		expect(parsed.positionals).toEqual(['sync']);

		// So a dispatcher reading the surviving positional as the command name would run
		// `sync`, a command that writes, where the caller named `build`. There is no error
		// anywhere in that path.
		expect(BY_NAME.get(parsed.positionals[0] as string)?.writes).toBe('files');
	});

	test('reading argv[0] first removes the whole class', () => {
		// The two-phase path over the same argv. `--project` is not a command name, so
		// nothing is dispatched and nothing is parsed against the wrong table.
		const argv = ['--project', 'build', 'sync'];
		expect(BY_NAME.get(argv[0] as string)).toBeUndefined();

		// And the shape a caller means instead binds exactly as written, with the value
		// after the flag and no command token in reach of it.
		expect(bind(sync, ['--project', 'hex-nfc', '--site', 'apps/front'])).toEqual({
			project: 'hex-nfc',
			site: 'apps/front',
		});
	});
});
