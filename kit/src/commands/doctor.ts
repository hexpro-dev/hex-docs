/**
 * `hexdocs doctor` / `docs_doctor`: run this first.
 *
 * **It answers nothing itself.** It works out which roles the root has, runs the commands
 * that apply to those roles, and concatenates their rows. There is no doctor-specific
 * check and there is no second implementation of anything.
 *
 * That is the whole point of the command and it is worth being explicit about, because
 * the design this replaces had a role-aware doctor re-deriving by regular expression the
 * same facts the consumer wiring guard derives properly, in a document whose headline
 * argument is that two implementations of one job drift apart and the second one goes
 * stale in the reassuring direction. A doctor that can disagree with `hexdocs check` is
 * worse than no doctor: it is the command a person runs when they already suspect
 * something is wrong, so it is the one whose answer gets believed.
 *
 * The sub-calls go through `invoke` rather than straight to `run`, which puts them
 * through the same Zod parse the CLI and the MCP server put a call through. It costs a
 * schema parse per role and it buys one definition of a valid call: if doctor ever hands
 * a sub-command an argument shape it would refuse from a person, that is a bug in
 * hexdocs and it surfaces as one rather than as a sub-command quietly running with a
 * field it did not expect.
 *
 * The one thing doctor cannot do is call `bundle` unasked. `bundle` declares `path` as a
 * required positional and there is nothing in a repository that says which directory a
 * bundle is in: a bundle is build output and lives wherever the person who built it put
 * it. So `--bundle` is the only way to include that half, and its absence is a `skipped`
 * row naming the flag rather than a guess at a path.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type {
	CheckRow,
	DiagnosticEnvelope,
	NextAction,
} from '../../../src/contracts/diagnostics.js';
import { notRunRow, skippedRow } from '../../../src/contracts/diagnostics.js';
import { SITE_ROOT_RELATIVE } from '../../../src/contracts/project.js';
import type { JsonValue } from '../compile/serialise.js';
import { defineCommand, invoke, type CommandOutput } from '../registry/command.js';

import { bundle } from './bundle.js';
import { check } from './check.js';
import { verifyInstall } from './verify-install.js';
import { ROOT, SITE, rootOf } from './common.js';

/** `<project>.docs.json`, the consuming website's half of the pair. */
const SITE_CONFIG_SUFFIX = '.docs.json';

/**
 * Where a consuming site keeps them, relative to the site directory.
 *
 * hex-web keeps them at `apps/front/app/docs/<project>.docs.json` and kcalc at
 * `front/app/docs/`. Both are `<site>/app/docs/`, which is what `--site` names the first
 * half of.
 */
const SITE_CONFIG_DIR = ['app', 'docs'];

/** Directory names the site probe below never descends into. */
const NOT_A_SITE = new Set(['node_modules', 'dist', 'build', 'coverage']);

function siteConfigsIn(root: string, site: string): string[] {
	const directory = join(root, site, ...SITE_CONFIG_DIR);
	if (!existsSync(directory)) return [];
	try {
		return readdirSync(directory)
			.filter((name) => name.endsWith(SITE_CONFIG_SUFFIX))
			.sort();
	} catch {
		return [];
	}
}

function childDirectories(directory: string): string[] {
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter(
			(entry) => entry.isDirectory() && !entry.name.startsWith('.') && !NOT_A_SITE.has(entry.name),
		)
		.map((entry) => entry.name)
		.sort();
}

/**
 * Site directories that look like consumers, probed rather than searched.
 *
 * It looks for `app/docs/` at the root itself and under every directory one and two
 * levels down, which covers a repository that is itself the site, hex-web's `apps/front`
 * and kcalc's `kcalc-web/front`. It is deliberately not a recursive walk: a walk over a
 * monorepo has to grow a skip list and a depth cap anyway, and a cap that silently stops
 * is the shape of failure this repository refuses everywhere else.
 *
 * **The honest limit**, because it is one somebody will hit: a site mounted deeper than
 * two levels is not found, and doctor then says nothing at all about the site half rather
 * than saying it looked and found nothing. `--site` is the reliable route, which is what
 * the skipped row this feeds asks for, and passing it skips this probe entirely.
 */
function siteCandidates(root: string): string[] {
	const found: string[] = [];
	if (siteConfigsIn(root, '.').length > 0) found.push('.');
	for (const first of childDirectories(root)) {
		if (siteConfigsIn(root, first).length > 0) found.push(first);
		for (const second of childDirectories(join(root, first))) {
			const path = `${first}/${second}`;
			if (siteConfigsIn(root, path).length > 0) found.push(path);
		}
	}
	return found;
}

/**
 * A row, and the command that produced it or would have.
 *
 * The argv is what makes `nextAction` a remedy rather than a restatement. A failing
 * `wiring-tsconfig-path` row tells a reader what is wrong; `hexdocs verify-install .
 * --site apps/front` tells them where to go and see the rest of it. Carried beside the
 * row rather than on it because `CheckRow` is a published contract shared with the
 * consumer's shim, and a field only doctor writes has no business in it.
 */
interface Reported {
	readonly row: CheckRow;
	readonly argv: readonly string[];
}

/**
 * One envelope over however many produced one.
 *
 * In practice `check` is the only sub-command with an envelope and this returns it
 * untouched, which is the case worth protecting: the single-envelope path keeps
 * `nextAction`, `truncated` and `passing` exactly as `runLint` computed them, so doctor
 * cannot report a summary for a list it does not contain.
 *
 * The merged path sums `passing`. That is defensible only because the rule sets are
 * disjoint (lint rules on one side, `CHECK_ID`s on the other), so no rule is counted
 * twice, and it inherits the warning `DiagnosticSummary` already carries: this number is
 * rules that reported nothing, which is not a coverage measure on either side.
 */
function mergeEnvelopes(envelopes: readonly DiagnosticEnvelope[]): DiagnosticEnvelope | null {
	const first = envelopes[0];
	if (first === undefined) return null;
	if (envelopes.length === 1) return first;

	const withFindings = envelopes.find((envelope) => envelope.findings.length > 0);
	return {
		kitVersion: first.kitVersion,
		summary: {
			errors: envelopes.reduce((total, envelope) => total + envelope.summary.errors, 0),
			warnings: envelopes.reduce((total, envelope) => total + envelope.summary.warnings, 0),
			infos: envelopes.reduce((total, envelope) => total + envelope.summary.infos, 0),
			passing: envelopes.reduce((total, envelope) => total + envelope.summary.passing, 0),
		},
		findings: envelopes.flatMap((envelope) => envelope.findings),
		truncated: envelopes.some((envelope) => envelope.truncated),
		nextAction: (withFindings ?? first).nextAction,
	};
}

/**
 * The first thing to do about this run.
 *
 * Rows first, in the order they were collected, because a failing row is a fact about the
 * installation and a finding is a fact about a page: a site whose tsconfig path is missing
 * renders no documentation at all, so fixing a banned phrase first would be fixing the
 * second problem. Only when every row is clean does the envelope's own next action, which
 * `runLint` already computed over the first finding, become the answer.
 */
function nextActionFrom(
	reported: readonly Reported[],
	envelope: DiagnosticEnvelope | null,
): NextAction {
	const failing = reported.find(
		(entry) => entry.row.status === 'fail' || entry.row.status === 'not-run',
	);
	if (failing !== undefined) {
		const why = failing.row.findings[0]?.message ?? failing.row.note ?? 'It did not pass.';
		return { kind: 'command', argv: [...failing.argv], why: `${failing.row.id}: ${why}` };
	}
	if (envelope !== null && envelope.summary.errors > 0) return envelope.nextAction;
	return {
		kind: 'none',
		why: 'Nothing doctor ran is failing. That is not the same as everything being checked: read the skipped rows above, because each one names something that did not run.',
	};
}

function nextActionLines(action: NextAction): string[] {
	switch (action.kind) {
		case 'command':
			return [`next: ${action.why}`, `      ${action.argv.join(' ')}`];
		case 'tool':
			return [`next: ${action.why}`, `      ${action.tool} ${JSON.stringify(action.args)}`];
		case 'none':
			return [`next: ${action.why}`];
	}
}

export const doctor = defineCommand({
	name: 'doctor',
	tool: 'docs_doctor',
	writes: 'nothing',
	summary: 'Run every check that applies to this repository and report what is wrong.',
	detail:
		'Works out which roles the repository has, an app repository with docs/site, a consuming website with a <project>.docs.json, or both, and runs the commands for those roles. It adds no checks of its own: the rows are the rows hexdocs check, hexdocs verify-install and hexdocs bundle produce, so doctor cannot disagree with them. Pass --site to include the consumer wiring checks and --bundle to verify a compiled bundle as well. Start here when something is broken and you do not yet know what.',
	params: {
		root: ROOT,
		site: {
			// `SITE`'s own words, so the two commands cannot describe the same flag
			// differently, but optional here. doctor runs whichever halves the root has, and
			// an app repository has no site to pass; the skipped row below is what says so
			// when the root looks like a consumer and this is absent.
			help: SITE.help,
			type: 'string',
		},
		bundle: {
			help: 'a compiled bundle directory to verify as well; there is no default, because a bundle is build output and lives wherever it was written',
			type: 'string',
		},
	},
	positionals: ['root'],
	taughtBy: ['docs-diagnose', 'docs-install-site'],
	async run(input, ctx) {
		const root = rootOf(ctx.cwd, input.root);

		const roles: string[] = [];
		const outputs: CommandOutput[] = [];
		const reported: Reported[] = [];
		const lines: string[] = [];

		const push = (output: CommandOutput, argv: readonly string[]): void => {
			outputs.push(output);
			for (const row of output.rows) reported.push({ row, argv });
			if (output.lines.length > 0) lines.push('', ...output.lines);
		};

		// An app repository is the one that holds the source tree. `SITE_ROOT_RELATIVE` is
		// the same constant `loadProject` joins onto the root, so this probe and the loader
		// cannot disagree about where a project lives.
		if (existsSync(join(root, ...SITE_ROOT_RELATIVE.split('/'), 'docs.json'))) {
			roles.push('app');
			const argv = ['hexdocs', 'check', root];
			push(await invoke(check, { root }, ctx), argv);
		}

		const site = input.site;
		// Probed only when `--site` is absent, because the flag is the answer the probe is
		// looking for. It is read again at the bottom, where the difference between "there is
		// no site here" and "there is one and nobody named it" decides what the closing row
		// is allowed to say.
		const candidates = site === undefined ? siteCandidates(root) : [];
		if (site !== undefined) {
			roles.push('site');
			const argv = ['hexdocs', 'verify-install', root, '--site', site];
			push(await invoke(verifyInstall, { root, site }, ctx), argv);
		} else if (candidates.length > 0) {
			reported.push({
				row: skippedRow(
					'verify-install',
					'consumer wiring checks',
					`This looks like a consuming website and --site was not given, so none of the wiring checks ran. Found a ${SITE_CONFIG_SUFFIX} under: ${candidates
						.map((candidate) => `${candidate}/${SITE_CONFIG_DIR.join('/')}`)
						.join(', ')}. Pass one of those as --site.`,
				),
				// No argv: a skipped row is never the next action, because it names something
				// nobody has decided to run rather than something that went wrong. The reason
				// is the whole remedy and it already carries the flag to pass.
				argv: [],
			});
		}

		const bundlePath = input.bundle;
		if (bundlePath !== undefined) {
			roles.push('bundle');
			const argv = ['hexdocs', 'bundle', bundlePath];
			push(await invoke(bundle, { path: bundlePath }, ctx), argv);
		} else {
			reported.push({
				row: skippedRow(
					'bundle',
					'compiled bundles',
					'No --bundle was given. A bundle is build output and nothing in a repository says which directory it is in, so doctor will not guess at one. Pass --bundle <directory> to verify one here, or run `hexdocs bundle <directory>`.',
				),
				argv: [],
			});
		}

		// The one row doctor originates, and it exists because the alternative is a false
		// green. With no role and no bundle the table is nothing but skipped rows, and
		// `verdict` counts only failures and non-runs, so the renderer would print "all
		// clear" over a run that examined nothing. That is precisely what `checkRow`'s
		// zero-examined coercion refuses one row at a time, applied to the whole command.
		//
		// The two wordings are not decoration. `outputs.length === 0` covers both "there is
		// nothing here" and "there is a site here and nobody named it", and a single message
		// claiming the first would contradict the skipped row printed directly above it in
		// the second. A row that argues with the row above it is how a report stops being
		// read.
		const first = candidates[0];
		if (outputs.length === 0) {
			reported.push(
				first === undefined
					? {
							row: notRunRow(
								'doctor',
								'documentation roles',
								`${root} holds no ${SITE_ROOT_RELATIVE}/docs.json and no ${SITE_CONFIG_SUFFIX} in the places this command probes, and no --bundle was given, so nothing ran. Run doctor from the repository root, or pass --site for a site mounted more than two levels down, or pass --bundle to verify a compiled bundle.`,
							),
							argv: ['hexdocs', 'doctor', '--help'],
						}
					: {
							row: notRunRow(
								'doctor',
								'documentation roles',
								`Nothing ran. ${root} holds no ${SITE_ROOT_RELATIVE}/docs.json, so there is no source tree to check, and the site half needs --site. The row above names every candidate.`,
							),
							argv: ['hexdocs', 'doctor', root, '--site', first],
						},
			);
		}

		const rows = reported.map((entry) => entry.row);
		const envelope = mergeEnvelopes(
			outputs.map((output) => output.envelope).filter((one) => one !== null),
		);
		const nextAction = nextActionFrom(reported, envelope);

		lines.unshift(
			roles.length === 0
				? `doctor found nothing to check in ${root}.`
				: `doctor ran the ${roles.join(', ')} check(s) in ${root}.`,
		);
		// The next action reads above the table rather than below it, because `renderOutput`
		// prints `lines`, then the rows, then the findings, and has no footer hook. That is a
		// layout compromise and not a claim that the top is the better place for it.
		lines.push('', ...nextActionLines(nextAction));

		return {
			// One cast, at the seam, the way `check` does it. These are contract types whose
			// unions `JsonValue` cannot express structurally, and every one of them is
			// serialised by the same `JSON.stringify` the dispatcher applies to any other
			// command's data.
			data: { root, roles, rows, envelope, nextAction } as unknown as JsonValue,
			lines,
			envelope,
			rows,
		};
	},
});
