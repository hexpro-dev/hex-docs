# CLAUDE.md

Guidance for Claude Code working in `hex-docs`.

## What this is

A reusable documentation package for Hex Pro. Documentation source lives in each app's
own repository, a GitHub Action publishes a compiled bundle to S3 keyed by commit sha,
and the consuming website labels a sha as a version. Unlabelled shas are invisible.

Two halves in one repo, consumed as a **git submodule** (no npm registry):

- **the root** (`package.json`, `src/`) is the runtime: a React renderer, the search
  client, route derivation and the UI strings. It has **zero runtime dependencies**, is
  consumed as TypeScript source through a `tsconfig` `paths` entry, and a CI gate fails
  the build if a `dependencies` entry ever appears.
- **`kit/`** is the toolchain: the `hexdocs` CLI, the MCP server, the bundled skills and
  the JSON Schemas. It has its own `package.json` and lockfile, installs its own
  `node_modules` on first run, and is never imported by a website.

The approved plan is `~/.claude/plans/i-have-need-for-indexed-russell.md`. The
eight-dimension design pass and its adversarial critique are in `.design/` (untracked);
read `.design/README.md` first, because a substantial number of those documents' claims
were overturned.

## Where it mounts

| Repo                                       | Path                         | Role                                                                                                                                 |
| ------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `hex-web`                                  | `common/docs`                | consumer. Excluded from the pnpm workspace, wired through `tsconfig` `paths`, listed in `deploy.config.json` `hash.extra_dirs.front` |
| `kcalc-ai`                                 | `kcalc-web/docs`             | consumer and content source                                                                                                          |
| `hex-nfc`, `sol-alarm`, `nepali-companion` | `hex-docs/` at the repo root | content source only; mirrors how `hex-terraform/` is mounted                                                                         |

## Verified facts about the consumers

These cost real effort to establish and several of them overturned an earlier design.
Do not re-derive them, and do not assume the opposite.

### The consumers are not the same

`hex-web/apps/front` is React Router 7.12 framework mode (SSR), React 19.2, Vite 7,
Tailwind v4 CSS-first, with `@hex-pro/i18n` and framer-motion. `kcalc-web/front` is the
same template diverged: identical React, React Router, Vite and Tailwind versions, the
same seven languages and the same URL scheme, but **no i18next, no shadcn, no
framer-motion**, and its locales live at `app/locales/<lang>/<page>.json` rather than in
a shared package.

**The only safe shared assumptions are React 19 + React Router 7 + Tailwind v4.**
Never depend on `@hex-pro/ui`, `@hex-pro/i18n`, `i18next` or `framer-motion`. This
package ships its own UI strings in all seven languages.

### There is no CI on hex-web or on kcalc-ai

No `.github/` directory in either. Every guard is a hand-run zero-dependency `.mjs` in
`apps/front/scripts/`, each carrying the comment "There is no CI on this repository."

The one thing that always runs is `prebuild`. Verified: pnpm 10.28.0 fires `prebuild`
automatically, and `hex-terraform/deploy/src/build.ts` runs `pnpm build` **on the host**
before the Docker build, so the network and the submodule are available there. The
container's own `npm install --ignore-scripts` never re-runs it. That is why the docs
guard hangs off `prebuild` and not off a script somebody has to remember.

### CSP

`default-src 'none'` with a per-request 128-bit nonce, `connect-src 'self'`,
`img-src 'self' blob: data:`, `script-src 'self' 'nonce-…' 'wasm-unsafe-eval'`. Minted in
`root.tsx`'s loader, re-emitted by its `headers` export, and read back out of the header
by `entry.server.tsx` to pass to `<ServerRouter nonce>`. Without that nonce the page
renders and never hydrates.

**Never export `headers` from a docs route.** React Router copies only `Set-Cookie` from
`parentHeaders` into a child's headers, so a child `headers` export ships docs pages with
no `Content-Security-Policy` and no nonce.

**Never widen `connect-src`.** Everything the browser fetches is a static file from the
consuming site's own origin, which is what the build-time prefetch exists to guarantee.

### root.tsx owns the canonical and the hreflang set

`root.tsx` writes `<link rel="canonical">` and all eight alternates as plain JSX inside
`Layout`, above `<Meta />`, gated on `isLocalisedPath(path)`. React Router's `meta()` can
append tags, never delete them, so a docs route cannot correct its own canonical.

Consequence: **the docs slug list must be a build input.** `hexdocs sync` writes it into
`<project>.docs.json` and `LOCALISED_PATHS` is derived from it. A slug list that only
existed at runtime would put a self-referential canonical plus eight alternates pointing
at eight 404s on every mistyped docs URL.

`isLocalisedPath` has a second caller, `preferredLanguageRedirect` in
`lib/i18n.server.ts`, which cookie-redirects any bare path it accepts.

### Resource routes bypass parent loaders

A leaf match with no default export is dispatched to `queryRoute`, which runs that one
route's loader and no parent's. `routes/lang.tsx` does all its language validation in its
loader, so a machine endpoint mounted under `:lang` answers
`GET /banana/hex-nfc/docs/llms.txt` with a 200.

Mount `llms.txt`, the raw markdown tree and the JSON index **top-level**, beside
`robots.txt` and `sitemap.xml`, carrying the language as a segment the route validates
itself with `matchLanguage()`.

### Route ranking ties break on declaration order

`:slug.json` fails React Router's `/^:[\w-]+$/` test so it scores as a static segment and
ties with `search.json`. Probed against the installed 7.12: declaring `:slug.json` first
makes `/…/search.json` resolve to it with `{slug: "search"}`. Declare every static-suffix
pattern before any `:slug.*` pattern, and pin it with a route-table test.

### The deployment

`hex-web` and `kcalc-ai` both vendor the same `hex-terraform` submodule and deploy with
`./deploy.sh <env>`. The web tier runs as **Docker Compose on a self-hosted box** behind
a cloudflared tunnel, not on ECS. AWS holds ECR, Secrets Manager, Terraform state and the
media buckets. Profile `hex-pro`, region `ap-southeast-2`.

This repository is public. The account id, the deploy host alias and the bucket name stay
in the private repos that already need them, and nothing here repeats one. The Terraform
in step 6 is parameterised for the same reason.

`hex-terraform/dockerfiles/frontend.Dockerfile` copies `build/` and `package.json` and
nothing else. Anything generated outside `build/` does not reach production. Vite copies
`public/` into `build/client/`, which is why docs images go there.

The front container gets exactly three read-only volumes (`compose.ts` `credsVolumes`)
and none of them is `/data`. There is no config key that adds a fourth, so a disk cache
would write into the container's own layer and vanish on redeploy.

Change detection is hash-based over project directories. A submodule not listed in
`deploy.config.json` `hash.extra_dirs.front` leaves the hash unchanged, the deploy
reports "unchanged", and production keeps serving the old code.
`apps/front/scripts/check-tools.mjs` already asserts exactly this for the two existing
submodules, along with `.gitmodules`, the `pnpm-workspace.yaml` exclusion and the
`tsconfig` path. Copy that shape.

### hex-nfc

Remote `git@github.com:hexpro-dev/hex-nfc.git`. Zero git tags, `MARKETING_VERSION` 1.0,
nothing released. `docs/public/` holds three engineering documents; `docs/internal/`
holds App Store review-risk strategy, export-compliance classification, competitor naming
and a device UDID.

**`docs/internal/` is protected by absence, not by a guard.** `scripts/sync-public.sh`
has a copy-in `ALLOW_PATHS` listing `docs/public`, and `prune_internal_files()` only
matches `CLAUDE.md`, `AGENTS.md`, `.claude` and `.agents` by name. Widening that entry to
`docs/` would push the internal tree to a public repo and nothing would catch it. Add
exactly `docs/site`, never `docs`, and assert that no bare `docs` entry exists.

The publish workflow is deliberately **not** allowlisted: it names the bucket and the
publisher role.

`.claude/` is gitignored there by policy, so skills wiring cannot be committed. `.mcp.json`
can be. That is why the MCP server exposes `list_skills` and `get_skill`.

App strings are `app/HexNFC/Localizable.xcstrings`, 468 keys, `sourceLanguage` `en`,
fully translated into `ar es fr ja pt-BR zh-Hans` (2796 translated string units, two
keys using `variations` rather than a top-level unit). Note `zh-Hans` there against `zh` on the web, and an orphan
`hi` App Store listing with no app strings behind it.

**`73b7be1ed9a1361bad35091207610e4f331493cf`, the commit cited as the first version,
touches only `marketing/`.** Nine of roughly a hundred main commits touch `docs/public`.
Release commits are precisely the commits least likely to be docs commits, which is why
the publish workflow has no `paths:` filter.

### The seven languages

`en zh ar es ja fr pt-BR`. English is unprefixed, `/en/…` 301s to bare, `/pt-br/…` 301s
to `/pt-BR/…`, `ar` is RTL. The language comes from the URL and nothing else. Normalise
`zh-Hans` to `zh` and `pt_BR` to `pt-BR` at the boundary and reject `hi` loudly.

`check-locales.mjs` compares all seven files key for key **in both directions**, so any
chrome key this package needs would be fourteen mandatory edits in the consumer. It needs
none: UI strings ship inside the package and the nav label lives in the project config.

## Contract decisions (step 1)

These were settled against the real corpus and the adversarial pass. They are not
preferences, and each one closes a failure the alternative left open.

### The AST is sized to the corpus, not to imagination

Twenty-two node types: ten block, nine inline, three child-only, pinned to their
unions by `AssertCovers` in `src/contracts/ast.ts` so a type added to one and not the
other fails the typecheck by name.

**Deferred to `ast-2`, deliberately:** math, mermaid diagrams, footnotes and
`<details>`. The real corpus is 59 markdown files with zero of any of them. Math also
cannot use `$…$` as a delimiter: "A$9.99 per month or A$6.99" in kcalc's terms and
`$0.createdAt > $1` in a Swift snippet would both render as equations. Mermaid needs a
real DOM for text measurement, so it means headless Chromium in the publish workflow
for zero diagrams. Adding any of them bumps `AST_VERSION`, which costs one additive
recompile and one submodule bump, and that cheapness is the whole reason the `ast-N`
key namespace exists.

**`status` is a node type**, because `chip-support-matrix.md` carries 86 status glyphs
that are data rather than decoration. Left as text they make a screen reader say "white
heavy check mark" in seven languages, make a search for "supported" match nothing, and
force the decorative-unicode rule to grow an exception it cannot express. Authors keep
typing the glyph, so the source still reads correctly on GitHub.

**`Heading` carries `idSource` and `aliases`.** Two anchor conventions are already in
production and are incompatible: engineering docs deep-link `#station-data` from the
heading text, and every legal document depends on `#section-4` derived from the section
number so one anchor addresses the same clause in all seven languages. `aliases` is
what keeps a link alive across a translation and across a rename.

**Soft wraps fold into `TextNode.value`** with the CJK rule `legal-markdown.ts` already
ships: a space unless the characters on _both_ sides are wide. Every corpus file is
hard-wrapped at about 75 columns. Nothing strips U+FE0F or U+200F; both are
load-bearing on the page.

### Two conventions for absence, and the boundary between them

Wire formats the renderer reads (AST, compiled page, manifest, search index) use
optional-and-omitted. Diagnostics an agent reads (`Finding`, the envelopes, the
reports) use `T | null`, always present, because "there is no suggested fix" must not
read the same as "the suggested fix is to delete this".

`PageRecord.locales` is a **partial** record and an absent key means the page does not
exist in that locale; `manifest.locales` is the authority for which languages exist at
all, and `validateManifestShape` cross-checks them. The all-keys-with-explicit-null
alternative was rejected on the day-one case: hex-nfc's first bundle is English-only, so
a sixty-page manual would carry 360 nulls saying nothing.

### Search normalises with NFKC, not the NFC the plan named

Measured: the same product name is spelled `NTAG 210µ` with U+00B5 in the chip matrix
and `NTAG210μ` with U+03BC in the store listing. NFC keeps them distinct. NFKC also
folds the fullwidth forms in the Japanese legal documents and subsumes the compatibility
folding Arabic already required. It is applied to tokeniser input only, and it is
recorded in the index header so a future change is a refusal rather than a silent
mis-query. Folding does not fix a tokenisation difference, so a project spelling a part
number two ways still needs the glossary entry.

### Byte reproducibility needs a header patch, not a gzip option

The bundle digest is taken over the stored bytes, so the same commit has to compress to
the same member or the write-once refusal fires on a re-run that changed nothing.
`GZIP_SETTINGS` states what that member must be, and only `level` is a zlib option.

Measured on Node 22.22, and pinned by `test/contracts/manifest.test.ts`:
`zlib.gzipSync(buf, { level, mtime, os })` and `zlib.gzipSync(buf, { level })` return
byte-identical output. Node has no `os` or `mtime` option and ignores both silently. It
writes byte 9 from the platform it was compiled on, **19 on macOS and 3 on Linux**, so a
writer that spreads the constant into `gzipSync` produces exactly the host-dependent byte
the constant exists to remove. The writer compresses and then patches byte 9 to 255. The
OS field is outside the CRC, which covers the uncompressed data, so the patch is safe and
the test proves it round-trips.

Bytes 4 to 7 are already zero and `gzipSync` sets no FNAME flag, so `mtime: 0` and
`filename: null` are assertions rather than instructions. They are in the object anyway,
because the alternative is a property stated only in prose that a future writer has to
rediscover.

### Guards fail closed, and have no exemptions

A `NOT RUN` row fails the run. That is not a detail: counting only failures is how the
house lint printed "all clear" and exited 0 with every one of its rows dark, which is
what deleting the generated rule pack does, and CI runs nothing but the exit code.
`SKIPPED` is the separate state for a deliberate, explained non-run, and it still
passes.

There is exactly one exception mechanism in the repository, and its shape is the point.
The fixture corpus has to contain an em dash, a rightwards arrow and two banned emoji,
because those are what the linter's rules exist to catch and what the `status` node
exists to recognise. Taking `fixtures/` out of the house lint to get them past it would
be the ordinary kind of exemption. Instead `fixtures/planted.json` names each file, each
code point and the reason; `scripts/lint.mjs` reads it; and the check runs **in both
directions**. An undeclared hit fails, and a declared pair whose character is no longer
present fails too. That second half is the one worth having: a planted character quietly
deleted leaves the rule it was the only coverage for untested, with every row green.
Every declared path must be under `fixtures/`, so the mechanism cannot reach real source,
and a group whose `why` is shorter than a sentence is refused as an exemption nobody
decided on.

Every step of `pnpm verify` measures what it examined rather than asserting it. The
typecheck step counted a literal `3` until `-p kit/tsconfig.json` was dropped from the
script and it went on reporting three configurations; that third one is the only thing
that compiles the drift assertions, which have no runtime statements and no test
importing them.

Measuring is not sufficient on its own, which is the second half of the same lesson. The
typecheck row then reported **two** configurations and still passed, because a smaller
count is not a failing count. A step whose coverage is knowable carries an `expect`
alongside its `count`, derived from the filesystem rather than a literal, and a shortfall
is a failure naming what should have run. `scripts/lint.mjs` has the same shape from the
other side: `REQUIRED_DIRS` is cross-checked against the directories actually on disk, so
deleting `.github` from the list fails instead of quietly taking the publish workflow out
of the lint.

### The trick that makes no-exemptions possible

Tests live in `test/`, not beside the code, which is what lets `check-imports.mjs`
allow nothing under `src/` to import anything a consumer will not have.

Banned characters are declared as **code points**, and the pattern is derived from that
list. A literal set would flag the line that declares it, and an exemption for "the file
that declares the rule" is the hole that later swallows a real hit. The same trick keeps
test fixtures clean: an em dash in a fixture is written `\u2014`, and the attribution
patterns carry a one-character class (`C[l]aude`) so the guard does not match itself.

The rule pack is emitted to `kit/schema/house-rules.json` so a zero-dependency `.mjs`
can read it. `scripts/lint.mjs` does; `check-locales.mjs` in hex-web should, instead of
re-deriving its set from a CLAUDE.md.

### The drift check

`kit/src/contracts/drift.ts` asserts every Zod schema's inferred output equals its
hand-written twin, invariantly, in both directions. The failure type is built from
template literals rather than a named alias, because TypeScript prints an unresolved
alias by name and would dump both whole types while naming neither key. It reads
`drift: "released" is only in the second type`.

Three things it does **not** prove, each closed elsewhere, and none of them safe to
assume:

**A union comparison can collapse to `never`.** `keyof` a union is the intersection of
its members' keys, so two unions differing in a member can produce three empty key
unions, and `Expect<never>` compiles because `never` is assignable to everything. Every
union contract therefore uses `AssertExactUnion`, and `AssertExact` falls back to a
literal rather than to `never`.

**A container's children are typed by annotation.** `inlineArray()` returning `z.any()`
typechecks and leaves the entire tree below the top node unvalidated. The seam-identity
and rejected-child tests in `kit/test/contracts/ast.schema.test.ts` are the only guard.

**A schema constraint is invisible to it.** `z.string()` and `z.string().regex(…)` both
infer `string`, so dropping a regex leaves the gate green.
`kit/test/contracts/constraint-sweep.test.ts` holds the constraints whose loss would
ship something wrong, and it is not every constraint in the package.

`kit/test/contracts/drift-coverage.test.ts` fails when a schema is added without an
assertion, matches the whole `Expect<AssertExact<…>>` wrapper rather than the schema
name, and carries a reason per exemption. Its bulk exemption tests what a schema
**validates**, unwrapping to a `ZodString` or `ZodNumber`, not which module it is
exported from. Exempting the whole of `primitives.ts` read as an explicit list and
behaved as a heuristic: a `z.strictObject` added to that file was auto-exempted with a
canned reason saying it refines a string.

There is a fourth thing it does not prove, worth stating separately because it is a
property of `AssertExactUnion` rather than of the drift check. A member that only gains
or loses an **optional** field is still assignable in both directions, so `Exclude` drops
it and the union form prints `{ onlyInFirst: never; onlyInSecond: never }`, naming
nothing. The per-member object assertions are what name the key. Measured, not assumed:
adding `order?: number` to `navGroupSchema` produces exactly that from the union
assertion and `drift: "order" is only in the first type` from the object one.

### Naming, so the two configs are never confused

`DocsProjectConfig` is `docs/site/docs.json` in the app repository. `DocsSiteConfig` is
`<project>.docs.json` in the web repository. Neither is a partial of the other. Theme
tokens are `--hx-*`, read at the point of use, never aliased at `:root`, and
`--hx-accent-link` is separate from `--hx-accent` because `#0b76d9` on the void ground
measures 4.23:1, which clears the 3:1 a control needs and misses the 4.5:1 an inline
link needs.

## Source spellings (step 2)

`src/contracts/source.ts` holds what an author types, as against `ast.ts`, which holds
what the renderer switches on. It exists because two parties have to agree about the
same characters: the compiler recognises them, and the linter has to know which of them
are data before it decides whether a character is decoration. A table private to the
parser would mean the two had separate ideas of which check mark was content.

**Status glyphs came out of the real corpus, not out of imagination.** A census of
`hex-nfc/docs/public/` counts 59 U+2705, 16 U+26A0 every one followed by U+FE0F, and 11
U+274C, which is exactly the 86 the design records. The fourth spelling is the one that
matters: **"not applicable" is written as a U+2014 EM DASH**, a character the house rules
ban outright and this package's own lint would reject in its own source. So the glyph
table carries a scope, and the em dash is recognised **only as the entire content of a
table cell**. Anywhere else it is a violation. Without that restriction the status node
would hand every author a one-character way to write an em dash that no prose rule can
see.

**Recognising a glyph means scanning, not comparing.** `statusAt(text, index, scope)` is
the form the compiler needs, because the corpus has a status glyph in the middle of a
sentence. The longest-first ordering is load-bearing there and only there: matched bare
first, U+26A0 U+FE0F consumes one code point and strands the variation selector as a
one-character text node beside the status. An earlier draft had the ordering and only a
whole-string equality compare, so the ordering could not change any answer and the comment
claiming it protected the variation selector was describing a scanner the module did not
contain.

**Directives are remark-directive's grammar, not an invented one, and the label is
bracketed.** Three or more colons and a name opens a container, `[label]` carries its
argument, a line of the same width closes it, nesting adds a colon to the outer marker,
and `::name[argument]` is a leaf. The names are derived from `CALLOUT_KINDS` plus `steps`,
`step`, `figure` and `table`, so a callout kind added to the union without being added to
the parser fails the typecheck.

The bracket is not cosmetic. The first draft took a bare argument, `:::note Background
scanning`, while the comment claimed the grammar was borrowed rather than invented. To
remark-directive that line is a paragraph, so every titled container in the corpus would
have compiled to nothing under the extension being cited. Borrowing a real extension's
spelling costs nothing and means the source renders on GitHub as visible literal markers
rather than as nothing, which is the honest failure for a page a developer reads in the
GitHub UI before it is ever published.

`figure` and `table` take their caption as the bracketed label rather than as the
container's last paragraph, because the paragraph form is ambiguous with the prose that
follows a table and the ambiguity only shows up as a missing sentence on a published page.

**A fence info string is parsed, not scanned.** Options are `title=`, `lineNumbers`,
`start=`, `highlight=` and `wrap`, each declaring the field it sets and whether it takes a
value. `parseFenceInfo` walks the string with a cursor and reports every span no option
consumed, which is the difference between it and the `matchAll` scan it replaces: that one
skipped anything that did not look like an option name, so ` ```swift 2,5-7 ` parsed
as a fence with no options and no problems and the author's intent vanished with no sign it
had been there. Arity is checked too, because `lineNumbers=yes` and a bare `title` both
used to parse.

## The fixture corpus (step 2)

`fixtures/app` is a synthetic app repository in all seven languages, and both suites read
it. `fixtures/README.md` is the file to read first; what follows is what would otherwise
be rediscovered.

**The corpus is deliberately not uniform.** A page in every language, a page in three, a
page in one, a page whose translations are stale, a page whose Spanish file was scaffolded
and never translated, a draft that is excluded from a bundle and still linted, and a page
that is published but hidden from the sidebar. Each is a state that produces a different
notice or a different coverage column, and none is testable against a corpus where every
page is the same.

**The history is replayed, not asserted.** Translation staleness is
`git log -1 --format=%cI` on the English file against the translation, so a corpus
committed in one go contains no stale page and cannot grow one: every file carries the
same date and the whole tree reads `current`. That is the shallow-clone failure reproduced
by accident. `materialiseCorpus()` copies the tree into a throwaway repository and replays
the declared commit dates. Two files are revised by a later commit, which means the first
commit has to write something different for them or the revising commit is empty and
`git log -1` never moves; the materialiser writes a placeholder and then checks the
finished tree byte for byte against the corpus on disk, comparing bytes rather than
decoded text so that the check covers the PNG.

The Spanish chip matrix is committed **after** the English source on purpose, so
timestamps alone call it current and only `translated: false` says otherwise. That is the
hole the flag exists to close, reproduced rather than described.

**No golden ASTs, on purpose.** They belong to step 3. The canonical JSON a digest is
taken over, the word count behind the reading estimate and the exact scope tokens a
highlighter emits are none of them decidable from the source and the contracts alone.
Hand-authoring them now would be inventing the compiler's answers before writing the
compiler, and checking those inventions in as golden files that look like evidence.

**The corpus markdown is excluded from Prettier**, with the reason in `.prettierignore`.
Prettier rewrites markdown rather than only spacing it: `*emphasis*` becomes `_emphasis_`,
table pipes are realigned and blank lines move around lists. Every one of those is a
construct under test. The house lint still reads every one of those files.

**`fixtures/nodes.ts` claims every AST node type against a page and a source pattern**,
and the suite fails when a node type has no claim, when a claimed file is gone, or when a
claimed pattern stops matching. Without it a page gets rewritten, the construct goes with
it, the golden test still passes against whatever the page now says, and one node type
quietly stops being exercised anywhere.

Type coverage alone is not enough, and this is the same lesson as counting: it is
satisfied by one claim per type, so 29 of the 51 claims were deletable with both suites
green, including every one whose own reason says it is the sole coverage of something.
`REQUIRED_VARIANTS` is the second list, checked against the claims in both directions, so
a deleted claim fails naming the variant.

**The declared translation states are swept against git, not spot-checked.** Three pairs
were checked by name at first and the other thirty-odd `current` declarations were
decorative: the table could have said the opposite of the replayed history and nothing
would have noticed. Every declared page-locale and snippet-locale pair now derives its
expected relation from its state, and the sweep asserts all four states appear.

**`fixtures/frontmatter.ts` refuses by name.** It is a deliberately narrow YAML subset and
its whole contract is that it must never quietly reinterpret: a reader that accepted
`title: a: b` as the string "a: b" would make the corpus pass while teaching a shape the
compiler's parser rejects. Every refusal names the construct and what YAML would have done
with it, and a table of refused shapes is in the suite.

**What the corpus disproved on its first run, which is the whole argument for building
it before the compiler.** `frontMatterSchema` required a title of at least three
characters, and the constraint sweep carried a row saying "a two-character title is a
mistake, not a title". The Chinese guide came back titled 指南. It is two characters and
it is correct: a floor measured in characters is a floor on Latin, which is the same
reasoning `description` already carried, rediscovered on the field nobody had applied it
to. The floor is now non-empty and nothing more.

The corpus also settled a question the contracts left implicit. **A link is a slug, and
a slug is resolved against the source locale**, not the linking page's. The Arabic
reference index links to a page nobody has translated, and that link is correct: the page
exists in the bundle and the site serves the English fallback with a notice and
`noindex`. Resolving against the linking locale would call `graceful` parity's normal
state a broken link.

**`fixtures/text.ts` measures the normalisation the search index depends on.** Until it
existed, `INDEX_NORMALISATION` said NFKC, the comment said why, and NFC would have passed
every test in the repository. The table records what NFC and NFKC each do with ten
spellings, including three that neither form folds, which is what says the tokeniser has
to do the Arabic work itself rather than leaning on normalisation.

## The compiler (step 3)

`kit/src/compile/` turns the tree into a bundle: markdown to AST, lint, link and orphan
checks, the search index, the bundle writer. `kit/test/golden/` is what pins it. What
follows is what would otherwise be rediscovered.

### The parser is hand written, over the subset the AST can carry

Not remark. Three reasons, and the first is decisive: `src/contracts/source.ts` already
declares the grammar as patterns, so a library parser would leave that table unused and
the two would drift. A parser that accepted more than the AST can carry would be
producing nodes with nowhere to go. And a refusal has to be a **named finding with a
line**, not a silently dropped block, which is what `unsupported-syntax` exists for.

Deliberately absent, each because it otherwise reads as a bug rather than a decision:
setext headings (there is one heading spelling and a page's title is front matter, so
`---` is always a thematic break), indented code blocks (four spaces is list
continuation here, and supporting both puts every deep continuation line one stray
space from becoming code), HTML blocks (there is no `html` node; raw HTML stays literal
text and `no-raw-html` reports it, which is what makes "no `dangerouslySetInnerHTML`
anywhere" structural), and link reference definitions and footnotes.

The one place it is deliberately unlike CommonMark: an underscore only opens emphasis
when the character outside it is not alphanumeric, so `FIXTURE_TAG_LOG` and
`session(_:didConnect:)` stay literal in a technical corpus.

### Positions live beside the tree, and prose is extracted once

The AST has no line numbers, because it is a wire format read by a renderer that has no
source. The parser records where each node came from in a `WeakMap` keyed by the node,
so a position field is never published and a node the map has not seen is honestly
unknown.

`ProseSegment` is the other half and it is what makes the house-style rules possible at
all. It is one block's text with the markup gone, the inline code gone, code fences
never present and **recognised status glyphs already absent**, soft wraps folded with
the CJK joiner, plus the runs that say which source line every character came from. So
a banned phrase that straddles a soft wrap is found, `no-decorative-unicode` sees the
tick that is decoration and not the 59 that are a support matrix, and a match at offset
41 of a folded paragraph reports line 12, column 3.

### Two constraints the corpus disproved by compiling

Both are the same shape as the three-character title floor that step 2 disproved.

**The anchor pattern was ASCII.** `anchorSchema` was `[a-z0-9]`, and every heading on
every Chinese, Japanese and Arabic page was refused the first time the compiler ran over
the corpus. An id derived from heading text is locale-dependent by construction, which
`ast.ts` says outright and which `aliases` exists to cope with, so ASCII was not a
stricter version of the rule but a rule that cannot be satisfied in four of the seven
languages. It now allows letters in any script. The alternative, a positional
`section-3` fallback for non-Latin headings, was rejected because it makes every anchor
below an inserted heading change, and stability is the whole reason the ids exist.

**`glossary-term-translated` used word boundaries.** It reported every correctly
translated Chinese page as having dropped `NDEF`, because CJK has no spaces and the
character after the term is a letter. Presence in a translation is now substring
containment; the source side keeps word boundaries, where they are right.

### The state a reader sees is not the state the manifest counts

`PageLocaleRecord.state` is the page's own state and `coverage` counts it, because a
translator needs to know which files to open. `CompiledPage.translation.state` is the
effective state, the worst of the page and every snippet it transcludes, because a
current page full of stale snippets is not current to a reader. Both contracts now say
so where they are declared.

The consequence is worth knowing before it surprises somebody: a page can be `stale`
with a `translationUpdated` **later** than its `sourceUpdated`, because the timestamps
are the page's own and the state is not. `index` in `zh` is exactly that, which is what
the corpus says that page is for.

Two independent things set `scaffolded`, and either alone is enough: the `translated:
false` flag, and the body text being byte for byte the source's. Timestamps can see
neither, because a scaffolded file is committed after the source it copies.

### Snippets are linted once, and parsed per page

A snippet is parsed fresh for every page that includes it, so its nodes land in that
page's origins map and a finding on a transcluded block points at the snippet's own file
and line. Its prose and its own problems are dropped there and collected once, from a
separate parse of the file itself. Without that split a banned phrase in a fragment is
reported once per including page, and the count in the report is a count of pages rather
than of problems.

Snippet links resolve as if the snippet sat at `content/<locale>/`, not relative to the
including page, because a fragment included from two directories cannot have two right
answers.

### The front matter reader is narrow, and cross-checked

Not a YAML parser, which `fixtures/frontmatter.ts` originally said it would be. A
general parser plus a schema error says "expected string, received boolean" where a
narrow reader says "`title: yes` is YAML's boolean true, quote it", and the toolchain
half stays dependency-light. The risk a real parser was protecting against is two
readers that quietly disagree, and what closes that is a test asserting this reader and
the fixture corpus reader agree on every file in the corpus, in both the values and the
refusals.

### What the writer does and does not decide

`buildBundle` always produces a bundle, even when the lint has errors, and returns the
envelope beside it. Refusing is the publisher's job. The fixture corpus carries seven
planted errors on purpose and still has to compile, which is the case that makes the
split obvious.

`AssetRecord.lqip` is `null`, always, in this version. Every encoder available here is a
shell out to ffmpeg or cwebp, whose output varies by build, and the manifest has to be
byte-reproducible from the commit alone or the write-once refusal fires on a re-run that
changed nothing. It is the same reasoning that makes a Display P3 asset a refusal rather
than a conversion. A deterministic encoder written in this repository would qualify.

Git is read in **one walk**, not one `git log -1` per file: a fourteen-hundred-file
project would otherwise spawn fourteen hundred processes on a runner for the same
answer. `kit/test/compile/project.test.ts` asserts the equivalence against per-file
calls rather than assuming it.

### Golden files

`kit/test/golden/` holds every compiled page in every locale, the manifest, the whole
findings list, the English term dictionary and the raw markdown of the three pages that
expand an include. `UPDATE_GOLDEN=1` rewrites them; read the diff.

**Every golden file is written with non-ASCII escaped as `\uXXXX`.** The house lint
reads every file in this repository and a compiled page carries the en dash, the em dash
and the arrow the corpus plants on purpose; the exemption mechanism is scoped to
`fixtures/` and widening it to reach a test directory would be the hole it exists to
refuse. The better reason is the second one: a golden file is the one place an invisible
character has to be visible, and U+FE0F and U+200F are load-bearing in this corpus.

The English dictionary is goldened and the other six are not. A dictionary of Chinese
bigrams written as escapes is not something a reviewer can read, so those are pinned
numerically by the manifest's per-locale term count and index digest, and readably by
the smoke queries, which are ten real phrases per language that must each return a hit.

### What the adversarial review changed

Forty-nine agents over six dimensions, each finding attacked by an independent skeptic:
43 findings, 41 confirmed. The ones worth knowing before touching this code again, because
each was green in 1633 tests and none of them is visible from the corpus.

**Three parser defects that ordinary English triggers.** `readDestination` advanced its
cursor with the emphasis flanking predicate, which counts the end of the text as
whitespace, so `Press [Enter] now.` did not hang the compiler in the sense of throwing:
it produced no output at all until something killed it. It also never checked that the
character after a `]` was a `(`, so a bracketed phrase became a link to a page nobody
named, and `The tag ID (see [chip matrix] below) is printed` refused to publish. And the
emphasis recursion published its own delimiters: `***important***` rendered a literal
asterisk inside the bold. The fixes are a separate `isBlank` for cursor advancement, a
one-line guard, a run of three meaning emphasis-wrapping-strong, and a descend into the
span a declined run opens. That descend is exponential without its memo, which is why
`EmphasisCache` exists and is not an optimisation.

**Two lists that had to be one.** The search index was built from `published` and the page
records from the same set minus the slugs with no source-locale file, so a French-only
page was searchable and had no payload behind it. And `assetBytes` was keyed by digest
while the records were pushed per path, so one file under two names produced two records
and one object key twice, under a comment claiming the opposite.

**The deny scan read prose only.** A `ProseSegment` has inline code removed and fences
never present, which is right for every house-style rule and exactly wrong for the rule
that stands between a device UDID and a public mirror. It now reads the raw source lines
as well, and `DenyList`'s contract says which two inputs and why. An empty deny list is
refused out loud for the same reason an absent one always was.

**Nine rule arms could be deleted with the suite green.** `kit/test/compile/rules-fire.test.ts`
is the answer and it is the highest-value file in the package: every rule in
`LINT_RULE_IDS` is claimed by a case, the union is checked against the contract in both
directions, and a multi-arm rule claims each arm by the message only that arm produces.
`registry.test.ts`'s `DESCRIBED` bucket used to assert a sentence about what covered a
rule; most of those sentences named the corpus and the corpus trips none of them.

**The git walk was wrong for exactly one commit shape.** `--name-only` prints no file
names for a merge, so a source page resolved in a merge's own conflict resolution was
dated four months early and six stale translations read `current`. `--diff-merges=combined`
matches `git log -1` on both that case and the side-branch-only case; `--first-parent`
matches only the first and gets the second wrong in the dangerous direction. The
equivalence test now has a merge in it, because a linear fixture history cannot show any
of this.

**`summary.passing` is not a coverage measure**, and the contract now says so rather than
claiming the opposite. Making it one means every rule declaring what it had to examine and
a third state in the envelope for a rule with nothing to look at, which is a design change
rather than a bug fix. The one case where the distinction actually bit is closed at the
rule.

Smaller, and each with the reasoning at the code: the tokeniser classified CJK punctuation
as a word character (`TOKENISER_VERSION` is 2 because of it), prefix expansion summed every
completion instead of taking the best, `stem` was a header field nothing compared, `df`
documented a cross-check that did not exist, the protected-rule constraint was enforced
nowhere despite two comments saying the schema did it, `no-decorative-unicode` was the one
third of the banned-character partition a project could switch off, tree-layout problems
were reported as `unsupported-syntax`, and three pieces of reader-visible text (a link
title, an image title, a fence's `title=`) reached no prose segment at all.

## The renderer (step 4)

`src/render/` is the React half and `src/site/` is the part of the same step that has no
JSX in it. What follows is what would otherwise be rediscovered.

### Two entry points, and the reason is not tidiness

`src/index.ts` stays importable from bare node. `hex-web` imports this package from places
with no bundler at all: its hand-run `.mjs` guards, its sitemap generation and `hexdocs
sync` all run under plain node, where a `.css` specifier throws before anything else
happens. So the barrel re-exports the contracts, the search client, the string tables and
the address rules and stops there, and everything that renders lives behind
`@hex-pro/docs/render`, which is the only module that imports the stylesheet.

`test/render/entrypoints.test.ts` walks the actual import graph rather than trusting the
arrangement, because the failure mode is one convenient re-export added a year from now and
it breaks a build inside a submodule during a deploy.

The stylesheet is imported by the package rather than by the consumer. Both consumers
already use a component-level `import './Foo.css'` and both bundlers turn it into a
code-split chunk linked only on the routes that need it, so a marketing page pays nothing
and the install has no stylesheet step to forget.

### No colour token reads a consumer's palette any more

The chain used to end `var(--color-accent, #0b76d9)`, which made hex-web need no theming
configuration at all. Measured against the second consumer, that is unsafe.
`kcalc-web/front` declares seven of the fifteen host names the table used and stamps
`data-ground="paper"` on every page, where `--color-ink` is `#1f2c26`. A docs page there
would paint `--hx-ink` #1f2c26 on `--hx-ground` #0f0e0d, which is 1.33:1, and its accent
#255745 on the package ground is 2.33:1, which fails the 3:1 a focus ring needs.

A host link is only safe when the whole palette comes from one place and CSS cannot branch
on whether it does. So every colour ships a literal, and the four tokens that keep a host
are the three font stacks and the easing curve, neither of which can fail contrast.
Per-instance theming is unchanged in kind: a consumer sets `--hx-accent` at or above the
docs root and wins.

### The check the theme contract prescribes is not sufficient on its own

`theme.ts` says to render the shell under a theme class and assert the computed accent
differs. Measured: the obvious optimisation, one private alias per token declared on the
docs root so the chain is written once, **passes that check**.

| where the token is rebound | chain at every use site | alias on the docs root |
| -------------------------- | ----------------------- | ---------------------- |
| an ancestor                | themed                  | themed                 |
| the docs root itself       | themed                  | themed                 |
| a descendant               | themed                  | **not themed**         |

So `scripts/check-paint.mjs` carries a descendant probe, and `test/paint.test.ts` drives
the whole check against a stylesheet with the alias deliberately reintroduced and asserts
that exactly one probe fails and it is that one.

Two DOM libraries were measured before that script was written, and neither can do this
job. jsdom does not resolve `var()` at all and hands back the literal text. happy-dom
resolves it **at the point of use**, which is the opposite of what a browser does, so it
returns the correct colour for the broken stylesheet: a theme test written against it is
worse than no test. happy-dom is still used, for the search dialog and the copy button,
where events are the thing under test and CSS is not; the files that use it say so.

Chrome over the DevTools Protocol needs no dependency at all, because Node 22 has a global
`WebSocket`, and GitHub's ubuntu-24.04 image ships Google Chrome and Chromium
preinstalled. The row is `SKIPPED` where no browser is installed and `FAIL` when the same
thing happens with `CI` set, because the runner image has one and a check that went quiet
would take the theming guarantee with it.

### The stylesheet is generated, and the generator is what makes a hard-coded colour impossible

`kit/src/theme/stylesheet.ts` writes `src/render/docs.css` from `THEME_TOKENS` and
`PALETTE`, and `pnpm schemas` regenerates it beside the JSON Schemas and the rule pack. The
only thing in it that can produce a colour is `t()`, which expands a name through
`tokenValue` and throws on a name the tables do not carry. That is the difference between
detecting a hard-coded `#f2ede6` and being unable to write one.

Three rules the generator cannot enforce, each asserted in
`kit/test/theme/stylesheet.test.ts`:

**No `@layer`.** Measured against both consumers: hex-web's `app.css` declares none and has
no bare-element selectors, and kcalc has an `@layer base` that restyles `p` and `h4`. Any
unlayered rule beats every layered one, so a layered docs stylesheet would lose to kcalc's
base and win nothing anywhere.

**No physical properties.** They look right in six languages and wrong in Arabic, and the
build that shows it is the one nobody runs.

**No rule may select on `[data-reduced]`.** The attribute is rendered `false` for the whole
first paint and flips in an effect, so a rule keyed off it is wrong for exactly the readers
it is for. `@media (prefers-reduced-motion: reduce)` needs no JavaScript and is the gate.
The attribute exists so a consumer's own effects can read the same answer.

### The palette is a separate table from the theme tokens

Thirty-one colours: twenty code scopes carried by ten values, five callout kinds and four
status marks. They are in `src/contracts/palette.ts` rather than in `THEME_TOKENS` for a
testing reason. `theme.test.ts` measures every token stating a ratio against the ground and
the surface and pins the covered set in both directions, and a scope colour joining that
sweep would be held to the wrong ground: a fence sits on `--hx-raised`.

Every entry states both a floor and a **measurement**, and the measurement is checked
against the value. That grammar came back into `theme.ts` as well, and it found two wrong
numbers: `dim` said 7.16:1 for a colour that measures 7.39, and `faint` said 3.24:1 for one
that measures 3.47, neither reachable from any pairing of any colour this package or either
consumer ships. They went unchecked because the sweep read `Held to`, and `faint`'s whole
point is that it states no floor.

Colour is never the only channel. `inserted` and `deleted` measure 1.29:1 against each
other, so the fence emits a gutter character; `lint.ts` bans the two glyphs an author would
reach for and no glyph that survives the ban is covered by every font in seven languages,
so a status mark is a CSS shape with a localised accessible name.

### `highlight` indexes the excerpt, and three of four designs read it the other way

`ast.ts` says "1-based line numbers to mark, relative to `startLine`", and that sentence has
been read both ways. It means the numbers count from the top of the fence. The corpus
settles it: `reference/api` writes `start=12 highlight="2,5-7"` over ten lines and means the
guard clause and the three-line constructor call, and `developer/architecture` writes
`start=48 highlight="3,9"` and means the throw and the alertMessage assignment. Adding
`startLine` to the numbers marks nothing at all on either block, which renders as a
perfectly ordinary code block. `test/render/code.test.ts` names both files and both sets of
indices.

### The table of contents and the anchors come from different lists

`page.headings` is what the compiler filtered for a table of contents and the body is what
carries the anchors, and neither substitutes for the other. `en/guide/troubleshooting` has
seven headings in its body and six in `headings`, and the missing one is a depth-4 heading
that is still a real anchor somebody can link to. A table of contents built from the body
shows what the compiler deliberately filtered; anchors built from `headings` leave that
heading unlinkable.

### What step 4 found wrong in step 3

Three defects in the bundle format, each invisible until something tried to render it.

**The manifest's nav could not say which pages are hidden.** `nav.ts` promises a hidden page
stays out of the sidebar, the sitemap and prev/next while remaining published and
indexable, and `ManifestNavNode` carried no flag, so the renderer had no way to honour it.
The corpus has one: `reference/api`. `hidden?: true` is now on the node, the page stays in
the array so `nav` and `llmsOrder` keep answering the same question, and a hidden page gets
neither neighbour rather than the two that surrounded it.

**`ManifestNavNode.children` had no writer.** It could not have been right either: a
`nav.json` group is not a page, so the compiler flattens it, and a group holding two pages
from different sections is a shape no slug hierarchy can express. The sidebar derives its
nesting from the slugs, where a section root is a real page with a real translated title.

**`navTitle` never reached the manifest.** Its whole purpose is the sidebar, the sidebar is
built from the manifest, and the bundle carries no `nav.json`, so the one field that exists
for the sidebar was the one field the sidebar could not see.

`DocsTranslationNotice.requested` was also widened from `string` to `Locale`, because it
names the reader's language in a lookup table that has no key for anything else.

### Decisions that were left implicit and are now written down

- The shell owns the only `h1` and emits **no `<main>`**: both consumers' `root.tsx` already
  renders one, and two is an authoring error a screen reader reports. There is no
  `headingOffset` and there should not be one.
- Five translation states map to three notices. `scaffolded` folds to `fallback`, which is
  the fold `kit/src/compile/search.ts` already applies: the reader is looking at English at
  a Spanish address, which is what a fallback is to them.
- A stale translation stays indexable. It is a real translation of a real page in that
  language, which is not true of the other two causes.
- An AST major this runtime does not know is a refusal from `docsRoute`, not a page of
  skipped nodes. `unhandledNode` stays the last resort it says it is, and there is one more
  thing worth knowing about it: on a long-lived server, once per process is once per deploy.
- The payload gets one small hand-written shape check at the seam. Zod is in `kit/` and this
  half may import only `react`, and the alternative is a truncated JSON file becoming an
  exception inside a React render, which on both consumers client-renders the whole shell.
- A slug the bundle carries and `site.pages` does not is refused. Serving it would ship a
  page with no canonical, no alternates and no `noindex`, and it would render perfectly.
  `pageSkew` names the state at build time.
- Dates are formatted as the ISO date the bundle already stores, and a consumer passes
  `formatDate` to change that. `Intl.DateTimeFormat` answers from whatever ICU the runtime
  was built with, which is a hydration mismatch on a string the reader sees. Plural
  categories and language names are hand-written tables for the same reason.
- A control the script has not reached yet renders **disabled** rather than absent or live.
  A button announced as available that does nothing is worse than no button, and rendering
  it only after hydration moves the layout under the reader.
- The search dialog has exactly one exit, the browser's own `close` event, so Escape, the
  backdrop, the close button and choosing a result all produce one `hexdocs:search-close`.

### Where the interactive behaviour is tested, and why it is not all in one place

The search dialog's keyboard and focus model is a reducer in `src/site/search-state.ts`,
because the two regressions most likely to ship on that surface are transitions rather than
renders: Escape dropping focus to the body, and `aria-activedescendant` still naming a row
that is no longer in the list after a reopen. Both are invisible in a screenshot, fine in a
golden, and one line each in a node test.

`test/render/dom/` drives what is left, under happy-dom, because `renderToStaticMarkup`
produces the markup an `onClick` is attached to and never calls it. The one thing that must
never move into that directory is anything about CSS.

### The render goldens

`test/golden/render/body/` holds eight rendered bodies, each with the reason it was chosen,
and the set is asserted to contain every member of `AST_NODE_TYPES` in both directions: a
corpus edit that moves the only fence out of a goldened page regenerates cleanly and would
otherwise take that arm out of coverage with nothing naming it. Every golden records the
sha256 of the compiled page it was produced from, so an update run over stale kit output
fails naming the file rather than writing the wrong answer into something that then looks
like evidence. `UPDATE_RENDER_GOLDEN=1` rewrites them.

There is no timestamp scan on the goldens. It was tried and refused the wrong thing: the
API reference contains an ISO timestamp as documentation content, and it is as deterministic
as the rest of the page. Rendering each body twice and comparing is the property that scan
was reaching for, and it also catches a random id or an insertion-ordered iteration.

### One thing the design pass said was missing and was not

The runtime search client and the index the toolchain writes were said to have no test
across the seam. They do: `kit/test/compile/search.test.ts` imports `searchIndex` from
`src/search/query.js` and runs 81 smoke queries, ten a language, against indexes
`buildBundle` produced in that same run.

## The CLI and the MCP server (step 5)

`kit/src/registry/` is one flat array and everything else is derived from it.
`kit/src/README.md` carries the failure catalogue, twelve rows of failure, structure,
proving test and the mutation that must turn it red, and a test walks that table. What
follows is what would otherwise be rediscovered.

### The parameter key is the field name, so there is no binder

The design this replaces carried a JSON pointer per argument, `into: '/options/locale'`,
so a CLI flag could write anywhere inside a separately hand-written Zod schema. The
adversarial critique called that resolver more code than the CLI it serves, and it was
right for a second reason: the schema it points into is redundant once the parameter table
exists. Here one `Record<string, Param>` produces the Zod shape, the JSON Schema a model
reads, the `parseArgs` options row, the `--help` column and the flag set the skill
validator checks a `SKILL.md` against. There is nowhere for a pointer to point.

`Input<P>` is a mapped type over the same record, so a handler reading a flag nobody
declared is a compile error at the definition site. That is also why the shared parameters
in `commands/common.ts` are `as const satisfies Param` and never `: Param`: an annotation
widens `required` and `fallback` back out of the literal types the mapped type reads, and
every handler using a shared `ROOT` then sees `root?: string` for a value the schema
guarantees. One colon erases the whole benefit, and it did, in four handlers at once.

**The array holds an erased type, and the reason took a compile failure to establish.**
`Input<Params>` collapses: `Params` is an index signature, so `Provided<Params>` is `never`
and every value widens to `string`. `Input<{offset: integer}>` is therefore assignable to
`Input<Params>` in neither direction, and method bivariance, which needs one of the two,
does not save it. `AnyCommand.run` takes `never`, which every input type is a supertype of,
and the erasure states exactly what `invoke`'s comment already says: the relationship
between table and handler is checked at the definition site by the type and at the call
site by the schema.

### install and verify-install share a predicate, not a specification

Each consumer edit is an `{ present, apply, byHand }` record. `verify-install` calls
`present` and `install` calls `present` then `apply`, and `install.test.ts` asserts
`edit.present === check.present` **by reference identity** rather than by behaviour,
because a copied predicate passes a behavioural test and a copy is the whole failure mode.
Idempotency is then not a property anyone maintains: re-running `install` is a no-op
exactly when `verify-install` passes, and there is no third state.

There is no managed-region convention to lean on. An exhaustive grep across hex-web returns
four whole-file "Code generated" headers and nothing else, and zero of the target files are
generated: `routes.ts` is about half prose comment and `root.tsx`'s CSP doc comment alone
is 55 lines. So detection is semantic and `apply` returns `null` when its anchor is missing
or not unique, which is the honest form of "abort only the edits whose own write target was
hand-edited": without markers, hand-edited is not knowable and "I cannot find exactly one
place to put this" is.

Three edits the plan's install table has and this deletes, each against the source:
`root.tsx` already matches app paths by prefix so a docs mount under an app path inherits
the accent for free; a missing `PATH_SCOPES` entry yields chrome-only strings, which is
right because this package ships its own in seven languages; and docs pages are not opted
out of the language cookie redirect, because the reason legal documents are does not apply
to a manual.

### The MCP server is written here, and the SDK is a devDependency that proves it

`@modelcontextprotocol/sdk@1.30.0` declares seventeen direct dependencies, including
express, hono, cors, jose and ajv, and resolves to roughly a hundred packages in a `kit/`
that ships two. That weight travels into every app repository that mounts the submodule,
and one of them is a Swift project whose first agent session pays for the install before
the server answers `initialize`, for transports this server does not use.

Measured against the SDK on disk rather than recalled: the stdio wire format is
`JSON.stringify(message) + '\n'`, and a tools-only server answers five methods. So
`mcp/protocol.ts` is about two hundred lines, the SDK is a devDependency, and
`kit/test/mcp/protocol.test.ts` drives this server with its real `Client`. The protocol
claim is proved against the reference implementation while the reference implementation
stays out of every consumer's tree, because `bin/hexdocs` installs production dependencies
only. All four candidate designs put the SDK in `dependencies` and three named the weight
as an accepted risk; it was the largest single cost in the step and it was avoidable.

A JSON array on that wire is a batch, and `typeof [] === 'object'`, so the guard needs
`Array.isArray` or an array falls through to the notification arm and is dropped in
silence. Batching is permitted in two of the protocol versions this server offers, so a
conforming client that used it would hang until its own timeout. It is refused by name.

### The exec boundary is a recipe table, not an allowlist

`runRecipe(id, holes)` fills a fixed argv template from a closed table. `git clean -fd` is
not denied, it is unrepresentable. That is strictly stronger than the two shapes it
replaces: hex-terraform's binary allowlist passes `git clean -fd`, `git reset --hard` and
`aws s3 rm --recursive` outright, and a subcommand allowlist still leaves `git checkout --
.` under a `checkout` entry and `git -c core.hooksPath=... log` under a `log` one, because
the dangerous form of a permitted subcommand is a flag.

`kit/src/compile/git.ts` moved behind the table rather than being exempted from it, and
`one-spawn-site.test.ts` asserts there is exactly one process-spawn site under `kit/src`.
hex-terraform has that defect live: its `context.ts` reaches for `execSync` while
`lib/exec.ts` beside it holds the allowlist.

**A space is deliberately not refused.** It is the separator a shell splits on, so it looks
like it belongs, and refusing it would break a repository checked out under a path
containing one. What makes that safe is that the class is not the guarantee: `spawnSync`
takes an argv array with `shell: false`, so no shell parses a value. What the program at the
other end still does with one is at `REFUSED_IN_ARGV`, and step 6 deleted the rest of this
class for exactly that reason. The NUL is written
as an escape, because it stood in that class as a raw byte for a while, invisible in every
diff, in the one file where a reviewer most needs to read the characters literally.

### Two id namespaces that look like one

`Finding.rule` is the closed union `LintRuleId | CheckId`. `CheckRow.id` is a plain string
and is a **row** id: `verifyBundle` has emitted `bundle-manifest`, `bundle-objects`,
`bundle-digests` and `bundle-payloads` since step 3 and none of them is in `CHECK_IDS`.

The consequence is that a both-directions coverage test keyed on row ids fails against the
compiler's own output, and one keyed on `Finding.rule` is the one worth having.
`checks-fire.test.ts` proves `CHECK_IDS` by **firing** each of them, which is
`rules-fire.test.ts`'s shape, and not by scanning source for a string literal: a literal in
an unreachable branch satisfies a grep, and that is exactly how eleven check ids sat
implemented-and-unreachable through four steps with a green suite. `wiring-allow-paths` was
the last of them, and closing it meant giving `hexdocs check` a reason to read the mirror
script rather than writing an exemption saying nothing called it.

### What the mutation testing found

Every guard in step 5 was reverted and observed to fail, and six defects came out of it
that a green suite did not show.

`kit/src/cli/help.ts` padded its left column to a literal 20, and two real flags are 21 and
22 characters, so `hexdocs label --help` printed the spelling and the help text with no
separator. The width is measured now, which is the version of the claim that holds for a
flag longer than any that exists today.

The lint envelope's `nextAction` named `hexdocs lint`, and there is no `lint` command. It
was invisible because every surface recomputes the action over its own filtered list first,
so the only route that reached it was a caller returning `runLint`'s envelope untouched.

`filterEnvelope`'s action was a fixed point: `['hexdocs', 'check', '--severity', <severity>]`
is byte for byte the invocation that produces it whenever the run already carried that
filter, so an agent following actions never left the state. It names the page to open now.

`normaliseEntry` in the allowlist reader folded by trimming the string, and `docs/..` named
the repository root to the copy step while reading here as an ordinary two-segment path: no
refusal fired and the insert proceeded beside it. It folds by segment now. Nobody would
have found it from the cases people write, because every case people write uses the plain
spelling.

A report whose every row is `skipped` validated, satisfied both per-row invariants and
exited 0 having examined nothing. `examinedNothing` is the report-level form of the rule
`checkRow` applies per row, and it is scoped to a report that would otherwise pass, because
a `not-run` row examines nothing by definition and without the scope the guard fires on its
own remedy. `verify-install` converts the all-skipped state into a `not-run` row before it
gets there, because pointing the command at the wrong directory is a wrong argument rather
than a bug in the command.

The prebuild check walked every `../`-prefixed token in the prebuild string looking for a
shared script that invokes hexdocs, and the docs guard invokes the launcher by exactly such
a path, whose file naturally contains the word. A correctly wired repository with the
submodule checked out failed its own row for naming its own launcher.

### Two claims that were corrected rather than defended

`kit/src/README.md` row 10 said the import graph from `mcp/server.ts` reaches no writer.
That is false and always will be: the server imports the registry and the registry is one
flat array of all sixteen commands, which is the point of having a registry. The guarantee
is real and is carried by three other things, so the row now names them and the graph walk
is rooted at the nine tool handlers instead. A comment that overstates a guard is worse
than no comment, and this was one in a file whose whole subject is that.

`registry/index.ts` said the seven commands with no tool are exactly the seven that write.
Six write; the seventh is `mcp`, which writes nothing and is the server itself. Wrong by
one, in a sentence that reads as a guarantee.

### Fixture consumers are strings, not files

Every design proposed committing `fixtures/consumer/apps/front/app/routes.ts` and its
siblings, and all of them break this repository's own ladder. Measured: both test tsconfigs
include `fixtures`, so a copied `routes.ts` importing `@react-router/dev/routes` and a
`.tsx` sitemap fail the typecheck row; `scripts/lint.mjs` scans `fixtures/` and the real
`paths.ts` carries four em dashes; and `pnpm format` rewrites `- "!common/docs"` to single
quotes, which is the exact byte shape the consumer's own guard matches. `fixtures/consumers.ts`
holds the bytes as escaped template strings and materialises them into a temporary
directory, which is what `materialiseCorpus()` already established one directory over.

The two shapes are not decoration. Seven of the nine wiring checks meet a materially
different situation in each: a workspace glob against an explicit include list, a JSONC
tsconfig against bare JSON, an existing `prebuild` shared by four packages against no
`prebuild` at all, a composed mutable path array against a readonly alias of a registry
whose keys are a closed union. A check developed against one consumer and correct only
there is the failure two fixtures exist to catch.

### What step 5 deliberately does not do

The Terraform stack, the publish workflow committed in an app repository, and running
`install` against the real hex-web belong to steps 6, 7 and 8. `publish` and `prefetch` are
therefore tested against a recording fake `Exec`, and each test says so in its header and
names what stays unproved: that S3 answers a second conditional write with a 412, that
`--checksum-sha256` is verified server side, and that `s3api get-object` writes stored bytes
rather than decoding `Content-Encoding`, which the whole stored-digest half of `prefetch`
rests on.

`hexdocs mv` is not built. Renaming across seven locales means rewriting inbound links,
which means emitting markdown, and this package has no printer. A regex rewriter would be a
second, weaker parser disagreeing with the first about exactly the constructs the first was
hand-written to get right, and the disagreement would surface as a broken link in a
language nobody here reads.

`hexdocs coverage --strings` is refuted rather than deferred: the only app with strings
keys them by their English source text, so there are no screen prefixes to group by.

## The bundle store (step 6)

`infra/` is a self-contained Terraform stack: one private S3 bucket, one GitHub Actions OIDC
provider, and one publisher role per app repository. `infra/README.md` is the runbook. What
follows is what would otherwise be rediscovered.

### The write-once guarantee is enforced at S3, not only in the client

Step 5 shipped `--if-none-match '*'` inside the put recipe and left the server side unproved.
It is real now, and it is in the **bucket policy** rather than in the role, because of what
this account actually is: the deploy profile authenticates as the AWS **account root user**
with a long-lived access key. Root is not the subject of any identity policy, cannot be
scoped and cannot assume a role, so a resource-based Deny is the only control that reaches
it. Every rule that has to hold against the operator's own terminal is therefore in
`bucket-policy.tf`, and the role policy holds only what has to be true of the GitHub
publisher.

Five denies, and each closes something the others do not:

- `DenyUnconditionalObjectCreation` is `Null: {"s3:if-none-match": "true"}` plus
  `Bool: {"s3:ObjectCreationOperation": "true"}`. The condition key is real and is on exactly
  one IAM action, `s3:PutObject`, which is enough because CopyObject, CreateMultipartUpload,
  UploadPart, UploadPartCopy and CompleteMultipartUpload are not separate IAM actions. The
  `ObjectCreationOperation` clause is what keeps the deny off the three multipart calls that
  cannot carry a conditional header; without it every multipart upload fails at its first
  part.
- `DenyObjectDeletion` is what turns no-overwrite into immutability, and the reason is not
  obvious. On a versioned bucket a simple DELETE is not blocked by a conditional-write deny:
  it inserts a delete marker, the marker becomes the current version, and AWS states that "if
  the current object version is a delete marker, the write operation succeeds". So without
  this statement anybody who can delete can free a published key and write different bytes to
  it. **Object Lock does not close this either**, even in COMPLIANCE mode, which is one of the
  two reasons the bucket does not have it.
- `DenyReplicationIntoStore` is the statement without which replication walks past both of
  the above. A replication rule is configured on the **source** bucket, so any other bucket in
  the account can name this one as its destination, and the destination-side writes authorise
  as `s3:ReplicateObject`, `s3:ReplicateDelete` and `s3:ReplicateTags`. None of the three is
  `s3:PutObject` and none is `s3:DeleteObject`, so neither object deny evaluates them.
  Measured before the statement existed: all three returned `allowed` against the applied
  policy in the same run where the three denies beside them returned `explicitDeny`.
  Same-account replication needs no destination bucket policy at all, so nothing had to be
  granted for that to work.
- `DenyStoreReconfiguration` covers `DeleteBucket`, `PutBucketObjectLockConfiguration`,
  `PutBucketPublicAccessBlock`, `PutBucketVersioning`, `PutLifecycleConfiguration` and
  `PutReplicationConfiguration`. The lifecycle one is the sharpest of the routes around the
  object denies: AWS says that "even if your bucket policy denies all actions for all
  principals, your S3 Lifecycle configuration still functions as normal", so an expiration
  rule is a delete no other statement in the policy can see. `PutReplicationConfiguration` is
  the **source** side and is not the same thing as the statement above: denying it stops this
  bucket becoming a replication source, and neither statement closes the other's direction.
  `PutBucketObjectLockConfiguration` is the odd one out and is not a route around anything: S3
  enables Object Lock on a bucket that already exists as long as it is versioned, so the deny
  is what holds the flag off, and it is the only entry here whose effect lifting the policy
  cannot undo.
- `DenyInsecureTransport` carries `BoolIfExists` on `aws:PrincipalIsAWSService`, not the
  `Bool` AWS publishes. The key is absent from an anonymous request context, a plain operator
  against an absent key is false, and every key in a condition block has to resolve true, so
  the published spelling does not deny anonymous plaintext at all.

The three bucket-policy actions are deliberately **not** denied, because AWS gives the account
root user a documented carve-out for exactly `GetBucketPolicy`, `PutBucketPolicy` and
`DeleteBucketPolicy`. Denying them would bind every principal except the one the policy
defends against, and would turn a wrong policy into a support ticket. That carve-out is also
the recovery path for everything above, and it is why removing a published object is a
deliberate three-step act rather than a command.

The price is stated rather than hidden: Terraform cannot change any of the six reconfigured
settings after the first apply without the policy being lifted first, and the bucket cannot be
a target for access logging, CloudTrail or load balancer logs, each of which authorises as
`s3:PutObject`, cannot carry an If-None-Match header, and so fails with a 403. Replication is
refused too, and by a different statement: it authorises as `s3:ReplicateObject`, which the
write-once deny never evaluates, so the reason is `DenyReplicationIntoStore` rather than the
absence of a service-principal exemption.

### The trust policy pins claims, not names, and one absence is load bearing

`aud`, `repository_id`, `ref`, and `sub` as a two-value `StringLike`. Measured: hex-nfc was
created before the 2026-07-15 immutable-subject cutover and
`gh api repos/<owner>/<repo>/actions/oidc/customization/sub` reports `use_immutable_subject
false`, so it emits `repo:<owner>/<repo>:ref:refs/heads/main` today and the `@<id>` form after
any rename or org-level opt-in. Both spellings are in the condition, so that flip is a no-op.

`sub` is not redundant with `ref`. A pull_request token's subject is
`repo:<owner>/<repo>:pull_request` with **no `:ref:` segment at all**, and for
`pull_request_target` the `ref` claim is the base branch, so a policy resting on `ref` alone
passes a token minted from a fork's code.

**`repository_owner_id` is deliberately absent**, although AWS's own worked example uses it.
Repository ids are globally unique so it scopes nothing new, and its mapping is disputed
between AWS's documentation and a third-party analysis of the February 2026 STS claim launch.
An unmapped claim key is absent from the request context, `StringEquals` on an absent key is
false, and the result would be that every publish is denied. No `...IfExists` operator appears
anywhere in the file for the mirror-image reason: absence evaluates **true** under those, so
one misspelled claim name would grant rather than deny.

Nothing verifies OIDC claim names ahead of time. Measured: `aws accessanalyzer validate-policy`
returns no finding for a deliberately misspelled `token.actions.githubusercontent.com:` key.
The first real workflow run is the only test, which is why the failure mode and its message are
written down in `infra/README.md`.

### `s3:ListBucket`, and the paragraph that had it backwards in both directions

S3 answers `HeadObject` on a key that is not there with **403 rather than 404** when the caller
lacks `s3:ListBucket`. `kit/src/s3/client.ts` originally stated that rule the wrong way round,
which is the sentence somebody would have read while tightening the policy. It was corrected in
step 6, and then the paragraph replacing it drew a conclusion that contradicted its own premise:
that the grant could carry an `s3:prefix` condition **because** a HeadObject carries no prefix.

The opposite follows. An absent condition key makes a `StringLike` false, and a statement whose
condition is false does not apply, so a prefix-conditioned `s3:ListBucket` does nothing for any
request that is not a list. `publish` opened with `head-object` on `<prefix>/manifest.json`, so
the publisher role would have read its own empty prefix as an access denial, **on its first
publish and on no other**. That last clause is the reason this was not left to the first real
run to settle: a head on a key that exists answers 200 on `s3:GetObject` alone, so publishing
that manifest once by any other route, including the step 6 smoke publish signing as root, makes
the run pass without ever exercising the permission it depends on.

The preflight is a `list-objects-v2` under the prefix now, and the head that follows runs only
on a key the listing named. `s3:prefix` is populated from the request parameter of the same
name, so the listing carries it and the condition applies; the head needs `s3:GetObject` and
nothing else. `reconcile` already worked this way and shares the one walk rather than making a
second, because two listings are two ideas of what is under the prefix.

The reader policy keeps the masking argument and is right to: `reader.tf` grants `s3:ListBucket`
with **no** condition, so it applies to a GetObject, which is what makes `prefetch` report a
missing label rather than a denial. The asymmetry is now written at both policies.

What is still unmeasured is S3 itself: nobody here has watched a prefix-conditioned grant answer
a real HeadObject, because assuming the publisher role needs a GitHub OIDC token. The reasoning
above is IAM evaluation logic rather than an observation, and the fix is what makes the question
stop mattering.

### Two step-5 defects that only a real bucket would have found

**`aws s3api head-object` returns no checksum at all without `--checksum-mode ENABLED`.**
Measured against a real object both ways: without the flag the response carries
`ContentLength` and `ETag` and nothing else. The CLI's own model has no `httpChecksum` block
for HeadObject, so botocore's auto-injection never fires. Every publish after the first would
have read "S3 holds no checksum" for every object, which makes identical content
indistinguishable from changed content and turns the write-once preflight into an existence
test.

**`aws s3api get-object` returns it today only by grace of a default.** GetObject does declare
the block, so botocore sets the mode when `response_checksum_validation` is `when_supported`.
Measured: `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required` removes `ChecksumSHA256` from the
output with exit code 0. Both recipes carry the flag now, which is the whole point of a closed
argv template.

The put recipes were checked on the wire against a loopback listener and are correct as they
stand. **Do not add `--checksum-algorithm SHA256`**: supplying `--checksum-sha256` already
short-circuits botocore's default-checksum resolution, so the request carries exactly
`x-amz-checksum-sha256` and no CRC, and adding the algorithm flag adds a second header S3
cross-checks, which turns a future one-sided edit into a BadDigest 400.

### The stack is testable without an account, and that decided how the ARNs are written

`infra/tests/policies.tftest.hcl` asserts the rendered policy JSON, statement by statement,
under `terraform test` with a static provider and no credentials. That is only possible because
`local.bucket_arn` and `local.oidc_provider_arn` are **composed from the name and the account
id rather than read off the resources**: a resource attribute is unknown until apply, and a
policy document referencing one renders as "(known after apply)" in every plan, which makes it
unassertable and unreviewable at the same time. The dependency edges a reference would have
given are written as explicit `depends_on`, on the bucket policy and on each publisher role.
Delete those and a first apply can fail with a 403 on the lifecycle put, or with
MalformedPolicyDocument on a role created before its provider.

Every one of the seven run blocks was mutation tested. Dropping `s3:DeleteObjectVersion`,
dropping the `ObjectCreationOperation` clause, widening the subject to the organisation and
changing one `StringEquals` to `StringEqualsIfExists` each turn exactly one row red.

**What holds those run blocks in place afterwards is weaker than it looks**, and the guard says
so now rather than claiming the opposite. `scripts/check-infra.mjs` cross-checks the `sid` of
every declared statement against the text of the test file in both directions, which catches a
statement no test ever mentioned and a test naming a statement no document declares. It does
not ask which run block names a Sid, or whether anything is asserted about it, and
`terraform test`'s passed-against-declared pair takes both of its numbers off the same file.
Measured: five of the seven original run blocks could each be deleted with all four rows green,
because the first block lists every bucket Sid as a literal inside its own assertion and so
covers for the blocks that carry the real assertions about them. Deleting a run block whose
Sids appear nowhere else is caught, and that is the whole of it.

Two smaller things the test file forced. `aws_iam_policy_document` does not render an action
list in the order it was declared, so assertions sort both sides; a positional comparison there
fails on a correct policy, which is the worst kind of red row. And an `override_data` value
accepts neither a function call nor a variable, so the fixture's account id is not
account-shaped at all: the repository-wide identifier scan fails on a twelve-digit run
anywhere, and this repository has exactly one exemption mechanism, scoped to `fixtures/`.

### What the first real publish found

The plan's step 6 ends with a manual publish, and its stated purpose was that a failure at
that point would be a credentials problem and nothing else. It was not. Four things came out
of the run, and three of them were invisible to a green suite of three thousand tests.

**`runRecipe` refused this repository's own content type.** `kit/src/exec/run.ts` carried a
class of shell metacharacters refused in any hole, and `s3/keys.ts` sends
`text/plain; charset=utf-8` for `llms/*.txt` and `text/markdown; charset=utf-8` for the raw
markdown. The publish uploaded two objects and stopped. Nothing in the suite could see it,
because every test injects a fake `Exec` and none of them reaches that function.

The class is gone except for the NUL, and the reasoning is at `REFUSED_IN_ARGV`. The short
form: `spawnSync` is called with an argv array and `shell: false`, so no value is ever parsed
by anything, and the module's own comment already said the class was belt and braces over a
boundary that cannot be crossed. It had one exception already, for the space, on the grounds
that refusing it would break an ordinary macOS path. The semicolon is the same argument one
step along, and an ampersand in a cache directory name is the next one waiting. A tripwire
that refuses correct input more often than it catches anything is not defence in depth. The
NUL stays because node refuses it anyway, so what it buys is a named refusal rather than a
`TypeError` naming neither the recipe nor the value.

**`--resource-owner` takes an ARN.** `scripts/check-stack.mjs` passed the bare account id and
IAM answered `InvalidInput: '<id>' is not a valid as a Resource Owner`, so the publisher
boundary row went red against a correct stack. The account root ARN is the documented
spelling.

**Three claims step 5 recorded as unproved are now measured**, and the test headers that named
them say so. S3 answers a second conditional write with `PreconditionFailed`. `head-object`
returns the base64 the put sent, so an unchanged commit reconciles to zero uploads: the two
objects left behind by the failed first attempt were recognised by checksum and skipped. And
`get-object` writes stored bytes rather than decoding `Content-Encoding`, measured on a
`.gz` key that came back byte for byte equal to the manifest digest and still passed
`gunzip -t`.

**The bucket policy's write-once deny holds against the account root user**, which is the
whole reason it is a bucket policy. An unconditional put by root answers
`AccessDenied ... with an explicit deny in a resource-based policy`. The cleanup afterwards
exercised the documented recovery once for real: lift the policy, delete ninety-three
versions, put the policy back, and `pnpm check:stack` compares the restored document against
the rendered one statement by statement.

One thing the run deliberately did not prove: whether `--checksum-sha256` is verified server
side or stored as a label. It needs a deliberately wrong digest, and the write that would
prove it lands at a real key in a store where nothing can then delete it.

### Two guards, and only one of them is on the ladder

`scripts/check-infra.mjs` is offline. `terraform fmt` needs nothing at all, and `validate` and
`test` need neither network nor credentials once `init -backend=false` has run, which is what
keeps the CI job inside the `permissions: contents: read` it already declares. Its first row is
pure JavaScript and always runs, so a machine with no terraform still examines something rather
than reporting a page of skips.

`scripts/check-stack.mjs` is credentialled, read-only, and deliberately **not** a ladder row. A
row that cannot run reports `NOT RUN`, `NOT RUN` fails the run, and a credentialled row would
fail `pnpm verify` on every machine without an AWS profile, which is most of them and all of
CI. It proves the publisher boundary with `aws iam simulate-principal-policy` rather than by
attempting a write, which is the difference between a verification an operator will re-run and
one they will do once.

Everything underneath that guard's calls is `scripts/lib/policy-diff.mjs`, and the split is a
coverage decision with a correctness argument behind it. The comparison of the applied bucket
policy against the rendered one is the one piece of the guard a bug can make silently wrong:
every other failure is loud, and a wrong comparison reports no drift on a policy that has
changed. It is also the only piece a suite with no credentials can hold. In the guard it was
three hundred statements of untestable-by-association code dragging two coverage floors down;
in the library it is held at 100 statements and 95 branches, and `scripts/check-stack.mjs` is
excluded from coverage with the measurement of what a floor over it would have cost.

Terraform is not on the `ubuntu-latest` runner image. Measured: the ubuntu-24.04 README lists
no terraform, and the 22.04 image that has it began deprecation in September 2026. CI installs
it with `hashicorp/setup-terraform@v4`, which is the first major whose `action.yml` declares
node24, with `terraform_wrapper: false` because the wrapper replaces the binary with a shim
that captures stdout into step outputs and the guard parses that stdout.

### What the adversarial review changed

Sixty-one agents over six dimensions, each finding attacked by an independent skeptic: 55
findings, 41 survived, 14 refuted. The ones worth knowing before touching this again, because
each was green in a nine-row ladder and none is visible from the stack itself.

**Two guards had a hole where their strongest claim was.** `DESTRUCTIVE_LIFECYCLE` anchors the
block name at the start of a line, so `dynamic "expiration"` never reached the alternation:
measured, a fmt-clean, valid plant of exactly that reported all clear. And the Sid coverage
scan added to close the deleted-run-block hole is a substring match over the whole file, so
five of the seven run blocks could be deleted with every row green, because the first block
already names all four bucket Sids. The regex is fixed; the second one could not be, and the
comment now says what the scan catches rather than what it was hoped to.

**Replication writes into the store were denied nowhere.** `s3:PutReplicationConfiguration` is
called on the source bucket, so denying it here only stops the store becoming a source.
Configure replication on any other bucket in the account with this one as the destination and
the writes authorise as `s3:ReplicateObject`, `s3:ReplicateDelete` and `s3:ReplicateTags`,
which carry neither conditional-write key. Measured with `simulate-custom-policy`: allowed,
against `explicitDeny` for the three the policy did name. `DenyReplicationIntoStore` is the
fifth statement.

**`DenyEverythingElse` was proving nothing.** Measured by simulating the role's document with
and without it: the decision does not move, because the bucket policy denies the same actions,
so the row was green over a role that had lost the statement its own comment says it watches.
`check-stack.mjs` now requires the role's own policy among the matched statements, and the
measurement is recorded at the claim.

**Object Lock can be enabled on an existing bucket.** `bucket.tf` said it could not, which made
the absence of the flag look self-enforcing. It is held by
`s3:PutBucketObjectLockConfiguration` sitting in the reconfiguration deny and by nothing else,
and the asymmetry is why: turning it on is one console call, turning it off is impossible.

**Twelve confirmed overstating comments**, which by this repository's own standard are worse
than none. The `depends_on` rule was false for one of its own entries, `providers.tf` claimed a
`check` block cannot fail a run when `terraform test` is the exception, `stripComments` named
the scan that cannot need it, `versions.tf` justified its version floor with a guard behaviour
that does not exist, and the paragraph deleting the metacharacter class claimed no value is
parsed by anything. That last one is now measured rather than asserted: the AWS CLI expands a
`file://` value into that file's contents, on any parameter, and takes a value that looks like
a flag as one. Neither is reachable today, because the only hole filled from outside this
repository is S3's own continuation token, and the check belongs where a value enters.

**A state bucket name from the estate was committed**, in the same file whose opening paragraph
says the stack names no bucket, and in the same commit as a lint row whose comment says no
committed file has a reason to hold one. It is a placeholder now.

Two guards grew a claims table out of it. `test/infra.test.ts` holds `ARM_CLAIMS`, one sentence
per assertion id in the invariants row, checked against the ids the guard actually evaluated in
both directions, which is `rules-fire.test.ts`'s shape applied to a guard rather than to a rule
set. And the house lint gained `no estate identifiers in git history`, because an account id in
a commit message passed it clean.

### There is no reader role, and the absence is the finding

`hexdocs prefetch` runs from a consuming site's `prebuild` on the deploy host, signing with the
ambient profile, and that profile is the account root user. Root cannot be the subject of an
identity policy, so a reader role would have no principal to trust and a reader policy would
have nothing to attach to. `reader.tf` therefore creates nothing and outputs the rendered
document, so the day a non-root deploy identity exists it is one attach away.

That is worth stating as what it is: the reader is unscoped because the identity is unscoped,
and no policy this stack writes can change that. `providers.tf` carries a `check` block that
warns on every plan while it is true, and goes quiet on its own when it stops being true.

### The house lint reads `.tf`, and now looks for estate identifiers

`infra/` was already in `OPTIONAL_DIRS`, and `.tf` was in no extension list, so the directory
would have contributed zero files and failed the every-root-contributes-files row on the day it
appeared. Both extensions are listed now, and `.terraform` is excluded from the walk because
gitignoring it is not enough: the walk reads the filesystem and the aws provider alone is a
778 MB binary.

The new `no estate identifiers in source` row is what makes the public-repository rule a guard
rather than a sentence in this file. The pattern is deliberately not `\b[0-9]{12}\b`: measured,
that matched nine sha256 digests in `kit/test/golden/manifest.json`, because a word boundary
sits between a letter and a digit. Refusing a hex neighbour on either side produces zero matches
across the repository and still catches an ARN, an assignment and a sentence. The row prints
the file and the column and never the value, because a guard that reports a leaked account id
by quoting it has put it in a CI log.

## The publish workflow (step 7)

`kit/src/templates/workflow.ts` is the file an app repository commits, and step 7 is the
first time anything ran it. Three of its assumptions were wrong, and the shape they share is
worth more than any of them: each was pinned green by a test asserting one side of a pair.

### `build` and `publish` were each correct against a literal and wrong against each other

`build --out X` writes to `X/<project>/<commit>/ast-N`, which its own `detail` states and
which `verifyBundle`'s remediation spells out word for word: "Point at the ast-N directory of
one bundle, not at the root of an output tree." The generated workflow ran `publish X`. Every
run would have failed after a successful compile, with no AWS call made at all, and
`kit/test/templates/workflow.test.ts` asserted exactly that argument as the expected string.

The workflow reads the path back out of `build --json` now rather than spelling it. That is
not a style preference. A spelled path carries an AST major frozen at the moment `hexdocs
init` ran, in every app repository at once, and the next `AST_VERSION` bump would break each
of them with a message about a missing manifest rather than about a version.

`kit/test/s3/publish.test.ts` carries the other half: the prefix `build` reports verifies as a
bundle and the `--out` directory does not. Neither test is worth much without the other, which
is the whole lesson: a pair of commands asserted separately against literals is a pair nothing
checks.

### The preflight was a head, and a head is the one call the publisher may not make

`publish` opened with `head-object` on `<prefix>/manifest.json`. S3 answers a head on a key
that is not there with 403 rather than 404 for a caller without `s3:ListBucket`, and the
publisher role holds that grant only under a `StringLike` on `s3:prefix`, which a HeadObject
request carries no value for. An absent condition key makes the condition false and the
statement does not apply, so the role built to publish would have read its own empty prefix as
an access denial.

The timing is what made it urgent rather than something to discover on the first run. It goes
wrong **only** on the first publish into a prefix: a head on a key that exists answers 200 on
`s3:GetObject` alone. Publishing that manifest once by any other route, including a laptop
signing as root exactly as the step 6 smoke publish did, makes the CI run pass without ever
exercising the permission it depends on. The obvious rehearsal would have settled the question
the wrong way and permanently.

The preflight is a `list-objects-v2` under the prefix now, `reconcile` shares that one walk
rather than making a second, and the head runs only on a key the listing named. A first
publish asks S3 exactly one question before it starts writing, and makes zero head calls.

### One of the four pinned actions was not what the comment above it said

The template's comment claimed every action was pinned to a major that runs on node24. Read
rather than assumed, from each action's own `action.yml`: `actions/checkout` and
`actions/setup-node` declare node24 at v5, v6 and v7 alike, and
`aws-actions/configure-aws-credentials` declares **node20** at v5 and node24 only from v6. The
pins are v7, v6, v7 and v6, and the comment now says what was measured.

### Three spellings of one scratch directory

`BUNDLE_OUT` was a private const in `templates/source.ts` and again in `commands/scaffold.ts`,
and `docs-publish-version/SKILL.md` spelled it a third way as `.hexdocs-out`. Three names for
one directory is three lines an app repository has to gitignore, and the one nobody adds is the
one that gets committed. It is exported from `templates/workflow.ts` now, beside the workflow
that is the only reason the name exists.

### What the first two runs measured

A first publish makes **six AWS calls**: one `list-objects-v2` and five puts. Zero heads,
because the listing came back empty and there was nothing to compare. That number is the
evidence for the preflight change above, and it is the number the old code could not have
produced: its first call was a head on a key that was not there.

The second run was a `workflow_dispatch` on the same sha. It recompiled to byte-identical
output, the preflight found the stored manifest carrying the same digest, and
`publish-reconcile` and `publish-upload` both came back `SKIPPED` with the reason. Five
objects and five versions in the bucket after two runs, so the write-once store holds and the
compile is reproducible across two separate runner invocations rather than only across two
runs on one machine.

Everything the first run also settled, none of which any local test could: STS maps
`ref`, `repository_id` and `sub` the way the trust policy assumes, so the OIDC condition keys
are real and correctly spelled; `actions/checkout` fetches an https submodule with the
job's own token and a public repository needs nothing further; `bin/hexdocs` installs its own
dependencies on a clean runner in under two seconds; and `pnpm/action-setup` with
`run_install` unset does not install, which matters because the workspace root has no
`package.json` and an install there would have failed.

The submodule is mounted with an **https** url, against the estate precedent of `git@`. Every
other submodule in the estate lives in a repository with no CI, so a developer machine with an
ssh key was the only thing that ever checked one out. `actions/checkout` authenticates a
submodule by rewriting an https url, and can do nothing with an ssh one.

### What the recon found in hex-nfc and step 7 did not fix

Reported rather than repaired, because each is a defect in that repository and none blocks a
publish. `sync-public.yml` gates its job on `github.repository == 'Hex-Pro/hex-nfc'` and the
repository is `hexpro-dev/hex-nfc`, so the mirror job has never run; the mirror repository does
not exist either. `hexdocs check` runs nowhere in that repository, so `wiring-allow-paths` and
the deny scan gate a publish and not a mirror push.

## Code style

Tabs. TypeScript strict, `verbatimModuleSyntax`, ES2022 / ESNext / bundler. Prettier with
`useTabs`, `tabWidth` 2, `singleQuote`, `trailingComma: all`, `printWidth` 100, `semi`,
`arrowParens: always`. `.editorconfig`: lf, tab, final newline, trim trailing except in
markdown, spaces in yaml, terraform and markdown. The terraform section is not cosmetic:
`terraform fmt` writes two spaces and has no option to write anything else, so without it the
`[*]` default tells an editor to type a tab into a `.tf` file and the ladder's fmt row becomes
the remedy for a hint the repository itself gave. Node `>=22`, CI matrix on 22 and 24.

Relative imports carry a `.js` extension, matching `@hex-pro/i18n`.

**No em dashes** in code comments, commit messages or any shipped content. The full
banned-phrasing list in the global CLAUDE.md applies to everything this package emits and
to everything it lints.

**No AI attribution anywhere in git activity.** No `Co-Authored-By`, no "Generated with",
no robot emoji, in commit messages or pull request bodies.

House comment style: every non-obvious decision carries a paragraph saying what breaks if
it is undone. A comment that overstates a guard is worse than no comment, because it is
how the guard gets trusted by the next person to touch it.

## Testing

vitest with v8 coverage and **per-directory thresholds set just under what the suite
actually reaches**, each with a comment saying why that number and not a higher one.
100% on the schema validators and the sanitiser, where a bug is silent rather than loud.

A check that examined zero things is a failure, not a pass. `kcalc-web/front/scripts/verify.mjs`
is the model: four states (PASS, FAIL, SKIPPED, NOT RUN), every row carrying a count, and
a checker reporting zero converted to a failure even when it exited 0.

The consumer sweep is the highest-value suite: walk every repo beside `~/Hex` holding a
`docs/site` or a `*.docs.json` and validate it against the current schema, so a config
key that only exists on a branch fails here rather than silently at publish time.

The fixture corpus is read by both suites, and each reads it for what only it can check.
`test/fixtures.test.ts` uses the contracts alone, which is what a consumer has: slugs
parse, locales normalise, the nav invariants hold, the declared inventory matches the tree
in both directions, and the materialised history really does produce the states the corpus
claims. `kit/test/fixtures.test.ts` adds the Zod schemas and the source grammar: every
config validates, every front matter block validates, every directive name is one this
AST major understands, every container is closed at the width it opened with, and every
fence language is in the project allowlist. That last one is checked in both directions,
because an allowlist that grew to cover mistakes stops catching them.
