# Documentation guide for Fixture App

This file is at `docs/CLAUDE.md`, one level above `docs/site/`, and that placement is
the point rather than an accident.

`sync-public.sh` copies `docs/site` into the public mirror and its
`prune_internal_files()` deletes `CLAUDE.md`, `AGENTS.md`, `.claude` and `.agents` by
name afterwards. An agent handed a documentation tree will reasonably drop its
authoring guidance beside the content it governs, and the tagged public release then
dies in the prune step with an error about a file nobody put there on purpose. So
`FORBIDDEN_SOURCE_NAMES` refuses those four names anywhere under `docs/site/`, and the
guidance lives here instead.

## Where things go

- `docs/site/docs.json` governs the project: sections, locales, budgets, lint, glossary.
- `docs/site/nav.json` is the order and the page namespace. Language neutral: it
  references slugs, and titles come from each locale's own front matter.
- `docs/site/content/<locale>/<slug>.md` is a page. The slug is the path, minus `.md`.
- `docs/site/snippets/<locale>/<id>.md` is a fragment transcluded with
  `::include[safety-note]`. Two colons and a bracketed argument: that is the leaf directive
  form, and `include` is deliberately not a container, so a three-colon spelling is
  refused rather than parsed.
- `docs/site/assets/` holds images, referenced by relative path from a page.
- `docs/docs.private.json` is the deny list, deliberately outside `docs/site/`. It
  names the strings that must never ship, so keeping it inside the tree the publisher
  reads would be the same mistake in miniature.

## What front matter may not say

A page cannot declare its slug, its order, its language, its date or its author.
Each of those already has an owner: the filename, `nav.json`, the directory, git and
git. Two owners for one fact is how a page ends up routable and unpublished.

## House style

Australian spelling. No em dashes, no en dashes outside numeric ranges, no decorative
unicode, no bolded lead-ins on every bullet, and none of the banned phrasings in the
estate rule pack. Status glyphs in a support matrix are data rather than decoration
and are exempt by being recognised as `status` nodes before any prose rule runs.

Run `hexdocs lint docs/site` before committing. It reads the same rule pack the
website's own scripts do, so a phrase that passes here passes there.
