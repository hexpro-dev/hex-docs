/**
 * Rendering the shell to markup, for the golden suite and the assertions over it.
 *
 * `react-dom/server` is a devDependency and is deliberately not on the runtime half's
 * allowlist: nothing under `src/` may import it, and this file is under `test/`, which is
 * the arrangement that lets `scripts/check-imports.mjs` have no exemptions at all.
 *
 * `renderToStaticMarkup` rather than `renderToString`. The goldens are about the markup a
 * reader and a crawler see, and the hydration bookkeeping `renderToString` adds is noise in
 * a diff that a person is meant to read. What is lost is a check that hydration ids line
 * up, which is not something a string comparison could have caught anyway.
 */

import { renderToStaticMarkup } from 'react-dom/server';

import type { Locale } from '../../src/contracts/locales.js';
import type { BundleManifest } from '../../src/contracts/manifest.js';
import type { CompiledPage } from '../../src/contracts/page.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import { DocsPage, type DocsPageProps } from '../../src/render/page.js';
import { docsRoute, type DocsPageData } from '../../src/site/route.js';

/**
 * The data a route would produce for one page, built from the real manifest and the real
 * site config rather than by hand.
 *
 * Hand-built props are the renderer author's idea of what the loader produces, and the two
 * drift silently: the renderer keeps passing while the object it is handed changes shape.
 * Going through `docsRoute` means a change to either end fails here.
 */
export async function pageData(input: {
	manifest: BundleManifest;
	site: DocsSiteConfig;
	locale: Locale;
	slug: string;
	pinned?: string;
	load: (locale: Locale, slug: string) => CompiledPage | undefined;
}): Promise<DocsPageData> {
	const result = await docsRoute({
		manifest: input.manifest,
		site: input.site,
		locale: input.locale,
		slug: input.slug,
		...(input.pinned === undefined ? {} : { pinned: input.pinned }),
		bundleBase: '/_docs/fixture-app/1.1.0',
		edit: {
			repo: 'https://github.com/hexpro-dev/fixture-app',
			branch: 'main',
			root: 'docs/site',
		},
		load: async (locale, slug) => input.load(locale, slug),
	});
	if (!result.ok) {
		throw new Error(
			`docsRoute refused ${input.locale}/${input.slug} with "${result.reason}". A golden cannot be produced from a page the route will not serve.`,
		);
	}
	return result.data;
}

/** The shell, as markup. */
export function renderPage(props: DocsPageProps): string {
	return renderToStaticMarkup(<DocsPage {...props} />);
}

/**
 * Markup, pretty-printed one element per line so a diff is readable.
 *
 * Attribute order is left exactly as React emitted it. React's ordering is stable in
 * practice and unstable in principle, and sorting here would hide the day it changes,
 * which is a thing the goldens should show rather than absorb.
 */
export function formatMarkup(html: string): string {
	return html
		.replace(/></g, '>\n<')
		.split('\n')
		.map((line) => line.trimEnd())
		.join('\n');
}
