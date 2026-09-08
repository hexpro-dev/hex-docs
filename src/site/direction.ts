/**
 * Every `lang` and `dir` decision the renderer makes, in one module.
 *
 * There are only three of them and they are each one line, so putting them together looks
 * like ceremony until you try to test the alternative. Scattered across the shell, the
 * inline switch and the fence, an assertion over rendered output can only count the
 * attributes it finds, and a count with nothing to compare it to is the failure the
 * verify ladder already learned once: a dropped arm lowers a number that nothing was
 * expecting to be any particular size. With the decisions here, the render suite derives
 * its expectation from the input tree, and a missing `dir` is a shortfall that names the
 * arm it came from.
 *
 * ## The article is labelled with the locale it is in, not the one that was asked for
 *
 * This is the whole reason `contentAttrs` takes both. When a reader asks for Japanese and
 * the page has no Japanese translation, the served payload is English, and marking that
 * article `lang="ja"` tells a screen reader to read English words with Japanese phonetics
 * and a translation tool that the text is already translated. The notice above it says
 * the same thing in words; the attribute has to agree.
 *
 * ## Code is left to right in every language
 *
 * Source code is not Arabic text. A right-aligned fence with its indentation on the wrong
 * side is unreadable to everyone, Arabic speakers included, and a bidirectional reorder
 * inside an identifier changes what the identifier says. The fence carries the attribute;
 * inline code inside a sentence is handled in the stylesheet with `unicode-bidi: isolate`,
 * because an inline element that forced `dir` would break the sentence around it.
 */

import { directionOf, type Direction, type Locale } from '../contracts/locales.js';
import type { CompiledPage } from '../contracts/page.js';

export interface LangAttrs {
	lang: Locale;
	dir: Direction;
}

/** The pair for one locale. `pt-BR` keeps its capitals: it is a BCP 47 tag, not a slug. */
export function langAttrs(locale: Locale): LangAttrs {
	return { lang: locale, dir: directionOf(locale) };
}

export interface ContentAttrs extends LangAttrs {
	/**
	 * True when the payload is not in the locale the reader asked for.
	 *
	 * The renderer uses it for nothing except deciding that the article needs its own
	 * `lang` and `dir` at all: when they match the document's, repeating them is noise
	 * that a screen reader reads as a language change to the same language.
	 */
	differs: boolean;
}

export function contentAttrs(page: CompiledPage, requested: Locale): ContentAttrs {
	return { ...langAttrs(page.locale), differs: page.locale !== requested };
}

/**
 * The direction a fenced code block is laid out in, whatever the page around it.
 *
 * A constant rather than a function, because there is no input that changes the answer
 * and a parameter would invite one.
 */
export const CODE_DIRECTION: Direction = 'ltr';
