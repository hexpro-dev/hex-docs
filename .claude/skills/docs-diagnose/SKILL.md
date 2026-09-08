---
name: docs-diagnose
description: Work out what is wrong with a documentation setup and what to do about it. Use when a docs build fails, a page does not appear, a translation notice is wrong, a version serves nothing, or any hexdocs command reports something you do not recognise.
---

# Diagnosing a hex-docs setup

## Run this first, always

```hexdocs-cli
hexdocs doctor
```

It runs every check that applies to the repository you are in and adds none of its own.
That is deliberate: `doctor` concatenates the rows the individual commands produce, so it
cannot tell you something `hexdocs check` and `hexdocs verify-install` would disagree
with. If a row looks wrong, run the command that owns it and you will get the same answer
with more detail.

Over MCP:

```hexdocs-mcp
docs_doctor {"root": "."}
```

## How to read the report

Four states, and only one of them means nothing to do.

| State     | What it means                                                                        |
| --------- | ------------------------------------------------------------------------------------ |
| `PASS`    | The check ran, examined the number of things in the count column, and found nothing. |
| `FAIL`    | The check ran and found something. The findings under the row say what.              |
| `SKIPPED` | The check deliberately did not run, and the note says why. **This is not a pass.**   |
| `NOT RUN` | The check should have run and could not. This fails the run.                         |

Two things about that table are worth holding on to.

**A count of zero on a passing row is impossible by construction.** `checkRow` turns a
pass that examined nothing into a failure, because a check that walked an empty directory
and exited zero has not passed: the glob stopped matching, or the directory moved. So if
you ever see one, the report was assembled by hand and you should not trust it.

**`SKIPPED` is a decision somebody wrote down.** `wiring-allow-paths` skips in a
repository with no public mirror, and that is correct. It does not skip because the check
is broken, and a skip whose note is empty is itself reportable.

## From a finding to the next edit

Every finding carries four fields, and the third is the one agents skip and should not:

- `message` says what is wrong.
- `consequence` says what breaks if you leave it. Read this before deciding a finding is
  cosmetic. Several of these rules exist because the failure they prevent is silent.
- `remediation` says what to do, in prose, when the message does not already say it.
- `suggestion` is a concrete replacement, safe to apply verbatim. It is `null` when the
  fix needs judgement, and that is different from an empty string.

Every report also carries one `nextAction`. Follow it rather than picking a finding
yourself: the list is ordered worst first, then by category, then by position, and the
next action names the one that is blocking the others.

## Where each kind of problem lives

| The finding is about                                               | Run                                    |
| ------------------------------------------------------------------ | -------------------------------------- |
| A page: front matter, headings, links, prose, translations, assets | `hexdocs check`                        |
| Which pages exist and how translated they are                      | `hexdocs pages`                        |
| One page's actual text                                             | `hexdocs page <slug>`                  |
| A compiled bundle: objects, digests, payloads                      | `hexdocs bundle <path>`                |
| A labelled version with nothing behind it                          | `hexdocs label` in the web repository  |
| The consuming website's wiring                                     | `hexdocs verify-install --site <site>` |

## Failures that do not look like what they are

**Every translation reads `current` and you know some are stale.** The clone is shallow.
Freshness is a comparison of committer dates, and in a shallow clone every file carries
the same date, so nothing is ever newer than anything. Set `fetch-depth: 0` on
`actions/checkout`. `bundle-shallow-clone` reports it, but only if it ran.

**A version in the picker serves 404s on every page.** The commit is labelled and no
bundle exists for it. Either the publish workflow has not run for that commit, or
`hexdocs prefetch` has not run on this machine. `hexdocs bundle <cache>/<project>/<sha>/ast-1`
says which.

**The docs pages render and never become interactive.** A docs route module exports
`headers`. React Router copies only `Set-Cookie` from a parent's headers, so that export
ships the page with no `Content-Security-Policy` and therefore no nonce, and without the
nonce the markup arrives and hydration never happens. `wiring-routes` refuses the export;
the symptom is three layers away from the cause.

**A deploy reports "unchanged" and production keeps serving the old pages.** The submodule
is not in `deploy.config.json`'s `hash.extra_dirs`. Change detection is hash based over
project directories, so a change inside an unlisted submodule leaves the hash identical.
`wiring-deploy-hash-dirs` is the row.

**A mistyped docs URL returns a page with a canonical pointing at itself.** The slug list
in `<project>.docs.json` is stale. `root.tsx` renders the canonical and all eight hreflang
alternates from that list, above the meta outlet, and a child route can append tags but
never delete them. Run `hexdocs sync`.

**`hexdocs check` reports nothing at all and exits 3 with one `NOT RUN` row.** The tree is
not in a git repository, or has no commits. That is a refusal rather than a fallback on
purpose: supplying a synthetic commit would make every page read `current`.

## What to do when a check is skipped and you wanted an answer

Say so, and say why it skipped. A skipped row is the honest state for "this repository
does not have the thing I check", and turning it into a pass to get a green report is the
one change that would make this whole surface worthless.
