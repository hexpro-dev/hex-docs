/**
 * `hexdocs verify-install` / `docs_verify_install`: is this website wired for docs.
 *
 * One implementation with three front doors, which is the property `diagnostics.ts`
 * opens by insisting on. The CLI prints the table, the MCP tool returns the same object,
 * and the consumer's `scripts/check-docs.mjs` renders the same JSON from `prebuild`. The
 * shim holds no copy of what is checked, including the closing paragraph, so a check
 * added here reaches every one of them without an edit anywhere else.
 *
 * The report is validated on the way out with the schema and with both invariants the
 * schema cannot express. That is not belt and braces over code that just built it: it is
 * the one place where a hand-assembled report would be caught, and the invariants are
 * exactly the two failure modes this repository treats as worse than a red row. A green
 * row that examined nothing reads as a clean sweep; a red row with neither a finding nor
 * a note is a failure a reader cannot act on.
 */

import {
	examinedNothing,
	rowsWithoutReason,
	verifyInstallReportSchema,
	zeroExaminedPasses,
} from '../contracts/diagnostics.schema.js';
import type {
	CheckRow,
	NextAction,
	VerifyInstallReport,
} from '../../../src/contracts/diagnostics.js';
import { failedRow, notRunRow } from '../../../src/contracts/diagnostics.js';
import type { JsonValue } from '../compile/serialise.js';
import { defineCommand, exitCodeFor } from '../registry/command.js';
import { CONSUMER_CHECK_IDS, runConsumerChecks } from '../wiring/checks.js';
import { detectSite } from '../wiring/detect.js';
import { requireSitePath } from '../wiring/site.js';

import { ROOT, SITE, rootOf } from './common.js';

/**
 * What this guard does not cover, printed verbatim by every renderer.
 *
 * The house already has this paragraph: `check-tools.mjs:1329` closes a clean run with
 * "Not checked here, and still a person's job", and the shape is copied rather than
 * invented. It is data rather than prose in a renderer for the reason
 * `VerifyInstallReport` states at its declaration: a renderer holding its own copy of
 * what happened goes stale the first time a check is added, and it goes stale in the
 * reassuring direction.
 */
export const NOT_CHECKED_HERE: readonly string[] = [
	'Whether the rendered sitemap and hreflang set actually come out right. Curl the sitemap and count the <loc> entries: this checks that the entries are derived, not that seven languages times every path is what came out.',
	'Whether a docs page carries a Content-Security-Policy in a real response. `pnpm csp:check` does that against a running server. The routes check refuses a `headers` export in a docs route module, which is the cause; this is the symptom, and only one of them is observable from a file.',
	"Whether the derivation call sites use the registry correctly. These are text matches on source, in the manner of check-tools.mjs: renaming the local variable in a spread breaks the check without breaking the code, and rearranging the map around DOCS_ROUTES breaks the code without breaking the check. Neither consumer's route table can be evaluated from node without executing a Vite module.",
	'Whether the accent reads well against the page, as against merely passing a contrast ratio. Nothing here opens a browser.',
	'Whether the offline build works. `hexdocs prefetch` does no network on a warm cache, and nothing here proves the cache is warm on the machine that will deploy.',
];

function nextActionFor(rows: readonly CheckRow[], site: string): NextAction {
	const failing = rows.find((row) => row.status === 'fail' || row.status === 'not-run');
	if (failing === undefined) {
		return {
			kind: 'none',
			why: 'Every wiring check passed. Read the skipped rows and the paragraph below before treating that as a finished install.',
		};
	}
	const first = failing.findings[0];
	return {
		kind: 'command',
		argv: ['hexdocs', 'install', '--site', site],
		why:
			first === undefined
				? `Start with ${failing.id}: ${failing.note ?? 'no reason recorded'}`
				: `Start with ${failing.id}: ${first.message}`,
	};
}

export const verifyInstall = defineCommand({
	name: 'verify-install',
	tool: 'docs_verify_install',
	writes: 'nothing',
	summary: 'Check that a consuming website is wired for a docs mount.',
	detail:
		'Reads the submodule declaration, the pnpm workspace, the tsconfig path mapping, the deploy hash directories, the build chain, the route table, the localised path list, the sitemap and the MCP wiring, and reports each as a row with a count of what it examined. It is the same implementation the generated scripts/check-docs.mjs shim runs from prebuild, so the answer cannot differ between a person, an agent and the build. Run it after hexdocs install and after applying the edits install prints.',
	params: {
		root: ROOT,
		site: SITE,
		mount: {
			help: 'where the docs package is mounted; detected from the submodule when absent',
			type: 'string',
		},
	},
	positionals: ['root'],
	taughtBy: ['docs-install-site', 'docs-diagnose'],
	async run(input, ctx) {
		const repoRoot = rootOf(ctx.cwd, input.root);
		const site = detectSite({
			repoRoot,
			site: requireSitePath(input.site),
			mount: input.mount,
		});
		const rows = runConsumerChecks(site, { exec: ctx.exec, kitVersion: ctx.kitVersion });

		// The row ids and the probe keys are one fact, closed twice. `PROBES` is declared
		// `satisfies Record<ConsumerCheckId, WiringProbe>`, so a deleted probe fails the
		// typecheck by name; the type cannot see a probe that runs and returns a row with
		// somebody else's id on it, which is what this catches. A missing row would
		// otherwise be a check that quietly stopped running with every remaining row green.
		const emitted = new Set(rows.map((row) => row.id));
		const expected = new Set<string>(CONSUMER_CHECK_IDS);
		const missing = [...expected].filter((id) => !emitted.has(id));
		const extra = [...emitted].filter((id) => !expected.has(id));
		const checked: CheckRow[] = [...rows];
		if (missing.length > 0 || extra.length > 0) {
			checked.push(
				failedRow(
					'verify-install-coverage',
					rows.length,
					'rows',
					`The rows emitted do not match the probe table. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${extra.join(', ') || 'none'}.`,
				),
			);
		}

		// Every probe skipped, so the run examined nothing at all.
		//
		// That is a real state a person reaches by pointing this at a directory that is not
		// a consuming site: each probe finds nothing of its own to read and skips with a
		// good reason, the schema is satisfied, both per-row invariants hold, and the report
		// exits 0 having verified nothing. `examinedNothing` catches the shape on the way
		// out, but it catches it as a contract violation, and a contract violation is a bug
		// in this command rather than a wrong argument from a person.
		//
		// So the state is converted here into the row it actually is. `not-run` rather than
		// `fail`, because nothing is wrong with the repository: the check should have run
		// and could not, which is what that state means and why it fails the run.
		if (checked.every((row) => row.examined === 0)) {
			checked.push(
				notRunRow(
					'verify-install-scope',
					'wiring checks',
					`Every check skipped, so nothing was examined. ${site.site} does not look like a consuming site: a site directory holds app/docs/<project>.docs.json and the repository holds the docs submodule. Point --site at one, or run \`hexdocs check\` if this is a documentation source repository rather than a consumer.`,
				),
			);
		}

		const findings = checked.flatMap((row) => row.findings);
		const exitCode = exitCodeFor({ data: null, lines: [], envelope: null, rows: checked });

		const report: VerifyInstallReport = {
			kitVersion: ctx.kitVersion,
			site: site.site,
			rows: checked,
			summary: {
				errors: findings.filter((finding) => finding.severity === 'error').length,
				warnings: findings.filter((finding) => finding.severity === 'warning').length,
				infos: findings.filter((finding) => finding.severity === 'info').length,
				// Rows in this report's scope that produced no finding. `diagnostics.ts`
				// says outright that `passing` is not a coverage measure, and this report
				// inherits that: the coverage statement is the `examined` column on each
				// row, which is why a skipped row counts here and has examined nothing.
				passing: checked.filter((row) => row.findings.length === 0).length,
			},
			notCheckedHere: [...NOT_CHECKED_HERE],
			nextAction: nextActionFor(checked, site.site),
			exitCode,
		};

		const problems: string[] = [];
		const parsed = verifyInstallReportSchema.safeParse(report);
		if (!parsed.success) {
			problems.push(
				...parsed.error.issues.map(
					(issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
				),
			);
		}
		problems.push(
			...zeroExaminedPasses(report),
			...rowsWithoutReason(report),
			...examinedNothing(report),
		);
		if (problems.length > 0) {
			// A report that fails its own validation is a bug in this command, and printing
			// it anyway would be printing something with a documented shape that does not
			// have it. The shim parses this JSON.
			throw new Error(
				`hexdocs verify-install assembled a report that does not satisfy its own contract:\n  ${problems.join('\n  ')}`,
			);
		}

		return {
			data: report as unknown as JsonValue,
			lines: [
				`docs wiring for ${site.site} (mount ${site.mount}, from ${site.mountSource})`,
				`${site.projects.length} site config(s) under ${site.site}/app/docs`,
				'',
				// Printed here rather than after the table because `renderOutput` owns the
				// layout below the lines it is given. It is the same list the JSON carries
				// and the shim prints, so there is one copy of it and this is a rendering
				// of that copy rather than a second one.
				"Not checked here, and still a person's job:",
				...NOT_CHECKED_HERE.map((line) => `  ${line}`),
			],
			envelope: null,
			rows: checked,
		};
	},
});
