# Eleven Edit

A free rig editor and librarian for the Avid Eleven Rack, controlled from your
computer over USB/MIDI. No iLok and no Avid Eleven Rack Editor required —
just the Avid USB driver and a connected Eleven Rack.

> **Status:** Feature-complete and in community testing. Released to the Eleven
> Rack community as-is. See the disclaimer below and **always back up your unit
> before loading banks.**

<!-- TODO: add a screenshot or two of the app here once you have them. -->

## What it does

<!-- TODO: fill this in from the user guide once it's written. Suggested bullets: -->
- Browse, edit, and organize the rigs on your Eleven Rack.
- Save rigs to any slot, and back up / restore whole banks to disk.
- Live knob and effect-panel editing that mirrors the hardware.

## Architecture

Eleven Edit is an Electron desktop app. A small Java WebSocket bridge
(`ElevenRackBridge.jar`) owns all MIDI hardware access via `javax.sound.midi`;
the Electron renderer talks to it over `ws://localhost:57121`. The app does
**not** run on the Eleven Rack — it remote-controls the hardware over MIDI.

Built with [Claude Code](https://www.anthropic.com/claude-code), Anthropic's AI
coding assistant.

## Requirements

- An Avid Eleven Rack connected over USB.
- The Avid Eleven Rack USB driver (v1.1.12 confirmed working) installed —
  the Avid Eleven Rack Editor itself is not needed, just its driver.
- A Java runtime for the bridge (JRE 21 or newer confirmed working).
- **Windows 10 or Windows 11** — the only platforms tested and supported
  today. macOS and Linux are untested; the Avid driver and this app's MIDI
  access are both Windows-only as it stands. Porting to other platforms is
  a hoped-for community contribution after open-source release, not
  something the current codebase has been adapted for yet.

## Install / Build

<!-- TODO: fill in from your actual build/release process. Placeholders: -->
- **Prebuilt release:** download the latest installer from the Releases page.
  <!-- TODO: link once published. -->
- **From source:**
  ```
  npm install
  npm run build
  ```

## Startup flags

- `/LOGS` — enable session logging.
- `/NOGPU` — force software rendering (for VMs that hit a splash-screen
  white-flash bug; not needed on real hardware).

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
(2013)**, which is licensed under the Apache License 2.0. ElevenHack was
consulted as conceptual reference only; none of its code was copied or ported.

If you build on Eleven Edit, please keep **Charles Wardick** and **Guillaume
Schmid** named in your credits, passing the courtesy forward. (A request, not a
license condition.)

See [`NOTICE`](NOTICE) for the full acknowledgment.

## License

[MIT](LICENSE) © 2026 Charles Wardick

---

*Eleven Rack is a trademark of its respective owner. Eleven Edit is an
independent, unofficial project and is not affiliated with or endorsed by Avid.*
