/**
 * `@hex-pro/docs`.
 *
 * Consumed as TypeScript source through a `tsconfig` `paths` entry, never built and
 * never published. Zero runtime dependencies, asserted by `scripts/check-imports.mjs`
 * over every specifier in this directory rather than by reading `package.json`.
 */

export * from './contracts/index.js';

/**
 * The AST helpers, the search client and the UI strings.
 *
 * Everything here is used by both halves, which is what puts it in the runtime half
 * rather than in the toolchain. The tokeniser is the clearest case: the index is built
 * by node in a GitHub Action and queried by the same functions in a browser, and two
 * implementations of "what is a term" is the failure `search.ts` opens by describing.
 */
export * from './ast/text.js';
export * from './search/normalise.js';
export * from './search/tokenise.js';
export * from './search/query.js';
export * from './ui/plural.js';
export * from './ui/status.js';
export * from './ui/strings.js';

/**
 * The address, notice and direction rules, and the server a consuming site's docs routes
 * call, all of which the site needs outside a React tree.
 *
 * Deliberately here and not in the renderer entry point. The toolchain imports these
 * modules under plain node, where a `.css` specifier throws before anything else happens,
 * and a consuming site's route config imports `app/lib/docs.server.ts`, which reaches this
 * barrel before a single route has rendered. A stylesheet or a component reachable from
 * here breaks both. `test/render/entrypoints.test.ts` walks the import graph and asserts
 * the separation rather than leaving it to be remembered.
 *
 * `docsRoute` is not exported. `docsServer` is the consumer API and calls it; what a
 * component or a loader's type needs from that module is exported as types alone.
 */
export * from './site/address.js';
export * from './site/direction.js';
export * from './site/ids.js';
export * from './site/notice.js';
export * from './site/seo.js';
export * from './site/serve.js';
export type { DocsCrumb, DocsNavNode, DocsPageData, DocsPager } from './site/route.js';
