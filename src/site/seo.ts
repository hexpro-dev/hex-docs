/**
 * How the consuming site's root reads a docs page's SEO answer.
 *
 * The root owns the canonical link, the `hreflang` alternates and the `noindex`, because it
 * writes them as plain JSX above `<Meta />` and React Router's `meta()` can append a tag but
 * never remove one. So the docs route cannot correct them itself; it hands its answer up,
 * and the root reads it from `useMatches()`:
 *
 * ```tsx
 * const docsSeo = docsSeoFromMatches(useMatches());
 * const translated = docsSeo ? docsSeo.indexable : isLocalisedPath(path);
 * // and the alternates loop keeps only the languages in docsSeo.languages
 * ```
 *
 * Docs addresses stay out of the host's `LOCALISED_PATHS` entirely. That list has two
 * readers in each consumer, the root and the language cookie redirect, and a path absent
 * from it is already exempt from the redirect, which is the exemption the translation
 * notice's link to the English page needs. It also keeps every docs module out of the
 * client bundle of every other page.
 *
 * Deliberately tiny and type-only in its imports, because the root is on every page.
 */

import { isLocale } from '../contracts/locales.js';
import type { DocsSeo } from '../contracts/site.js';

/**
 * The `handle` a docs page route exports, and the only thing `docsSeoFromMatches` looks
 * for. Recognised by `hexdocs === 1` rather than by identity, so a handle that crossed the
 * server and client boundary as data still matches.
 */
export const DOCS_HANDLE: { readonly hexdocs: 1 } = Object.freeze({ hexdocs: 1 });

function isDocsHandle(handle: unknown): boolean {
	return (
		typeof handle === 'object' && handle !== null && (handle as { hexdocs?: unknown }).hexdocs === 1
	);
}

function seoOf(data: unknown): DocsSeo | undefined {
	if (typeof data !== 'object' || data === null) return undefined;
	const seo = (data as { seo?: unknown }).seo;
	if (typeof seo !== 'object' || seo === null) return undefined;
	const { indexable, languages } = seo as { indexable?: unknown; languages?: unknown };
	if (typeof indexable !== 'boolean' || !Array.isArray(languages)) return undefined;
	if (!languages.every((language) => isLocale(language))) return undefined;
	return { indexable, languages: [...languages] };
}

/**
 * The docs page's SEO answer, or `undefined` when this is not a docs page.
 *
 * `undefined` exactly when no match carries `DOCS_HANDLE`, which is every page the site
 * owns and every URL no route matched. The root then keeps its own rule.
 *
 * `{ indexable: false, languages: [] }` when a docs match is present and its data is not
 * an SEO answer. That is an error render: the docs loader threw a 404 or a 500, or the
 * `:lang` parent refused the language, and in all three React Router keeps the docs match
 * in `useMatches()` with its handle and `data: undefined`. Measured through the real
 * handler. Failing closed there is the point: reading the data unguarded throws inside the
 * root's render, and React Router turns that into a plain-text 500 with no HTML and no
 * content security policy, for every mistyped docs URL.
 */
export function docsSeoFromMatches(
	matches: readonly { handle?: unknown; data?: unknown }[],
): DocsSeo | undefined {
	// The deepest docs match, although a docs page is a leaf and there is only ever one.
	const docs = [...matches].reverse().find((match) => isDocsHandle(match.handle));
	if (docs === undefined) return undefined;
	return seoOf(docs.data) ?? { indexable: false, languages: [] };
}
