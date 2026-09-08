/**
 * The nine consumer wiring checks, over the predicates `install` writes with.
 *
 * Every row here calls the matching entry in `PRESENT` from `edits.ts` and then adds the
 * assertions no edit can make: whether a `paths` target resolves to a real file, whether
 * a declared submodule is actually committed, whether a route module exports `headers`.
 * That split is what makes `install` re-running a no-op exactly when this passes.
 *
 * Every finding is built with `raw()` and turned into a `Finding` by `runLint`. Nothing
 * here assembles a `Finding` object: `toFinding` is module private in `run.ts` on
 * purpose, and it is what attaches the consequence sentence from `CHECK_DEFINITIONS` and
 * pins a check to `error`. A hand-assembled finding would be one with whatever
 * consequence the author of the day thought of.
 *
 * The states are used as `diagnostics.ts` defines them and not as convenience. A repo
 * with no `pnpm-workspace.yaml` and one with no `deploy.config.json` are `skipped` with
 * a reason, because there is nothing there to be wrong; a file that exists and cannot be
 * parsed is `failedRow`, because refusing to report success on a file this check cannot
 * see is the house idiom (`check-tools.mjs:317-324`); and a row that examined nothing is
 * a failure whatever else is true of it, which `checkRow` coerces rather than trusting.
 */

import {
	checkRow,
	failedRow,
	skippedRow,
	type CheckRow,
	type Finding,
	type FindingLocation,
} from '../../../src/contracts/diagnostics.js';
import type { CheckId } from '../../../src/contracts/lint.js';
import { DEFAULT_BUDGETS, DOCS_CONFIG_VERSION } from '../../../src/contracts/project.js';
import type { DocsProjectConfig } from '../../../src/contracts/project.js';
import {
	docsLocalisedPathsFor,
	docsRouteRows,
	docsSitemapRows,
} from '../../../src/site/address.js';
import { CHECK_DEFINITIONS } from '../compile/lint/registry.js';
import { runLint } from '../compile/lint/run.js';
import { raw, type RawFinding } from '../compile/types.js';
import type { Exec } from '../exec/run.js';

import { parseGitmodules, parseWorkspacePackages } from './detect.js';
import {
	PRESENT,
	editById,
	prebuildFragment,
	resolveJsonModuleOf,
	settingsSatisfied,
	tsconfigPathEntries,
} from './edits.js';
import { parseJsonc, stripComments, structural } from './needles.js';
import {
	DOCS_ROUTE_MODULES,
	joinPosix,
	resolveFrom,
	validConfigs,
	type SiteDescriptor,
} from './site.js';
import { mcpServerEntry } from './templates.js';

/**
 * The nine that are about a consuming website.
 *
 * `wiring-allow-paths` and `wiring-forbidden-agent-files` are about an app repository's
 * public mirror and belong to `hexdocs check`, not here: a web repository has no mirror
 * script, and a pass there would be a green row over a file that is not being read.
 *
 * Pinned against `CheckId` so a renamed check id fails the typecheck by name, and used
 * as the key type of `PROBES` below so a deleted probe does the same.
 */
export const CONSUMER_CHECK_IDS = [
	'wiring-submodule',
	'wiring-workspace-exclusion',
	'wiring-tsconfig-path',
	'wiring-deploy-hash-dirs',
	'wiring-prebuild-hook',
	'wiring-routes',
	'wiring-localised-paths',
	'wiring-sitemap',
	'wiring-mcp',
] as const satisfies readonly CheckId[];

export type ConsumerCheckId = (typeof CONSUMER_CHECK_IDS)[number];

export interface ProbeContext {
	readonly exec: Exec;
	readonly kitVersion: string;
}

export interface WiringProbe {
	readonly id: ConsumerCheckId;
	run(site: SiteDescriptor, ctx: ProbeContext): CheckRow;
}

/**
 * A project config that exists only to satisfy `runLint`'s signature.
 *
 * `runLint` pins every `CheckId` to `error` before it consults the configuration, so
 * nothing in this object changes an answer here. It exists because the alternative is a
 * second path into `Finding`, and that path would skip the consequence table and the
 * ordering. `verify-install` runs in a web repository, where there is no
 * `docs/site/docs.json` to read: there is no real config to pass.
 */
const WIRING_CONFIG: DocsProjectConfig = {
	docs: DOCS_CONFIG_VERSION,
	project: 'wiring',
	productName: 'wiring',
	repo: 'hexpro-dev/hex-docs',
	defaultAudience: 'both',
	headingIds: 'slug',
	sections: [],
	i18n: { locales: ['en'], sourceLocale: 'en', parity: 'graceful' },
	budgets: DEFAULT_BUDGETS,
	code: { languages: ['text'] },
	toc: { enabled: true, maxDepth: 3, minHeadings: 3 },
	lint: { extends: 'house', maxDisables: 0 },
};

function findingsOf(entries: readonly RawFinding[], kitVersion: string): Finding[] {
	return runLint(entries, { config: WIRING_CONFIG, disables: [], kitVersion }).envelope.findings;
}

function at(file: string): FindingLocation {
	return { kind: 'file', file };
}

/** A row, with its unit taken from the check's own definition rather than restated. */
function row(
	id: ConsumerCheckId,
	examined: number,
	entries: readonly RawFinding[],
	ctx: ProbeContext,
	note: string | null = null,
): CheckRow {
	return checkRow(
		id,
		examined,
		CHECK_DEFINITIONS[id].unit,
		findingsOf(entries, ctx.kitVersion),
		note,
	);
}

function unitOf(id: ConsumerCheckId): string {
	return CHECK_DEFINITIONS[id].unit;
}

/**
 * A finding's remediation, taken from the instruction `install` prints.
 *
 * One source rather than two registers of the same sentence, and the shortening is the
 * reason it is derived rather than copied. `Finding.remediation` is one line of prose in
 * a table that indents nothing after the first, so the whole printed block would render
 * as a wall against the left margin in three renderers at once. The rule is the first
 * paragraph, plus the next one when it ends in a colon, because that is where an
 * instruction that opens with a sentence and then a command puts the command.
 */
function remediationFor(site: SiteDescriptor, id: string): string {
	const instruction = editById(site, id)?.instruction ?? '';
	const paragraphs = instruction.split('\n\n').map((part) => part.trim());
	const first = paragraphs[0] ?? '';
	const taken = first.endsWith(':') ? [first, paragraphs[1] ?? ''] : [first];
	return taken.join(' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------

const submodule: WiringProbe = {
	id: 'wiring-submodule',
	run(site, ctx) {
		const id = 'wiring-submodule';
		const file = '.gitmodules';
		const text = site.files.read(file);
		const stanzas = parseGitmodules(text ?? '');
		const entries: RawFinding[] = [];
		let examined = stanzas.length;
		let note: string | null = null;

		if (!PRESENT.submodule(text, site)) {
			entries.push(
				raw(
					id,
					at(file),
					null,
					`${file} declares no submodule at \`${site.mount}\`.` +
						(site.mountSource === 'convention'
							? " That path is this command's proposal, not something on disk: nothing here says where the mount belongs."
							: ''),
					{ remediation: remediationFor(site, 'submodule') },
				),
			);
		} else {
			// The stanza and the gitlink are two different facts, and only one of them is
			// in a file. `check-tools.mjs:953-960` makes the same distinction: a directory
			// that exists with no `160000` entry in the index is a superproject that
			// records no commit for it, so a fresh clone gets an empty directory and the
			// failure arrives as a module resolution error inside the build.
			const result = ctx.exec('git.ls-files-stage', [site.mount], { cwd: site.repoRoot });
			if (result.status === null) {
				note =
					'git is not available here, so the gitlink was not checked. The stanza in .gitmodules was.';
			} else if (result.status !== 0) {
				note = `git ls-files exited ${result.status} here, so the gitlink was not checked. The stanza in .gitmodules was.`;
			} else {
				examined += 1;
				if (!/^160000 [0-9a-f]{40}/.test(result.stdout.trim())) {
					entries.push(
						raw(
							id,
							at(file),
							null,
							`.gitmodules declares \`${site.mount}\` and git records no gitlink for it.`,
							{
								remediation:
									'The directory exists but the superproject does not record a commit for it, so a fresh clone gets nothing. Run `git add ' +
									site.mount +
									'` and commit the pin.',
							},
						),
					);
				}
			}
		}

		return row(id, examined, entries, ctx, note);
	},
};

const workspaceExclusion: WiringProbe = {
	id: 'wiring-workspace-exclusion',
	run(site, ctx) {
		const id = 'wiring-workspace-exclusion';
		const file = 'pnpm-workspace.yaml';
		const text = site.files.read(file);
		if (text === null) {
			return skippedRow(
				id,
				unitOf(id),
				'this repository has no pnpm-workspace.yaml, so nothing can enrol the mount as a workspace package',
			);
		}

		const entries = parseWorkspacePackages(text);
		if (entries.length === 0) {
			return failedRow(
				id,
				0,
				unitOf(id),
				'Read zero packages entries out of pnpm-workspace.yaml. Refusing to report success on a list this check cannot see.',
			);
		}

		const findings: RawFinding[] = [];
		if (!PRESENT.workspaceExclusion(text, site)) {
			const unquoted = text.includes(`- !${site.mount}`);
			findings.push(
				raw(
					id,
					at(file),
					null,
					unquoted
						? `pnpm-workspace.yaml excludes \`${site.mount}\` without the double quotes.`
						: `pnpm-workspace.yaml enrols \`${site.mount}\` as a workspace package${site.workspace.enrolledBy === null ? '' : ` through \`${site.workspace.enrolledBy}\``}.`,
					{
						remediation: remediationFor(site, 'workspace-exclusion'),
						suggestion: `  - "!${site.mount}"`,
					},
				),
			);
		}

		// The note carries the state, because "no exclusion is present" is the correct
		// answer on one of the two consumers and the wrong one on the other. kcalc's
		// packages list is explicit literals with no glob, so nothing enrols the mount and
		// an exclusion there would be inert decoration.
		const note =
			site.workspace.excludedBy !== null
				? `excluded by \`${site.workspace.excludedBy}\``
				: site.workspace.enrolledBy === null
					? `no packages entry matches \`${site.mount}\`, so no exclusion is needed here`
					: null;

		return row(id, entries.length, findings, ctx, note);
	},
};

const tsconfigPath: WiringProbe = {
	id: 'wiring-tsconfig-path',
	run(site, ctx) {
		const id = 'wiring-tsconfig-path';
		const file = joinPosix(site.site, 'tsconfig.json');
		const text = site.files.read(file);
		if (text === null) {
			return failedRow(
				id,
				0,
				unitOf(id),
				`${file} does not exist, so this site has no path mapping to check.`,
			);
		}
		const parsed = parseJsonc(text);
		if (parsed === null) {
			return failedRow(
				id,
				0,
				unitOf(id),
				`${file} did not parse, even with comments stripped. Refusing to report success on a configuration this check cannot see.`,
			);
		}

		const findings: RawFinding[] = [];
		let examined = 0;

		if (!PRESENT.tsconfigPaths(text, site)) {
			findings.push(
				raw(id, at(file), null, `${file} does not map the docs package to its TypeScript source.`, {
					remediation: remediationFor(site, 'tsconfig-paths'),
				}),
			);
		}

		// A key that is present and points at a file that is not there is the failure the
		// two existing submodules already have a comment about: nothing in the consuming
		// repository builds a `dist/`, so a mapping that dangles resolves to nothing and
		// the error names a path rather than a missing install.
		for (const [key, target] of tsconfigPathEntries(site)) {
			examined += 1;
			const resolved = resolveFrom(site.site, target);
			if (!site.files.exists(resolved)) {
				findings.push(
					raw(
						id,
						at(file),
						null,
						`\`${key}\` would resolve to \`${resolved}\`, which does not exist.`,
						{
							remediation:
								'Either the submodule is not checked out, or the mount path is wrong. `git submodule update --init --recursive` is the usual answer.',
						},
					),
				);
			}
		}

		examined += 1;
		const resolveJson = resolveJsonModuleOf(site, file);
		if (resolveJson !== true) {
			findings.push(
				raw(
					id,
					at(file),
					null,
					resolveJson === null
						? `Could not determine \`resolveJsonModule\` for ${file}, following its \`extends\` chain.`
						: `\`resolveJsonModule\` is false for ${file}.`,
					{ remediation: remediationFor(site, 'tsconfig-resolve-json') },
				),
			);
		}

		return row(
			id,
			examined,
			findings,
			ctx,
			'`resolveJsonModule` is followed through `extends`: both existing consumers set it in a shared config rather than in the site tsconfig.',
		);
	},
};

const deployHashDirs: WiringProbe = {
	id: 'wiring-deploy-hash-dirs',
	run(site, ctx) {
		const id = 'wiring-deploy-hash-dirs';
		const file = 'deploy.config.json';
		const text = site.files.read(file);
		if (text === null) {
			return skippedRow(
				id,
				unitOf(id),
				'this repository has no deploy.config.json, so there is no change-detection hash to extend',
			);
		}
		const parsed = parseJsonc(text);
		if (parsed === null || typeof parsed !== 'object') {
			return failedRow(
				id,
				0,
				unitOf(id),
				'deploy.config.json did not parse. Refusing to report success on a deploy configuration this check cannot see.',
			);
		}
		if (site.projectType === null) {
			return failedRow(
				id,
				0,
				unitOf(id),
				`deploy.config.json has no project whose path is \`${site.site}\`, so there is no hash key this mount belongs in. hash.extra_dirs is keyed by project type, not by site.`,
			);
		}

		const hash = (parsed as { hash?: unknown }).hash;
		const extra =
			hash !== null && typeof hash === 'object'
				? ((hash as { extra_dirs?: unknown }).extra_dirs ?? null)
				: null;
		const table =
			extra !== null && typeof extra === 'object' ? (extra as Record<string, unknown>) : null;

		let examined = 0;
		if (table !== null) {
			for (const value of Object.values(table)) {
				if (Array.isArray(value)) examined += value.length;
			}
		}

		const findings: RawFinding[] = [];
		if (!PRESENT.deployHashDirs(text, site)) {
			const own = table === null ? undefined : table[site.projectType];
			findings.push(
				raw(
					id,
					at(file),
					null,
					Array.isArray(own)
						? `deploy.config.json does not list \`${site.mount}\` in hash.extra_dirs.${site.projectType}.`
						: `deploy.config.json has no hash.extra_dirs.${site.projectType} key at all, so the docs submodule has nowhere to be listed.`,
					{
						remediation: remediationFor(site, 'deploy-hash-dirs'),
						suggestion: JSON.stringify(site.mount),
					},
				),
			);
		}

		return row(
			id,
			examined,
			findings,
			ctx,
			`extra_dirs is keyed by project type, not by site, so this entry applies to every \`${site.projectType}\` in the repository and adding it rebuilds each of them once.`,
		);
	},
};

const prebuildHook: WiringProbe = {
	id: 'wiring-prebuild-hook',
	run(site, ctx) {
		const id = 'wiring-prebuild-hook';
		const file = joinPosix(site.site, 'package.json');
		const text = site.files.read(file);
		if (text === null) {
			return failedRow(
				id,
				0,
				unitOf(id),
				`${file} does not exist, so this site has no build chain to hang the guard off.`,
			);
		}
		const parsed = parseJsonc(text);
		if (parsed === null || typeof parsed !== 'object') {
			return failedRow(
				id,
				0,
				unitOf(id),
				`${file} did not parse. Refusing to report success on a package this check cannot see.`,
			);
		}
		const scriptsValue = (parsed as { scripts?: unknown }).scripts;
		if (scriptsValue === null || typeof scriptsValue !== 'object') {
			return failedRow(
				id,
				0,
				unitOf(id),
				`${file} has no scripts block, so nothing in it always runs.`,
			);
		}
		const table = scriptsValue as Record<string, unknown>;

		const findings: RawFinding[] = [];
		let examined = 0;
		for (const name of ['prebuild', 'build']) {
			if (typeof table[name] === 'string') examined += 1;
		}

		if (!PRESENT.prebuildHook(text, site)) {
			findings.push(
				raw(id, at(file), null, `Nothing in ${site.site}'s build chain runs the docs guard.`, {
					remediation: remediationFor(site, 'prebuild-hook'),
					suggestion: prebuildFragment(site),
				}),
			);
		}

		// The guard must not have been added to a script other packages share. All four
		// hex-web fronts declare the identical `"prebuild": "../../common/copy-assets.sh"`,
		// so a docs guard inside that file runs for three sites that have no docs, and the
		// first of them to fail it fails a deploy nobody connected to documentation.
		const prebuild = table['prebuild'];
		if (typeof prebuild === 'string') {
			for (const token of prebuild.split(/\s+|&&/)) {
				if (!token.startsWith('../')) continue;
				const shared = resolveFrom(site.site, token);
				// The launcher is not a shared script, it is hexdocs. The docs guard invokes
				// it as `../../common/docs/kit/bin/hexdocs prefetch ...`, which starts with
				// `../` like any other token and whose file naturally contains the word this
				// scan is looking for, so without this a correctly wired repository with the
				// submodule checked out fails its own prebuild row for naming its own
				// launcher, and the only way to green would be to stop invoking it. Measured
				// against the real launcher rather than reasoned about: it prints "hexdocs:
				// installing toolchain dependencies" on first run.
				if (shared === site.mount || shared.startsWith(`${site.mount}/`)) continue;
				const sharedText = site.files.read(shared);
				if (sharedText === null) continue;
				examined += 1;
				if (sharedText.includes('hexdocs')) {
					findings.push(
						raw(id, at(shared), null, `${shared} invokes hexdocs, and it is shared.`, {
							remediation: `Move the docs guard into ${file}'s own prebuild string. A script referenced from outside this package is shared with the other packages that reference it, and the docs guard would run for every one of them.`,
						}),
					);
				}
			}
		}

		// The shim and the ignore entries are the rest of what makes `prebuild` work. They
		// have no check id of their own, and giving them one would be a contract change;
		// they belong here because this row is what asserts that the build chain runs the
		// guard, and a guard that is not there or whose output is committed is the same
		// failure one step along.
		const shimFile = joinPosix(site.site, 'scripts/check-docs.mjs');
		examined += 1;
		if (!PRESENT.checkDocsShim(site.files.read(shimFile), site)) {
			findings.push(
				raw(
					id,
					at(shimFile),
					null,
					`${shimFile} is missing or is not a guard for \`${site.site}\`.`,
					{
						remediation: 'Run `hexdocs install --write`, which generates it.',
					},
				),
			);
		}

		const ignoreFile = joinPosix(site.site, '.gitignore');
		examined += 1;
		if (!PRESENT.gitignore(site.files.read(ignoreFile))) {
			findings.push(
				raw(
					id,
					at(ignoreFile),
					null,
					`${ignoreFile} does not ignore what \`hexdocs prefetch\` writes.`,
					{
						remediation: remediationFor(site, 'gitignore'),
					},
				),
			);
		}

		return row(
			id,
			examined,
			findings,
			ctx,
			'The deploy runs `npm run build` rather than `pnpm build` in a front package with no lockfile of its own. Both runners fire the pre-hook, so the guarantee holds either way.',
		);
	},
};

/** The first of several spellings to appear, or `-1`. Indices are only ever compared. */
function firstIndexOfAny(shape: string, needles: readonly string[]): number {
	let best = -1;
	for (const needle of needles) {
		const at = shape.indexOf(needle);
		if (at !== -1 && (best === -1 || at < best)) best = at;
	}
	return best;
}

/** The last path segment, which is where a route-ranking tie is decided. */
function leafOf(path: string): string {
	const parts = path.split('/');
	return parts[parts.length - 1] ?? '';
}

const routes: WiringProbe = {
	id: 'wiring-routes',
	run(site, ctx) {
		const id = 'wiring-routes';
		const file = joinPosix(site.site, 'app/routes.ts');
		const text = site.files.read(file);
		if (text === null) {
			return failedRow(
				id,
				0,
				unitOf(id),
				`${file} does not exist, so this site has no route table to check.`,
			);
		}

		const findings: RawFinding[] = [];
		let examined = 0;
		const shape = structural(text);

		examined += 1;
		if (!PRESENT.routes(text)) {
			findings.push(
				raw(id, at(file), null, `${file} does not reference DOCS_ROUTES.`, {
					remediation: remediationFor(site, 'routes'),
				}),
			);
		}

		// Where the machine endpoints are declared, bracketed between the bare mount and
		// the `:lang` mount. A leaf route with no default export is dispatched to
		// `queryRoute`, which runs that route's own loader and no parent's, so one mounted
		// under `:lang` never runs the language validation and answers a nonsense language
		// with a 200.
		//
		// Both quote styles are looked for. Both consumers write double quotes today and
		// `structural` does not normalise quoting, so a repository whose formatter used
		// single quotes would otherwise be told it has no `:lang` mount, which is a loud
		// and wrong message rather than a missed check.
		examined += 1;
		const langAt = firstIndexOfAny(shape, ['route(":lang"', "route(':lang'"]);
		if (langAt === -1) {
			findings.push(
				raw(
					id,
					at(file),
					null,
					`${file} has no \`route(":lang", ...)\` mount, so this site does not have the seven-language URL scheme this package installs into.`,
					{
						remediation:
							'Install docs into a site that already mounts its pages twice, once bare and once under a validated `:lang` segment. Creating that scheme is a change to the site, not to its docs.',
					},
				),
			);
		} else {
			// The lower bound is the bare mount when it can be found, and `-1` otherwise,
			// which degrades the assertion to "somewhere before the `:lang` mount". That
			// weaker form is still worth having: it is the page spread that sits above it
			// in both consumers, so a machine spread declared inside the `:lang` children
			// still fails.
			const bareAt = firstIndexOfAny(shape, ['...pages("en/")', "...pages('en/')"]);
			const docsBetween = [...shape.matchAll(/DOCS_ROUTES/g)].some(
				(match) => match.index !== undefined && match.index > bareAt && match.index < langAt,
			);
			if (!docsBetween) {
				findings.push(
					raw(
						id,
						at(file),
						null,
						'No DOCS_ROUTES spread is declared between the bare mount and the `:lang` mount.',
						{
							remediation: remediationFor(site, 'routes'),
						},
					),
				);
			}
		}

		// The ordering the tie depends on, asserted over the rows themselves. It is
		// decided in `docsRouteRows` once for every consumer, and the consumer's only job
		// is to spread them in the order they arrive, which no text match can prove.
		const rows = docsRouteRows(validConfigs(site));
		examined += rows.length;
		const firstWildcard = rows.findIndex((route) => leafOf(route.path).includes('*'));
		const lastStaticSuffix = rows.reduce((last, route, index) => {
			const leaf = leafOf(route.path);
			return leaf.includes('.') && !leaf.includes('*') && !leaf.includes(':') ? index : last;
		}, -1);
		if (firstWildcard !== -1 && lastStaticSuffix > firstWildcard) {
			findings.push(
				raw(
					id,
					at(file),
					null,
					'A wildcard route pattern is emitted before a static-suffix one, so the wildcard wins the tie and swallows it.',
					{
						remediation:
							"This is a defect in `docsRouteRows`, not in the consumer. A dynamic pattern that fails React Router's parameter test scores as a static segment and ties with a real static one, and ties break on declaration order.",
					},
				),
			);
		}

		// No docs route module may export `headers`. React Router copies only Set-Cookie
		// from a parent, so a child `headers` export ships docs pages with no
		// Content-Security-Policy and no nonce on hex-web, where the page then renders and
		// never hydrates, and drops Vary: Cookie and the whole cache policy on kcalc. The
		// only thing standing here today is a prose comment in `root.tsx`.
		const modules =
			rows.length === 0 ? [...DOCS_ROUTE_MODULES] : [...new Set(rows.map((route) => route.file))];
		for (const module of modules) {
			const modulePath = joinPosix(site.site, 'app', module);
			const source = site.files.read(modulePath);
			if (source === null) {
				findings.push(
					raw(
						id,
						at(modulePath),
						null,
						`A docs mount needs ${modulePath}, and it does not exist.`,
						{
							remediation:
								'Create it. It renders the docs shell through `docsRoute` from `@hex-pro/docs/render`, and without it the route table fails to build.',
						},
					),
				);
				continue;
			}
			examined += 1;
			const stripped = stripComments(source);
			const declared = /export\s+(?:const|let|var|async\s+function|function)\s+headers\b/.test(
				stripped,
			);
			const named = /export\s*\{[^}]*\bheaders\b[^}]*\}/.test(stripped);
			if (declared || named) {
				findings.push(
					raw(id, at(modulePath), null, `${modulePath} exports \`headers\`.`, {
						remediation:
							"Delete the export. React Router uses the deepest `headers` export among the matched routes and copies only Set-Cookie from a parent, so this replaces the root's headers for every docs page.",
					}),
				);
			}
		}

		return row(
			id,
			examined,
			findings,
			ctx,
			'These are text matches on source, in the manner of check-tools.mjs: renaming a local variable in the spread breaks the check without breaking the code.',
		);
	},
};

const localisedPaths: WiringProbe = {
	id: 'wiring-localised-paths',
	run(site, ctx) {
		const id = 'wiring-localised-paths';
		const findings: RawFinding[] = [];

		for (const project of site.projects) {
			if (project.problem === null) continue;
			findings.push(
				raw(
					id,
					at(project.file),
					null,
					`${project.file} is not a valid site config: ${project.problem}`,
					{
						remediation:
							'Every route, canonical, alternate and sitemap entry for this mount is derived from this file, so a config that does not validate is a docs mount that does not exist.',
					},
				),
			);
		}

		const configs = validConfigs(site);
		const docsPaths = docsLocalisedPathsFor(configs);

		const libFile = joinPosix(site.site, 'app/lib/docs.ts');
		const libText = site.files.read(libFile);
		if (!PRESENT.docsLib(libText)) {
			findings.push(
				raw(
					id,
					at(libFile),
					null,
					libText === null
						? `${libFile} does not exist, so nothing derives DOCS_PATHS, DOCS_ROUTES or DOCS_SITEMAP.`
						: `${libFile} does not derive its three exports from the package.`,
					{
						remediation:
							libText === null
								? 'Run `hexdocs install --write`, which creates it.'
								: remediationFor(site, 'docs-lib'),
					},
				),
			);
		}

		const pathsFile = joinPosix(site.site, 'app/lib/paths.ts');
		const pathsText = site.files.read(pathsFile);
		if (pathsText === null) {
			findings.push(
				raw(
					id,
					at(pathsFile),
					null,
					`${pathsFile} does not exist, so this site has no localised-path list.`,
					{
						remediation:
							'root.tsx gates the canonical link and the eight hreflang alternates on that list. A site without one is not a site this package can install into.',
					},
				),
			);
		} else if (!PRESENT.localisedPaths(pathsText)) {
			findings.push(
				raw(id, at(pathsFile), null, 'LOCALISED_PATHS does not include the docs addresses.', {
					remediation: remediationFor(site, 'localised-paths'),
				}),
			);
		}

		// Zero is a failure and it is the right one: it means `hexdocs sync` has not
		// written the pages array, so there are no addresses for the consumer to localise
		// and the canonical would be self-referential on every docs URL.
		const note =
			docsPaths.length === 0
				? 'No docs addresses at all. Either no site config was found, or `hexdocs sync` has not written its pages array.'
				: null;
		return row(id, docsPaths.length, findings, ctx, note);
	},
};

const sitemap: WiringProbe = {
	id: 'wiring-sitemap',
	run(site, ctx) {
		const id = 'wiring-sitemap';
		const file = joinPosix(site.site, 'app/routes/sitemap[.]xml.tsx');
		const text = site.files.read(file);
		if (text === null) {
			return failedRow(
				id,
				0,
				unitOf(id),
				`${file} does not exist, so this site publishes no sitemap to add docs entries to.`,
			);
		}

		const configs = validConfigs(site);
		const rows = docsSitemapRows(configs);
		const findings: RawFinding[] = [];

		if (!PRESENT.sitemap(text)) {
			findings.push(
				raw(id, at(file), null, `${file} does not derive its docs entries from DOCS_SITEMAP.`, {
					remediation: remediationFor(site, 'sitemap'),
				}),
			);
		}

		// A hand-listed docs address in this file is the failure DOCS_SITEMAP exists to
		// prevent: a hand-written list cannot know which pages are hidden, so it
		// advertises a page that is deliberately out of the sidebar, out of prev and next
		// and out of the sitemap.
		const stripped = stripComments(text);
		for (const config of configs) {
			if (stripped.includes(config.basePath)) {
				findings.push(
					raw(id, at(file), null, `${file} names \`${config.basePath}\` directly.`, {
						remediation:
							'Remove the hand-written docs entries and spread DOCS_SITEMAP instead. It already excludes the hidden pages.',
					}),
				);
			}
		}

		return row(
			id,
			rows.length + configs.length,
			findings,
			ctx,
			rows.length === 0
				? 'No docs pages are sitemapped: either none are published, or every one is hidden.'
				: null,
		);
	},
};

const mcp: WiringProbe = {
	id: 'wiring-mcp',
	run(site, ctx) {
		const id = 'wiring-mcp';
		const file = '.mcp.json';
		const text = site.files.read(file);
		const findings: RawFinding[] = [];
		let examined = 0;

		if (text === null) {
			findings.push(
				raw(id, at(file), null, 'This repository has no .mcp.json.', {
					remediation: remediationFor(site, 'mcp-json'),
				}),
			);
		} else {
			const parsed = parseJsonc(text);
			const servers =
				parsed !== null && typeof parsed === 'object'
					? (parsed as { mcpServers?: unknown }).mcpServers
					: null;
			if (servers === null || typeof servers !== 'object') {
				findings.push(
					raw(id, at(file), null, '.mcp.json has no mcpServers object.', {
						remediation: remediationFor(site, 'mcp-json'),
					}),
				);
			} else {
				examined += Object.keys(servers as Record<string, unknown>).length;
				if (!PRESENT.mcpJson(text, site)) {
					findings.push(
						raw(id, at(file), null, '.mcp.json declares no hexdocs server.', {
							remediation: remediationFor(site, 'mcp-json'),
						}),
					);
				} else {
					const command = mcpServerEntry(site).command.replace(/^\.\//, '');
					if (!site.files.exists(command)) {
						findings.push(
							raw(
								id,
								at(file),
								null,
								`The hexdocs server's command is \`${command}\`, which does not exist.`,
								{
									remediation:
										'The launcher lives inside the submodule. Either the submodule is not checked out, or the mount path in .mcp.json is wrong.',
								},
							),
						);
					}
				}
			}
		}

		const settings = settingsSatisfied(site);
		examined += settings.inspected.length;

		if (settings.enabledBy === null) {
			findings.push(
				raw(id, at('.claude/settings.json'), null, 'No settings file enables the hexdocs server.', {
					remediation: remediationFor(site, 'mcp-settings'),
				}),
			);
		}
		if (settings.directoryIn === null) {
			findings.push(
				raw(
					id,
					at('.claude/settings.json'),
					null,
					`No settings file grants \`${site.mount}/.claude/skills\` in permissions.additionalDirectories.`,
					{ remediation: remediationFor(site, 'mcp-settings') },
				),
			);
		}

		const noteParts: string[] = [];
		if (settings.inspected.length === 0) noteParts.push('no settings file exists here');
		if (settings.enabledBy !== null) noteParts.push(`enabled by ${settings.enabledBy}`);
		if (settings.enabledBy === '.claude/settings.local.json') {
			noteParts.push(
				'a local settings file is commonly ignored by a global git ignore rather than by the repository, so an enable that lives only there reaches no clone',
			);
		}
		noteParts.push('this install prints the settings edit and never writes it');

		return row(id, examined, findings, ctx, noteParts.join('; '));
	},
};

/**
 * The nine probes, pinned to the id union in both directions.
 *
 * `satisfies Record<ConsumerCheckId, WiringProbe>` makes a deleted probe a typecheck
 * failure by name. `verify-install` then asserts at run time that the row ids it emitted
 * equal these keys, which is the same fact closed a second time: the type cannot see a
 * probe that runs and returns a row with somebody else's id on it.
 */
export const PROBES = {
	'wiring-submodule': submodule,
	'wiring-workspace-exclusion': workspaceExclusion,
	'wiring-tsconfig-path': tsconfigPath,
	'wiring-deploy-hash-dirs': deployHashDirs,
	'wiring-prebuild-hook': prebuildHook,
	'wiring-routes': routes,
	'wiring-localised-paths': localisedPaths,
	'wiring-sitemap': sitemap,
	'wiring-mcp': mcp,
} as const satisfies Record<ConsumerCheckId, WiringProbe>;

export function runConsumerChecks(site: SiteDescriptor, ctx: ProbeContext): CheckRow[] {
	return CONSUMER_CHECK_IDS.map((id) => PROBES[id].run(site, ctx));
}
