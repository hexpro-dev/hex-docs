/**
 * `hexdocs check` / `docs_check`: everything wrong with a documentation tree, in one call.
 *
 * This is five of the original design's tools: `validate_docs`, `lint_docs`,
 * `check_links`, `check_nav` and the orphan check. They were never five implementations.
 * `buildBundle` compiles the tree and hands every finding to one `runLint` call, so
 * splitting the report into five tools would have been five filters over one list, each
 * with its own summary and its own idea of what to do next.
 *
 * The bundle is built in memory and thrown away. `writeBundle` is `hexdocs build`, and
 * keeping them apart is what lets an agent check a tree it has no business writing a
 * bundle for.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildBundle } from '../compile/build.js';
import { runLint } from '../compile/lint/run.js';
import {
	MIRROR_SCRIPT_RELATIVE,
	allowPathsFindings,
	parseAllowPaths,
} from '../source/allow-paths.js';
import { SITE_ROOT_RELATIVE } from '../../../src/contracts/project.js';
import type { JsonValue } from '../compile/serialise.js';
import { ProjectError } from '../compile/project.js';
import { FINDING_CATEGORIES, SEVERITIES } from '../../../src/contracts/diagnostics.js';
import type {
	DiagnosticEnvelope,
	Finding,
	NextAction,
} from '../../../src/contracts/diagnostics.js';
import { checkRow, notRunRow, skippedRow } from '../../../src/contracts/diagnostics.js';
import type { CheckRow } from '../../../src/contracts/diagnostics.js';
import type { Locale } from '../../../src/contracts/locales.js';
import { defineCommand } from '../registry/command.js';

import { LOCALE_MANY, ROOT, rootOf } from './common.js';

/**
 * Re-derives the summary and the next action over a filtered list.
 *
 * The filter is why this exists. `runLint` computes both over the whole finding set, so
 * an envelope that kept the original summary after `--severity error` would report
 * counts for findings it does not contain, and its `nextAction` would name one it
 * dropped. `truncated` is recomputed for the same reason: it is a published field
 * meaning "there were more", and after a filter the original value is a claim about a
 * different list.
 */
/**
 * The slug a finding is about, from the file path the compiler recorded.
 *
 * `content/<locale>/<slug>.md` is the shape every page finding carries, so the slug falls
 * out of it. A finding about a snippet, an asset or the project itself has no page to
 * open and returns `null`, which the caller turns into the docs home rather than into a
 * command naming a slug that does not exist.
 */
function slugOf(finding: Finding): string | null {
	if (!('file' in finding.location)) return null;
	const match = /^content\/[^/]+\/(.+)\.md$/.exec(finding.location.file);
	return match?.[1] ?? null;
}

export function filterEnvelope(
	envelope: DiagnosticEnvelope,
	keep: (finding: Finding) => boolean,
): DiagnosticEnvelope {
	const findings = envelope.findings.filter(keep);
	const dropped = envelope.findings.length - findings.length;
	const count = (severity: Finding['severity']): number =>
		findings.filter((finding) => finding.severity === severity).length;

	const first = findings[0];
	// The action names the page to open, not the command that produced this report.
	//
	// It used to be `['hexdocs', 'check', '--severity', <severity>]`, which is byte for
	// byte the invocation that produces this envelope whenever the run already carried
	// that filter. An agent following actions then never leaves the state: the action it
	// is handed is the call it just made. `NextAction` is a contract about what to do
	// next, so an action that loops is worse than none.
	//
	// `page` is the right next call because the finding has already been read: what an
	// agent needs is the text around it, in the locale it is about.
	const nextAction: NextAction =
		first === undefined
			? {
					kind: 'none',
					why: 'Nothing matched this filter. That is not the same as nothing being wrong: widen it, or run `hexdocs check` with no filter.',
				}
			: {
					kind: 'command',
					argv: [
						'hexdocs',
						'page',
						slugOf(first) ?? 'index',
						...(first.locale === null ? [] : ['--locale', first.locale]),
					],
					why: `Start with ${first.rule} in ${'file' in first.location ? first.location.file : 'the project'}: ${first.message}`,
				};

	return {
		kitVersion: envelope.kitVersion,
		summary: {
			errors: count('error'),
			warnings: count('warning'),
			infos: count('info'),
			// `passing` counts rules that reported nothing, which a filter cannot know
			// about: a rule dropped by the filter did report something. It is carried
			// through unchanged, and `diagnostics.ts` already says this number is not a
			// coverage measure.
			passing: envelope.summary.passing,
		},
		findings,
		truncated: envelope.truncated && dropped === 0,
		nextAction,
	};
}

export const check = defineCommand({
	name: 'check',
	tool: 'docs_check',
	writes: 'nothing',
	summary: 'Check a documentation tree: structure, house style, links, nav and translations.',
	detail:
		'Compiles the tree in memory and reports every finding one pass produces: front matter that does not validate, headings out of order, a link or an anchor that does not resolve, a page no nav entry reaches, a banned phrase, a translation that is stale or is still the English text, an asset in the wrong colour space, and a string from the project deny list. Filter with --category, --severity and --locale. Run this before claiming a page is done.',
	params: {
		root: ROOT,
		category: {
			help: 'restrict to these categories',
			type: 'string',
			values: FINDING_CATEGORIES as unknown as readonly [string, ...string[]],
			many: true,
		},
		severity: {
			help: 'restrict to this severity and worse',
			type: 'string',
			values: SEVERITIES as unknown as readonly [string, ...string[]],
		},
		locale: LOCALE_MANY,
		'include-drafts': {
			help: 'check pages marked draft as well; they are excluded from a bundle either way',
			type: 'boolean',
		},
	},
	positionals: ['root'],
	taughtBy: ['docs-authoring', 'docs-diagnose'],
	async run(input, ctx) {
		const root = rootOf(ctx.cwd, input.root);

		let result;
		try {
			result = buildBundle(root, {
				generator: ctx.kitVersion,
				...(input['include-drafts'] === true ? { includeDrafts: true } : {}),
			});
		} catch (error) {
			// Two shapes reach here and neither is a stack trace worth printing. A
			// `ProjectError` is a tree this command could not load, and the message already
			// names the file. A tree with no git history throws from `buildBundle`, and the
			// honest answer is a `not-run` row: translation freshness is a comparison of
			// commit dates, and supplying a synthetic commit would make every page read
			// `current`, which is the shallow-clone failure reproduced deliberately.
			const why =
				error instanceof ProjectError || error instanceof Error ? error.message : String(error);
			// An envelope with no findings rather than `null`, purely so this shape carries a
			// `nextAction` like every other. `docs-diagnose` tells an agent that every report
			// has one, and the shape where the tree could not be read at all is exactly the
			// one where an agent most needs to be told what to do next.
			return {
				data: { root, checked: false, why } as unknown as JsonValue,
				lines: [`Could not check ${root}.`, why],
				envelope: {
					kitVersion: ctx.kitVersion,
					summary: { errors: 0, warnings: 0, infos: 0, passing: 0 },
					findings: [],
					truncated: false,
					nextAction: {
						kind: 'command',
						argv: ['hexdocs', 'doctor', root],
						why: `${why} Run doctor against this directory: it reports which roles it recognises, and a tree with no docs/site is a different problem from a tree with no git history.`,
					},
				},
				rows: [notRunRow('check', 'documentation trees', why)],
			};
		}

		const categories = new Set(input.category ?? []);
		const locales = new Set<string>(input.locale ?? []);
		// `SEVERITIES` is a readonly tuple of literals, so `indexOf` wants one of them and
		// the parameter table's `values` widens to `string`. The schema has already refused
		// anything outside the tuple by the time this runs, which is why this is a cast
		// rather than a second check that could disagree with the first.
		const floor =
			input.severity === undefined
				? undefined
				: SEVERITIES.indexOf(input.severity as (typeof SEVERITIES)[number]);

		const envelope = filterEnvelope(result.lint.envelope, (finding) => {
			if (categories.size > 0 && !categories.has(finding.category)) return false;
			if (locales.size > 0 && (finding.locale === null || !locales.has(finding.locale))) {
				return false;
			}
			if (floor !== undefined && SEVERITIES.indexOf(finding.severity) > floor) return false;
			return true;
		});

		// The public mirror allowlist, which is an app-repository check rather than a
		// consumer one and therefore belongs here rather than in `verify-install`.
		//
		// It is a row rather than a finding merged into the envelope, and the reason is
		// scope: every finding in the envelope came out of one `runLint` pass over the
		// compiled tree, and this one is about a shell script outside that tree entirely.
		// Folding it in would make the envelope's `passing` count and its truncation flag
		// describe two different populations. A row carries its own count, which is what
		// the `examined` column is for.
		//
		// A repository with no mirror script gets `skipped` with the reason, never a pass.
		// That is the one direction this check must not degrade in: it stands between an
		// internal documentation tree and a public repository, so "there is nothing here to
		// read" and "what is here is fine" have to be different answers.
		const mirrorPath = join(root, MIRROR_SCRIPT_RELATIVE);
		const mirrorText = existsSync(mirrorPath) ? readFileSync(mirrorPath, 'utf8') : null;
		const rows: CheckRow[] = [];
		if (mirrorText === null) {
			rows.push(
				skippedRow(
					'wiring-allow-paths',
					'allowlist entries',
					`${MIRROR_SCRIPT_RELATIVE} is not in this repository, so it publishes no public mirror and there is no allowlist to read. This is not a pass: nothing was examined.`,
				),
			);
		} else {
			const block = parseAllowPaths(mirrorText);
			const mirror = runLint(
				allowPathsFindings(mirrorText, existsSync(join(root, ...SITE_ROOT_RELATIVE.split('/')))),
				{ config: result.project.config, disables: [], kitVersion: ctx.kitVersion },
			);
			rows.push(
				checkRow(
					'wiring-allow-paths',
					block?.entries.length ?? 0,
					'allowlist entries',
					mirror.envelope.findings,
				),
			);
		}

		const counted = result.project.pages.size + result.project.snippets.size;
		return {
			data: envelope as unknown as JsonValue,
			lines: [
				`${result.manifest.project}: ${counted} page(s) and snippet(s) across ` +
					`${result.manifest.locales.length} locale(s), ${result.project.examined} file(s) read.`,
			],
			envelope,
			rows,
		};
	},
});

export type { Locale };
