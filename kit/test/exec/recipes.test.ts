/**
 * The exec boundary, pinned at the table rather than at the call sites.
 *
 * Row 5 of the failure catalogue is "the exec boundary admits a mutating command", and
 * the structure that answers it is that `runRecipe(id, holes)` has no argv parameter: the
 * subcommand and every flag are literals in `kit/src/exec/recipes.ts`, so `git clean -fd`
 * is unrepresentable rather than denied. A test that only drove the refusals would leave
 * that claim resting on a reviewer noticing a new table entry, which is what the pinned
 * lists below exist to stop. Every id, every argv element and every hole count is written
 * out here, so widening the table is a diff in a test file with a reason attached rather
 * than a line added to a record.
 *
 * Nothing in this file starts a process, and that is deliberate rather than incidental.
 * Two separate things hold it, and neither is obvious from a diff. `runRecipe` checks
 * arity and then the NUL before it reaches `spawnSync`, so every refusal is reachable with
 * no binary installed; and the calls that are meant to get past those checks, the ones
 * asserting which characters reach the child, pass `cwd: '/nonexistent'`, where `spawnSync`
 * fails before it execs anything and answers `status: null`. That argument is load-bearing:
 * an edit passing `process.cwd()` there would start running `gh` and `aws` from inside the
 * suite. A correct call to a zero-hole recipe is the remaining shape that would spawn, and
 * the test pinning those four says so where they are named.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
	ALL_RECIPES,
	HOLE,
	READ_RECIPES,
	WRITE_RECIPES,
	holeCount,
	type Recipe,
	type RecipeId,
} from '../../src/exec/recipes.js';
import { ExecRefusal, NO_EXEC, runRecipe } from '../../src/exec/run.js';

/**
 * The read table, spelled out.
 *
 * `Object.keys` on one side and a literal on the other, compared in both directions. A
 * one-directional check is satisfied by a table that grew: the literal would still be a
 * subset and the new recipe would ship unnamed.
 */
const READ_IDS = [
	'aws.get-object',
	'aws.head-object',
	'aws.list-objects',
	'aws.list-objects-page',
	'gh.api',
	'git.head',
	'git.head-date',
	'git.is-shallow',
	'git.log-walk',
	'git.ls-files-stage',
	'git.merge-base-is-ancestor',
].sort();

const WRITE_IDS = ['aws.put-object', 'aws.put-object-gzip'].sort();

/**
 * Every recipe's argv, with a hole written as `<hole>`.
 *
 * This is the pinned-argv assertion row 7's mutation has to turn red: dropping
 * `--if-none-match '*'` from either put recipe changes one line here. It is the whole
 * table rather than the two puts because the same mutation is available everywhere: a
 * `--dryrun` removed from a read, a `--force` added to one, a literal turned into a hole
 * so the caller chooses it. None of those changes an id, and none of them changes a hole
 * count either once a flag and its value are added together.
 */
const ARGV: Readonly<Record<string, readonly string[]>> = {
	'git.head': ['rev-parse', 'HEAD'],
	'git.head-date': ['log', '-1', '--format=%cI'],
	'git.is-shallow': ['rev-parse', '--is-shallow-repository'],
	// The U+0001 opening each commit's date line, written as an escape because the
	// character is invisible in a diff and this argv is the one a reviewer reads literally.
	'git.log-walk': ['log', '--format=\u0001%cI', '--name-only', '--diff-merges=combined'],
	'git.ls-files-stage': ['ls-files', '-s', '--', '<hole>'],
	'git.merge-base-is-ancestor': ['merge-base', '--is-ancestor', '<hole>', '<hole>'],
	'gh.api': ['api', '<hole>'],
	'aws.head-object': [
		's3api',
		'head-object',
		'--bucket',
		'<hole>',
		'--key',
		'<hole>',
		'--checksum-mode',
		'ENABLED',
		'--output',
		'json',
	],
	'aws.list-objects': [
		's3api',
		'list-objects-v2',
		'--bucket',
		'<hole>',
		'--prefix',
		'<hole>',
		'--max-items',
		'<hole>',
		'--output',
		'json',
	],
	'aws.list-objects-page': [
		's3api',
		'list-objects-v2',
		'--bucket',
		'<hole>',
		'--prefix',
		'<hole>',
		'--max-items',
		'<hole>',
		'--starting-token',
		'<hole>',
		'--output',
		'json',
	],
	'aws.get-object': [
		's3api',
		'get-object',
		'--bucket',
		'<hole>',
		'--key',
		'<hole>',
		'<hole>',
		'--checksum-mode',
		'ENABLED',
		'--output',
		'json',
	],
	'aws.put-object': [
		's3api',
		'put-object',
		'--bucket',
		'<hole>',
		'--key',
		'<hole>',
		'--body',
		'<hole>',
		'--content-type',
		'<hole>',
		'--cache-control',
		'public, max-age=31536000, immutable',
		'--checksum-sha256',
		'<hole>',
		'--if-none-match',
		'*',
		'--output',
		'json',
	],
	'aws.put-object-gzip': [
		's3api',
		'put-object',
		'--bucket',
		'<hole>',
		'--key',
		'<hole>',
		'--body',
		'<hole>',
		'--content-type',
		'<hole>',
		'--content-encoding',
		'gzip',
		'--cache-control',
		'public, max-age=31536000, immutable',
		'--checksum-sha256',
		'<hole>',
		'--if-none-match',
		'*',
		'--output',
		'json',
	],
};

const ids = (table: object): string[] => Object.keys(table).sort();
const allIds = ids(ALL_RECIPES) as RecipeId[];
const recipeOf = (id: RecipeId): Recipe => ALL_RECIPES[id] as Recipe;
const shown = (id: RecipeId): string[] =>
	recipeOf(id).argv.map((slot) => (slot === HOLE ? '<hole>' : slot));

/** A hole value that passes the NUL check, so arity is what a call fails on. */
const SAFE = 'safe-value';
const fill = (id: RecipeId, value = SAFE): string[] => Array(holeCount(id)).fill(value) as string[];

describe('the recipe tables', () => {
	test('the read ids are exactly these, in both directions', () => {
		expect(ids(READ_RECIPES)).toEqual(READ_IDS);
	});

	test('the write ids are exactly these, in both directions', () => {
		// Two, and the second exists because a conditional `--content-encoding` would put a
		// caller in charge of whether a gzipped member is labelled as one. A third entry here
		// is the diff row 5 exists to make visible.
		expect(ids(WRITE_RECIPES)).toEqual(WRITE_IDS);
	});

	test('no id is in both tables, and ALL_RECIPES is their union', () => {
		// A merge of two records silently prefers the second on a collision, so an id added
		// to both tables would take its write template into the read half of the boundary.
		expect(READ_IDS.filter((id) => WRITE_IDS.includes(id))).toEqual([]);
		expect(allIds).toEqual([...READ_IDS, ...WRITE_IDS].sort());
	});

	test('every recipe argv is exactly the pinned template, in both directions', () => {
		const pinned = Object.keys(ARGV).sort();
		expect(pinned, 'a recipe was added or removed without updating ARGV').toEqual(allIds);
		const actual = Object.fromEntries(allIds.map((id) => [id, shown(id)]));
		const expected = Object.fromEntries(pinned.map((id) => [id, ARGV[id]]));
		expect(actual).toEqual(expected);
	});

	test('the binaries are exactly git, aws and gh, in both directions', () => {
		const bins = [...new Set(allIds.map((id) => recipeOf(id).bin))].sort();
		expect(bins).toEqual(['aws', 'gh', 'git']);
	});

	test('a hole is a symbol, so no argument value can be mistaken for one', () => {
		// `'HOLE'` as a string sentinel would be one real bucket name away from a template
		// that fills itself, which is the reason `recipes.ts` reaches for a symbol.
		expect(typeof HOLE).toBe('symbol');
		const strings = allIds.flatMap((id) =>
			recipeOf(id).argv.filter((slot): slot is string => typeof slot === 'string'),
		);
		expect(strings.filter((slot) => /^<?HOLE>?$/i.test(slot))).toEqual([]);
	});

	test('no recipe lets the caller choose the subcommand', () => {
		// `argv[0]` as a hole would turn one entry into a binary allowlist, which is the
		// weaker shape `hex-terraform/mcp/src/lib/exec.ts` ships and which `git clean -fd`
		// walks straight through.
		const chosen = allIds.filter((id) => recipeOf(id).argv[0] === HOLE);
		expect(chosen).toEqual([]);
	});

	test('every recipe says in a sentence what it reads and why it is safe', () => {
		const bad = allIds.filter((id) => {
			const why = recipeOf(id).why;
			return why.length < 40 || !why.trimEnd().endsWith('.');
		});
		expect(bad).toEqual([]);
	});
});

describe('no recipe can mutate a repository', () => {
	/**
	 * Every git subcommand the table is allowed to name.
	 *
	 * Checked in both directions, so an unused entry here fails too. That half is the one
	 * worth having: an allowlist that grew to admit something and then outlived it is an
	 * allowlist nobody is reading, and the next entry added to it is not questioned either.
	 */
	const GIT_SUBCOMMANDS = ['log', 'ls-files', 'merge-base', 'rev-parse'];

	test('every git recipe opens with a read subcommand, in both directions', () => {
		const used = [
			...new Set(
				allIds
					.filter((id) => recipeOf(id).bin === 'git')
					.map((id) => recipeOf(id).argv[0] as string),
			),
		].sort();
		expect(used).toEqual(GIT_SUBCOMMANDS);
	});

	test('no git recipe names a mutating subcommand anywhere in its argv', () => {
		// The first element is the subcommand, and the assertion above covers it. This one
		// covers the residue that makes a subcommand allowlist insufficient in the first
		// place: `git -c core.hooksPath=/tmp/x log` is a `log` to anything reading `argv[0]`,
		// and `git checkout -- .` is a `checkout` whose damage is in the flags.
		const MUTATING = [
			'add',
			'am',
			'apply',
			'branch',
			'checkout',
			'cherry-pick',
			'clean',
			'clone',
			'commit',
			'config',
			'fetch',
			'filter-branch',
			'gc',
			'init',
			'mv',
			'prune',
			'pull',
			'push',
			'rebase',
			'remote',
			'reset',
			'restore',
			'revert',
			'rm',
			'stash',
			'submodule',
			'switch',
			'tag',
			'update-ref',
			'worktree',
			'-c',
			'--exec-path',
			'--work-tree',
			'--git-dir',
		];
		const found: string[] = [];
		for (const id of allIds) {
			if (recipeOf(id).bin !== 'git') continue;
			for (const slot of recipeOf(id).argv) {
				if (typeof slot === 'string' && MUTATING.includes(slot)) found.push(`${id}: ${slot}`);
			}
		}
		expect(found).toEqual([]);
	});

	test('every aws recipe is an s3api call, and only the write table says put-object', () => {
		const readOps = new Set<string>();
		const writeOps = new Set<string>();
		for (const id of allIds) {
			const recipe = recipeOf(id);
			if (recipe.bin !== 'aws') continue;
			expect(recipe.argv[0], `${id} does not open with s3api`).toBe('s3api');
			(READ_IDS.includes(id) ? readOps : writeOps).add(recipe.argv[1] as string);
		}
		// Both directions on both halves: an operation added to either set fails, and an
		// operation that left one fails too. `rm`, `delete-object` and `sync` are absent
		// because they are unrepresentable, not because they are filtered.
		expect([...readOps].sort()).toEqual(['get-object', 'head-object', 'list-objects-v2']);
		expect([...writeOps].sort()).toEqual(['put-object']);
	});

	test('the only gh recipe is a plain api read', () => {
		const gh = allIds.filter((id) => recipeOf(id).bin === 'gh');
		expect(gh).toEqual(['gh.api']);
		expect(recipeOf('gh.api').argv[0]).toBe('api');
		// `gh api` defaults to GET. A `-X`, `--method` or `-f` in this template would make it
		// a writer against the GitHub API with no other guard in the package looking at it.
		expect(recipeOf('gh.api').argv).toHaveLength(2);
	});
});

describe('write-once is inside the template, not at the call site', () => {
	// Row 7. `publish.ts` cannot omit the conditional header, because there is no argument
	// through which it could supply one.
	for (const id of WRITE_IDS as RecipeId[]) {
		test(`${id} carries --if-none-match '*' as adjacent literals`, () => {
			const argv = recipeOf(id).argv;
			const at = argv.indexOf('--if-none-match');
			expect(at, `${id} has no --if-none-match`).toBeGreaterThan(-1);
			expect(argv[at + 1], `${id} does not pin the header to '*'`).toBe('*');
		});

		test(`${id} sends a checksum and an immutable cache-control`, () => {
			const argv = recipeOf(id).argv;
			expect(argv).toContain('--checksum-sha256');
			expect(argv[argv.indexOf('--checksum-sha256') + 1]).toBe(HOLE);
			expect(argv).toContain('--cache-control');
			expect(argv[argv.indexOf('--cache-control') + 1]).toBe('public, max-age=31536000, immutable');
		});
	}

	test('the encoding is decided by the recipe, never by a hole', () => {
		const plain = recipeOf('aws.put-object').argv;
		const gzip = recipeOf('aws.put-object-gzip').argv;
		expect(plain).not.toContain('--content-encoding');
		expect(gzip[gzip.indexOf('--content-encoding') + 1]).toBe('gzip');
		// The two differ by exactly the encoding pair, so the gzip variant cannot drift into
		// a second put with different headers.
		expect(gzip.filter((slot) => slot !== '--content-encoding' && slot !== 'gzip')).toEqual([
			...plain,
		]);
	});
});

describe('hole counts', () => {
	/** Derived from `ARGV` rather than written again, so the two cannot disagree. */
	const EXPECTED: Readonly<Record<string, number>> = Object.fromEntries(
		Object.entries(ARGV).map(([id, argv]) => [id, argv.filter((slot) => slot === '<hole>').length]),
	);

	test('holeCount agrees with the pinned templates, in both directions', () => {
		const actual = Object.fromEntries(allIds.map((id) => [id, holeCount(id)]));
		expect(actual).toEqual(EXPECTED);
	});

	test('the four zero-hole recipes are exactly the ones with nothing to fill', () => {
		// Named because they are the shape this file cannot drive with a correct arity: a
		// correct call to one of them reaches `spawnSync`. Their too-many arm is exercised
		// below; their too-few arm does not exist.
		const zero = allIds.filter((id) => holeCount(id) === 0);
		expect(zero).toEqual(['git.head', 'git.head-date', 'git.is-shallow', 'git.log-walk']);
	});
});

describe('runRecipe refuses before it spawns', () => {
	const options = { cwd: process.cwd() };

	for (const id of allIds) {
		const holes = holeCount(id);

		if (holes > 0) {
			test(`${id} refuses too few values`, () => {
				// One short, not zero, because zero is the shape a caller reaches by forgetting
				// the array and the interesting one is the caller who dropped a single value:
				// that leaves a flag holding the following flag, and for `--key --output` it is
				// a request for an object literally named `--output`.
				let thrown: unknown;
				try {
					runRecipe(id, fill(id).slice(1), options);
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBeInstanceOf(ExecRefusal);
				expect((thrown as Error).message).toContain(`"${id}"`);
			});

			test(`${id} refuses a value carrying a NUL`, () => {
				const poisoned = fill(id);
				poisoned[0] = `x\u0000y`;
				let thrown: unknown;
				try {
					runRecipe(id, poisoned, options);
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBeInstanceOf(ExecRefusal);
				expect((thrown as Error).message).toContain(`"${id}"`);
				expect((thrown as Error).message).toContain('NUL');
			});
		}

		test(`${id} refuses too many values`, () => {
			let thrown: unknown;
			try {
				runRecipe(id, [...fill(id), SAFE], options);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(ExecRefusal);
			expect((thrown as Error).message).toContain(`"${id}"`);
			// The extra value would otherwise be dropped in silence, which means the caller is
			// holding a different template in their head from the one in the table.
			expect((thrown as Error).message).toContain('dropped silently');
		});
	}

	test('a shell metacharacter reaches the child, and the semicolon is why', () => {
		// This assertion is the inverse of the one it replaces, and the inversion was forced
		// by the first publish against a real bucket rather than by an argument.
		//
		// `runRecipe` used to refuse a class of shell metacharacters in any hole. Two of the
		// content types this repository itself sends carry a semicolon:
		// `text/plain; charset=utf-8` for `llms/*.txt` and `text/markdown; charset=utf-8` for
		// the raw markdown. The publish uploaded two objects and stopped, and no test in this
		// suite could have seen it, because every one of them injects a fake `Exec` and never
		// reaches this function.
		//
		// The semicolon is only the instance. An ampersand in a cache directory name and a
		// backtick in a checkout path are the same defect waiting, and the module's own
		// comment already said why none of them is dangerous: `spawnSync` takes an argv array
		// with `shell: false`, so no shell parses a value. The child still applies its own
		// argument semantics to whatever it is handed, which is what `REFUSED_IN_ARGV`'s
		// paragraph names and none of these characters is part of. Each is asserted here as a
		// value that gets through, so restoring the class turns this red with the reason
		// beside it.
		const admitted = ['`', '$', ';', '|', '&', '>', '<', '\\', ' '];
		for (const character of admitted) {
			expect(
				() => runRecipe('gh.api', [`repos/x${character}y`], { cwd: '/nonexistent' }),
				`${JSON.stringify(character)} was refused`,
			).not.toThrow(ExecRefusal);
		}
		// The real value, spelled exactly as `s3/keys.ts` sends it. Named separately from the
		// loop because this is the one the bucket refused.
		expect(() =>
			runRecipe(
				'aws.put-object',
				['bucket', 'llms/en.txt', '/tmp/body', 'text/plain; charset=utf-8', 'AAAA'],
				{ cwd: '/nonexistent' },
			),
		).not.toThrow(ExecRefusal);
	});

	/**
	 * How this assertion got here, because the history is the argument for it.
	 *
	 * It began as a marked failure against a defect in `kit/src/exec/run.ts`. The class
	 * there was written ``/[`$;|&><\\\n\r ]/``, which reads in an editor and in every diff
	 * as ending with a space. It did not: the last character was a raw U+0000, written into
	 * the file as a byte, so the class refused the NUL and admitted the space it appeared to
	 * name. An invisible control character in shipped source is the failure the house rule
	 * about writing non-ASCII as `\uXXXX` exists to stop, in the one file where a reviewer
	 * most needs to read the characters literally.
	 *
	 * Both halves were then settled the other way round from the way the marked failure
	 * argued. The class is gone except for the NUL, which node refuses on its own account,
	 * so what is left buys a named refusal rather than an `ERR_INVALID_ARG_VALUE` naming
	 * neither the recipe nor the value. And the space stays admitted, on purpose, which is
	 * what this test now pins.
	 */
	test('a value containing a space reaches the child, deliberately', () => {
		// A space is the separator a shell splits on, so it looks like it belongs. What
		// makes leaving it out safe is that no class here is the guarantee: `spawnSync` is
		// called with an argv array and `shell: false`, so no shell ever parses a value. The
		// fixed template is the guarantee. What makes leaving it out necessary is that a
		// hole is often a filesystem path, and refusing a space would break a repository
		// checked out under a path containing one, which on macOS is ordinary.
		//
		// The byte that used to stand in this class where a space appeared to be is now
		// written as an escape, which is the other half of the same finding.
		expect(() => runRecipe('gh.api', ['repos/hex pro'], { cwd: '/nonexistent' })).not.toThrow(
			ExecRefusal,
		);
	});

	test('U+0000 is still refused, and it is written as an escape', () => {
		// The one member left. It buys a named refusal rather than node's own
		// `ERR_INVALID_ARG_VALUE`, which names neither the recipe nor the value, and it is a
		// message rather than a security control: node refuses it either way.
		//
		// The source spells it `\u0000` rather than carrying the raw byte. An invisible
		// character in this file is the one place the house rule about escapes matters most,
		// and it stood here as a byte once: nobody reviewing that line could see what it said.
		expect(() => runRecipe('gh.api', [`repos/x\u0000y`], { cwd: '/nonexistent' })).toThrow(
			ExecRefusal,
		);
		const source = readFileSync(join(import.meta.dirname, '../../src/exec/run.ts'), 'utf8');
		const line = source.split('\n').find((row) => row.includes('const REFUSED_IN_ARGV')) ?? '';
		expect(line).not.toContain('\u0000');
		expect(line).toContain('u0000');
	});
});

describe('NO_EXEC', () => {
	test('refuses every recipe by name, in both directions', () => {
		// The context the design gives a caller that must not run anything. It is not what
		// the MCP server carries, and `kit/test/exec/no-write.test.ts` says why: two
		// read-only tools genuinely need git.
		for (const id of allIds) {
			let thrown: unknown;
			try {
				NO_EXEC(id, [], { cwd: process.cwd() });
			} catch (error) {
				thrown = error;
			}
			expect(thrown, `NO_EXEC ran ${id}`).toBeInstanceOf(ExecRefusal);
			expect((thrown as Error).message).toContain(`"${id}"`);
		}
		expect(allIds.length).toBe(READ_IDS.length + WRITE_IDS.length);
	});
});
