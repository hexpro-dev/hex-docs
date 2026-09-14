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
 * The fixture is the **unwired** consumer, which is the state `install` starts from, as the
 * real bytes of both repositories. Nothing is patched in: the deploy configs carry their
 * own `sites` blocks, hex-web's routes carry their own tuple annotation, and no mount is
 * passed, because detection proposes the real one for each.
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
	MOUNT_OF,
	SITE_OF,
	materialiseConsumer,
	removeConsumer,
	type ConsumerShape,
} from '../../../fixtures/consumers.js';
import type { CheckId } from '../../../src/contracts/lint.js';
import { bucketOf } from '../../src/commands/common.js';
import { install } from '../../src/commands/install.js';
import { runRecipe } from '../../src/exec/run.js';
import { fileWriter } from '../../src/io/write.js';
import { invoke } from '../../src/registry/command.js';
import { runConsumerChecks } from '../../src/wiring/checks.js';
import { detectSite } from '../../src/wiring/detect.js';
import {
	PRESENT,
	editById,
	editsFor,
	type Edit,
	type EditContext,
} from '../../src/wiring/edits.js';
import { MACHINE_ROUTES_SPREAD, ROOT_DECISION } from '../../src/wiring/instructions.js';
import { parseJsonc } from '../../src/wiring/needles.js';
import { prebuildFragment } from '../../src/wiring/prebuild.js';
import type { SiteDescriptor } from '../../src/wiring/site.js';

const KIT_VERSION = '@hex-pro/docs-kit@0.0.0-test';

/** The exec every predicate gets here. No fixture has a React Router, so the table is unread. */
const CTX: EditContext = { exec: runRecipe };

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

function descriptorFor(repo: Repo): SiteDescriptor {
	return detectSite({ repoRoot: repo.root, site: repo.site });
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
	readonly notes: string[];
}

async function runInstall(
	repo: Repo,
	write: boolean,
	extra: { bucket?: string } = {},
): Promise<{
	result: InstallResult;
	rows: readonly { id: string; status: string; note: string | null }[];
	lines: readonly string[];
}> {
	const output = await invoke(
		install,
		{ root: repo.root, site: repo.site, write, ...extra },
		{
			cwd: repo.root,
			kitVersion: KIT_VERSION,
			exec: runRecipe,
			write: fileWriter(),
			now: () => new Date(0),
			log: () => {},
		},
	);
	return {
		result: output.data as unknown as InstallResult,
		rows: output.rows,
		lines: output.lines,
	};
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
 * and `install`'s loop honours that. One applier does append a second time, and writing
 * `same-bytes` for every edit would be asserting a guarantee that does not exist while hiding
 * which one relies on the caller. The guarantee that does exist is the whole-table one
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
		id: 'tsconfig-react-types',
		present: 'tsconfigReactTypes',
		check: 'wiring-tsconfig-path',
		byHand: false,
		reapply: 'same-bytes',
		why: 'tsc resolves a bare react from the submodule by walking up past a directory with no node_modules/react, which is ten resolution errors in the consumer typecheck.',
	},
	{
		id: 'tsconfig-resolve-json',
		present: 'tsconfigResolveJson',
		check: 'wiring-tsconfig-path',
		byHand: true,
		reapply: 'refuses',
		satisfiedOn: {
			'glob-workspace': 'hex-web sets it in the shared config its site tsconfig extends',
			'literal-workspace': 'kcalc sets it in the shared config its site tsconfig extends',
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
		reapply: 'refuses',
		why: 'There is no CI on either consumer, so prebuild is the one thing that always runs. A string that already names the guard is refused rather than appended after, because a broken segment left first still stops the build.',
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
		why: 'It needs a project id, a mount path and a labelled commit that nothing here knows.',
	},
	{
		id: 'docs-server',
		present: 'docsServer',
		check: 'wiring-routes',
		byHand: false,
		reapply: 'refuses',
		why: 'Created, never rewritten. A file that exists and fails its predicate is a file somebody wrote, and the template header invites that.',
	},
	{
		id: 'route-page-module',
		present: 'pageRouteModule',
		check: 'wiring-routes',
		byHand: false,
		reapply: 'refuses',
		why: 'The same predicate for install and the check, so a stub that exists and reads nothing is refused by both rather than unchanged to one and red in the other.',
	},
	{
		id: 'route-machine-module',
		present: 'machineRouteModule',
		check: 'wiring-routes',
		byHand: false,
		reapply: 'refuses',
		why: 'A default export turns a resource route into a document route, and the predicate that refuses one is the one install writes with.',
	},
	{
		id: 'routes',
		present: 'routes',
		check: 'wiring-routes',
		byHand: true,
		reapply: 'refuses',
		why: 'Insertions into a hand-authored route table whose surrounding prose is the consuming repository actual documentation, and whose result only the site own loader can read.',
	},
	{
		id: 'root-seo',
		present: 'rootSeo',
		check: 'wiring-localised-paths',
		byHand: true,
		reapply: 'refuses',
		why: 'The one place a docs page canonical, alternates and robots tag can be decided, in a file hand-edited in every commit.',
	},
	{
		id: 'sitemap',
		present: 'sitemap',
		check: 'wiring-sitemap',
		byHand: true,
		reapply: 'refuses',
		why: 'One consumer has an entries array and the other maps a page registry with a lastmod lookup a docs spread would break.',
	},
	{
		id: 'mcp-json',
		present: 'mcpJson',
		check: 'wiring-mcp',
		byHand: false,
		reapply: 'refuses',
		why: 'A hexdocs entry present with a different command is somebody own wiring, and a second key of the same name is a file that parses to whichever came last.',
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

	test('the settings edit and the localised-paths edit are gone, not moved', () => {
		// Deleted in step 8 and named here so neither comes back as a quiet addition. The
		// first was a build gate on one developer's editor; the second put docs addresses in
		// a list whose other reader is the language-cookie redirect.
		const ids = editsFor(descriptorFor(copy('glob-workspace'))).map((edit) => edit.id);
		expect(ids).not.toContain('mcp-settings');
		expect(ids).not.toContain('localised-paths');
		expect(ids).not.toContain('docs-lib');
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
		// `editsFor` builds a table per descriptor because several instructions are shaped to
		// the consumer file in hand. The predicates must not be rebuilt with it: a closure per
		// descriptor would pass the assertion above and still be a fresh function on every
		// call, which is the same defect one level out.
		const first = editsFor(descriptorFor(copy('glob-workspace')));
		const second = editsFor(descriptorFor(copy('literal-workspace')), 'a-bucket');
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
		// modules are looking at one object. This asserts the observable half of that: the two
		// answers agree on a tree where one edit is applied and the rest are not.
		const repo = copy('glob-workspace');
		const before = descriptorFor(repo);
		const gitignore = editById(before, 'gitignore') as Edit;
		const applied = gitignore.apply(before.files.read(gitignore.file), before, CTX);
		expect(applied).not.toBeNull();
		write(repo, gitignore.file, applied as string);

		const after = descriptorFor(repo);
		expect(
			(editById(after, 'gitignore') as Edit).present(after.files.read(gitignore.file), after, CTX),
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
			edit.present(text, site, CTX),
			satisfied === undefined
				? `"${claim.id}" is already satisfied on an unwired ${shape}, which no claim declares`
				: `"${claim.id}" is declared already satisfied on ${shape} because ${satisfied}`,
		).toBe(satisfied !== undefined);
		if (satisfied !== undefined) return;

		const next = edit.apply(text, site, CTX);
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
			edit.present(next as string, site, CTX),
			`"${claim.id}" produced text it does not accept`,
		).toBe(true);

		const again = edit.apply(next as string, site, CTX);
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

			// Missing: no tsconfig at all, so both appliers into it are handed `null`.
			rmSync(join(repo.root, repo.site, 'tsconfig.json'));
			// Not unique: two `mcpServers` keys, so `soleBlock` cannot say which one an insert
			// belongs in. Inserting into whichever came first is how an edit lands in a block the
			// reader was not looking at.
			const mcpBefore = '{\n\t"mcpServers": {},\n\t"other": { "mcpServers": {} }\n}\n';
			write(repo, '.mcp.json', mcpBefore);

			const site = descriptorFor(repo);
			expect((editById(site, 'tsconfig-paths') as Edit).apply(null, site, CTX)).toBeNull();
			expect((editById(site, 'mcp-json') as Edit).apply(mcpBefore, site, CTX)).toBeNull();

			const { result, rows } = await runInstall(repo, true);
			const state = (id: string): string =>
				result.edits.find((edit) => edit.id === id)?.state ?? 'absent';
			const refusedIds = ['tsconfig-paths', 'tsconfig-react-types', 'mcp-json'];
			expect(refusedIds.map(state)).toEqual(['refused', 'refused', 'refused']);

			// A refusal is printed with the instruction a person then follows, so it must not be
			// null: a boolean tells somebody the edit did not happen and only the text tells them
			// what to do instead.
			for (const id of refusedIds) {
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
			const others = CLAIMS.filter((claim) => !claim.byHand && !refusedIds.includes(claim.id))
				.filter((claim) => claim.satisfiedOn?.[shape] === undefined)
				.map((claim) => claim.id);
			expect(others.map((id) => `${id}:${state(id)}`)).toEqual(others.map((id) => `${id}:written`));

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
		// and `verify-install` would then report the same row as failing.
		//
		// The state that produces it is a real one, and it is a defect in `insertIntoBlock`
		// that this guard is currently the only thing catching. `lastNonBlankBefore` walks the
		// **original** text, so when the last thing inside the block is a line comment it puts
		// the separating comma inside that comment, where JSON cannot see it, and the file
		// stops parsing. hex-web's tsconfig carries comments inside its `paths` object, so this
		// is one moved comment away from being the ordinary case.
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

		const produced = edit.apply(before, site, CTX);
		expect(produced, 'the applier found its anchor and produced text').not.toBeNull();
		expect(produced).toContain('node_modules.,');
		expect(
			edit.present(produced as string, site, CTX),
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
// The prebuild string, which is refused rather than appended after
// ---------------------------------------------------------------------------

describe('a prebuild that already names the guard', () => {
	test.each(CONSUMER_SHAPES)(
		'%s: the step 5 fragment is refused, named, and the file is left byte for byte',
		async (shape) => {
			const repo = copy(shape);
			const packageFile = `${repo.site}/package.json`;
			const site = descriptorFor(repo);
			// The fragment step 5 installed, which the CLI refuses because root is positional.
			const broken = `${site.mountFromSite}/kit/bin/hexdocs prefetch --root ${site.repoFromSite} --site ${repo.site} && node scripts/check-docs.mjs`;
			const value = parseJsonc(read(repo, packageFile)) as { scripts: Record<string, string> };
			value.scripts['prebuild'] =
				value.scripts['prebuild'] === undefined
					? broken
					: `${value.scripts['prebuild']} && ${broken}`;
			write(repo, packageFile, `${JSON.stringify(value, null, '\t')}\n`);
			const before = read(repo, packageFile);

			// The applier refuses on its own, rather than appending and leaving `install`'s
			// re-run of the predicate to catch a chain whose first segment still exits 2.
			const seeded = descriptorFor(repo);
			expect((editById(seeded, 'prebuild-hook') as Edit).apply(before, seeded, CTX)).toBeNull();

			const { result } = await runInstall(repo, true);
			const outcome = result.edits.find((edit) => edit.id === 'prebuild-hook');
			expect(outcome?.state).toBe('refused');
			expect(outcome?.instruction ?? '').not.toContain('its own predicate does not accept');
			expect(read(repo, packageFile)).toBe(before);
			// The instruction names the segment to replace and what is wrong with it, rather than
			// only printing the fragment a person would then append after the broken one.
			expect(outcome?.instruction ?? '').toContain(`replace \`${broken.split(' && ')[0]}\``);
			expect(outcome?.instruction ?? '').toContain("Unknown option '--root'");
		},
	);

	test('with --bucket, the fragment carries the bucket and the predicate accepts it', async () => {
		const repo = copy('literal-workspace');
		const { result } = await runInstall(repo, true, { bucket: 'docs-bucket-example' });
		expect(result.edits.find((edit) => edit.id === 'prebuild-hook')?.state).toBe('written');
		const scripts = (
			parseJsonc(read(repo, `${repo.site}/package.json`)) as {
				scripts: Record<string, string>;
			}
		).scripts;
		const site = descriptorFor(repo);
		expect(scripts['prebuild']).toBe(prebuildFragment(site, 'docs-bucket-example'));
		expect(PRESENT.prebuildHook(read(repo, `${repo.site}/package.json`), site)).toBe(true);
	});

	test('--bucket is refused exactly when prefetch would refuse it', async () => {
		// The value is validated where it enters, and the validator is prefetch's own, so this
		// asserts agreement rather than a list of bucket names: whatever `bucketOf` refuses,
		// install refuses and writes nothing.
		for (const bucket of ['docs-bucket-example', 'file://bucket', '-bucket', 'Bucket_Name']) {
			const repo = copy('literal-workspace');
			const before = snapshot(repo.root);
			const { rows } = await runInstall(repo, true, { bucket });
			const refused = 'why' in bucketOf(bucket);
			expect([bucket, rows[0]?.status === 'not-run']).toEqual([bucket, refused]);
			if (refused) expect(snapshot(repo.root)).toEqual(before);
		}
	});
});

// ---------------------------------------------------------------------------
// The hand-edit half
// ---------------------------------------------------------------------------

interface Perturbation {
	readonly name: string;
	readonly edit: string;
	/** The file it rewrites, relative to the repository root. */
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
		name: 'the react mapping is respelled as its index file',
		edit: 'tsconfig-react-types',
		file: (repo) => `${repo.site}/tsconfig.json`,
		survives: true,
		why: 'Two spellings of one resolution are one wiring, and a predicate comparing target strings would refuse a correct consumer forever.',
		perturb: (text) =>
			text.replace(
				'"react": ["./node_modules/@types/react"]',
				'"react": ["node_modules/@types/react/index.d.ts"]',
			),
	},
	{
		name: 'the site package.json is reformatted with two spaces',
		edit: 'prebuild-hook',
		file: (repo) => `${repo.site}/package.json`,
		survives: true,
		why: 'The predicate reads the script string rather than the file layout.',
		perturb: (text) => `${JSON.stringify(parseJsonc(text), null, 2)}\n`,
	},
	{
		name: 'the prefetch flag is written with an equals sign',
		edit: 'prebuild-hook',
		file: (repo) => `${repo.site}/package.json`,
		survives: true,
		why: 'The CLI accepts `--site=apps/front`, and the step 5 substring test refused it, which is a false failure on a chain that works.',
		perturb: (text, repo) => text.replace(`--site ${repo.site}`, `--site=${repo.site}`),
	},
	{
		name: 'the prefetch flags are reordered around the positional root',
		edit: 'prebuild-hook',
		file: (repo) => `${repo.site}/package.json`,
		survives: true,
		why: 'The binder takes a flag before the positional as readily as after it, so a person tidying the string has not broken anything.',
		perturb: (text, repo) =>
			text.replace(`prefetch ../.. --site ${repo.site}`, `prefetch --site ${repo.site} ../..`),
	},
	{
		name: 'a bucket is added to the prefetch by hand',
		edit: 'prebuild-hook',
		file: (repo) => `${repo.site}/package.json`,
		survives: true,
		why: 'The bucket reaches prefetch through this private string, which is the route decided for it, so adding one is wiring rather than drift.',
		perturb: (text, repo) =>
			text.replace(`--site ${repo.site}`, `--site ${repo.site} --bucket docs-bucket-example`),
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
		name: 'the server module is reflowed onto fewer lines',
		edit: 'docs-server',
		file: (repo) => `${repo.site}/app/lib/docs.server.ts`,
		survives: true,
		why: 'The module header says it is safe to edit, so the predicate asks what the rest of the wiring depends on rather than whether it matches byte for byte.',
		perturb: (text) => text.replace(/\n\t/g, ' ').replace(/\n\n/g, '\n'),
	},
	{
		name: 'the server module annotates its exports',
		edit: 'docs-server',
		file: (repo) => `${repo.site}/app/lib/docs.server.ts`,
		survives: true,
		why: 'A type annotation on an export is an ordinary edit, and a needle that wanted `export const DOCS =` exactly would refuse it.',
		perturb: (text) =>
			text
				.replace(
					'export const DOCS_ROUTES =',
					'export const DOCS_ROUTES: ReturnType<typeof docsRouteRows> =',
				)
				.replace('export const DOCS =', 'export const DOCS: ReturnType<typeof docsServer> ='),
	},
	{
		name: 'the check-docs shim is reindented with spaces',
		edit: 'check-docs-shim',
		file: (repo) => `${repo.site}/scripts/check-docs.mjs`,
		survives: true,
		why: 'kcalc front package runs eslint over scripts/, so the shim has to survive a reindent.',
		perturb: (text) => text.replaceAll('\t', '  '),
	},

	// The ones that do not survive. Each is a real thing a consumer does, and each is
	// declared here with the remedy the failing check hands the reader.
	{
		name: 'the workspace exclusion is written with single quotes',
		edit: 'workspace-exclusion',
		file: () => 'pnpm-workspace.yaml',
		shapes: ['glob-workspace'],
		survives: false,
		why: 'pnpm accepts either quoting and `apps/front/scripts/check-tools.mjs` matches the double-quoted literal as a raw substring, so the consumer own guard would fail on it too.',
		perturb: (text, repo) => text.replace(`"!${repo.mount}"`, `'!${repo.mount}'`),
	},
	{
		name: 'the page module destructures DOCS',
		edit: 'route-page-module',
		file: (repo) => `${repo.site}/app/routes/docs.tsx`,
		survives: false,
		why: 'The limit `VerifyInstallReport.notCheckedHere` states in the report itself: rearranging the expression around a call breaks the text match without breaking the code.',
		perturb: (text) =>
			text.replace(
				'return DOCS.page(new URL(request.url));',
				'const { page } = DOCS;\n\treturn page(new URL(request.url));',
			),
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
			edit.present(site.files.read(path), site, CTX),
			`${perturbation.edit} is not satisfied before the perturbation, so this proves nothing`,
		).toBe(true);

		const before = read(repo, path);
		const after = perturbation.perturb(before, repo);
		expect(after, `${perturbation.name} changed nothing, so this proves nothing`).not.toBe(before);
		write(repo, path, after);
		const perturbed = descriptorFor(repo);
		const held = (editById(perturbed, perturbation.edit) as Edit).present(
			perturbed.files.read(path),
			perturbed,
			CTX,
		);
		expect(held, perturbation.why).toBe(perturbation.survives);

		if (perturbation.survives) return;

		// Where the needle does break, the failure has to be actionable. The check row is
		// what a person sees, and a finding with no remediation is a red line with no cause.
		const row = runConsumerChecks(perturbed, { exec: runRecipe, kitVersion: KIT_VERSION }).find(
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
				`  - '!${repo.mount}'\n  - apps/front`,
			),
		);
		const site = descriptorFor(repo);
		const row = runConsumerChecks(site, { exec: runRecipe, kitVersion: KIT_VERSION }).find(
			(candidate) => candidate.id === 'wiring-workspace-exclusion',
		);
		expect(row?.findings.map((finding) => finding.suggestion)).toEqual([`  - "!${repo.mount}"`]);
	});

	test('a react mapping already present by another spelling leaves the docs entries to be written', async () => {
		// A consumer that had mapped `react` before this install used to get no `@hex-pro/docs`
		// entries at all, because the one paths applier refused the whole edit when any key it
		// wanted was already there. The react mapping is its own edit now.
		const repo = copy('glob-workspace');
		write(
			repo,
			`${repo.site}/tsconfig.json`,
			read(repo, `${repo.site}/tsconfig.json`).replace(
				'"~/*": ["./app/*"],',
				'"~/*": ["./app/*"],\n\t\t\t"react": ["node_modules/@types/react"],',
			),
		);
		const { result } = await runInstall(repo, true);
		const state = (id: string) => result.edits.find((edit) => edit.id === id)?.state;
		expect([state('tsconfig-paths'), state('tsconfig-react-types')]).toEqual([
			'written',
			'written',
		]);
		const table = (
			parseJsonc(read(repo, `${repo.site}/tsconfig.json`)) as {
				compilerOptions: { paths: Record<string, string[]> };
			}
		).compilerOptions.paths;
		expect(table['react']).toEqual(['node_modules/@types/react']);
		expect(table['react/*']).toEqual(['./node_modules/@types/react/*']);
		expect(table['@hex-pro/docs']).toEqual(['../../common/docs/src/index.ts']);
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
		// report success over a list it could not see. Pinned here so the sentence cannot
		// quietly become true or quietly become worse.
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
				CTX,
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

describe('the printed instructions are shaped to the file they are about', () => {
	const instruction = (id: string, repo: Repo): string =>
		(editById(descriptorFor(repo), id) as Edit).instruction;

	test('routes: the tuple array gets the page spread and the registry gets the helper', () => {
		// Both from the real bytes, with nothing patched in: hex-web's PAGES carries the tuple
		// annotation and kcalc's pages() maps a registry from another module.
		const tuple = instruction('routes', copy('glob-workspace'));
		const registry = instruction('routes', copy('literal-workspace'));
		expect(tuple).toContain('As the last entries of `PAGES`');
		expect(tuple).not.toContain('function docsPages');
		expect(registry).toContain('function docsPages');
		expect(registry).not.toContain('As the last entries of `PAGES`');
		for (const text of [tuple, registry]) {
			// Insertions only. A printed whole `export default` deleted kcalc's robots, sitemap
			// and admin routes when copied literally.
			expect(text).not.toContain('export default [');
			expect(text).toContain('{ id: row.id }');
			expect(text).toContain(MACHINE_ROUTES_SPREAD.split('\n')[0] as string);
			expect(text).toContain('import { DOCS_ROUTES } from "./lib/docs.server";');
		}
	});

	test('sitemap: the escaping site gets escaped URLs and the other does not', () => {
		const plain = instruction('sitemap', copy('glob-workspace'));
		const escaped = instruction('sitemap', copy('literal-workspace'));
		expect(escaped).toContain('escapeXml(localeUrl(lang, entry.path))');
		expect(plain).not.toContain('escapeXml(');
		for (const text of [plain, escaped]) {
			expect(text).toContain('DOCS.sitemap().flatMap');
			expect(text).toContain('entry.languages.includes(DEFAULT_LANGUAGE)');
		}
	});

	test('root: the decision reads the docs match and filters the alternates', () => {
		const text = instruction('root-seo', copy('glob-workspace'));
		for (const line of ROOT_DECISION.split('\n')) expect(text).toContain(line);
		expect(text).toContain('import { docsSeoFromMatches } from "@hex-pro/docs";');
		expect(text).toContain('PREFIXED_LANGUAGES.filter(named).map(');
	});
});

// ---------------------------------------------------------------------------
// The note, and the context that cannot write
// ---------------------------------------------------------------------------

test('the editor settings are printed as a note and never become an edit', async () => {
	const repo = copy('glob-workspace');
	const { result, lines } = await runInstall(repo, false);
	expect(result.notes).toHaveLength(1);
	expect(result.notes[0]).toContain('"enabledMcpjsonServers": ["hexdocs"]');
	expect(result.notes[0]).toContain(`${repo.mount}/.claude/skills`);
	expect(lines.join('\n')).toContain(result.notes[0] as string);
	expect(result.edits.some((edit) => edit.file.includes('.claude'))).toBe(false);
});

test('install with --write in a context that has no writer reports not-run and writes nothing', async () => {
	// The runtime half of the guarantee whose other halves are the `Command` union and the
	// import-graph walk. A writer reached from the MCP server has nothing to call, and the
	// row says so rather than the command reporting a clean dry run.
	const repo = copy('glob-workspace');
	const before = snapshot(repo.root);
	const output = await invoke(
		install,
		{ root: repo.root, site: repo.site, write: true },
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
