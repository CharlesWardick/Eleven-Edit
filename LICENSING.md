# Eleven Edit — Licensing

Eleven Edit uses a **two-tier license split**. Most of the app is MIT; the one
small component that touches ASIO is GPL-3.0-or-later, isolated in its own
process. This keeps the editor permissively licensed while cleanly meeting the
terms of Steinberg's ASIO SDK.

## The split

| Part | License | Files |
| --- | --- | --- |
| **Main application** (editor, MIDI bridge integration, UI, everything else) | **MIT** | `LICENSE` — all source except the audio helper |
| **Audio helper** (built-in audio passthrough process) | **GPL-3.0-or-later** | `LICENSE-GPL-3.0.txt` — `audio-helper.js` |

- `audio-helper.js` carries `SPDX-License-Identifier: GPL-3.0-or-later`.
- Every other source file remains under the MIT `LICENSE`.

## Why

The built-in audio engine uses [`audify`](https://www.npmjs.com/package/audify)
(an MIT-licensed Node wrapper around [RtAudio](https://github.com/thestk/rtaudio)).
On Windows, audify's prebuilt binary contains code compiled against **Steinberg's
ASIO SDK**, which since **2025-10-15** is licensed **GPL-3.0-or-proprietary**.
The MIT license on audify's wrapper does not erase the ASIO SDK's terms on the
shipped binary, so by redistributing that binary Eleven Edit must honor them.

Eleven Edit takes the **free GPLv3 path** for the component that touches ASIO —
the audio helper — rather than purchasing a proprietary ASIO license. To keep
the rest of the app MIT, the helper is a **truly separate process**: it is
spawned on engine-ON and killed on engine-OFF, and it communicates with the main
app only over **arms-length IPC** (newline-delimited JSON on stdin/stdout). No
GPL code is linked into the MIT application, and the editor runs fine without the
helper (the audio feature simply greys out).

## GPLv3 corresponding source

The audio helper's own source (`audio-helper.js`) ships in readable form inside
the application. The corresponding source for the GPLv3 native components it
loads is available here:

- **audify** (MIT wrapper): <https://github.com/almogh52/audify> · npm: `audify`
- **RtAudio** (audio backend): <https://github.com/thestk/rtaudio>
- **Steinberg ASIO SDK**: <https://github.com/audiosdk/asio>

## Third-party credits

- **audify** by Almog Hamdani and contributors (MIT) — the RtAudio-based audio
  engine that makes the built-in passthrough possible.
- **RtAudio** by Gary P. Scavone and contributors.
- **ASIO** is a trademark of Steinberg Media Technologies GmbH. Eleven Edit uses
  the name only to identify the driver type; no ASIO logo or branding is used.

## Notes

- **Eleven Edit v1.0.0 remains MIT** in its entirety; the GPLv3 helper arrives
  with the v1.1.0 audio engine.
- **Forker's escape hatch:** if you want an entirely MIT codebase, remove or
  replace the audio helper — the rest of Eleven Edit is still a full MIT editor.
