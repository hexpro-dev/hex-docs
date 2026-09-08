---
title: Chip support matrix
description: Which NFC chips Fixture App can read and write on iOS, and the caveats that apply to each one.
navTitle: Chip support
tags:
  - chips
---

Fixture App talks to tags through Core NFC, so a chip only works if it
answers as one of the tag types iOS exposes: Type 2 over ISO 14443A,
Type 4 over ISO 7816, or Type 5 over ISO 15693. A chip that answers
only on a proprietary protocol shows up as an identifier and nothing
more.

Every result below came from an iPhone 13 and an iPhone 15 Pro running
iOS 18.2, against blank tags from three suppliers. Read means the Scan
sheet pulls the NDEF message off the tag with no extra setup. Write
means the Write sheet puts a new message back and reports the free
bytes left afterwards. User memory is the space an NDEF message can
occupy, which is always less than the total memory on the die.

::include[legend]

:::table[Core NFC support by chip, measured on iOS 18.2]
| Chip | Part number | Read | Write | User memory (bytes) |
| :--- | --- | :---: | --- | ---: |
| NTAG213 | `NT2H1311` | ✅ | ✅ | 144 |
| NTAG215 | `NT2H1511` | ✅ | ✅ | 504 |
| NTAG216 | `NT2H1611` | ✅ | ✅ | 888 |
| [NTAG424 DNA](https://example.com/chips/nt4h2421gx) | `NT4H2421Gx` | ✅ | ⚠️ | 416 |
| MIFARE Ultralight EV1 | `MF0UL1101` | ✅ | ✅ | 48 |
| MIFARE Ultralight C | `MF0ICU2` | ✅ | ⚠️ | 144 |
| ICODE SLIX2 | `SL2S2602` | ✅ | ⚠️ | 316 |
| [MIFARE DESFire EV3](https://example.com/chips/mf3d8x3) | `MF3D8X3` | ⚠️ | ❌ | — |
| MIFARE Classic 1K | `MF1S503x` | ❌ | — | — |
:::

## What the caveats mean

A ⚠️ in the Write column means the chip accepts a write only after
an extra step, never that the write is unreliable once it starts.

NTAG424 DNA ships with its NDEF file locked behind AES authentication,
so the Write sheet asks for the application key before it will change
anything. Ultralight C uses 3DES on the pages above the counter, and
Fixture App writes below the lock byte unless you paste the key into
Settings, Advanced, Tag keys. ICODE SLIX2 answers on ISO 15693 and
stores its message in blocks of four bytes, so the free-byte figure
drops in steps of four.

DESFire EV3 is readable and no more. The phone can select the NDEF
application and read what is in it, but creating or resizing the file
needs a key we will not ask you to carry, so the write button stays
dim and shows "This tag is read only on iPhone". MIFARE Classic 1K is
not readable at all. iOS hands back the identifier and stops there,
and the Scan sheet reports error 2001, "Tag is not NDEF compliant".
Neither chip has a figure in the memory column: on DESFire the size is
fixed when the file is created, and on Classic there is no NDEF file
to measure.

## If a chip is not listed

Send the tag identifier from the Scan sheet and the marking printed on
the packaging to [docs@example.com](mailto:docs@example.com) and we
will test it. A chip on this list can still fail behind a case with a
metal plate or a payment card, which is covered in
[When a scan does not work](../guide/troubleshooting.md).
