/**
 * A `SiteDescriptor` from a repository on disk.
 *
 * Nothing here fails. A file that is absent, unparseable or the wrong shape leaves the
 * field it would have filled at its neutral value, and the check that needed it reports
 * the state itself with a message a person can act on. That split matters: a detector
 * that threw would turn "this repository has no `pnpm-workspace.yaml`" into a stack
 * trace from a command whose whole job is to explain what is missing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { docsSiteConfigSchema } from '../contracts/config.schema.js';
import type { DocsSiteConfig } from '../../../src/contracts/site.js';

import { parseJsonc } from './needles.js';
import {
	dirnamePosix,
	joinPosix,
	relativePosix,
	type MountSource,
	type RepoFiles,
	type SiteDescriptor,
	type SiteProject,
	type WorkspaceEnrolment,
} from './site.js';

/** A `RepoFiles` over a real directory. */
export function diskFiles(repoRoot: string): RepoFiles {
	const at = (relative: string): string => resolve(repoRoot, relative);
	return {
		read(relative) {
			try {
				return readFileSync(at(relative), 'utf8');
			} catch {
				return null;
			}
		},
		exists(relative) {
			return existsSync(at(relative));
		},
		list(relative) {
			try {
				if (!statSync(at(relative)).isDirectory()) return [];
				return readdirSync(at(relative)).sort();
			} catch {
				return [];
			}
		},
	};
}

/** A `RepoFiles` over a map of repository-relative paths to text, for the tests. */
export function memoryFiles(tree: Readonly<Record<string, string>>): RepoFiles {
	const paths = Object.keys(tree);
	return {
		read: (relative) => tree[relative] ?? null,
		exists: (relative) => relative in tree || paths.some((path) => path.startsWith(`${relative}/`)),
		list(relative) {
			const prefix = relative === '' ? '' : `${relative}/`;
			const names = new Set<string>();
			for (const path of paths) {
				if (!path.startsWith(prefix)) continue;
				const rest = path.slice(prefix.length);
				if (rest === '') continue;
				const head = rest.split('/')[0];
				if (head !== undefined) names.add(head);
			}
			return [...names].sort();
		},
	};
}

/**
 * One `[submodule "..."]` stanza, as `.gitmodules` writes it.
 *
 * The `name` and the `path` are separate fields because they are separate things and
 * both consumers prove it: hex-web's stanza names are `hex-terraform`,
 * `common/google-auth-secret-retriever` and `common/private-image-converter`, so the
 * name happens to equal the path there, and nothing requires that. Every assertion in
 * this package is about the path, which is what git checks out and what
 * `deploy.config.json` and `pnpm-workspace.yaml` both name.
 */
export interface SubmoduleStanza {
	readonly name: string;
	readonly path: string | null;
	readonly url: string | null;
}

export function parseGitmodules(text: string): SubmoduleStanza[] {
	const stanzas: SubmoduleStanza[] = [];
	let current: { name: string; path: string | null; url: string | null } | null = null;
	for (const line of text.split('\n')) {
		const header = /^\s*\[submodule\s+"([^"]*)"\]\s*$/.exec(line);
		if (header !== null) {
			if (current !== null) stanzas.push(current);
			current = { name: header[1] ?? '', path: null, url: null };
			continue;
		}
		if (current === null) continue;
		const entry = /^\s*(path|url)\s*=\s*(.+?)\s*$/.exec(line);
		if (entry === null) continue;
		if (entry[1] === 'path') current.path = entry[2] ?? null;
		else current.url = entry[2] ?? null;
	}
	if (current !== null) stanzas.push(current);
	return stanzas;
}

/**
 * The `packages:` list of a `pnpm-workspace.yaml`, as written.
 *
 * A three-line reader rather than a YAML parser, and the shape of the file is what makes
 * that safe: both consumers write one `- <value>` per line under a single `packages:`
 * key, with `#` comments between entries. The reader stops at the first line that starts
 * a new top-level key, so `onlyBuiltDependencies` and `hoistWorkspacePackages` below it
 * are never read as packages.
 *
 * Quotes are stripped from the value and are not part of the answer, because the
 * question this feeds is whether the mount is enrolled. Whether the exclusion is written
 * with quotes is a separate assertion and it is made against the raw text, not here: the
 * quotes are what `check-tools.mjs:944` matches, and it matches them as a raw substring.
 */
export function parseWorkspacePackages(text: string): string[] {
	const entries: string[] = [];
	let inside = false;
	for (const line of text.split('\n')) {
		if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
		if (/^packages\s*:/.test(line)) {
			inside = true;
			continue;
		}
		if (!inside) continue;
		const item = /^\s+-\s*(.+?)\s*$/.exec(line);
		if (item === null) {
			// A line at column zero that is not a list item ends the block. Anything else
			// is malformed and is left out rather than guessed at.
			if (/^\S/.test(line)) inside = false;
			continue;
		}
		const value = (item[1] ?? '').replace(/^["']|["']$/g, '');
		if (value !== '') entries.push(value);
	}
	return entries;
}

/**
 * Whether a pnpm workspace pattern matches a path.
 *
 * `*` matches within one segment and `**` matches across segments, which is pnpm's own
 * reading of these globs. Anything without a wildcard is compared literally, because
 * that is the whole of kcalc's file and treating a literal as a prefix would enrol
 * `kcalc-web/docs` under the `kcalc-web/front` entry.
 */
export function workspaceMatches(pattern: string, path: string): boolean {
	const cleaned = pattern.replace(/^!/, '').replace(/\/+$/, '');
	if (!cleaned.includes('*')) return cleaned === path;
	const source = cleaned
		.split('**')
		.map((part) =>
			part
				.split('*')
				.map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
				.join('[^/]*'),
		)
		.join('.*');
	return new RegExp(`^${source}$`).test(path);
}

export function workspaceEnrolment(files: RepoFiles, mount: string): WorkspaceEnrolment {
	const file = 'pnpm-workspace.yaml';
	const text = files.read(file);
	if (text === null) {
		return { file: null, entries: [], enrols: false, enrolledBy: null, excludedBy: null };
	}
	const entries = parseWorkspacePackages(text);
	let enrolledBy: string | null = null;
	let excludedBy: string | null = null;
	for (const entry of entries) {
		if (!workspaceMatches(entry, mount)) continue;
		if (entry.startsWith('!')) excludedBy = entry;
		else enrolledBy = entry;
	}
	return {
		file,
		entries,
		enrols: enrolledBy !== null && excludedBy === null,
		enrolledBy,
		excludedBy,
	};
}

/**
 * The `deploy.config.json` project type whose `path` is this site.
 *
 * Matched rather than assumed to be `front`. Both consumers happen to call it `front`,
 * and the key that matters is the one the deploy actually reads: `hash.extra_dirs` is
 * keyed by project type, so a site whose type is something else would have the docs
 * submodule added to a key nothing hashes, the deploy would report `unchanged`, and
 * production would keep serving the old code. That is the exact failure the check
 * exists for, reproduced by a hard-coded key.
 */
export function projectTypeOf(files: RepoFiles, site: string): string | null {
	const parsed = parseJsonc(files.read('deploy.config.json') ?? '');
	if (parsed === null || typeof parsed !== 'object') return null;
	const sites = (parsed as { sites?: unknown }).sites;
	if (sites === null || typeof sites !== 'object') return null;
	for (const entry of Object.values(sites as Record<string, unknown>)) {
		if (entry === null || typeof entry !== 'object') continue;
		const projects = (entry as { projects?: unknown }).projects;
		if (projects === null || typeof projects !== 'object') continue;
		for (const [type, project] of Object.entries(projects as Record<string, unknown>)) {
			if (project === null || typeof project !== 'object') continue;
			if ((project as { path?: unknown }).path === site) return type;
		}
	}
	return null;
}

/** Where this package is mounted, when it is inside the repository being wired. */
export function selfMount(repoRoot: string): string | null {
	// Two levels up from `kit/src/wiring/` is `kit/`, and one more is the package root.
	const packageRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
	const root = resolve(repoRoot);
	if (packageRoot === root) return null;
	if (!packageRoot.startsWith(`${root}/`)) return null;
	return packageRoot
		.slice(root.length + 1)
		.split('/')
		.join('/');
}

/**
 * Where the mount belongs when nothing on disk says.
 *
 * `common/` when the repository already keeps its source-consumed submodules there,
 * which is hex-web's shape and is why the two existing entries in its `tsconfig` `paths`
 * live under that directory. Otherwise beside the site, which gives `kcalc-web/docs` for
 * a site at `kcalc-web/front`. Both are proposals, and `mountSource` says so, so a check
 * that reports a missing submodule names a path the reader can disagree with.
 */
export function conventionalMount(files: RepoFiles, site: string): string {
	if (files.exists('common')) return 'common/docs';
	const parent = dirnamePosix(site);
	return parent === '' ? 'docs' : joinPosix(parent, 'docs');
}

function readProjects(files: RepoFiles, site: string): SiteProject[] {
	const dir = joinPosix(site, 'app/docs');
	const projects: SiteProject[] = [];
	for (const name of files.list(dir)) {
		if (!name.endsWith('.docs.json')) continue;
		const file = joinPosix(dir, name);
		const text = files.read(file);
		if (text === null) {
			projects.push({ file, config: null, problem: 'the file could not be read' });
			continue;
		}
		const parsed = parseJsonc(text);
		if (parsed === null) {
			projects.push({ file, config: null, problem: 'the file is not valid JSON' });
			continue;
		}
		const result = docsSiteConfigSchema.safeParse(parsed);
		if (!result.success) {
			projects.push({
				file,
				config: null,
				problem: result.error.issues
					.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
					.join('; '),
			});
			continue;
		}
		projects.push({ file, config: result.data as DocsSiteConfig, problem: null });
	}
	return projects;
}

export interface DetectOptions {
	/** Absolute. */
	readonly repoRoot: string;
	/** Repository-relative, forward slashes: `apps/front`. */
	readonly site: string;
	/** Overrides every other source. */
	readonly mount?: string | undefined;
	readonly files?: RepoFiles;
}

export function detectSite(options: DetectOptions): SiteDescriptor {
	const files = options.files ?? diskFiles(options.repoRoot);
	const site = options.site.replace(/^\.?\/+/, '').replace(/\/+$/, '');

	let mount = options.mount;
	let mountSource: MountSource = 'flag';
	if (mount === undefined || mount === '') {
		const own = selfMount(options.repoRoot);
		if (own !== null && files.exists(joinPosix(own, 'kit'))) {
			mount = own;
			mountSource = 'self';
		}
	}
	if (mount === undefined || mount === '') {
		const declared = parseGitmodules(files.read('.gitmodules') ?? '').find(
			(stanza) => stanza.url !== null && /hex-docs(\.git)?$/.test(stanza.url),
		);
		if (declared?.path != null && declared.path !== '') {
			mount = declared.path;
			mountSource = 'gitmodules';
		}
	}
	if (mount === undefined || mount === '') {
		mount = conventionalMount(files, site);
		mountSource = 'convention';
	}

	return {
		repoRoot: resolve(options.repoRoot),
		site,
		mount,
		mountSource,
		mountFromSite: relativePosix(site, mount),
		repoFromSite: relativePosix(site, ''),
		projectType: projectTypeOf(files, site),
		workspace: workspaceEnrolment(files, mount),
		projects: readProjects(files, site),
		files,
	};
}
