# Eleven Edit — Release Notes

## v1.2.0 (in progress)

**Built-in tuner.** TUNER now opens a tuner panel right in Eleven Edit: note name,
a -50 to +50 cent meter and the exact offset, matching the rack's own tuner
screen. Choose Meter + Note, LED strip + Note or Big Note, mute the output while
you tune, and set the reference pitch (A = 410 to 480 Hz) from a list or with
-/+. It follows the rack's front panel both ways, and if the rack's tuner was
left on, Eleven Edit switches it off at startup instead of waiting.

**Full input selection, including Re-Amp.** The input selector now covers every
input the rack offers — Guitar, Mic, Re-Amp, Line L / R / L+R and Digital L / R /
L+R — from one dropdown at the start of the chain row.

**Cab / Amp Linking.** A new GLOBALS toggle for the rack's own amp-to-cab linking:
when on, picking an amp also loads that amp's default cab and mic, exactly as the
rack's front panel does. Read from the rack at startup; not saved per patch.

**Drag a .tfx onto the Jump List.** Drop a single .tfx file from Windows onto a
user slot in the Jump List, then choose Write (save it to that slot), Try
(audition it without saving), or Cancel.

**Rig Browser.** A new way to find a patch when you don't know exactly which one
you want: open RIG BROWSER (next to the patch name, or Rig Browser… on the
Preset / Bank row) to see every user and factory patch in one list with its amp,
cab and mic. Search by any of them (e.g. "800", "Green 25W", "121") or pick from
the amp / cab / mic lists; CLEAR brings everything back. 🎧 plays a patch while the
browser stays open, so you can audition several in a row, and Back (or CLOSE / Esc)
returns you to where you started; ➜ or a click goes to the patch. After startup
The first time you open it in a session, Eleven Edit reads your 104 user patches from
the rack (well under a minute, with a progress box and Cancel — leave the rack alone
meanwhile); after that it opens instantly and stays up to date as you save, import or
export. Factory patches are built in.

**Rig Balancing reads silently.** It shares the Rig Browser's patch read, so all 104
rig volumes are read without stepping through patches on the rack's front panel —
and if either one has already been opened this session, it opens instantly.

**Parametric EQ graph view.** The Parametric EQ panel has a KNOBS | GRAPH switch.
GRAPH opens a large response graph across the full panel width: drag a band's dot
to set frequency and gain, use the mouse wheel for Q, double-click to return to
the patch's saved values, and right-click the LF or HF dot to change the filter
type. Under the graph, each band has Freq / Gain / Q sliders with type-in value
boxes and a tick marking the saved value. A dashed line shows the patch as saved,
a Range selector (±12 / ±24 / ±48 dB, or Fit to size the view tightly to the curve) rescales it, and GRAPH is the
default. FX1, FX2 and MOD each remember their own view and range. While the graph is
open it uses the space of the Auto Advance, Preset / Bank and audio rows (audio keeps
playing). KNOBS view keeps the small
curve. When the LF or HF band is set to Notch, Hipass or Lowpass its Gain has no
effect on the rack's sound, so Gain is greyed out and locked in both views.
(Curves are a close approximation of the rack's EQ, not a lab measurement.)

**Parametric EQ band on/off.** Each band (LF, LMF, HMF, HF) has an on/off button in
its header, in both views. The rack has no band bypass, so Off sets the band flat
(Peaking, 0 dB) on the rack while Eleven Edit remembers its real settings; the band
is greyed out but still shows them, and On puts them back. A band stays off while you
visit other blocks or models, and the memory is cleared when you change or save the
patch — saving with a band off (from the rack's front panel) saves it flat.

**Live spectrum.** With the audio engine on, the PEQ graph can show a live
spectrum of the sound behind the curves (SPECTRUM button to turn it off). It
shows the rack's final output after the whole chain, not the signal at the EQ's
position, so treat it as a broad guide and trust your ears for detail.

**Graphic EQ start markers.** Graphic EQ faders are now green and show a small
marker where each fader started, so you can see what you changed; double-click
still snaps back.

**Visual makeover.** A hardware-style look throughout: physical push-buttons,
lit indicator bars on on/off toggles, recessed value readouts, an amber LCD-style
patch name, a unified green, a new two-tone "Eleven Edit" wordmark, restyled
dialogs, and a cleaner header. The output mute buttons now read MUTE (dim
normally, red when muted), and the Speaker Breakup slider matches the audio
volume slider. Quick Mix sliders use the same amber ball with a grey
saved-value tick, and no longer turn red when moved. The audio bar leads with an
amber AUDIO CONTROL label and a compact ENABLE button (matching the Auto Advance
and Preset / Bank rows), and its MUTE (mirrored in Audio Setup) now works
like the output mutes — always reads MUTE, lit red while muted.

**Exact readouts.** Knob readouts across the app now use the rack's own value
steps, so they show what the rack's screen shows (Rig Vol, Amp Out, tone knobs,
Gate Release, Parametric EQ gain and effect knobs verified against the rack), instead of occasionally
being 0.1–0.2 dB off. Values stored in a patch between knob steps (set on the rack's front panel) now
read exactly in the effect panels too. In Rig Balancing you can also turn the rack's own Rig Vol knob: the
selected row follows it, and Save Changed stores exactly what you dialed.

**Chain row views: Classic or Modern.** Settings → Chain Row → View picks how the
chain row looks. Classic is the familiar row of icons over name pills. Modern
turns each block into a single button: click it to open its controls, drag it
to reorder, and click its indicator to bypass it. AMP sits over CAB in one
housing, STEREO/MONO is a fixed stack at the end, and INPUT sits in a matching
housing. Modern comes in five looks — Bar, Lens, Strip, Glow and Lit face — that
differ only in how "on" is shown. Everything else (Quick Mix, To Amp 1/2 markers,
stereo/mono connector lines, reorder rules) works the same in every view.

**Color intensity.** Settings → Colors has Green, Red and Amber intensity sliders
that brighten or dim every shade of that color across the whole app at once.
100% is the original look; double-click a slider to reset it.

**Steadier layout.** Only one panel is ever open at a time, and the open panel
fills the space above the Auto Advance and Preset / Bank rows. Those two rows are
now flat strips fixed just above the audio bar, so switching between panels no
longer moves anything on screen; a panel taller than the window scrolls inside
its own frame.

**Redesigned Settings.** Settings is now five columns: Folders, Rig-Wide Hardware,
Audio Configuration (with Other Configuration under it), Chain Row and Colors. The long path lines are gone — Captures, Logs
and Avid Graphics are buttons with a status light; click one to see its path and
change or open it. The Logs folder can now be changed. The Avid Graphics light
shows how many of the 39 chain-row images a scan found: green = all, amber = some
(or not scanned yet), red = none, dim = no folder set.

**Keyboard shortcuts.** T turns the tuner on/off; Esc closes the open panel
(back to Amp / Cab) as well as About and the Jump List. Neither acts while you are
typing in a box or have a dropdown selected.

**Rename sends to the rack.** Renaming a patch in the name box now shows the new
name on the rack's screen straight away (the patch is still unsaved until you Save
to Rack), so Save to Disk writes it with the new name inside. In Save to Disk the
name box is the file name only.

**Smaller touches.** The version and build number show in the title bar and
About box; the Avid-editor warning in the status bar stays on one line. Knobs
show faint end-stop marks in their ring at minimum and maximum. The tone-knob
lock button is gone — drag a knob's name to reorder any time. The TFX / BANK row
is now labelled PRESET / BANK and lines up with the AUTO ADVANCE row. New installs
start with the Modern 2 (Lens) chain row and Quick Mix off; updating from v1.1
keeps the Classic row and Quick Mix as you had them, and in Modern views the INPUT label sits
on a raised band matching the chosen look. The "rack not found" startup screen has
a shorter message and the new button style.

**Clearer audio wording.** The built-in passthrough is no longer called an
"engine": the bar reads AUDIO CONTROL / ENABLE, Settings has an Audio Configuration
column with Built-in Audio Passthrough, and Audio Setup's button is Restart Audio.
Nothing about how it works has changed.

**Panel presets (optional, off by default).** Save and load the settings of a single
effect block — Distortion, Reverb, Delay, FX1, FX2 and MOD — as small preset files,
compatible with the Avid Eleven Rack Editor's own block presets. Turn it on in
Settings → Other Configuration → Panel presets. Each of those panels then gets a
PRESET bar (SAVE, LOAD, step through a folder with − / +, or auto-step with ▶) and a
↺ RELOAD button that puts the block back the way the patch was saved. With the
setting off, the panels look and work exactly as before.

**Bypassed blocks look bypassed.** When an effect block is off, its open panel is
dimmed and marked BYPASSED (you can still edit it). On the AMP / CAB panel the amp and
cab halves dim separately.

**Smoother panel switching.** Opening an effect panel, or changing its model, now goes
straight from the old panel to the new one with every value in place — no blank-knob
step in between.

**More exact readouts.** FX Loop, Graphic EQ, Dyn Delay and MultiChorus readouts now
match the rack's screen too, and saved block presets keep the rack's exact values.
Note: the rack itself can't land on every tenth for some controls (its own dial skips
a few), while Eleven Edit shows a number for every knob position. A value the rack
doesn't have is still a valid setting — the difference is far too small to hear.

**Fixes.** Tri-Knob Fuzz knob labels now match the rack (Volume, Sustain, Tone). The
MultiChorus Low Cut range now starts at 20 Hz like the rack. The Auto Advance PAUSE
button has a proper amber pause symbol.

**Status messages are visible again.** Short notes (patch changes, loads, saves,
errors and the like) now appear in the bottom status bar and clear after a few
seconds.

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
