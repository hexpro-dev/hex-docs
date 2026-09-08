/**
 * `--help`, derived from the registry.
 *
 * There is no help text anywhere but in the registry, so a command whose summary is
 * blank or whose flag lost its description fails `kit/test/cli/help.test.ts` rather than
 * shipping an empty column. It is the same argument the JSON Schema makes on the other
 * surface: `Param.help` is what a model reads before it decides what to send, and a
 * second copy for humans would be the one that goes stale.
 */

import { COMMANDS, BY_NAME } from '../registry/index.js';
import type { AnyCommand } from '../registry/command.js';
import type { Param } from '../registry/params.js';

function defaultText(fallback: string | number | boolean | undefined): string {
	return fallback === undefined ? '' : ` (default: ${JSON.stringify(fallback)})`;
}

/**
 * How wide the left column has to be, measured from the rows about to be printed.
 *
 * It was a literal 20, and two real flags overflowed it: `--source-repo <value>` is 21
 * characters and `--product-name <value>` is 22, so `padEnd(20)` printed the spelling and
 * its help text with no separator between them. A literal is a guess about the widest
 * name any command will ever declare, and it was already wrong. Two extra spaces are
 * added so the column has a gap even at the widest row.
 */
function columnWidth(rows: readonly string[]): number {
	return rows.reduce((widest, row) => Math.max(widest, row.length), 0) + 2;
}

export function commandHelp(command: AnyCommand): string[] {
	const lines: string[] = [];
	const usage = [
		'hexdocs',
		command.name,
		...command.positionals.map((name) =>
			command.params[name]?.required === true ? `<${name}>` : `[${name}]`,
		),
		'[options]',
	].join(' ');
	lines.push(usage, '', command.summary, '', command.detail, '');

	const options = Object.entries(command.params).filter(
		([name]) => !(command.positionals as readonly string[]).includes(name),
	);
	const spellingOf = ([name, param]: [string, Param]): string =>
		param.type === 'boolean' ? `--${name}` : `--${name} <value>`;
	// One width across both blocks and the two dispatcher rows, so the whole page lines up
	// rather than the arguments and the options each finding their own column.
	const width = columnWidth([
		...command.positionals,
		...options.map(spellingOf),
		'--json',
		'--help, -h',
	]);

	if (command.positionals.length > 0) {
		lines.push('Arguments:');
		for (const name of command.positionals) {
			const param = command.params[name];
			if (param === undefined) continue;
			lines.push(`  ${name.padEnd(width)}${param.help}${defaultText(param.fallback)}`);
		}
		lines.push('');
	}
	lines.push('Options:');
	for (const entry of options) {
		const [, param] = entry;
		const values = param.values === undefined ? '' : ` [${param.values.join(' | ')}]`;
		const repeat = param.many === true ? ' (repeatable)' : '';
		lines.push(
			`  ${spellingOf(entry).padEnd(width)}${param.help}${values}${repeat}${defaultText(param.fallback)}`,
		);
	}
	lines.push(`  ${'--json'.padEnd(width)}Print the machine-readable result on stdout`);
	lines.push(`  ${'--help, -h'.padEnd(width)}Print this`);
	if (command.tool !== null) {
		lines.push('', `Also available over MCP as \`${command.tool}\`.`);
	}
	lines.push('', `Taught by: ${command.taughtBy.join(', ')}.`);
	return lines;
}

export function topHelp(): string[] {
	const width = COMMANDS.reduce((max, command) => Math.max(max, command.name.length), 0);
	const lines = [
		'hexdocs <command> [options]',
		'',
		'The hex-docs toolchain: compile a documentation tree into a bundle, check it,',
		'wire it into a website and publish it.',
		'',
		'Commands:',
	];
	for (const command of COMMANDS) {
		lines.push(`  ${command.name.padEnd(width + 2)}${command.summary}`);
	}
	lines.push(
		'',
		'Run `hexdocs <command> --help` for one command.',
		'`--json` on any command prints the result on stdout and the human text on stderr.',
	);
	return lines;
}

export function helpFor(name: string | undefined): string[] {
	if (name === undefined) return topHelp();
	const command = BY_NAME.get(name);
	return command === undefined ? topHelp() : commandHelp(command);
}
