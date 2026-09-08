/**
 * `@hex-pro/docs/render`: the React half.
 *
 * A second entry point, and the separation is load-bearing rather than tidy. This module
 * imports the stylesheet, and `hex-web` imports the package from places with no bundler at
 * all: its hand-run `.mjs` guards, its sitemap generation and `hexdocs sync` all run under
 * bare node, where a `.css` specifier throws. `src/index.ts` therefore re-exports the
 * contracts, the search client, the string tables and the address rules and stops there,
 * and everything that renders lives behind this one.
 *
 * `test/render/entrypoints.test.ts` asserts the split over the actual import graph rather
 * than trusting the arrangement, because the failure mode is a single convenient
 * re-export somebody adds a year from now, and it breaks a build in a submodule during a
 * deploy.
 *
 * The stylesheet is imported here rather than by the consumer. Both consumers already use
 * a component-level `import './Foo.css'` and both bundlers turn it into a code-split CSS
 * chunk that is linked only on the routes that need it, so the docs stylesheet costs a
 * marketing page nothing. It also means the install has no stylesheet step to forget.
 */

import './docs.css';

export { DocsPage, type DocsChrome, type DocsPageProps } from './page.js';
export { PlainLink, renderBlocks, renderInline } from './nodes.js';
export { NO_EMIT } from './context.js';
export type { DocsLinkComponent, EmitFn, RenderContext } from './context.js';
export { DocsSearch, statusText, type SearchProps } from './search.js';
export { CodeBlock } from './code.js';
export {
	useAliasScroll,
	useDocsEvents,
	useHeadingSpy,
	useHydrated,
	useNavigationAnnounce,
	useReducedMotion,
} from './client.js';
