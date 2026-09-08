/**
 * `hexdocs init`: turn an app repository into a documentation source, once.
 *
 * Two halves, and the second is the reason this command is written the way it is.
 *
 * The first half writes the files `hexdocs scaffold source` returns, and it is ordinary:
 * every one is written only when it is absent or already byte-identical, so a second run
 * reports `unchanged` on every line and exits 0. It never overwrites. A `docs.json`
 * somebody has edited is a refusal naming the file, not a silent restore of the template.
 *
 * The second half adds one line to a public-mirror allowlist, and that array is the whole
 * decision about what leaves a private repository. `kit/src/source/allow-paths.ts` carries
 * the reasoning; what matters here is the shape of this command around it:
 *
 *   * The line written is derived from `SITE_ROOT_RELATIVE`, the same constant
 *     `loadProject` resolves the compiled tree against, so widening it to a bare `docs`
 *     is not a local edit: it points the compiler at the wrong directory and fails every
 *     project test in `kit/test/compile/` before anything reaches a mirror.
 *   * Five named refusals stop the edit, each rendered as a `not-run` row, which is a
 *     non-zero exit. An allowlist refusal stops the whole command rather than only the
 *     allowlist edit: the scaffolded files are harmless on their own, and somebody
 *     running this against a repository whose mirror allowlist already copies its
 *     internal documentation tree needs to fix that before anything else, not receive a
 *     half-finished setup and a warning they can scroll past. A file that already exists
 *     with different contents is the other way round and stops only itself, because that
 *     is a fact about one file and the allowlist entry is still the right thing to add.
 *   * The publish workflow is written and deliberately not allowlisted. It names the
 *     bucket and the publishing role, and it is withheld by the same mechanism that
 *     withholds the mirror's own workflow: absence.
 *
 * Without `--write` this changes nothing and prints the plan. The dry run goes through
 * `recordingWriter`, so the plan a person reads is produced by the code path that would
 * apply it. A separate "describe what I would do" branch is how a dry run and a real run
 * come to disagree, and here the two disagreeing means somebody approves one edit and gets
 * another.
 */

import { join } from 'node:path';

import {
	checkRow,
	failedRow,
	notRunRow,
	skippedRow,
	type CheckRow,
} from '../../../src/contracts/diagnostics.js';
import { LOCALES, SOURCE_LOCALE, type Locale } from '../../../src/contracts/locales.js';
import {
	PROJECT_ID_PATTERN,
	REPO_PATTERN,
	SITE_ROOT_RELATIVE,
} from '../../../src/contracts/project.js';
import { UsageError } from '../cli/args.js';
import { recordingWriter } from '../io/write.js';
import { defineCommand, type Writer } from '../registry/command.js';
import {
	MIRROR_SCRIPT_RELATIVE,
	PUBLISH_WORKFLOW_RELATIVE,
	allowPathsRefusals,
	insertSiteRoot,
	parseAllowPaths,
} from '../source/allow-paths.js';
// The file list is `sourceScaffold`, which is also what `hexdocs scaffold source` returns
// to an agent. One table, two front doors: an agent applies it with Write and this command
// applies it itself. Two lists of the files a project starts with would be two ideas of
// what a project is, and the one written by whichever command was touched last would be
// the one nobody reads.
import { sourceScaffold } from '../templates/source.js';

import { LOCALE_MANY, ROOT, rootOf } from './common.js';

/** What the allowlist edit did, as one word for a machine reader. */
type AllowPathsOutcome = 'added' | 'present' | 'absent-file' | 'refused';

interface RefusedFile {
	readonly path: string;
	readonly why: string;
}

export const init = defineCommand({
	name: 'init',
	// CLI only, because it writes. `Command`'s union has no member that carries a tool
	// name and a `writes` other than `nothing`, so this is a typecheck rather than a
	// convention: over MCP `Ctx.write` is null and there would be nothing to write with.
	tool: null,
	writes: 'files',
	summary: 'Set up a documentation source in an app repository, and wire its public mirror.',
	detail:
		'Writes the project config, the nav, a first English page, the deny list and the publish workflow, then adds the publishable documentation root to the public mirror allowlist in scripts/sync-public.sh when that file exists. Changes nothing without --write: the default is a plan, printed from the same code path that would apply it. It never overwrites a file that already exists with different contents, and it refuses to touch an allowlist it cannot read or one that already carries an entry wider than the publishable root. Locales default to en.',
	params: {
		root: ROOT,
		project: {
			help: 'the project id: lower case, hyphen separated, used as a URL segment and a key prefix',
			type: 'string',
			required: true,
		},
		'product-name': {
			help: 'the product name as a reader sees it, such as Hex NFC',
			type: 'string',
			required: true,
		},
		repo: {
			help: 'the GitHub repository this documentation lives in, as owner/name',
			type: 'string',
			required: true,
		},
		// `Param.fallback` is a scalar and this parameter is `many`, so the default cannot
		// live in the table with every other default in this package. The handler carries
		// it, `detail` states it, and both `--help` and the JSON Schema are therefore one
		// step further from the truth here than they are anywhere else. That is the whole
		// cost and it is written down rather than left to be discovered.
		locale: LOCALE_MANY,
		write: {
			help: 'apply the plan; without it nothing is written and nothing is edited',
			type: 'boolean',
		},
	},
	positionals: ['root'],
	taughtBy: ['docs-init-source'],
	async run(input, ctx) {
		const root = rootOf(ctx.cwd, input.root);
		const project = input.project;
		const productName = input['product-name'];
		const repo = input.repo;

		// Shape failures are usage errors, exit 2, because nothing was examined. A project
		// id is an S3 key prefix and a URL segment and a repo is `owner/name`; both are
		// refused here rather than written into a config that fails to parse later, in a
		// different command, naming a file this one created.
		if (!PROJECT_ID_PATTERN.test(project)) {
			throw new UsageError(
				`--project "${project}" is not a project id. It is a URL segment and an object key prefix: lower case letters and digits, hyphen separated, such as hex-nfc.`,
			);
		}
		if (!REPO_PATTERN.test(repo)) {
			throw new UsageError(
				`--repo "${repo}" is not a repository. Spell it owner/name, as GitHub does.`,
			);
		}
		if (productName.trim() === '') {
			throw new UsageError('--product-name is the name a reader sees, and cannot be blank.');
		}

		// Filtered out of `LOCALES` rather than taken as given, which does three things at
		// once: it puts the list in canonical order, which the config requires because a
		// re-run on the same commit has to write identical bytes; it collapses a repeated
		// flag; and it keeps the source locale in, because `i18n.locales` must contain it
		// and a config written without it is one the compiler refuses.
		//
		// The `flat` is not decoration. `common.ts` annotates the shared parameter as `Param`,
		// which erases `many: true` from the type, so the compiler here believes `locale` is
		// one string while the schema hands over an array. `flat` reads both without a cast,
		// and it keeps working whichever way that annotation is eventually tightened.
		const requested: string[] = [input.locale ?? SOURCE_LOCALE].flat();
		const locales: Locale[] = LOCALES.filter(
			(locale) => locale === SOURCE_LOCALE || requested.includes(locale),
		);

		const disk = ctx.write;
		if (disk === null) {
			return {
				data: {
					root,
					project,
					write: false,
					why: 'There is no writer in this context.',
				},
				lines: [`Cannot initialise ${root}.`],
				envelope: null,
				rows: [
					notRunRow(
						'init',
						'files',
						'This command writes files and was given no writer. Over MCP there is none by construction, and `init` is not exposed as a tool.',
					),
				],
			};
		}

		// `kitMount` is left at its documented default. `init` runs in the repositories that
		// are content sources rather than consumers, and all three of those mount this
		// package at the repository root under that name; a repository that mounts it
		// elsewhere gets `$schema` references that do not resolve, which costs an editor's
		// completion and nothing else. Measuring it here would be a third implementation of
		// a measurement `scaffold` already carries privately, and two measurements that can
		// disagree are worse than one default that is written down.
		const plan = sourceScaffold({ project, productName, repo, locales });
		const creates = plan.files.filter((file) => file.action === 'create');
		const patches = plan.files.filter((file) => file.action !== 'create');

		const rows: CheckRow[] = [];
		const lines: string[] = [`${project}: ${plan.files.length} file(s) planned under ${root}.`, ''];

		// The scaffold writes the publish workflow and this command asserts it is not
		// allowlisted. If the two ever name different paths, that assertion checks a file the
		// repository does not have and reports nothing, so the mismatch is a failing row here
		// rather than a guard that quietly stopped guarding.
		const workflows = plan.files.filter((file) => file.path.startsWith('.github/workflows/'));
		const strayWorkflow = workflows.find((file) => file.path !== PUBLISH_WORKFLOW_RELATIVE);
		if (strayWorkflow !== undefined) {
			rows.push(
				failedRow(
					'init-publish-workflow',
					workflows.length,
					'workflow files',
					`The scaffold writes ${strayWorkflow.path} and the allowlist assertion names ${PUBLISH_WORKFLOW_RELATIVE}. That is a mismatch inside hexdocs, not in this repository: the assertion that keeps the publish workflow out of the public mirror would be checking a file nobody writes.`,
				),
			);
		}

		const absolute = (relative: string): string => join(root, ...relative.split('/'));

		// Read the mirror script before anything is written, because a refusal stops the
		// whole run and a run that had already written half its files would not be a plan
		// anybody approved.
		const mirrorPath = absolute(MIRROR_SCRIPT_RELATIVE);
		const mirrorPresent = disk.exists(mirrorPath);
		const mirrorText = mirrorPresent ? (disk.read(mirrorPath) ?? null) : null;
		if (mirrorPresent && mirrorText === null) {
			// Present and unreadable is not the same as absent, and treating it as absent
			// would produce a `skipped` row saying this repository has no public mirror.
			rows.push(
				notRunRow(
					'init-allow-paths',
					'allowlist entries',
					`${MIRROR_SCRIPT_RELATIVE} exists and could not be read. Refusing to report on an allowlist this command cannot see.`,
				),
			);
		}
		const refusals = mirrorText === null ? [] : allowPathsRefusals(mirrorText);
		for (const refusal of refusals) {
			rows.push(notRunRow(`init-allow-paths-${refusal.id}`, 'allowlist entries', refusal.why));
		}

		// Read off the rows rather than off their count, so a row added above that is a note
		// rather than a failure does not silently stop the command from writing.
		const blocked = rows.some((row) => row.status === 'fail' || row.status === 'not-run');
		const apply = input.write === true && !blocked;

		// Both writers see the bytes that are on disk now, so `unchanged` means the same
		// thing in a dry run as it does in a real one.
		const seed: Record<string, string> = {};
		for (const file of creates) {
			const existing = disk.read(absolute(file.path));
			if (existing !== undefined) seed[absolute(file.path)] = existing;
		}
		if (mirrorText !== null) seed[mirrorPath] = mirrorText;
		const target: Writer = apply ? disk : recordingWriter(seed);

		const created: string[] = [];
		const unchanged: string[] = [];
		const refusedFiles: RefusedFile[] = [];

		/** One planned change, as two lines: what happens to the path, and why. */
		const report = (state: string, path: string, why: string): void => {
			lines.push(`  ${state.padEnd(10)} ${path}`, `             ${why}`);
		};

		for (const file of creates) {
			// Every path in the scaffold is built from constants and none of them can climb,
			// so this is insurance rather than a live guard: `init` is the one command that
			// joins those paths onto a filesystem, and an agent applying the same plan with
			// Write would at least see the path in the transcript first.
			if (file.path.startsWith('/') || file.path.split('/').includes('..')) {
				const why = `The scaffold planned ${file.path}, which is not inside the repository. That is a fault in hexdocs rather than in this repository, and nothing is written for it.`;
				refusedFiles.push({ path: file.path, why });
				report('refuse', file.path, why);
				continue;
			}
			const path = absolute(file.path);
			const exists = disk.exists(path);
			const existing = exists ? disk.read(path) : undefined;
			if (exists && existing === undefined) {
				const why =
					'This file exists and could not be read, so this command cannot tell whether writing it would change anything.';
				refusedFiles.push({ path: file.path, why });
				report('refuse', file.path, why);
				continue;
			}
			if (existing !== undefined && existing !== file.contents) {
				const why =
					"This file already exists with different contents. `hexdocs init` never overwrites: it is either somebody else's work or a project that is already set up, and restoring a template over either of those is a loss nothing in this repository would report.";
				refusedFiles.push({ path: file.path, why });
				report('refuse', file.path, why);
				continue;
			}
			if (target.write(path, file.contents)) {
				created.push(file.path);
				report(apply ? 'create' : 'would create', file.path, file.why);
			} else {
				unchanged.push(file.path);
				report('unchanged', file.path, file.why);
			}
		}

		if (refusedFiles.length > 0) {
			rows.push(
				failedRow(
					'init-files',
					creates.length,
					'files',
					`${refusedFiles.length} file(s) already exist with different contents and were left alone. Read them, and delete or move whichever ones are stale before running this again.`,
				),
			);
		} else {
			rows.push(checkRow('init-files', creates.length, 'files', []));
		}

		// The allowlist. `insertSiteRoot` re-runs every refusal itself, so a null return
		// here after the checks above passed is a disagreement between the two, and it is
		// reported rather than smoothed over.
		let outcome: AllowPathsOutcome;
		let allowPathsLine: string | null = null;
		if (blocked) {
			outcome = 'refused';
		} else if (mirrorText === null) {
			outcome = 'absent-file';
			rows.push(
				skippedRow(
					'init-allow-paths',
					'allowlist entries',
					`This repository has no ${MIRROR_SCRIPT_RELATIVE}, so there is no public mirror allowlist to add ${SITE_ROOT_RELATIVE} to.`,
				),
			);
		} else {
			const block = parseAllowPaths(mirrorText);
			const entries = block === null ? 0 : block.entries.length;
			const already =
				block !== null && block.entries.some((entry) => entry.normalised === SITE_ROOT_RELATIVE);
			if (already) {
				outcome = 'present';
				rows.push(
					checkRow(
						'init-allow-paths',
						entries,
						'allowlist entries',
						[],
						`The allowlist already names "${SITE_ROOT_RELATIVE}". Matched as a whole quoted entry, not as a substring: "docs/public" contains the word docs and is not this.`,
					),
				);
			} else {
				const edited = insertSiteRoot(mirrorText);
				if (edited === null) {
					outcome = 'refused';
					rows.push(
						notRunRow(
							'init-allow-paths',
							'allowlist entries',
							'The allowlist editor declined to produce an edit although every refusal check passed. That is a disagreement inside hexdocs, and this command stops rather than guessing which half is right.',
						),
					);
				} else {
					outcome = 'added';
					const anchor = block?.entries.find((entry) => entry.normalised === 'docs/public');
					const indent = anchor?.indent ?? block?.entries[0]?.indent ?? '    ';
					allowPathsLine = `${indent}"${SITE_ROOT_RELATIVE}"`;
					target.write(mirrorPath, edited);
					rows.push(
						checkRow(
							'init-allow-paths',
							entries,
							'allowlist entries',
							[],
							anchor === undefined
								? `Adds "${SITE_ROOT_RELATIVE}" after the last entry. There is no "docs/public" to join, and the array is grouped and unsorted, so there is no collation slot to compute.`
								: `Adds "${SITE_ROOT_RELATIVE}" on the line after "docs/public", which is the documentation group.`,
						),
					);
					report(
						apply ? 'edit' : 'would edit',
						MIRROR_SCRIPT_RELATIVE,
						`Adds the line ${allowPathsLine.trim()} to ALLOW_PATHS. Nothing else in this file changes.`,
					);
				}
			}
		}

		for (const file of patches) {
			// A patch entry is a hand edit the scaffold describes and this command does not
			// apply. The one edit `init` makes to a file it did not write is the allowlist, and
			// that goes through a parser rather than through a template's bytes: writing a line
			// into that array from a string built somewhere else is the single thing this
			// command exists to make impossible.
			//
			// The mirror script's own patch entry is therefore printed only where this command
			// refused to make the edit, which is the one case where somebody has to make it by
			// hand. Printing it beside an `edit` line for the same path would read as two
			// changes to one file, and printing it in a repository with no mirror script would
			// be an instruction to edit a file that is not there, which the `skipped` row
			// explains better anyway.
			if (file.path === MIRROR_SCRIPT_RELATIVE && outcome !== 'refused') continue;
			report('by hand', file.path, file.why);
		}

		if (plan.notes.length > 0) {
			lines.push('');
			for (const note of plan.notes) lines.push(`  ${note}`);
		}

		lines.push('');
		lines.push(
			blocked
				? 'Nothing was written. Read the rows below, fix the allowlist by hand, and run this again.'
				: apply
					? `Wrote ${target.written.length} file(s).`
					: 'Nothing was written. Run this again with --write to apply it.',
		);

		return {
			data: {
				root,
				project,
				write: apply,
				created,
				unchanged,
				refused: refusedFiles.map((file) => ({ path: file.path, why: file.why })),
				allowPaths: outcome,
				allowPathsLine,
				notes: [...plan.notes],
			},
			lines,
			envelope: null,
			rows,
		};
	},
});
