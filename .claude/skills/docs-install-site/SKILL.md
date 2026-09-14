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
explicit include list and needs no exclusion at all. One keeps its pages in a `[path, file]`
tuple array inside `routes.ts`; another maps a page registry whose keys are a closed union,
so docs pages are declared beside it instead. The checks report which case they found, and
the printed instructions differ to match.

## 2. See the plan

```hexdocs-cli
hexdocs install --site apps/front
```

Without `--write` this prints every edit it would make and every one it leaves to you. Read
the whole plan before applying it. The dry run is produced by the same code path as the real
run, so what it prints is what would happen.

Run it from the repository root, or pass the root as the first argument, because `--site` is
relative to the root. Run from inside the site directory, `install` finds no site at that
path, plans nothing and says so in a `NOT RUN` row.

## 3. Apply the mechanical edits

```hexdocs-cli
hexdocs install --site apps/front --bucket <bucket> --write
```

It writes the workspace exclusion where one is needed, the `tsconfig` path entries for the
package and for `react` (mapped to the site's own `@types/react`), the deploy hash directory,
the prebuild hook, the generated `scripts/check-docs.mjs`, the `.gitignore` entries for the
prefetched trees, the `.mcp.json` entry, and three modules written only when absent:
`app/lib/docs.server.ts`, `app/routes/docs.tsx` and `app/routes/docs.machine.tsx`.

`--bucket` goes into the prebuild string install writes, which lives in this site's private
`package.json`. Leave it out and set `HEXDOCS_BUCKET` in the deploy environment instead if you
prefer. Never put the bucket in a site config: the server module globs every config eagerly,
and an eager glob inlines the whole object into the site's JavaScript.

Every edit preserves the file's own indentation and comments. An edit whose anchor is missing
or not unique is refused and printed rather than guessed at, and the others still apply. A
prebuild that already runs `hexdocs prefetch` in a way the CLI would refuse is refused too,
with the segment named, because appending a correct one after it would leave the broken one
first in the chain.

**Re-running `install` is a no-op.** The predicate that says "this edit is already there" is
the same function the matching wiring check calls, so "already installed" and "correctly
installed" are one fact.

## 4. Apply what it prints

`install` prints each of these with the code to paste and where it goes. Apply them with Edit.

- **The submodule.** `git submodule add` with the command it prints. A stanza in
  `.gitmodules` alone is not a committed submodule.
- **The site config.** One `<project>.docs.json` under `app/docs`, for the commit the site
  should serve, from the scaffold command below this list. Its `navLabel` comes out translated
  into all seven languages from the package's own UI strings, so installing docs needs no
  edits to the site's locale files.
- **The route table.** Insertions into `routes.ts`: the import, the page rows into the site's
  page list, and the machine rows at the top level with the id each row carries. Paste the
  insertions only. Never replace the whole default export, which drops the site's own routes.
- **`root.tsx`.** Docs addresses do not join `LOCALISED_PATHS`. Root asks the matched docs
  route instead, through `docsSeoFromMatches(useMatches())`, and takes whether the page is
  indexable and which languages its alternates may name from that. Leaving docs out of
  `LOCALISED_PATHS` is also what keeps the language-cookie redirect away from them, which the
  translation notice depends on.
- **The sitemap.** A block that lists each docs page from `DOCS.sitemap()` in the languages
  that page is indexable in, with `x-default` at the English address.
- **`resolveJsonModule`**, when the shared TypeScript config this site extends does not
  already set it.

```hexdocs-cli
hexdocs scaffold site --site apps/front --project hex-nfc --commit <sha> --version 1.0.0 --released 2026-09-14
```

## 5. Fill in the pages

`pages` starts empty, and `sync` is what fills it. Do not maintain it by hand.

```hexdocs-cli
hexdocs prefetch --site apps/front
hexdocs sync --site apps/front --project hex-nfc
```

The first `prefetch` after a scaffold exits 3. It extracts the bundle and then fails its last
row, `prefetch-skew`, because the bundle carries pages the empty list does not name. Leave
the row alone and run `sync` next: it reads the bundle `prefetch` has just extracted, so it
cannot go first, and the following `prefetch`, which the site's own prebuild runs, passes. A
release that adds a page fails the same row until `sync` runs again.

`sync` writes `pages`, `hidden`, `redirects` and the per-version digests, and touches nothing
else. The route rows are derived from those lists, so they have to be a build input.

## 6. Confirm

```hexdocs-cli
hexdocs verify-install --site apps/front
```

The route row runs this site's own `react-router routes --json` and compares the table it
prints with the docs rows, so it needs the site's dependencies installed. Then run the site's
own guards and build:

```
pnpm typecheck
pnpm build
```

`pnpm build` is the one that matters. The docs guard hangs off `prebuild`, and `prebuild` is
the one thing that always runs; there is no CI on these repositories.

On a checkout where the docs submodule was never initialised, a build stops on the prebuild's
prefetch segment, before the guard runs, with the shell's own error and exit 127. On macOS it
reads:

```
sh: ../../common/docs/kit/bin/hexdocs: No such file or directory
```

The path is the launcher as the prebuild string spells it, relative to the site. Run
`git submodule update --init common/docs` from the repository root, with the mount this site
uses. `git pull` does not check out a submodule a commit added on every clone, so the first
build after the docs integration merges is where this appears. The guard's own sentence about
the submodule is printed only when `node scripts/check-docs.mjs` is run by hand.

When the guard does run and a row fails, the rows that did not pass are printed last, with
their findings, so they are what a deploy log's last lines show.

## 7. What the report says it did not check

`verify-install` closes with a list of what it deliberately does not cover. `root.tsx`, the
sitemap and the route modules are read as text, which proves the calls are there and not that
the tags they produce are right. Run the site and look:

```
curl -s localhost:5173/hex-nfc/docs | grep -o 'hreflang="[^"]*"' | sort | uniq -c
curl -si localhost:5173/hex-nfc/docs | grep -i 'content-security-policy'
curl -s -o /dev/null -w '%{http_code}\n' localhost:5173/banana/hex-nfc/docs/llms.txt
curl -si localhost:5173/hex-nfc/docs/index.md | grep -i 'x-robots-tag'
```

Count `hreflang` attributes rather than `rel="alternate"` links, and expect only the languages
the page is indexable in plus `x-default`. A missing CSP header means a docs route exported
`headers`. The invalid language must be a 404.

The site's own guards read the prefetched trees too. A guard that scans `public/` for asset
formats, or scans `app/` and `public/` for forbidden words, sees every bundle's assets and raw
markdown, so settle how it treats `public/_docs` and `app/docs/_bundles` before the first
build that has them.

The deploy hashes both prefetched trees by name. That costs one extra rebuild after a relabel
that already rebuilt the site; add `_bundles` and `_docs` to `hash.exclude_dirs` by hand if
the rebuild matters.

## 8. Editor settings, which are yours to decide

`install` prints a settings block that enables the MCP server and grants its skills
directory. It is not an edit and nothing checks it, because whether one developer's editor
enables a server has nothing to do with whether the site builds. The server is `hexdocs mcp`,
which `.mcp.json` reaches through `kit/start.sh`. Once it is enabled, `docs_skills` returns
these procedures to an agent in that repository.

Whether a local settings file merges with the project one or replaces it could not be
established, and an installer that guessed wrong would switch off the other MCP servers the
repository already uses, so the block is merged by hand.

## Adding a second documented project

One more `<project>.docs.json` beside the first, then `prefetch` and `sync`. The server module
globs `app/docs/*.docs.json`, so there is no code edit and no second install. Check that the
two `basePath` values differ.
