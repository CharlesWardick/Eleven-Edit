# tools/ — reusable dev tooling for Eleven Edit

Utilities that would otherwise get rebuilt from scratch every session.
**If you are about to write a one-off parser/script, look here first** and
extend what exists instead of re-deriving it.

## parse_capture.py — Wireshark/USBPcap → clean Eleven Rack SysEx

Reads a `.pcapng` USB capture (e.g. the Avid editor driving the rack) and
reassembles clean, application-level SysEx **exactly as the Java bridge presents
it**: `F0 13 0B 0F [dir] [cmd] ... F7`, with the USB-MIDI CIN framing bytes
(`0x04/05/06/07`) stripped.

**Why it matters:** a naive `find(F0..F7)` scan of the raw capture bytes leaves
the CIN framing embedded — you get a spurious `0x04` after `13 0B` and phantom
param bytes mid-message, and you will mis-decode message shapes. This tool does
real 4-byte-group CIN reassembly. (Background: Tech Ref Sec 2, "USB-MIDI
FRAMING".) No `tshark` required — pure Python stdlib.

```
python3 tools/parse_capture.py CAPTURE.pcapng              # summary: count by [dir cmd]
python3 tools/parse_capture.py CAPTURE.pcapng --cmd 0x42   # dump one command's messages
python3 tools/parse_capture.py CAPTURE.pcapng --tuner      # decode tuner note/tune + rate
python3 tools/parse_capture.py CAPTURE.pcapng --raw        # every clean message, hex
python3 tools/parse_capture.py CAP_A.pcapng --diff CAP_B.pcapng   # compare two captures
#   add --by-cmd to the diff to group by [dir cmd] instead of full bytes
#   add --with-ts to prefix seconds-from-start
```

**`--diff` is the workhorse** for the "load on X, step through the setting, find
the one thing that changed" workflow this project keeps running. It prints the
messages unique to each capture and those whose counts differ — e.g. an
input-selector capture on Guitar vs Mic surfaces exactly `12 3d 00` vs `12 3d 02`.

The `--tuner` decoder is a worked example of adding a command-specific decode;
copy its shape for the next command you need to decode from a capture.

**Reassembly is cross-packet:** MIDI bytes are concatenated across USB transfers
before splitting on `F0..F7`, so a message spanning more than one packet (large
TFX/bulk dumps) reassembles whole instead of being dropped.

**Known limitation:** only SysEx (`F0..F7`) is surfaced — channel-voice messages
(CC/PC/note, e.g. tap-tempo CC64, PC nav) are not. Everything the Avid editor
drives for globals/params is `13 0B 0F` SysEx, so this hasn't mattered; add a
channel-voice path if a future capture needs one.

## gen_icon.py — app icon generator ("Rack Rails" concept)

Generates `assets/icon.ico` (multi-size: 16/24/32/48/64/128/256) and
`assets/icon.png` (512, for README/Linux use) with Pillow. Draws two
numeral-"1" silhouettes (brushed-metal rail material, base foot + top
flag) side by side, plus an amber LED and rack-ear screw dots — the app's
icon, not a protocol tool, but kept here per the "save any one-off tool"
rule below rather than losing the generation logic once the .ico exists.

Each size is drawn NATIVELY (not resized down from one master image) so
the numeral stays crisp at 16px instead of blurring — the flag notch is
dropped below 32px, but the base foot (the detail that actually
distinguishes "1" from a plain bar) is kept at every size.

```
python3 tools/gen_icon.py
```

Regenerate after changing colors/proportions in the script; there's no
separate source-of-truth vector file, the script IS the source.

## Maintaining this directory

Keep improving `parse_capture.py` in place as new needs come up (a new
command decoder, a new view), and **save any other one-off tool you build here**
instead of letting it evaporate with the chat — that is the whole point of
`tools/`. Look here first before writing a new script.

Verified against `…Tuner_Reference_440…Eb_Ab_Db_Gb_Bb_Eb…pcapng` (2026-08-31):
CMD 0x42 note/tune stream, ~32 Hz poll, `note = octave<<4 | chromatic(0=C..11=B)`,
`tune 0x40 = in tune`. See Tech Ref Sec 9.
