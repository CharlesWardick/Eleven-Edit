# Eleven Edit — Release Notes

## v1.2.0 (in progress)

**Full input selection, including Re-Amp.** The input selector now covers every
input the rack offers — Guitar, Mic, Re-Amp, Line L / R / L+R and Digital L / R /
L+R — from one dropdown at the start of the chain row.

**Cab / Amp Linking.** A new GLOBALS toggle for the rack's own amp-to-cab linking:
when on, picking an amp also loads that amp's default cab and mic, exactly as the
rack's front panel does. Read from the rack at startup; not saved per patch.

**Drag a .tfx onto the Jump List.** Drop a single .tfx file from Windows onto a
user slot in the Jump List, then choose Write (save it to that slot), Try
(audition it without saving), or Cancel.

**Rig Balancing opens faster and quieter.** It now reads all 104 rig volumes
directly, without stepping the rack through every patch — no front-panel
flicker, a few seconds instead of about a minute, and no Quick/Detail choice.

**Parametric EQ curve.** The Parametric EQ panel shows a live response curve of
all four bands plus Output, redrawn as you turn any knob or change a band type.
(A close approximation of the rack's EQ shape, not a lab measurement.)

**Graphic EQ start markers.** Graphic EQ faders are now green and show a small
marker where each fader started, so you can see what you changed; double-click
still snaps back.

**Visual makeover.** A hardware-style look throughout: physical push-buttons,
lit indicator bars on on/off toggles, recessed value readouts, an amber LCD-style
patch name, a unified green, a new two-tone "Eleven Edit" wordmark, restyled
dialogs, and a cleaner header. The output mute buttons now read MUTE (dim
normally, red when muted), and the Speaker Breakup slider matches the audio
volume slider. Quick Mix sliders use the same amber ball with a grey
saved-value tick, and no longer turn red when moved. The audio bar is scaled up to
match its AUDIO ENGINE button, and its MUTE (mirrored in Audio Setup) now works
like the output mutes — always reads MUTE, lit red while muted.

**Exact Rig Volume readouts.** Rig Vol (main panel and Rig Balancing) now shows
exactly what the rack's own screen shows, instead of occasionally being 0.1–0.2 dB
off. In Rig Balancing you can also turn the rack's own Rig Vol knob: the
selected row follows it, and Save Changed stores exactly what you dialed.

**Smaller touches.** The version and build number show in the title bar and
About box; the Avid-editor warning in the status bar stays on one line.

---


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
