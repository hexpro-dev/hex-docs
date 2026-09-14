/**
 * The nine consumer wiring checks, over the predicates `install` writes with.
 *
 * Every row here calls the matching entry in `PRESENT` from `edits.ts` and then adds the
 * assertions no edit can make: whether a `paths` target resolves to a real file, whether
 * a declared submodule is actually committed, and what exactly is wrong with a file whose
 * predicate said no. That split is what makes `install` re-running a no-op exactly when
 * this passes.
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
 * see is the house idiom (`check-tools.mjs:317-324`); a route table nothing could read is
 * `not-run`, because the check should have run and could not; and a row that examined
 * nothing is a failure whatever else is true of it, which `checkRow` coerces rather than
 * trusting.
 */

import {
	checkRow,
	failedRow,
	notRunRow,
	skippedRow,
	type CheckRow,
	type Finding,
	type FindingLocation,
} from '../../../src/contracts/diagnostics.js';
import type { CheckId } from '../../../src/contracts/lint.js';
import { DEFAULT_BUDGETS, DOCS_CONFIG_VERSION } from '../../../src/contracts/project.js';
import type { DocsProjectConfig } from '../../../src/contracts/project.js';
import { docsRouteRows } from '../../../src/site/address.js';
import { CHECK_DEFINITIONS } from '../compile/lint/registry.js';
import { runLint } from '../compile/lint/run.js';
import { raw, type RawFinding } from '../compile/types.js';
import type { Exec } from '../exec/run.js';

import { parseGitmodules, parseWorkspacePackages } from './detect.js';
import {
	PRESENT,
	REACT_TYPES_ENTRIES,
	docsServerProblems,
	editById,
	resolveJsonModuleOf,
	rootSeoProblems,
	routeModuleProblems,
	sitemapProblems,
	tsconfigPathEntries,
	type EditContext,
} from './edits.js';
import { parseJsonc, withoutModuleStatements } from './needles.js';
import { prebuildFragment, readPrebuild } from './prebuild.js';
import { readRouteTable, routeTableProblems } from './route-table.js';
import {
	DOCS_ROUTE_KINDS,
	DOCS_ROUTE_MODULE,
	DOCS_SERVER_MODULE,
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
	'wiring-root-seo',
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

function editContext(ctx: ProbeContext): EditContext {
	return { exec: ctx.exec };
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
		if (!PRESENT.tsconfigReactTypes(text, site)) {
			findings.push(
				raw(id, at(file), null, `${file} does not map \`react\` to this site's own types.`, {
					remediation: remediationFor(site, 'tsconfig-react-types'),
				}),
			);
		}

		// A key that is present and points at something that is not there is the failure the
		// two existing submodules already have a comment about: nothing in the consuming
		// repository builds a `dist/`, so a mapping that dangles resolves to nothing and the
		// error names a path rather than a missing install. A wildcard target is checked as
		// the directory it expands under, because a literal `*` is never a file on disk.
		const targets = [
			...tsconfigPathEntries(site).map(([key, target]) => ({ key, target, inMount: true })),
			...REACT_TYPES_ENTRIES.map(([key, target]) => ({ key, target, inMount: false })),
		];
		for (const { key, target, inMount } of targets) {
			examined += 1;
			const resolved = resolveFrom(site.site, target.replace(/\/\*$/, ''));
			if (site.files.exists(resolved)) continue;
			findings.push(
				raw(
					id,
					at(file),
					null,
					`\`${key}\` would resolve to \`${resolved}\`, which does not exist.`,
					{
						remediation: inMount
							? 'Either the submodule is not checked out, or the mount path is wrong. `git submodule update --init --recursive` is the usual answer.'
							: "This site's dependencies are not installed, or it has no `@types/react`. Install them in the site directory before building.",
					},
				),
			);
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
		const reading = readPrebuild(table, site);
		let examined = reading.scripts;

		// One finding per problem rather than one for the row, because the problems are
		// different remedies: a refused flag, a masking `||` and a guard out of order are three
		// edits to one string, and a single message naming the first would hide the other two
		// until the next build.
		if (!PRESENT.prebuildHook(text, site)) {
			for (const problem of reading.problems) {
				findings.push(
					raw(id, at(file), null, problem, {
						remediation: remediationFor(site, 'prebuild-hook'),
						suggestion: prebuildFragment(site),
					}),
				);
			}
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
			'The prefetch segment is bound through the same argument parser and schema the CLI uses. The deploy runs `npm run build` rather than `pnpm build`, and both runners fire the pre-hook.',
		);
	},
};

const routes: WiringProbe = {
	id: 'wiring-routes',
	run(site, ctx) {
		const id = 'wiring-routes';
		const findings: RawFinding[] = [];
		let examined = 0;

		// No route config at all is not a site this row can say anything useful about, and
		// the files below would each add a finding about a mount that has nowhere to go.
		const routesFile = joinPosix(site.site, 'app/routes.ts');
		if (!site.files.exists(routesFile)) {
			return failedRow(
				id,
				0,
				unitOf(id),
				`${routesFile} does not exist, so this site has no route table to check.`,
			);
		}

		// The server module first, because every other file in this row imports it and the
		// route table cannot load without it.
		const serverFile = joinPosix(site.site, DOCS_SERVER_MODULE);
		const serverText = site.files.read(serverFile);
		examined += 1;
		if (!PRESENT.docsServer(serverText)) {
			if (serverText === null) {
				findings.push(
					raw(id, at(serverFile), null, `${serverFile} does not exist.`, {
						remediation: 'Run `hexdocs install --write`, which writes it.',
					}),
				);
			} else {
				for (const problem of docsServerProblems(serverText)) {
					findings.push(
						raw(id, at(serverFile), null, `${serverFile} ${problem}`, {
							remediation: remediationFor(site, 'docs-server'),
						}),
					);
				}
			}
		}

		// The two route modules, by the predicate `install` writes them with. A `headers`
		// export here replaces the root's headers for every docs page, because React Router
		// copies only Set-Cookie from a parent.
		for (const kind of DOCS_ROUTE_KINDS) {
			const moduleFile = joinPosix(site.site, 'app', DOCS_ROUTE_MODULE[kind]);
			const text = site.files.read(moduleFile);
			const present = kind === 'page' ? PRESENT.pageRouteModule : PRESENT.machineRouteModule;
			examined += 1;
			if (present(text)) continue;
			const edit = kind === 'page' ? 'route-page-module' : 'route-machine-module';
			if (text === null) {
				findings.push(
					raw(
						id,
						at(moduleFile),
						null,
						`A docs mount needs ${moduleFile}, and it does not exist.`,
						{
							remediation: 'Run `hexdocs install --write`, which writes it.',
						},
					),
				);
				continue;
			}
			for (const problem of routeModuleProblems(kind, text)) {
				findings.push(
					raw(id, at(moduleFile), null, `${moduleFile} ${problem}`, {
						remediation: remediationFor(site, edit),
					}),
				);
			}
		}

		// The table itself, as the site's own React Router evaluates it.
		const table = readRouteTable(site, ctx.exec);
		const rows = docsRouteRows(validConfigs(site));
		let note: string | null = null;
		if (table.kind === 'refused') {
			findings.push(
				raw(
					id,
					at(routesFile),
					null,
					`React Router refused this site's route config: ${table.message}`,
					{ remediation: remediationFor(site, 'routes') },
				),
			);
		} else if (table.kind === 'unread') {
			if (findings.length === 0) return notRunRow(id, unitOf(id), table.why);
			note = table.why;
		} else if (rows.length === 0) {
			// No valid site config, so no docs rows, and a loaded table compared against nothing
			// has proved nothing about where docs routes are declared. This row used to pass here
			// counting the server module and the two route modules, which are files and not
			// route rows. `wiring-root-seo` names the missing or invalid config; this says why
			// the table was not compared.
			const why =
				'No valid site config under app/docs, so there are no docs route rows to look for in the table. Scaffold one with `hexdocs scaffold site`, or fix the one `wiring-root-seo` names.';
			if (findings.length === 0) return notRunRow(id, unitOf(id), why);
			note = why;
		} else {
			examined += rows.length;
			if (!PRESENT.routes(null, site, editContext(ctx))) {
				for (const problem of routeTableProblems(table.routes, rows)) {
					findings.push(
						raw(id, at(routesFile), null, problem, { remediation: remediationFor(site, 'routes') }),
					);
				}
			}
		}

		return row(id, examined, findings, ctx, note);
	},
};

/**
 * The site configs and the one host edit that decides whether a docs page is indexed.
 *
 * Docs addresses do not join `LOCALISED_PATHS` at all: its second reader is the
 * language-cookie redirect, and a docs page left out of it is already exempt from the
 * redirect, which is the exemption the translation notice needs. What decides the
 * canonical, the alternates and the robots tag for a docs page is `root.tsx` reading the
 * docs match through `docsSeoFromMatches`, so that call is what this row asserts, and the
 * id names it. An id naming the host list this row used to be about sends whoever reads a
 * failure to a file the row no longer opens.
 */
const rootSeo: WiringProbe = {
	id: 'wiring-root-seo',
	run(site, ctx) {
		const id = 'wiring-root-seo';
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

		const rootFile = joinPosix(site.site, 'app/root.tsx');
		const rootText = site.files.read(rootFile);
		if (!PRESENT.rootSeo(rootText)) {
			const problems =
				rootText === null
					? ['does not exist, so nothing decides whether a docs page is indexed.']
					: rootSeoProblems(rootText);
			for (const problem of problems) {
				findings.push(
					raw(id, at(rootFile), null, `${rootFile} ${problem}`, {
						remediation: remediationFor(site, 'root-seo'),
					}),
				);
			}
		}

		// Zero is a failure and it is the right one: it means `hexdocs sync` has not written
		// the pages array, so there is no docs address for root to decide anything about.
		const pages = validConfigs(site).reduce((total, config) => total + config.pages.length, 0);
		const note =
			pages === 0
				? 'No docs pages at all. Either no site config was found, or `hexdocs sync` has not written its pages array.'
				: null;
		return row(id, pages, findings, ctx, note);
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
		const findings: RawFinding[] = [];

		if (!PRESENT.sitemap(text)) {
			for (const problem of sitemapProblems(text)) {
				findings.push(
					raw(id, at(file), null, `${file} ${problem}`, {
						remediation: remediationFor(site, 'sitemap'),
					}),
				);
			}
		}

		// A hand-listed docs address in this file is the failure `DOCS.sitemap()` exists to
		// prevent: a hand-written list cannot know which pages are hidden or which
		// translations are fallbacks, so it advertises both.
		//
		// Read with the import statements gone, because the import the arm above requires
		// contains `/docs`, and a mount at `/docs` failed here on a wired site with no edit
		// that could clear it. Any character may stand before the base path, which is why the
		// fix is not a quote in front of it: a template literal after an origin and a full URL
		// both put a hand-listed address somewhere other than just inside a quote.
		const stripped = withoutModuleStatements(text);
		for (const config of configs) {
			if (stripped.includes(config.basePath)) {
				findings.push(
					raw(id, at(file), null, `${file} names \`${config.basePath}\` directly.`, {
						remediation:
							'Remove the hand-written docs entries and list them from DOCS.sitemap() instead. It already leaves hidden pages and fallback translations out.',
					}),
				);
			}
		}

		return row(id, configs.length, findings, ctx);
	},
};

/**
 * The committed `.mcp.json` entry, and nothing about any one developer's editor.
 *
 * There used to be two more arms here, reading `.claude/settings.json` and
 * `.claude/settings.local.json` for an enabled server and a skills directory grant. They
 * were deleted rather than moved, and the reason is where this row runs: `verify-install` is
 * the build gate, so those arms failed the prebuild of every clone whose developer had not
 * enabled a server, which on kcalc is every clone but one. `doctor` has no checks of its own
 * by contract, so there was nowhere else to put them. `install` prints the settings advice
 * as a note instead.
 */
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
			return row(id, examined, findings, ctx);
		}

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
			return row(id, examined, findings, ctx);
		}

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

		return row(id, examined, findings, ctx);
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
	'wiring-root-seo': rootSeo,
	'wiring-sitemap': sitemap,
	'wiring-mcp': mcp,
} as const satisfies Record<ConsumerCheckId, WiringProbe>;

export function runConsumerChecks(site: SiteDescriptor, ctx: ProbeContext): CheckRow[] {
	return CONSUMER_CHECK_IDS.map((id) => PROBES[id].run(site, ctx));
}
