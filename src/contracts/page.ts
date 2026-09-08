/**
 * A compiled page: one slug, one locale, everything the renderer needs and nothing
 * it has to derive.
 *
 * There is no markdown parser and no DOM walk at runtime, so anything the page needs
 * that is not a node arrives precomputed here or it does not exist. The table of
 * contents is the clearest case: it is a publish-time product of the heading nodes,
 * and a runtime derivation would mean walking the tree on every render on the server.
 */

import type { AstVersion, Block, HeadingDepth } from './ast.js';
import type { Audience, PageKind, TranslationRecord } from './frontmatter.js';
import type { Locale } from './locales.js';

export interface PageHeading {
	id: string;
	depth: HeadingDepth;
	/**
	 * The heading's text with inline markup flattened away.
	 *
	 * A separate field rather than the heading's own children, because a table of
	 * contents entry that rendered a link inside a link is invalid HTML and a table of
	 * contents entry that rendered an image is not a table of contents entry.
	 */
	text: string;
}

export interface ReadingEstimate {
	words: number;
	/** Rounded up, minimum one. */
	minutes: number;
}

export interface CompiledPage {
	/** The AST major this page's nodes conform to. Matches the `ast-N` key it came from. */
	ast: AstVersion;
	project: string;
	/** Wire form: `index`, `guide/first-tag`. */
	slug: string;
	locale: Locale;

	title: string;
	description: string;
	/** A shorter sidebar label. Absent means use `title`. */
	navTitle?: string;
	audience: Audience;
	pageKind: PageKind;
	tags: string[];
	/** The product version this page first described. */
	since?: string;

	/**
	 * Whether to render a table of contents, already resolved against the project
	 * default, the per-page suppression and the minimum heading count. The renderer
	 * does not re-decide.
	 */
	toc: boolean;
	/**
	 * Flattened, in document order. Ids are unique within the page and stable across a
	 * rebuild of the same source: an unstable id breaks every deep link anybody ever
	 * pasted into a support reply.
	 */
	headings: PageHeading[];

	body: Block[];

	translation: TranslationRecord;
	reading: ReadingEstimate;

	/**
	 * Snippet ids transcluded into this page, for provenance.
	 *
	 * Snippets are expanded at compile time and leave no node behind, so this is the
	 * only record that a paragraph came from somewhere else. It is also what makes a
	 * page's effective freshness computable: a current page full of stale snippets is
	 * not current, and the worst state among the page and everything it includes is
	 * the one the notice should show.
	 */
	snippets: string[];

	/** Path relative to `docs/site/`, for the "edit this page" link. */
	sourceFile: string;
}
