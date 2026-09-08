import { describe, expect, test } from 'vitest';

import {
	FOLDING_CASES,
	PRESERVED_INVISIBLES,
	TOKENISER_INPUTS,
	type FoldingCase,
	type TokeniserInput,
} from '../../fixtures/text.js';
import { LOCALES, type Locale } from '../../src/contracts/locales.js';
import { countWords, tokenise, tokeniseQuery } from '../../src/search/tokenise.js';

/**
 * The rows neither normalisation form closes, split by whether the tokeniser closes
 * them.
 *
 * This is the line between normalisation and the tokeniser, and it is the reason the
 * Arabic table exists at all. Cross-checked against `FOLDING_CASES` in both directions
 * below, so a new `nfkc: false` row has to be classified here rather than joining the
 * sweep as "distinct" by default, which is how a pair that should fold ends up
 * asserting that it does not.
 */
const FOLDED_BY_THE_TOKENISER = new Set(['arabic-alef-hamza', 'arabic-yeh', 'arabic-tatweel']);

const LEFT_DISTINCT = new Set(['arabic-indic-digits']);

/** Fails by name, so a renamed fixture row is a failure rather than a silent skip. */
function row(id: string): FoldingCase {
	const found = FOLDING_CASES.find((entry) => entry.id === id);
	if (found === undefined) throw new Error(`fixtures/text.ts has no folding case "${id}".`);
	return found;
}

function input(locale: Locale): TokeniserInput {
	const found = TOKENISER_INPUTS.find((entry) => entry.locale === locale);
	if (found === undefined)
		throw new Error(`fixtures/text.ts has no tokeniser input for ${locale}.`);
	return found;
}

/**
 * The locales whose fixture sentence is separated by spaces.
 *
 * Declared rather than detected, because detecting it would mean writing the script
 * classifier a second time and asserting that it agrees with itself. Checked against
 * `LOCALES` in both directions, so an eighth language cannot arrive unclassified.
 */
const SPACE_SEPARATED: Locale[] = ['en', 'fr', 'es', 'pt-BR', 'ar'];
const RUN_TOGETHER: Locale[] = ['zh', 'ja'];

describe('the tokeniser does the folding normalisation does not', () => {
	test('the two classifications cover every row neither form folds, in both directions', () => {
		const unfolded = FOLDING_CASES.filter((entry) => !entry.nfkc).map((entry) => entry.id);
		const classified = [...FOLDED_BY_THE_TOKENISER, ...LEFT_DISTINCT];
		expect([...classified].sort()).toEqual([...unfolded].sort());
		expect(classified.length).toBe(new Set(classified).size);
		expect(unfolded.length).toBeGreaterThan(0);
	});

	test('every folding case tokenises the way the row and the classification predict', () => {
		let swept = 0;
		for (const entry of FOLDING_CASES) {
			// Derived from the row: normalisation folds it, or the tokeniser does.
			const expected = entry.nfkc || FOLDED_BY_THE_TOKENISER.has(entry.id);
			const message = `${entry.id}: ${entry.why}`;
			if (expected) expect(tokenise(entry.a), message).toEqual(tokenise(entry.b));
			else expect(tokenise(entry.a), message).not.toEqual(tokenise(entry.b));
			swept += 1;
		}
		expect(swept).toBe(FOLDING_CASES.length);
		expect(swept).toBeGreaterThan(0);
	});

	test('the three Arabic pairs tokenise identically although neither form folds them', () => {
		let swept = 0;
		for (const id of FOLDED_BY_THE_TOKENISER) {
			const entry = row(id);
			expect(entry.nfc, entry.id).toBe(false);
			expect(entry.nfkc, entry.id).toBe(false);
			expect(tokenise(entry.a), entry.why).toEqual(tokenise(entry.b));
			swept += 1;
		}
		expect(swept).toBe(3);
	});

	test('Arabic-Indic digits stay distinct from ASCII digits', () => {
		// The other half of the same line. NFKC leaves these alone, which is correct, and
		// a fold here would be the tokeniser deciding that one script's digits are another
		// script's digits. The row is false in both columns for the opposite reason to the
		// three above.
		const digits = row('arabic-indic-digits');
		expect(digits.nfkc).toBe(false);
		expect(tokenise(digits.a)).not.toEqual(tokenise(digits.b));
		expect(tokenise(digits.a)).toHaveLength(1);
	});
});

describe('the corpus sentences tokenise the same however they were composed', () => {
	test('every input tokenises identically from its decomposed spelling', () => {
		const covered = new Set<Locale>();
		for (const entry of TOKENISER_INPUTS) {
			expect(tokenise(entry.text), `${entry.locale}: ${entry.why}`).toEqual(
				tokenise(entry.text.normalize('NFD')),
			);
			// A row that produced nothing would satisfy the comparison above and say
			// nothing at all.
			expect(tokenise(entry.text).length, entry.locale).toBeGreaterThan(0);
			covered.add(entry.locale);
		}
		expect([...covered].sort()).toEqual([...LOCALES].sort());
		expect(covered.size).toBe(7);
	});

	test('the space-separated locales are exactly the ones that are not CJK', () => {
		expect([...SPACE_SEPARATED, ...RUN_TOGETHER].sort()).toEqual([...LOCALES].sort());
	});

	test('a space-separated sentence gives one term per word', () => {
		let swept = 0;
		for (const locale of SPACE_SEPARATED) {
			const entry = input(locale);
			// Derived from the sentence rather than counted by hand. The Arabic row is the
			// one that matters: it carries a shadda inside its first word, and a tokeniser
			// that treated combining marks as separators would return one term more than
			// there are words and no assertion about Latin would notice.
			expect(tokenise(entry.text), entry.why).toHaveLength(entry.text.split(' ').length);
			swept += 1;
		}
		expect(swept).toBe(SPACE_SEPARATED.length);
	});
});

describe('CJK runs emit overlapping bigrams', () => {
	test('the Chinese sentence gives bigrams, not single characters', () => {
		// The regression the plan names. A tokeniser that stops emitting bigrams passes
		// every Latin assertion in this file and makes Chinese search return nothing, and
		// the only visible symptom is an index that got smaller.
		const entry = input('zh');
		const characters = [...entry.text];
		const terms = tokenise(entry.text);
		expect(terms).toHaveLength(characters.length - 1);
		for (const term of terms) expect([...term]).toHaveLength(2);
		expect(terms[0]).toBe(characters.slice(0, 2).join(''));
		expect(terms[1]).toBe(characters.slice(1, 3).join(''));
	});

	test('a run of one character is that character', () => {
		// U+4E2D, a common one-character heading. Dropping it would make the heading
		// unsearchable, and there is nothing else a one-character run can contribute.
		expect(tokenise('中')).toEqual(['中']);
	});

	test('Han and Hiragana are one run, not two', () => {
		// U+8AAD U+307F, a kanji followed by the kana that inflects it. Classified per
		// script rather than per run, this would be two single-character runs and the
		// bigram that spans them would never exist.
		expect(tokenise('読み')).toEqual(['読み']);
	});

	test('a Latin word inside a Japanese sentence is its own term', () => {
		const entry = input('ja');
		const terms = tokenise(entry.text);
		expect(terms).toContain('iphone');
		// Nothing merged the Latin run into a bigram with the kana on either side of it.
		for (const term of terms) {
			if (term === 'iphone') continue;
			expect(term).not.toContain('i');
		}
	});

	test('the prolonged sound mark keeps a katakana word in one run', () => {
		// Measured, not assumed: U+30FC is Script=Common and Script_Extensions=Katakana.
		expect(/\p{sc=Katakana}/u.test('ー')).toBe(false);
		expect(/\p{scx=Katakana}/u.test('ー')).toBe(true);
		// U+30B3 U+30FC U+30D2 U+30FC. Under `sc` this is two runs of one character and a
		// separator between them, so the word contributes two single characters instead of
		// three bigrams.
		expect(tokenise('コーヒー')).toEqual(['コー', 'ーヒ', 'ヒー']);
	});
});

describe('word runs, separators and the characters that are neither', () => {
	test('duplicates are kept and order is preserved, because the builder counts them', () => {
		expect(tokenise('Tag tag ntag')).toEqual(['tag', 'tag', 'ntag']);
	});

	test('the underscore is a word character', () => {
		expect(tokenise('read_tag')).toEqual(['read_tag']);
	});

	test('digits are terms', () => {
		expect(tokenise('NTAG 213')).toEqual(['ntag', '213']);
	});

	test('punctuation and whitespace emit nothing', () => {
		expect(tokenise('!!! ,,, --- ...')).toEqual([]);
		expect(tokenise('')).toEqual([]);
	});

	test('CJK punctuation ends a run rather than joining it', () => {
		// This test used to exist in ASCII only, and that is exactly why the hole survived.
		// `classify` tested Script_Extensions alone for its CJK arm, and Script_Extensions
		// is not a letter test: the ideographic full stop, the ideographic comma, both
		// corner brackets and the katakana middle dot all carry Han or Kana in their scx set
		// and none is a letter. So each joined the run beside it and formed bigrams with the
		// characters either side. 127 of 2709 Chinese terms and 221 of 3048 Japanese terms
		// in the built corpus were such bigrams, each rare enough to carry a high idf, and
		// `countWords` counted them.
		const cases: readonly { text: string; terms: string[]; why: string }[] = [
			{ text: 'iPhone\u3002', terms: ['iphone'], why: 'a full stop after a Latin word' },
			{
				text: '\u626b\u63cf\u6807\u7b7e\u3002\u7136\u540e',
				terms: ['\u626b\u63cf', '\u63cf\u6807', '\u6807\u7b7e', '\u7136\u540e'],
				why: 'two Chinese sentences, with no bigram straddling the full stop',
			},
			{
				text: '\u300c\u30bf\u30b0\u300d\u3092\u8aad\u3080',
				terms: ['\u30bf\u30b0', '\u3092\u8aad', '\u8aad\u3080'],
				why: 'corner brackets around a Japanese term',
			},
			{
				text: '\u30b9\u30ad\u30e3\u30f3\u30fb\u30bf\u30b0',
				terms: ['\u30b9\u30ad', '\u30ad\u30e3', '\u30e3\u30f3', '\u30bf\u30b0'],
				why: 'a katakana middle dot between two words',
			},
		];
		let swept = 0;
		for (const entry of cases) {
			expect(tokenise(entry.text), entry.why).toEqual(entry.terms);
			swept += 1;
		}
		expect(swept).toBe(cases.length);

		// And the character the CJK arm was written for still joins its run. U+30FC is
		// Script=Common with Kana script extensions and it is `\p{L}`, so intersecting the
		// arm with the word-character table left it alone. Without it an ordinary katakana
		// word carrying one splits into two runs and Japanese search quietly gets worse.
		expect(tokenise('\u30c7\u30fc\u30bf\u30fc\u30d9\u30fc\u30b9')).toEqual([
			'\u30c7\u30fc',
			'\u30fc\u30bf',
			'\u30bf\u30fc',
			'\u30fc\u30d9',
			'\u30d9\u30fc',
			'\u30fc\u30b9',
		]);
	});

	test('CJK punctuation is not counted as a word', () => {
		// The other half. `countWords` reads the same classification, so the same characters
		// inflated every reading estimate in two languages: the Japanese guide measured 1739
		// words against 1624, nearly seven per cent.
		expect(countWords('\u3002\u3001\u3002\u3001')).toBe(0);
		expect(countWords('... ,,,')).toBe(0);
	});

	test('the invisible characters a page depends on are separators to the tokeniser', () => {
		// Tokeniser input only. Both of these are load-bearing in displayed text, which is
		// never normalised and never tokenised: U+200F fixes the visual order of a line
		// mixing Arabic with a Latin product name, and U+FE0F selects the coloured glyph in
		// the support matrix. Inside a term they would be a spelling nobody can type.
		let swept = 0;
		for (const entry of PRESERVED_INVISIBLES) {
			const character = String.fromCodePoint(entry.codePoint);
			expect(tokenise(`ntag${character}213`), entry.name).toEqual(['ntag', '213']);
			expect(tokenise(character), entry.name).toEqual([]);
			swept += 1;
		}
		expect(swept).toBe(PRESERVED_INVISIBLES.length);
		expect(swept).toBe(2);
	});

	test('tokeniseQuery is the same function, so the two sides cannot drift', () => {
		let swept = 0;
		for (const entry of TOKENISER_INPUTS) {
			expect(tokeniseQuery(entry.text), entry.locale).toEqual(tokenise(entry.text));
			swept += 1;
		}
		expect(swept).toBe(TOKENISER_INPUTS.length);
		expect(tokeniseQuery('NTAG 213')).toEqual(['ntag', '213']);
	});
});

describe('countWords is an estimate whose only contract is stability', () => {
	test('a run of word characters is one word', () => {
		const entry = input('en');
		expect(countWords(entry.text)).toBe(entry.text.split(' ').length);
		expect(countWords(entry.text)).toBe(6);
	});

	test('each CJK character is one word', () => {
		const entry = input('zh');
		expect(countWords(entry.text)).toBe([...entry.text].length);
	});

	test('a mixed sentence counts the Latin run once and every CJK character', () => {
		const entry = input('ja');
		// Derived: the sentence is one Latin word and the rest CJK characters.
		expect(countWords(entry.text)).toBe([...entry.text].length - 'iPhone'.length + 1);
	});

	test('the count does not depend on how the source file was composed', () => {
		let swept = 0;
		for (const entry of TOKENISER_INPUTS) {
			expect(countWords(entry.text), entry.locale).toBe(countWords(entry.text.normalize('NFD')));
			expect(countWords(entry.text), entry.locale).toBeGreaterThan(0);
			swept += 1;
		}
		expect(swept).toBe(TOKENISER_INPUTS.length);
	});

	test('empty and separator-only text count nothing', () => {
		expect(countWords('')).toBe(0);
		expect(countWords('!!! ,,,')).toBe(0);
	});
});
