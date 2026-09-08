/**
 * The text the search tokeniser has to get right, and the pairs that prove which
 * normalisation form it needs.
 *
 * Every failure in this subsystem is silent. An index built with one normalisation and
 * queried with another returns nothing, with no error, in one language, and never on
 * the machine of the person who changed it. So the corpus carries the inputs rather
 * than leaving them to be imagined, and the suite measures the folding rather than
 * repeating what a comment claims.
 *
 * `INDEX_NORMALISATION` is NFKC and `search.ts` justifies that with two spellings of
 * one product name. Until this file existed, nothing measured it: the constant said
 * NFKC, the comment said why, and NFC would have passed every test in the repository.
 *
 * Invisible characters are written as escapes. A combining mark or a no-break space
 * pasted in as a literal is unreviewable, and a reviewer who cannot see the difference
 * between the two sides of a pair cannot check the claim.
 */

import type { Locale } from '../src/contracts/locales.js';

/**
 * Two spellings a reader would expect to find each other, and what each normalisation
 * form does with them.
 *
 * `nfc` and `nfkc` are measured on Node 22 and pinned by the suite, not asserted here.
 * A row where both are false is the important kind: it says normalisation alone does
 * not close the gap and the tokeniser has to do the work.
 */
export interface FoldingCase {
	id: string;
	a: string;
	b: string;
	/** Whether `a` and `b` are the same string after NFC. */
	nfc: boolean;
	/** Whether they are the same string after NFKC. */
	nfkc: boolean;
	why: string;
}

export const FOLDING_CASES: readonly FoldingCase[] = [
	{
		id: 'micro-sign-vs-greek-mu',
		a: 'NTAG 210µ',
		b: 'NTAG 210μ',
		nfc: false,
		nfkc: true,
		why: 'The measured case that chose NFKC over the NFC the plan named. The same part number is spelled with U+00B5 MICRO SIGN in the chip matrix and U+03BC GREEK SMALL LETTER MU in the store listing. Under NFC a reader who types one never finds the other.',
	},
	{
		id: 'fullwidth-latin',
		a: 'ＮＴＡＧ',
		b: 'NTAG',
		nfc: false,
		nfkc: true,
		why: 'Fullwidth Latin appears in the Japanese legal documents. NFC keeps it distinct from the ASCII a reader types.',
	},
	{
		id: 'halfwidth-katakana',
		a: 'ｶﾞ',
		b: 'ガ',
		nfc: false,
		nfkc: true,
		why: 'Halfwidth katakana with a halfwidth voiced mark. Two code points that mean one character, and NFC leaves them as two.',
	},
	{
		id: 'no-break-space',
		a: 'NTAG\u00a0213',
		b: 'NTAG 213',
		nfc: false,
		nfkc: true,
		why: 'A no-break space typed by a word processor. It is invisible in review and it splits a term in two under NFC.',
	},
	{
		id: 'french-cedilla-decomposed',
		a: 'français',
		b: 'franc\u0327ais',
		nfc: true,
		nfkc: true,
		why: 'The decomposed form both NFC and NFKC fix. Without either, the combining cedilla falls outside the word-character table and the word tokenises as franc plus ais.',
	},
	{
		id: 'japanese-voiced-kana-decomposed',
		a: 'ガ',
		b: '\u30ab\u3099',
		nfc: true,
		nfkc: true,
		why: 'Decomposed voiced kana. The same failure as the cedilla, in the language least likely to be proofread here.',
	},
	{
		id: 'arabic-alef-hamza',
		a: 'أحمد',
		b: 'احمد',
		nfc: false,
		nfkc: false,
		why: 'Neither form folds this. Arabic writers omit the hamza constantly, so the tokeniser folds alef variants itself. A row that stays false in both columns is what says normalisation is not enough.',
	},
	{
		id: 'arabic-yeh',
		a: 'يوم',
		b: 'ىوم',
		nfc: false,
		nfkc: false,
		why: 'Yeh against alef maksura, the same problem in a different letter and the second half of the Arabic folding the plan requires.',
	},
	{
		id: 'arabic-tatweel',
		a: 'ك\u0640\u0640تاب',
		b: 'كتاب',
		nfc: false,
		nfkc: false,
		why: 'Tatweel is a justification character with no meaning. Neither normalisation removes it, so the tokeniser must.',
	},
	{
		id: 'arabic-indic-digits',
		a: '١٢٣',
		b: '123',
		nfc: false,
		nfkc: false,
		why: 'Arabic-Indic digits are not compatibility equivalents of ASCII digits and NFKC leaves them alone, which is correct. Recorded so that nobody adds a fold here believing NFKC already does it.',
	},
];

/**
 * Terms the index has to contain, one set per locale, in their composed spelling.
 *
 * Decomposed input is not hypothetical: it is what macOS filesystem APIs hand back and
 * what arrives when text is pasted out of a PDF. The plan asks the corpus to carry
 * "the NFD form of every tokeniser input", and the naive way to test that is a
 * tautology: `s.normalize('NFD').normalize('NFKC') === s.normalize('NFKC')` holds for
 * every string in existence, so it measures Node's `normalize` and says nothing at all
 * about these seven rows.
 *
 * `decomposes` is what makes them mean something. It records whether the NFD form of
 * this row actually differs from the composed one, it is measured by the suite rather
 * than trusted, and it is what fails when somebody replaces an accented sentence with
 * an unaccented one and leaves a table of pure ASCII behind a test that still passes.
 */
export interface TokeniserInput {
	locale: Locale;
	text: string;
	/** Whether NFD differs from this spelling. Measured, and pinned by the suite. */
	decomposes: boolean;
	why: string;
}

export const TOKENISER_INPUTS: readonly TokeniserInput[] = [
	{
		locale: 'en',
		text: 'Scan your first tag with NTAG213',
		decomposes: false,
		why: 'Plain Latin with a part number, the baseline every other row is compared against.',
	},
	{
		locale: 'fr',
		text: 'Rapprochez le badge du téléphone',
		decomposes: true,
		why: 'Accented Latin. Decomposed, the acute falls outside the word-character table and splits the word.',
	},
	{
		locale: 'es',
		text: 'Acerca la etiqueta al teléfono para leerla',
		decomposes: true,
		why: 'Accented Latin again, in the locale that also carries the scaffolded page.',
	},
	{
		locale: 'pt-BR',
		text: 'Aproxime a etiqueta do aparelho para começar a leitura',
		decomposes: true,
		why: 'A cedilla and a tilde in one sentence.',
	},
	{
		locale: 'zh',
		text: '将标签靠近手机顶部即可读取',
		decomposes: false,
		why: 'Chinese with no spaces. Intl.Segmenter was measured splitting this kind of run into single characters on Node 22 full ICU, which is why the tokeniser uses bigrams rather than trusting word granularity.',
	},
	{
		locale: 'ja',
		text: 'タグをiPhoneの上部に近づけて読み取ります',
		decomposes: true,
		why: 'Mixed kana, kanji and Latin in one run, with no spaces. The seam between the Latin word and the kana is where a naive joiner inserts a space that should not be there.',
	},
	{
		locale: 'ar',
		text: 'قرّب البطاقة من أعلى الهاتف لقراءتها',
		decomposes: true,
		why: 'Arabic with a shadda, which is a combining mark, and an alef with hamza, which the folding has to reach. Right to left, so a reviewer cannot check it by eye either.',
	},
];

/**
 * Bidirectional control characters the corpus carries on purpose.
 *
 * Nothing strips these. U+200F is load-bearing in the Arabic pages, where removing it
 * reverses the visual order of a line mixing Arabic with a Latin product name, and
 * U+FE0F carries the difference between a coloured status glyph and a monochrome one.
 * They are declared here so that a future normalisation pass has to argue with a test
 * rather than with a comment.
 */
export const PRESERVED_INVISIBLES: readonly { codePoint: number; name: string; why: string }[] = [
	{
		codePoint: 0x200f,
		name: 'right-to-left mark',
		why: 'Fixes the visual order of a line that mixes Arabic with a Latin product name. Removing it reverses the line for the reader and for nobody reviewing it here.',
	},
	{
		codePoint: 0xfe0f,
		name: 'variation selector-16',
		why: 'Selects emoji presentation for the warning sign in the support matrix. Stripped, the cell renders as a monochrome glyph that reads as a different status.',
	},
];
