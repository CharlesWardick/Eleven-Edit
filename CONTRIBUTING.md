# Developing Eleven Edit

Short orientation for anyone working on this repo (including a future you). For
end-user instructions, see the [User Manual](UserManual.txt); for the SysEx
protocol, see the Technical Reference in [`docs/`](docs/).

## Where the truth lives

- **Protocol / hardware behaviour:** `docs/ElevenEdit_Technical_Reference.txt` is
  the authoritative, re-derived map of the Eleven Rack's USB/MIDI (SysEx)
  interface — commands, encodings, TFX format, save/load/export mechanics. Treat
  it as the source of truth; if code and Tech Ref disagree, one of them is a bug.
- **Fuller development notes and history** are kept privately by the author and
  are not part of this public repo. This file plus the Technical Reference are
  the public orientation.

## Architecture at a glance

Eleven Edit is an Electron desktop app. A small Java WebSocket bridge
(`ElevenRackBridge.jar`) owns all MIDI hardware access via `javax.sound.midi`;
the Electron renderer talks to it over `ws://localhost:57121`. The app does
**not** run on the Eleven Rack — it remote-controls the hardware over MIDI.

The pivotal insight the whole project rests on: Java's `javax.sound.midi`
exposes the Eleven Rack's Vendor-Specific transport that Windows (and therefore
Electron/Web MIDI) otherwise hides. That is why the bridge exists.

## The passenger principle (read before chasing any platform/crash issue)

Eleven Edit runs entirely in user space and **cannot** cause a Windows kernel
crash. Every BSOD or boot instability ever seen in this project's testing was
the Avid USB **kernel driver** reacting to its environment (or Avid's own
Eleven Rack Editor), never Eleven Edit. The real prerequisite for running the
app is a machine that stays stable with the Avid driver installed:

> Install the Avid USB driver + JRE 25/26, connect the rack, reboot a couple of
> times with it plugged in. If Windows is stable that way, Eleven Edit runs on
> top of it. If the PC is unstable with just the driver installed — before
> Eleven Edit is involved — that is an Avid-driver/Windows matter to resolve
> first.

Windows 10 is solid; Windows 11 is more prone to Avid driver/Editor trouble.
Fallbacks if a Win11 machine is unstable: keep the rack off the Windows *default
sound device* role, or use the lighter Avid `1.0.11` driver. (A separate Win11
issue — the new in-box MIDI stack corrupting large SysEx uploads — is documented
in the User Manual and handled in-app; it is not a stability/crash matter.)

## Building

```
npm install
npm run build
```

Produces a Windows installer (`.exe`) in `dist/` via electron-builder.

### The Java bridge

`npm run build` bundles a prebuilt `ElevenRackBridge.jar` but does **not**
compile it. The jar is a build artifact and is **not** committed (only the
source, `ElevenRackBridge.java`, is). Compile it once from the repo root with
**JDK 25 or newer**:

```
javac ElevenRackBridge.java
jar --create --file ElevenRackBridge.jar --main-class ElevenRackBridge ElevenRackBridge*.class
```

This writes the jar where `npm run build` picks it up. The intermediate
`*.class` files can be deleted afterwards.

## Validating a build (smoke test)

Most changes here (docs, comments, license headers) don't alter behaviour — so
the bar is simply that the app still behaves like the released v1.0.0. After a
build, with a rack connected, confirm:

1. It launches and the startup Java-version gate passes (JRE 25+).
2. It finds and connects to the rack.
3. You can navigate patches, edit a knob, and Save to Rack.
4. Export All Rigs and Import Rigs work (a full 104-slot round-trip re-imports
   clean).

If those hold, the binary is good.

## Versioning

The version stays **1.0.0** until a real functional fix ships. Do **not** bump
it for comment-only, documentation, or license-header changes — the released
binary and a fresh public build should report the same version. Bump only for
actual mechanics/behaviour changes, post-release.

## Code conventions

- Every source file I authored carries the MIT header (see `LICENSE`). Keep it
  when adding new files.
- Runtime requirement: **JRE 25 or newer.** JRE 8 and 21 were tested and
  found to hard-lock Windows; the app enforces a JRE-25 floor at startup and
  the bridge is compiled `--release 25`.

## Intermittent timing behaviour

If you ever chase an intermittent, timing-flavoured glitch (a panel that
occasionally shows stale/blank values, a nav that sometimes lands wrong, a scan
slot that comes up empty), start at **Appendix A of the Technical Reference —
the fixed-delay timer map**. It classifies every fixed timer in the app (which
have a real ack to wait on, which are backstops, which are rate-limiters) and is
the intended first place to look before shortening any timer.

## Scope and support

Eleven Edit is a one-person, open-source project shared as-is, with no support
obligation. Windows 10/11 only; macOS and Linux are unported (the Avid driver
and this app's MIDI access are both Windows-only as it stands). Issues and pull
requests are welcome on GitHub, time permitting.

---

*Eleven Rack is a trademark of its respective owner. Eleven Edit is an
independent, unofficial project and is not affiliated with or endorsed by Avid.*
