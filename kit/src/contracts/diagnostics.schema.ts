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

export type {
	CheckRow,
	DiagnosticEnvelope,
	DiagnosticSummary,
	Finding,
	FindingLocation,
	NextAction,
	VerifyInstallReport,
};
