/**
 * `hexdocs install`, and the one idea the whole install turns on.
 *
 * Row 3 of the failure catalogue is "install run twice gives a different result", and the
 * structure that answers it is not a re-run guard. It is that every edit's `present` is
 * the same function object the matching `wiring-*` check calls, so "already installed" and
 * "correctly installed" are one fact and there is no third state. That claim is only worth
 * anything if the sharing is asserted by **reference identity**: a copied predicate passes
 * every behavioural test there is and then drifts on the first change to either copy, which
 * is exactly the failure mode. So the identity assertions below use `===` on the function
 * objects, and the behavioural assertions sit beside them rather than instead of them.
 *
 * The second half is the one needles actually have to survive, and it is measured rather
 * than hoped for. `install` writes into somebody else's repository and that repository then
 * formats, lints and hand-edits the files it wrote. Every perturbation in `PERTURBATIONS`
 * is something a real consumer does, and each row records whether the needle survived it.
 * Three do not, and they are declared with the remedy the failing check hands the reader,
 * because a needle that breaks silently and a needle that breaks with a paste-able line are
 * different products.
 *
 * The fixture is the **unwired** consumer, which is the state `install` starts from. One
 * thing is added that is not docs wiring and is stated so it is not mistaken for it:
 * `deploy.config.json` gains a `sites` block, because `projectTypeOf` matches the site path
 * against `sites.*.projects.*.path` and both fixtures carry only a `hash` key, so without
 * it the deploy edit refuses for a reason that has nothing to do with the mount.
 */

import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
	CONSUMER_SHAPES,
	materialiseConsumer,
	removeConsumer,
	type ConsumerShape,
} from '../../../fixtures/consumers.js';
import type { CheckId } from '../../../src/contracts/lint.js';
import { install } from '../../src/commands/install.js';
import { runRecipe } from '../../src/exec/run.js';
import { fileWriter } from '../../src/io/write.js';
import { invoke } from '../../src/registry/command.js';
import { runConsumerChecks } from '../../src/wiring/checks.js';
import { detectSite } from '../../src/wiring/detect.js';
import { PRESENT, editById, editsFor, type Edit } from '../../src/wiring/edits.js';
import { parseJsonc } from '../../src/wiring/needles.js';
import type { SiteDescriptor } from '../../src/wiring/site.js';

const KIT_VERSION = '@hex-pro/docs-kit@0.0.0-test';

const MOUNT_OF: Record<ConsumerShape, string> = {
	'glob-workspace': 'common/docs',
	'literal-workspace': 'web/docs',
};

const SITE_OF: Record<ConsumerShape, string> = {
	'glob-workspace': 'apps/front',
	'literal-workspace': 'web/front',
};

interface Repo {
	readonly shape: ConsumerShape;
	readonly root: string;
	readonly site: string;
	readonly mount: string;
}

const read = (repo: Repo, path: string): string => readFileSync(join(repo.root, path), 'utf8');

function write(repo: Repo, path: string, text: string): void {
	const target = join(repo.root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, text, 'utf8');
}

function editJson(repo: Repo, path: string, edit: (value: Record<string, unknown>) => void): void {
	const value = parseJsonc(read(repo, path)) as Record<string, unknown>;
	edit(value);
	write(repo, path, `${JSON.stringify(value, null, '\t')}\n`);
}

function descriptorFor(repo: Repo): SiteDescriptor {
	return detectSite({ repoRoot: repo.root, site: repo.site, mount: repo.mount });
}

interface InstallResult {
	readonly edits: {
		id: string;
		check: string;
		file: string;
		state: string;
		instruction: string | null;
	}[];
	readonly written: string[];
}

async function runInstall(
	repo: Repo,
	write: boolean,
): Promise<{
	result: InstallResult;
	rows: readonly { id: string; status: string; note: string | null }[];
}> {
	const output = await invoke(
		install,
		{ root: repo.root, site: repo.site, mount: repo.mount, write },
		{
			cwd: repo.root,
			kitVersion: KIT_VERSION,
			exec: runRecipe,
			write: fileWriter(),
			now: () => new Date(0),
			log: () => {},
		},
	);
	return { result: output.data as unknown as InstallResult, rows: output.rows };
}

/** Every file under a tree, as bytes, keyed by its path relative to the root. */
function snapshot(root: string): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : 1,
		)) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.isFile()) continue;
			files.set(relative(root, path), readFileSync(path, 'base64'));
		}
	};
	walk(root);
	return files;
}

let scratch: string;
const TEMPLATES = new Map<ConsumerShape, string>();
let copies = 0;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), 'hexdocs-install-'));
	for (const shape of CONSUMER_SHAPES) {
		const consumer = materialiseConsumer(shape);
		const repo: Repo = {
			shape,
			root: consumer.root,
			site: consumer.site,
			mount: MOUNT_OF[shape],
		};
		editJson(repo, 'deploy.config.json', (value) => {
			value['sites'] = { main: { projects: { front: { path: repo.site } } } };
		});
		const template = join(scratch, `template-${shape}`);
		cpSync(consumer.root, template, { recursive: true, verbatimSymlinks: true });
		TEMPLATES.set(shape, template);
		removeConsumer(consumer);
	}
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function copy(shape: ConsumerShape): Repo {
	copies += 1;
	const root = join(scratch, `copy-${copies}`);
	cpSync(TEMPLATES.get(shape) as string, root, { recursive: true, verbatimSymlinks: true });
	return { shape, root, site: SITE_OF[shape], mount: MOUNT_OF[shape] };
}

// ---------------------------------------------------------------------------
// The claim table
// ---------------------------------------------------------------------------

/**
 * What `apply` does when it is handed its own output.
 *
 * Recorded rather than asserted uniformly, because "apply is idempotent" is a property the
 * contract does not claim: `Edit.apply` says "Never called when `present` is already true",
 * and `install`'s loop honours that. Two appliers do append a second time, and writing
 * `same-bytes` for all fifteen would be asserting a guarantee that does not exist while
 * hiding which two rely on the caller. The guarantee that does exist is the whole-table one
 * further down: install twice writes nothing the second time.
 */
type Reapply = 'same-bytes' | 'refuses' | 'appends-again';

interface Claim {
	readonly id: string;
	/** The `PRESENT` entry this edit must be carrying, compared with `===`. */
	readonly present: keyof typeof PRESENT;
	readonly check: CheckId;
	readonly byHand: boolean;
	readonly reapply: Reapply;
	/** Shapes on which the unwired fixture already satisfies this edit, and why. */
	readonly satisfiedOn?: Partial<Record<ConsumerShape, string>>;
	readonly why: string;
}

const CLAIMS: readonly Claim[] = [
	{
		id: 'submodule',
		present: 'submodule',
		check: 'wiring-submodule',
		byHand: true,
		reapply: 'refuses',
		why: 'Writing the stanza alone produces a declared submodule with no gitlink, and `git submodule add` refuses a path already in the index, so an append here would also break the command that fixes it.',
	},
	{
		id: 'workspace-exclusion',
		present: 'workspaceExclusion',
		check: 'wiring-workspace-exclusion',
		byHand: false,
		reapply: 'same-bytes',
		satisfiedOn: {
			'literal-workspace':
				'the packages list is explicit literals with no glob, so nothing enrols the mount and an exclusion would be inert decoration',
		},
		why: 'A workspace glob enrols the mount as a package, so pnpm install inside it installs the monorepo and ignores kit/pnpm-lock.yaml.',
	},
	{
		id: 'tsconfig-paths',
		present: 'tsconfigPaths',
		check: 'wiring-tsconfig-path',
		byHand: false,
		reapply: 'same-bytes',
		why: 'Without the mapping tsc and Vite disagree about the same specifier and the failure arrives as a resolution error inside a submodule during a deploy.',
	},
	{
		id: 'tsconfig-resolve-json',
		present: 'tsconfigResolveJson',
		check: 'wiring-tsconfig-path',
		byHand: true,
		reapply: 'refuses',
		satisfiedOn: {
			'glob-workspace':
				'this fixture sets the option in the site tsconfig rather than in a shared one',
		},
		why: 'On both real consumers the option is set in a shared config other packages extend, and an install scoped to one site has no business editing it.',
	},
	{
		id: 'deploy-hash-dirs',
		present: 'deployHashDirs',
		check: 'wiring-deploy-hash-dirs',
		byHand: false,
		reapply: 'appends-again',
		why: 'An unlisted submodule leaves the change-detection hash identical, the deploy reports unchanged, and production keeps serving the old code.',
	},
	{
		id: 'prebuild-hook',
		present: 'prebuildHook',
		check: 'wiring-prebuild-hook',
		byHand: false,
		reapply: 'appends-again',
		why: 'There is no CI on either consumer, so prebuild is the one thing that always runs.',
	},
	{
		id: 'check-docs-shim',
		present: 'checkDocsShim',
		check: 'wiring-prebuild-hook',
		byHand: false,
		reapply: 'same-bytes',
		why: 'The hook and the shim are the same guarantee one step apart, and the shim holds no copy of what is checked.',
	},
	{
		id: 'gitignore',
		present: 'gitignore',
		check: 'wiring-prebuild-hook',
		byHand: false,
		reapply: 'same-bytes',
		why: 'Both prefetch trees are build output. Committing them puts every page in every language into the site repository.',
	},
	{
		id: 'site-config',
		present: 'siteConfig',
		check: 'wiring-localised-paths',
		byHand: true,
		reapply: 'refuses',
		why: 'It needs a project id, a mount path and a label in seven languages that nothing here knows.',
	},
	{
		id: 'docs-lib',
		present: 'docsLib',
		check: 'wiring-localised-paths',
		byHand: false,
		reapply: 'refuses',
		why: 'Created, never rewritten. A file that exists and does not derive is a file somebody wrote, and this module own header invites that.',
	},
	{
		id: 'routes',
		present: 'routes',
		check: 'wiring-routes',
		byHand: true,
		reapply: 'refuses',
		why: 'A spread into a hand-authored array whose surrounding prose is the consuming repository actual documentation.',
	},
	{
		id: 'localised-paths',
		present: 'localisedPaths',
		check: 'wiring-localised-paths',
		byHand: true,
		reapply: 'refuses',
		why: 'One consumer has an array to spread into and the other has a readonly alias with nowhere to splice.',
	},
	{
		id: 'sitemap',
		present: 'sitemap',
		check: 'wiring-sitemap',
		byHand: true,
		reapply: 'refuses',
		why: 'One consumer has an entries array and the other maps a page registry directly.',
	},
	{
		id: 'mcp-json',
		present: 'mcpJson',
		check: 'wiring-mcp',
		byHand: false,
		reapply: 'refuses',
		why: 'A hexdocs entry present with a different command is somebody own wiring, and a second key of the same name is a file that parses to whichever came last.',
	},
	{
		id: 'mcp-settings',
		present: 'mcpSettings',
		check: 'wiring-mcp',
		byHand: true,
		reapply: 'refuses',
		why: 'Whether a local settings file merges with the project one or replaces it could not be established, and guessing wrong disables every other MCP server in the repository.',
	},
];

const claimOf = (id: string): Claim => {
	const claim = CLAIMS.find((entry) => entry.id === id);
	if (claim === undefined) throw new Error(`no claim for edit "${id}"`);
	return claim;
};

describe('the edit table and the claim table cover each other', () => {
	test.each(CONSUMER_SHAPES)('%s', (shape) => {
		const edits = editsFor(descriptorFor(copy(shape)));
		const declared = edits.map((edit) => edit.id).sort();
		const claimed = CLAIMS.map((claim) => claim.id).sort();
		expect(declared, 'an edit exists that no claim covers, or the reverse').toEqual(claimed);

		// And each claim says the right thing about the edit it names, so the table cannot
		// go stale in the reassuring direction while still covering every id.
		for (const edit of edits) {
			const claim = claimOf(edit.id);
			expect([edit.id, edit.check, edit.byHand === true]).toEqual([
				claim.id,
				claim.check,
				claim.byHand,
			]);
		}
	});

	test('every PRESENT entry is claimed by exactly one edit, in both directions', () => {
		// The direction that catches a predicate added to `PRESENT` and wired to nothing,
		// and the direction that catches an edit carrying a predicate that is not in the
		// shared table at all.
		const claimed = CLAIMS.map((claim) => claim.present);
		const keys = Object.keys(PRESENT) as (keyof typeof PRESENT)[];
		expect([...claimed].sort()).toEqual([...keys].sort());
		expect(new Set(claimed).size).toBe(claimed.length);
	});
});

// ---------------------------------------------------------------------------
// The identity, which is the whole of row 3
// ---------------------------------------------------------------------------

describe('the writer and the checker share one predicate', () => {
	test.each(CONSUMER_SHAPES)(
		'%s: every edit carries the PRESENT entry it claims, by ===',
		(shape) => {
			const edits = editsFor(descriptorFor(copy(shape)));
			let compared = 0;
			for (const edit of edits) {
				const claim = claimOf(edit.id);
				// `===` on the function objects, not a behavioural comparison. A copy such as
				// `present: (text, site) => PRESENT.workspaceExclusion(text, site)` answers every
				// question the same way and is a second place the rule lives, which is how the
				// writer and the checker come to disagree one edit at a time.
				expect(
					edit.present as unknown,
					`edit "${edit.id}" does not carry PRESENT.${claim.present}`,
				).toBe(PRESENT[claim.present] as unknown);
				compared += 1;
			}
			expect(compared).toBe(CLAIMS.length);
		},
	);

	test('two descriptors produce edits carrying the same function objects', () => {
		// `editsFor` builds a table per descriptor because half the instructions are shaped
		// to the consumer file in hand. The predicates must not be rebuilt with it: a
		// closure per descriptor would pass the assertion above and still be a fresh
		// function on every call, which is the same defect one level out.
		const first = editsFor(descriptorFor(copy('glob-workspace')));
		const second = editsFor(descriptorFor(copy('literal-workspace')));
		expect(first.map((edit) => edit.id)).toEqual(second.map((edit) => edit.id));
		for (let index = 0; index < first.length; index += 1) {
			const a = first[index] as Edit;
			const b = second[index] as Edit;
			expect(a.present as unknown, `"${a.id}" has a per-descriptor predicate`).toBe(
				b.present as unknown,
			);
		}
	});

	test('the checks read the same table the edits carry', () => {
		// The other end of the seam. `checks.ts` calls `PRESENT.<name>` directly rather than
		// reaching through `editsFor`, so the identity above only closes the loop if the two
		// modules are looking at one object. A copied `PRESENT` in `checks.ts` would give a
		// consumer whose row passes while `install` reports work to do; this asserts the
		// observable half of that, which is that the two answers agree on a tree where one
		// edit is applied and the rest are not.
		const repo = copy('glob-workspace');
		const before = detectSite({ repoRoot: repo.root, site: repo.site, mount: repo.mount });
		const gitignore = editById(before, 'gitignore') as Edit;
		const applied = gitignore.apply(before.files.read(gitignore.file), before);
		expect(applied).not.toBeNull();
		write(repo, gitignore.file, applied as string);

		const after = descriptorFor(repo);
		expect(
			(editById(after, 'gitignore') as Edit).present(after.files.read(gitignore.file), after),
		).toBe(true);
		const row = runConsumerChecks(after, { exec: runRecipe, kitVersion: KIT_VERSION }).find(
			(candidate) => candidate.id === 'wiring-prebuild-hook',
		);
		expect(
			row?.findings
				.map((finding) => finding.message)
				.filter((message) => /gitignore/.test(message)),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// present, apply, present again
// ---------------------------------------------------------------------------

describe('every edit answers present, apply and present again as its claim says', () => {
	const CASES = CONSUMER_SHAPES.flatMap((shape) =>
		CLAIMS.map((claim) => [`${shape}: ${claim.id}`, shape, claim] as const),
	);

	test.each(CASES)('%s', (_name, shape, claim) => {
		const repo = copy(shape);
		const site = descriptorFor(repo);
		const edit = editById(site, claim.id) as Edit;
		const text = site.files.read(edit.file);

		const satisfied = claim.satisfiedOn?.[shape];
		expect(
			edit.present(text, site),
			satisfied === undefined
				? `"${claim.id}" is already satisfied on an unwired ${shape}, which no claim declares`
				: `"${claim.id}" is declared already satisfied on ${shape} because ${satisfied}`,
		).toBe(satisfied !== undefined);
		if (satisfied !== undefined) return;

		const next = edit.apply(text, site);
		if (claim.byHand) {
			// A by-hand edit refuses unconditionally. It is printed, not written, and the
			// instruction is what a person acts on, so it has to say something.
			expect(next, `"${claim.id}" is by hand and its applier produced text`).toBeNull();
			expect(edit.instruction.length).toBeGreaterThan(80);
			return;
		}

		expect(
			next,
			`"${claim.id}" refused to apply on an unwired ${shape}. ${claim.why}`,
		).not.toBeNull();
		// The applier's output has to satisfy the applier's own predicate. This is the one
		// disagreement between install and verify-install the design exists to make
		// impossible, and `install` re-runs the predicate for exactly this reason.
		expect(
			edit.present(next as string, site),
			`"${claim.id}" produced text it does not accept`,
		).toBe(true);

		const again = edit.apply(next as string, site);
		const observed: Reapply =
			again === null ? 'refuses' : again === next ? 'same-bytes' : 'appends-again';
		expect(observed, `"${claim.id}" changed what it does when handed its own output`).toBe(
			claim.reapply,
		);
	});
});

// ---------------------------------------------------------------------------
// The whole table, twice
// ---------------------------------------------------------------------------

describe('install run twice', () => {
	test.each(CONSUMER_SHAPES)(
		'%s: the second pass writes nothing and changes no byte',
		async (shape) => {
			const repo = copy(shape);
			const first = await runInstall(repo, true);
			expect(first.result.written.length).toBeGreaterThan(0);
			const after = snapshot(repo.root);

			const second = await runInstall(repo, true);
			expect(second.result.written, 'the second install wrote something').toEqual([]);
			expect(snapshot(repo.root), 'the second install changed a byte').toEqual(after);

			// Every mechanical edit reports `unchanged`, which is the visible half of the same
			// fact: `present` answered true from disk, so the applier was never reached.
			const mechanical = second.result.edits.filter((edit) => !claimOf(edit.id).byHand);
			expect(mechanical.map((edit) => `${edit.id}:${edit.state}`).sort()).toEqual(
				mechanical.map((edit) => `${edit.id}:unchanged`).sort(),
			);
			expect(mechanical.length).toBe(CLAIMS.filter((claim) => !claim.byHand).length);
		},
	);

	test.each(CONSUMER_SHAPES)(
		'%s: a dry run after a real one changes nothing and reports unchanged',
		async (shape) => {
			const repo = copy(shape);
			await runInstall(repo, true);
			const after = snapshot(repo.root);

			const dry = await runInstall(repo, false);
			expect(dry.result.written).toEqual([]);
			expect(snapshot(repo.root)).toEqual(after);
			expect(dry.result.edits.filter((edit) => edit.state === 'planned')).toEqual([]);
		},
	);

	test.each(CONSUMER_SHAPES)(
		'%s: a dry run before writing plans exactly what the write then writes',
		async (shape) => {
			// The plan a person reads is produced by the applying code path, so the two lists
			// have to be the same list. A separate "describe what I would do" branch is how a
			// dry run and a real run come to disagree.
			const planning = copy(shape);
			const dry = await runInstall(planning, false);
			const planned = dry.result.edits
				.filter((edit) => edit.state === 'planned')
				.map((edit) => edit.id)
				.sort();
			expect(planned.length).toBeGreaterThan(0);
			expect(snapshot(planning.root)).toEqual(snapshot(TEMPLATES.get(shape) as string));

			const applying = copy(shape);
			const wet = await runInstall(applying, true);
			const written = wet.result.edits
				.filter((edit) => edit.state === 'written')
				.map((edit) => edit.id)
				.sort();
			expect(written).toEqual(planned);
		},
	);
});

// ---------------------------------------------------------------------------
// A refusal aborts one edit and nothing else
// ---------------------------------------------------------------------------

describe('an anchor that is missing or not unique', () => {
	test.each(CONSUMER_SHAPES)(
		'%s: refuses that edit, writes nothing for it, applies the rest',
		async (shape) => {
			const repo = copy(shape);

			// Missing: no tsconfig at all, so the applier is handed `null`.
			rmSync(join(repo.root, repo.site, 'tsconfig.json'));
			// Not unique: two `mcpServers` keys, so `soleBlock` cannot say which one an insert
			// belongs in. Inserting into whichever came first is how an edit lands in a block the
			// reader was not looking at.
			const mcpBefore = '{\n\t"mcpServers": {},\n\t"other": { "mcpServers": {} }\n}\n';
			write(repo, '.mcp.json', mcpBefore);

			const site = descriptorFor(repo);
			expect((editById(site, 'tsconfig-paths') as Edit).apply(null, site)).toBeNull();
			expect((editById(site, 'mcp-json') as Edit).apply(mcpBefore, site)).toBeNull();

			const { result, rows } = await runInstall(repo, true);
			const state = (id: string): string =>
				result.edits.find((edit) => edit.id === id)?.state ?? 'absent';
			expect([state('tsconfig-paths'), state('mcp-json')]).toEqual(['refused', 'refused']);

			// A refusal is printed with the instruction a person then follows, so it must not be
			// null: a boolean tells somebody the edit did not happen and only the text tells them
			// what to do instead.
			for (const id of ['tsconfig-paths', 'mcp-json']) {
				expect(
					(result.edits.find((edit) => edit.id === id)?.instruction ?? '').length,
				).toBeGreaterThan(80);
			}

			// Neither target was touched.
			expect(read(repo, '.mcp.json')).toBe(mcpBefore);
			expect(result.written.some((path) => path.endsWith('.mcp.json'))).toBe(false);
			expect(result.written.some((path) => path.endsWith('tsconfig.json'))).toBe(false);

			// And every other mechanical edit still happened. A refusal that aborted the run
			// would leave a consumer half wired with no row saying which half.
			const others = CLAIMS.filter(
				(claim) => !claim.byHand && claim.id !== 'tsconfig-paths' && claim.id !== 'mcp-json',
			).filter((claim) => claim.satisfiedOn?.[shape] === undefined);
			expect(others.map((claim) => `${claim.id}:${state(claim.id)}`)).toEqual(
				others.map((claim) => `${claim.id}:written`),
			);

			// The row is a failure, not a note. A command that reported success here would be
			// reporting it over an install that is not finished.
			const row = rows.find((candidate) => candidate.id === 'install-writes');
			expect(row?.status).toBe('fail');
			expect(row?.note ?? '').toMatch(/tsconfig-paths/);
			expect(row?.note ?? '').toMatch(/mcp-json/);
		},
	);

	test('an applier whose output its own predicate rejects refuses rather than writing it', () => {
		// The third refusal, and the only one where the anchor was found and the edit still
		// must not land. `install` re-runs the predicate over the applier's output for exactly
		// this: an edit that inserted the right text in the wrong place would report success
		// and `verify-install` would then report the same row as failing, which is the one
		// disagreement between the two commands this design exists to make impossible.
		//
		// The state that produces it is a real one rather than a contrived one, and it is a
		// defect in `insertIntoBlock` that this guard is currently the only thing catching.
		// `lastNonBlankBefore` walks the **original** text, so when the last thing inside the
		// block is a line comment it puts the separating comma inside that comment, where JSON
		// cannot see it, and the file stops parsing. hex-web's `apps/front/tsconfig.json`
		// carries comments inside its `paths` object, so this is one moved comment away from
		// being the ordinary case.
		const repo = copy('glob-workspace');
		write(
			repo,
			`${repo.site}/tsconfig.json`,
			read(repo, `${repo.site}/tsconfig.json`).replace(
				'\t\t\t]\n\t\t}',
				'\t\t\t]\n\t\t\t// Everything else resolves through node_modules.\n\t\t}',
			),
		);
		const site = descriptorFor(repo);
		const edit = editById(site, 'tsconfig-paths') as Edit;
		const before = read(repo, edit.file);

		const produced = edit.apply(before, site);
		expect(produced, 'the applier found its anchor and produced text').not.toBeNull();
		expect(produced).toContain('node_modules.,');
		expect(
			edit.present(produced as string, site),
			'the applier produced a file its own predicate accepts, so this proves nothing',
		).toBe(false);
	});

	test('install reports that refusal as a refusal and leaves the file alone', async () => {
		const repo = copy('glob-workspace');
		write(
			repo,
			`${repo.site}/tsconfig.json`,
			read(repo, `${repo.site}/tsconfig.json`).replace(
				'\t\t\t]\n\t\t}',
				'\t\t\t]\n\t\t\t// Everything else resolves through node_modules.\n\t\t}',
			),
		);
		const before = read(repo, `${repo.site}/tsconfig.json`);

		const { result, rows } = await runInstall(repo, true);
		const outcome = result.edits.find((edit) => edit.id === 'tsconfig-paths');
		expect(outcome?.state).toBe('refused');
		// The instruction says which of the two refusals this was, because "I could not find
		// the anchor" and "I found it and produced something wrong" need different answers.
		expect(outcome?.instruction ?? '').toContain(
			'The edit produced a file its own predicate does not accept',
		);
		expect(read(repo, `${repo.site}/tsconfig.json`)).toBe(before);
		expect(rows.find((row) => row.id === 'install-writes')?.status).toBe('fail');
		// And the rest of the table still applied.
		expect(result.edits.find((edit) => edit.id === 'gitignore')?.state).toBe('written');
	});
});

// ---------------------------------------------------------------------------
// The hand-edit half
// ---------------------------------------------------------------------------

interface Perturbation {
	readonly name: string;
	readonly edit: string;
	/** The file it rewrites, relative to the site when it starts with `<site>/`. */
	readonly file: (repo: Repo) => string;
	readonly shapes?: readonly ConsumerShape[];
	/** True when the needle is expected to survive. False is a declared limit, not a bug. */
	readonly survives: boolean;
	readonly why: string;
	perturb(text: string, repo: Repo): string;
}

const PERTURBATIONS: readonly Perturbation[] = [
	{
		name: 'the deploy config is reformatted with two spaces',
		edit: 'deploy-hash-dirs',
		file: () => 'deploy.config.json',
		survives: true,
		why: 'A JSON needle that read the raw bytes would break on a formatter run, and this one parses.',
		perturb: (text) => `${JSON.stringify(parseJsonc(text), null, 2)}\n`,
	},
	{
		name: 'the extra_dirs entries are reordered',
		edit: 'deploy-hash-dirs',
		file: () => 'deploy.config.json',
		survives: true,
		why: 'The question is membership, not position, and somebody sorting that array is an ordinary tidy-up.',
		perturb: (text) => {
			const value = parseJsonc(text) as { hash: { extra_dirs: Record<string, string[]> } };
			for (const list of Object.values(value.hash.extra_dirs)) list.reverse();
			return `${JSON.stringify(value, null, '\t')}\n`;
		},
	},
	{
		name: 'the tsconfig is reformatted and loses its block comments',
		edit: 'tsconfig-paths',
		file: (repo) => `${repo.site}/tsconfig.json`,
		survives: true,
		why: 'The comments in hex-web paths object are that repository documentation of why those entries exist, and a needle that depended on them would break when somebody ran a formatter over the file.',
		perturb: (text) => `${JSON.stringify(parseJsonc(text), null, 2)}\n`,
	},
	{
		name: 'a line comment is added above the tsconfig',
		edit: 'tsconfig-paths',
		file: (repo) => `${repo.site}/tsconfig.json`,
		survives: true,
		why: 'JSONC is what both consumers write, so a reader that assumed strict JSON would fail one of them.',
		perturb: (text) => `// Why these entries exist.\n${text}`,
	},
	{
		name: 'the site package.json is reformatted with two spaces',
		edit: 'prebuild-hook',
		file: (repo) => `${repo.site}/package.json`,
		survives: true,
		why: 'The needle is inside the script string rather than in the file layout.',
		perturb: (text) => `${JSON.stringify(parseJsonc(text), null, 2)}\n`,
	},
	{
		name: 'the mcp servers are reordered',
		edit: 'mcp-json',
		file: () => '.mcp.json',
		survives: true,
		why: 'The entry is looked up by key, and a JSON object has no order to depend on.',
		perturb: (text) => {
			const value = parseJsonc(text) as { mcpServers: Record<string, unknown> };
			value.mcpServers = Object.fromEntries(Object.entries(value.mcpServers).reverse());
			return `${JSON.stringify(value, null, '\t')}\n`;
		},
	},
	{
		name: 'the gitignore entries are reordered and given CRLF endings',
		edit: 'gitignore',
		file: (repo) => `${repo.site}/.gitignore`,
		survives: true,
		why: 'Both are things a Windows checkout or a tidy-up does, and neither changes what git ignores.',
		perturb: (text) => `${text.split('\n').reverse().join('\n').trim()}\n`.replaceAll('\n', '\r\n'),
	},
	{
		name: 'app/lib/docs.ts is reflowed onto fewer lines',
		edit: 'docs-lib',
		file: (repo) => `${repo.site}/app/lib/docs.ts`,
		survives: true,
		why: 'The module header says it is safe to edit, so the predicate asks whether it still derives rather than whether it matches byte for byte.',
		perturb: (text) => text.replace(/\n\t/g, ' ').replace(/\n\n/g, '\n'),
	},
	{
		name: 'the check-docs shim is reindented with spaces',
		edit: 'check-docs-shim',
		file: (repo) => `${repo.site}/scripts/check-docs.mjs`,
		survives: true,
		why: 'kcalc front package runs eslint over scripts/, so the shim has to survive a reindent.',
		perturb: (text) => text.replaceAll('\t', '  '),
	},

	// The three that do not survive. Each is a real thing a consumer does, and each is
	// declared here with the remedy the failing check hands the reader.
	{
		name: 'the workspace exclusion is written with single quotes',
		edit: 'workspace-exclusion',
		file: () => 'pnpm-workspace.yaml',
		shapes: ['glob-workspace'],
		survives: false,
		why: 'pnpm accepts either quoting and `apps/front/scripts/check-tools.mjs` matches the double-quoted literal as a raw substring, so the consumer own guard would fail on it too. `pnpm format` in that repository rewrites double quotes to single ones in YAML, which is why the fixture comment calls the quotes the whole point.',
		perturb: (text, repo) => text.replace(`"!${repo.mount}"`, `'!${repo.mount}'`),
	},
	{
		name: 'the DOCS_SITES identifier in app/lib/docs.ts is renamed',
		edit: 'docs-lib',
		file: (repo) => `${repo.site}/app/lib/docs.ts`,
		survives: false,
		why: 'This is the limit `VerifyInstallReport.notCheckedHere` states in the report itself: renaming the local variable in a derivation breaks the check without breaking the code. Neither consumer route table can be evaluated from node without executing a Vite module, so a text match is the honest ceiling.',
		perturb: (text) => text.replaceAll('DOCS_SITES', 'SITES'),
	},
	{
		name: 'the check-docs shim is reformatted with single quotes',
		edit: 'check-docs-shim',
		file: (repo) => `${repo.site}/scripts/check-docs.mjs`,
		survives: false,
		why: 'The predicate looks for the double-quoted `"verify-install"` argument, and prettier over a consumer scripts/ directory rewrites every string to single quotes. The row then goes red until somebody re-runs install, which does rewrite the shim because its predicate is false.',
		perturb: (text) => text.replaceAll('"', "'"),
	},
];

describe('a needle survives what a consumer does to the file afterwards', () => {
	const CASES = CONSUMER_SHAPES.flatMap((shape) =>
		PERTURBATIONS.filter((entry) => (entry.shapes ?? CONSUMER_SHAPES).includes(shape)).map(
			(entry) => [`${shape}: ${entry.name}`, shape, entry] as const,
		),
	);

	test.each(CASES)('%s', async (_name, shape, perturbation) => {
		const repo = copy(shape);
		await runInstall(repo, true);

		const path = perturbation.file(repo);
		const site = descriptorFor(repo);
		const edit = editById(site, perturbation.edit) as Edit;
		expect(
			edit.present(site.files.read(path), site),
			`${perturbation.edit} is not satisfied before the perturbation, so this proves nothing`,
		).toBe(true);

		write(repo, path, perturbation.perturb(read(repo, path), repo));
		const after = descriptorFor(repo);
		const held = (editById(after, perturbation.edit) as Edit).present(
			after.files.read(path),
			after,
		);
		expect(held, perturbation.why).toBe(perturbation.survives);

		if (perturbation.survives) return;

		// Where the needle does break, the failure has to be actionable. The check row is
		// what a person sees, and a finding with no remediation is a red line with no cause.
		const row = runConsumerChecks(after, { exec: runRecipe, kitVersion: KIT_VERSION }).find(
			(candidate) => candidate.id === claimOf(perturbation.edit).check,
		);
		expect(row?.status).toBe('fail');
		const actionable = (row?.findings ?? []).filter(
			(finding) =>
				(finding.remediation !== null && finding.remediation.length > 20) ||
				finding.suggestion !== null,
		);
		expect(
			actionable.map((finding) => finding.message),
			'the row went red and carries no remediation and no suggestion',
		).not.toEqual([]);
	});

	test('the workspace exclusion failure carries the exact line to paste', () => {
		// The strongest form of "actionable": `suggestion` is contractually safe to apply
		// verbatim, and this is the one perturbation where a reader cannot guess the answer
		// from the message, because what is wrong is a pair of quote characters.
		const repo = copy('glob-workspace');
		write(
			repo,
			'pnpm-workspace.yaml',
			read(repo, 'pnpm-workspace.yaml').replace(
				'  - apps/front',
				`  - "!${repo.mount}"\n  - apps/front`,
			),
		);
		write(
			repo,
			'pnpm-workspace.yaml',
			read(repo, 'pnpm-workspace.yaml').replace(`"!${repo.mount}"`, `'!${repo.mount}'`),
		);
		const site = descriptorFor(repo);
		const row = runConsumerChecks(site, { exec: runRecipe, kitVersion: KIT_VERSION }).find(
			(candidate) => candidate.id === 'wiring-workspace-exclusion',
		);
		expect(row?.findings.map((finding) => finding.suggestion)).toEqual([`  - "!${repo.mount}"`]);
	});
});

// ---------------------------------------------------------------------------
// A perturbation that satisfies the edit and fails the check
// ---------------------------------------------------------------------------

describe('the split between what an edit can assert and what a check can', () => {
	test('an unindented packages list satisfies the predicate and still fails the row', () => {
		// `edits.ts` opens by saying install re-running is a no-op precisely when
		// verify-install passes and there is no third state. Read strictly that is not quite
		// true, and this is the case: a `packages:` list written flush against the left
		// margin is valid YAML that pnpm reads, the parser here declines to read it, and the
		// predicate then answers "not enrolled, so nothing to do" while the row refuses to
		// report success over a list it could not see. The check is right and the predicate
		// is not wrong; what is wrong is reading the header as a guarantee. Pinned here so
		// the sentence cannot quietly become true or quietly become worse.
		const repo = copy('glob-workspace');
		write(
			repo,
			'pnpm-workspace.yaml',
			read(repo, 'pnpm-workspace.yaml')
				.split('\n')
				.map((line) => (line.startsWith('  - ') ? line.trimStart() : line))
				.join('\n'),
		);
		const site = descriptorFor(repo);
		expect(
			(editById(site, 'workspace-exclusion') as Edit).present(
				site.files.read('pnpm-workspace.yaml'),
				site,
			),
		).toBe(true);
		const row = runConsumerChecks(site, { exec: runRecipe, kitVersion: KIT_VERSION }).find(
			(candidate) => candidate.id === 'wiring-workspace-exclusion',
		);
		expect(row?.status).toBe('fail');
		expect(row?.note ?? '').toMatch(/Read zero packages entries/);
	});
});

// ---------------------------------------------------------------------------
// The instructions that are shaped to the consumer in hand
// ---------------------------------------------------------------------------

describe('three instructions are shaped to the file they are about', () => {
	const marker = (id: string, repo: Repo): string =>
		(editById(descriptorFor(repo), id) as Edit).instruction;

	test('routes: a tuple array gets the spread and a page registry gets the declaration', () => {
		// Both directions, because a branch that always took one arm would satisfy either
		// half alone. Neither fixture ships the tuple shape, so the tuple arm is reached by
		// giving the fixture the annotation hex-web actually carries.
		const registry = copy('literal-workspace');
		expect(marker('routes', registry)).toContain('maps a page registry rather than a tuple array');
		expect(marker('routes', registry)).not.toContain('[path, file] tuple array here');

		const tuple = copy('glob-workspace');
		write(
			tuple,
			`${tuple.site}/app/routes.ts`,
			read(tuple, `${tuple.site}/app/routes.ts`).replace(
				'const PAGES = [',
				'const PAGES: [path: string, file: string][] = [',
			),
		);
		expect(marker('routes', tuple)).toContain('[path, file] tuple array here');
		expect(marker('routes', tuple)).not.toContain('maps a page registry rather than a tuple array');
	});

	test('localised paths: an array gets a spread and a readonly alias gets a concatenation', () => {
		expect(marker('localised-paths', copy('glob-workspace'))).toContain(
			'inside the LOCALISED_PATHS array',
		);
		expect(marker('localised-paths', copy('literal-workspace'))).toContain(
			'is an alias of one registry',
		);
		expect(marker('localised-paths', copy('glob-workspace'))).not.toContain(
			'is an alias of one registry',
		);
		expect(marker('localised-paths', copy('literal-workspace'))).not.toContain(
			'inside the LOCALISED_PATHS array',
		);
	});

	test('sitemap: an entries array gets a spread and a mapped registry gets a concatenation', () => {
		expect(marker('sitemap', copy('glob-workspace'))).toContain('inside the entries array');
		expect(marker('sitemap', copy('literal-workspace'))).toContain(
			'has no entries array to spread into',
		);
		expect(marker('sitemap', copy('glob-workspace'))).not.toContain(
			'has no entries array to spread into',
		);
		expect(marker('sitemap', copy('literal-workspace'))).not.toContain('inside the entries array');
	});
});

// ---------------------------------------------------------------------------
// The context that cannot write
// ---------------------------------------------------------------------------

test('install with --write in a context that has no writer reports not-run and writes nothing', async () => {
	// The runtime half of the guarantee whose other halves are the `Command` union and the
	// import-graph walk. A writer reached from the MCP server has nothing to call, and the
	// row says so rather than the command reporting a clean dry run.
	const repo = copy('glob-workspace');
	const before = snapshot(repo.root);
	const output = await invoke(
		install,
		{ root: repo.root, site: repo.site, mount: repo.mount, write: true },
		{
			cwd: repo.root,
			kitVersion: KIT_VERSION,
			exec: runRecipe,
			write: null,
			now: () => new Date(0),
			log: () => {},
		},
	);
	expect(output.rows.map((row) => [row.id, row.status])).toEqual([['install-writes', 'not-run']]);
	expect(snapshot(repo.root)).toEqual(before);
});
