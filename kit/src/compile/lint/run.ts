/**
 * Turning raw findings into a report.
 *
 * Three things happen here and nowhere else: a project's config decides a severity, a
 * suppression comment drops a finding, and the whole list is put in one documented
 * order. Keeping them together is what makes the CLI, the consumer's shim and the MCP
 * tool incapable of disagreeing about what a clean run is, which is the property
 * `diagnostics.ts` opens by insisting on.
 */

import {
	SEVERITIES,
	compareFindings,
	type DiagnosticEnvelope,
	type DiagnosticSummary,
	type Finding,
	type NextAction,
	type Severity,
} from '../../../../src/contracts/diagnostics.js';
import type { FindingCategory } from '../../../../src/contracts/diagnostics.js';
import {
	CHECK_IDS,
	LINT_RULE_IDS,
	RULE_CATEGORIES,
	type LintRuleId,
} from '../../../../src/contracts/lint.js';
import type { Locale } from '../../../../src/contracts/locales.js';
import { SOURCE_LOCALE } from '../../../../src/contracts/locales.js';
import type { DocsProjectConfig } from '../../../../src/contracts/project.js';

import type { DisableComment, RawFinding } from '../types.js';
import { RULE_DEFINITIONS, resolveSeverity } from './registry.js';

/**
 * The most findings one report carries.
 *
 * `truncated` is a required field on the envelope rather than something a reader infers
 * from a length, because a 200-page project across seven locales is fourteen hundred
 * files and this limit is reached in ordinary use rather than in an edge case.
 */
export const MAX_FINDINGS = 500;

export interface LintRunOptions {
	config: DocsProjectConfig;
	disables: readonly DisableComment[];
	kitVersion: string;
	/**
	 * Severity floors the project config cannot express.
	 *
	 * `i18n.parity` is the one that exists: under `required` a missing translation is a
	 * publish-blocking error, and under `graceful` it is the rule's own default. Putting
	 * it here rather than inside the rule keeps the rule pure and keeps the reason
	 * visible at the call site.
	 */
	overrides?: Partial<Record<LintRuleId, Severity>>;
	/**
	 * The source line span of every block a finding can come from.
	 *
	 * Without this a suppression matched only `location.line - 1`, and every corpus file is
	 * hard-wrapped at about 75 columns, so a house-style finding usually lands on a
	 * continuation line rather than on the paragraph's first line. A comment written where
	 * an author would write it, above the paragraph, therefore suppressed nothing and was
	 * itself reported as matching nothing; the only placement that worked was inside the
	 * paragraph, and `stripComments` turns that line blank, which splits the paragraph in
	 * two on the published page. For `no-em-dash` and the other protected rules, which
	 * default to `error` and cannot be lowered, that made a visible change to what the
	 * reader sees the only way past a false positive.
	 */
	spans?: readonly BlockSpan[];
}

/** One block's extent in its source file, both ends inclusive, both 1-based. */
export interface BlockSpan {
	file: string;
	from: number;
	to: number;
}

const CHECK_ID_SET: ReadonlySet<string> = new Set<string>(CHECK_IDS);

/**
 * The category of a check id, which has no entry in `RULE_CATEGORIES`.
 *
 * Derived from the prefix rather than listed, so a check added to `CHECK_IDS` is
 * categorised without a second list to update. The two prefixes are the only two there
 * are, and the fallback names the id rather than guessing.
 */
function checkCategory(id: string): FindingCategory {
	if (id.startsWith('wiring-')) return 'wiring';
	if (id.startsWith('bundle-')) return 'bundle';
	return 'config';
}

function severityFor(
	rule: string,
	locale: Locale | null,
	options: LintRunOptions,
): Severity | 'off' {
	// A check is not a rule. There is no severity to configure and no project may turn
	// one off, because each one reports a state in which the package cannot do its job.
	if (CHECK_ID_SET.has(rule)) return 'error';

	const resolved = resolveSeverity(
		rule as LintRuleId,
		options.config.lint,
		locale ?? SOURCE_LOCALE,
	);
	const floor = options.overrides?.[rule as LintRuleId];
	if (floor === undefined) return resolved;
	if (resolved === 'off') return floor;
	return SEVERITIES.indexOf(floor) < SEVERITIES.indexOf(resolved) ? floor : resolved;
}

function toFinding(entry: RawFinding, severity: Severity): Finding {
	const isCheck = CHECK_ID_SET.has(entry.rule);
	const definition = isCheck ? undefined : RULE_DEFINITIONS[entry.rule as LintRuleId];
	return {
		rule: entry.rule,
		severity,
		category: isCheck ? checkCategory(entry.rule) : RULE_CATEGORIES[entry.rule as LintRuleId],
		location: entry.location,
		locale: entry.locale,
		message: entry.message,
		consequence: definition?.consequence ?? 'The package cannot do its job in this state.',
		remediation: entry.remediation,
		suggestion: entry.suggestion,
		excerpt: entry.excerpt,
	};
}

export interface LintRunResult {
	envelope: DiagnosticEnvelope;
	/** Suppressions that dropped nothing, so a stale one is visible rather than free. */
	unusedDisables: DisableComment[];
}

export function runLint(entries: readonly RawFinding[], options: LintRunOptions): LintRunResult {
	const disables = options.disables.map((comment) => ({ ...comment }));
	const kept: Finding[] = [];
	const firing = new Set<string>();

	for (const entry of entries) {
		const severity = severityFor(entry.rule, entry.locale, options);
		if (severity === 'off') continue;

		const location = entry.location;
		if (location.kind === 'file' && location.line !== undefined) {
			const line = location.line;
			const suppression = disables.find(
				(comment) =>
					comment.file === location.file &&
					comment.rule === entry.rule &&
					// The literal next line, which is what a block-level finding wants: a
					// block's recorded origin is its first line, and that is where an author
					// would put the comment anyway.
					(comment.line === line - 1 ||
						// Or the block that starts on the line after the comment, anywhere in
						// it. This is the hard-wrapped paragraph case.
						(options.spans ?? []).some(
							(span) =>
								span.file === location.file &&
								span.from === comment.line + 1 &&
								line >= span.from &&
								line <= span.to,
						)),
			);
			if (suppression !== undefined) {
				suppression.used = true;
				continue;
			}
		}

		firing.add(entry.rule);
		kept.push(toFinding(entry, severity));
	}

	const unusedDisables = disables.filter((comment) => !comment.used);
	for (const comment of unusedDisables) {
		kept.push({
			rule: comment.rule,
			// Always `info`, whatever the rule it names resolves to. It is a statement about
			// the comment rather than about the code, and a stale suppression that inherited
			// `error` would block a publish over a line nobody has a problem with.
			severity: 'info',
			category: CHECK_ID_SET.has(comment.rule)
				? checkCategory(comment.rule)
				: (RULE_CATEGORIES[comment.rule as LintRuleId] ?? 'config'),
			location: { kind: 'file', file: comment.file, line: comment.line },
			locale: null,
			message: `This suppression of "${comment.rule}" matched nothing.`,
			consequence:
				'A suppression that suppresses nothing counts against maxDisables and hides whatever the line grows into next.',
			remediation: 'Delete the comment.',
			suggestion: null,
			excerpt: comment.reason,
		});
	}

	const maxDisables = options.config.lint.maxDisables;
	if (disables.length > maxDisables) {
		kept.push({
			rule: 'front-matter-invalid',
			severity: 'error',
			category: 'config',
			location: { kind: 'file', file: 'docs.json' },
			locale: null,
			message: `This project carries ${disables.length} suppression comments and its cap is ${maxDisables}.`,
			consequence:
				'Suppressions with reasons are legitimate and a growing pile of them is an opt-out nobody decided on. Counting is the only thing that keeps it visible.',
			remediation:
				'Fix the findings, or raise lint.maxDisables in docs.json and say in the commit why the number went up.',
			suggestion: null,
			excerpt: null,
		});
	}

	// Identical findings collapse to one. A rule that reads prose is run once per file, so
	// a fact about the project rather than about the page, such as there being no deny
	// list at all, is otherwise reported once for every file in the tree: fifty-one
	// copies of one sentence, with the count in the summary saying fifty-one problems.
	// Two findings that differ in any way, the column included, are two findings.
	const seen = new Set<string>();
	const unique = kept.filter((finding) => {
		const key = canonicalKey(finding);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	unique.sort(compareFindings);
	const truncated = unique.length > MAX_FINDINGS;
	const findings = truncated ? unique.slice(0, MAX_FINDINGS) : unique;

	const summary: DiagnosticSummary = {
		errors: unique.filter((finding) => finding.severity === 'error').length,
		warnings: unique.filter((finding) => finding.severity === 'warning').length,
		infos: unique.filter((finding) => finding.severity === 'info').length,
		passing: LINT_RULE_IDS.filter(
			(id) => severityFor(id, null, options) !== 'off' && !firing.has(id),
		).length,
	};

	return {
		envelope: {
			kitVersion: options.kitVersion,
			summary,
			findings,
			truncated,
			nextAction: nextAction(unique, truncated),
		},
		unusedDisables,
	};
}

/** Everything that makes two findings the same finding to a reader. */
function canonicalKey(finding: Finding): string {
	return JSON.stringify([finding.rule, finding.severity, finding.location, finding.message]);
}

/**
 * One action, with the reason.
 *
 * Sorted worst first already, so the first finding is the one to act on. A list with no
 * ordering is what makes an agent's second call the wrong one, and an agent cannot infer
 * priority from a list it did not sort.
 */
function nextAction(findings: readonly Finding[], truncated: boolean): NextAction {
	const first = findings.find((finding) => finding.severity === 'error');
	if (first !== undefined) {
		const where = 'file' in first.location ? first.location.file : 'the project';
		return {
			kind: 'command',
			argv: ['hexdocs', 'lint', where],
			why: `${findings.filter((f) => f.severity === 'error').length} errors block a publish. Start with "${first.rule}" in ${where}.${truncated ? ' The list is truncated: fix these and run it again.' : ''}`,
		};
	}
	const warning = findings.find((finding) => finding.severity === 'warning');
	if (warning !== undefined) {
		return {
			kind: 'none',
			why: `Nothing blocks a publish. ${findings.filter((f) => f.severity === 'warning').length} warnings are worth reading before the next release.`,
		};
	}
	return { kind: 'none', why: 'Nothing to do.' };
}
