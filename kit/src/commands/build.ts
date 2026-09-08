/**
 * `hexdocs build`: compile a tree and write the bundle to disk.
 *
 * The publish workflow's first step, and the only command besides `publish` that reaches
 * `kit/src/compile/bundle.ts` directly rather than going through `Ctx.write`. That
 * exception predates the writer and is documented where it lives: `writeBundle` is
 * write-once, which is a stronger guarantee than the `Writer` interface can express, and
 * a bundle is the one artefact whose bytes have to be identical on two machines.
 *
 * CLI only, like every command that writes. There is no `docs_build` tool, and the
 * `Command` union is what refuses to give it one.
 *
 * **It writes the bundle even when the lint has errors, and the output says so.**
 * `buildBundle` always produces a bundle and refusing is the publisher's job: the fixture
 * corpus carries seven planted errors on purpose and still has to compile, and a `build`
 * that refused would make the golden tests untestable. The exit code is still 3, so a
 * workflow that gates on it stops.
 */

import { resolve } from 'node:path';

import { buildBundle } from '../compile/build.js';
import { writeBundle } from '../compile/bundle.js';
import { ProjectError } from '../compile/project.js';
import { checkRow, failedRow, notRunRow } from '../../../src/contracts/diagnostics.js';
import type { CheckRow } from '../../../src/contracts/diagnostics.js';
import { defineCommand } from '../registry/command.js';

import { ROOT, rootOf } from './common.js';

export const build = defineCommand({
	name: 'build',
	tool: null,
	writes: 'files',
	summary: 'Compile a documentation tree and write the bundle to a directory.',
	detail:
		'Compiles every page in every locale, runs every rule, builds the search indexes and writes the objects and the manifest under <out>/<project>/<commit>/ast-N/. The layout on disk is the layout in the bucket, so `hexdocs publish` is a copy rather than a translation. Writing is write-once: recompiling the same commit has to produce the same bytes, so a key that already exists with different content is refused rather than overwritten, and identical bytes are a no-op. The bundle is written even when the lint reports errors, and the exit code still reports them.',
	params: {
		root: ROOT,
		out: {
			help: 'the directory to write the bundle under; the project, commit and AST major are added below it',
			type: 'string',
			required: true,
		},
		'include-drafts': {
			help: 'compile pages marked draft as well; a published bundle never carries them',
			type: 'boolean',
		},
	},
	positionals: ['root'],
	taughtBy: ['docs-publish-version'],
	async run(input, ctx) {
		const root = rootOf(ctx.cwd, input.root);
		const out = resolve(ctx.cwd, input.out);

		let result;
		try {
			result = buildBundle(root, {
				generator: ctx.kitVersion,
				...(input['include-drafts'] === true ? { includeDrafts: true } : {}),
			});
		} catch (error) {
			// The same two shapes `check` handles, treated the same way and for the same
			// reason. A `ProjectError` names the file it could not load, and a tree with no
			// git history throws from `buildBundle` because a bundle is commit-addressed.
			// Neither is a bug in hexdocs, so neither is a stack trace: they are a `not-run`
			// row, which fails the run without claiming to know what is wrong with the docs.
			const why =
				error instanceof ProjectError || error instanceof Error ? error.message : String(error);
			return {
				data: { root, out, built: false, why },
				lines: [`Could not build ${root}.`, why],
				envelope: null,
				rows: [notRunRow('build', 'documentation trees', why)],
			};
		}

		const rows: CheckRow[] = [];

		// The manifest's own invariants, which `buildBundle` computed and did not act on.
		// Every one of them is a slug or a count that a reader would follow to something
		// that is not there, so a non-empty list is a failure even though the bytes are
		// perfectly well formed.
		rows.push(
			result.manifestProblems.length === 0
				? checkRow('build-manifest', 1, 'manifests', [])
				: failedRow(
						'build-manifest',
						result.manifestProblems.length,
						'problems',
						result.manifestProblems.join(' '),
					),
		);

		let written = 0;
		let unchanged = 0;
		let prefix: string | null = null;
		try {
			const result2 = writeBundle(out, result.manifest, result.objects);
			prefix = result2.prefix;
			written = result2.written.length;
			unchanged = result2.unchanged.length;
			// Examined is every key the bundle put on disk, written and unchanged together,
			// so a re-run that writes nothing still reports what it compared. Keys rather
			// than objects, and the difference is one: `manifest.counts.objects` does not
			// count the manifest, which is a key like any other here. `checkRow` turns a zero
			// into a failure, which is the case where the compile produced nothing at all.
			rows.push(checkRow('build-objects', written + unchanged, 'keys', []));
		} catch (error) {
			// The write-once refusal, and it is not a bug. It means either the toolchain
			// changed under a published sha or the compile is not deterministic, and the
			// message `bundle.ts` throws says which and why. Printing it as a stack trace
			// under "this is a bug in hexdocs" would send the reader to the wrong place.
			const why = error instanceof Error ? error.message : String(error);
			rows.push(failedRow('build-objects', 0, 'objects', why));
		}

		const counts = result.manifest.counts;
		return {
			data: {
				prefix,
				written,
				unchanged,
				counts: {
					pages: counts.pages,
					locales: counts.locales,
					objects: counts.objects,
					bytes: counts.bytes,
				},
				manifestProblems: result.manifestProblems,
			},
			lines: [
				`${result.manifest.project} at ${result.manifest.commit.slice(0, 12)}: ` +
					`${counts.pages} page(s), ${counts.locales} locale(s), ${counts.objects} object(s), ` +
					`${counts.bytes} stored byte(s).`,
				prefix === null
					? `Nothing was written under ${out}.`
					: `${written} key(s) written and ${unchanged} already present, under ${prefix}.`,
				...(result.lint.envelope.summary.errors > 0
					? [
							`The bundle was written with ${result.lint.envelope.summary.errors} lint error(s). ` +
								'Whether to publish it is a decision for the publish step; the exit code is 3 either way.',
						]
					: []),
			],
			envelope: result.lint.envelope,
			rows,
		};
	},
});
