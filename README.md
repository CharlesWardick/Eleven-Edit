# Eleven Edit

A free rig editor and librarian for the Avid Eleven Rack, controlled from your
computer over USB/MIDI. No iLok and no Avid Eleven Rack Editor required —
just the Avid USB driver and a connected Eleven Rack.

> **Status:** v1.0.0 — released to the Eleven Rack community, as-is. See the
> disclaimer below and **always back up your unit before loading banks.**
>
> **macOS build (2026-09-10):** a native Mac port now exists — same app, same
> renderer, with the Java bridge replaced by a small CoreMIDI bridge (no Java,
> no Avid driver needed). It passes its protocol tests against a virtual rack
> but has **not yet been tried against real Eleven Rack hardware**. See
> [macOS](#macos) below.

![Eleven Edit v1.0.0 — the main patch editor and audition screen, connected to an Eleven Rack](assets/screenshot.png)

## What it does

- Browse, edit, and organize the rigs on your Eleven Rack — live knob and
  effect-panel editing that mirrors the hardware, patch navigation with a
  jump-to-any-slot/by-name list, and inline renaming.
- Save edits to any rack slot or to disk as a `.tfx` file; load a `.tfx`
  back in for further editing.
- Back up all 104 user/factory slots to disk in one pass, and restore from
  a backup with a full preview of what will change before anything is
  written.
- A dedicated Rig Balancing screen for leveling output volume across every
  user rig, with buffered edits you can discard cleanly if you change your
  mind partway through.
- An Auto Advance mode for hands-free auditioning of a whole bank.

## Architecture

Eleven Edit is an Electron desktop app. A small Java WebSocket bridge
(`ElevenRackBridge.jar`) owns all MIDI hardware access via `javax.sound.midi`;
the Electron renderer talks to it over `ws://localhost:57121`. The app does
**not** run on the Eleven Rack — it remote-controls the hardware over MIDI.

On macOS the same renderer talks the same WebSocket protocol to a native
CoreMIDI bridge instead (`bridge-macos/ElevenRackBridge.swift`, a single
~450-line Swift program built as a universal binary and bundled inside the
app). Java is only needed on Windows, where it is the one MIDI layer that can
see the Avid driver's "Vendor Specific" port; macOS exposes the Eleven Rack's
USB-MIDI ports natively.

Built with [Claude Code](https://www.anthropic.com/claude-code), Anthropic's AI
coding assistant.

## Requirements

- An Avid Eleven Rack connected over USB.
- The Avid Eleven Rack USB driver installed — **v1.1.12 (recommended) or
  v1.0.11** both work. Eleven Edit talks through the operating system's MIDI
  layer, so it is driver-version-agnostic; any working Avid driver is fine, and
  the Avid Eleven Rack Editor itself is not needed, just its driver.
- A Java runtime for the bridge — **JRE 25 or newer required.** Older
  versions (including JRE 8 and JRE 21) have been directly tested and found to
  freeze or crash Windows when running Eleven Edit; the app checks this on
  startup and won't launch the bridge against a JRE below 25.
- **Windows 10 or Windows 11** — the platforms tested against real hardware.
  A macOS build exists (below); Linux is untested.

### macOS

- Any Mac running **macOS 12 Monterey or later**, Apple Silicon or Intel
  (the DMG ships one build per architecture).
- An Avid Eleven Rack connected over USB. **No Avid driver and no Java
  runtime are needed.** macOS's built-in class USB-MIDI driver exposes the
  rack's two MIDI ports on its own — they appear in Audio MIDI Setup as
  **Eleven Rack Rig** (the internal port the editor protocol lives on) and
  **Eleven Rack External** (the rear-panel DIN jacks). Eleven Edit picks
  Rig in / Rig out automatically; both pickers stay user-overridable.
- Audio over USB is a separate matter Eleven Edit doesn't touch: Avid never
  shipped an Apple Silicon audio driver, but Matt Housley's open-source
  [Eleven Rack Driver](https://github.com/Matt-Housley/eleven-rack-driver)
  covers it if you want the rack as a Core Audio device too.
- **Not yet verified on real hardware.** The bridge passes an end-to-end test
  against a virtual rack (see Build), and the Windows build's transport uses
  a differently-named port pair, so the first Mac session with a real rack may
  need a port choice: if the identity check gets no reply, Eleven Edit tries
  the other Rig/External combinations once each before showing the firmware
  gate, and remembers whichever pair answered. Please report what worked.
- The app is not code-signed with an Apple Developer ID (there is no paid
  certificate behind this project). On first launch macOS will say it can't
  verify the app: **right-click → Open → Open**, or allow it under System
  Settings → Privacy & Security. Once is enough.

### The real prerequisite (and a note on Windows 11)

Eleven Edit is a *passenger*: it runs in user space on top of Windows, the Avid
USB driver, and Java, and it cannot cause a Windows crash. So the only real
prerequisite is a machine that stays stable with the Avid driver installed:
install the Avid USB driver and JRE 25/26, connect the rack, and reboot a couple
of times with it plugged in. If Windows is stable that way, Eleven Edit runs on
top of it fine. If the PC is **not** stable with just the driver installed —
before Eleven Edit is even involved — that's an Avid-driver/Windows matter to
sort out first, not an Eleven Edit one.

Windows 10 has been rock-solid throughout. Windows 11 is more prone to Avid
driver trouble in general — Avid's own Eleven Rack Editor is known not to run
(and sometimes to crash the machine) on Windows 11. Eleven Edit itself is
unaffected by the Editor's problems, but it still rides on the same USB driver,
so if a Windows 11 machine is unstable with the driver installed: keep the Eleven
Rack off the Windows **default sound device** role, or use the lighter 1.0.11
driver. The User Manual's Troubleshooting section has the full rundown, including
a separate Windows 11 note about bank/patch **uploads**.

## Build

Build from source:

```
npm install
npm run build
```

This produces a Windows installer (`.exe`) in the `dist` folder via
electron-builder. Run it — it'll show a license/terms screen, check for
a working Java runtime, and install Eleven Edit like any other Windows
app.

### Building for macOS

Needs Node and the Xcode Command Line Tools (`xcode-select --install` gives
you `swiftc`, `lipo`, `codesign` and `iconutil`).

```
npm install
npm run build:mac          # arm64 + x64 DMGs and zips into dist/
```

`build:mac` first runs `bridge-macos/build.sh`, which compiles
`ElevenRackBridge.swift` into a universal, ad-hoc-signed binary
(`bridge-macos/ElevenRackBridge`, a gitignored build artifact like the jar),
then packages it inside `Eleven Edit.app/Contents/Resources`. If the npm
version in use refuses to run Electron's post-install script, run
`node node_modules/electron/install.js` once by hand. The `.icns` app icon is
generated from the same drawing code as the Windows icon with
`npm run icons:mac` (needs Pillow).

Tests, no hardware needed: `npm run test:bridge:mac` drives the bridge over
its WebSocket protocol against a virtual Eleven Rack (identity request, PC/CC,
a 1300-byte SysEx reassembled whole, error paths, graceful shutdown);
`bridge-macos/tests/app-smoke.sh` launches the whole app in dev mode
against that virtual rack and checks the startup handshake in the session log;
`bridge-macos/tests/packaged-smoke.sh` does the same with the BUILT app,
launched through Finder's `open` and quit with an Apple Event, which is the
path a user actually takes (a shell launch inherits the shell's file
permissions and can hide problems). Dev run: `./node_modules/.bin/electron . --logs`.

### Building the Java bridge

`npm run build` bundles a prebuilt `ElevenRackBridge.jar` but does **not**
compile it. The jar is a build artifact and is not committed to the repo
(only the source, `ElevenRackBridge.java`, is). Compile it once, from the
repo root, with **JDK 25 or newer**:

```
javac ElevenRackBridge.java
jar --create --file ElevenRackBridge.jar --main-class ElevenRackBridge ElevenRackBridge*.class
```

This writes `ElevenRackBridge.jar` in the repo root, where `npm run build`
picks it up. The intermediate `*.class` files can be deleted afterwards.

## Startup flags

- `/LOGS` — enable session logging.
- `/NOGPU` — force software rendering (for VMs that hit a splash-screen
  white-flash bug; not needed on real hardware).
- `/T<seconds>` — widen the startup timers (connect gate + firmware check)
  for a slow machine, e.g. `/T30`.

On macOS the same flags take the Unix form — `--logs`, `--nogpu`, `--t30` —
passed from Terminal as `open -a "Eleven Edit" --args --logs`. Session logs
land in `~/Library/Application Support/eleven-edit/logs/`.

## Safety / disclaimer

Free to use and share under the MIT License, with **no warranty, express or
implied — use at your own risk.** Always back up your unit before loading new
banks. The author is not responsible for lost patches, corrupted banks, or gear
that mysteriously starts playing better than you can.

## Acknowledgments

Eleven Edit was written independently, from scratch — no third-party source code
is included or reused. The Eleven Rack USB/MIDI (SysEx) protocol was re-derived
here through direct packet analysis; no Avid software, firmware, or source code
was used.

The SysEx protocol map builds on, and gratefully acknowledges, the earlier
reverse-engineering work of **Guillaume Schmid — [ElevenHack](https://sites.google.com/site/elevenhack/)
(released 2013; open-sourced 2020 under the Apache License 2.0)**. ElevenHack
was consulted as conceptual reference only — it was the clue that Java's
`javax.sound.midi` exposes the Eleven Rack's Vendor-Specific transport that
Windows otherwise hides. None of its code was copied or ported.

If you build on Eleven Edit, please keep **Charles Wardick** and **Guillaume
Schmid** named in your credits, passing the courtesy forward. (A request, not a
license condition.)

See [`NOTICE`](NOTICE) for the full acknowledgment.

## License

[MIT](LICENSE) © 2026 Charles Wardick

---

*Eleven Rack is a trademark of its respective owner. Eleven Edit is an
independent, unofficial project and is not affiliated with or endorsed by Avid.*
