/**
 * Every DOM id the shell emits.
 *
 * They are here rather than written where they are used so that one test can assert, over
 * every rendered golden, that each `aria-labelledby`, `aria-controls`, `aria-describedby`
 * and `aria-activedescendant` value names an id occurring exactly once in the same
 * rendered string. That is the cheapest catch for the commonest silent ARIA break: a
 * reference to an element that was renamed, moved into a component that no longer renders
 * it, or duplicated. Nothing warns, nothing looks wrong, and the relationship is simply
 * gone.
 *
 * ## Why these are constants and not `useId`
 *
 * `useId` produces a value that depends on the position of the component in the React
 * tree, so the same page rendered by a consumer that wraps the shell in one more provider
 * gets different ids, and the skip link in the site chrome cannot name the target. The
 * ids here are part of the contract: a consumer's own skip link may point at
 * `#hx-content`, and that only works if the value is stated rather than generated.
 *
 * ## One shell per page
 *
 * These are fixed strings, so two `DocsPage` components on one document would collide on
 * every one of them. That is a supported limitation rather than an oversight: two docs
 * shells on a page would also give two skip links to different articles, two live regions
 * announcing over each other, and two navigation landmarks with the same accessible name.
 * The single-instance assumption is asserted by the id-uniqueness test rather than left to
 * be discovered.
 */

/** The prefix every id and class in this package carries. */
export const HX = 'hx';

export const IDS = {
	/** The docs root element. Carries the theme class and the `data-` attributes. */
	root: 'hx-root',
	/** The article. The skip link's target, and what focus moves to after a navigation. */
	content: 'hx-content',
	/** The `h1`. `aria-labelledby` on the article names it. */
	title: 'hx-title',
	/** The sidebar navigation landmark. */
	tree: 'hx-tree',
	/** The table of contents navigation landmark, and the heading above it. */
	toc: 'hx-toc',
	tocHeading: 'hx-toc-heading',
	/** The previous/next pair. */
	pager: 'hx-pager',
	/** The breadcrumb trail. */
	breadcrumb: 'hx-breadcrumb',
	/** The button that opens search, which `aria-controls` on the dialog names. */
	searchTrigger: 'hx-search-trigger',
	searchDialog: 'hx-search-dialog',
	searchInput: 'hx-search-input',
	searchResults: 'hx-search-results',
	/** Announces the result count without moving focus. */
	searchStatus: 'hx-search-status',
	/** The polite live region that announces a client-side navigation. */
	live: 'hx-live',
} as const;

export type IdName = keyof typeof IDS;

/** One search result option, for `aria-activedescendant`. */
export function searchOptionId(index: number): string {
	return `hx-search-option-${index}`;
}

/**
 * A heading anchor as it appears in the DOM.
 *
 * Heading ids come from the compiler and are already unique within a page, so this is
 * identity. It exists so that the id-uniqueness test has one function to exclude, rather
 * than a rule about which ids in a rendered page are the shell's and which came out of
 * the content.
 */
export function headingId(id: string): string {
	return id;
}
