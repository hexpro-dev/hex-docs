/**
 * `hexdocs build`, over the real corpus.
 *
 * Three properties, and each of them is one somebody would reasonably assume the other
 * way round.
 *
 * **The bundle is written even when the lint has errors.** The fixture corpus carries
 * seven planted errors on purpose and still has to compile, because refusing is the
 * publisher's job and a `build` that refused would make every golden test in this package
 * untestable. What the run owes instead is a sentence saying so and an exit code of 3, and
 * both are asserted here rather than left to the comment in `build.ts` that claims them.
 *
 * **A re-run writes nothing.** Not "writes the same bytes": nothing. `writeBundle` is
 * write-once, so the second run compares and returns, and the assertion is over the
 * modification times of every file on disk rather than over their contents. A writer that
 * rewrote identical bytes would pass a content comparison and would still be the thing
 * the write-once refusal exists to make impossible to do accidentally.
 *
 * **The exit code is never the command's decision.** Two independent things reach 3 here,
 * a non-empty envelope and a failing row, and the tests separate them: the lint-error case
 * asserts every row passed, so the 3 can only have come from the envelope.
 *
 * The corpus is materialised once. Running against `fixtures/app` directly would give
 * every file this repository's own single commit date, which is the shallow-clone failure
 * by accident, and it would also give the bundle a commit that changes on every commit to
 * hex-docs.
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

/**
 * A seam that lets one test see the arm no corpus can produce.
 *
 * `manifestProblems` is `validateManifestShape`, and every list it checks is filtered at
 * assembly in `kit/src/compile/build.ts`: `manifestNav` drops a nav entry whose slug is not
 * a page, `navOrder` filters the same way, and the redirect table drops both a target that
 * is not a page and a source that is. So there is no perturbation of the fixture tree that
 * makes it non-empty, and the arm that turns it into a failing row would sit unexercised.
 *
 * The mock delegates to the real compiler and replaces one field, so the command under
 * test is the real one and the only fabricated thing is the state it is being asked to
 * report on.
 */
const control = vi.hoisted(() => ({ problems: null as string[] | null }));

vi.mock('../../src/compile/build.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/compile/build.js')>();
	return {
		...actual,
		buildBundle: (root: string, options: Parameters<typeof actual.buildBundle>[1]) => {
			const result = actual.buildBundle(root, options);
			return control.problems === null ? result : { ...result, manifestProblems: control.problems };
		},
	};
});

import { materialiseCorpus } from '../../../fixtures/index.js';
import { MANIFEST_KEY, bundlePrefix } from '../../../src/contracts/manifest.js';
import { build } from '../../src/commands/build.js';
import { NO_EXEC } from '../../src/exec/run.js';
import { fileWriter } from '../../src/io/write.js';
import { exitCodeFor, invoke, type Ctx, type CommandOutput } from '../../src/registry/command.js';

// A real version string, because `bundleManifestSchema` holds `generator` to
// `@hex-pro/docs-kit@<major>.<minor>.<patch>` and a bundle this suite writes has to be one
// the schemas would accept.
const KIT_VERSION = '@hex-pro/docs-kit@0.0.1';

/** The seven the corpus plants on purpose. Pinned, so a corpus edit that loses one shows. */
const PLANTED_ERRORS = 7;

let scratch: string;
let corpus: string;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'hexdocs-build-'));
	corpus = materialiseCorpus(join(scratch, 'app')).root;
});

afterAll(() => {
	control.problems = null;
	rmSync(scratch, { recursive: true, force: true });
});

let outs = 0;

function outDir(): string {
	outs += 1;
	return join(scratch, `out-${outs}`);
}

function context(cwd: string): Ctx {
	return {
		cwd,
		kitVersion: KIT_VERSION,
		exec: NO_EXEC,
		write: fileWriter(),
		now: () => new Date('2026-06-01T00:00:00Z'),
		log: () => undefined,
	};
}

interface BuildData {
	prefix: string | null;
	written: number;
	unchanged: number;
	counts: { pages: number; locales: number; objects: number; bytes: number };
	manifestProblems: string[];
	built?: boolean;
	why?: string;
}

async function runBuild(root: string, out: string, extra: Record<string, unknown> = {}) {
	const output: CommandOutput = await invoke(build, { root, out, ...extra }, context(root));
	return { output, data: output.data as unknown as BuildData, exit: exitCodeFor(output) };
}

/** Every file under a directory, relative and sorted, with its modification time. */
function tree(root: string): Map<string, number> {
	const found = new Map<string, number>();
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const full = join(directory, entry.name);
			if (entry.isDirectory()) walk(full);
			else found.set(relative(root, full).split(sep).join('/'), statSync(full).mtimeMs);
		}
	};
	walk(root);
	return found;
}

// ---------------------------------------------------------------------------
// the bundle is written even when the lint has errors
// ---------------------------------------------------------------------------

describe('a tree that lints with errors', () => {
	/**
	 * One build for the three assertions below, because they are three readings of one
	 * run rather than three runs. A compile of the corpus is about half a second and the
	 * suite already has several files doing one in a hook, so a test that needed a fresh
	 * build would have to say why.
	 */
	let out: string;
	let once: Awaited<ReturnType<typeof runBuild>>;

	beforeAll(async () => {
		out = outDir();
		once = await runBuild(corpus, out);
	});

	test('still compiles, still writes, and says which of those happened', () => {
		const { output, data, exit } = once;

		expect(output.envelope?.summary.errors).toBe(PLANTED_ERRORS);
		// Written, not refused. The corpus is the case that makes this concrete: seven
		// planted errors, and the bundle every golden test in this package reads.
		expect(data.written).toBeGreaterThan(0);
		expect(data.prefix).not.toBeNull();
		expect(existsSync(join(data.prefix as string, MANIFEST_KEY))).toBe(true);

		// And the run says so, in the sentence a person reads, naming whose decision it is.
		const lines = output.lines.join('\n');
		expect(lines).toContain(`written with ${PLANTED_ERRORS} lint error(s)`);
		expect(lines).toContain('a decision for the publish step');

		expect(exit).toBe(3);
	});

	test('the 3 comes from the envelope, because every row passed', () => {
		const { output, exit } = once;
		// The two halves of `exitCodeFor` separated. If a row had failed as well this test
		// would say nothing about which one produced the code.
		expect(output.rows.map((row) => row.status)).toEqual(['pass', 'pass']);
		expect(output.rows.map((row) => row.id)).toEqual(['build-manifest', 'build-objects']);
		expect(exit).toBe(3);
	});

	test('the prefix is the layout the bucket uses, derived from the manifest', () => {
		const { data } = once;
		// The manifest is the authority on the project and the commit, and the on-disk layout
		// is the key layout, so a publish is a copy rather than a translation.
		const manifest = JSON.parse(
			readFileSync(join(data.prefix as string, MANIFEST_KEY), 'utf8'),
		) as { project: string; commit: string; ast: number; generator: string };
		expect(data.prefix).toBe(
			join(out, bundlePrefix(manifest.project, manifest.commit, manifest.ast)),
		);
		// `generator` is the one build-identity field a manifest keeps, and it comes from the
		// context rather than from a literal in the compiler.
		expect(manifest.generator).toBe(KIT_VERSION);
	});
});

// ---------------------------------------------------------------------------
// a re-run
// ---------------------------------------------------------------------------

describe('running twice into the same directory', () => {
	test('reports every object unchanged and touches no file', async () => {
		const out = outDir();
		const first = await runBuild(corpus, out);
		const prefix = first.data.prefix as string;
		const before = tree(prefix);

		const second = await runBuild(corpus, out);

		expect(second.data.written).toBe(0);
		expect(second.data.unchanged).toBe(first.data.written);
		expect(second.data.prefix).toBe(prefix);

		// Nothing on disk moved. Modification times rather than contents, because a writer
		// that rewrote identical bytes would pass a content comparison and would still have
		// written over a published bundle.
		const after = tree(prefix);
		expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
		for (const [path, mtime] of before) expect(after.get(path)).toBe(mtime);

		// Still a pass, and still counting what it compared rather than what it wrote.
		const row = second.output.rows.find((entry) => entry.id === 'build-objects');
		expect(row?.status).toBe('pass');
		expect(row?.examined).toBe(before.size);
	});

	test('the object count is keys, which is one more than the manifest counts', async () => {
		const out = outDir();
		const { data, output } = await runBuild(corpus, out);
		// `manifest.counts.objects` does not count the manifest, which is a key like any
		// other on disk. The difference is exactly one, and a row that reported the manifest
		// count would be a row that stopped noticing a manifest that failed to write.
		expect(data.written + data.unchanged).toBe(data.counts.objects + 1);
		expect(output.rows.find((row) => row.id === 'build-objects')?.examined).toBe(
			data.counts.objects + 1,
		);
		expect(data.counts.pages).toBe(8);
		expect(data.counts.locales).toBe(7);
	});
});

// ---------------------------------------------------------------------------
// drafts
// ---------------------------------------------------------------------------

test('--include-drafts reaches the compiler rather than being accepted and dropped', async () => {
	const without = await runBuild(corpus, outDir());
	const with_ = await runBuild(corpus, outDir(), { 'include-drafts': true });
	// The corpus carries one draft, which is the whole point of it carrying one.
	expect(with_.data.counts.pages).toBe(without.data.counts.pages + 1);
});

// ---------------------------------------------------------------------------
// the manifest's own invariants
// ---------------------------------------------------------------------------

describe('a manifest whose own invariants report a problem', () => {
	test('fails the run and names them, with the bundle still on disk', async () => {
		control.problems = [
			'nav names "guide/ghost", which is not a page in this bundle.',
			'redirects sends "old" to "gone", which is not a page in this bundle.',
		];
		try {
			const out = outDir();
			const { output, data, exit } = await runBuild(corpus, out);

			const row = output.rows.find((entry) => entry.id === 'build-manifest');
			expect(row?.status).toBe('fail');
			expect(row?.examined).toBe(2);
			expect(row?.unit).toBe('problems');
			expect(row?.note).toContain('guide/ghost');
			expect(row?.note).toContain('redirects sends "old"');
			expect(data.manifestProblems).toHaveLength(2);

			// Every one of them is a slug a reader would follow to something that is not
			// there, so the bytes being well formed is not a pass.
			expect(exit).toBe(3);
			// And the bundle is still written, because writing and refusing are separate
			// decisions and only one of them belongs to this command.
			expect(data.written).toBeGreaterThan(0);
			expect(existsSync(join(data.prefix as string, MANIFEST_KEY))).toBe(true);
		} finally {
			control.problems = null;
		}
	});

	test('and an empty list is a pass over one manifest, not over zero of them', async () => {
		const { output } = await runBuild(corpus, outDir());
		const row = output.rows.find((entry) => entry.id === 'build-manifest');
		expect(row?.status).toBe('pass');
		// `checkRow` turns a zero into a failure, so the count has to be the one manifest
		// that was examined rather than the zero problems it had.
		expect(row?.examined).toBe(1);
		expect(row?.unit).toBe('manifests');
	});
});

// ---------------------------------------------------------------------------
// inputs the compiler cannot read
// ---------------------------------------------------------------------------

describe('a tree that cannot be compiled', () => {
	test('a checkout with no git history is a not-run row, not a stack trace', async () => {
		const bare = join(scratch, 'no-history');
		cpSync(corpus, bare, { recursive: true, dereference: false, verbatimSymlinks: true });
		rmSync(join(bare, '.git'), { recursive: true, force: true });

		const { output, data, exit } = await runBuild(bare, outDir());
		expect(data.built).toBe(false);
		expect(data.why).toContain('commit-addressed');
		expect(output.rows.map((row) => row.status)).toEqual(['not-run']);
		expect(output.rows[0]?.id).toBe('build');
		expect(output.envelope).toBeNull();
		// A `not-run` row fails the run. "I could not read the tree" and "the tree is broken"
		// are both "no verdict, and it is not clean".
		expect(exit).toBe(3);
	});

	test('a directory that is not a documentation tree names the file it could not load', async () => {
		const empty = join(scratch, 'not-a-tree');
		mkdirSync(empty, { recursive: true });

		const { output, data, exit } = await runBuild(empty, outDir());
		expect(data.built).toBe(false);
		expect(data.why ?? '').not.toBe('');
		expect(output.rows.map((row) => row.status)).toEqual(['not-run']);
		expect(exit).toBe(3);
	});
});
