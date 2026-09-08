/**
 * One finding shape, one envelope, one set of states.
 *
 * Every diagnostic surface in this package emits these: `hexdocs lint`,
 * `hexdocs validate`, `check_links`, `check_nav`, `translation_status`,
 * `verify-install`, and the MCP tools that wrap them. That is the point. The wiring
 * check has one implementation and three front doors, the CLI, the JSON the
 * consumer's `check-docs.mjs` shim renders, and the MCP tool, and they cannot be
 * allowed to disagree about what correct means. Two finding shapes with two renderers
 * is precisely the drift this package exists to stop happening to documentation.
 *
 * Nullability convention here is the opposite of the AST's. A `Finding` field that
 * can be absent is `T | null` and always present, because the consumer is an agent
 * deciding what to do next: "there is no suggested fix" and "the suggested fix is to
 * delete this text" must not both be expressible as a falsy value. Bytes do not
 * matter in a diagnostic; ambiguity does.
 */

import type { Locale } from './locales.js';

export const SEVERITIES = ['error', 'warning', 'info'] as const;

/**
 * Exactly three.
 *
 * `error` blocks a publish, `warning` does not, `info` is advice. Heading parity is
 * why there are three and not two: it is an error when the translation is current and
 * a warning when it is already stale, because the alternative deadlocks a project
 * into retranslating six pages before it can publish a typo fix. A fourth level would
 * let a rule exist that neither blocks nor is reported, which is a rule nobody reads.
 */
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_CATEGORIES = [
	'structure',
	'house-style',
	'brand',
	'i18n',
	'links',
	'nav',
	'assets',
	'wiring',
	'bundle',
	'config',
] as const;

/** Closed, so a typo makes a schema error rather than a new category nobody groups by. */
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/**
 * Where a finding is.
 *
 * A discriminated union, not a string. One design draft typed this as a single
 * `path: string` commented "JSON pointer, filesystem path, or path:line:col", which a
 * renderer cannot take apart again: the consumer's shim would have to re-derive the
 * format with a regex, and it would get the config-pointer case wrong.
 */
export type FindingLocation =
	/** No narrower location than the project itself. */
	| { kind: 'project' }
	/** A source file, optionally a position in it. Both 1-based. */
	| { kind: 'file'; file: string; line?: number; column?: number }
	/** A position inside a JSON document, as an RFC 6901 pointer. */
	| { kind: 'pointer'; file: string; pointer: string }
	/** A node in a compiled page: the child indices from the page root down. */
	| { kind: 'ast'; file: string; path: (string | number)[]; line?: number };

export type FindingLocationKind = FindingLocation['kind'];

export interface Finding {
	/**
	 * The rule or check that produced this. Kebab case, from `LINT_RULE_IDS` or
	 * `CHECK_IDS`.
	 *
	 * Stable, because it is what a suppression comment names, what a project config
	 * overrides, and what somebody greps for when the same finding turns up again in
	 * six months.
	 */
	rule: string;
	severity: Severity;
	category: FindingCategory;
	location: FindingLocation;
	/** The locale this finding is about, when it is about one. */
	locale: Locale | null;
	/** What is wrong. One sentence, present tense, no leading rule id. */
	message: string;
	/**
	 * What breaks if it is left. Carried on the finding rather than behind a second
	 * "explain this" call, because an agent that has to ask why will instead guess.
	 */
	consequence: string;
	/** What to do about it, in prose. `null` when the message already says it. */
	remediation: string | null;
	/**
	 * A concrete replacement, safe to apply verbatim. `null` when the fix needs
	 * judgement. Never the empty string: an agent cannot tell "no suggestion" from
	 * "replace this with nothing".
	 */
	suggestion: string | null;
	/** The offending text, trimmed to a line. `null` when there is no useful span. */
	excerpt: string | null;
}

/**
 * Total order over findings: worst first, then grouped by category, then by position.
 *
 * A documented invariant rather than a rendering detail. Golden files depend on it,
 * and so does an agent re-running a check and expecting the same first line: an
 * unordered list is what makes the second call address a different problem from the
 * first.
 */
export function compareFindings(a: Finding, b: Finding): number {
	const bySeverity = SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
	if (bySeverity !== 0) return bySeverity;

	const byCategory =
		FINDING_CATEGORIES.indexOf(a.category) - FINDING_CATEGORIES.indexOf(b.category);
	if (byCategory !== 0) return byCategory;

	const aFile = 'file' in a.location ? a.location.file : '';
	const bFile = 'file' in b.location ? b.location.file : '';
	if (aFile !== bFile) return aFile < bFile ? -1 : 1;

	const aLine = 'line' in a.location ? (a.location.line ?? 0) : 0;
	const bLine = 'line' in b.location ? (b.location.line ?? 0) : 0;
	if (aLine !== bLine) return aLine - bLine;

	return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
}

/**
 * What to do next: one action, with the reason.
 *
 * Every diagnostic carries one. A finding list with no ordering is what makes an
 * agent's second call the wrong one, and the agent cannot infer priority from a list
 * it did not sort.
 *
 * A command is an argv array, never a shell string. A skill that copies a command out
 * of a diagnostic and runs it must not be able to carry a metacharacter past the exec
 * gate, and a single string is the shape that lets it.
 */
export type NextAction =
	| { kind: 'tool'; tool: string; args: Record<string, unknown>; why: string }
	| { kind: 'command'; argv: string[]; why: string }
	| { kind: 'none'; why: string };

export interface DiagnosticSummary {
	errors: number;
	warnings: number;
	infos: number;
	/**
	 * Enabled rules that reported nothing.
	 *
	 * This line used to read "checks that ran and found nothing, not things not
	 * reported", and the implementation was and is exactly "things not reported". The
	 * wording is corrected rather than the number because making it true means every rule
	 * declaring what it had to examine, and a rule with nothing to look at then needs a
	 * third state in this summary rather than a place in one of these four counts. That is
	 * a design change with a wire format behind it, and inventing it inside a bug fix is
	 * how a field ends up meaning two things.
	 *
	 * So read this as what it is: a rule with nothing to examine is counted here. On a
	 * project with no SVG, `asset-svg-unsafe` is in this number. The one case where that
	 * was actively misleading is closed at the rule instead, because it is the one that
	 * matters: both deny rules now report themselves when the deny list is absent **or**
	 * empty, so the two protected brand rules cannot sit in this count having scanned
	 * nothing.
	 */
	passing: number;
}

/**
 * What every diagnostic tool returns.
 *
 * `truncated` is required rather than implied by a length. A list that silently
 * stopped at a limit reads as complete, and a 200-page project across seven locales
 * is fourteen hundred files, so the limit is reached in ordinary use rather than in
 * an edge case.
 */
export interface DiagnosticEnvelope {
	/** The toolchain that produced this, so a stale submodule is visible in the output. */
	kitVersion: string;
	summary: DiagnosticSummary;
	findings: Finding[];
	truncated: boolean;
	nextAction: NextAction;
}

export const CHECK_STATES = ['pass', 'fail', 'skipped', 'not-run'] as const;

/**
 * Four states, matching `kcalc-web/front/scripts/verify.mjs`.
 *
 * `skipped` is "deliberately not run, here is why". `not-run` is "should have run and
 * did not, because something earlier failed". Collapsing either into `pass` is how a
 * report claims coverage it does not have.
 */
export type CheckState = (typeof CHECK_STATES)[number];

export interface CheckRow {
	id: string;
	status: CheckState;
	/** How many things this check actually looked at. */
	examined: number;
	/** What it counted, plural: "files", "imports", "pages". */
	unit: string;
	findings: Finding[];
	note: string | null;
}

/**
 * Builds a `CheckRow`, converting a pass that examined nothing into a failure.
 *
 * The coercion lives here rather than in a renderer on purpose. There are three
 * renderers over this data, the CLI, the consumer's shim and the MCP tool, and if the
 * rule lived in one of them the other two would disagree about the same run. A check
 * that walked an empty directory and exited zero has not passed; the glob stopped
 * matching, or the directory moved.
 */
export function checkRow(
	id: string,
	examined: number,
	unit: string,
	findings: Finding[],
	note: string | null = null,
): CheckRow {
	if (findings.some((finding) => finding.severity === 'error')) {
		return { id, status: 'fail', examined, unit, findings, note };
	}
	if (examined === 0) {
		return {
			id,
			status: 'fail',
			examined,
			unit,
			findings,
			note: `Examined zero ${unit}. A check that looked at nothing has not passed.`,
		};
	}
	return { id, status: 'pass', examined, unit, findings, note };
}

/**
 * The full report from `hexdocs verify-install --json`.
 *
 * The JSON carries every string the shim prints, including `notCheckedHere`, which is
 * the closing paragraph naming what this guard does not cover. The shim owns layout
 * and colour and nothing else: a shim holding its own copy of what is checked goes
 * stale the first time a check is added, and it goes stale silently, in the
 * reassuring direction.
 */
export interface VerifyInstallReport {
	kitVersion: string;
	/** The consuming site this report is about, e.g. `apps/front`. */
	site: string;
	rows: CheckRow[];
	summary: DiagnosticSummary;
	/** What this guard deliberately does not check, printed verbatim. */
	notCheckedHere: string[];
	nextAction: NextAction;
	/**
	 * `0` clean, `3` not.
	 *
	 * Three, not one, so a shim that could not spawn the CLI or could not parse its
	 * output is distinguishable from a run that found problems. Either way it must
	 * exit non-zero: a shim that degrades to "validation skipped" prints a pass
	 * forever the day the spawn path breaks.
	 */
	exitCode: 0 | 3;
}
