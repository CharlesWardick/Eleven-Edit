# Eleven Edit — Release Notes

## v1.1.0

**Built-in audio engine.** One-button ASIO/WASAPI passthrough from your rig to
your speakers — monitor your tone with no DAW or third-party app. Pick your
device, input/output channels, sample rate and buffer in Settings → Audio Setup;
an audio bar gives you a level meter, monitor volume, and mute. Turning the
engine off fully releases the audio device so a DAW can grab it.

**Quick Mix.** A slim wet-amount slider now sits under each active effect block
in the chain row (Reverb, Delay, FX Loop, and the Mod/FX1/FX2 slots when the
loaded model has a wet control). Trim a block's wetness in place without opening
its panel — drag, mouse-wheel, or double-click to return to the patch-saved
value. Toggle it in Settings → Chain Row.

**Chain row rework.** AMP and CAB are now a single split pill (left = AMP,
right = CAB), with general layout and alignment clean-up.

**Logging off by default.** Session logging is now opt-in — add the `/LOGS`
launch flag only when you need to capture a session for troubleshooting.

**Installer.** The installer now sets up the Microsoft Visual C++ runtime that
the audio engine needs, automatically (and skips it if you already have it).

**Startup flags.** `/AUDIOON` (start with the engine running), `/LOGS` (capture
a session log), `/T<sec>` e.g. `/T60` (widen the startup wait on a slow PC), and
`/NOGPU` (software rendering for some VMs). See the user manual for details.

**Licensing.** The audio helper is licensed GPL-3.0-or-later (it loads an
ASIO-touching component); the rest of Eleven Edit stays MIT. See `LICENSING.md`.

---

## v1.0.0

Initial public release — patch navigation, TFX capture, and full editor controls
for the Avid Eleven Rack over the Java MIDI bridge.
