---
title: How the app is put together
description: The package layout, and which module talks to CoreNFC.
audience: developer
navTitle: Architecture
tags:
  - architecture
since: "1.1.0"
---

Fixture App is one Xcode project plus five local Swift packages under
`Packages/`. The app target, `AppShell`, is thin. It owns the window
and the deep link handler, and every screen it presents comes out of a
package.

Dependencies point one way. No package imports the app target, and
nothing below `Design` knows that a view exists.

## Module graph {#module-graph}

Read the tree as "depends on". AppShell -> Design -> Shaders means the
app links `Design`, and `Design` links `Shaders`.

```text
AppShell
├─ TagSession ─┬─ ChipProfiles
│              └─ TagCodec
├─ Design ─────── Shaders
└─ Storage ────┬─ KeychainVault
               └─ ScanLog
```

- `TagSession` is the only package that imports CoreNFC. It opens the
  reader session, hands raw NDEF payloads to `TagCodec`, and publishes
  the state machine the Scan sheet observes.
- `TagCodec` turns NDEF records into `TagRecord` values and back. It
  needs nothing from Apple beyond Foundation, so the `fixturectl`
  command line tool links it directly.
- `ChipProfiles` holds the per-chip capability table: memory size,
  password support, lock byte layout and default capacity container.
  The published version of that table is the
  [chip support matrix](../reference/chip-support.md).
- `Design` holds the colour tokens and the two custom views the Scan
  sheet uses.
- `Shaders` is a Metal package with one fragment shader in it, the
  halo that pulses while a session is open.
- `Storage` appends scan history to a SQLite file and keeps tag
  passwords in the keychain behind `KeychainVault`.

## Where a scan happens

Tapping Scan on the home screen calls `begin(_:)` with a `ScanIntent`.
That call is the boundary. Above it there are views. Below it there is
CoreNFC and nothing else.

```swift title="TagSession.swift" lineNumbers start=48 highlight="3,9"
func begin(_ intent: ScanIntent) throws {
    guard NFCNDEFReaderSession.readingAvailable else {
        throw TagError.radioUnavailable
    }
    let session = NFCNDEFReaderSession(
        delegate: self,
        queue: .main,
        invalidateAfterFirstRead: intent == .readOnce
    )
    session.alertMessage = strings.holdTagPrompt
    session.begin()
}
```

`TagSession` owns the radio – `TagCodec` owns the bytes, and neither
reaches across. Passing a payload between them is seamless because
both sides already speak `TagRecord`, so the codec can be tested with
no device attached.

If the tag leaves the field before the read finishes, CoreNFC calls
back with a user-cancelled invalidation or, more often, a timeout.
Both map to one message on screen: "Tag was moved away too quickly.
Hold it against the top of the phone until the tick appears." The
mapping table lives in `TagError+Message.swift`, and the
[Tag session API](../reference/api.md#errors) lists every case.

`ChipProfiles` ships the public capability table in the App Store
build. Our internal builds add station-pack-alpha, the profile set for
the reader hardware on the test bench, through a separate package
target that the release scheme excludes.

Contoso Tap keeps its codec inside the app target, which is a
reasonable choice if there is never going to be a command line tool.
We split ours out in 1.1.0 and got the fuzz tests for free.

## What was removed

~~SyncEngine~~ came out in 1.1.0. It mirrored scan history to a server
account, and it was the only package that opened a network connection.
Removing it dropped the network entitlement and about four hundred
lines of migration code. Scan history is local now, and the export
button in Settings writes a JSON file.

The name still appears in the 1.0 tag. Do not revive it for something
smaller, because the entitlement comes back with it.

## Adding a package

New code goes in an existing package unless it needs a dependency that
package cannot take. When it does need one, place the package in the
[module graph](#module-graph) before writing any code, because its
position decides what it is allowed to import.

1. Create it with `swift package init --type library`.
2. Add it to `Fixture.xcworkspace` and to the app target.
3. Add a row to `Docs/module-graph.txt`, the source of the tree above.
4. Run `make graph-check` and fix whatever it names.

:::note[Import direction is checked]
`make graph-check` reads every `import` statement under
`Packages/*/Sources` and fails on an upward edge. A package that
imports `AppShell` will not reach review.
:::

When a scan misbehaves on device, the state machine in `TagSession` is
the first place to look. The symptoms users report are listed in
[When a scan does not work](../guide/troubleshooting.md).
