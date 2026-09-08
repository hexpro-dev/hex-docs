# hex-docs

A reusable documentation package for Hex Pro.

Documentation source lives in each app's own repository. A GitHub Action compiles it
and publishes a bundle to S3 keyed by commit sha. The consuming website labels a sha
as a version, and unlabelled shas are invisible, which is what stops every typo fix
becoming a version bump.

The repository is public so that a `git submodule` checkout needs no token. It is not
published to any registry and neither half is installable from npm.

## Two halves

**The root** is the runtime: a React renderer, the search client, route derivation and
the UI strings. It has **zero runtime dependencies**, is consumed as TypeScript source
through a `tsconfig` `paths` entry, and a guard fails the build if a bare import ever
appears in it.

**`kit/`** is the toolchain: the `hexdocs` CLI, the MCP server, the compiler and the
JSON Schemas. It has its own `package.json` and lockfile, installs its own
`node_modules`, and is never imported by a website.

**`fixtures/`** is neither. It is the corpus both suites read, and no website ever sees
it.

## Where it mounts

| Repository                                 | Path                    | Role                        |
| ------------------------------------------ | ----------------------- | --------------------------- |
| `hex-web`                                  | `common/docs`           | consumer                    |
| `kcalc-ai`                                 | `kcalc-web/docs`        | consumer and content source |
| `hex-nfc`, `sol-alarm`, `nepali-companion` | `hex-docs/` at the root | content source              |

## Working on it

```bash
pnpm install
pnpm --dir kit install

pnpm verify        # typecheck, both suites, both guards, formatting
pnpm test          # the runtime half
pnpm test:kit      # the toolchain half
pnpm schemas       # regenerate kit/schema from the Zod schemas
```

`pnpm verify` is the one command that answers whether the repository is in a good
state. Every row it prints carries a count of what that step examined, and a step that
could not run says so rather than being left out.

## The contracts

Every shape this package reads or writes is declared twice: as a TypeScript type in
`src/contracts/`, which the runtime reads with no dependencies, and as a Zod schema in
`kit/src/contracts/`, which validates it at publish time.

`kit/src/contracts/drift.ts` asserts the two are identical, in both directions,
including optionality. It runs as part of `tsc --noEmit`, so a schema that stopped
matching its type fails the same command that catches a syntax error, and the error
names the field:

```
error TS2344: Type '"drift: \"released\" is only in the second type"'
  does not satisfy the constraint 'true'.
```

## The fixture corpus

`fixtures/app` is a synthetic app repository in all seven languages, and both suites
read it. It is what stops the compiler and the renderer drifting apart: everything they
rely on is declared in `fixtures/corpus.ts` and `fixtures/nodes.ts` rather than
discovered on disk, and the suites check the declaration against the tree in both
directions.

It is deliberately uneven. A page in every language, a page in three, a page in one, a
page whose translations are stale, a Spanish page that was scaffolded and never
translated, a draft excluded from the bundle but still linted, and a page published but
hidden from the sidebar. `fixtures/README.md` says what each one is for.

Staleness is replayed rather than asserted: `materialiseCorpus()` builds a throwaway git
repository with the commit dates the corpus declares, because a tree committed in one go
has no stale page in it and no way to grow one.

## The compiler

`kit/src/compile/` turns an app repository's `docs/` tree into a bundle: markdown to
AST, lint, link and orphan checks, one search index per language, and the objects the
bundle is made of.

```ts
import { buildBundle } from './kit/src/compile/build.js';
import { writeBundle, verifyBundle } from './kit/src/compile/bundle.js';

const result = buildBundle('/path/to/app', { generator: '@hex-pro/docs-kit@0.1.0' });
const { prefix } = writeBundle('/tmp/bundle', result.manifest, result.objects);
const rows = verifyBundle(prefix);
```

A build always produces a bundle and returns the findings beside it. Refusing to publish
is the publisher's decision, not the compiler's, which is why the fixture corpus can
carry deliberate errors and still compile.

The markdown parser is hand written over the subset the AST can carry, and refuses
anything else by name with a line number. `CLAUDE.md` says what is deliberately absent
and why each omission otherwise reads as a bug.

`kit/test/golden/` holds every compiled page in every language, the manifest and the
whole findings list. `UPDATE_GOLDEN=1 pnpm --dir kit test golden` rewrites them, and
reading the diff is the point of them existing.

## Status

The contracts, the scaffolding, the fixture corpus and the compiler are in place. The
renderer, the CLI, the MCP server, the infrastructure and the first wired site are not
yet built.
