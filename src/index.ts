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
 * The address, notice and direction rules the consuming site needs outside a React tree.
 *
 * Deliberately here and not in the renderer entry point. `hex-web` derives its
 * `LOCALISED_PATHS` array and its sitemap from `docsLocalisedPaths`, and both of those run
 * under bare node in a hand-run `.mjs` with no bundler. The renderer imports a stylesheet,
 * so a module that reached it from this barrel would make every one of those importers
 * throw on a `.css` specifier. `test/guards.test.ts` asserts the separation rather than
 * leaving it to be remembered.
 */
export * from './site/address.js';
export * from './site/direction.js';
export * from './site/ids.js';
export * from './site/notice.js';
