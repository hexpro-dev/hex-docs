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
 * than one function. The bar's current heading, the outline's list of headings and a search
 * result's title are the article's text standing in the interface's furniture; the
 * translation notice, the reading estimate, the edit link, the copy button on a fence and
 * the status mark in a table are the interface's words standing inside the article. On a
 * page whose two locales agree, none of them says anything, because repeating an attribute
 * an element already inherits makes a screen reader announce a language change into the
 * language it is already reading. On a fallback, every one of them has to.
 *
 * ## Mark the words, never the box
 *
 * A mark goes on the smallest element that holds nothing but the run of text it describes.
 * That is not tidiness; `dir` changes where a box lands as well as which way its text runs,
 * and the two answers are different. Measured on hex-web's Arabic address of an English
 * page: `interfaceMark` spread onto `<button class="hx-copy">` moved the Copy button from
 * the end of the fence bar to its start, because the button is a flex item in a bar that
 * stays left to right and `margin-inline-start: auto` resolves in the item's own direction.
 * The same trap is one line away in the pager, where `.hx-next` carries
 * `margin-inline-start: auto` and `text-align: end`, and in every row of the tree and the
 * trail, where the current-item bar is an inset shadow with a `:dir(rtl)` mirror on the
 * element itself.
 *
 * So the copy button's label, a crumb's label, a pager's title and a tree row's label each
 * sit in a span of their own and the mark goes there, while the box keeps the direction of
 * the list it belongs to. The two lists whose every row is in one language, the outline and
 * the search results, are marked on the list instead: there the box should mirror, because
 * the depth indent and the current-item bar belong on the side those words read from.
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

/** The same, for an element that has a language and must not be given a direction. */
export type LangOnlyMark = Pick<LangAttrs, 'lang'> | Record<string, never>;

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
 * What this cannot reach is an accessible name that is only an attribute on an element that
 * also holds the page's own words. A fence's region name and a table's are exactly that, and
 * there is no way in HTML to give an attribute a different language from the text beside it.
 * The text wins, because the text is what is read.
 *
 * That argument does not extend to an element with no text at all, which is what
 * `interfaceLang` is for.
 */
export function interfaceMark(requested: Locale, contentLocale: Locale): LangMark {
	return contentLocale === requested ? {} : langAttrs(requested);
}

/**
 * The same, minus the direction, for a mark whose whole content is its accessible name.
 *
 * A status mark and a task marker are empty elements: `role="img"` with an `aria-label` and
 * a shape drawn in CSS. The exemption `interfaceMark` describes for a fence's region name
 * does not reach them, because there is no text beside the attribute for the text to win
 * over. The attribute is the whole of what is read, so it needs the `lang` that says which
 * language to read it in, and on the Arabic address of an English page every one of the 101
 * marks in a support matrix was announced as English without it.
 *
 * `dir` is deliberately absent, and this is the whole reason the two marks are separate
 * functions rather than one with a flag. Measured: `dir="rtl"` on `.hx-status-half` makes
 * the element match `.hx-status-half:dir(rtl)`, whose background is
 * `linear-gradient(to left, ...)`, so the half-filled disc fills its other half. The mark
 * would then say the wrong thing about support in a table the reader is reading left to
 * right, which is the one channel the shape exists to carry when the colour cannot.
 */
export function interfaceLang(requested: Locale, contentLocale: Locale): LangOnlyMark {
	return contentLocale === requested ? {} : { lang: requested };
}

/**
 * The direction a fenced code block is laid out in, whatever the page around it.
 *
 * A constant rather than a function, because there is no input that changes the answer
 * and a parameter would invite one.
 */
export const CODE_DIRECTION: Direction = 'ltr';
