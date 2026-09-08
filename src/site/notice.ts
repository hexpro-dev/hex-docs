/**
 * Which notice a reader sees, and whether the page they are on may be indexed.
 *
 * Both answers come from the same two facts, so they live together: the locale the reader
 * asked for, and the locale the payload actually is. Splitting them is how a page ends up
 * showing a translation notice and telling a crawler it is a canonical translation.
 *
 * ## Five states, three notices
 *
 * `TranslationState` has five members and `DocsTranslationNotice` has three, and the
 * mapping is not obvious enough to leave implicit.
 *
 * `source` and `current` are both `current`: there is nothing to tell the reader.
 * `stale` is its own notice because the page really is a translation, really is in the
 * reader's language, and is behind. `missing` cannot appear on a page that was served,
 * because a missing translation is what makes the served payload English in the first
 * place, and that is caught by the locale comparison rather than by the state.
 *
 * `scaffolded` is the one worth stating. It is source text under a translation's name, so
 * the reader is looking at English at a Spanish address, which is the same thing a
 * fallback is from their point of view even though the URL and the file both exist. It
 * folds to `fallback`, which is the same fold `kit/src/compile/search.ts` already applies
 * for the same reason.
 *
 * A fourth notice member was considered and rejected. `site.ts` gives the reason where
 * the union is declared: three states, three notices, three answers to whether the page
 * is indexable. A scaffolded page is not indexable, for exactly the reason a fallback is
 * not, and its sentence to the reader is the same sentence. A fourth member would add a
 * name and no fourth answer.
 */

import type { Locale } from '../contracts/locales.js';
import type { CompiledPage } from '../contracts/page.js';
import type { DocsSeo, DocsTranslationNotice } from '../contracts/site.js';

/**
 * The notice for a page as served.
 *
 * `page.translation.state` is the **effective** state, the worst of the page and every
 * snippet it transcludes, which is what `frontmatter.ts` says it is for: a current page
 * full of stale snippets is not current to a reader. The per-page state the manifest
 * counts is a different number and is not this function's input.
 *
 * The source locale is deliberately not a parameter. Every question this function asks is
 * about the payload against the request, and a third locale in the signature would be an
 * argument every caller has to get right for no answer it can change.
 */
export function translationNotice(page: CompiledPage, requested: Locale): DocsTranslationNotice {
	// Determined by comparing the payload's locale to the reader's, not by reading the
	// state. A page whose state is `source` is not a fallback when the reader asked for
	// English, and is one when they did not, and only the comparison can tell those apart.
	if (page.locale !== requested) return { state: 'fallback', requested };
	if (page.translation.state === 'scaffolded') return { state: 'fallback', requested };
	if (page.translation.state === 'stale') {
		return { state: 'stale', sourceUpdated: page.translation.sourceUpdated };
	}
	// `missing` cannot be reached here: it describes a locale with no file, and there is
	// no file to have produced this payload. It is folded rather than refused because a
	// bundle compiled by a newer toolchain is input this half does not control, and a
	// thrown error would take a whole page down over a notice.
	if (page.translation.state === 'missing') return { state: 'fallback', requested };
	return { state: 'current' };
}

/**
 * Whether the served page may be indexed.
 *
 * Two reasons for `false`, and `site.ts` states both where `DocsSeo` is declared. A
 * pinned version is not the canonical one, and an English page served at six other
 * addresses is duplicate content: hex-nfc's first bundle is English-only, so without this
 * every page ships seven URLs of byte-identical English, each self-canonicalising and
 * each declaring the other six as alternates.
 *
 * A stale translation stays indexable. It is a real translation of a real page in that
 * language and the right result for a reader searching in it, which is not true of the
 * other two.
 */
export function seoFor(notice: DocsTranslationNotice, pinned: boolean): DocsSeo {
	return { indexable: !pinned && notice.state !== 'fallback' };
}
