#!/usr/bin/env node
/**
 * The command surface, exercised through the launcher rather than through an import.
 *
 * Every other assertion about the CLI is a vitest test that imports the modules directly.
 * That covers the logic and covers none of the path every consumer actually uses: the
 * shell script, its first-run install probe, tsx resolution, the process exit code, and
 * whether stdout stays clean when the same launcher is serving a protocol.
 *
 * Five rows, and the third is the one worth having. `hexdocs mcp` writes JSON-RPC to
 * stdout, so a single stray line from anything else in the process is a parse error the
 * client reports as a broken server with no cause attached. Nothing else in this
 * repository tests that, and it is the failure the launcher's stderr redirect exists for.
 * The fifth is the only row that runs the launcher's first-run install at all.
 *
 * Zero dependencies, plain `.mjs`, because it runs from the ladder and reads the emitted
 * catalogue rather than importing TypeScript.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { check, notRun, renderAndExit, skipped } from './lib/report.mjs';

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

/**
 * The launcher's first run, in the shape a consuming site gives it.
 *
 * Every other row runs a launcher whose `node_modules` already exists, so the install
 * branch at the top of `kit/bin/hexdocs` never executes anywhere in the ladder. That branch
 * is the one a fresh checkout meets, and the one a working copy that persists between builds
 * meets after a submodule bump that changes the kit's dependencies. Step 8 found it broken in
 * hex-web's shape: without `--ignore-workspace`, pnpm walks up from the kit to the site's
 * workspace root and installs that instead.
 *
 * So the kit is copied without its `node_modules` to `common/docs/kit` inside a throwaway
 * pnpm workspace that excludes the mount the way hex-web's does, and `--help` is run from
 * the site directory with stdin closed and `CI` set, which is what the deploy's build step
 * gives it. Asserted of the first run: the exit code and the command list; output
 * byte-identical, on both streams, to a second run once the kit is installed, so the install
 * added nothing to either (the deploy reports the tail of stderr, and install chatter there
 * would bury the row that says why a build failed); no `node_modules` at the workspace root;
 * and exactly the packages `dependencies` names at the top of the kit's tree, so a
 * devDependency reaching a consumer is a failure rather than a larger install nobody sees.
 *
 * Then three more runs against the installed kit, each after `package.json` changes, which is
 * what a submodule bump that touches the kit's dependencies looks like from here. A tree the
 * launcher installed is reinstalled, silently on both streams. A tree whose pnpm metadata no
 * longer matches the launcher's stamp, and a tree with no stamp at all, are left alone: those
 * are trees somebody else installed, a development install among them, and the launcher's
 * `--prod` install would strip its devDependencies. The metadata change is simulated by
 * rewriting the stamp's second line rather than by running a full install, which would make
 * the row depend on the store holding every devDependency. Whether an install ran is read
 * from the mtime of `node_modules/.modules.yaml`, which pnpm rewrites on every install,
 * including one with nothing to do (measured on pnpm 10.33).
 *
 * The install is forced offline through `npm_config_offline`, which pnpm reads as its own
 * setting (measured: an empty store then fails with `ERR_PNPM_NO_OFFLINE_TARBALL`). A
 * ladder row that reached the registry would pass or fail on the network. The flags under
 * test are unaffected. A store without the kit's packages is `SKIPPED` with that reason,
 * and so is a machine with no pnpm; both are `FAIL` with `CI` set, because the job installs
 * the kit with pnpm before this runs and so has both.
 *
 * @param {string} root
 * @returns {import('./lib/report.mjs').CheckResult}
 */
export function checkFirstRun(root) {
	const name = 'first run';
	const unit = 'installs';
	const unusable = (reason) =>
		process.env.CI === 'true'
			? check(name, 0, unit, [
					`${reason} CI installs the kit with pnpm before the ladder runs, so this is a broken environment rather than a skip.`,
				])
			: skipped(name, unit, reason);

	const probe = spawnSync('pnpm', ['--version'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (probe.error !== undefined || probe.status !== 0) {
		return unusable('pnpm is not on PATH, so the first-run install cannot be exercised.');
	}

	const workspace = mkdtempSync(join(tmpdir(), 'hexdocs-first-run-'));
	try {
		writeFileSync(
			join(workspace, 'pnpm-workspace.yaml'),
			"packages:\n  - 'apps/*'\n  - '!common/docs'\n",
			'utf8',
		);
		writeFileSync(
			join(workspace, 'package.json'),
			`${JSON.stringify({ name: 'first-run-probe', private: true }, null, '\t')}\n`,
			'utf8',
		);
		const site = join(workspace, 'apps', 'front');
		mkdirSync(site, { recursive: true });
		writeFileSync(
			join(site, 'package.json'),
			`${JSON.stringify({ name: 'front', private: true }, null, '\t')}\n`,
			'utf8',
		);
		// The kit, and the runtime half beside it that the kit imports from `../../../src`.
		// Dereferenced, because a test copy of this repository links trees in rather than
		// copying them, and a link here would carry the probe's writes back into the original.
		const mount = join(workspace, 'common', 'docs');
		const skip = new Set(['node_modules', 'coverage']);
		for (const tree of ['kit', 'src']) {
			cpSync(join(root, tree), join(mount, tree), {
				recursive: true,
				dereference: true,
				filter: (source) => !skip.has(basename(source)),
			});
		}

		const env = { ...process.env, CI: 'true', NO_COLOR: '1', npm_config_offline: 'true' };
		delete env.HEXDOCS_PROJECT_ROOT;
		const launch = () =>
			spawnSync(join(mount, 'kit', 'bin', 'hexdocs'), ['--help'], {
				cwd: site,
				encoding: 'utf8',
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 180_000,
			});
		const spawned = launch();

		const said = `${spawned.stdout}${spawned.stderr}`;
		if (spawned.status !== 0 && said.includes('ERR_PNPM_NO_OFFLINE_TARBALL')) {
			// The environment is unusable, and the launcher's failure branch still ran, so its
			// one stream promise is checked before the skip. A launcher that exits in the install
			// branch never reaches tsx, so any byte on stdout is install output on the stream
			// `hexdocs mcp` speaks JSON-RPC on, and the reason the install failed is then missing
			// from stderr, which is the stream the deploy reports.
			if (spawned.stdout !== '') {
				// The excerpt starts at pnpm's error code where there is one. pnpm prints its
				// progress lines first and the error last, and how many progress lines come first
				// varies from run to run, so the first 200 characters sometimes held the reason and
				// sometimes stopped short of it.
				const at = spawned.stdout.indexOf('ERR_PNPM_');
				const excerpt = at < 0 ? spawned.stdout.slice(-200) : spawned.stdout.slice(at, at + 200);
				return check(name, 1, unit, [
					`The failed install wrote ${spawned.stdout.length} characters to stdout, where \`hexdocs mcp\` speaks JSON-RPC, instead of to stderr: ${JSON.stringify(excerpt)}`,
				]);
			}
			return unusable(
				'The pnpm store on this machine does not hold the kit dependencies, and the install is run offline. Run `pnpm --dir kit install` once to fill it.',
			);
		}

		const problems = [];
		if (spawned.status !== 0) {
			const tail = said.trim().split('\n').slice(-6).join(' | ');
			problems.push(`The first run exited ${spawned.status}: ${tail}`);
		}
		if (helpNames(said).length === 0) {
			problems.push('The first run printed no command list.');
		}
		// Against a warm run rather than against an empty stream, because `--help` itself
		// writes to stderr. What must not be there is anything the install added.
		const warm = launch();
		for (const stream of /** @type {const} */ (['stdout', 'stderr'])) {
			const first = spawned[stream];
			const second = warm[stream];
			if (first !== second) {
				// What the first run added, wherever it put it, when the warm run's output is
				// still inside it; the whole of the first run's output when it is not.
				const extra = first.replace(second, '');
				problems.push(
					`The first run wrote ${first.length - second.length} more characters to ${stream} than a warm run, where a deploy's failure message is taken from: ${JSON.stringify(extra.slice(0, 200))}`,
				);
			}
		}
		if (existsSync(join(workspace, 'node_modules'))) {
			problems.push(
				'The install created node_modules at the workspace root, so it installed the consuming workspace rather than the kit.',
			);
		}
		const kit = join(mount, 'kit');
		const modules = join(kit, 'node_modules');
		if (!existsSync(join(modules, '.bin', 'tsx'))) {
			problems.push('The kit has no node_modules/.bin/tsx after its first run.');
			return check(name, 1, unit, problems);
		}

		const manifestPath = join(kit, 'package.json');
		const declared = Object.keys(
			JSON.parse(readFileSync(manifestPath, 'utf8')).dependencies ?? {},
		).sort();
		const installed = topLevelPackages(modules);
		const undeclared = installed.filter((entry) => !declared.includes(entry));
		const absent = declared.filter((entry) => !installed.includes(entry));
		if (undeclared.length > 0) {
			problems.push(
				`The first run installed ${undeclared.join(', ')} into the kit, and package.json does not list ${undeclared.length === 1 ? 'it' : 'them'} under dependencies, so a consumer pays for packages it never runs.`,
			);
		}
		if (absent.length > 0) {
			problems.push(
				`The first run did not install ${absent.join(', ')}, which dependencies lists.`,
			);
		}

		const stamp = join(modules, '.hexdocs-installed-from');
		if (!existsSync(stamp)) {
			problems.push(
				'The first run left no stamp at kit/node_modules/.hexdocs-installed-from, so no later change to the kit dependencies would reinstall the tree.',
			);
			return check(name, 1, unit, problems);
		}

		const metadata = join(modules, '.modules.yaml');
		const installedAt = () => statSync(metadata).mtimeMs;
		// A change to package.json, one byte at a time, so each run below sees a kit that is
		// not the one the stamp records.
		const bump = () =>
			writeFileSync(manifestPath, `${readFileSync(manifestPath, 'utf8')}\n`, 'utf8');

		const stampBefore = readFileSync(stamp, 'utf8');
		let at = installedAt();
		bump();
		const reinstalled = launch();
		if (installedAt() === at) {
			problems.push(
				'After package.json changed, the launcher did not reinstall a tree it had installed itself, so a submodule bump that adds a dependency ends in ERR_MODULE_NOT_FOUND on a working copy that persists.',
			);
		}
		if (readFileSync(stamp, 'utf8') === stampBefore) {
			problems.push(
				'The reinstall did not rewrite the stamp, so every later run reinstalls again.',
			);
		}
		if (reinstalled.status !== 0) {
			problems.push(`The run after package.json changed exited ${reinstalled.status}.`);
		}
		for (const stream of /** @type {const} */ (['stdout', 'stderr'])) {
			if (reinstalled[stream] !== warm[stream]) {
				problems.push(
					`The reinstall wrote ${reinstalled[stream].length - warm[stream].length} more characters to ${stream} than a warm run: ${JSON.stringify(reinstalled[stream].replace(warm[stream], '').slice(0, 200))}`,
				);
			}
		}

		const [inputs] = readFileSync(stamp, 'utf8').split('\n');
		const foreign = [
			{
				what: 'whose pnpm metadata no longer matches its stamp',
				plant: () => writeFileSync(stamp, `${inputs}\nnot the metadata this tree has\n`, 'utf8'),
			},
			{ what: 'with no stamp', plant: () => rmSync(stamp) },
		];
		for (const tree of foreign) {
			tree.plant();
			bump();
			at = installedAt();
			const left = launch();
			if (installedAt() !== at) {
				problems.push(
					`The launcher reinstalled a tree ${tree.what}, which is a tree somebody else installed. Its install is --prod, and over a development install that removes the devDependencies the test suite runs on.`,
				);
			}
			if (left.status !== 0) {
				problems.push(`The run over a tree ${tree.what} exited ${left.status}.`);
			}
		}

		return check(name, 2, unit, problems);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

/**
 * The packages at the top of a `node_modules`, with scoped names joined to their scope.
 *
 * Entries starting with a dot are pnpm's own (`.bin`, `.pnpm`, `.modules.yaml`) and the
 * launcher's stamp. With pnpm's isolated layout the top level holds exactly the direct
 * dependencies of the install, so this is the list `--prod` decides.
 *
 * @param {string} modules
 * @returns {string[]}
 */
function topLevelPackages(modules) {
	const found = [];
	for (const entry of readdirSync(modules)) {
		if (entry.startsWith('.')) continue;
		if (entry.startsWith('@')) {
			for (const scoped of readdirSync(join(modules, entry))) found.push(`${entry}/${scoped}`);
		} else {
			found.push(entry);
		}
	}
	return found.sort();
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
	return [
		checkHelp(root, tools),
		checkJson(root),
		await checkMcp(root, tools),
		checkModes(root),
		checkFirstRun(root),
	];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	renderAndExit('hexdocs command surface', await run_());
}
