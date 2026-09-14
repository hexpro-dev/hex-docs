/**
 * Parameters spelled once, so two commands cannot mean different things by `--locale`.
 *
 * A flag whose help text differs between commands is a flag an agent has to read twice,
 * and the JSON Schema description is the only thing a model sees before it calls a tool.
 */

import { resolve } from 'node:path';

import { LOCALES } from '../../../src/contracts/locales.js';
import {
	COMMIT_SHA_PATTERN,
	RELEASE_DATE_PATTERN,
	VERSION_LABEL_PATTERN,
} from '../../../src/contracts/site.js';
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

/*
 * The three fields of a version entry, spelled once for `label` and `scaffold site`.
 *
 * Neither is `required` here, because `scaffold` holds one parameter table for four kinds
 * and only `site` needs them. `label` spreads each one and adds `required: true`, which
 * keeps the literal types `Input<P>` reads while leaving one help text per flag: a sha
 * described two ways is a sha an agent reads twice.
 */

export const COMMIT = {
	help: 'the 40-character lower-case commit sha to label',
	type: 'string',
} as const satisfies Param;

export const VERSION = {
	help: 'the version label; it becomes a URL segment under /v/<label>/',
	type: 'string',
} as const satisfies Param;

export const RELEASED = {
	help: 'the release date as YYYY-MM-DD; defaults to today in UTC',
	type: 'string',
} as const satisfies Param;

/**
 * What is wrong with a version entry's three hand-typed fields, one sentence each.
 *
 * Shared by `label`, which reports these on its shape row, and `scaffold site`, which
 * refuses to return a config carrying any of them. The schema would refuse the same values,
 * and says "Invalid string: must match pattern", which tells nobody that an abbreviated sha
 * is the mistake.
 */
export function entryShapeProblems(entry: {
	commit: string;
	version: string;
	released: string;
}): string[] {
	const problems: string[] = [];
	if (!COMMIT_SHA_PATTERN.test(entry.commit)) {
		problems.push(
			`"${entry.commit}" is not a commit sha. It must be 40 lower-case hex characters; abbreviations are refused because they collide eventually.`,
		);
	}
	if (!VERSION_LABEL_PATTERN.test(entry.version)) {
		problems.push(
			`"${entry.version}" is not a version label. It is a URL segment under /v/<label>/, so it starts with a letter or a digit and carries only letters, digits, dot, underscore and hyphen, up to 32 characters.`,
		);
	}
	if (!RELEASE_DATE_PATTERN.test(entry.released)) {
		problems.push(`"${entry.released}" is not a release date. The format is YYYY-MM-DD.`);
	}
	return problems;
}

/** `YYYY-MM-DD` in UTC, the default for `--released`. */
export function isoDate(now: Date): string {
	// UTC rather than the local date, because `RELEASE_DATE_PATTERN` is a date with no
	// zone in it: rendering the local date would make the same command produce two
	// different `released` values for one instant on two machines, and the file would then
	// disagree with itself about when a version shipped depending on who ran it.
	return now.toISOString().slice(0, 10);
}

/** A root argument resolved against the context, so every command reads `.` the same way. */
export function rootOf(cwd: string, root: string | undefined): string {
	return resolve(cwd, root ?? '.');
}

/**
 * An S3 bucket name: 3 to 63 characters of lower-case letters, digits, dots and hyphens,
 * starting and ending with a letter or a digit.
 *
 * The general-purpose naming rule, and deliberately not the whole of it: a name S3 would
 * refuse for a subtler reason, such as two adjacent dots, reaches S3 and is refused there
 * with S3's own message, which is loud. What this exists to stop is quieter. The value is
 * handed to the AWS CLI as an argument, and the CLI reads a `file://` value as a file to
 * expand into the parameter and a value starting with a hyphen as a flag. Neither shape can
 * be a bucket, so the grammar refuses both without naming either.
 */
export const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * The bucket, from the flag or the environment, refusing rather than guessing.
 *
 * Returned as a value or a reason, never thrown, so the caller can put the reason on a
 * `not-run` row rather than turning a missing configuration into a stack trace.
 *
 * Checked here, where the value enters, and not in the recipe runner. `run.ts` carries a
 * paragraph saying why: `spawnSync` takes an argv array so no shell parses anything, and
 * what the program at the other end does with a value is a question about the hole it
 * fills, answered where that value comes from. `prefetch`, `publish` and `label` all take
 * the bucket through here. The value is quoted in the refusal because a string that fails
 * this grammar cannot be a working bucket name, and the usual cause is visible only in the
 * quote: an unexpanded `$HEXDOCS_BUCKET` in a prebuild string.
 *
 * `flagDeclared: false` is for a command whose parameter table has no `bucket`, which is
 * `label`. The refusal then names only the environment variable. Naming `--bucket` there
 * sent an operator who was already blocked to a flag the CLI answers with "Unknown option".
 */
export function bucketOf(
	flag: string | undefined,
	options: { readonly flagDeclared?: boolean } = {},
): { bucket: string } | { why: string } {
	const fromFlag = flag !== undefined;
	const bucket = flag ?? process.env['HEXDOCS_BUCKET'];
	if (bucket === undefined || bucket === '') {
		const how =
			options.flagDeclared === false ? 'Set HEXDOCS_BUCKET' : 'Pass --bucket or set HEXDOCS_BUCKET';
		return {
			why: `No bucket. ${how}. There is no default: hex-docs is a public repository, and a default here would be a command that appears to work while writing into a bucket somebody else owns.`,
		};
	}
	if (!BUCKET_NAME_PATTERN.test(bucket)) {
		return {
			why: `${fromFlag ? '--bucket' : 'HEXDOCS_BUCKET'} is ${JSON.stringify(bucket)}, which is not an S3 bucket name: 3 to 63 lower-case letters, digits, dots and hyphens, starting and ending with a letter or a digit. Nothing was sent to AWS.`,
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
