---
name: docs-init-source
description: Set up documentation in an app repository for the first time, and migrate any ad-hoc markdown it already has. Use when a repository has no docs/site directory, or when moving existing engineering documents into the publishable tree.
---

# Setting up documentation in an app repository

This runs once per repository. After it, `docs-authoring` is the skill you want.

## 1. Look before writing

```hexdocs-cli
hexdocs doctor
```

Then read the repository's own `CLAUDE.md` and, if there is one, its public mirror script.
Two facts decide how careful the next step has to be, and neither is knowable from the
directory listing.

## 2. Scaffold the tree

```hexdocs-cli
hexdocs init --project hex-nfc --product-name "Hex NFC" --repo hexpro-dev/hex-nfc
```

Without `--write` this is a dry run that prints every file it would create and the exact
allowlist line it would add. Read it. Then:

```hexdocs-cli
hexdocs init --project hex-nfc --product-name "Hex NFC" --repo hexpro-dev/hex-nfc --write
```

It creates `docs/site/docs.json`, `docs/site/nav.json`, `docs/site/content/en/index.md`,
`docs/docs.private.json` and `.github/workflows/docs-publish.yml`. Every file is written
only when it is absent or already byte-identical, so a second run reports `unchanged` on
every line and exits 0.

## 3. The public mirror allowlist, which is the part to be careful about

If the repository has a `scripts/sync-public.sh`, `init` adds exactly one line to its
`ALLOW_PATHS` array:

```
    "docs/site"
```

Four spaces, double quoted, inserted after `"docs/public"`. Not `"docs"`. Never `"docs"`.

**Why that distinction is the whole of this section.** In an app repository that mirrors to
a public GitHub repo, the internal documentation tree is protected by being absent from
that array and by nothing else. The prune step that runs after the copy matches four file
names by hand and expects to find none of them, so it prints "(nothing to prune)" over a
tree it was never looking at. Widening the entry from the publishable root to its parent
copies engineering notes, export-compliance material and device identifiers into a public
repository, and the script then commits, tags and pushes.

`init` refuses rather than writing when any of these is true, and each refusal names what
it saw:

1. There is not exactly one `ALLOW_PATHS` array it can parse.
2. An entry is already exactly `"docs"`.
3. An entry names an internal tree, a marketing directory, a design directory, or the
   mirror script itself.
4. The publishable root is already present as an exact quoted token.

That last one is an anchored match on purpose. Searching for the substring `docs` finds
`"docs/public"` and would report "already wired" on a file that is not.

**The publish workflow is deliberately not allowlisted.** It names the bucket and the
publisher role, and it stays out of the public mirror by the same mechanism the mirror
script itself uses: absence from the array. Do not add it.

## 4. Migrating markdown that is already there

Most repositories that reach this skill have engineering documents somewhere, and they
were written for contributors rather than for the documentation pipeline. Move them one at
a time, running `hexdocs check` between each, and expect real findings rather than a clean
import.

**Expect punctuation findings, and expect them to be errors you cannot lower.** Documents
written for GitHub tend to carry em dashes in prose and arrows between steps, and both are
protected rules: a project config can raise a severity and cannot lower one, so there is no
baseline mechanism and no way to carry a violation forward. This is the deliberate design.
Rewriting them is the work, and it is a few minutes per document.

Three specific things to get right while doing it:

- **A status glyph in a table is data, not decoration.** A support matrix full of check
  marks is fine and stays as it is: the compiler turns a recognised glyph into a `status`
  node before any prose rule looks at the text. What is not fine is a check mark in a
  sentence, or a legend entry that spells the convention out with a bare em dash outside a
  table cell.
- **Fixing an em dash in a heading changes that heading's anchor.** Anchors are derived
  from heading text, and an engineering document is exactly the kind of page other
  documents deep-link into. Add the old anchor to that heading's `aliases` in the same
  edit, or the link rot is silent.
- **Move the document, do not copy it.** Two copies of one document in one repository is
  the problem this whole package exists to stop, and the copy that gets updated is always
  the wrong one.

## 5. If you need a file the scaffolder can produce

`init` writes the whole starting tree, but individual pieces are available on their own,
and they return contents rather than writing:

```hexdocs-cli
hexdocs scaffold workflow --project hex-nfc
hexdocs scaffold page --slug guide/index --title "Guide"
```

### Reaching these instructions when nothing is wired up

Some app repositories gitignore `.claude/` by policy, so the skills cannot be committed
there even though `.mcp.json` can. That is why the whole skill set is also a tool:

```hexdocs-mcp
docs_skills {}
```

It returns every bundled skill body, so an agent in a repository with no local skills
wiring still has the procedures. `hexdocs skills` is the same thing from a terminal.

## 6. The deny list

`docs/docs.private.json` sits **outside** `docs/site/`, deliberately: it names the things
that must never be published, so keeping it inside the tree the publisher reads would be
the same mistake in miniature.

Fill it in. An absent or empty deny list is reported rather than passing quietly, because
a scan that examined nothing has cleared nothing, and this is the check standing between a
device identifier and a public page. It is matched case-insensitively against two inputs:
every source line, so a sample command in a fenced block is covered, and the extracted
prose, which catches a name folded across a soft wrap.

## 7. Confirm

```hexdocs-cli
hexdocs check
hexdocs doctor
```

Then hand over to `docs-authoring` for the first real page, and to `docs-install-site` when
the consuming website is ready to mount it.
