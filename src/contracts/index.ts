/**
 * The contracts.
 *
 * Every shape this package reads or writes is declared here, in the runtime half,
 * with no dependencies. The Zod schemas that validate them live in `kit/`, where a
 * dependency is allowed, and a compile-time drift check asserts the two agree
 * exactly in both directions.
 *
 * The direction matters. The runtime is the only party that must read a bundle it
 * did not write, so whatever it can parse *is* the format, and owning the type here
 * is what keeps Zod out of the CI-gated half. `kit/src/contracts/drift.ts` is where
 * the two are pinned together.
 *
 * ## Two conventions for absence, on purpose
 *
 * **Wire formats** the renderer reads (the AST, a compiled page, the manifest, the
 * search index) use optional-and-omitted. They are large, they are gzipped and
 * shipped to a browser, and every absent key has a documented default.
 *
 * **Diagnostics** an agent reads (`Finding`, the envelopes, the reports) use
 * `T | null`, always present. Size is irrelevant there and ambiguity is not: an
 * absent key cannot be told apart from a field this version of the toolchain did not
 * have, and "there is no suggested fix" must not read the same as "the suggested fix
 * is to delete this".
 *
 * The manifest follows the wire-format rule for absence, `PageRecord.locales`
 * included: it is a partial record, and an absent key means the page does not exist in
 * that locale. What makes that unambiguous is `manifest.locales`, the authority on
 * which languages the bundle contains at all, cross-checked against every page by
 * `validateManifestShape`. An earlier draft of this paragraph described the opposite
 * design, which was considered and rejected because hex-nfc's first bundle is
 * English-only and a sixty-page manual would have carried 360 explicit nulls.
 *
 * Two of its fields are `T | null` and present rather than omitted, `AssetRecord.lqip`
 * and `PageRecord.since`, and each says why where it is declared. Neither is an
 * exception to the rule: there the null is a measured answer, no thumbnail was
 * generated and the page is not version-gated, rather than the absence of an answer.
 */

export * from './ast.js';
export * from './diagnostics.js';
export * from './exact.js';
export * from './frontmatter.js';
export * from './lint.js';
export * from './locales.js';
export * from './manifest.js';
export * from './nav.js';
export * from './page.js';
export * from './project.js';
export * from './search.js';
export * from './site.js';
export * from './slug.js';
export * from './source.js';
export * from './theme.js';
