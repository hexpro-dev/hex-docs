/**
 * Shared leaf schemas.
 *
 * Declared once so that "a sha256" means the same thing in the manifest, the site
 * config and the asset record. Three copies of a hex regex is three chances for one
 * of them to accept an upper-case digest, which produces a second key for the same
 * bytes and quietly defeats write-once.
 */

import { z } from 'zod';

import {
	COMMIT_SHA_PATTERN,
	RELEASE_DATE_PATTERN,
	SHA256_PATTERN,
	VERSION_LABEL_PATTERN,
} from '../../../src/contracts/site.js';
import { LOCALES } from '../../../src/contracts/locales.js';
import { PROJECT_ID_PATTERN, REPO_PATTERN } from '../../../src/contracts/project.js';
import { RULE_ID_PATTERN } from '../../../src/contracts/lint.js';
import { SEMVER_PATTERN } from '../../../src/contracts/frontmatter.js';
import {
	SLUG_SEGMENT_PATTERN,
	MAX_SLUG_DEPTH,
	MAX_SEGMENT_LENGTH,
} from '../../../src/contracts/slug.js';
import { UTC_TIMESTAMP_PATTERN } from '../../../src/contracts/manifest.js';

export const localeSchema = z.enum(LOCALES);

export const sha256Schema = z
	.string()
	.regex(SHA256_PATTERN, 'Expected 64 lower-case hex characters.');

export const commitShaSchema = z
	.string()
	.regex(
		COMMIT_SHA_PATTERN,
		'Expected a full 40-character lower-case commit sha. Abbreviations collide.',
	);

export const utcTimestampSchema = z
	.string()
	.regex(UTC_TIMESTAMP_PATTERN, 'Expected ISO 8601 UTC to the second, e.g. 2026-09-07T04:11:52Z.');

export const releaseDateSchema = z.string().regex(RELEASE_DATE_PATTERN, 'Expected YYYY-MM-DD.');

export const versionLabelSchema = z.string().regex(VERSION_LABEL_PATTERN);

export const semverSchema = z
	.string()
	.regex(SEMVER_PATTERN, 'Expected three numeric parts, e.g. 1.0.0. No "v" prefix.');

export const projectIdSchema = z
	.string()
	.regex(
		PROJECT_ID_PATTERN,
		'Expected a lower-case hyphenated id: it is an S3 prefix and a URL segment.',
	);

export const repoSchema = z.string().regex(REPO_PATTERN, 'Expected owner/name.');

export const ruleIdSchema = z.string().regex(RULE_ID_PATTERN);

/**
 * The wire form of a slug. Structural validation beyond the shape (reserved roots,
 * nested `index`) belongs to `parseSlug`, which produces a diagnostic naming the
 * offending segment rather than a regex failure.
 */
export const slugSchema = z
	.string()
	.min(1)
	.max(MAX_SLUG_DEPTH * (MAX_SEGMENT_LENGTH + 1))
	.refine(
		(value) => value.split('/').every((segment) => SLUG_SEGMENT_PATTERN.test(segment)),
		'Each segment must be lower-case ASCII letters, digits and single hyphens.',
	)
	.refine(
		(value) => value.split('/').length <= MAX_SLUG_DEPTH,
		`At most ${MAX_SLUG_DEPTH} levels deep.`,
	)
	// The `max()` above bounds the whole slug, which a single long segment can satisfy:
	// `a/<250 characters>` is under the total and over the per-segment limit, so the
	// schema accepted a slug `parseSlug` then refused. Two validators disagreeing about
	// what a slug is means the build fails somewhere other than where the mistake is.
	.refine(
		(value) => value.split('/').every((segment) => segment.length <= MAX_SEGMENT_LENGTH),
		`At most ${MAX_SEGMENT_LENGTH} characters per segment.`,
	);

/** A non-negative integer count. */
export const countSchema = z.int().min(0);

/** A positive integer, for dimensions and sizes that cannot be zero. */
export const positiveIntSchema = z.int().min(1);

/** Absolute https. `http:` is refused everywhere, matching hex-web's own `safeHref`. */
export const httpsUrlSchema = z
	.string()
	.url()
	.refine((value) => value.startsWith('https://'), 'Only https: URLs are allowed.');
