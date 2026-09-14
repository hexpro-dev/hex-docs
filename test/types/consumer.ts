/**
 * Type-level assertions about what a consumer hands this package. Compiled, never run.
 *
 * `pnpm typecheck` compiles this file, and `test/render/consumer-types.test.ts` compiles it
 * again with the compiler API so the same program can be handed a link component that must
 * be refused. The second half is why that test still exists: a positive control is a file
 * that has to fail, and no configuration can assert that about itself.
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
 * `app/lib/docs.server.ts` when they carry no type argument, transcribed from its
 * `types/importGlob.d.ts` because Vite is not a dependency here. With no type argument the
 * `As` parameter infers as `string`, so a lazy glob resolves to `unknown` whatever its
 * `query` says, and an eager one is a record of `unknown`.
 *
 * The module `install` writes passes `<string>` to the text glob, which narrows it, so these
 * are not the types that module produces. They are the widest a consumer can produce by
 * editing that file, whose first line says it is safe to edit, and the server has to accept
 * them or that edit is a type error in the site's own server module.
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
