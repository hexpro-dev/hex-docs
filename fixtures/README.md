# The fixture corpus

A synthetic app repository, in all seven languages, that both halves of this package
read. It is step 2 of the plan, and its job is to stop the compiler and the renderer
drifting apart: the compiler's golden tests build it, the renderer's golden tests render
what those produce, and everything either of them relies on is stated here rather than
discovered on disk.

```
fixtures/
├── app/                     the synthetic app repository, the compiler's input
│   └── docs/
│       ├── CLAUDE.md        the authoring guide, one level ABOVE docs/site on purpose
│       ├── docs.private.json  the deny list, deliberately outside docs/site
│       └── site/
│           ├── docs.json    DocsProjectConfig
│           ├── nav.json     the order, and the page namespace
│           ├── content/<locale>/<slug>.md
│           ├── snippets/<locale>/<id>.md
│           └── assets/
├── site/                    the consuming website's half: <project>.docs.json
├── rejected/                assets that must be REFUSED, kept out of the build
├── corpus.ts                the page and snippet inventory, and the commit history
├── nodes.ts                 which page produces which AST node, and how to tell
├── planted.json             banned characters the corpus carries on purpose
├── planted.ts               the typed view of that, plus the planted prose
├── text.ts                  the tokeniser inputs and the normalisation evidence
├── frontmatter.ts           a deliberately narrow front matter reader
└── index.ts                 paths, readers, and the repository materialiser
```

## What it is for, page by page

`corpus.ts` carries the inventory and a reason for every entry. A fixture page with no
stated purpose is the first one deleted when it gets in the way, and the rule it was the
only coverage for goes with it. Read that file before adding anything here.

The corpus is deliberately not uniform. It contains a page in every language, a page in
three, a page in one, a page whose translations are stale, a page whose Spanish file was
scaffolded and never translated, a draft that is excluded from a bundle and still linted,
and a page that is published but hidden from the sidebar. Each of those is a state that
produces a different notice on a published page or a different column in the coverage
table, and none of them can be tested against a corpus where every page is the same.

## The history is real

Translation staleness is `git log -1 --format=%cI` on the English file against the same
on the translation. A corpus committed in one go therefore contains no stale page and
cannot grow one: every file carries the same date, nothing is newer than anything, and
the whole tree reads `current`. That is the shallow-clone failure this package refuses to
run under, reproduced by accident.

So `materialiseCorpus()` copies the tree into a throwaway directory and replays
`FIXTURE_HISTORY` over it with the dates the corpus declares. Two files are revised by a
later commit, which means the first commit has to write something different for them or
the revising commit is empty and `git log -1` never moves. The materialiser writes a
placeholder, and then checks the finished tree byte for byte against the corpus on disk,
so the placeholder cannot leak into what the compiler reads.

## Planted characters, and why nothing is exempt

The corpus has to contain an em dash, a rightwards arrow and two banned emoji. They are
what the linter's own rules exist to catch, and what the `status` node exists to
recognise. Taking `fixtures/` out of the house lint to get them past it would be the
shape of exemption this repository refuses everywhere else.

So nothing is skipped. `planted.json` names each file, each code point and the reason,
`scripts/lint.mjs` reads it, and the check runs in both directions. An undeclared hit
fails. A declared pair that is no longer present fails too, and that half is the one that
matters: a planted character quietly deleted leaves the rule it was the only coverage for
untested, with every row still green. Every declared path must be under `fixtures/`, so
the mechanism can never reach real source.

The same discipline covers the prose. `PLANTED_PROSE` in `planted.ts` names the exact
substring of every planted style violation, so the suite can prove the text is still
there, and the rule ids are typed as `LintRuleId`, so renaming a rule fails the typecheck
rather than orphaning a fixture.

## What it deliberately does not contain

**No golden ASTs, and they are not here now either.** They live with the compiler, in
`kit/test/golden/`, because that is what they are evidence about. The corpus was built
without them on purpose: the canonical JSON a digest is taken over, the word count
behind the reading estimate and the exact scope tokens a highlighter emits are none of
them decidable from the source and the contracts alone, and hand-authoring them before
the compiler existed would have been inventing its answers and checking the inventions
in as evidence. What is decidable from the corpus alone is here: the source, the states,
the node claims and the normalisation evidence.

**No oversized asset.** `budgets.assetBytesMax` defaults to 2 MiB, and committing two
megabytes of noise to prove that a comparison works is a bad trade against a test that
lowers the budget over one of the assets already here.

## The markdown is not formatted by Prettier

`.prettierignore` excludes `content/` and `snippets/`, with the reason. Prettier rewrites
markdown rather than only spacing it: `*emphasis*` becomes `_emphasis_`, table pipes are
realigned, and blank lines move around lists. Every one of those is a construct under
test. The TypeScript, the JSON and this README are formatted normally, and the house lint
still reads every markdown file for banned characters and attribution.

## Adding to it

1. Add the page or snippet to `FIXTURE_PAGES` or `FIXTURE_SNIPPETS` in `corpus.ts`, with
   the locales it exists in, the state each must resolve to, and the reason it is here.
2. Write the files. The runtime suite fails on a file that exists and is not declared, and
   on a declaration with no file.
3. If it is the only source of an AST node or a variant, claim it in `nodes.ts` with a
   pattern that matches the source spelling. `AST_NODE_TYPES` is checked against the claim
   list, so a node type with no claim fails. Since step 3 the claims are checked against
   the compiler as well as against the source: `kit/test/compile/parse.test.ts` compiles
   every English document and asserts each claimed node type is produced by the file that
   claims it, so a pattern that still matches a page the parser no longer turns into that
   node fails there.
4. If it carries a banned character, declare it in `planted.json` with the reason.
5. Run `pnpm verify`.
