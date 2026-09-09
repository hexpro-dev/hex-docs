/**
 * The public-mirror allowlist, and the five states in which nothing may be written to it.
 *
 * This is the guard between an internal documentation tree and a public GitHub
 * repository, and it is the one mistake in this package that cannot be taken back: a push
 * is a push. Everything the mirror withholds it withholds by being absent from one bash
 * array, so a single entry widened from the publishable root to its parent copies
 * export-compliance material and a device identifier out, and the run prints
 * "(nothing to prune)" on its way past.
 *
 * Three things are therefore asserted here that a boolean test would not reach.
 *
 * **The refusal set is closed in both directions.** Every id in `ALLOW_PATHS_REFUSAL_IDS`
 * is fired by a case below, and the union of the cases' ids is exactly that tuple. A
 * refusal added to the contract and not implemented fails here naming it, and an arm
 * whose body is deleted fails here naming it too. Neither direction can be satisfied by a
 * sentence saying what covers what.
 *
 * **The message is the product, so the message is asserted.** A boolean tells somebody the
 * edit did not happen. Only the words tell them that the alternative synchronises an
 * internal tree, that the prune step matches file names and would report nothing to prune,
 * and that the sync then pushes to a public repository. Those three clauses are pinned as
 * substrings rather than as a whole string, so rewording survives and deleting a clause
 * does not.
 *
 * **A refusal writes nothing.** Every refusing case asserts `insertSiteRoot` returns
 * `null` as well as asserting the refusal fired, because the two are separate code paths:
 * `insertSiteRoot` re-runs `allowPathsRefusals` itself rather than trusting its caller,
 * and a version that trusted the caller would pass a test that only checked the refusal
 * list. `kit/test/commands/init.test.ts` closes the same property from the other end, on a
 * real filesystem.
 *
 * What is deliberately not here: nothing in this file names a real device identifier, a
 * real mirror repository or a real bucket. The messages under test name the *category* of
 * what leaks, which is what makes them safe to assert on in a public repository.
 */

import { describe, expect, test } from 'vitest';

import { SITE_ROOT_RELATIVE } from '../../../src/contracts/project.js';
import {
	ALLOW_PATHS_REFUSAL_IDS,
	FORBIDDEN_ENTRIES,
	MIRROR_SCRIPT_RELATIVE,
	PUBLISH_WORKFLOW_RELATIVE,
	allowPathsFindings,
	allowPathsRefusals,
	insertSiteRoot,
	normaliseEntry,
	parseAllowPaths,
	siteRootLine,
	type AllowPathsRefusalId,
} from '../../src/source/allow-paths.js';
import { BUCKET_VARIABLE, ROLE_VARIABLE, publishWorkflow } from '../../src/templates/workflow.js';

/**
 * The allowlist of the one repository that has one, in its real shape.
 *
 * Twenty-one entries, each indented by exactly four spaces and double quoted, opened by
 * `readonly ALLOW_PATHS=(` alone on its line and closed by `)` alone on its line. Verified
 * against the real script rather than invented, and the shape is asserted below rather
 * than assumed, because the numbers are load-bearing in two places: `"docs/public"` sits
 * in the middle of the list, so the insert has to land between two existing lines rather
 * than at either end, and `.github/scripts` sits beside `.github/workflows/ci.yml`, which
 * is the pair that separates the `publish-workflow` refusal from a false positive on every
 * repository that allowlists a workflow at all.
 *
 * A fixture that drifted into a short array would still pass every refusal test below and
 * would quietly stop covering both of those.
 */
const REAL_ENTRIES: readonly string[] = [
	'app',
	'LICENSE',
	'NOTICE',
	'TERMS.md',
	'PRIVACY.md',
	'CHANGELOG.md',
	'CONTRIBUTING.md',
	'CODE_OF_CONDUCT.md',
	'SECURITY.md',
	'.swiftlint.yml',
	'.swiftformat',
	'.gitignore',
	'docs/public',
	'.github/workflows/ci.yml',
	'.github/workflows/release.yml',
	'.github/scripts',
	'.github/ISSUE_TEMPLATE',
	'.github/PULL_REQUEST_TEMPLATE.md',
	'fastlane/Fastfile',
	'fastlane/Appfile',
	'fastlane/Matchfile',
];

const INDENT = '    ';

/** The mirror script, with whatever entries a case needs, in the real surrounding shape. */
function mirror(entries: readonly string[] = REAL_ENTRIES, indent = INDENT): string {
	return [
		'#!/usr/bin/env bash',
		'set -euo pipefail',
		'',
		'# Paths copied to the public mirror. Everything else is withheld by being absent.',
		'readonly ALLOW_PATHS=(',
		...entries.map((entry) => `${indent}"${entry}"`),
		')',
		'',
		'copy_allowed_paths',
		'prune_internal_files',
		'sync_public',
		'',
	].join('\n');
}

/** The same file with one entry added, which is what most refusal cases need. */
function withEntry(entry: string): string {
	return mirror([...REAL_ENTRIES, entry]);
}

function refusalIds(text: string): AllowPathsRefusalId[] {
	return allowPathsRefusals(text).map((refusal) => refusal.id);
}

/** The one refusal a case produces, so a case that produced two fails rather than passing. */
function onlyRefusal(text: string) {
	const refusals = allowPathsRefusals(text);
	expect(refusals).toHaveLength(1);
	const refusal = refusals[0];
	if (refusal === undefined) throw new Error('allowPathsRefusals returned nothing');
	return refusal;
}

// ---------------------------------------------------------------------------
// the fixture is the shape it claims to be
// ---------------------------------------------------------------------------

describe('the fixture allowlist', () => {
	test('is the real shape: one opener, 21 four-space quoted entries, one closer', () => {
		const text = mirror();
		const lines = text.split('\n');
		const open = lines.findIndex((line) => line === 'readonly ALLOW_PATHS=(');
		const close = lines.findIndex((line, index) => index > open && line === ')');
		expect(open).toBeGreaterThanOrEqual(0);
		expect(close).toBe(open + REAL_ENTRIES.length + 1);

		const body = lines.slice(open + 1, close);
		expect(body).toHaveLength(21);
		// Read off the text rather than off `REAL_ENTRIES`, so the count and the spelling are
		// checked against the bytes the parser is handed and not against the list that built
		// them.
		for (const line of body) expect(line).toMatch(/^ {4}"[^"]*"$/);
		expect(body.filter((line) => line === `${INDENT}"docs/public"`)).toHaveLength(1);
		// In the middle, not at an end. The insert has to land between two lines.
		expect(body.indexOf(`${INDENT}"docs/public"`)).toBeGreaterThan(0);
		expect(body.indexOf(`${INDENT}"docs/public"`)).toBeLessThan(body.length - 1);
	});

	test('parses to exactly those entries, with lines and indents', () => {
		const block = parseAllowPaths(mirror());
		expect(block).not.toBeNull();
		if (block === null) return;
		expect(block.entries.map((entry) => entry.value)).toEqual([...REAL_ENTRIES]);
		expect(block.entries.every((entry) => entry.indent === INDENT)).toBe(true);
		expect(block.openLine).toBe(5);
		expect(block.closeLine).toBe(5 + REAL_ENTRIES.length + 1);
		expect(block.entries.map((entry) => entry.line)).toEqual(
			REAL_ENTRIES.map((_, index) => 6 + index),
		);
	});

	test('refuses nothing and reports nothing once the publishable root is listed', () => {
		expect(allowPathsRefusals(mirror())).toEqual([]);
		const wired = mirror([...REAL_ENTRIES, SITE_ROOT_RELATIVE]);
		expect(allowPathsFindings(wired, true)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// the five refusals, each fired on its own
// ---------------------------------------------------------------------------

/**
 * One case per refusal, claiming the ids it produces.
 *
 * The table is checked against `ALLOW_PATHS_REFUSAL_IDS` in both directions below, which
 * is what stops this from being a list of five tests that could each be deleted with the
 * suite green. `bare-docs` is claimed twice because two different entries reach it with
 * two different messages, and the messages are asserted separately.
 */
const CASES: readonly {
	name: string;
	text: string;
	produces: readonly AllowPathsRefusalId[];
}[] = [
	{
		name: 'an unquoted entry makes the whole block unreadable',
		// Valid bash, and a real bare-docs entry. Skipping the line would leave an entry no
		// assertion in this module can see, which is the entire argument for failing closed
		// over the block rather than over the line.
		text: mirror().replace(`${INDENT}"docs/public"`, `${INDENT}docs`),
		produces: ['unreadable-block'],
	},
	{
		name: 'two ALLOW_PATHS openers are unreadable, not the first one',
		text: `${mirror()}\n${mirror()}`,
		produces: ['unreadable-block'],
	},
	{
		name: 'an unclosed array is unreadable',
		text: mirror().split('\n').slice(0, 8).join('\n'),
		produces: ['unreadable-block'],
	},
	{
		name: 'an empty array publishes nothing and has nowhere to insert',
		text: mirror([]),
		produces: ['empty-block'],
	},
	{
		name: 'a bare docs entry',
		text: withEntry('docs'),
		produces: ['bare-docs'],
	},
	{
		name: 'an entry naming the repository root',
		text: withEntry('.'),
		produces: ['bare-docs'],
	},
	{
		name: 'the internal documentation tree by name',
		text: withEntry('docs/internal'),
		produces: ['forbidden-entry'],
	},
	{
		name: 'a directory that copies the mirror script with it',
		text: withEntry('scripts'),
		produces: ['forbidden-entry'],
	},
	{
		name: 'the publish workflow by name',
		text: withEntry(PUBLISH_WORKFLOW_RELATIVE),
		produces: ['publish-workflow'],
	},
	{
		name: 'the whole workflows directory',
		text: withEntry('.github/workflows'),
		produces: ['publish-workflow'],
	},
];

describe('the five refusals', () => {
	for (const entry of CASES) {
		test(`${entry.name} refuses, and writes nothing`, () => {
			expect(refusalIds(entry.text)).toEqual([...entry.produces]);
			// The second half, and it is a separate code path: `insertSiteRoot` re-runs the
			// refusals itself rather than trusting whoever called it. A version that trusted
			// its caller would pass the line above and write a line into a file nobody read.
			expect(insertSiteRoot(entry.text)).toBeNull();
		});
	}

	test('every declared refusal id is fired, and no case fires an undeclared one', () => {
		const fired = new Set(CASES.flatMap((entry) => entry.produces));
		// Both directions. One of them alone is satisfied by a single case.
		expect([...fired].sort()).toEqual([...ALLOW_PATHS_REFUSAL_IDS].sort());
		for (const id of ALLOW_PATHS_REFUSAL_IDS) expect(fired.has(id)).toBe(true);
	});

	test('every forbidden entry is refused by name, and the list is not shorter than it looks', () => {
		// Both directions over `FORBIDDEN_ENTRIES`: every declared path refuses when it is
		// listed, and the count is pinned so an entry deleted from the constant fails here
		// rather than silently stopping being withheld.
		expect(FORBIDDEN_ENTRIES).toHaveLength(4);
		for (const path of FORBIDDEN_ENTRIES) {
			expect(refusalIds(withEntry(path))).toEqual(['forbidden-entry']);
		}
		expect(FORBIDDEN_ENTRIES).toContain(MIRROR_SCRIPT_RELATIVE);
	});
});

// ---------------------------------------------------------------------------
// the messages, which are the product
// ---------------------------------------------------------------------------

describe('what a refusal says', () => {
	test('a bare docs entry names what it synchronises, the prune step and the push', () => {
		const refusal = onlyRefusal(withEntry('docs'));
		expect(refusal.id).toBe('bare-docs');
		expect(refusal.line).toBe(6 + REAL_ENTRIES.length);

		// What such an entry synchronises. Not "this entry is too wide": the reader has to be
		// told that the internal tree travels beside the publishable one and what is in it.
		expect(refusal.why).toContain('"docs"');
		expect(refusal.why).toContain('every documentation directory');
		expect(refusal.why).toContain('internal');
		expect(refusal.why).toContain('export-compliance');
		expect(refusal.why).toContain('device identifier');

		// That the prune step matches file names and would report nothing to prune. This is
		// the clause that stops somebody assuming a later step catches it.
		expect(refusal.why).toContain('prune');
		expect(refusal.why).toContain('file names');
		expect(refusal.why).toContain('nothing to prune');

		// And that the sync then pushes to a public repository, which is the consequence.
		expect(refusal.why).toContain('public repository');
		expect(refusal.why).toMatch(/commits, tags and pushes/);
	});

	test('an entry naming the repository root says it withholds nothing', () => {
		for (const spelling of ['.', '/', './', '']) {
			const refusal = onlyRefusal(withEntry(spelling));
			expect(refusal.id).toBe('bare-docs');
			expect(refusal.why).toContain('the whole repository');
			expect(refusal.why).toContain('withholds nothing');
			expect(refusal.why).toContain('device identifier');
			expect(refusal.why).toContain('nothing to prune');
			expect(refusal.why).toContain('public repository');
		}
	});

	/**
	 * The spelling of the widest possible entry that the string form of this function
	 * missed.
	 *
	 * `normaliseEntry` used to fold `./`, a trailing slash, `.`, `/` and the empty string
	 * by trimming the string, and `docs/..` survived that untouched: it names the
	 * repository root to the copy step and read here as an ordinary two-segment path, so
	 * no refusal fired and the insert proceeded beside it. Nobody would have found it from
	 * the cases people write, because every case people write uses the plain spelling.
	 *
	 * It now folds by segment, so every spelling of the root reaches the same arm. The
	 * assertions below are the ones that were failing.
	 */
	test('a parent-directory segment resolves, so it cannot smuggle the root past the arm', () => {
		expect(normaliseEntry('docs/../')).toBe('');
		expect(normaliseEntry('docs/site/..')).toBe('docs');
		expect(normaliseEntry('a/b/../../c')).toBe('c');
		const refusal = onlyRefusal(withEntry('docs/..'));
		expect(refusal.id).toBe('bare-docs');
		expect(refusal.why).toContain('the whole repository');
	});

	test('a leading parent segment is kept rather than resolved away', () => {
		// It escapes the repository and this module has no idea what is above it, so it
		// must not be folded into an entry it can reason about. Keeping it means the arm
		// reports the spelling it was actually given.
		expect(normaliseEntry('../secrets')).toBe('../secrets');
		expect(normaliseEntry('../../x')).toBe('../../x');
	});

	test('the internal tree is the one message that has to carry the leak', () => {
		// The one check that can leak a device identifier. The message is the product here:
		// a reader who sees only "delete this entry" has no way to know what was at stake.
		const refusal = onlyRefusal(withEntry('docs/internal'));
		expect(refusal.id).toBe('forbidden-entry');
		expect(refusal.why).toContain('export-compliance');
		expect(refusal.why).toContain('device identifier');
		expect(refusal.why).toContain('absent from this array');
		expect(refusal.why).toContain('nothing to prune');
		expect(refusal.why).toContain('public repository');
	});

	test('a directory prefix says which forbidden path it copies, not just that it is wide', () => {
		const refusal = onlyRefusal(withEntry('scripts'));
		expect(refusal.why).toContain('"scripts"');
		expect(refusal.why).toContain(`copies "${MIRROR_SCRIPT_RELATIVE}" with it`);
		expect(refusal.why).toContain('the exact shape of what is being withheld');
	});

	test('the publish workflow message gives the reason the file can be checked against', () => {
		// It used to say the file names the bucket and the role. It does not: both are
		// `vars.` reads, which is the entire purpose of them being repository variables, so
		// an operator checking that sentence against the file would find no identifier and
		// conclude the exclusion was written for a version that no longer exists. What the
		// file publishes is the shape of the estate, and the message says so now. This is
		// the copy an operator actually reads, which is why it is asserted here rather than
		// left to the module header.
		for (const entry of [PUBLISH_WORKFLOW_RELATIVE, '.github/workflows', '.github']) {
			const refusal = onlyRefusal(withEntry(entry));
			expect(refusal.id).toBe('publish-workflow');
			expect(refusal.why).toContain('carries neither the bucket nor the role');
			expect(refusal.why).toContain('shape of the estate');
			expect(refusal.why).toContain('absent from this array');
		}
	});

	test('no refusal message claims the generated workflow carries an identifier', () => {
		// The generator and this message are the pair: if `publishWorkflow` ever inlined a
		// literal, the sentence above would become true and this test would be the one that
		// has to change with it. Asserted against the rendered file rather than against the
		// template source, because a literal could arrive through either.
		const rendered = publishWorkflow({
			kitMount: 'hex-docs',
			region: 'ap-southeast-2',
			out: '.hexdocs-bundle',
		});
		expect(rendered).not.toMatch(/arn:aws/);
		expect(rendered).not.toMatch(/(?<![0-9a-fA-F])[0-9]{12}(?![0-9a-fA-F])/);
		for (const name of [ROLE_VARIABLE, BUCKET_VARIABLE]) {
			expect(rendered).toContain(`\${{ vars.${name} }}`);
		}
	});

	test('an unreadable block says which shape it does read', () => {
		const refusal = onlyRefusal(mirror().replace(`${INDENT}"docs/public"`, `${INDENT}docs`));
		expect(refusal.id).toBe('unreadable-block');
		expect(refusal.line).toBeNull();
		expect(refusal.why).toContain('ALLOW_PATHS=(');
		expect(refusal.why).toContain('one double-quoted path per line');
		expect(refusal.why).toContain('unquoted entry is valid bash');
	});

	test('an empty block says why a line cannot simply be added to it', () => {
		const refusal = onlyRefusal(mirror([]));
		expect(refusal.id).toBe('empty-block');
		expect(refusal.line).toBe(5);
		expect(refusal.why).toContain('nothing at all');
		expect(refusal.why).toContain('anchored on an existing entry');
	});
});

// ---------------------------------------------------------------------------
// entries a naive comparison gets wrong
// ---------------------------------------------------------------------------

describe('what counts as which entry', () => {
	test('normaliseEntry folds the spellings of one directory, and only those', () => {
		expect(normaliseEntry(SITE_ROOT_RELATIVE)).toBe(SITE_ROOT_RELATIVE);
		expect(normaliseEntry(`./${SITE_ROOT_RELATIVE}`)).toBe(SITE_ROOT_RELATIVE);
		expect(normaliseEntry(`${SITE_ROOT_RELATIVE}/`)).toBe(SITE_ROOT_RELATIVE);
		expect(normaliseEntry(`  ./${SITE_ROOT_RELATIVE}//  `)).toBe(SITE_ROOT_RELATIVE);
		for (const root of ['.', '/', '', './', './.']) expect(normaliseEntry(root)).toBe('');
		// And does not fold two different directories together.
		expect(normaliseEntry('docs/public')).toBe('docs/public');
		expect(normaliseEntry('docs/sitemap')).toBe('docs/sitemap');
	});

	test('a file holding "docs/public" and not the publishable root is not already wired', () => {
		const text = mirror();
		// A naive search would say yes. `grep docs` matches `"docs/public"`, and so does any
		// substring test, so the check has to be an anchored comparison on the whole
		// normalised entry or every repository with a documentation entry reads as wired.
		expect(text).toContain('docs');
		expect(text).toContain('docs/public');
		expect(text).not.toContain(`"${SITE_ROOT_RELATIVE}"`);

		const block = parseAllowPaths(text);
		expect(block?.entries.some((entry) => entry.normalised === SITE_ROOT_RELATIVE)).toBe(false);
		// So an edit is produced rather than declined as already present.
		expect(insertSiteRoot(text)).not.toBeNull();
	});

	test('an entry the publishable root is a prefix of is not the publishable root', () => {
		const text = mirror([...REAL_ENTRIES, `${SITE_ROOT_RELATIVE}map`]);
		expect(insertSiteRoot(text)).not.toBeNull();
	});

	test('the publishable root already present, in any spelling, declines the edit', () => {
		for (const spelling of [
			SITE_ROOT_RELATIVE,
			`./${SITE_ROOT_RELATIVE}`,
			`${SITE_ROOT_RELATIVE}/`,
		]) {
			expect(insertSiteRoot(mirror([...REAL_ENTRIES, spelling]))).toBeNull();
		}
	});

	test('a workflow that is not the publish workflow is left alone', () => {
		// The other direction of the `publish-workflow` arm. A rule that refused every
		// `.github` entry would refuse the two workflows and the two template directories
		// that are in the real allowlist on purpose, which is a guard that fires on every
		// repository and is therefore turned off.
		for (const entry of [
			'.github/workflows/ci.yml',
			'.github/workflows/release.yml',
			'.github/scripts',
			'.github/ISSUE_TEMPLATE',
		]) {
			expect(refusalIds(mirror([entry]))).toEqual([]);
		}
	});
});

// ---------------------------------------------------------------------------
// the insert
// ---------------------------------------------------------------------------

describe('inserting the publishable root', () => {
	test('lands on the line after "docs/public", four spaces and double quoted', () => {
		const before = mirror();
		const after = insertSiteRoot(before);
		expect(after).not.toBeNull();
		if (after === null) return;

		const lines = after.split('\n');
		const anchorIndex = lines.indexOf(`${INDENT}"docs/public"`);
		expect(anchorIndex).toBeGreaterThan(0);
		expect(lines[anchorIndex + 1]).toBe(`${INDENT}"${SITE_ROOT_RELATIVE}"`);
		// Exactly four spaces and a double-quoted value, asserted off the written line rather
		// than off the constant that produced it.
		expect(lines[anchorIndex + 1]).toMatch(/^ {4}"[a-z]+\/[a-z]+"$/);

		// One line added and nothing else touched.
		expect(lines).toHaveLength(before.split('\n').length + 1);
		expect(lines.filter((line, index) => index !== anchorIndex + 1).join('\n')).toBe(before);
	});

	test('re-parsing the edited file yields the original entries plus exactly one', () => {
		const after = insertSiteRoot(mirror());
		expect(after).not.toBeNull();
		if (after === null) return;
		const block = parseAllowPaths(after);
		expect(block).not.toBeNull();
		if (block === null) return;

		const values = block.entries.map((entry) => entry.value);
		expect(values).toHaveLength(REAL_ENTRIES.length + 1);
		// The original list survives in its original order, and the one addition is the
		// publishable root. Both directions: nothing removed, nothing else added.
		expect(values.filter((value) => value !== SITE_ROOT_RELATIVE)).toEqual([...REAL_ENTRIES]);
		expect(values.filter((value) => value === SITE_ROOT_RELATIVE)).toEqual([SITE_ROOT_RELATIVE]);
		// And the edited file is now the already-wired state, so a second run writes nothing.
		expect(insertSiteRoot(after)).toBeNull();
	});

	test('takes the anchor indent rather than a hard-coded four spaces', () => {
		const after = insertSiteRoot(mirror(REAL_ENTRIES, '\t\t'));
		expect(after).not.toBeNull();
		expect(after).toContain(`\n\t\t"${SITE_ROOT_RELATIVE}"\n`);
		expect(after).not.toContain(`\n${INDENT}"${SITE_ROOT_RELATIVE}"\n`);
	});

	test('falls back to the last entry where there is no "docs/public"', () => {
		const entries = REAL_ENTRIES.filter((entry) => entry !== 'docs/public');
		const after = insertSiteRoot(mirror(entries));
		expect(after).not.toBeNull();
		if (after === null) return;
		const lines = after.split('\n');
		const last = lines.indexOf(`${INDENT}"${entries[entries.length - 1] as string}"`);
		expect(lines[last + 1]).toBe(`${INDENT}"${SITE_ROOT_RELATIVE}"`);
		// Still inside the array.
		expect(lines[last + 2]).toBe(')');
	});

	test('a CRLF file gains a CRLF line, not one bare LF in the middle of the array', () => {
		const before = mirror().split('\n').join('\r\n');
		const after = insertSiteRoot(before);
		expect(after).not.toBeNull();
		if (after === null) return;
		expect(after).toContain(`\r\n${INDENT}"${SITE_ROOT_RELATIVE}"\r\n`);
		expect(
			after
				.split('\n')
				.every((line, index, all) => index === all.length - 1 || line.endsWith('\r')),
		).toBe(true);
	});

	test('siteRootLine is the same line, at the indent it is given', () => {
		expect(siteRootLine()).toBe(`${INDENT}"${SITE_ROOT_RELATIVE}"`);
		expect(siteRootLine('\t')).toBe(`\t"${SITE_ROOT_RELATIVE}"`);
	});
});

// ---------------------------------------------------------------------------
// the check, which reports rather than edits
// ---------------------------------------------------------------------------

describe('wiring-allow-paths findings', () => {
	test('a repository with no mirror script has nothing to report', () => {
		// `null` is "there is no public mirror", which is neither a problem nor a pass. The
		// caller owes it a skipped row; this returns no findings rather than a false green.
		expect(allowPathsFindings(null, true)).toEqual([]);
		expect(allowPathsFindings(null, false)).toEqual([]);
	});

	test('every refusal reaches the check with the same words', () => {
		// One table of messages, two surfaces. A refusal whose finding said something milder
		// than the not-run row would mean the check that runs on every build reported the
		// leak less clearly than the command that refuses to make it.
		//
		// `unreadable-block` is the one pair that differs, and only in its opening clause:
		// the refusal says it will not edit and the check says it will not report success.
		// The paragraph describing the shape this module reads is shared, and that is the
		// half a reader acts on, so it is what is compared for that id.
		const SHAPE = 'one double-quoted path per line';
		for (const entry of CASES) {
			const refusals = allowPathsRefusals(entry.text);
			const findings = allowPathsFindings(entry.text, true);
			expect(findings.length).toBeGreaterThanOrEqual(refusals.length);
			for (const refusal of refusals) {
				const same = findings.some((finding) => finding.message === refusal.why);
				if (refusal.id === 'unreadable-block') {
					expect(refusal.why).toContain(SHAPE);
					expect(findings.some((finding) => finding.message.includes(SHAPE))).toBe(true);
					continue;
				}
				expect(same).toBe(true);
			}
			expect(findings.every((finding) => finding.rule === 'wiring-allow-paths')).toBe(true);
			for (const finding of findings) {
				expect(finding.location).toMatchObject({ kind: 'file', file: MIRROR_SCRIPT_RELATIVE });
			}
		}
	});

	test('a bare docs entry suggests the exact narrower line, at the entry indent', () => {
		const findings = allowPathsFindings(withEntry('docs'), true);
		const bare = findings.find((finding) =>
			finding.message.includes('every documentation directory'),
		);
		expect(bare).toBeDefined();
		expect(bare?.suggestion).toBe(`${INDENT}"${SITE_ROOT_RELATIVE}"`);
		expect(bare?.remediation).toContain(`Narrow the entry to "${SITE_ROOT_RELATIVE}"`);
		expect(bare?.excerpt).toBe('"docs"');
	});

	test('listed with no such directory is one finding, and it names the silent failure', () => {
		const findings = allowPathsFindings(mirror([...REAL_ENTRIES, SITE_ROOT_RELATIVE]), false);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.message).toContain('no such directory');
		expect(findings[0]?.message).toContain('warns and continues');
		expect(findings[0]?.message).toContain('tagged release with no documentation in it');
	});

	test('present on disk with no entry is one finding, and it suggests the line to add', () => {
		const findings = allowPathsFindings(mirror(), true);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.message).toContain('the public mirror carries none of it');
		expect(findings[0]?.suggestion).toBe(`${INDENT}"${SITE_ROOT_RELATIVE}"`);
		// Anchored at the closing parenthesis, which is where the line would go.
		expect(findings[0]?.location).toMatchObject({
			kind: 'file',
			file: MIRROR_SCRIPT_RELATIVE,
			line: 5 + REAL_ENTRIES.length + 1,
		});
	});

	test('neither listed nor on disk is silence, which is the fourth corner', () => {
		// The both-directions pairing in full: listed and present is clean, listed and absent
		// reports, absent and present reports, absent and absent is a repository that has no
		// documentation yet and nothing to say about it.
		expect(allowPathsFindings(mirror(), false)).toEqual([]);
	});
});
