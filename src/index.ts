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
export * from './ui/status.js';
