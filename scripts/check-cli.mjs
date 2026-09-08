#!/usr/bin/env node
/**
 * The command surface, exercised through the launcher rather than through an import.
 *
 * Every other assertion about the CLI is a vitest test that imports the modules directly.
 * That covers the logic and covers none of the path every consumer actually uses: the
 * shell script, its first-run install probe, tsx resolution, the process exit code, and
 * whether stdout stays clean when the same launcher is serving a protocol.
 *
 * Four rows, and the third is the one worth having. `hexdocs mcp` writes JSON-RPC to
 * stdout, so a single stray line from anything else in the process is a parse error the
 * client reports as a broken server with no cause attached. Nothing else in this
 * repository tests that, and it is the failure the launcher's stderr redirect exists for.
 *
 * Zero dependencies, plain `.mjs`, because it runs from the ladder and reads the emitted
 * catalogue rather than importing TypeScript.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { check, notRun, renderAndExit } from './lib/report.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * The registry, as data.
 *
 * Read rather than derived, because a `.mjs` cannot import the TypeScript that declares
 * it. `pnpm schemas` writes it and CI fails on a diff afterwards, so the file cannot
 * drift from the registry without that being a reviewable change.
 */
function catalogue(root) {
	return JSON.parse(readFileSync(join(root, 'kit', 'schema', 'tools-1.json'), 'utf8'));
}

/**
 * Where the launcher and the catalogue are.
 *
 * A parameter rather than a constant so the guard's own failure paths are reachable from
 * a test: `test/cli-surface.test.ts` points it at a copy whose catalogue has been
 * doctored and asserts the rows go red naming the difference. `check-paint.mjs` takes a
 * root for the same reason and says the same thing, which is that a guard whose failure
 * has never been observed is a guard nobody has tested.
 */
function paths(root) {
	return {
		launcher: join(root, 'kit', 'bin', 'hexdocs'),
		start: join(root, 'kit', 'start.sh'),
	};
}

function run(root, args, options = {}) {
	return spawnSync(paths(root).launcher, args, {
		cwd: root,
		encoding: 'utf8',
		env: { ...process.env, NO_COLOR: '1' },
		...options,
	});
}

/** Every command the top-level help lists, by name. */
function helpNames(output) {
	const names = [];
	let inCommands = false;
	for (const line of output.split('\n')) {
		if (line.startsWith('Commands:')) {
			inCommands = true;
			continue;
		}
		if (inCommands) {
			const match = /^ {2}([a-z][a-z-]*) {2,}\S/.exec(line);
			if (match !== null) names.push(match[1]);
			else if (line.trim() === '') inCommands = false;
		}
	}
	return names;
}

function checkHelp(root, tools) {
	const spawned = run(root, ['--help']);
	if (spawned.status !== 0) {
		return check('help', 0, 'commands', [`\`hexdocs --help\` exited ${spawned.status}.`]);
	}
	const listed = helpNames(spawned.stdout + spawned.stderr);
	const expected = tools.commands.map((command) => command.name);
	const missing = expected.filter((name) => !listed.includes(name));
	const extra = listed.filter((name) => !expected.includes(name));
	return check('help', listed.length, 'commands', [
		...missing.map((name) => `The registry has "${name}" and --help does not list it.`),
		...extra.map((name) => `--help lists "${name}" and the registry does not have it.`),
	]);
}

/**
 * The `--json` contract, through the process.
 *
 * The fixture corpus carries seven planted errors on purpose, so exit 3 is the pass here
 * and exit 0 would mean the corpus stopped tripping its own rules.
 */
function checkJson(root) {
	const spawned = run(root, ['check', 'fixtures/app', '--json']);
	const problems = [];
	if (spawned.status !== 3) {
		problems.push(
			`\`hexdocs check fixtures/app --json\` exited ${spawned.status}, and the fixture corpus carries planted errors, so 3 is the expected code.`,
		);
	}
	let parsed;
	try {
		parsed = JSON.parse(spawned.stdout);
	} catch (error) {
		problems.push(`stdout is not one JSON object: ${error.message}`);
	}
	if (parsed !== undefined && !Array.isArray(parsed.findings)) {
		problems.push('stdout parsed but is not a diagnostic envelope.');
	}
	// The other half of the contract, and the half a `JSON.parse` cannot catch: the human
	// text has to be somewhere, and it has to be somewhere that is not stdout.
	if (spawned.stderr.trim() === '') {
		problems.push('stderr is empty, so the human-readable report went nowhere.');
	}
	try {
		JSON.parse(spawned.stderr);
		problems.push('stderr parsed as JSON, so the two streams are the wrong way round.');
	} catch {
		// Expected: stderr is prose.
	}
	return check('json output', parsed?.findings?.length ?? 0, 'findings', problems);
}

/**
 * A real MCP handshake over the real launcher, and a stdout purity assertion.
 *
 * Two frames in, two frames expected out. Anything else on stdout, including a single
 * newline from an install that decided to announce itself, is the failure.
 */
async function checkMcp(root, tools) {
	const expected = tools.commands
		.filter((command) => command.tool !== null)
		.map((command) => command.tool)
		.sort();

	const child = spawn(paths(root).launcher, ['mcp'], {
		cwd: root,
		env: { ...process.env, NO_COLOR: '1' },
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	let stdout = '';
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		stdout += chunk;
	});
	// Captured rather than discarded. A server that failed to start writes its reason here
	// and produces no frames, and a row reporting only "got 0 frames" sends whoever reads
	// it looking at the protocol instead of at the stack trace that is already in hand.
	let stderr = '';
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk) => {
		stderr += chunk;
	});

	child.stdin.write(
		`${JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-11-25',
				capabilities: {},
				clientInfo: { name: 'check-cli', version: '0' },
			},
		})}\n`,
	);
	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
	child.stdin.end();

	const code = await new Promise((done) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			done('timeout');
		}, 60_000);
		child.on('close', (status) => {
			clearTimeout(timer);
			done(status);
		});
	});

	const problems = [];
	if (code === 'timeout') problems.push('`hexdocs mcp` did not exit when stdin closed.');

	const lines = stdout.split('\n').filter((line) => line !== '');
	const frames = [];
	for (const line of lines) {
		try {
			frames.push(JSON.parse(line));
		} catch {
			// The assertion this row exists for. Anything on stdout that is not a frame is
			// a protocol error to a client, and the client reports it as a broken server
			// rather than as whatever printed it.
			problems.push(
				`A line on stdout is not a JSON-RPC frame: ${JSON.stringify(line.slice(0, 120))}`,
			);
		}
	}

	// A notification takes no reply, so two requests must produce exactly two frames. A
	// third would mean the notification was answered, which a client reports as an
	// unsolicited response it has no pending request for.
	if (frames.length !== 2) {
		const because =
			stderr.trim() === ''
				? ''
				: ` Its stderr said: ${stderr.trim().split('\n').slice(-4).join(' ')}`;
		problems.push(`Expected exactly 2 frames on stdout and got ${frames.length}.${because}`);
	}

	const initialise = frames.find((frame) => frame.id === 1);
	if (initialise?.result?.protocolVersion === undefined) {
		problems.push('The initialize reply carries no protocolVersion.');
	}
	const list = frames.find((frame) => frame.id === 2);
	const advertised = (list?.result?.tools ?? []).map((tool) => tool.name).sort();
	if (JSON.stringify(advertised) !== JSON.stringify(expected)) {
		problems.push(
			`tools/list advertised ${JSON.stringify(advertised)} and the registry declares ${JSON.stringify(expected)}.`,
		);
	}
	for (const tool of list?.result?.tools ?? []) {
		if (tool.inputSchema?.type !== 'object') {
			problems.push(`Tool "${tool.name}" has an inputSchema whose root type is not "object".`);
		}
	}

	return check('mcp handshake', advertised.length, 'tools', problems);
}

/** Both launchers are executable. A submodule checked out without the bit is unusable. */
function checkModes(root) {
	const problems = [];
	let examined = 0;
	const { launcher, start } = paths(root);
	for (const path of [launcher, start]) {
		let mode;
		try {
			mode = statSync(path).mode;
		} catch {
			problems.push(`${path} is missing.`);
			continue;
		}
		examined += 1;
		if ((mode & 0o111) === 0) problems.push(`${path} is not executable.`);
	}
	return check('launchers', examined, 'launchers', problems);
}

export async function run_(root = ROOT) {
	let tools;
	try {
		tools = catalogue(root);
	} catch (error) {
		// `not-run` rather than a failure with a count of zero. The catalogue is what says
		// how many commands and tools there should be, so without it this guard has no
		// verdict to give rather than a bad one.
		return [
			notRun(
				'help',
				'commands',
				`kit/schema/tools-1.json could not be read (${error.message}). Run \`pnpm schemas\`.`,
			),
		];
	}
	return [checkHelp(root, tools), checkJson(root), await checkMcp(root, tools), checkModes(root)];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	renderAndExit('hexdocs command surface', await run_());
}
