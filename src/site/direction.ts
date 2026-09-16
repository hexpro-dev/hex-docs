/**
 * Every `lang` and `dir` decision the renderer makes, in one module.
 *
 * They are each one line, so putting them together looks like ceremony until you try to
 * test the alternative. Scattered across the shell, the inline switch and the fence, an
 * assertion over rendered output can only count the attributes it finds, and a count with
 * nothing to compare it to is the failure the verify ladder already learned once: a
 * dropped arm lowers a number that nothing was expecting to be any particular size. With
 * the decisions here, the render suite derives its expectation from the input tree, and a
 * missing `dir` is a shortfall that names the arm it came from.
 *
 * ## The article is labelled with the locale it is in, not the one that was asked for
 *
 * This is the whole reason the marks below take both locales. When a reader asks for
 * Japanese and the page has no Japanese translation, the served payload is English, and
 * marking that article `lang="ja"` tells a screen reader to read English words with
 * Japanese phonetics and a translation tool that the text is already translated. The
 * notice above it says the same thing in words; the attribute has to agree.
 *
 * ## The article is not all content, and the chrome is not all interface
 *
 * Both directions cross, which is why `contentMark` and `interfaceMark` are a pair rather
 * than one function. The bar's current heading is the article's text standing in the
 * interface's furniture; the translation notice, the reading estimate, the edit link, the
 * breadcrumb and the pager are the interface's words standing inside the article. On a
 * page whose two locales agree, none of them says anything, because repeating an attribute
 * an element already inherits makes a screen reader announce a language change into the
 * language it is already reading. On a fallback, every one of them has to.
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

export interface LangAttrs {
	lang: Locale;
	dir: Direction;
}

/** The pair for one locale. `pt-BR` keeps its capitals: it is a BCP 47 tag, not a slug. */
export function langAttrs(locale: Locale): LangAttrs {
	return { lang: locale, dir: directionOf(locale) };
}

/**
 * A pair to spread onto an element, or nothing to say.
 *
 * An empty object rather than a pair of `undefined`s. React renders either as no attribute,
 * so the markup is the same, but a `dir={undefined}` reads as a decision somebody made about
 * direction and this is the absence of one.
 */
export type LangMark = LangAttrs | Record<string, never>;

/**
 * What to put on an element carrying the page's own words inside the interface's furniture.
 *
 * The article itself and the current heading named in the phone's bar. Without them, an
 * English heading on an Arabic page is read with Arabic phonetics and laid out right to
 * left in a line that clips at its inline end.
 */
export function contentMark(requested: Locale, contentLocale: Locale): LangMark {
	return contentLocale === requested ? {} : langAttrs(contentLocale);
}

/**
 * What to put on an element carrying the reader's own words inside the article.
 *
 * The mirror of `contentMark`, down to the argument list, because the two answer the same
 * question from opposite sides and a reader of either should be able to see that the
 * condition is one condition. When the article says nothing about its language, everything
 * inside it is already in the reader's and there is nothing to add; when it does, every
 * piece of the shell's furniture inside it is in the other language and each has to say so.
 *
 * Measured on hex-web's Arabic address before this existed. The translation notice and the
 * reading estimate sat inside an article marked `lang="en" dir="ltr"`, so the Arabic was laid
 * out left to right: its final full stop painted before the first word, the notice hugged the
 * wrong edge of its own box, and a screen reader announced Arabic as English.
 *
 * What this cannot reach is an accessible name that is only an attribute. A fence's region
 * name and a table's are interface strings on elements whose content is the page's own, and
 * there is no way in HTML to give an attribute a different language from the text beside it.
 * The text wins, because the text is what is read.
 */
export function interfaceMark(requested: Locale, contentLocale: Locale): LangMark {
	return contentLocale === requested ? {} : langAttrs(requested);
}

/**
 * The direction a fenced code block is laid out in, whatever the page around it.
 *
 * A constant rather than a function, because there is no input that changes the answer
 * and a parameter would invite one.
 */
export const CODE_DIRECTION: Direction = 'ltr';
