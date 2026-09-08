/**
 * The public-mirror allowlist, read and edited.
 *
 * One app repository mirrors an allowlisted subset of itself to a public GitHub
 * repository, and the allowlist is the whole decision: everything the mirror withholds,
 * it withholds by being absent from that array. The copy step warns and continues on a
 * path that is missing, the prune step that runs after it matches four file names by
 * basename, and the sync then commits, tags and pushes. So one entry widened from the
 * publishable documentation root to its parent copies an internal documentation tree
 * holding export-compliance material and a device identifier to a public repository, and
 * the run prints "(nothing to prune)" on its way past.
 *
 * That is why this module exists at all, and why it is a parser rather than a pair of
 * `grep` calls. Three properties carry the weight.
 *
 * **The entry this writes is derived from `SITE_ROOT_RELATIVE`.** That constant is also
 * what `loadProject` resolves the tree it compiles against, so the dangerous edit is not
 * expressible on its own: widening it to a bare `docs` points the compiler at `docs/`
 * instead of `docs/site/`, and every project test in `kit/test/compile/` fails before
 * anything reaches a mirror. A separate string literal here could have been widened with
 * the compiler none the wiser.
 *
 * **The parser fails closed over the whole block, never over one line.** A line inside
 * the array that is not blank, not a comment and not one double-quoted path makes
 * `parseAllowPaths` return `null`. Skipping such a line would be worse than useless:
 * `    docs` unquoted is valid bash and a real bare-docs entry, and an entry no assertion
 * can see is an entry that passes every assertion. The cost is real and worth stating: a
 * valid file written in a spelling this does not know, single quotes for instance, is
 * refused rather than read. That is the safe direction, and the refusal names the shape
 * it does read.
 *
 * **A refusal and a finding say the same words.** `allowPathsRefusals` is what
 * `hexdocs init` renders as `not-run` rows before it declines to write, and
 * `allowPathsFindings` is what the `wiring-allow-paths` check reports. Both read one
 * table of messages, because the failure message is the product here: a boolean tells
 * somebody the edit did not happen, and only the message tells them that the alternative
 * ships a device identifier to a public repository.
 *
 * What this does not cover, so the guard is not trusted for more than it does. It reads
 * one array in one file at one path. A mirror script that assembled its allowlist from a
 * variable, a second array or a here-document is unreadable to it and is refused rather
 * than analysed. It says nothing about what the copy step then does with a path, and
 * nothing about the prune step: those are the mirror's own code, and the assertions here
 * are about the one line a person edits.
 */

import type { FindingLocation } from '../../../src/contracts/diagnostics.js';
import { SITE_ROOT_RELATIVE } from '../../../src/contracts/project.js';
import { raw, type RawFinding } from '../compile/types.js';

/**
 * Where the mirror script lives, relative to the app repository.
 *
 * A constant rather than a parameter so a finding's `file` and the path the caller read
 * cannot drift apart: a diagnostic naming a file nobody opened is how a check comes to
 * report on something other than what it examined.
 */
export const MIRROR_SCRIPT_RELATIVE = 'scripts/sync-public.sh';

/**
 * The documentation publish workflow, which must never be allowlisted.
 *
 * It names the bucket and the publishing role. It is kept out of the mirror by the same
 * mechanism that keeps the mirror's own workflow out, absence from this array, and that
 * mechanism is invisible: nothing fails when it stops holding.
 *
 * This has to agree with the path the source scaffold writes. If the two drift, this
 * assertion checks a file the repository does not have and reports nothing, which is why
 * `hexdocs init` cross-checks its own plan against this constant rather than trusting the
 * two to stay equal.
 */
export const PUBLISH_WORKFLOW_RELATIVE = '.github/workflows/docs-publish.yml';

/**
 * Entries that must never appear, each because the mirror script's own header says so.
 *
 * `docs/internal`, `marketing` and `design` are three of the directories that header
 * calls inviolable and protects by absence. The script itself is the fourth: publishing
 * it publishes the exact shape of what is being withheld.
 */
export const FORBIDDEN_ENTRIES: readonly string[] = [
	'docs/internal',
	'marketing',
	'design',
	MIRROR_SCRIPT_RELATIVE,
];

/**
 * The five refusals, as a closed list.
 *
 * Closed so a test can assert each one fires and that there is no sixth nobody named.
 * These are the states in which an edit to this file must not be attempted, and they are
 * deliberately not every problem the check reports. Whether the publishable root is listed
 * at all is a question about a repository, and its answer changes in the middle of an
 * `init` run, which is precisely when the edit has to be allowed to proceed.
 */
export const ALLOW_PATHS_REFUSAL_IDS = [
	'unreadable-block',
	'empty-block',
	'bare-docs',
	'forbidden-entry',
	'publish-workflow',
] as const;

export type AllowPathsRefusalId = (typeof ALLOW_PATHS_REFUSAL_IDS)[number];

export interface AllowPathsRefusal {
	readonly id: AllowPathsRefusalId;
	/** The whole reason, in prose. This is what a `not-run` row's note carries. */
	readonly why: string;
	/** 1-based, when the refusal is about one entry. */
	readonly line: number | null;
}

export interface AllowPathEntry {
	/** Exactly the characters between the quotes. */
	readonly value: string;
	/** `value` with a leading `./` and any trailing slash removed, for comparisons. */
	readonly normalised: string;
	/** The leading whitespace of the line, so an insertion matches its neighbours. */
	readonly indent: string;
	/** 1-based, as every editor counts. */
	readonly line: number;
	/** The whole source line, unmodified. */
	readonly text: string;
}

export interface AllowPathsBlock {
	readonly entries: readonly AllowPathEntry[];
	/** 1-based line of the array opener. */
	readonly openLine: number;
	/** 1-based line of the closing parenthesis. */
	readonly closeLine: number;
}

// `readonly` is optional because a repository may drop it. The opener has to end its
// line, because `ALLOW_PATHS=("a" "b")` is a shape whose entries this does not parse and a
// pattern that matched it would report an array with nothing in it.
const OPEN = /^\s*(?:readonly\s+)?ALLOW_PATHS=\(\s*$/;
const CLOSE = /^\s*\)\s*$/;
// One double-quoted path, optionally followed by a comment. Anything else inside the block
// is what makes the whole parse fail.
const ENTRY = /^([ \t]*)"([^"]*)"[ \t]*(?:#.*)?\r?$/;
const COMMENT = /^\s*#/;
const BLANK = /^\s*$/;

/** The spellings of one directory, folded so a comparison cannot miss one. */
export function normaliseEntry(value: string): string {
	const trimmed = value.trim();
	// Segment folding rather than string trimming, because the string form missed the one
	// spelling that matters. `docs/..` names the repository root to the copy step and
	// normalised to the literal `docs/..` here, so it matched no refusal, fired no finding
	// and would have been inserted beside. That is the widest possible entry arriving
	// through the arm built to refuse exactly it, and no test would have seen it: every
	// case anybody writes uses the plain spelling.
	//
	// A leading `..` is kept rather than resolved away. It escapes the repository, this
	// module has no idea what is above it, and an entry it cannot reason about must not be
	// folded into one it can: `refusals` reports the leading form on its own.
	const segments: string[] = [];
	for (const segment of trimmed.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
			else segments.push('..');
			continue;
		}
		segments.push(segment);
	}
	// The empty string is what `.`, `/`, `./` and `docs/..` all come to, and it is the
	// repository root: the widest entry there is. Folding them means one arm reports all
	// of them, which is why the arm's message says what a root entry synchronises rather
	// than quoting the spelling it was written as.
	return segments.join('/');
}

/**
 * The array, or `null` when this cannot see it.
 *
 * `null` covers three states, folded together deliberately: the opener is absent, it
 * appears more than once, or something inside the block is not a shape this reads. The
 * response to all three is to stop, and a caller that could tell them apart would be a
 * caller deciding to proceed on some of them.
 */
export function parseAllowPaths(text: string): AllowPathsBlock | null {
	const lines = text.split('\n');

	const openings: number[] = [];
	lines.forEach((line, index) => {
		if (OPEN.test(line)) openings.push(index);
	});
	const open = openings.length === 1 ? openings[0] : undefined;
	if (open === undefined) return null;

	let close = -1;
	for (let index = open + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line !== undefined && CLOSE.test(line)) {
			close = index;
			break;
		}
	}
	if (close === -1) return null;

	const entries: AllowPathEntry[] = [];
	for (let index = open + 1; index < close; index += 1) {
		const line = lines[index] ?? '';
		const match = ENTRY.exec(line);
		if (match !== null) {
			const indent = match[1] ?? '';
			const value = match[2] ?? '';
			entries.push({
				value,
				normalised: normaliseEntry(value),
				indent,
				line: index + 1,
				text: line,
			});
			continue;
		}
		if (COMMENT.test(line) || BLANK.test(line)) continue;
		// Not blank, not a comment, not one quoted path. The block is not the shape this
		// module reads, and reading the rest of it would mean reporting on an array whose
		// contents are partly invisible.
		return null;
	}

	return { entries, openLine: open + 1, closeLine: close + 1 };
}

// ---------------------------------------------------------------------------
// The messages, which are the product
// ---------------------------------------------------------------------------

const UNREADABLE_SHAPE =
	' This reads one shape: `ALLOW_PATHS=(` alone on its line, one double-quoted path per ' +
	'line, closed by `)` alone on its line, with blank lines and comments allowed between. A ' +
	'line inside the array that is none of those makes the whole block unreadable rather than ' +
	'one line skipped, because an unquoted entry is valid bash and an entry that was skipped ' +
	'is an entry no assertion here can see.';

const UNREADABLE_FOR_CHECK = `Refusing to report success on an allowlist this check cannot see.${UNREADABLE_SHAPE}`;

const UNREADABLE_FOR_EDIT = `Refusing to edit an allowlist this command cannot see.${UNREADABLE_SHAPE}`;

const EMPTY_BLOCK =
	'The allowlist array is empty, so the public mirror would receive nothing at all. It is ' +
	'not a shape a line can be added to either: an insertion is anchored on an existing entry, ' +
	'and there is none.';

/**
 * What a bare `docs` entry does, in full, on both surfaces.
 *
 * Longer than the one sentence `Finding.message` asks for, and deliberately so.
 * `renderFindings` prints the message, the remediation and the suggestion and never prints
 * `consequence`, and a `not-run` row carries a note and nothing else, so a message that
 * stopped at "this entry is too wide" would be the whole of what anybody reads about the
 * one mistake in this package that cannot be taken back.
 */
function bareDocsMessage(value: string): string {
	return (
		`The allowlist entry "${value}" copies every documentation directory to the public ` +
		'mirror, the internal one with it: an internal documentation tree holding ' +
		'export-compliance material and a device identifier travels beside the publishable ' +
		'root. Nothing downstream stops it. The prune step that runs after the copy matches ' +
		'four file names, none of which an internal documentation tree uses, so it prints ' +
		'"(nothing to prune)" and returns, and the sync then commits, tags and pushes to a ' +
		'public repository.'
	);
}

function repositoryRootMessage(value: string): string {
	return (
		`The allowlist entry "${value}" copies the whole repository to the public mirror. ` +
		'Everything this mirror withholds, it withholds by being absent from this array, so an ' +
		'entry naming the repository root withholds nothing: an internal documentation tree ' +
		'holding export-compliance material and a device identifier, the marketing and design ' +
		'directories and the mirror script itself all travel with it. The prune step that runs ' +
		'after the copy matches four file names and would print "(nothing to prune)", and the ' +
		'sync then commits, tags and pushes to a public repository.'
	);
}

/**
 * Why each of the four must not travel, as a noun phrase.
 *
 * A noun phrase rather than a sentence because it is read in two frames: an entry that is
 * one of these paths, and an entry that is a directory above one and copies it.
 */
const FORBIDDEN_REASONS: Readonly<Record<string, string>> = {
	'docs/internal':
		'the internal documentation tree, which holds export-compliance material and a device ' +
		'identifier and is kept out of the mirror by being absent from this array and by ' +
		'nothing else',
	marketing:
		"a directory the mirror script's own header calls inviolable, kept out of the mirror " +
		'by being absent from this array and by nothing else',
	design:
		"a directory the mirror script's own header calls inviolable, kept out of the mirror " +
		'by being absent from this array and by nothing else',
	[MIRROR_SCRIPT_RELATIVE]:
		'the mirror script itself, which publishes the exact shape of what is being withheld, ' +
		'meaning the allowlist, the prune names and the directories neither one mentions',
};

/**
 * A forbidden path this entry copies, or `undefined`.
 *
 * A directory prefix counts, and that is the half a comparison against the four literal
 * paths misses. `"scripts"` is not `"scripts/sync-public.sh"` and copies it, which
 * publishes the allowlist, the prune names and, by omission, the directories neither one
 * mentions. `"docs"` is caught by its own arm before this one, because that entry has a
 * message of its own.
 */
function forbiddenCovered(normalised: string): string | undefined {
	if (normalised === '') return undefined;
	return FORBIDDEN_ENTRIES.find((path) => path === normalised || path.startsWith(`${normalised}/`));
}

function forbiddenMessage(value: string, normalised: string, covered: string): string {
	const reason =
		FORBIDDEN_REASONS[covered] ??
		'a path this mirror is required to withhold, and it is withheld by being absent from ' +
			'this array and by nothing else';
	const opening =
		covered === normalised
			? `The allowlist entry "${value}" names ${reason}.`
			: `The allowlist entry "${value}" copies "${covered}" with it: ${reason}.`;
	return (
		`${opening} The prune step that runs after the copy matches four file names and would ` +
		'report nothing to prune, and the sync then commits, tags and pushes to a public ' +
		'repository.'
	);
}

function publishWorkflowMessage(value: string): string {
	return (
		`The allowlist entry "${value}" publishes the documentation publish workflow. It names ` +
		'the bucket and the publishing role, and it is withheld the same way the mirror ' +
		'workflow is, by being absent from this array. That is why workflows are listed here ' +
		'one file at a time, and a reader of the public mirror cannot run it anyway.'
	);
}

// ---------------------------------------------------------------------------
// Refusals: what makes an edit unsafe
// ---------------------------------------------------------------------------

/**
 * Every reason not to touch this file, or an empty list.
 *
 * `null` text means the repository has no mirror script, which is not a refusal and not a
 * problem: an empty list, and the caller renders a `skipped` row saying so. A repository
 * with no public mirror has nothing here to get wrong.
 *
 * These run before an edit and again inside `insertSiteRoot`, so a caller that skipped
 * this cannot write a line into a file neither of them understands.
 */
export function allowPathsRefusals(text: string | null): AllowPathsRefusal[] {
	if (text === null) return [];

	const block = parseAllowPaths(text);
	if (block === null) {
		return [{ id: 'unreadable-block', why: UNREADABLE_FOR_EDIT, line: null }];
	}
	if (block.entries.length === 0) {
		return [{ id: 'empty-block', why: EMPTY_BLOCK, line: block.openLine }];
	}

	const refusals: AllowPathsRefusal[] = [];
	for (const entry of block.entries) {
		if (entry.normalised === 'docs') {
			refusals.push({ id: 'bare-docs', why: bareDocsMessage(entry.value), line: entry.line });
			continue;
		}
		// An entry naming the repository root is the same mistake one directory wider, and it
		// costs nothing to catch here. It shares the `bare-docs` id because it is the same
		// refusal to a reader: an allowlist entry that copies what absence was withholding.
		if (entry.normalised === '') {
			refusals.push({
				id: 'bare-docs',
				why: repositoryRootMessage(entry.value),
				line: entry.line,
			});
			continue;
		}
		const covered = forbiddenCovered(entry.normalised);
		if (covered !== undefined) {
			refusals.push({
				id: 'forbidden-entry',
				why: forbiddenMessage(entry.value, entry.normalised, covered),
				line: entry.line,
			});
			continue;
		}
		// The workflow by name, and the two directory entries that would sweep it in.
		// Allowlisting `.github/workflows` whole is how a per-file allowlist stops being one,
		// and the workflows it then publishes are exactly the ones somebody left off on
		// purpose.
		if (
			entry.normalised === PUBLISH_WORKFLOW_RELATIVE ||
			entry.normalised === '.github/workflows' ||
			entry.normalised === '.github'
		) {
			refusals.push({
				id: 'publish-workflow',
				why: publishWorkflowMessage(entry.value),
				line: entry.line,
			});
		}
	}
	return refusals;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function at(line: number | null): FindingLocation {
	return line === null
		? { kind: 'file', file: MIRROR_SCRIPT_RELATIVE }
		: { kind: 'file', file: MIRROR_SCRIPT_RELATIVE, line };
}

/**
 * `wiring-allow-paths`, as raw findings.
 *
 * `text` is the mirror script, or `null` when the repository has no mirror script at all.
 * `hasSiteRoot` is whether the publishable documentation root exists on disk.
 *
 * The caller owns the row and owes it two things this cannot do for it. A `null` text is a
 * `skippedRow` carrying the reason, never a pass: a pass over a file nobody read is the
 * false green this module exists to refuse. And the row counts what it examined, which is
 * the number of entries `parseAllowPaths` returned, so an unreadable block reaches
 * `checkRow` as zero examined and fails on that as well as on the finding. Two independent
 * closures on one state, because the alternative to either is a green row over an array
 * nobody read.
 *
 * The assertions run in both directions where there are two of them. A dangerous entry has
 * one direction: it must not be there. The publishable root has two: listed with no such
 * directory on disk, which the copy step turns into one yellow warning line and a tagged
 * release with no documentation in it, and present on disk with no entry, which is a
 * mirror carrying none of the documentation source.
 */
export function allowPathsFindings(text: string | null, hasSiteRoot: boolean): RawFinding[] {
	if (text === null) return [];

	const block = parseAllowPaths(text);
	if (block === null) {
		return [
			raw('wiring-allow-paths', at(null), null, UNREADABLE_FOR_CHECK, {
				remediation:
					'Restore the array to one double-quoted path per line, or read this repository by hand and say in the commit why the shape changed.',
			}),
		];
	}
	if (block.entries.length === 0) {
		return [
			raw('wiring-allow-paths', at(block.openLine), null, EMPTY_BLOCK, {
				remediation: 'Restore the paths this repository means to publish.',
			}),
		];
	}

	const findings: RawFinding[] = [];

	for (const refusal of allowPathsRefusals(text)) {
		const entry = block.entries.find((candidate) => candidate.line === refusal.line);
		findings.push(
			raw('wiring-allow-paths', at(refusal.line), null, refusal.why, {
				remediation:
					refusal.id === 'bare-docs'
						? `Narrow the entry to "${SITE_ROOT_RELATIVE}". That is the publishable root, it is the same string the compiler resolves the tree against, and everything beside it stays out of the mirror by being absent from this array.`
						: 'Delete the entry. Nothing else in this repository withholds that path from the mirror.',
				...(refusal.id === 'bare-docs' && entry !== undefined
					? { suggestion: `${entry.indent}"${SITE_ROOT_RELATIVE}"` }
					: {}),
				...(entry === undefined ? {} : { excerpt: entry.text.trim() }),
			}),
		);
	}

	const listed = block.entries.find((entry) => entry.normalised === SITE_ROOT_RELATIVE);
	if (listed !== undefined && !hasSiteRoot) {
		findings.push(
			raw(
				'wiring-allow-paths',
				at(listed.line),
				null,
				`The allowlist names "${SITE_ROOT_RELATIVE}" and this repository has no such directory. The copy step warns and continues on a path that is missing, so this is one yellow line that scrolls past and a tagged release with no documentation in it.`,
				{
					remediation: `Run \`hexdocs init\` to create ${SITE_ROOT_RELATIVE}, or delete the entry if the documentation moved.`,
					excerpt: listed.text.trim(),
				},
			),
		);
	}
	const last = block.entries[block.entries.length - 1];
	if (listed === undefined && hasSiteRoot) {
		findings.push(
			raw(
				'wiring-allow-paths',
				at(block.closeLine),
				null,
				`This repository has a publishable documentation root at "${SITE_ROOT_RELATIVE}" and the allowlist does not name it, so the public mirror carries none of it. A path reaches that mirror by being listed here and by nothing else.`,
				{
					remediation:
						'Add the entry after "docs/public", or run `hexdocs init`, which writes exactly that line and refuses anything wider.',
					suggestion: `${last === undefined ? '    ' : last.indent}"${SITE_ROOT_RELATIVE}"`,
				},
			),
		);
	}

	return findings;
}

// ---------------------------------------------------------------------------
// The edit
// ---------------------------------------------------------------------------

/**
 * The publishable root added to the array, or `null` when this must not edit.
 *
 * `null` for every state a caller might have wanted told apart: the block is unreadable,
 * it is empty, something in it is a refusal, or the entry is already there. That is
 * deliberate. A caller distinguishes them by asking `allowPathsRefusals` and by looking
 * for the token first; this function's contract is narrower and it is the one worth
 * having, which is that it never returns text for a file it has any question about.
 *
 * The entry is written at the indent of the line it follows rather than at a hard-coded
 * four spaces. Four is right for the one repository that has this file today and wrong for
 * the next one, and an insertion that does not match its neighbours is a diff a reviewer
 * reads as a mistake.
 *
 * It goes after `"docs/public"` where that entry is present and after the last entry
 * otherwise. The array is grouped by area and unsorted inside every group, so there is no
 * collation slot to compute; the documentation group is one line long and this joins it.
 */
export function insertSiteRoot(text: string): string | null {
	const block = parseAllowPaths(text);
	if (block === null) return null;
	if (block.entries.length === 0) return null;
	if (allowPathsRefusals(text).length > 0) return null;
	// Anchored on the whole normalised entry, never a substring. `grep docs` matches
	// `"docs/public"` and would report a file already wired that is not wired at all.
	if (block.entries.some((entry) => entry.normalised === SITE_ROOT_RELATIVE)) return null;

	const anchor =
		block.entries.find((entry) => entry.normalised === 'docs/public') ??
		block.entries[block.entries.length - 1];
	if (anchor === undefined) return null;

	const lines = text.split('\n');
	// The line ending is the anchor's, so a file checked out with CRLF does not gain one
	// bare LF line in the middle of an array and a diff nobody can read.
	const terminator = anchor.text.endsWith('\r') ? '\r' : '';
	lines.splice(anchor.line, 0, `${anchor.indent}"${SITE_ROOT_RELATIVE}"${terminator}`);
	return lines.join('\n');
}

/**
 * The exact line an edit writes, for a plan a person reads before it is applied.
 *
 * The default indent is the four spaces the one repository with a mirror script uses; a
 * caller that has parsed the file passes the anchor's own indent, which is what
 * `insertSiteRoot` writes.
 */
export function siteRootLine(indent = '    '): string {
	return `${indent}"${SITE_ROOT_RELATIVE}"`;
}
