/**
 * The value checks in `commands/common.ts` that sit where a value enters.
 *
 * `arms.test.ts` owns what `bucketOf` says when there is no bucket at all and which source
 * wins. This file is the other half: what it refuses when there is one, and the shape
 * sentences `label` and `scaffold site` share. Both halves matter for the same reason. The
 * bucket is handed to the AWS CLI as an argument, and that program reads a `file://` value
 * as a file to expand and a leading hyphen as a flag, so a value that cannot be a bucket
 * has to stop here rather than reach it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
	BUCKET_NAME_PATTERN,
	bucketOf,
	entryShapeProblems,
	isoDate,
} from '../../src/commands/common.js';

let saved: string | undefined;

beforeEach(() => {
	saved = process.env['HEXDOCS_BUCKET'];
	delete process.env['HEXDOCS_BUCKET'];
});

afterEach(() => {
	if (saved === undefined) delete process.env['HEXDOCS_BUCKET'];
	else process.env['HEXDOCS_BUCKET'] = saved;
});

describe('bucketOf refuses what cannot be a bucket name', () => {
	const REFUSED: readonly { value: string; why: string }[] = [
		{ value: 'file:///etc/hosts', why: 'the CLI would read that file into the parameter' },
		{ value: '--debug', why: 'the CLI would take it as a flag' },
		{ value: '-bucket', why: 'a leading hyphen is a flag too' },
		{ value: '$HEXDOCS_BUCKET', why: 'an unexpanded variable in a prebuild string' },
		{ value: 'Hex-Docs', why: 'upper case' },
		{ value: 'ab', why: 'two characters' },
		{ value: 'a'.repeat(64), why: 'sixty-four characters' },
		{ value: 'bucket-', why: 'ends with a hyphen' },
		{ value: '.bucket', why: 'starts with a dot' },
		{ value: 'my bucket', why: 'a space' },
		{ value: 'my_bucket', why: 'an underscore' },
	];

	for (const entry of REFUSED) {
		test(`${JSON.stringify(entry.value)} is refused: ${entry.why}`, () => {
			const result = bucketOf(entry.value);
			expect(result).not.toHaveProperty('bucket');
			const why = (result as { why: string }).why;
			expect(why).toContain('not an S3 bucket name');
			expect(why).toContain(JSON.stringify(entry.value));
			expect(why).toContain('--bucket');
			expect(why).toContain('Nothing was sent to AWS');
		});
	}

	test('the environment variable is held to the same grammar and named as the source', () => {
		process.env['HEXDOCS_BUCKET'] = 'file://secrets';
		const result = bucketOf(undefined);
		expect(result).not.toHaveProperty('bucket');
		expect((result as { why: string }).why).toContain('HEXDOCS_BUCKET is "file://secrets"');
	});

	test('the names a bucket can really have are accepted, at both ends of the length', () => {
		for (const value of ['abc', 'a'.repeat(63), 'hexdocs-bundles', 'docs.bundles.1', '0-store-9']) {
			expect([value, bucketOf(value)]).toEqual([value, { bucket: value }]);
			expect(BUCKET_NAME_PATTERN.test(value)).toBe(true);
		}
	});
});

describe('entryShapeProblems', () => {
	const GOOD = {
		commit: '67a7f22c66619693ab861f82cd1cc5fb2f1788a6',
		version: '1.0.0-rc.1',
		released: '2026-04-08',
	};

	test('a well formed entry has nothing to say', () => {
		expect(entryShapeProblems(GOOD)).toEqual([]);
	});

	test('each field is named by its own sentence, and all three can be wrong at once', () => {
		const problems = entryShapeProblems({ commit: '67a7f22', version: 'v1/beta', released: 'May' });
		expect(problems).toHaveLength(3);
		expect(problems[0]).toContain('"67a7f22" is not a commit sha');
		expect(problems[0]).toContain('abbreviations are refused');
		expect(problems[1]).toContain('"v1/beta" is not a version label');
		expect(problems[2]).toContain('"May" is not a release date');
	});

	test('an upper-case sha is not a sha, because the pattern is the lower-case one', () => {
		expect(entryShapeProblems({ ...GOOD, commit: GOOD.commit.toUpperCase() })).toHaveLength(1);
	});
});

test('isoDate is the UTC date, whatever the local zone would call it', () => {
	// One minute before midnight UTC is already the next day east of Greenwich.
	expect(isoDate(new Date('2026-06-01T23:59:00Z'))).toBe('2026-06-01');
	expect(isoDate(new Date('2026-06-02T00:00:00+10:00'))).toBe('2026-06-01');
});
