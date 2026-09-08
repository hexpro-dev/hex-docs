---
title: Reference
description: Lookup pages for tag hardware support and the Tag session API in Fixture App.
navTitle: Reference
tags:
  - chips
---

Reference pages answer a narrow question quickly. They do not walk you
through a task, which is what [the guide](../guide/index.md) is for.

## What is here

[Chip support matrix](chip-support.md) lists every tag family Fixture App
recognises, with usable memory, the write modes each one accepts and
whether its lock bits are one way. Check it before you buy a batch of
tags.

[Tag session API](api.md) documents the `TagSession` type, the records it
returns and every error it can throw. It is written for developers
embedding the Fixture App reader in another app.

## Conventions

Both pages use the same notation. Sizes are the bytes available to you
after the tag's own header, not the figure printed on the packaging.

| Notation | Meaning |
| -------- | ------- |
| `0x04` | A single byte in hexadecimal, as the app prints it |
| `216 B` | Usable user memory, header excluded |
| `n/a` | The field does not apply to that tag family |
| `RO` | Read only, because the lock bits have been set |

A field marked `n/a` is absent rather than zero. A tag that reports `0 B`
has been locked with an empty payload, which is a different problem.
