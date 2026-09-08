/**
 * `nav.json`: the order of the documentation, and the set of pages that exist.
 *
 * Language-neutral on purpose. It references slugs, and titles come from each
 * locale's own front matter, which is what makes "a page cannot exist in one language
 * and not another" a thing the compiler can check rather than a thing somebody
 * notices. Ordering lives here rather than in a front matter number because seven
 * numbers that have to agree is six chances to disagree.
 *
 * It is also the page namespace. A published page that appears nowhere in this file
 * is an orphan: reachable by URL, unreachable by reading, and invisible to prev/next.
 * The compiler treats that as an error, not a warning.
 */

import type { LocalisedLabel } from './frontmatter.js';

/** The `nav.json` format version. Independent of the AST major. */
export const NAV_VERSION = 1;

/**
 * How deep groups may nest.
 *
 * Three is not arbitrary. A fourth level renders, and is unusable on a phone: the
 * sidebar indent eats the text column, and in Arabic the mirrored indent eats it from
 * the other side.
 */
export const MAX_NAV_DEPTH = 3;

/** Group ids: lower case, hyphenated, and stable, because they appear in the DOM. */
export const NAV_GROUP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface NavDocItem {
	/** A slug, in the wire spelling: `index`, `guide/first-tag`. */
	doc: string;
	/**
	 * Present to keep this page out of the sidebar, the sitemap and prev/next while
	 * leaving it published and indexable.
	 *
	 * The value is the reason, and it is required rather than a bare `true`, because a
	 * page that quietly vanishes from every listing is exactly the state somebody
	 * needs to be able to explain a year later. A page nobody should find should not be
	 * published at all.
	 */
	hidden?: string;
}

export interface NavGroupItem {
	group: string;
	/**
	 * All seven locales, every one required. A partially translated sidebar label is
	 * not a state worth supporting: the failure is an English word sitting under an
	 * Arabic heading in a right-to-left column, which reads as a bug to every reader
	 * who sees it and to none of the people who could fix it.
	 */
	label: LocalisedLabel;
	/** Rendered collapsed on first visit. */
	collapsed?: boolean;
	/** At least one. An empty group is a heading with nothing under it. */
	items: NavItem[];
}

export interface NavLinkItem {
	/** Absolute `https:`. */
	link: string;
	label: LocalisedLabel;
	/** Always true. Present so the three item shapes are told apart by key, not by guess. */
	external: true;
}

export type NavItem = NavDocItem | NavGroupItem | NavLinkItem;

export interface NavTree {
	/**
	 * Accepted and ignored. Editors resolve a relative `$schema` against the file, so
	 * `"../../hex-docs/kit/schema/nav-1.json"` gives completion and validation in place
	 * with nothing hosted anywhere. Every schema in this package is strict, so the key
	 * has to be declared or the tool rejects the files it generates itself.
	 */
	$schema?: string;
	nav: typeof NAV_VERSION;
	items: NavItem[];
}

export function isNavDoc(item: NavItem): item is NavDocItem {
	return 'doc' in item;
}

export function isNavGroup(item: NavItem): item is NavGroupItem {
	return 'group' in item;
}

export function isNavLink(item: NavItem): item is NavLinkItem {
	return 'link' in item;
}

export interface NavDocEntry {
	slug: string;
	/** The reason it is hidden, when it is. */
	hidden?: string;
	/** Group ids from the root down to this page's parent. */
	path: string[];
}

/**
 * Every page the nav names, depth-first, in reading order.
 *
 * Reading order is what prev/next uses, so this is the one traversal and both the
 * renderer and the orphan check go through it. Two traversals that disagree would put
 * a page's "next" somewhere its own sidebar does not.
 */
export function navDocs(tree: NavTree): NavDocEntry[] {
	const found: NavDocEntry[] = [];

	const walk = (items: NavItem[], path: string[]): void => {
		for (const item of items) {
			if (isNavGroup(item)) {
				walk(item.items, [...path, item.group]);
			} else if (isNavDoc(item)) {
				const entry: NavDocEntry = { slug: item.doc, path };
				found.push(item.hidden === undefined ? entry : { ...entry, hidden: item.hidden });
			}
		}
	};

	walk(tree.items, []);
	return found;
}

/** Group ids in declaration order, for the uniqueness check. */
export function navGroupIds(tree: NavTree): string[] {
	const found: string[] = [];
	const walk = (items: NavItem[]): void => {
		for (const item of items) {
			if (isNavGroup(item)) {
				found.push(item.group);
				walk(item.items);
			}
		}
	};
	walk(tree.items);
	return found;
}

/** Deepest group nesting in the tree. Zero when there are no groups at all. */
export function navDepth(tree: NavTree): number {
	const walk = (items: NavItem[], depth: number): number => {
		let deepest = depth;
		for (const item of items) {
			if (isNavGroup(item)) deepest = Math.max(deepest, walk(item.items, depth + 1));
		}
		return deepest;
	};
	return walk(tree.items, 0);
}
