---
title: Fixture App documentation
description: Read and rewrite the NDEF records on an NFC tag from an iPhone, with nothing leaving the device.
navTitle: Overview
tags:
  - scanning
---

Fixture App turns an iPhone into a tag reader and a tag writer. It runs
on the NFC hardware Apple exposes to third-party apps, which means one
tag at a time with the Scan sheet open.

## What Fixture App does

Hold the top edge of the phone against a tag and the app decodes the
NDEF message on it. From there you can edit a record in place or
overwrite the tag with a new one. Nothing is uploaded, and no scan
history survives closing the app.

The reader understands these payloads:
- text records, with the language code the tag declares
- URI records, including `tel:` and `mailto:` shortcuts
- Wi-Fi handover records written by an Android phone
- vCard payloads, shown as a contact card

Writing is *destructive*. The app replaces the whole NDEF message
rather than appending to it, so whatever was on the tag is gone the
moment you tap **Write**. A locked tag stays readable, and the writer
stops with `Tag is permanently locked` instead of reporting success.

## What you need

Supported hardware: iPhone 7 or later, running iOS 16 or later.\
Supported tags: ISO 14443 Type A chips formatted for NDEF.

The [Chip support matrix](reference/chip-support.md) lists every chip
the reader has been tested against and how much writable memory each
one has. An NTAG213 holds 132 bytes, which is a short URL and very
little else.

:::note[Background scanning]
iOS hands a tag to a background app only when the tag carries a URL
record matching the app's associated domain. Everything else needs the
Scan sheet open in the foreground.
:::

::include[safety-note]

---

## Where to go next

Start with [Scan your first tag](guide/first-tag.md), which covers one
read and one write on a blank NTAG215. If a tag will not read at all,
re-check [what you need](#what-you-need) first. Most failures are a
chip the reader cannot address rather than a fault in the tag.

Build numbers and release notes live on the
[Fixture App site](https://example.com/fixture-app). Send corrections
to this documentation to [docs@example.com](mailto:docs@example.com).
