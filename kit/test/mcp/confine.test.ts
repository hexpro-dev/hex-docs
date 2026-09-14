/**
 * A tool call cannot point the server outside the project it was started in, and a tool
 * runs only the recipes it declares.
 *
 * The step 8 review planted `apps/front/node_modules/.bin/react-router` under an absolute
 * root outside the server's working directory, called `docs_verify_install` with that
 * root, and the planted script ran, from a tool advertised as read-only and closed-world.
 * The first block reproduces that plant and proves both halves: through the CLI's own
 * context the script really does run, so the plant is live, and through the server it does
 * not, and nothing is spawned at all.
 *
 * The second block is about the recipes. `openWorldHint` is derived from a tool's `runs`,
 * and `runs` is only honest if the tool cannot reach a recipe it did not list, so the
 * tools that reach an open-world recipe are driven here through `callTool` against a
 * recording exec, and what they asked for is compared with what they declare.
 */

import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { APP_ROOT, CONSUMER_ROOT } from '../../../fixtures/index.js';
import type { Finding } from '../../../src/contracts/diagnostics.js';
import { verifyInstall } from '../../src/commands/verify-install.js';
import type { RecipeId } from '../../src/exec/recipes.js';
import { runRecipe, type Exec, type RunResult } from '../../src/exec/run.js';
import { ToolRefusal, pathProblems } from '../../src/mcp/confine.js';
import { callTool, serverContext, startServer } from '../../src/mcp/server.js';
import { invoke, type Ctx } from '../../src/registry/command.js';
import { BY_TOOL, TOOLS } from '../../src/registry/index.js';

const KIT_VERSION = '@hex-pro/docs-kit@0.0.0-confine';

let scratch: string;
/** The directory the server is started in. */
let project: string;
/** A directory beside it, holding the planted binary. */
let outside: string;

/**
 * A site whose React Router is a shell script that leaves a marker file behind.
 *
 * The marker is the measurement. A refusal that happened after the spawn would still
 * produce a refusal, and only a file on disk says whether the script ran.
 */
function plant(root: string): { marker: string } {
	const site = join(root, 'apps', 'front');
	const marker = join(root, 'RAN');
	mkdirSync(join(site, 'node_modules', '.bin'), { recursive: true });
	mkdirSync(join(site, 'app'), { recursive: true });
	writeFileSync(join(site, 'app', 'routes.ts'), 'export default [];\n');
	writeFileSync(join(site, 'package.json'), '{ "name": "planted", "private": true }\n');
	const binary = join(site, 'node_modules', '.bin', 'react-router');
	writeFileSync(binary, `#!/bin/sh\necho ran > "${marker}"\necho '{}'\n`);
	chmodSync(binary, 0o755);
	return { marker };
}

interface Recording {
	readonly exec: Exec;
	readonly calls: RecipeId[];
}

function recording(
	answer: (id: RecipeId) => RunResult = () => ({ status: 1, stdout: '', stderr: 'recorded' }),
): Recording {
	const calls: RecipeId[] = [];
	return {
		calls,
		exec: (id) => {
			calls.push(id);
			return answer(id);
		},
	};
}

function serverWith(exec: Exec): Ctx {
	return { ...serverContext(project, KIT_VERSION), exec };
}

/** The refusal a call rejected with, parsed the way a client reads it. */
async function refusalOf(call: Promise<string>): Promise<{ tool: string; findings: Finding[] }> {
	let thrown: unknown;
	try {
		await call;
	} catch (error) {
		thrown = error;
	}
	expect(thrown, 'the call was not refused').toBeInstanceOf(ToolRefusal);
	return JSON.parse((thrown as Error).message) as { tool: string; findings: Finding[] };
}

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'hexdocs-confine-'));
	project = join(scratch, 'project');
	outside = join(scratch, 'outside');
	mkdirSync(project, { recursive: true });
	mkdirSync(outside, { recursive: true });
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('a root outside the project', () => {
	test('the planted binary is live: the CLI context, which a person drives, runs it', async () => {
		// The positive control. Without it the assertion below that nothing ran is satisfied by
		// a plant that could never have run, and the whole block proves nothing.
		const evil = join(outside, 'cli-control');
		const { marker } = plant(evil);
		const ctx: Ctx = { ...serverContext(project, KIT_VERSION), exec: runRecipe, write: null };
		await invoke(verifyInstall, { root: evil, site: 'apps/front' }, ctx);
		expect(existsSync(marker)).toBe(true);
	});

	test('docs_verify_install is refused before anything runs, through the real server context', async () => {
		const evil = join(outside, 'server');
		const { marker } = plant(evil);
		// The call is settled before anything about it is asserted, so the marker is read first:
		// against the server this replaced, the call succeeds and the marker is what says why
		// that is a failure.
		const call = callTool(
			'docs_verify_install',
			{ root: evil, site: 'apps/front' },
			serverContext(project, KIT_VERSION),
		);
		await call.catch(() => undefined);
		expect(existsSync(marker), 'the planted react-router ran').toBe(false);
		const refusal = await refusalOf(call);
		expect(refusal.tool).toBe('docs_verify_install');
		expect(refusal.findings).toHaveLength(1);
		const finding = refusal.findings[0] as Finding;
		expect([finding.rule, finding.severity, finding.category]).toEqual([
			'mcp-path-outside-project',
			'error',
			'config',
		]);
		expect(finding.message).toContain(`root ${JSON.stringify(evil)} resolves to`);
		expect(finding.message).toContain('outside the project this server was started in');
		expect(finding.consequence).toContain('react-router');
		expect(finding.remediation).toContain('inside the directory the server was started in');
	});

	test('every tool that takes a root refuses one outside the project, and spawns nothing', async () => {
		const evil = join(outside, 'every-tool');
		plant(evil);
		let refused = 0;
		for (const command of TOOLS) {
			if (!('root' in command.params)) continue;
			const recorder = recording();
			const args: Record<string, unknown> = {
				root: evil,
				site: 'apps/front',
				slug: 'index',
				kind: 'page',
				project: 'fixture-app',
				commit: 'a'.repeat(40),
				version: '9.9.9',
			};
			const refusal = await refusalOf(
				callTool(command.tool as string, args, serverWith(recorder.exec)),
			);
			expect({ tool: command.tool, rule: refusal.findings[0]?.rule }).toEqual({
				tool: command.tool,
				rule: 'mcp-path-outside-project',
			});
			expect({ tool: command.tool, calls: recorder.calls }).toEqual({
				tool: command.tool,
				calls: [],
			});
			refused += 1;
		}
		// Seven of the nine take a root. `docs_bundle` and `docs_skills` do not, and a sweep
		// that matched none would pass on an empty loop.
		expect(refused).toBe(7);
	});

	test('the refusal reaches a client as a tool error carrying the finding', async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let written = '';
		output.on('data', (chunk: Buffer) => {
			written += chunk.toString('utf8');
		});
		const finished = startServer({ input, output }, serverWith(recording().exec));
		input.write(
			`${JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'docs_doctor', arguments: { root: outside } },
			})}\n`,
		);
		input.end();
		await finished;
		const reply = JSON.parse(written.trim()) as {
			result: { isError?: boolean; content: { text: string }[] };
		};
		expect(reply.result.isError).toBe(true);
		const body = JSON.parse(reply.result.content[0]?.text ?? '') as {
			refused: boolean;
			findings: Finding[];
		};
		expect(body.refused).toBe(true);
		expect(body.findings[0]?.rule).toBe('mcp-path-outside-project');
	});
});

describe('what counts as outside', () => {
	const verify = (): (typeof TOOLS)[number] =>
		BY_TOOL.get('docs_verify_install') as (typeof TOOLS)[number];

	test('a relative root, an absolute root and a site inside the project are all inside', () => {
		mkdirSync(join(project, 'apps', 'front'), { recursive: true });
		expect(pathProblems(verify(), { site: 'apps/front' }, project)).toEqual([]);
		expect(pathProblems(verify(), { root: '.', site: 'apps/front' }, project)).toEqual([]);
		expect(pathProblems(verify(), { root: project, site: 'apps/front' }, project)).toEqual([]);
		// A path that does not exist yet is compared through the part of it that does.
		expect(pathProblems(verify(), { root: 'not/yet/there', site: 'apps/front' }, project)).toEqual(
			[],
		);
	});

	test('a ".." segment is refused even when the path comes back inside', () => {
		mkdirSync(join(project, 'sub'), { recursive: true });
		expect(pathProblems(verify(), { root: 'sub/..', site: 'apps/front' }, project)).toEqual([
			'root "sub/.." has a ".." segment, which a tool call is refused however it resolves.',
		]);
		expect(pathProblems(verify(), { site: 'apps\\..\\apps\\front' }, project)).toEqual([
			'site "apps\\\\..\\\\apps\\\\front" has a ".." segment, which a tool call is refused however it resolves.',
		]);
	});

	test('a site outside is refused when the root is inside', () => {
		const problems = pathProblems(
			verify(),
			{ root: '.', site: join(outside, 'apps', 'front') },
			project,
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/^site ".*" resolves to .*, which is outside the project/);
	});

	test('a symbolic link inside the project that leads out of it is outside', () => {
		const link = join(project, 'escape');
		if (!existsSync(link)) symlinkSync(outside, link);
		const problems = pathProblems(verify(), { root: 'escape', site: 'apps/front' }, project);
		expect(problems).toHaveLength(2);
		expect(problems[0]).toMatch(/^root "escape" resolves to .*outside/);
	});

	test('a sibling whose name starts with the project name is outside', () => {
		// `/x/project-evil` begins with `/x/project` as a string. A prefix comparison without a
		// separator calls it inside.
		const sibling = `${project}-evil`;
		mkdirSync(sibling, { recursive: true });
		expect(pathProblems(verify(), { root: sibling, site: 'apps/front' }, project)).toHaveLength(2);
	});

	test('a directory inside the project whose name starts with two dots is inside', () => {
		mkdirSync(join(project, '..hidden', 'apps', 'front'), { recursive: true });
		expect(
			pathProblems(verify(), { root: join(project, '..hidden'), site: 'apps/front' }, project),
		).toEqual([]);
	});

	test('a tool with no root or site has nothing to confine', () => {
		const skills = BY_TOOL.get('docs_skills') as (typeof TOOLS)[number];
		expect(pathProblems(skills, { root: outside }, project)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

describe('a tool reaches only the recipes it declares', () => {
	test('docs_verify_install asks for exactly its declared recipes, over the route table and the gitlink', async () => {
		const site = join(project, 'wired', 'apps', 'front');
		mkdirSync(join(site, 'node_modules', '.bin'), { recursive: true });
		writeFileSync(join(site, 'node_modules', '.bin', 'react-router'), '#!/bin/sh\n');
		mkdirSync(join(site, 'app'), { recursive: true });
		writeFileSync(join(site, 'app', 'routes.ts'), 'export default [];\n');
		writeFileSync(join(site, 'package.json'), '{ "name": "wired", "private": true }\n');
		writeFileSync(
			join(project, 'wired', '.gitmodules'),
			'[submodule "common/docs"]\n\tpath = common/docs\n\turl = https://example.com/docs.git\n',
		);
		mkdirSync(join(project, 'wired', 'common', 'docs'), { recursive: true });
		const recorder = recording();
		await callTool(
			'docs_verify_install',
			{ root: 'wired', site: 'apps/front' },
			serverWith(recorder.exec),
		);
		expect([...new Set(recorder.calls)].sort()).toEqual([
			'git.ls-files-stage',
			'react-router.routes',
		]);
		const declared = BY_TOOL.get('docs_verify_install');
		expect(declared?.tool === null ? [] : [...(declared?.runs ?? [])].sort()).toEqual([
			'git.ls-files-stage',
			'react-router.routes',
		]);
	});

	test('docs_label asks for AWS, GitHub and git, all of them declared', async () => {
		vi.stubEnv('AWS_PROFILE', 'confine-test');
		vi.stubEnv('HEXDOCS_BUCKET', 'a-bucket-that-is-not-real');
		const web = join(project, 'web');
		const config = join(web, 'apps', 'front', 'app', 'docs', 'fixture-app.docs.json');
		mkdirSync(dirname(config), { recursive: true });
		cpSync(join(CONSUMER_ROOT, 'fixture-app.docs.json'), config);
		const clone = join(project, 'clone');
		mkdirSync(join(clone, 'docs', 'site'), { recursive: true });
		cpSync(join(APP_ROOT, 'docs', 'site', 'docs.json'), join(clone, 'docs', 'site', 'docs.json'));

		const recorder = recording((id) =>
			id === 'aws.head-object'
				? {
						status: 254,
						stdout: '',
						stderr: 'An error occurred (404) when calling the HeadObject operation',
					}
				: id === 'git.merge-base-is-ancestor'
					? { status: 0, stdout: '', stderr: '' }
					: { status: 1, stdout: '', stderr: 'gh: unreachable' },
		);
		await callTool(
			'docs_label',
			{
				root: 'web',
				project: 'fixture-app',
				commit: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c',
				version: '2.0.0',
				'source-repo': clone,
				cache: join(scratch, 'empty-cache'),
			},
			serverWith(recorder.exec),
		);
		const label = BY_TOOL.get('docs_label');
		const declared = label?.tool === null ? [] : [...(label?.runs ?? [])];
		expect([...new Set(recorder.calls)].sort()).toEqual([...declared].sort());
		expect(declared.sort()).toEqual(['aws.head-object', 'gh.api', 'git.merge-base-is-ancestor']);
	});

	test('a recipe outside the tool runs list is refused inside the call, even when another tool declares it', async () => {
		// `docs_doctor` declares the route table and `docs_check` does not, so a check call that
		// reached it would widen what the server does without its annotation moving. The
		// narrowed exec is private to `callTool`, so the command behind `docs_check` is swapped
		// for one that asks for the route table, for the length of this test and no longer: the
		// registry map is the one `callTool` dispatches through, and the swap is put back in a
		// `finally` so a failure here cannot leak into another file's view of it.
		const seen: string[] = [];
		const ctx = serverWith((id) => {
			seen.push(id);
			return { status: 1, stdout: '', stderr: '' };
		});
		const registry = BY_TOOL as Map<string, (typeof TOOLS)[number]>;
		const check = registry.get('docs_check') as (typeof TOOLS)[number];
		registry.set('docs_check', {
			...check,
			run: (_input: never, inner: Ctx) => {
				let refusal = '';
				try {
					inner.exec('react-router.routes', [], { cwd: project });
				} catch (error) {
					refusal = (error as Error).message;
				}
				return Promise.resolve({ data: refusal, lines: [], envelope: null, rows: [] });
			},
		});
		try {
			const text = await callTool('docs_check', { root: '.' }, ctx);
			expect(JSON.parse(text)).toContain('docs_check does not run "react-router.routes"');
			expect(seen).toEqual([]);
		} finally {
			registry.set('docs_check', check);
		}
		expect(BY_TOOL.get('docs_check')).toBe(check);
	});
});
