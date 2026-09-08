---
title: When a scan does not work
description: Common reasons a scan fails, and what to do about each one.
audience: user
pageKind: faq
navTitle: Troubleshooting
tags:
  - troubleshooting
  - scanning
---

Most failed scans come down to where the tag sits against the phone, or
to the chip inside the tag. Find the question that matches what you saw
on screen and work from there.

## Why does nothing happen when I hold a tag to my phone?

The NFC antenna sits at the top of the back panel, beside the camera
bar. Resting the centre of the phone on a tag leaves roughly 40 mm
between the antenna and the chip, which is enough for the tag to stay
asleep. Slide the top edge of the phone over the tag instead.

The Scan sheet shows a ![contactless](../../../assets/nfc-glyph.svg)
badge in its top right corner for as long as the radio is listening. If
that badge never appears, the session did not start. Close the sheet,
wait a moment, then open it again.

### Check the tag before you blame the phone

A tag can be readable by one app and invisible to another. iOS filters
tag families before an app ever sees them, so a chip Fixture App has no
decoder for never reaches the Scan sheet.

Three situations account for most silent tags.

- The tag is stuck to metal. A sticker on a laptop lid or a biscuit tin
  detunes the antenna far enough that nothing answers.
  - A ferrite layer between the tag and the metal restores the range.
  - Tags sold as on-metal have that layer built in already.
- The tag uses a chip iOS does not expose to other developers. MIFARE
  Classic 1K is the one people run into.
- The tag has worn out. An NTAG213 sticker usually survives being
  peeled off once, and rarely twice.

#### Tags that read once and then go quiet

A few chips answer the first poll after power-up and then ignore every
poll until they lose the field for about half a second. If a tag reads
on the first attempt and fails several times running after that, pull
the phone well away from it, count to two, and scan again.

## Why does the scan stop halfway through?

"Tag connection lost" means the radio link broke while a read or a
write was still in progress. Usually the phone moved. Fixture App holds
the session open for 20 seconds, so there is no need to rush, but the
tag does have to stay put for the two or three seconds a write takes.

> [!IMPORTANT]
> A write is not atomic. If the link drops partway through, the tag is
> left holding half a message and the next scan reports "Damaged
> message". Nothing is lost for good: write the tag again from the
> Write sheet and the old content is replaced.

## Why can I read a tag but not write to it?

Two different locks produce the same result. The first is the one you
chose, because the Write sheet has a Lock after writing switch, and a
tag locked that way reports itself as read only from then on. The
second belongs to the manufacturer. Tags sold pre-programmed for a
product launch normally arrive locked.

The Tag detail screen used to label both cases ~~read only~~, which
people took to be a setting they could turn off. Since 1.4 it
distinguishes Locked by you from Locked at the factory.

> [!CAUTION]
> Locking cannot be undone. The lock bits on an NTAG21x chip are
> one-way, and once they are set no reader on any platform can clear
> them. Check the message on the Preview screen before you turn the
> switch on.

## Why does the app say "Unsupported tag type"?

That message means iOS handed the app a tag whose chip Fixture App does
not recognise. Reading falls back to plain NDEF where the tag allows
it, and writing is refused rather than risking a half-configured chip.
The [chip support matrix](../reference/chip-support.md) lists every
chip the app has been tested against and what works on each one.

## What should I send in when I report a scan problem?

Open Settings, then Diagnostics, and tap Copy scan log. The log covers
the last twenty sessions: chip type, byte counts, and the error each
session ended with. It records no tag content and no location.

Paste it into a message to
[support@example.com](mailto:support@example.com), with the make of the
tag if you know it. A photo of the tag helps more than a description of
it does.

> A walkthrough of a scan that works, for comparison against your own
> log, is in [Scan your first tag](first-tag.md).
