---
title: Release note scratchpad
description: Working notes for the 1.4 release, kept out of the published bundle.
draft: true
tags:
  - architecture
---

## Still to confirm

Aiden is checking whether the NTAG 216 write path still needs the extra
capability container read on iOS 18.2. If it does not, the retry loop in
`TagSession.write(_:)` loses a full second of tag contact time.

- Confirm the "Tag moved away" copy matches the string table in Scan.
- Decide whether the chip matrix lists the 213 variants separately.
- Ask design whether the Write sheet keeps the amber lock badge.

## Parked

Nobody has measured how long the session stays alive after the sheet is
dismissed — the number in the old notes came from a simulator run and the
simulator does not run the radio at all. Measure on a device before quoting
anything.

Move the confirmed items into the guide and delete this page when 1.4 ships.
