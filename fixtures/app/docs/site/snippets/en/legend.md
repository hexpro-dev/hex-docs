---
title: Reading the matrix
---

| Status | Meaning |
| --- | --- |
| ✅ | Verified on hardware. Fixture App reads and writes every record type the chip supports, including locked NDEF pages. |
| ⚠️ | Partial. Reading works, writing does not, usually because the chip ships with a vendor password Fixture App cannot set. |
| ❌ | Not supported. The chip is recognised during discovery, and the session ends before any write, so the tag is left untouched. |
| — | Not applicable. This chip has no NDEF surface for Fixture App to use. |

Status is recorded per chip revision, so check the revision printed in
the row rather than the family name on the packaging.
