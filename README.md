# Eleven Edit

A free rig editor and librarian for the Avid Eleven Rack, controlled from your
computer over USB/MIDI. No iLok and no Avid software required.

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

<!-- TODO: confirm/complete exact versions and OS support. -->
- An Avid Eleven Rack connected over USB.
- A Java runtime (for the bridge).
- Windows / macOS / Linux <!-- TODO: state which are actually tested. -->

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
