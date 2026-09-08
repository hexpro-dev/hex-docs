/**
 * Every external command this package may run, as a fixed argv template.
 *
 * There is no argv parameter anywhere in `kit/src/exec`. `git clean -fd` is not denied,
 * it is unrepresentable: a caller names a recipe and supplies values for its holes, and
 * the flags are part of the template.
 *
 * That is the difference between this and the two weaker shapes it replaces. A binary
 * allowlist is what `hex-terraform/mcp/src/lib/exec.ts` ships, `new Set(["aws",
 * "terraform", "git"])` with no subcommand filter, and its `aws.ts` carries the comment
 * "Subcommand allowlist: ALL of these are read-only" describing wrapper functions rather
 * than a guard. Replayed against those predicates, `git clean -fd`, `git reset --hard
 * origin/main`, `aws s3 rm --recursive` and `terraform apply -auto-approve` all pass.
 * A subcommand allowlist closes most of that and leaves a residue, because the dangerous
 * form of a permitted subcommand is a flag: `git checkout -- .` is a `checkout`, and
 * `git -c core.hooksPath=/tmp/x log` is a `log` to anything reading `args[0]`.
 *
 * A recipe table has neither hole. The subcommand and every flag are literals in this
 * file, and the only thing a caller controls is a value in a position the template
 * chose.
 *
 * `kit/test/exec/recipes.test.ts` pins these ids in both directions, so widening the
 * table is a visible diff in a test rather than a line added to a set.
 */

/**
 * A value the caller supplies, in a position the template chose.
 *
 * A symbol rather than a string sentinel, so no argument value can ever be mistaken for
 * a hole. `'HOLE'` as a literal would be a real bucket name away from a template that
 * fills itself.
 */
export const HOLE = Symbol('hole');

export type Slot = string | typeof HOLE;

export interface Recipe {
	readonly bin: 'git' | 'aws' | 'gh';
	readonly argv: readonly Slot[];
	/** One sentence: what this reads, and why running it is safe. */
	readonly why: string;
}

/**
 * The reads. Nothing here changes anything, anywhere.
 *
 * The four `git` entries at the top are exactly the four calls `kit/src/compile/git.ts`
 * makes. It was the one place in the package that spawned a process directly, and it
 * moved behind this table rather than being exempted from it, because this repository
 * has exactly one exemption mechanism and it is scoped to `fixtures/`.
 */
export const READ_RECIPES = {
	'git.head': {
		bin: 'git',
		argv: ['rev-parse', 'HEAD'],
		why: 'The commit a bundle is keyed by. Bundles are commit addressed.',
	},
	'git.head-date': {
		bin: 'git',
		argv: ['log', '-1', '--format=%cI'],
		why: 'The head committer date, which the manifest records.',
	},
	'git.is-shallow': {
		bin: 'git',
		argv: ['rev-parse', '--is-shallow-repository'],
		why: 'A shallow clone dates every file the same and makes the whole corpus read current.',
	},
	'git.log-walk': {
		bin: 'git',
		// U+0001 opens each commit's date line so the parse can tell it from a file name,
		// and it is written as an escape because the character itself is invisible in a
		// diff and this argv is the one thing a reviewer has to read literally. The parse
		// half is `COMMIT_MARKER` in `compile/git.ts`; the two are one decision.
		argv: ['log', '--format=\u0001%cI', '--name-only', '--diff-merges=combined'],
		why: 'One walk for every file date, instead of one process per file.',
	},
	'git.ls-files-stage': {
		bin: 'git',
		argv: ['ls-files', '-s', '--', HOLE],
		why: 'The gitlink mode of a path, which says whether a declared submodule is committed.',
	},
	'git.merge-base-is-ancestor': {
		bin: 'git',
		argv: ['merge-base', '--is-ancestor', HOLE, HOLE],
		why: 'Whether a commit being labelled is on the branch it claims to be on.',
	},
	'gh.api': {
		bin: 'gh',
		argv: ['api', HOLE],
		why: 'Ancestry against a remote, from a repository that does not contain the commit.',
	},
	'aws.head-object': {
		bin: 'aws',
		argv: ['s3api', 'head-object', '--bucket', HOLE, '--key', HOLE, '--output', 'json'],
		why: 'The publish preflight, and resolving a labelled sha to a bundle that exists.',
	},
	'aws.list-objects': {
		bin: 'aws',
		argv: [
			's3api',
			'list-objects-v2',
			'--bucket',
			HOLE,
			'--prefix',
			HOLE,
			'--max-items',
			HOLE,
			'--output',
			'json',
		],
		why: 'Reconciling what a prefix already holds. Paginated: see the continuation hole below.',
	},
	'aws.list-objects-page': {
		bin: 'aws',
		argv: [
			's3api',
			'list-objects-v2',
			'--bucket',
			HOLE,
			'--prefix',
			HOLE,
			'--max-items',
			HOLE,
			'--starting-token',
			HOLE,
			'--output',
			'json',
		],
		why: 'The second and later pages. A full bundle crosses a thousand keys once a manual has sixty pages in seven locales, so a single unpaginated call would silently report the tail absent.',
	},
	'aws.get-object': {
		bin: 'aws',
		argv: ['s3api', 'get-object', '--bucket', HOLE, '--key', HOLE, HOLE, '--output', 'json'],
		why: 'Prefetch. The third hole is the output path, which s3api takes positionally.',
	},
} as const satisfies Readonly<Record<string, Recipe>>;

/**
 * The one recipe that writes, in its own table and its own module-level constant.
 *
 * Split from the reads so the import-graph test has something to assert about: nothing
 * reachable from `kit/src/mcp/` may import this binding, and `kit/test/exec/no-write.test.ts`
 * walks the graph to prove it. A single table with a `mutates: true` flag would make
 * that a runtime property of a field somebody can edit.
 *
 * `--if-none-match '*'` is inside the template rather than assembled at the call site,
 * so a publish that omits server-side write-once does not typecheck into existence. It
 * is the third of three enforcements: `writeBundle` refuses locally, this refuses at
 * S3, and the preflight compares checksums before either.
 */
export const WRITE_RECIPES = {
	'aws.put-object': {
		bin: 'aws',
		argv: [
			's3api',
			'put-object',
			'--bucket',
			HOLE,
			'--key',
			HOLE,
			'--body',
			HOLE,
			'--content-type',
			HOLE,
			'--cache-control',
			'public, max-age=31536000, immutable',
			'--checksum-sha256',
			HOLE,
			'--if-none-match',
			'*',
			'--output',
			'json',
		],
		why: 'Publishing one object. The only write in the toolchain.',
	},
	/**
	 * The same put with a `Content-Encoding`.
	 *
	 * A separate recipe rather than a conditional flag, because a conditional would put
	 * a caller in charge of whether a gzipped member is labelled as one, and an
	 * unlabelled gzip member is served to a browser as bytes it cannot decode. Which one
	 * to use is decided by the key, in `s3/keys.ts`, from a table.
	 */
	'aws.put-object-gzip': {
		bin: 'aws',
		argv: [
			's3api',
			'put-object',
			'--bucket',
			HOLE,
			'--key',
			HOLE,
			'--body',
			HOLE,
			'--content-type',
			HOLE,
			'--content-encoding',
			'gzip',
			'--cache-control',
			'public, max-age=31536000, immutable',
			'--checksum-sha256',
			HOLE,
			'--if-none-match',
			'*',
			'--output',
			'json',
		],
		why: 'Publishing one gzipped object, labelled so a browser decodes it.',
	},
} as const satisfies Readonly<Record<string, Recipe>>;

export const ALL_RECIPES = { ...READ_RECIPES, ...WRITE_RECIPES } as const;

export type ReadRecipeId = keyof typeof READ_RECIPES;
export type WriteRecipeId = keyof typeof WRITE_RECIPES;
export type RecipeId = ReadRecipeId | WriteRecipeId;

/** How many values a recipe expects. Derived, so it cannot disagree with the template. */
export function holeCount(id: RecipeId): number {
	return (ALL_RECIPES[id] as Recipe).argv.filter((slot) => slot === HOLE).length;
}
