---
title: Tag session API
description: The TagSession type, its delegate callbacks, error cases and the JSON payload Fixture App writes to a tag.
audience: developer
pageKind: article
navTitle: Tag session API
tags:
  - architecture
---

`TagSession` wraps Core NFC and is the only type in Fixture App that
holds an `NFCTagReaderSession`. The Scan sheet, the home screen widget
and the share extension all go through it. Reading this page is enough
to add a new tag operation without touching Core NFC directly.

If you have not run a scan on a device yet, start with
[Scan your first tag](../guide/first-tag.md). The API below assumes you
know what the system sheet looks like.

## Starting a session

`begin(_:)` takes an `Intent`, which names the operation and carries the
prompt string iOS shows in the sheet. It throws before any hardware is
touched when the device cannot read tags, so a simulator build fails at
the call site instead of waiting on a sheet that never appears.

```swift title="TagSession.swift" lineNumbers start=12 highlight="2,5-7"
public func begin(_ intent: Intent) throws {
    guard NFCTagReaderSession.readingAvailable else {
        throw TagSessionError.readerUnavailable
    }
    let session = NFCTagReaderSession(pollingOption: [.iso14443, .iso15693],
                                      delegate: self,
                                      queue: queue)
    session.alertMessage = intent.promptText
    session.begin()
}
```

The polling option set is fixed. Fixture App polls ISO 14443 and ISO
15693 together because the chip families it recognises are split across
the two, and picking one at call time would make a mistyped intent look
like a dead tag. The [chip support matrix](chip-support.md) lists which
part number answers on which protocol, and the
[module graph](../developer/architecture.md#module-graph) shows where
`TagSession` sits.

`alertMessage` can be rewritten while the session is live. The sheet
re-renders in place and the radio link survives, which is how the write
path swaps "Hold your iPhone near the tag" for "Writing, keep holding".

<!-- hexdocs-disable-next-line no-banned-phrase: quoting the marketing copy verbatim is the point of this line -->
The store listing calls this "tap and go", and the phrase sets a budget
the API has to meet: 700 ms from `begin(_:)` to a written tag on a
NTAG215 at 137 bytes. Anything slower and a user lifts the phone early.

## The state machine

There are four states: `.idle`, `.polling`, `.connected` and
`.finished`. On a successful connect the state is `.polling` →
`.connected`, and every callback from that point runs on the session
queue rather than on the main queue. Publishing to SwiftUI therefore
needs an explicit hop; `TagSessionStore` does that hop once so view code
never has to.

A session that ends for any reason, including the user cancelling the
sheet, lands in `.finished` and cannot be restarted. Create a new
`TagSession` per operation. Holding one and calling `begin(_:)` twice
throws `TagSessionError.sessionSpent`.

## Delegate callbacks

`TagSessionDelegate` has three methods and none of them is optional.

- `session(_:didConnect:)` gives you the detected tag and the chip
  identity the app resolved from its UID and capability container.
- `session(_:didFinish:)` reports a completed read or write, with the
  byte count and the elapsed time.
- `session(_:didFail:)` reports a `TagSessionError`. It is the only
  place the app surfaces error copy, so the strings live beside the
  cases rather than in the view layer.

Do not call UIKit or SwiftUI from any of the three without dispatching
to the main queue first.

## Errors

| Case | Thrown when | Message shown |
| --- | --- | --- |
| `readerUnavailable` | The device has no NFC reader, or the entitlement is missing | "This iPhone cannot read NFC tags." |
| `sessionSpent` | `begin(_:)` called on a finished session | (internal, never shown) |
| `tagUnsupported` | The chip answered but is not in the support matrix | "Fixture App does not recognise this tag yet." |
| `payloadTooLarge` | The record exceeds the tag's user memory | "This tag holds 137 bytes and the record needs 208." |
| `writeRejected` | The tag is locked or password protected | "This tag is locked and cannot be changed." |
| `lostConnection` | The tag moved out of range mid-operation | "Hold the tag still and try again." |

`lostConnection` is the only case the app retries on its own, once, and
only for reads. A half-finished write is left alone so that the tag is
never rewritten without the user asking.

## The payload

Fixture App writes a single NDEF record with a MIME type of
`application/vnd.hexpro.fixture+json`. The object is small on purpose,
because user memory on a NTAG213 is 137 bytes.

```json
{
  "v": 2,
  "kind": "route",
  "target": "fixture://scan/history",
  "written": "2026-03-14T09:21:07Z"
}
```

`v` is the payload version, not the app version. A reader that meets a
higher `v` than it knows reports `tagUnsupported` instead of guessing at
the fields it recognises.

## Debug output

Build with the `FIXTURE_TAG_LOG` environment variable set to `1` and the
session prints one line per transition to the Xcode console. The format
is stable enough to grep and is not localised.

```
TagSession begin intent=writeRoute polling=iso14443,iso15693
TagSession connect uid=04A23B9C5D6E80 chip=NTAG215 memory=504
TagSession finish bytes=137 duration=0.68s
```

## Driving the scan ring

The session publishes a `phase` value between 0 and 1 while it polls.
The Scan sheet feeds that straight into a fragment shader, so the ring
on screen is driven by the radio state rather than by a timer that
happens to look right.

```metal wrap
fragment half4 scanPulse(RingVertex in [[stage_in]],
                         constant float &phase [[buffer(0)]]) {
    float edge = smoothstep(0.46, 0.50, length(in.uv - 0.5));
    half3 colour = half3(0.043, 0.463, 0.851);
    return half4(colour, half(edge * phase));
}
```

Keep the shader free of branches on `phase`. The ring is redrawn at
120 Hz on ProMotion devices while the radio is active, and the frame
budget is the reason the animation is not a SwiftUI keyframe.
