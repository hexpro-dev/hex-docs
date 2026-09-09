---
name: docs-publish-version
description: Compile a documentation tree into a bundle, publish it, and label a commit as a version the website serves. Use when shipping a documentation release, when a docs change needs to become visible, or when a published bundle needs checking.
---

# Publishing a version

Two repositories are involved and the split is the point. The app repository produces a
bundle for every commit on `main`. The web repository decides which of those commits is a
version anybody can see.

**Labelling is the throttle.** A bundle exists for every commit; none of them is visible
until somebody writes a version entry, and that entry is a commit to the web repository
and therefore a deploy. That is also why nothing is fetched at request time: there is no
state in which the bucket has something the site should be showing and no deploy has
happened.

## In the app repository

### 1. Compile and read the report

```hexdocs-cli
hexdocs build --out .hexdocs-bundle
```

`build` writes the bundle **even when the lint has errors**, and says so. That split is
deliberate: producing a bundle and deciding whether to publish it are different jobs, and
the exit code is the gate. Read the envelope before doing anything with the output.

The bundle is a product of a commit and nothing else, so recompiling is always safe and
the same commit always compresses to the same bytes. If a re-run reports different bytes
for a key that already exists, that is either a toolchain change under a published sha or
a compile that is not deterministic, and both are worth stopping over.

### 2. Verify what you are about to publish

```hexdocs-cli
hexdocs bundle .hexdocs-bundle/<project>/<sha>/ast-1
```

Five rows: the manifest parses and satisfies its own invariants, the AST major is one this
toolchain knows, every object the manifest names is present and no others are, every
digest matches, and every page and index payload parses against its schema.

### 3. Publish

```hexdocs-cli
hexdocs publish .hexdocs-bundle/<project>/<sha>/ast-1 --bucket "$HEXDOCS_BUCKET"
```

There is no default bucket, deliberately: hex-docs is a public repository and a default
here would be a command that appears to work while writing into a bucket somebody else
owns.

Write-once is enforced three times over, and each one closes a different gap: the local
writer refuses to overwrite a key with different bytes, the preflight compares the stored
checksum before sending anything, and every upload carries a conditional header so the
bucket refuses a key that already exists. A re-run on the same sha writes nothing and
exits 0. If it reports that every object matched and the manifest did not, read the
message: the toolchain version lives inside the manifest bytes, so republishing an old sha
after a submodule bump is that exact shape and is not a content change.

In practice this runs from the workflow rather than from a terminal. The workflow has no
`paths:` filter on purpose: release commits are precisely the commits least likely to be
docs commits, and a filter means the commit somebody wants to label has no bundle. It also
checks out with full history, because freshness is a comparison of commit dates and a
shallow clone makes every page read `current`.

## In the web repository

### 4. Validate the label before writing it

```hexdocs-cli
hexdocs label --project hex-nfc --commit <40-hex-sha> --version 1.0.0
```

It writes nothing and returns the JSON patch. Three rows:

- The shape: a full forty-character sha (abbreviations collide eventually), a label that
  is safe as a URL segment, a date, and no collision with an existing label or an
  already-labelled commit.
- A bundle exists for that sha. Checked against the local prefetch cache, and against the
  bucket as well when credentials are present. Without credentials that arm is skipped
  with the reason and the local arm still decides.
- Ancestry: the commit is on the default branch. This is answered against the remote,
  because from the web repository the app repository is a sibling directory and the sha is
  not in this history at all. When neither route is available the row is skipped naming
  both, rather than passing.

Apply the patch with Edit. Exactly one entry carries `default`, and it is the version
served at the unprefixed address, the only one in the sitemap, and the only indexable one.

### 5. Fetch it and update the derived fields

```hexdocs-cli
hexdocs prefetch --site apps/front
hexdocs sync --site apps/front --project hex-nfc
```

`prefetch` is keyed by sha, so relabelling a sha does no network at all, and a warm cache
needs no AWS credentials. It verifies the stored digest of every object as fetched and the
uncompressed digest of every payload after extracting, then lands the page payloads and
raw markdown inside the app tree where a lazy glob and the resource routes reach them, and
the search indexes and images under `public/`, which is where a same-origin fetch can
reach them at all.

`sync` writes `pages`, the hidden list and the per-version digests back into the config,
and nothing else. It is byte-idempotent: run it twice and the file does not change.

### 6. Confirm, then deploy

```hexdocs-cli
hexdocs verify-install --site apps/front
```

Then the site's own build, because that is where the guard actually runs.

## What not to do

**Do not garbage-collect old bundles.** They accumulate slowly and a thousand of them is
single-digit dollars a year. A script that decided which are still referenced would have to
read every web repository's version table, and getting that wrong deletes a live version.

**Do not label a commit you have not verified has a bundle.** The version picker offers it
and every page under it 404s, and nothing on the site can tell you why.

**Do not add a `paths:` filter to the publish workflow.** See above: the commit you want to
label is the one it would skip.
