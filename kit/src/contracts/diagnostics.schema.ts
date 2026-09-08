/**
 * Zod mirrors of the diagnostic shapes.
 *
 * These are validated on the way *out*, not the way in. `hexdocs verify-install --json`
 * is parsed by a zero-dependency shim in a consuming repository that cannot import
 * anything, so the only place the report's shape can be checked is here, before it is
 * printed. A shim rendering a report it could not parse exits 3, which is loud; a CLI
 * emitting a report that quietly lost a field is not.
 */

import { z } from 'zod';

import {
	CHECK_STATES,
	FINDING_CATEGORIES,
	SEVERITIES,
	type CheckRow,
	type DiagnosticEnvelope,
	type DiagnosticSummary,
	type Finding,
	type FindingLocation,
	type NextAction,
	type VerifyInstallReport,
} from '../../../src/contracts/diagnostics.js';
import { countSchema, localeSchema, ruleIdSchema } from './primitives.js';

export const findingLocationSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('project') }),
	z.strictObject({
		kind: z.literal('file'),
		file: z.string().min(1),
		line: z.int().min(1).optional(),
		column: z.int().min(1).optional(),
	}),
	z.strictObject({
		kind: z.literal('pointer'),
		file: z.string().min(1),
		// RFC 6901: the empty string is the whole document, so no minimum length.
		pointer: z.string(),
	}),
	z.strictObject({
		kind: z.literal('ast'),
		file: z.string().min(1),
		path: z.array(z.union([z.string(), z.int()])),
		line: z.int().min(1).optional(),
	}),
]);

export const findingSchema = z.strictObject({
	rule: ruleIdSchema,
	severity: z.enum(SEVERITIES),
	category: z.enum(FINDING_CATEGORIES),
	location: findingLocationSchema,
	locale: localeSchema.nullable(),
	message: z.string().min(1),
	consequence: z.string().min(1),
	remediation: z.string().min(1).nullable(),
	// Never the empty string. An agent cannot tell "no suggestion" from "replace this
	// with nothing", so the empty case is spelled `null` and enforced here.
	suggestion: z.string().min(1).nullable(),
	excerpt: z.string().min(1).nullable(),
});

export const nextActionSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('tool'),
		tool: z.string().min(1),
		args: z.record(z.string(), z.unknown()),
		why: z.string().min(1),
	}),
	z.strictObject({
		kind: z.literal('command'),
		// An argv array, never a shell string. A skill that copies a command out of a
		// diagnostic must not be able to carry a metacharacter past the exec gate.
		argv: z.array(z.string()).min(1),
		why: z.string().min(1),
	}),
	z.strictObject({ kind: z.literal('none'), why: z.string().min(1) }),
]);

export const diagnosticSummarySchema = z.strictObject({
	errors: countSchema,
	warnings: countSchema,
	infos: countSchema,
	passing: countSchema,
});

export const diagnosticEnvelopeSchema = z.strictObject({
	kitVersion: z.string().min(1),
	summary: diagnosticSummarySchema,
	findings: z.array(findingSchema),
	truncated: z.boolean(),
	nextAction: nextActionSchema,
});

export const checkRowSchema = z.strictObject({
	id: z.string().min(1),
	status: z.enum(CHECK_STATES),
	examined: countSchema,
	unit: z.string().min(1),
	findings: z.array(findingSchema),
	note: z.string().min(1).nullable(),
});

export const verifyInstallReportSchema = z.strictObject({
	kitVersion: z.string().min(1),
	site: z.string().min(1),
	rows: z.array(checkRowSchema).min(1),
	summary: diagnosticSummarySchema,
	notCheckedHere: z.array(z.string().min(1)),
	nextAction: nextActionSchema,
	exitCode: z.union([z.literal(0), z.literal(3)]),
});

/**
 * The one invariant the schema cannot express: a row that examined nothing has not
 * passed.
 *
 * `checkRow()` in the runtime half already coerces this at construction, so a
 * violation here means a report was assembled by hand somewhere. Checking it again on
 * the way out is cheap, and this is the guard whose whole purpose is that a check
 * silently examining zero things reads as a clean sweep.
 */
export function zeroExaminedPasses(report: VerifyInstallReport): string[] {
	return report.rows
		.filter((row) => row.status === 'pass' && row.examined === 0)
		.map(
			(row) =>
				`Check "${row.id}" passed having examined zero ${row.unit}. That is a failure: either the glob stopped matching or the directory moved.`,
		);
}

/**
 * The same invariant from the other end: a row that is not a pass and says nothing.
 *
 * `zeroExaminedPasses` catches a green row that examined nothing. This catches a row
 * a reader cannot act on: a `fail` with no finding and no note is a red line with no
 * cause, and a `skipped` with no note is indistinguishable from a check somebody
 * switched off, which is the opposite of what that state means.
 *
 * `checkRowSchema` permits `note: null` on every state, and it has to: a passing row
 * with findings below the error threshold has a reason in the findings and needs no
 * note. So the rule is per state rather than in the schema, and `skipped` is included
 * deliberately, because step 5 emits more of those than of anything else.
 */
export function rowsWithoutReason(report: VerifyInstallReport): string[] {
	return report.rows
		.filter(
			(row) =>
				row.status !== 'pass' &&
				row.findings.length === 0 &&
				(row.note === null || row.note.trim() === ''),
		)
		.map(
			(row) =>
				`Check "${row.id}" is ${row.status} and carries neither a finding nor a note. A row a reader cannot act on is the same problem as a passing row that examined nothing, from the other end.`,
		);
}

/**
 * The counting rule at the level of the whole report.
 *
 * `checkRow` applies it per row and `zeroExaminedPasses` re-checks that on the way out,
 * and both are exempt from the state this catches. A `skipped` row examines nothing on
 * purpose, so it is exempt by design and correctly so; but a report in which *every* row
 * skipped has looked at nothing, validates against the schema, satisfies both per-row
 * invariants and exits 0. The generated shim then prints "a skipped check did not run, it
 * is not a pass" immediately above an exit code saying it was.
 *
 * That is the same failure the per-row rule exists for, one level up, and it is the
 * likeliest shape step 5 can produce: skips are what this half of the toolchain emits
 * when a repository does not have the thing a check reads.
 *
 * It is a property of the contract rather than of today's probe table, which is why it
 * lives here beside the other two and not inside `verifyInstall`. Both other readers, the
 * shim and the MCP tool, get it for free.
 */
export function examinedNothing(report: VerifyInstallReport): string[] {
	// Only a report that would otherwise pass. `zeroExaminedPasses` scopes itself to rows
	// whose status is `pass` for the same reason, and the report-level analogue of "pass"
	// is a zero exit code: a report already carrying a failing or non-running row has
	// reported failure, and a second sentence saying it examined nothing adds nothing.
	// Without this scope the guard fires on its own remedy, because a `not-run` row
	// examines nothing by definition.
	if (report.exitCode !== 0) return [];
	const total = report.rows.reduce((sum, row) => sum + row.examined, 0);
	if (total > 0) return [];
	return [
		`This report has ${report.rows.length} row(s), exits 0 and examined zero things in total. A report that looked at nothing has not verified anything, whatever its rows say individually.`,
	];
}

export type {
	CheckRow,
	DiagnosticEnvelope,
	DiagnosticSummary,
	Finding,
	FindingLocation,
	NextAction,
	VerifyInstallReport,
};
