/**
 * Parameters spelled once, so two commands cannot mean different things by `--locale`.
 *
 * A flag whose help text differs between commands is a flag an agent has to read twice,
 * and the JSON Schema description is the only thing a model sees before it calls a tool.
 */

import { resolve } from 'node:path';

import { LOCALES } from '../../../src/contracts/locales.js';
import type { Param } from '../registry/params.js';

/**
 * `satisfies Param`, never `: Param`, and the difference is not stylistic.
 *
 * `Input<P>` is a mapped type over the parameter table that reads `required` and
 * `fallback` as literal types to decide which keys a handler may read without
 * narrowing. An annotation widens both back to `boolean | undefined` and
 * `string | number | boolean | undefined`, so a shared `ROOT` declared `: Param` makes
 * every handler that uses it see `root?: string` even though the schema guarantees a
 * value. That is the whole benefit of the table erased by one colon, and it was caught
 * by four separate handlers reaching for a fallback the table already declares.
 *
 * `satisfies` checks the shape and keeps the literal, which is what these need.
 */
export const ROOT = {
	help: 'repository root; defaults to the working directory',
	type: 'string',
	fallback: '.',
} as const satisfies Param;

export const LOCALE_MANY = {
	help: 'restrict to these locales; repeat the flag for more than one',
	type: 'string',
	values: LOCALES,
	many: true,
} as const satisfies Param;

export const SITE = {
	help: 'the consuming site directory, relative to the repository root, such as apps/front',
	type: 'string',
	required: true,
} as const satisfies Param;

export const BUCKET = {
	// No fallback, deliberately. A default bucket name is a command that appears to work
	// while writing into a bucket somebody else owns, and this repository is public, so
	// the name does not live here at all.
	help: 'the S3 bucket; also read from HEXDOCS_BUCKET',
	type: 'string',
} as const satisfies Param;

export const REGION = {
	help: 'the AWS region',
	type: 'string',
	fallback: 'ap-southeast-2',
} as const satisfies Param;

export const PROFILE = {
	help: 'the AWS profile to sign with',
	type: 'string',
} as const satisfies Param;

/** A root argument resolved against the context, so every command reads `.` the same way. */
export function rootOf(cwd: string, root: string | undefined): string {
	return resolve(cwd, root ?? '.');
}

/**
 * The bucket, from the flag or the environment, refusing rather than guessing.
 *
 * Returned as a value or a reason, never thrown, so the caller can put the reason on a
 * `not-run` row rather than turning a missing configuration into a stack trace.
 */
export function bucketOf(flag: string | undefined): { bucket: string } | { why: string } {
	const bucket = flag ?? process.env['HEXDOCS_BUCKET'];
	if (bucket === undefined || bucket === '') {
		return {
			why: 'No bucket. Pass --bucket or set HEXDOCS_BUCKET. There is no default: hex-docs is a public repository, and a default here would be a command that appears to work while writing into a bucket somebody else owns.',
		};
	}
	return { bucket };
}

/**
 * The region a command was given, or the one its own parameter table declares.
 *
 * `shapeOf` applies a `fallback` before a handler ever sees the input, so `--region` is
 * always filled at runtime and this is a total function rather than a default. Reading
 * the value back off `REGION` is what keeps it declared exactly once, in the place
 * `--help` and the JSON Schema both read; a literal here would be a second declaration
 * neither of them can see.
 */
export function regionOf(region: string | undefined): string {
	return region ?? REGION.fallback;
}
