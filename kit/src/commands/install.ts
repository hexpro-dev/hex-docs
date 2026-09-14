/**
 * `hexdocs install`: wire a consuming website for a docs mount.
 *
 * CLI only, and the `Command` union is what enforces that rather than a convention: a
 * command that writes has no type in which it can carry a tool name, and `Ctx.write` is
 * `null` over MCP so a writer reached from the server has nothing to call. The agent
 * path to the same work is `hexdocs scaffold`, which returns file contents the agent
 * applies with Write and Edit, so every change is visible in the transcript and in git.
 *
 * A run with no `--write` is a dry run, and it is produced by the same code path that
 * applies. The only difference is which `Writer` the loop writes into, so the plan a
 * person reads is not a separate description that could disagree with what happens next.
 *
 * Idempotency is not maintained here and is not asserted here. Every edit's `present` is
 * the same function object the matching `wiring-*` check calls, so a second run writes
 * nothing exactly when `hexdocs verify-install` passes, and there is no third state.
 *
 * What is deliberately not an edit at all, each decided against the real source:
 *
 *   The theme class in `root.tsx`. hex-web matches apps by prefix, `APPS.find((app) =>
 *   path.startsWith(app.path))?.themeClass`, so a docs mount at `/hex-nfc/docs/...` already
 *   gets `app-hex-nfc`. The one `root.tsx` change docs need is the SEO decision, and that is
 *   printed rather than written because the file is hand-edited in every commit.
 *
 *   `i18n.server.ts` `PATH_SCOPES`. A path with no entry returns `[]` from
 *   `scopesForPath`, which is chrome only and not raw keys, and this package ships its
 *   own UI strings in all seven languages. The entry would change no output.
 *
 *   The language-cookie redirect. Docs addresses are not added to `LOCALISED_PATHS`, and a
 *   path absent from that list is already skipped by `preferredLanguageRedirect`. That
 *   exemption is needed rather than incidental: the translation notice links to the English
 *   address, and a redirect keyed on the cookie would send the reader straight back.
 *
 *   `hash.exclude_dirs` in `deploy.config.json`. The prefetched trees are hashed by name, so
 *   leaving `_bundles` and `_docs` out of the exclusions costs one extra rebuild after a
 *   relabel that already rebuilt the site. An edit, a predicate and a check for that is more
 *   than the rebuild costs, and a site that cares adds the two names by hand.
 *
 *   Editor settings for the MCP server. Printed as a note, never written and never checked,
 *   for the reason `settingsInstruction` gives.
 */

import { resolve } from 'node:path';

import { checkRow, failedRow, notRunRow, skippedRow } from '../../../src/contracts/diagnostics.js';
import type { CheckRow } from '../../../src/contracts/diagnostics.js';
import type { JsonValue } from '../compile/serialise.js';
import { recordingWriter } from '../io/write.js';
import { defineCommand } from '../registry/command.js';
import type { Writer } from '../registry/command.js';
import { editsFor, type EditContext } from '../wiring/edits.js';
import { detectSite } from '../wiring/detect.js';
import { requireSitePath } from '../wiring/site.js';
import { settingsInstruction } from '../wiring/templates.js';

import { BUCKET, ROOT, SITE, bucketOf, rootOf } from './common.js';

interface Outcome {
	readonly id: string;
	/**
	 * The `wiring-*` row this edit satisfies.
	 *
	 * Carried through to the output rather than left on the table, so a person reading
	 * `install` knows which `verify-install` row each printed instruction unblocks. It is
	 * also what a test uses to assert the two tables cover each other in both directions.
	 */
	readonly check: string;
	readonly file: string;
	readonly state: 'unchanged' | 'written' | 'planned' | 'refused' | 'by-hand';
	readonly why: string | null;
}

export const install = defineCommand({
	name: 'install',
	tool: null,
	writes: 'files',
	summary: 'Wire a consuming website for a docs mount, or print what that would take.',
	detail:
		'Applies the mechanical edits (the workspace exclusion, the tsconfig path mappings, the deploy hash directories, the prebuild hook, the generated server module, route modules and guard shim, the gitignore entries and the MCP server entry) and prints the ones that are left to a person: the submodule itself, the site config, the insertions into routes.ts, root.tsx and the sitemap, and the compiler option that lives in a shared config. Without --write it changes nothing and prints the same plan. --bucket goes into a prebuild fragment install writes, and never into an existing one.',
	params: {
		root: ROOT,
		site: SITE,
		mount: {
			help: 'where the docs package is mounted; detected from the submodule when absent',
			type: 'string',
		},
		bucket: BUCKET,
		write: {
			help: 'apply the mechanical edits; without it nothing is written',
			type: 'boolean',
		},
	},
	positionals: ['root'],
	taughtBy: ['docs-install-site'],
	async run(input, ctx) {
		const repoRoot = rootOf(ctx.cwd, input.root);
		const site = detectSite({
			repoRoot,
			site: requireSitePath(input.site),
			mount: input.mount,
		});
		const write = input.write === true;

		// Validated where the value enters, which is here: it is about to be written into a
		// prebuild string that runs on the deploy host. Only the flag is read. `bucketOf`
		// falls back to HEXDOCS_BUCKET, and an install that wrote a developer's environment
		// variable into a committed package.json would be publishing it by accident.
		if (input.bucket !== undefined) {
			const bucket = bucketOf(input.bucket);
			if ('why' in bucket) {
				return {
					data: { site: site.site, mount: site.mount, wrote: false },
					lines: [`--bucket was refused: ${bucket.why}`],
					envelope: null,
					rows: [
						notRunRow(
							'install-writes',
							'edits',
							`--bucket was refused, so nothing was planned or applied. ${bucket.why}`,
						),
					],
				};
			}
		}
		const editContext: EditContext = { exec: ctx.exec, bucket: input.bucket };

		if (write && ctx.write === null) {
			return {
				data: { site: site.site, mount: site.mount, wrote: false },
				lines: ['This context cannot write.'],
				envelope: null,
				rows: [
					notRunRow(
						'install-writes',
						'edits',
						'This context has no writer, so nothing was applied. Every filesystem write in this package goes through Ctx.write, which is null wherever writing is not permitted.',
					),
				],
			};
		}

		// A dry run records instead of writing, so the plan is produced by the applying
		// code path rather than by a second description of it. `present` is still answered
		// from disk, which is what makes a dry run after a real run report `unchanged`.
		const writer: Writer = write && ctx.write !== null ? ctx.write : recordingWriter();

		const outcomes: Outcome[] = [];
		const instructions: string[] = [];

		for (const edit of editsFor(site, input.bucket)) {
			const base = { id: edit.id, check: edit.check, file: edit.file };
			const text = site.files.read(edit.file);
			if (edit.present(text, site, editContext)) {
				outcomes.push({ ...base, state: 'unchanged', why: null });
				continue;
			}
			if (edit.byHand === true) {
				outcomes.push({ ...base, state: 'by-hand', why: edit.instruction });
				instructions.push(edit.instruction);
				continue;
			}

			const next = edit.apply(text, site, editContext);
			if (next === null) {
				outcomes.push({ ...base, state: 'refused', why: edit.instruction });
				instructions.push(edit.instruction);
				continue;
			}

			// The applier's output has to satisfy the applier's own predicate. Without this
			// an edit that inserted the right text in the wrong place would report success
			// and `verify-install` would then report the same row as failing, which is the
			// one disagreement between the two commands this design exists to make
			// impossible.
			if (!edit.present(next, site, editContext)) {
				outcomes.push({
					...base,
					state: 'refused',
					why: `The edit produced a file its own predicate does not accept, so it was not applied.\n\n${edit.instruction}`,
				});
				instructions.push(edit.instruction);
				continue;
			}

			if (write) {
				writer.write(resolve(repoRoot, edit.file), next);
				outcomes.push({ ...base, state: 'written', why: null });
			} else {
				outcomes.push({ ...base, state: 'planned', why: null });
			}
		}

		const mechanical = outcomes.filter((outcome) => outcome.state !== 'by-hand');
		const refused = outcomes.filter((outcome) => outcome.state === 'refused');
		const byHand = outcomes.filter((outcome) => outcome.state === 'by-hand');
		const count = (state: Outcome['state']): number =>
			outcomes.filter((outcome) => outcome.state === state).length;

		const rows: CheckRow[] = [
			// A refusal is a failure: the anchor was not there, or was not unique, so that
			// edit now needs a person, and a command that reported success would be
			// reporting it over an install that is not finished.
			refused.length === 0
				? checkRow(
						'install-writes',
						mechanical.length,
						'mechanical edits',
						[],
						write
							? `${count('written')} written, ${count('unchanged')} already in place`
							: `dry run: ${count('planned')} would change, ${count('unchanged')} already in place. Pass --write to apply.`,
					)
				: failedRow(
						'install-writes',
						mechanical.length,
						'mechanical edits',
						`${refused.length} edit(s) refused: ${refused.map((outcome) => outcome.id).join(', ')}. Each is printed below.`,
					),
		];

		// Outstanding by-hand work is `skipped` rather than `fail`, and the distinction is
		// the one `diagnostics.ts` draws: this is a deliberate non-run with a reason, not a
		// check that should have run. `hexdocs verify-install` is what fails until they are
		// applied, and it is the command in the build chain.
		rows.push(
			byHand.length === 0
				? checkRow('install-by-hand', outcomes.length, 'edits', [], 'Nothing is left to a person.')
				: skippedRow(
						'install-by-hand',
						'edits',
						`${byHand.length} edit(s) are printed and never written: ${byHand.map((outcome) => outcome.id).join(', ')}. hexdocs verify-install fails until they are applied.`,
					),
		);

		const lines = [
			`docs install for ${site.site} (mount ${site.mount}, from ${site.mountSource})`,
			write ? 'Writing.' : 'Dry run. Nothing was written; pass --write to apply.',
			'',
			...outcomes.map(
				(outcome) =>
					`  ${outcome.state.padEnd(9)}  ${outcome.id.padEnd(22)}  ${outcome.file}` +
					`  (${outcome.check})`,
			),
		];
		if (instructions.length > 0) {
			lines.push('', 'Left to a person:', '');
			for (const instruction of instructions) lines.push(instruction, '');
		}
		// A note and not an edit. Whether one developer's editor enables the MCP server has
		// nothing to do with whether the site builds, and `verify-install` is the build gate.
		const note = settingsInstruction(site);
		lines.push('', note);

		return {
			data: {
				site: site.site,
				mount: site.mount,
				mountSource: site.mountSource,
				write,
				edits: outcomes.map((outcome) => ({
					id: outcome.id,
					check: outcome.check,
					file: outcome.file,
					state: outcome.state,
					instruction: outcome.why,
				})),
				written: [...writer.written],
				notes: [note],
			} as unknown as JsonValue,
			lines,
			envelope: null,
			rows,
		};
	},
});
