/**
 * The failure catalogue in `kit/src/README.md`, held to its fourth column.
 *
 * The table's whole argument is that a guard whose failure has never been observed is a
 * guard nobody has tested, so every row names the test that proves it and the mutation
 * that must turn that test red. A row can be weakened in two directions and neither one
 * shows up anywhere else: the row can be deleted, and the test it names can be renamed or
 * removed while the row goes on claiming it exists.
 *
 * **The honest limit, and it is a real one.** This proves the named file is on disk and
 * that every column of every row says something. It does not prove the file tests what the
 * row says it tests, and nothing in this repository does: that claim is closed one row at
 * a time by the mutation in the fifth column, run by hand. What this refuses is the
 * cheaper failure, a catalogue that points at nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CATALOGUE = join(REPO_ROOT, 'kit', 'src', 'README.md');

interface Row {
	/** The `#` column, as written. */
	readonly number: string;
	readonly failure: string;
	readonly structure: string;
	readonly provingTest: string;
	readonly mutation: string;
	/** Where the row is in the file, so a failure names a line rather than an index. */
	readonly line: number;
}

/**
 * The one table in the file whose first column is `#`, read as rows.
 *
 * Located by its header rather than by position, because a second table added above it
 * would silently shift a positional reader onto the wrong one and every assertion below
 * would then be about the exit-code table.
 */
function readCatalogue(): Row[] {
	const lines = readFileSync(CATALOGUE, 'utf8').split('\n');
	const cells = (line: string): string[] =>
		line
			.replace(/^\s*\|/, '')
			.replace(/\|\s*$/, '')
			.split('|')
			.map((cell) => cell.trim());

	const header = lines.findIndex(
		(line) => line.trimStart().startsWith('|') && cells(line)[0] === '#',
	);
	if (header === -1) throw new Error(`${CATALOGUE} has no table whose first column is "#".`);

	const rows: Row[] = [];
	for (let at = header + 2; at < lines.length; at += 1) {
		const line = lines[at] as string;
		if (!line.trimStart().startsWith('|')) break;
		const columns = cells(line);
		rows.push({
			number: columns[0] ?? '',
			failure: columns[1] ?? '',
			structure: columns[2] ?? '',
			provingTest: columns[3] ?? '',
			mutation: columns[4] ?? '',
			line: at + 1,
		});
	}
	return rows;
}

const ROWS = readCatalogue();

/** Every backticked path in a cell. A row may name more than one proving test. */
function pathsIn(cell: string): string[] {
	return [...cell.matchAll(/`([^`]+)`/g)]
		.map((match) => match[1] as string)
		.filter((text) => text.includes('/') && text.endsWith('.ts'));
}

describe('the table itself', () => {
	test('there are rows to check, and they are numbered 1 upwards with no gap', () => {
		// A reader who deletes a row rather than a whole guard leaves the numbering with a
		// hole in it, which is the cheapest possible signal and the one worth having.
		expect(ROWS.length).toBeGreaterThan(0);
		expect(ROWS.map((row) => row.number)).toEqual(ROWS.map((_row, index) => String(index + 1)));
	});

	test('every column of every row says something', () => {
		const empty: string[] = [];
		for (const row of ROWS) {
			for (const [column, text] of Object.entries({
				failure: row.failure,
				structure: row.structure,
				'proving test': row.provingTest,
				mutation: row.mutation,
			})) {
				// A blank fourth column is the failure this file is named after, and a blank
				// fifth is the same failure one step later: a mutation nobody wrote down is a
				// mutation nobody ran.
				if (text === '') empty.push(`row ${row.number} (line ${row.line}): ${column} is empty`);
			}
		}
		expect(empty).toEqual([]);
	});

	test('every row names at least one test file', () => {
		const nameless = ROWS.filter((row) => pathsIn(row.provingTest).length === 0).map(
			(row) => `row ${row.number} (line ${row.line}): ${row.provingTest}`,
		);
		expect(nameless, 'the proving test column carries no backticked .ts path').toEqual([]);
	});
});

describe('every named proving test exists', () => {
	const claims = ROWS.flatMap((row) => pathsIn(row.provingTest).map((path) => ({ row, path })));

	test('the claims were actually collected, or the sweep below proves nothing', () => {
		expect(claims.length).toBeGreaterThanOrEqual(ROWS.length);
	});

	test.each(claims.map((claim) => [`row ${claim.row.number}: ${claim.path}`, claim] as const))(
		'%s',
		(_name, claim) => {
			expect(
				existsSync(join(REPO_ROOT, claim.path)),
				`kit/src/README.md line ${claim.row.line} names ${claim.path}, which is not on disk. Either the test was renamed and the row was not, or the guard lost its proof.`,
			).toBe(true);
		},
	);
});
