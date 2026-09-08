/**
 * The tokeniser, on both sides of the index.
 *
 * It is script driven, not locale driven, and that is the decision the rest of the file
 * hangs off. A Chinese product name inside an English page has to be findable, and so
 * does an English part number inside a Japanese one; the corpus has both. A tokeniser
 * chosen by the page's locale would make a term's spelling in the dictionary depend on
 * which file it was written in, so the same characters would index one way in `en` and
 * another in `zh`, and a query would find one of them.
 *
 * `TOKENISER_VERSION` in `src/contracts/search.ts` is what this module is identified by.
 * Any change to the classification, the bigram rule or the folding bumps it, because the
 * failure mode of a mismatch is an empty result set rather than an error.
 */

import { foldArabic, foldTerm, normaliseText } from './normalise.js';

/**
 * Script extensions, not script.
 *
 * U+30FC KATAKANA-HIRAGANA PROLONGED SOUND MARK is Script=Common and
 * Script_Extensions={Hiragana, Katakana}. Under `\p{sc=Katakana}` it is a separator, so
 * an ordinary katakana word carrying one splits into two runs and the bigrams that
 * straddle it are never emitted. `kit` and the browser would still agree with each
 * other, so nothing fails: Japanese search just gets quietly worse.
 */
const CJK_SCRIPTS = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;

/** Letters, numbers and the underscore. Everything else is a separator. */
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

type CharacterClass = 'cjk' | 'word' | 'separator';

function classify(character: string): CharacterClass {
	// CJK first, because a word test that ran first would swallow an entire Japanese
	// sentence as one term and emit no bigrams at all.
	//
	// But CJK **and** a word character, not CJK alone. Script_Extensions is not a letter
	// test, and the comment that used to sit here said Han, Hiragana and Katakana "are all
	// `\p{L}`", which describes a test this function did not perform. U+3002 IDEOGRAPHIC
	// FULL STOP, U+3001 IDEOGRAPHIC COMMA, U+300C and U+300D CORNER BRACKETS and U+30FB
	// KATAKANA MIDDLE DOT all carry Han or Kana in their scx set and none of them is a
	// letter, so each joined the run beside it instead of ending it. Measured on the built
	// corpus: 127 of 2709 Chinese terms and 221 of 3048 Japanese terms were punctuation
	// bigrams, each rare and so each carrying a high idf, and `countWords` counted them,
	// inflating the Japanese reading estimate by nearly seven per cent.
	//
	// U+30FC, the prolonged sound mark this rule was written for, is `\p{L}` (Lm), so it
	// still classifies as CJK and an ordinary katakana word carrying one stays one run.
	if (CJK_SCRIPTS.test(character) && WORD_CHARACTER.test(character)) return 'cjk';
	if (WORD_CHARACTER.test(character)) return 'word';
	return 'separator';
}

/**
 * What both the tokeniser and the word count read.
 *
 * The Arabic folding is applied to the whole string here, before anything is
 * classified, because the diacritics it removes are combining marks and combining marks
 * are not word characters. Left in place, a shadda inside a word ends the run and the
 * word becomes two terms; folding the two pieces afterwards cannot rejoin them.
 * `foldTerm` still folds each finished term, because that is the one exported
 * definition of a term's spelling, and the folding is idempotent so the second pass
 * changes nothing.
 */
function prepare(text: string): string {
	return foldArabic(normaliseText(text));
}

/**
 * The terms a piece of text contributes, in order, with duplicates kept.
 *
 * The builder counts term frequency from exactly this array, so removing duplicates
 * here would flatten every `tf` to 1 and turn BM25 into a presence test.
 */
export function tokenise(text: string): string[] {
	const terms: string[] = [];
	let run: string[] = [];
	let runClass: CharacterClass = 'separator';

	const flush = (): void => {
		if (run.length === 0) return;
		if (runClass === 'cjk') {
			// Overlapping bigrams, because the corpus has no spaces to segment on and
			// `Intl.Segmenter` was measured splitting these runs into single characters on
			// Node 22. A run of one character is that character: a single-character term is
			// the only thing a one-character run can contribute, and dropping it would make
			// a one-character heading unsearchable.
			if (run.length === 1) {
				terms.push(run[0] as string);
			} else {
				for (let i = 0; i + 1 < run.length; i += 1) {
					terms.push((run[i] as string) + (run[i + 1] as string));
				}
			}
		} else {
			terms.push(foldTerm(run.join('')));
		}
		run = [];
	};

	for (const character of prepare(text)) {
		const next = classify(character);
		if (next !== runClass) {
			flush();
			runClass = next;
		}
		if (next !== 'separator') run.push(character);
	}
	flush();

	return terms;
}

/**
 * The query side of the same tokeniser.
 *
 * Defined in terms of `tokenise` rather than repeating its steps, so the index side and
 * the query side cannot drift. A second implementation is how a search returns nothing
 * for exactly the inputs the two spell differently, with no error anywhere.
 */
export function tokeniseQuery(text: string): string[] {
	return tokenise(text);
}

/**
 * The word count behind `ReadingEstimate` and `PageLocaleRecord.words`.
 *
 * A run of word characters is one word and each CJK character is one word. Both halves
 * are approximations: 200 words a minute is a figure measured on Latin prose, and a CJK
 * character is not a word. The only contract this function carries is that the same
 * input always produces the same number, which is why it reads the same prepared text
 * the tokeniser does. Counting the raw string instead would make the estimate depend on
 * whether the source file happened to be saved composed or decomposed, and a page's
 * reading time would change with no edit to the page.
 */
export function countWords(text: string): number {
	let words = 0;
	let previous: CharacterClass = 'separator';

	for (const character of prepare(text)) {
		const current = classify(character);
		if (current === 'cjk') {
			words += 1;
		} else if (current === 'word' && previous !== 'word') {
			words += 1;
		}
		previous = current;
	}

	return words;
}
