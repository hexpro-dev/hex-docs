/**
 * What every renderer function is handed.
 *
 * One object rather than six props threaded through nine functions, and it is passed
 * explicitly rather than through a React context for a specific reason: every function in
 * `nodes.tsx` is then a plain function of its arguments, callable from a test without a
 * React tree, and a golden can be produced by calling one of them rather than by rendering
 * a page and finding the fragment in it.
 *
 * The two locales are both here and they are not the same thing. `locale` is the reader's
 * interface language, which is what every UI string is read in. `contentLocale` is the
 * language the payload actually is, which differs whenever an English page is served as
 * the fallback for a language with no translation. A single `locale` would either label an
 * English article as Japanese or print the interface in a language the reader did not
 * choose.
 */

import type { ReactElement, ReactNode, Ref } from 'react';

import type { Locale } from '../contracts/locales.js';
import type { DocsEventMap } from '../contracts/theme.js';
import type { DocsAddress } from '../site/address.js';

/**
 * The consumer's router link.
 *
 * This one prop is what keeps `react-router` out of the package while still giving an
 * internal link a client-side navigation, which `ast.ts` commits to where it declares the
 * `internal` kind. The shape is the intersection of what React Router 7's `Link`, Next's
 * and Astro's all accept, so a consumer passes its own component unchanged.
 */
export type DocsLinkComponent = (props: {
	to: string;
	children: ReactNode;
	className?: string;
	title?: string;
	'aria-current'?: 'page';
	/**
	 * Forwarded to the anchor. React 19 makes this an ordinary prop on a function
	 * component, and React Router 7's `Link` already forwards it.
	 *
	 * The search dialog needs it: pressing Enter on a highlighted result has to activate
	 * that row's own link, because the consumer's router owns navigation and this package
	 * cannot import it. Clicking the element that already knows how is the only honest
	 * version of that, and it needs a handle on the element.
	 */
	ref?: Ref<HTMLAnchorElement>;
	onClick?: () => void;
}) => ReactElement;

/**
 * The typed dispatcher for the package's custom events.
 *
 * `theme.ts` declares the map and says why it exists: a consuming site wires its own
 * motion and effects to these without the package importing anything from it, which is
 * what keeps the zero-dependency gate and the rule against depending on the consumer's UI
 * package true at the same time.
 */
export type EmitFn = <K extends keyof DocsEventMap>(name: K, detail: DocsEventMap[K]) => void;

export interface RenderContext {
	/** The reader's interface language. Every UI string is read in this one. */
	locale: Locale;
	/** The language the payload is actually in, which is the fallback's whole point. */
	contentLocale: Locale;
	/** Base path, locale and version, for every internal link this page emits. */
	address: DocsAddress;
	/** Where the prefetched bundle's objects are served from, for images. */
	bundleBase: string;
	Link: DocsLinkComponent;
	emit: EmitFn;
}

/** Dispatches nothing. The default on the server, and in every test that is not about events. */
export const NO_EMIT: EmitFn = () => undefined;
