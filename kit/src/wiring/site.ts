/**
 * What one consuming website looks like, derived rather than declared.
 *
 * The critique of the design this replaces proposed a `hexdocs.site.json` descriptor
 * file per consuming site, which is refused for a stated reason: `CLAUDE.md` already
 * warns that `DocsProjectConfig` and `DocsSiteConfig` must never be confused, and a
 * third configuration file beside `<project>.docs.json` is a confusion generator. Every
 * field here is read out of files the consumer already has, and where one cannot be
 * determined the row that needed it is `skipped` with the reason rather than guessed.
 *
 * The two consumers differ in shape, not only in content, and that is why this type
 * exists at all. `hex-web/apps/front` mounts at `common/docs` under a `common/*`
 * workspace glob, with a composed `LOCALISED_PATHS`, an existing `prebuild` shared by
 * four front packages, a JSONC `tsconfig.json` and a populated `hash.extra_dirs.front`.
 * `kcalc-ai/kcalc-web/front` mounts at `kcalc-web/docs` under an explicit literal
 * workspace include list with no glob and no exclusion anywhere, with `LOCALISED_PATHS`
 * a readonly alias of one registry, no `prebuild` at all, a comment-free `tsconfig.json`
 * and a `hash.extra_dirs` holding only a `worker` key. A check written against either
 * shape fails the other, so every check reads this descriptor instead of a constant.
 */

import type { DocsSiteConfig } from '../../../src/contracts/site.js';

/**
 * Every file read in this layer goes through here.
 *
 * A seam rather than `node:fs` at each site, so a test can drive the whole wiring layer
 * from a `Map` of paths to text without materialising a consumer tree, and so `install`
 * and `verify-install` cannot end up reading through two different resolvers. Paths are
 * always repository-relative with forward slashes: they are also finding locations and
 * lines in a printed instruction, none of which is a filesystem path on the machine
 * reading it.
 */
export interface RepoFiles {
	read(relative: string): string | null;
	exists(relative: string): boolean;
	/** Entry names in a directory, sorted. Empty when the path is not a directory. */
	list(relative: string): readonly string[];
}

/**
 * How the mount path was arrived at, so a check can say rather than assert.
 *
 * `self` is the strongest and is the ordinary case: `bin/hexdocs` runs from inside the
 * submodule, so the package's own location inside the repository is a fact rather than a
 * convention. `convention` is the weakest and is what a check names when it reports a
 * missing submodule, because at that point nothing on disk says where the mount belongs
 * and the answer is a proposal.
 */
export type MountSource = 'flag' | 'self' | 'gitmodules' | 'convention';

/** One `<project>.docs.json` under `<site>/app/docs/`. */
export interface SiteProject {
	/** Repository-relative path to the file. */
	readonly file: string;
	/** `null` when the file did not parse or did not validate. */
	readonly config: DocsSiteConfig | null;
	/** Why it did not validate. `null` when it did. */
	readonly problem: string | null;
}

export interface WorkspaceEnrolment {
	/** `null` when there is no `pnpm-workspace.yaml`, which is a skip and not a failure. */
	readonly file: string | null;
	/** Every `packages:` entry as written, exclusions included, in file order. */
	readonly entries: readonly string[];
	/**
	 * Whether anything in `packages:` enrols the mount as a workspace package.
	 *
	 * This is the question, and a line is not. hex-web's line 3 is `- common/*`, a glob
	 * that enrols `common/docs` the moment the submodule lands, so an exclusion is
	 * required there. kcalc's file is an explicit literal include list with no glob and
	 * no `!` line anywhere, so the mount is already not enrolled and an exclusion would
	 * be inert decoration. A check that asserted the presence of an exclusion line would
	 * fail a correctly wired kcalc forever.
	 */
	readonly enrols: boolean;
	/** The include pattern that enrols it, when one does. */
	readonly enrolledBy: string | null;
	/** The `!` pattern that excludes it, when one does. */
	readonly excludedBy: string | null;
}

export interface SiteDescriptor {
	/** Absolute path to the repository root. Everything else is relative to it. */
	readonly repoRoot: string;
	/** The consuming site directory, repository-relative: `apps/front`. */
	readonly site: string;
	/** Where the docs package is mounted, repository-relative: `common/docs`. */
	readonly mount: string;
	readonly mountSource: MountSource;
	/** `common/docs` seen from `apps/front`: `../../common/docs`. */
	readonly mountFromSite: string;
	/** The repository root seen from the site directory: `../..`. */
	readonly repoFromSite: string;
	/**
	 * The `deploy.config.json` project type this site is, or `null`.
	 *
	 * Derived by matching the site path against `sites.*.projects.*.path` rather than
	 * assumed to be `front`. It is the key `hash.extra_dirs` is keyed by, and
	 * `hex-terraform/deploy/src/hash.ts:50` reads `extraDirs[type]` where `type` is the
	 * project type and not the site, so one entry covers every front in the repository.
	 */
	readonly projectType: string | null;
	readonly workspace: WorkspaceEnrolment;
	/** Every `<site>/app/docs/*.docs.json`, in sorted order. */
	readonly projects: readonly SiteProject[];
	readonly files: RepoFiles;
}

/** The configs that parsed. The ones that did not are reported by their own check. */
export function validConfigs(site: SiteDescriptor): DocsSiteConfig[] {
	return site.projects
		.map((project) => project.config)
		.filter((config): config is DocsSiteConfig => config !== null);
}

/**
 * The three route modules a docs mount needs, relative to the site's `app/` directory.
 *
 * Constants of this package rather than facts about a consumer, which is what makes the
 * needles portable: `install` writes `app/lib/docs.ts`, this package chose the
 * identifiers in it, and `docsRouteRows` in the runtime half chose these file names. A
 * per-consumer needle table would have been a second thing to maintain per install.
 */
export const DOCS_ROUTE_MODULES = [
	'routes/docs.tsx',
	'routes/docs.machine.tsx',
	'routes/docs.raw.tsx',
] as const;

/** The remote the submodule is added from. One spelling, used by the edit and the check. */
export const DOCS_REMOTE = 'git@github.com:hexpro-dev/hex-docs.git';

/** Joins repository-relative segments. Forward slashes, never `path.join`. */
export function joinPosix(...parts: readonly string[]): string {
	return parts
		.filter((part) => part !== '')
		.join('/')
		.replace(/\/+/g, '/');
}

/** `a/b/c` from `a/b/c/d.json`. Empty for a top-level file. */
export function dirnamePosix(value: string): string {
	const at = value.lastIndexOf('/');
	return at === -1 ? '' : value.slice(0, at);
}

/**
 * `from` to `to`, both repository-relative, as a forward-slash relative path.
 *
 * Hand written rather than `node:path`'s `relative`, because these are not filesystem
 * paths: they are written into a consumer's `tsconfig.json`, its `package.json` scripts
 * and its `.mcp.json`, all of which are read on a machine whose separator is irrelevant
 * to what those files mean.
 */
export function relativePosix(from: string, to: string): string {
	const fromParts = from.split('/').filter((part) => part !== '');
	const toParts = to.split('/').filter((part) => part !== '');
	let shared = 0;
	while (
		shared < fromParts.length &&
		shared < toParts.length &&
		fromParts[shared] === toParts[shared]
	) {
		shared += 1;
	}
	const up = new Array<string>(fromParts.length - shared).fill('..');
	const down = toParts.slice(shared);
	const parts = [...up, ...down];
	return parts.length === 0 ? '.' : parts.join('/');
}

/** Resolves a relative reference against a repository-relative directory. */
export function resolveFrom(dir: string, reference: string): string {
	const parts = [...dir.split('/'), ...reference.split('/')].filter((part) => part !== '');
	const stack: string[] = [];
	for (const part of parts) {
		if (part === '.') continue;
		if (part === '..') {
			stack.pop();
			continue;
		}
		stack.push(part);
	}
	return stack.join('/');
}

/**
 * `--site`, narrowed to the string it always is.
 *
 * `SITE` in `kit/src/commands/common.ts` is annotated `Param` rather than declared
 * `as const`, which erases `required: true` from its type, so `Input<P>` cannot see that
 * this argument is always present. Zod can: `shapeOf` builds it as a required non-empty
 * string and `invoke` parses before `run` is called, so neither front door can reach the
 * branch below.
 *
 * A throw rather than a cast, because the branch is not quite unreachable: a test or a
 * future caller constructing an input object by hand skips the parse, and a cast there
 * would produce `undefined` inside path arithmetic and a descriptor pointing at the
 * repository root.
 */
export function requireSitePath(value: string | undefined): string {
	if (value === undefined || value === '') {
		throw new Error(
			'This command needs --site: the consuming site directory relative to the repository root, such as apps/front.',
		);
	}
	return value;
}
