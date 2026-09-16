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

The one thing that always runs is `prebuild`. Verified: pnpm 10.28.0 and npm 11 both fire
`prebuild` automatically, and `hex-terraform/deploy/src/build.ts` builds the front **on the
host** before the Docker build, so the network and the submodule are available there. It
runs `npm run build`, not `pnpm build`: it takes the pnpm branch only when the site
directory holds its own `pnpm-lock.yaml`, and neither consumer's does. The
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

**Docs addresses do not join `LOCALISED_PATHS`.** Root asks the docs match instead:
`docsSeoFromMatches(useMatches())` returns the page's `DocsSeo`, and the installed decision
is `docsSeo ? docsSeo.indexable : isLocalisedPath(path)`, with the alternates filtered to
`docsSeo.languages`. A docs loader that threw leaves the match with no data, which reads as
not indexable, and a mistyped docs URL matches no route at all, so it gets root's `noindex`
branch. Step 5 derived `LOCALISED_PATHS` from the slug list; step 8 measured that doing so put
the docs code and every config into each page's client bundle, and gave the docs home no
canonical because both consumers normalise the trailing slash away before an exact match.

The slug list is still a build input, for the route table: `hexdocs sync` writes it into
`<project>.docs.json` and the route rows are derived from it.

`isLocalisedPath` has a second caller, `preferredLanguageRedirect` in
`lib/i18n.server.ts`, which cookie-redirects any bare path it accepts. A docs address is
absent from the list, so it is never redirected, and that absence is load-bearing: the
translation notice links to the English address, and a redirect would bounce the reader
straight back, which is the loop `isLegalPath` exists to prevent for legal pages.

### Resource routes bypass parent loaders

A leaf match with no default export is dispatched to `queryRoute`, which runs that one
route's loader and no parent's. `routes/lang.tsx` does all its language validation in its
loader, so a machine endpoint mounted under `:lang` answers
`GET /banana/hex-nfc/docs/llms.txt` with a 200.

Mount `llms.txt`, `llms-full.txt` and the raw markdown rows **top-level**, beside
`robots.txt` and `sitemap.xml`, carrying the language as a segment the route validates
itself. `docsServer().resource()` does that validation in the order `lang.tsx` does.

### Every docs route row is static, so declaration order decides nothing

A docs row is either fully static or a single leading `:lang` followed by static segments.
The only overlaps are a `:lang` row against a static row (at a `/docs` mount, `/docs/docs`
matches the page row and `/:lang/docs` with `lang=docs`), and a static segment outscores a
dynamic one whichever is declared first. `test/site/router.test.ts` reverses the rows and
checks every address still reaches the same route, with a planted tie as its positive
control. Step 5's rows had a `*.md` pattern, and React Router escapes a `*` that is not a
trailing `/*`, so that row matched only the literal URL `/…/*.md` while every raw address
404d. The raw rows are now one static `<slug>.md` row per page per mount.

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
nothing released. `docs/internal/` holds App Store review-risk strategy,
export-compliance classification, competitor naming and a device UDID.

Step 9 moved the three engineering documents out of `docs/public/`, which no longer
exists, into `docs/site/content/en/developer/`, and `scripts/sync-public.sh` lists
`docs/site` in its place. Anything written about that repository before step 9, here or
in a fixture, is describing the old tree.

**`docs/internal/` is protected by absence, not by a guard.** `scripts/sync-public.sh`
has a copy-in `ALLOW_PATHS`, and `prune_internal_files()` only matches `CLAUDE.md`,
`AGENTS.md`, `.claude` and `.agents` by name. Widening the docs entry to `docs/` would
push the internal tree to a public repo and nothing would catch it. The entry is exactly
`docs/site`, never `docs`, and `hexdocs check` asserts that no bare `docs` entry exists.

The publish workflow is deliberately **not** allowlisted. It carries neither the bucket nor
the role, which it reads from repository variables, but it describes the shape of the estate
and a public mirror has no use for it.

`.claude/` is gitignored there by policy, so skills wiring cannot be committed. `.mcp.json`
can be. That is why the MCP server exposes `list_skills` and `get_skill`.

App strings are `app/HexNFC/Localizable.xcstrings`, 468 keys, `sourceLanguage` `en`,
fully translated into `ar es fr ja pt-BR zh-Hans` (2796 translated string units, two
keys using `variations` rather than a top-level unit). Note `zh-Hans` there against `zh` on the web, and an orphan
`hi` App Store listing with no app strings behind it.

**`73b7be1ed9a1361bad35091207610e4f331493cf`, the commit cited as the first version,
touches only `marketing/`.** Nine of roughly a hundred main commits touched the
documentation tree before step 9 moved it.
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
hex-nfc's three engineering documents counts 59 U+2705, 16 U+26A0 every one followed by U+FE0F, and 11
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

`src/index.ts` stays importable from bare node. The toolchain imports it under `tsx`, and a
consuming site's `app/lib/docs.server.ts` is loaded by React Router's route-config loader,
which runs with no Vite plugins at all; a `.css` specifier on either path is a failure a long
way from its cause. So the barrel re-exports the contracts, the search client, the string
tables, the address rules, `docsServer` and `docsSeoFromMatches`, and stops there, and
everything that renders lives behind `@hex-pro/docs/render`, which is the only module that
imports the stylesheet.

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

Four rules the generator cannot enforce, each asserted in
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

**State every property a host's base layer resets.** Unlayered beats layered only for the
properties a rule states. Both consumers ship Tailwind v4's preflight in `@layer base`, and for
anything this file leaves unstated the preflight still wins over the browser default the rule
was written against. Step 8 measured what that meant; see the step 8 section.

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
perfectly ordinary code block. `test/render/code.test.tsx` names both files and both sets of
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
- Five translation states map to three notices. `scaffolded` folds to `fallback`, and the
  route serves the **source** page for a locale whose own file is scaffolded, never that
  file. Step 8's review found the route serving it: `hexdocs scaffold` writes the source's
  headings with a TODO under each, not a copy of the English, so a reader got a page of TODO
  markers under a notice promising English. The corpus could not show it, because its only
  scaffolded file is the other signal, a byte copy of the English body. The search index for
  that locale is built from the source page for the same reason.
- A stale translation stays indexable. It is a real translation of a real page in that
  language, which is not true of the other two causes.
- An AST major this runtime does not know is a refusal from `docsRoute`, not a page of
  skipped nodes. `unhandledNode` stays the last resort it says it is, and there is one more
  thing worth knowing about it: on a long-lived server, once per process is once per deploy.
- The payload gets one small hand-written shape check at the seam. Zod is in `kit/` and this
  half may import only `react`, and the alternative is a truncated JSON file becoming an
  exception inside a React render, which on both consumers client-renders the whole shell.
- A slug the bundle carries and `site.pages` does not is refused. The route table is built
  from `site.pages`, so such a slug has no row and nothing lists it; serving it through some
  other path would publish an address the site does not know it has. `pageSkew` names the
  state at build time.
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
right because this package ships its own in seven languages; and the cookie redirect needs no
edit, which step 5 got right for the wrong reason. It said the legal exemption's reason does
not apply to a manual. It does, word for word: the translation notice links to the English
address. Step 8 keeps docs addresses out of `LOCALISED_PATHS`, and that absence is the
exemption.

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
not exist either. `hexdocs check` runs nowhere in that repository, so `wiring-allow-paths` runs in no
automation there at all. The deny scan is the half that does gate a publish, because
`internal-leak` and `no-competitor-name` are lint rules `build` runs and `build` exits 3
on an error envelope. Neither gates a mirror push, and `wiring-allow-paths` could not gate
a publish even if `check` ran on every commit: it reads the mirror script, and publishing
does not.

## The hex-web integration (step 8)

Step 8 is the first time this package met a real consumer, and the package had to change
before hex-web could mount it. What follows is mostly the hex-docs half; what the consumer
half measured is its own subsection near the end.

### Step 5 was green against strings and could not build a real site

A read-only mapping pass ran `install`, `verify-install` and the route rows against the real
hex-web and kcalc-web and found eighteen defects. A fully green `verify-install` and an
idempotent `install` coexisted with a site that could not build, and with one that built and
shipped its most important page wrong. The loud ones: the launcher's first run inside a pnpm
workspace installed the whole workspace and aborted with no TTY, `--silent` hiding why; the
prebuild string passed `--root`, which `prefetch` refuses because its root is positional; the
generated `app/lib/docs.ts` imported `@hex-pro/docs`, which React Router's route-config
loader cannot resolve because it runs with `plugins: []`; and the printed machine rows had no
ids, which the route loader refuses as duplicates. The silent ones: the `*.md` raw row matched
nothing; section roots carried a trailing slash both consumers normalise away, so the docs home
had no canonical; fallback pages got `noindex` from `meta()` while root still wrote a canonical
and eight alternates; and the translation notice's English link was cookie-redirected back.

The shape they share is the lesson. The fixture consumers were strings, every wiring check was a
text match, and nothing evaluated a route table, a prebuild string or an import the way the
consumer would. The fixtures are now the consumers' real bytes, and the checks below run the
consumer's own tools.

### Decisions that came out of measuring, not preference

**No bucket name in any config.** A client-reachable `import.meta.glob` with `import: 'default'`
over `*.docs.json` inlines the whole object into the client bundle; four independent critiques
measured a sentinel bucket key in the built JavaScript. The bucket reaches `prefetch` through
`--bucket` in the consumer's own prebuild string, which is private and never bundled, or through
`HEXDOCS_BUCKET`. `bucketOf` holds it to S3's naming grammar where it enters.

**Addresses are slashless.** Both consumers' `normalise`, `localeUrl` and sitemap drop a
trailing slash, so the slashless form is the only one a link, the canonical and the sitemap can
agree on. A leaf and a section root at one address (`guide.md` beside `guide/index.md`, in any
two locales) and a redirect source colliding with a page address are arms of `slug-reserved`.

**One server module and two route modules in the consumer.** `app/lib/docs.server.ts` holds the
configs glob and three bundle globs and calls `docsServer`, through an extensionless relative
import of `<mount>/src/index` so the plugin-less route-config loader can load it.
`routes/docs.tsx` and `routes/docs.machine.tsx` are one-line loaders. `page()` throws its 301,
404 and 500 as `Response`s; `resource()` always returns one. Everything subtle is in
`src/site/serve.ts`, once, for both consumers: the slug comes from a lookup table on the
lower-cased, decoded, slashless path and is never parsed out of the URL, because React Router
matches case-insensitively and strips one slash from `.data` requests; a case variant is served
and marked not indexable, which is the site's existing behaviour for its own pages; and a bundle
that is missing or malformed is a 500 naming `hexdocs prefetch`, never a throw at import.

**`DocsSeo.languages` agrees with `indexable` by construction.** The manifest carries a page's
effective translation state when it differs from its own, and `languages` is every locale whose
effective state is neither `scaffolded` nor `missing`. The sitemap rows carry the same list. A
sweep over the corpus, and over a corpus perturbed so a snippet is scaffolded, checks every
page and locale.

**Raw markdown links resolve.** An author writes links relative to the file and images relative
to the source tree, and neither survives being served at an address or concatenated into
`llms-full.txt`. The compiler writes resolved destinations as `hexdocs:page/<slug>.md` and
`hexdocs:asset/<sha>.<ext>`, always immediately after `](` (angle brackets and a leading space are
removed so the substitution cannot miss them), and the server substitutes the locale prefix, the
mount and the label. A golden test counts the tokens the parser sees against the ones the
substitution can find. A link to a page with no source-locale file is `link-resolves`, because
nothing would serve it.

**Redirects are routed.** `sync` writes the default version's redirects into the config, the
route rows include each source at both mounts, and `page()` answers with a 301. `sync` used to
drop a redirected slug from `pages` and nothing else, so a renamed page 404d while the manifest
said the redirect existed.

**`wiring-routes` runs the consumer's own `react-router routes --json`** through a read recipe,
then checks the structure: each page row once at the bare mount and once under `:lang`, each
machine row top level with its id. It is allowed over MCP by name, deliberately, and it is safe
there only because every MCP tool call's `root` and `site` are confined to the project the server
was started in (`kit/src/mcp/confine.ts`): the recipe runs the site's own
`node_modules/.bin/react-router`, so an unconfined root would let a tool call run any binary a
directory names. The hex-web review found exactly that, under tool annotations stating the tool
was read-only and closed-world; the annotations are now derived from the recipes each tool
declares, and the server runs nothing a tool did not declare. A missing binary is `not-run`. `wiring-root-seo` (formerly `wiring-localised-paths`) checks that
root asks `docsSeoFromMatches`.

**The prebuild predicate binds, it does not match.** `kit/src/commands/prefetch-params.ts` holds
`prefetch`'s table in a module with no writer imports, so the read-only check can parse the
prebuild segment against it: split on shell operators, refuse a masking `||` or `;`, require the
positional root to resolve to the repository and the segment to precede the guard and the build.

**The settings half of `wiring-mcp` is gone.** Whether one developer enabled an MCP server is not
part of whether a site is wired, and as a build gate it failed every deploy from a machine whose
local settings did not name it.

### prefetch now deletes, and what it may delete is narrow

A relabel or a removed version used to leave its pages in `app/docs/_bundles/`, where the glob
bundled them, and its assets in `public/_docs/`, where the build shipped them. Prune runs after
every cache fill has succeeded and before extraction, and removes what no plan names: a stray
regular file anywhere in the two trees (a Finder `.DS_Store` included, which the first version of
this rule refused and would have failed a production prebuild over), and any directory it left
empty that no planned file sits under. A symbolic link anywhere from the site down to a label
directory fails a named row with nothing deleted or written, because extraction writes through a
link. A regular file with more than one link at a planned destination is replaced rather than
written through, because `writeFileSync` truncates the shared inode. Labels that differ only by
case are refused, because the deploy host is APFS. Nothing runs when an earlier row has not
passed, which is what keeps a laptop without credentials from losing a tree it cannot rebuild.

### The launcher

`kit/bin/hexdocs` installs with `--ignore-workspace`: without it pnpm installs the consumer's
whole workspace from inside the submodule, and with `CI=true` it removes that workspace's
devDependencies. The install log goes to a file and is replayed to stderr only on failure,
because the deploy reports the last twenty lines of stderr and a successful first run would
otherwise bury the row that failed. It reinstalls only a tree it stamped and only when the kit's
`package.json` or lockfile changed. The obvious rule, reinstall whenever the stamp is absent,
would have run a production install over this repository's own development install on the next
`pnpm verify` and deleted the test suite's dependencies.

### Root test files had never been typechecked

`tsconfig.test.json` set `include` and inherited `exclude`, which `extends` replaces wholesale
and which named `test`. So the typecheck row counted three configurations while one of them
compiled no test file, from step 1 to step 8, over 23 latent errors. `allowJs` was also missing,
which is why every `.mjs` import had a directive typing it `any`, and that `any` hid nine more.
`test/guards.test.ts` now compares every include root's TypeScript files on disk against the
program, with one reasoned exemption, and a failed typecheck row names the file, which it did not:
the last twenty-five lines of a failed run were the compiler's diagnostics table.

### The review

Forty-one agents over six lenses, each finding attacked by a skeptic who had to reproduce it:
35 findings, 31 survived, 4 refuted. That is the highest ratio of any round, and the change was
the largest. The blocker was the scaffolded page above. The majors were guards that could be
deleted with the suite green (three in `prefetch`'s integrity checks, three in `sync`'s), a
sitemap check that failed on the import its own instruction adds, an `install` that printed no
routes instruction on a first install because its predicate passed over zero rows, and a
generated guard that failed hex-web's own eslint. Two comments in the renderer named tests that
did not exist, for a property each was the only record of; those tests now exist.

### Deploy facts this step established

- The front builds with `npm run build` on the deploy host, and hash `extra_dirs` are keyed by
  project type, so a hex-docs submodule bump rebuilds every front project: four in hex-web today
  (`pro`, `apps`, `games`, `citadel`), since `analytics` sets `has_front: false`.
- In a checkout whose submodules were initialised one at a time, which is how `~/Hex/hex-web` was
  set up, `git pull` leaves a newly added submodule empty even with `submodule.recurse` set; a
  `--recurse-submodules` clone gets it checked out. Either way, the first deploy after the
  integration merges should run `git submodule update --init common/docs` first, because an
  empty mount fails the prebuild before any guard runs, with only
  `sh: ../../common/docs/kit/bin/hexdocs: No such file or directory` and exit 127.
- `wiring-routes` needs the consumer's dependencies installed, which they are at prebuild time.
- Generated consumer files have to be measured under both consumers' eslint: hex-web lints `.mjs`
  with node globals, and kcalc gives `.mjs` none.

### What the first browser pass over hex-web found in the stylesheet

A headless pass over hex-web's production build found four layout defects, and none of them is
visible on a blank page, which is where every earlier paint probe ran. The skip link was hidden
with `translateY(-120%)` relative to the docs root, which is off-screen only when the root starts
at the top of the page; under hex-web's 64px sticky header it sat on the logo. It is now the
`.hx-sr` clip until `:focus`. A task marker is an inline box followed by a block paragraph, so the
text always started a line lower; the paragraph after the marker is inline now, and two rules put
back the spacing its end margin gave, one of which ties with `.hx-tight li` and must stay after it.
The preflight made an inline icon a block. And hex-web's `main` is full-bleed, so the shell had no
inline gutter: the layout now pads itself with `shell-inset`, a clamp that reaches 2rem at
exactly 1280px, and caps its width at the three columns plus that padding, derived from the
tokens rather than a token of its own.

Rendering nine corpus pages in four languages bare and under hex-web's compiled base layer, and
diffing the computed style of every element, found the rest: list markers, heading weight, link colour and
underline outside prose (the browser's own blue, 2.05:1 on the ground, where nothing is stated),
the block margins of a quote and a figure, and the `margin: auto` that centres a modal dialog, so
the search dialog opened pinned to the corner. The same pass found a defect with no host at all:
the browser's stylesheet gives `code` its own `font-family: monospace`, so the mono token never
reached the text inside a fence. kcalc-web's own base layer also colours h1 to h4 with its ink,
which on its paper world is 1.33:1 on this ground. After the fix, every element on those nine
pages has the same height, line height and font size under the base layer as without it.

`scripts/check-paint.mjs` reproduces the host rather than the package: a sticky header, a
full-bleed `main`, the preflight rules that touch an emitted element in `@layer base`, phone and
desktop widths, and one page measured both bare and hosted with every differing property named.
Its markup is renderer output, held to it by `test/paint.test.ts`, which also deletes each rule in
turn and asserts exactly that probe fails. Two things worth knowing before touching it:
`Emulation.setDeviceMetricsOverride` must keep `mobile: false`, because a page with no viewport
meta then lays out at 980px; and hit testing cannot judge the skip link, because the header's logo
paints over the misplaced link and `elementFromPoint` answers "the header" for exactly that defect.

### Two direction defects the house rule and the layout probes both missed

A pass over hex-web's Arabic chip matrix found them. The partial status mark was drawn with
`linear-gradient(to inline-end, ...)`, and no engine has a logical gradient direction, so Chrome
dropped the declaration and every partial mark computed `background-image: none`: an empty ring,
the shape of "no", which undoes the reason a status is a shape as well as a colour. And the
current tree and table of contents link and the selected search result drew their bar with
`box-shadow: inset 2px 0 0`, which is physical and stayed on the left in Arabic.

Both are a physical value now with a `:dir(rtl)` rule mirroring it, and the `:dir()` is on the
element, never on the docs root: an Arabic page serving the English fallback carries `dir="ltr"`
on its article, and a mark inside it reads left to right. The partial mark fills its inline-end
half. A marked code line has the same mirror although a fence is always `dir="ltr"` and it matches
nothing today, so the bar does not rest on that. The shadow stays a shadow because it takes no
space, and marking a link current moves nothing.

The house rule missed the shadow because it was a regular expression over side names,
`text-align` and bare offsets. `kit/test/theme/stylesheet.test.ts` scans declarations now. A side
in a property name, an asymmetric four-value box shorthand and a border radius whose corners differ
across the inline axis have logical spellings and are never exempt. A shadow's horizontal offset, a
linear-gradient angle or direction, a horizontal translation and any `left` or `right` keyword are
accepted only beside the same selector with `:dir(rtl)` on its subject, in the same at-rule,
declaring the mirrored value, and the mirror is computed and compared rather than assumed. What it
cannot know is which of a pair is the right way round, and it does not read a horizontal position
written as a length or a percentage, a conic gradient's angle, or a shadow offset inside a `var()`.

`scripts/check-paint.mjs` gained the two probes that would have caught them the day they were
written. `declarations` walks the stylesheet's text, because the CSSOM has already dropped what it
could not parse, replaces each `var()` with its fallback, because `CSS.supports` answers true for
any value holding one (measured: `2px solid var(--hx-edge, #2a262)` is supported, `2px solid
#2a262` is not), and asks the browser about every declaration. Its parser is cross-checked against
a semicolon count it shares no code with, and a run that validated nothing fails. Before the fix it
named exactly one invalid declaration in 421, the gradient. `sides-rtl`, `sides-fallback` and
`sides-ltr` read where the paint lands from one-pixel screenshots rather than from computed styles,
so a correct fix drawn another way still passes, and the plain link beside the current one is the
reference, so no probe has to know the ground colour. `test/paint.test.ts` breaks each of them
with one mutation that exactly one probe can see.

### What the hex-web review changed

Thirty-two agents over four lenses against the branch and its running build: 28 findings, 22
survived. Three were security defects in this package, and none of the three was visible from
hex-web's side of the diff. The SVG safety scan was a denylist that passed an XHTML `iframe`
with `srcdoc`, and a consuming site serves bundle assets as same-origin static files with no
CSP, so a navigation to the asset ran script on the site's origin; it is now an allowlist over a
namespace-aware walk that refuses what it cannot reason about. The MCP tools were unconfined, as
above. And `aws.get-object`, whose hole is an output path, sat in the MCP recipe set under a
comment saying the server cannot write; no tool needed it and it now lives in its own table.

Two guards were added that stop a site shipping something it should not. `prefetch` refuses a
labelled bundle whose source pages still carry the scaffold's placeholder description or its
TODO body markers, read from the constants the templates export, so the scaffold can never be
labelled into production by accident; a scaffolded translation is not refused, because it is
served as the source page. And a machine address with a trailing slash is a 301, because
`llms.txt` links relatively and every link under the slash spelling 404d. The generated docs guard
prints failing rows last, because the deploy reports only the last twenty lines and the fixed
"not checked here" paragraph used to push them out.

The rest was hex-web's own text: a relabel runbook that could not run as written, a CSP check
that passed when both docs pages answered 500, and comments claiming more than the code does.
One finding was pre-existing and outside this step: a request with thousands of path segments
blocks the server's event loop, through React Router's lazy route discovery on every document
render.

### What mounting it in hex-web measured

hex-web's branch `docs/hex-nfc` holds the mount, unmerged, because the only published hex-nfc
bundle is still the init scaffold and `prefetch` now refuses to build it. Everything below was
measured against that branch's production build served by `react-router-serve`, with the real
bundle and, separately, with the fixture corpus mounted as an uncommitted second project.

- **A cold prefetch through the real prebuild string** made five AWS calls, extracted five files and
  stopped on `prefetch-skew` until `sync` ran, exactly as documented. A later build with no AWS
  profile in the environment made zero calls.
- **Byte reproducibility across platforms, for the first time.** hex-nfc 8492565 compiled on macOS
  with its pinned toolchain matched the bundle the Linux runner published, all five objects and
  their gzip members byte for byte.
- **Client cost.** A non-docs page's JavaScript grew by 449 bytes gzipped, the SEO reader in root.
  The docs stylesheet is its own chunk, linked only on docs routes.
- **Routing and SEO.** The docs home carries a slashless canonical and names only `en` and
  `x-default`; `/ja/…` is `noindex` with no canonical; a stale translation stays indexable with its
  banner; a scaffolded one is the English page, `noindex`; the sitemap lists each page only in the
  languages it is indexable in; redirects and the language rules on machine text answer in one hop
  with the query kept; `csp:check` holds on the docs pages; `locales:check` needed no key.
- **In headless Chrome** (the extension was not connected, and `check-paint.mjs` already drives
  Chrome over the DevTools Protocol with no dependency): no console error or hydration warning on any
  page; `/` opens search and typing a `/` inside it stays literal; Enter navigates client-side to a
  hashed result and lands on the heading; Escape returns focus to the trigger; CJK search returns
  results; Arabic mirrors; nothing overflows at 390px; with JavaScript off the page renders and the
  search control is disabled rather than dead. The layout defects the first screenshots showed are
  the two stylesheet subsections above.
- **Prune on a real site.** Removing a docs config removed that project's extracted trees on the next
  build and nothing else.

### What step 8 deliberately does not do

Pinned version addresses (`/v/<label>/`) have no route rows; `docsRoute` still accepts `pinned`.
There is no `Accept: text/markdown` negotiation, which would need `Vary: Accept` from root's
`headers`. There is no JSON-LD helper; a consumer builds its own. `search.json` was removed, since
nothing specified or read it. On a phone the sidebar renders before the article with no
collapse, which is a design question for when a project has enough pages to make it matter. And
three kcalc guards conflict with docs and are recorded for
kcalc's own install rather than fixed here: `seo-audit.mjs` expects exactly its registry's URLs in
the sitemap, `check-assets.mjs` refuses `.png` and `.svg` in `public/`, and `check-forbidden.mjs`
scans the prefetched trees.

## Language, direction and the phone (step 9)

Step 9 is what a browser found on the running hex-web build that no suite here could see: the
phone layout, the search dialog's dismissal, a line breaker, and then the whole question of
which language each run of text on a page is actually in. What follows is what would
otherwise be rediscovered.

### Two marks, one condition, and the article is the thing they are relative to

`src/site/direction.ts` holds every `lang` and `dir` decision the renderer makes.
`contentMark(requested, content)` is for the page's own words standing in the interface's
furniture, `interfaceMark(requested, content)` for the interface's words standing inside the
article, and both answer nothing when the two locales agree, because an element repeating a
language it already inherits makes a screen reader announce a change into the language it is
already reading.

The article carries the locale it is **in**, never the one that was asked for. Measured on
hex-web's `/ar/hex-nfc/docs`: the translation notice inside an article marked `lang="en"
dir="ltr"` computed direction `ltr`, sat flush against the left of its box with 443px of empty
space beside it, painted its final full stop before its first word, and was read to a screen
reader as English.

`interfaceLang` is the third function and the reason it exists is measured, not stylistic. A
status mark and a task marker are empty elements whose whole content is an `aria-label`, so
the exemption `interfaceMark` documents for a fence's region name does not reach them: there
is no text beside the attribute for the text to win over. They take the `lang` and not the
`dir`, because `dir="rtl"` makes `.hx-status-half` match its own `:dir(rtl)` rule and fill its
other half, and a half-filled shape that fills the wrong half says the opposite of what the
row says. `reference/chip-support` at an Arabic address carries 101 of these.

### Mark the words, never the box

The rule the second review produced, and the case that produced it. `interfaceMark` spread on
`<button class="hx-copy">` moved the Copy button from the end of the fence bar to its start on
every right-to-left address serving a fallback page: the button is a flex item in a bar that
stays left to right, `margin-inline-start: auto` resolves in the **item's** own direction, and
`dir="rtl"` flipped which side the auto margin absorbed. Measured at 1280px: 12px from the
bar's start where it belongs 12px from its end, and the same flip at 360, 390 and 768. A bar
that also carries a language chip did not move, because `.hx-fence-lang + .hx-copy` zeroes
that margin, so one page could show two fences with the button on opposite sides.

So a mark goes on the smallest element holding nothing but the run of text it describes: the
copy button's label, a crumb's label, a pager's title and a tree row's label each sit in a
span of their own. The same trap is one line away in `.hx-next`, which carries
`margin-inline-start: auto` and `text-align: end`, and in every row of the tree and the trail,
where the current-item bar is an inset shadow with a `:dir(rtl)` mirror keyed on the element
itself.

The two exceptions are lists whose every row is in one language: the outline and the search
results. There the mark is on the list, because the box is what has to mirror. The outline's
depth indent is `padding-inline-start` on `.hx-toc-item[data-depth]` and the current-item bar
sits on the inline start, and both belong on the side those words are read from.

### `labelOf` returns the locale it chose

The trail, the pager and the sidebar are the interface's furniture and their rows are other
pages' titles, which the manifest gives in the reader's language where that page is translated
and in the source's where it is not. The first version of step 9 marked the containers and
left the labels, on the grounds that the shell could not say which. It could, one call away:
`labelOf` picks `record.locales[locale] ?? record.locales[source]`, so the chooser knows. It
returns `{ label, locale }` now, `DocsCrumb`, `DocsPager` and `DocsNavNode` carry
`labelLocale`, and each label is marked with it. Marking only the container declared four
English page titles on hex-web's Arabic architecture page to be Arabic, which is the same
defect as the notice, in the other direction.

### The sweep is one rule in both directions, over every address twice

`test/render/shell.test.tsx` asserts that every run of text and every accessible name sits
under a declared language the words in it could be in. One rule: an Arabic interface string
inside an article marked English breaks it, and so does an English page title inside a
breadcrumb marked Arabic.

Three things about its shape are load bearing, and each closes a hole the previous version
had.

**It reads the whole shell, with the reader's locale as the baseline**, because that is what
both consumers write on `<html>`. The sidebar, the outline and the trail are outside the
article and every one of them carried the defect.

**It sweeps every locale against every slug, and then the corpus again as an English-only
bundle.** The first version read one page, and that page was the only page in the corpus
carrying none of the five node types that emit an interface string inside the article, so its
empty result was empty partly because nothing on it could have filled it. The English-only
pass is not padding either: `hexdocs init` publishes exactly that, which is what hex-nfc serves
today, and without it the corpus has no fallback page carrying an ordered procedure, so the
step number could be left unmarked with all 56 real addresses green.

**Evidence, not a script range.** The old detector was `/[؀-ۿ]/`, which cannot see a French
stray, and the one corpus pairing that is a fallback over a page carrying statuses and
external links is `fr`/`reference/chip-support`. A run is judged against the string tables and
the manifest's labels: interpolated strings are matched as patterns, because `Step {number}`
matched literally is how the step number stayed unmarked. A run with no evidence either way is
skipped, which is why the sweep asserts how many it placed.

There is one exemption list, three keys long, and it is checked in both directions: a fence's
region name and a table's are interface strings on elements whose content is the page's own,
and HTML has no way to give an attribute a different language from the text beside it.

### The line breaker belongs on the root

`overflow-wrap: break-word` was scoped to `.hx-code`, which fixed a long identifier for an
author who writes backticks and for nobody else. Measured at 390px on a page carrying
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` as its title, a heading and a pager title: the
title ran 362px past the screen, the heading 413px, and in Arabic the pager ran 82px off the
leading edge instead. It is on `.hx-root` now, where every text holder inherits it.
`break-word` contributes nothing to the minimum content width, which is what lets it sit there
without collapsing a table's column, and a fence keeps `white-space: pre` and never wraps at
all.

`.hx-pager a` needed `min-inline-size: 0` beside it, and it is the one holder the inherited
property could not reach: a flex item's automatic minimum size is its content's, so the link
held its own width however willing the text inside it was to break.

A block element's box is the column's width whatever its text does inside it, so the spill
probe reads the **ink** of each block holder as a range as well as its box. Without that, a
heading whose one unbreakable word runs off the screen reports nothing, and in a
right-to-left page the page's own `scrollWidth` cannot see it either.

### The dialog's one exit did not include the backdrop

The comment said Escape, the backdrop, the close button and choosing a result all reached one
exit. The backdrop did not: a modal `<dialog>` does not light dismiss on its own. A click on
it has the dialog itself as its target, because the backdrop is the dialog's own
pseudo-element, so the target is what rules out clicks on things inside and the box is what
tells a backdrop click from a click on the dialog's own padding. The press has to be paired
with the click, because a click is dispatched at the common ancestor of where the press went
down and where it came up: a reader selecting the last word of a result and releasing outside
produces exactly the event a dismissal produces.

Not the `closedby` attribute, and the reason is not its support table. An engine that honours
`closedby="any"` dismisses before any handler runs and one that does not falls through, so the
behaviour would depend on the reader's browser and the path under test would be the path
nobody takes.

### The public surface is pinned, and `contentAttrs` is the reason

`contentAttrs` and `ContentAttrs` were the whole of `direction.ts`'s public surface, the
barrel re-exports that module wholesale, and step 9 replaced them. Nothing here noticed and
neither consumer did, because neither called them. `test/exports.test.ts` holds both barrels'
runtime names in both directions, the types a consuming site annotates with as `import type`
bindings, and a `WITHDRAWN` list with a reason per name, so a removal leaves a record and a
name cannot quietly come back under a different meaning.

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
