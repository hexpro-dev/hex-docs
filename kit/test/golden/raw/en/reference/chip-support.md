# Chip support matrix

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

| Status | Meaning |
| --- | --- |
| \u2705 | Verified on hardware. Fixture App reads and writes every record type the chip supports, including locked NDEF pages. |
| \u26a0\ufe0f | Partial. Reading works, writing does not, usually because the chip ships with a vendor password Fixture App cannot set. |
| \u274c | Not supported. The chip is recognised during discovery, and the session ends before any write, so the tag is left untouched. |
| \u2014 | Not applicable. This chip has no NDEF surface for Fixture App to use. |

Status is recorded per chip revision, so check the revision printed in
the row rather than the family name on the packaging.

:::table[Core NFC support by chip, measured on iOS 18.2]
| Chip | Part number | Read | Write | User memory (bytes) |
| :--- | --- | :---: | --- | ---: |
| NTAG213 | `NT2H1311` | \u2705 | \u2705 | 144 |
| NTAG215 | `NT2H1511` | \u2705 | \u2705 | 504 |
| NTAG216 | `NT2H1611` | \u2705 | \u2705 | 888 |
| [NTAG424 DNA](https://example.com/chips/nt4h2421gx) | `NT4H2421Gx` | \u2705 | \u26a0\ufe0f | 416 |
| MIFARE Ultralight EV1 | `MF0UL1101` | \u2705 | \u2705 | 48 |
| MIFARE Ultralight C | `MF0ICU2` | \u2705 | \u26a0\ufe0f | 144 |
| ICODE SLIX2 | `SL2S2602` | \u2705 | \u26a0\ufe0f | 316 |
| [MIFARE DESFire EV3](https://example.com/chips/mf3d8x3) | `MF3D8X3` | \u26a0\ufe0f | \u274c | \u2014 |
| MIFARE Classic 1K | `MF1S503x` | \u274c | \u2014 | \u2014 |
:::

## What the caveats mean

A \u26a0\ufe0f in the Write column means the chip accepts a write only after
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
