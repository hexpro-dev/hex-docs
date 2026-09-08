import { describe, expect, test } from 'vitest';

import { FOLDING_CASES, PRESERVED_INVISIBLES, type FoldingCase } from '../../fixtures/text.js';
import { INDEX_NORMALISATION } from '../../src/contracts/search.js';
import { ARABIC_FOLDS, foldArabic, foldTerm, normaliseText } from '../../src/search/normalise.js';

/**
 * Rows are looked up by id and never typed out here.
 *
 * Arabic and Japanese literals in a test file are unreviewable: nobody reading the diff
 * can tell one spelling of an alef from another, and a pasted string that lost a
 * combining mark still looks right. Reading the measured corpus instead means the
 * assertion is about the same characters the index will hold, and a renamed row fails
 * by name rather than quietly testing nothing.
 */
function row(id: string): FoldingCase {
	const found = FOLDING_CASES.find((entry) => entry.id === id);
	if (found === undefined) throw new Error(`fixtures/text.ts has no folding case "${id}".`);
	return found;
}

const ARABIC_ROW_IDS = ['arabic-alef-hamza', 'arabic-yeh', 'arabic-tatweel'];

describe('normaliseText is the form the index header records', () => {
	test('every folding case folds under normalisation exactly as the corpus measured it', () => {
		let swept = 0;
		for (const entry of FOLDING_CASES) {
			expect(normaliseText(entry.a) === normaliseText(entry.b), `${entry.id}: ${entry.why}`).toBe(
				entry.nfkc,
			);
			swept += 1;
		}
		expect(swept).toBe(FOLDING_CASES.length);
		expect(swept).toBeGreaterThan(0);
	});

	test('it is NFKC, measured against the row that chose NFKC over NFC', () => {
		// This row exists because the constant said NFKC, the comment said why, and NFC
		// would have passed every test in the repository until the pair was written down.
		const micro = row('micro-sign-vs-greek-mu');
		expect(micro.nfc).toBe(false);
		expect(micro.nfkc).toBe(true);
		expect(micro.a.normalize('NFC') === micro.b.normalize('NFC')).toBe(false);
		expect(normaliseText(micro.a)).toBe(normaliseText(micro.b));
		expect(INDEX_NORMALISATION).toBe('NFKC');
	});

	test('it leaves the invisible characters the pages depend on alone', () => {
		// Normalisation is not where these die. The tokeniser drops them from terms,
		// because a term is not displayed text; the page keeps them, because U+200F fixes
		// the visual order of a mixed-script line and U+FE0F picks the coloured glyph.
		let swept = 0;
		for (const entry of PRESERVED_INVISIBLES) {
			const character = String.fromCodePoint(entry.codePoint);
			expect(normaliseText(`ntag${character}213`), entry.name).toBe(`ntag${character}213`);
			swept += 1;
		}
		expect(swept).toBe(PRESERVED_INVISIBLES.length);
		expect(swept).toBe(2);
	});
});

describe('the Arabic table is the folding neither normalisation form does', () => {
	test('every entry folds to what it declares', () => {
		let swept = 0;
		for (const entry of ARABIC_FOLDS) {
			const character = String.fromCodePoint(entry.codePoint);
			const expected = entry.to === null ? '' : String.fromCodePoint(entry.to);
			expect(foldArabic(character), entry.name).toBe(expected);
			swept += 1;
		}
		expect(swept).toBe(ARABIC_FOLDS.length);
		expect(swept).toBe(16);
	});

	test('the table holds exactly the letters the folding claims to map', () => {
		const mapped: [number, number][] = [];
		for (const entry of ARABIC_FOLDS) {
			if (entry.to !== null) mapped.push([entry.codePoint, entry.to]);
		}
		expect(mapped).toEqual([
			// The four alef spellings a writer who omits the hamza produces.
			[0x0623, 0x0627],
			[0x0625, 0x0627],
			[0x0622, 0x0627],
			[0x0671, 0x0627],
			// Alef maksura to yeh, and teh marbuta to heh.
			[0x0649, 0x064a],
			[0x0629, 0x0647],
		]);
	});

	test('the table removes tatweel and every short-vowel mark, as a derived range', () => {
		const removed = ARABIC_FOLDS.filter((entry) => entry.to === null).map(
			(entry) => entry.codePoint,
		);
		// U+064B to U+0652 inclusive, derived rather than typed out, so a gap in the table
		// fails naming a code point rather than leaving a mark nobody notices is missing.
		const expected = [0x0640];
		for (let point = 0x064b; point <= 0x0652; point += 1) expected.push(point);
		expected.push(0x0670);
		expect([...removed].sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
	});

	test('every entry carries a name, and no two share one', () => {
		const names = ARABIC_FOLDS.map((entry) => entry.name);
		for (const name of names) expect(name.length).toBeGreaterThan(0);
		expect(new Set(names).size).toBe(names.length);
	});

	test('it closes the three pairs neither NFC nor NFKC closes', () => {
		let swept = 0;
		for (const id of ARABIC_ROW_IDS) {
			const entry = row(id);
			expect(entry.nfc, entry.id).toBe(false);
			expect(entry.nfkc, entry.id).toBe(false);
			expect(foldArabic(normaliseText(entry.a)), entry.why).toBe(
				foldArabic(normaliseText(entry.b)),
			);
			swept += 1;
		}
		expect(swept).toBe(3);
	});

	test('it leaves Arabic-Indic digits alone, because they are not the ASCII ones', () => {
		const digits = row('arabic-indic-digits');
		expect(foldArabic(normaliseText(digits.a))).not.toBe(foldArabic(normaliseText(digits.b)));
	});

	test('it leaves a word carrying none of the table alone', () => {
		// The plain spelling of the tatweel row is the folded form of the other side, so
		// folding it again has nothing to do.
		const plain = normaliseText(row('arabic-tatweel').b);
		expect(foldArabic(plain)).toBe(plain);
		expect(foldArabic('NTAG 213')).toBe('NTAG 213');
	});

	test('it is idempotent, which is what lets it run over a string and again over a term', () => {
		let swept = 0;
		for (const entry of FOLDING_CASES) {
			const once = foldArabic(normaliseText(entry.a));
			expect(foldArabic(once), entry.id).toBe(once);
			swept += 1;
		}
		expect(swept).toBe(FOLDING_CASES.length);
	});
});

describe('foldTerm is the one definition of a term spelling', () => {
	test('it lower cases', () => {
		expect(foldTerm('NTAG213')).toBe('ntag213');
		expect(foldTerm('NTAG213')).toBe(foldTerm('ntag213'));
	});

	test('it folds the Arabic spellings a reader types onto the ones an author writes', () => {
		let swept = 0;
		for (const id of ARABIC_ROW_IDS) {
			const entry = row(id);
			expect(foldTerm(normaliseText(entry.a)), entry.why).toBe(foldTerm(normaliseText(entry.b)));
			swept += 1;
		}
		expect(swept).toBe(3);
	});

	test('it is idempotent', () => {
		let swept = 0;
		for (const entry of FOLDING_CASES) {
			const once = foldTerm(normaliseText(entry.a));
			expect(foldTerm(once), entry.id).toBe(once);
			swept += 1;
		}
		expect(swept).toBe(FOLDING_CASES.length);
	});

	test('it does not normalise, because normalisation belongs to the whole input', () => {
		// The decomposed cedilla is composed on the way into the tokeniser, not here.
		// Asserting it keeps someone from moving normalisation down into the term folding,
		// where it would run per term rather than per document and would never see the
		// separators between them.
		const cedilla = row('french-cedilla-decomposed');
		expect(cedilla.nfc).toBe(true);
		expect(foldTerm(cedilla.a)).not.toBe(foldTerm(cedilla.b));
		expect(foldTerm(normaliseText(cedilla.a))).toBe(foldTerm(normaliseText(cedilla.b)));
	});
});
