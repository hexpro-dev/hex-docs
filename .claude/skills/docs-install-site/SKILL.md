---
name: docs-install-site
description: Mount a documentation project into a consuming website. Use when adding docs to a React Router site for the first time, when adding a second documented project to a site that already has one, or when the docs wiring check is failing.
---

# Installing docs into a consuming website

## 1. Look at what is there

```hexdocs-cli
hexdocs doctor --site apps/front
```

The consuming sites are not interchangeable, and the install adapts rather than assuming.
One has a workspace glob that would enrol the submodule as a package; another has an
explicit include list and needs no exclusion at all. One composes its localised path list
from several arrays and has somewhere to splice; another aliases a single page registry
whose keys are a closed union, so joining that registry is not available and concatenating
is. The checks report which case they found, and the remediation differs.

## 2. See the plan

```hexdocs-cli
hexdocs install --site apps/front
```

Without `--write` this prints every edit it would make and every one it will leave to you.
Read the whole plan before applying it. The dry run is produced by the same code path as
the real run, so what it prints is what would happen.

## 3. Apply it

```hexdocs-cli
hexdocs install --site apps/front --write
```

It writes the mechanical edits: the submodule declaration, the workspace exclusion where
one is needed, the `tsconfig` path entries, the deploy hash directory, the prebuild hook,
the generated `app/lib/docs.ts`, the `check-docs.mjs` shim, the `.mcp.json` entry and the
site `.gitignore` additions.

Every edit is line anchored and preserves the file's own indentation and comments. Nothing
is parsed and re-serialised, because one of these files is JSON with comments, another
carries deliberate hand-packing, and a third is roughly half prose. An edit whose anchor is
missing or is not unique is refused and printed rather than guessed at, and the other edits
still apply: something else being wrong elsewhere is not a reason to write nothing.

**Re-running `install` is a no-op.** The predicate that says "this edit is already there"
is the same function the corresponding wiring check calls, so "already installed" and
"correctly installed" are one fact and there is no third state.

## 4. Apply the four edits it leaves to you

`install` prints these with the exact text and the anchor. Apply them with Edit.

Three are one-line spreads, into the route table, into the localised path list, and into
the sitemap entries. They are left to a human because those files are not generated, they
carry the repository's real documentation in their comments, and an installer that
rewrote them would be editing prose it did not write.

The fourth is the Claude Code settings entry that enables the MCP server and adds the
skills directory. The server is `hexdocs mcp`, which `.mcp.json` reaches through
`kit/start.sh` so the entry names a stable path rather than encoding a subcommand. Once it
is enabled, `docs_skills` returns these procedures to an agent working in that repository,
which matters most where `.claude/` is gitignored and the skills cannot be committed.

That entry is printed rather than written, and the reason is worth knowing before you
decide to automate it. Both a project settings file and a local settings file exist in
these repositories; the local one is gitignored and is the one that actually lists the
enabled servers. Whether the two merge or whether local replaces project wholesale could
not be established, and an installer that guessed wrong would silently switch off the other
MCP servers the repository already uses. Applying it by hand costs a minute.

## 5. Write the project config, then fill it in

Create `apps/front/app/docs/<project>.docs.json`:

```hexdocs-cli
hexdocs scaffold site --project hex-nfc --site apps/front
```

Its `navLabel` comes out already translated into all seven languages, taken from the
package's own UI strings. That is what makes installing docs need no edits to the site's
locale files: those files are compared key for key in both directions by the site's own
guard, so two chrome keys would have been fourteen mandatory edits rather than none.

`pages` starts empty. Do not hand-maintain it:

```hexdocs-cli
hexdocs prefetch --site apps/front
hexdocs sync --site apps/front --project hex-nfc
```

`sync` writes `pages` and the per-version digests and touches nothing else. The list has to
be a build input because the canonical link and all eight hreflang alternates are rendered
above the meta outlet and gated on it, and a child route can append tags but never delete
them. A slug list that only existed at runtime would put a self-referential canonical and
eight alternates pointing at eight 404s on every mistyped docs URL.

## 6. Confirm

```hexdocs-cli
hexdocs verify-install --site apps/front
```

Then run the site's own guards, which must still pass with **zero** new locale keys:

```
pnpm locales:check
pnpm typecheck
pnpm build
```

`pnpm build` is the one that matters, because the docs guard hangs off `prebuild` and
`prebuild` is the one thing that always runs. There is no CI on these repositories, so a
check that only runs when somebody remembers to type it is not a guard.

## 7. What the report says it did not check

`verify-install` closes with a list of what it deliberately does not cover, and it is worth
reading rather than skipping. The static needles prove a file consults the docs registry;
they cannot prove the code around them produces the right route table, because neither
consumer's route table can be read from Node without executing a bundler module. So a docs
spread that is present, wrong and green is a state this guard leaves open, and the things
that close it are running the site and looking:

```
curl -s localhost:5173/hex-nfc/docs/ | grep -c 'rel="alternate"'
curl -si localhost:5173/hex-nfc/docs/ | grep -i 'content-security-policy'
curl -s -o /dev/null -w '%{http_code}\n' localhost:5173/banana/hex-nfc/docs/llms.txt
```

Eight alternates, a CSP header present, and a 404 on the invalid language. A missing CSP
header means a docs route exported `headers`, which ships the page with no nonce and it
never hydrates.

## Adding a second documented project

One more `<project>.docs.json` beside the first, then `prefetch` and `sync`. The generated
`app/lib/docs.ts` globs `app/docs/*.docs.json`, so there is no code edit and no second
install. Check that the two `basePath` values differ; two projects at one mount is a
configuration error the report names with both file names in hand.
