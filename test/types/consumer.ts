/**
 * Type-level assertions about what a consumer hands this package. Compiled, never run.
 *
 * `test/render/consumer-types.test.ts` compiles this file with the TypeScript compiler and
 * fails on any diagnostic. It is compiled from a test rather than by `pnpm typecheck`
 * because `tsconfig.test.json` inherits `"exclude": [..., "test"]` from `tsconfig.json`, so
 * no file under `test/` is part of that typecheck at all.
 */

import type { Link } from 'react-router';

import type { DocsLinkComponent } from '../../src/render/context.js';
import type { DocsSiteConfig } from '../../src/contracts/site.js';
import type { DocsSources } from '../../src/site/serve.js';

declare const reactRouterLink: typeof Link;

/**
 * React Router's own `Link`, passed unchanged. A `DocsLinkComponent` returning
 * `ReactElement` refuses this with TS2322, because `Link` is a `ForwardRefExoticComponent`
 * whose call signature returns `ReactNode`, and every consumer template then needs a
 * wrapper component to get past it.
 */
export const passedUnchanged: DocsLinkComponent = reactRouterLink;

/**
 * The types Vite 7.3.1's `import.meta.glob` gives the three globs in a consumer's
 * `app/lib/docs.server.ts`, transcribed from its `types/importGlob.d.ts` because Vite is
 * not a dependency here. With no type argument the `As` parameter infers as `string`, so a
 * lazy glob resolves to `unknown` whatever its `query` says, and an eager one is a record of
 * `unknown`. The server has to accept exactly these, or the template is a type error in
 * every site that installs it.
 */
declare const eagerGlob: Record<string, unknown>;
declare const lazyGlob: Record<string, () => Promise<unknown>>;
declare const configs: DocsSiteConfig[];

export const globsPassedUnchanged: DocsSources = {
	configs,
	manifests: eagerGlob,
	pages: lazyGlob,
	text: lazyGlob,
};
