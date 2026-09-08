---
title: Guide
description: How to scan, write and organise NFC tags with Fixture App, from the first scan to a tag that survives a wash cycle.
navTitle: Guide
tags:
  - scanning
---

The guide covers the parts of Fixture App you touch every day: reading a
tag, writing a payload to it, and working out what went wrong when the
phone stays silent. It assumes an iPhone that supports background tag
reading, which is every model from the iPhone XS onward.

Two pages sit under this one. Read them in order the first time.

## Where to start

1. [Scan your first tag](first-tag.md) walks through the Scan sheet, the
   haptic that fires on a successful read, and the record list that
   appears once the tag is decoded. It uses an NTAG213 sticker, which is
   the chip in most cheap tag packs.

2. [When a scan does not work](troubleshooting.md) lists the errors the
   NFC radio can return and what each one means in practice. Session
   timeouts, tags that read once and never again, and the antenna
   position problem that accounts for most reports are all covered
   there.

Both pages assume you have granted the app the NFC entitlement prompt on
first launch. If you declined it, the Scan button is disabled and a
banner reading "NFC is unavailable" sits at the top of the Tags screen.
Deleting and reinstalling the app is the only way to see that prompt
again.

## What the guide does not cover

Chip capacities, memory layouts and the exact record types each chip
accepts live in the reference section rather than here. If you are
choosing tags to buy, start with the chip support matrix instead of
this guide.

The Fixture App URL scheme, the shortcuts actions and the tag session
callbacks are developer material. They are not repeated in the guide,
because the guide is written for someone holding a phone and a sticker.

> A tag that fails to write is usually not faulty. Write operations need
> the tag to stay in the field for the whole operation, and a hand that
> moves away after the read tone will abort the write with the tag left
> readable but unchanged. Hold still until the second tone.

## Reading order for a new deployment

If you are setting up more than a handful of tags, do a full pass on one
tag before you touch the rest. Write it, read it back on a second phone,
then lock it. A locked NTAG213 cannot be rewritten, so a mistake caught
on tag one costs a sticker and a mistake caught on tag two hundred costs
an afternoon.

The [documentation home](../index.md) links to the reference and
developer sections when you need them.
