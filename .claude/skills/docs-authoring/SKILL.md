---
name: docs-authoring
description: Write, illustrate, translate and review a documentation page. Use when adding or editing a page under docs/site, when translating one into the other six languages, when reviewing a translation, or when adding an image to a page.
---

# Authoring a documentation page

One workflow in five sections, done in order by the same agent in one session. It is one
skill rather than four because that is how the work actually happens: you write a page,
you illustrate it, you translate it, you check the translation, and stopping halfway
leaves the tree in a state the checks report on.

## 1. See what is there before adding to it

```hexdocs-cli
hexdocs pages
```

Two state columns, and they are not the same question:

- `state` is the page's own translation state, which is what the coverage counts and what
  tells you which files to open.
- `effectiveState` is the worst of the page and every snippet it transcludes, which is
  what a reader actually gets. A `current` page full of stale snippets is not current to
  the person reading it.

Read the existing pages in the section you are adding to before writing. Terminology
consistency across a manual matters more than any individual sentence, and the project's
glossary in `docs/site/docs.json` is the authority on it.

## 2. Create the page

```hexdocs-cli
hexdocs scaffold page --slug guide/writing-a-tag --title "Writing a tag" --locale en
```

It returns file contents. Write them with the Write tool; the command does not touch the
filesystem, so every change is visible in the transcript and in git.

**`scaffold page` never overwrites.** If the file exists it is omitted from the result and
a note says so. Editing an existing page is Read then Edit, not a scaffold.

The slug is the filename and is not a front matter field, so a page cannot disagree with
its own address. `index.md` is the section root and maps to the trailing-slash address.

### Front matter

`title` and `description` are required. `description` has a maximum and no minimum: a
floor measured in characters is a floor on Latin, and correct Japanese is roughly half the
character count for the same content. The same reasoning already applied to `title`, where
a three-character minimum rejected 指南, which is two characters and is correct.

Ordering is `nav.json`, never a number in front matter. `nav.json` is language neutral and
references slugs, and titles come from each locale's own front matter. That is what makes
"a page cannot exist in one language and not another" a checkable property.

### Writing the body

Start at heading level two. The page title is already the only `h1`, and a second one
gives the page two document outlines, which is what a screen reader and a crawler each
read to decide what the page is about.

The house rules are not preferences and several are protected, meaning a project cannot
lower them:

- **No em dashes.** Use commas, parentheses, colons or separate sentences. The one
  exception is narrow and deliberate: an em dash is recognised as a status glyph when it
  is the **entire content of a table cell**, meaning "not applicable". Anywhere else it is
  a finding, including in a heading and including in a list item.
- **No en dashes in prose.** Numeric ranges only.
- **No decorative unicode.** Check marks, crosses, warning signs, arrows used as bullets
  or emphasis, and emoji. A check mark in a support matrix is different: the compiler turns
  a recognised status glyph into a `status` node before any prose rule runs, so it is data
  and it is fine. One in a sentence is decoration and is not.
- No "it's not just X, it's Y", no "whether you're X or Y", no "unlock", "leverage",
  "seamless", "robust", "delve", "elevate", "empower". No rhetorical question openers
  answered by the next sentence. No three-adjective triads.
- Australian English: organise, licence as a noun, centre.

Vary sentence length deliberately. State things directly. Let a plain sentence stand
without a flourish, and cut any sentence that exists only to introduce the next one.

## 3. Add an image, if the page needs one

Put it under `docs/site/assets/` and reference it from the page. Two things are checked
and both are refusals rather than conversions:

**Colour space.** An iOS screenshot comes off the device in Display P3, tagged with a PNG
`cICP` chunk, and that tag is the only record of what the numbers mean. Dropping it without
converting makes P3 numbers get read as sRGB, so every colour lands short and the asset
looks flat. `asset-colour-space` refuses an unconverted P3 asset rather than converting it,
because the conversion has to be deterministic for the bundle to be byte reproducible and
every encoder available here is a shell out whose output varies by build. Convert before
adding: `ffmpeg` with `zscale` from `smpte432` to `bt709`, and check what the file declares
first, per file, never in a batch. Forcing the conversion on a file already in sRGB
oversaturates it by roughly forty per cent, which is the same bug in reverse.

**SVG.** An SVG asset is a same-origin document on the consuming site, not only an `<img>`
source, so `asset-svg-unsafe` refuses scripts, foreign objects and external references.

Write real alt text. An image with an empty alt attribute is announced as nothing, which
is right for decoration and wrong for a screenshot the paragraph refers to.

## 4. Check before claiming it is done

```hexdocs-cli
hexdocs check --category house-style
hexdocs check
```

Read `consequence` on anything you are tempted to dismiss. Run the unfiltered check as
well: a filter narrows the report and the summary is re-derived over what is left, so a
clean filtered run says nothing about the categories it excluded.

## 5. Translate, into the other six

```hexdocs-cli
hexdocs scaffold page --slug guide/writing-a-tag --locale zh --locale ar --locale es --locale ja --locale fr --locale pt-BR
```

Each scaffolded file carries `translated: false` in its front matter and a body that is the
source's headings with a TODO under each. **It is never a copy of the English prose**, and
that is the single most important property of this step. A scaffolder that copied the
English and marked it translated would put six locales of English prose into production as
Chinese, Arabic and Japanese documentation, permanently, with nothing able to report it,
because there would be no state between "missing" and "done".

Two independent things then make the compiler grade the file `scaffolded`, and either
alone is enough: the flag, and a body that is not byte-identical to the source. Remove the
flag when you have actually translated the file, and not before.

While translating:

- The glossary in `docs/site/docs.json` is binding. A `do-not-translate` term stays in
  English, because localising a chip part number makes the page unfindable by the person
  reading the part number off the chip. A `translate` term has exactly one spelling per
  language, which is what stops one manual written across three sessions using three words
  for the same object.
- Keep the heading set. `heading-set-matches-source` is an error when the translation is
  current and a warning when it is already stale, because the alternative deadlocks: add
  one heading to an English page and the only ways to publish would be to retranslate six
  pages immediately or delete them.
- Arabic is right to left, and the source order of a bidirectional run matters. Do not
  strip U+200F.
- `zh` on the web is `zh-Hans` in an app's string catalogue. Normalise at the boundary; do
  not invent an eighth locale.

## 6. Review a translation

```hexdocs-cli
hexdocs check --locale ja
hexdocs page guide/writing-a-tag --locale ja
```

Read the rendered page, not only the report. What the checks cannot tell you is whether
the Japanese reads like documentation or like translated English, whether the Arabic
reading order is right, and whether a table makes sense to somebody using a screen reader.
Those are the three things marked as a person's job, and saying so is more useful than a
green report that implies otherwise.
