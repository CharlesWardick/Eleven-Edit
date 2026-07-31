// ════════════════════════════════════════════════════════════════════
// PROTOCOL.JS — everything reverse-engineered about the Eleven Rack's
// SysEx protocol: constants, confirmed offsets, amp/gate lookup tables,
// and the pure decode functions that read values out of a SEND_PATCH
// body. No DOM dependency (other than appLog for logging, from ui.js —
// loads after this, fine since these are only CALLED later, not at
// parse time).
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// ERROR HANDLERS
// ════════════════════════════════════════════════════════════════════
window.onerror = function(msg, src, line) {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#300;color:#fff;padding:10px;font-family:monospace;font-size:12px;z-index:9999;white-space:pre-wrap;';
  div.textContent = 'ERROR: ' + msg + ' — Line: ' + line;
  document.body.appendChild(div);
  return false;
};
window.addEventListener('unhandledrejection', e => {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;top:36px;left:0;right:0;background:#320;color:#ffa;padding:10px;font-family:monospace;font-size:12px;z-index:9999;';
  div.textContent = 'PROMISE: ' + (e.reason && e.reason.message ? e.reason.message : e.reason);
  document.body.appendChild(div);
});

// ════════════════════════════════════════════════════════════════════
// CONSTANTS & STATE
// ════════════════════════════════════════════════════════════════════
const BANKS    = ['A','B','C','D','E','F','G','H','I','J','K','L','M',
                  'N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];
const MAX_SLOT = 103;
const CC_TUNER = 69;

// Avid SysEx constants
const SYSEX_HDR    = [0xF0, 0x13, 0x0B, 0x0F];
const DIR_SNDSET   = 0x00;
const DIR_REQU     = 0x01;
const CMD_RIG_DESC = 0x21;

// Confirmed-working REQU commands (see ElevenRack_Protocol_Research.txt /
// POC log) — used to read current state directly through the bridge,
// without needing the Avid editor open to trigger these as a side effect.
// Confirmed 7/9/2026 via Wireshark/USBPcap capture of the real Avid
// editor's own USB traffic (Vendor Specific bulk endpoint, invisible to
// MIDI-OX) — every bare REQU command is exactly F0 13 0B 0F 01 [cmd] F7,
// 7 bytes, NO trailing padding. The versions below previously had
// spurious extra bytes (07, or 07 00 00) that the real editor never
// sends — almost certainly the actual root cause of gate/patch-state
// pulls being unreliable all along. Corrected to match exactly.
const REQU_CHAIN_MAP  = 'F0 13 0B 0F 01 21 F7';
const REQU_SEND_PATCH = 'F0 13 0B 0F 01 01 F7';
const REQU_PATCH_NAME = 'F0 13 0B 0F 01 05 F7';
const REQU_RIG_VOL    = 'F0 13 0B 0F 01 07 F7';
const REQU_CURR_RIG   = 'F0 13 0B 0F 01 02 F7';

// ── DIAGNOSTIC — amp paramLo investigation, 2026-07-22.
// The Avid editor sends these five queries after every patch recall and we
// have never decoded any of them. In the Wireshark captures they are short
// messages, so the capture truncation ate their entire payload. Our own logs
// are NOT truncated, so asking for them ourselves is the way to see them.
// Hypothesis: one of these returns a parameter descriptor for the currently
// loaded amp, which would give us the paramLo map for every amp model without
// sweeping each one by hand.
// Set PROBE_UNKNOWN_QUERIES false in transport.js to switch all of this off.
const REQU_PROBE_03   = 'F0 13 0B 0F 01 03 F7';
const REQU_PROBE_08   = 'F0 13 0B 0F 01 08 F7';
const REQU_PROBE_0A   = 'F0 13 0B 0F 01 0A F7';
const REQU_PROBE_34   = 'F0 13 0B 0F 01 34 F7';
const REQU_PROBE_50   = 'F0 13 0B 0F 01 50 F7';

// CMD 0x36 read candidates. We only ever WRITE 0x36; no read form has ever
// been tried. Every other read in this protocol is F0 13 0B 0F 01 <cmd> F7,
// and CMD 0x3A takes a slot byte the same way, so try bare and both slots.
// Read-only: these cannot alter or corrupt a patch.
const REQU_PROBE_36    = 'F0 13 0B 0F 01 36 F7';
const REQU_PROBE_36_S2 = 'F0 13 0B 0F 01 36 02 F7';
const REQU_PROBE_36_S3 = 'F0 13 0B 0F 01 36 03 F7';

// CMD 0x0D read candidate. Confirmed 2026-07-22 from Mono_Toggle.pcapng that
// CMD 0x0D IS the Mono/Stereo command: the Avid editor writes it as
// F0 13 0B 0F 00 0D <val> F7 and the rack echoes F0 13 0B 0F 02 0D <val> F7.
// We already set and handle 0x0D; only the read form is missing.
const REQU_PROBE_0D    = 'F0 13 0B 0F 01 0D F7';

// ── Confirmed read commands for the outer (rig) level, 2026-07-22.
// These replace values previously only obtainable from the bulk TFX body.
//   To Amp volume — slot byte REQUIRED; the bare form returns nothing.
//     F0 13 0B 0F 01 36 <02|03> F7
//     -> F0 13 0B 0F 12 36 <slot> <v0> 00 00 00 00 F7
//   Mono/Stereo — verified 5/5 against hardware state, read does not toggle.
//     F0 13 0B 0F 01 0D F7  ->  F0 13 0B 0F 12 0D <00 stereo|01 mono> F7
const REQU_TOAMP1_READ = 'F0 13 0B 0F 01 36 02 F7';
const REQU_TOAMP2_READ = 'F0 13 0B 0F 01 36 03 F7';
const REQU_MONO_READ   = 'F0 13 0B 0F 01 0D F7';

//   Master (Main) output volume — same command as To Amp 1/2, outSel=0x00.
//     F0 13 0B 0F 01 36 00 F7  ->  F0 13 0B 0F 12 36 00 <v0> 00 00 00 00 F7
const REQU_MASTER_VOL_READ = 'F0 13 0B 0F 01 36 00 F7';

// CMD 0x3B — Master Mute (Main output / Headphone output). Confirmed
// 7/29/2026 from Avid Editor USB capture (Master_Volume_Mute_Phones_
// Capture.pcapng) — see Tech Ref Sec 18/C13 "MASTER MUTE — MAIN / PHONES".
//   F0 13 0B 0F [dir] 3B [channel] [state] F7
// channel: MUTE_CH_MAIN (0x00) / MUTE_CH_PHONES (0x01).
// state: 0x00 = unmuted, 0x01 = muted. No query/read form observed.
const MUTE_CH_MAIN   = 0x00;
const MUTE_CH_PHONES = 0x01;

//   Rig tempo — CMD 0x50. Reply carries the four 6-bit digits (see
//   rigTempoDecodeUs below). Reply direction byte observed as 0x12 for the
//   answer to this query and 0x02 for an unsolicited broadcast; the handler
//   accepts either.
const REQU_TEMPO_READ  = 'F0 13 0B 0F 01 50 F7';

// Responses to raw-dump in full. Set to [] to silence the dump.
// 0x50 removed 7/24/2026 — it is decoded now and has a real handler, so the
// raw dump was only doubling the log on every tempo change (and a tempo
// change is already a noisy event).
const PROBE_DUMP_CMDS = [0x03, 0x08, 0x0A, 0x0D, 0x34, 0x36];

// ════════════════════════════════════════════════════════════════════
// RIG TEMPO — CMD 0x50 (decoded 7/24/2026, Tempo_Settings.pcapng)
// ════════════════════════════════════════════════════════════════════
// Payload is MICROSECONDS PER BEAT — the standard MIDI tempo quantity —
// carried as a 24-bit number split into four SIX-bit digits, most
// significant first:
//     us = (d1 << 18) | (d2 << 12) | (d3 << 6) | d4
//     BPM = 60000000 / us
// Every payload byte is therefore below 0x40, which is the tell that these
// are 6-bit digits and not the 7-bit bytes used by CMD 0x11. Reading them as
// base 128 is what made this look like an undecodable inverse relationship
// with a ~98:1 span for the better part of a day.
// Exact against all six calibration points, no rounding slack:
//     500.0 -> 00 1D 13 00 -> 120000     60.0 -> 03 34 09 00 -> 1000000
//     120.0 -> 01 3A 04 20 -> 500000    240.0 -> 00 3D 02 10 -> 250000
//      32.1 -> 07 08 15 27 -> 1869159    10.0 -> 16 38 36 00 -> 6000000
const TEMPO_BPM_MIN = 10.0;
const TEMPO_BPM_MAX = 500.0;

function rigTempoDecodeUs(d1, d2, d3, d4) {
  return (d1 << 18) | (d2 << 12) | (d3 << 6) | d4;
}

// Microseconds per beat -> BPM, rounded to the tenth the display shows.
function rigTempoUsToBpm(us) {
  if (!us) return null;
  return Math.round((60000000 / us) * 10) / 10;
}

// BPM -> the four 6-bit digits, ready to drop into a send string.
function rigTempoBpmToDigits(bpm) {
  var us = Math.round(60000000 / bpm);
  if (us < 1) us = 1;
  if (us > 0xFFFFFF) us = 0xFFFFFF;
  return [(us >> 18) & 0x3F, (us >> 12) & 0x3F, (us >> 6) & 0x3F, us & 0x3F];
}

// ── Model display names, indexed by the chain map's mid (CMD 0x20 index).
// Complete: all 65 indices, captured from the editor's startup enumeration.
// Used for the chain slot hover text so the user can see what is loaded in a
// slot without opening its panel.
const MODEL_NAMES = {
  0x00: 'Eleven',
  0x01: 'C1 Chorus/Vibrato',
  0x02: 'C1 Chorus/Vibrato',
  0x03: 'C1 Chorus/Vibrato',
  0x04: 'MultiChorus',
  0x05: 'Multi Chorus',
  0x06: 'Multi Chorus',
  0x07: 'Flanger',
  0x08: 'Flanger',
  0x09: 'Vibe Phaser',
  0x0A: 'Vibe Phaser',
  0x0B: 'Orange Phaser',
  0x0C: 'Orange Phaser',
  0x0D: 'Roto Speaker',
  0x0E: 'Roto Speaker',
  0x0F: 'Roto Speaker',
  0x10: 'Graphic EQ',
  0x11: 'Graphic EQ',
  0x12: 'Parametric EQ',
  0x13: 'Parametric EQ',
  0x14: 'Gray Compressor',
  0x15: 'Dyn3 Compressor',
  0x16: 'Dyn3 Compressor',
  0x17: 'Tri-Knob Fuzz',
  0x18: 'Black Op Distortion',
  0x19: 'Green JRC Overdrive',
  0x1A: 'White Boost',
  0x1B: 'DC Distortion',
  0x1C: 'EP Tape Echo',
  0x1D: 'EP Tape Echo',
  0x1E: 'BBD Delay',
  0x1F: 'BBD Delay',
  0x20: 'Dyn Delay',
  0x21: 'Dyn Delay',
  0x22: 'Dyn Delay',
  0x23: 'Shine Wah',
  0x24: 'Black Wah',
  0x25: 'Tuner',
  0x26: 'Blackpanel Spring Reverb',
  0x27: 'Blackpanel Spring Reverb',
  0x28: 'Eleven SR',
  0x29: 'Eleven SR',
  0x2A: 'Eleven SR',
  0x2B: 'Volume Pedal',
  0x2C: 'Volume Pedal',
  0x2D: 'FX Loop',
  0x2E: 'FX Loop',
  0x2F: 'FX Loop',
  0x30: 'FX Loop',
  0x31: 'FX Loop',
  0x32: 'FX Loop',
  0x33: 'FX Loop',
  0x34: 'DSP2 Copier',
  0x35: 'Dummy',
  0x36: 'Mute',
  0x37: 'Guitar In',
  0x38: 'Mic In',
  0x39: 'FakeStereo In',
  0x3A: 'PtLeGuitar In',
  0x3B: 'LineL In',
  0x3C: 'LineR In',
  0x3D: 'LineS In',
  0x3E: 'DigitalL In',
  0x3F: 'DigitalR In',
  0x40: 'DigitalS In'
};

// ── Does this model OUTPUT stereo?
// Drives the chain row connectors: the connector AFTER a block is stereo
// exactly when that block's output is stereo.
//
// RULE (holds across every one of the 30 direct observations, no exceptions):
//   the LOWEST variant in a model family outputs MONO;
//   every other variant in that family outputs STEREO.
// It follows from there being no stereo-in/mono-out variant anywhere in the
// unit — see Tech Ref Sec 4. Entries marked [derived] come from that rule;
// the rest were observed directly.
//
// EXCEPTION — FX Loop. Its send and return are independent, so variant order
// says nothing about its output (0x31 is mono-out despite not being lowest).
// Loop variants must be observed one at a time; 0x2E, 0x2F and 0x33 are the
// only models in the unit still unknown.
//
// A mid missing from this table draws a DASHED connector, not a mono one, and
// logs a warning — unknown must never look like a confident answer.
const MODEL_OUT_STEREO = {
  0x00: false, // Eleven
  0x01: false, // C1 Chorus/Vibrato   [derived]
  0x02: true,  // C1 Chorus/Vibrato
  0x03: true,  // C1 Chorus/Vibrato
  0x04: false, // MultiChorus
  0x05: true,  // Multi Chorus
  0x06: true,  // Multi Chorus
  0x07: false, // Flanger
  0x08: true,  // Flanger   [derived]
  0x09: false, // Vibe Phaser   [derived]
  0x0A: true,  // Vibe Phaser
  0x0B: false, // Orange Phaser
  0x0C: true,  // Orange Phaser   [derived]
  0x0D: false, // Roto Speaker
  0x0E: true,  // Roto Speaker   [derived]
  0x0F: true,  // Roto Speaker   [derived]
  0x10: false, // Graphic EQ
  0x11: true,  // Graphic EQ
  0x12: false, // Parametric EQ
  0x13: true,  // Parametric EQ
  0x14: false, // Gray Compressor
  0x15: false, // Dyn3 Compressor   [derived]
  0x16: true,  // Dyn3 Compressor
  0x17: false, // Tri-Knob Fuzz   [derived]
  0x18: false, // Black Op Distortion   [derived]
  0x19: false, // Green JRC Overdrive
  0x1A: false, // White Boost
  0x1B: false, // DC Distortion   [derived]
  0x1C: false, // EP Tape Echo
  0x1D: true,  // EP Tape Echo   [derived]
  0x1E: false, // BBD Delay
  0x1F: true,  // BBD Delay   [derived]
  0x20: false, // Dyn Delay
  0x21: true,  // Dyn Delay   [derived]
  0x22: true,  // Dyn Delay
  0x23: false, // Shine Wah
  0x24: false, // Black Wah
  0x25: false, // Tuner   [derived]
  0x26: false, // Blackpanel Spring Reverb   [derived]
  0x27: true,  // Blackpanel Spring Reverb
  0x28: false, // Eleven SR   [derived]
  0x29: true,  // Eleven SR
  0x2A: true,  // Eleven SR
  0x2B: false, // Volume Pedal
  0x2C: true,  // Volume Pedal
  0x2D: false, // FX Loop
  0x30: true,  // FX Loop
  0x31: false, // FX Loop
  0x32: true,  // FX Loop
};

// ── Per-amp tone knob paramLo table — confirmed via Wireshark 7/14/2026.
// paramLo values only — paramHi is the AMP BLOCK'S HANDLE, read at runtime
// from the CMD 0x21 chain map and stored as currentParamHi. The amp block is
// the one whose SLOT ID is 0x00; see the CMD 0x21 handler in sysex-handler.js.
// (An earlier comment here described it as "the third byte of the typeA=0x07
// triplet". There is no typeA field — byte 1 of a triplet is a back-link to
// the previous block's slot ID, and 0x07 is DIST. That description produced a
// real bug: the amp handle was wrong on any patch where the amp did not
// immediately follow the distortion. Fixed 2026-07-19.)
// Gate and Amp Out paramLo are consistent across ALL amps:
//   Gate Threshold = 0x04, Gate Release = 0x05, Amp Out = 0x03
// knobs: hardware panel order. type 'knob'=continuous, 'selector'=discrete(deferred).
// null entry = amp not yet captured, tone knobs hidden until confirmed.
// knobs: hardware panel order. lo=CMD 0x11 paramLo (from Wireshark).
// tfxKey=TFX binary key name (from XML/binary scan — NOT derived from lo).
// type: 'knob'=continuous, 'selector'=discrete (deferred, no UI knob).
// Both lo AND tfxKey are required for full send+readback+TFX decode.
const AMP_TONE_PARAMS = {
  tweed_lux: {
    knobs: [
      { lo: 0x0A, tfxKey: 'sldA', label: 'Tone',     type: 'knob' },
      { lo: 0x07, tfxKey: 'sld7', label: 'Inst Vol', type: 'knob' },
      { lo: 0x08, tfxKey: 'sld8', label: 'Mic Vol',  type: 'knob' },
    ],
  },
  tweed_bass: {
    knobs: [
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence',   type: 'knob' },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Mid',        type: 'knob' },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',       type: 'knob' },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',     type: 'knob' },
      { lo: 0x07, tfxKey: 'sld7', label: 'Vol Bright', type: 'knob' },
      { lo: 0x08, tfxKey: 'sld8', label: 'Vol Norm',   type: 'knob' },
    ],
  },
  lux_vib: {
    // Speed=sldG(0x10 in XML) maps to paramLo 0x11 per Wireshark 7/15/2026
    // Intensity=sldF(0x0F in XML) maps to paramLo 0x10 per Wireshark 7/15/2026
    // tfxKey confirmed from TFX binary scan — NOT derived from paramLo
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Volume',    type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',    type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',      type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',     type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',      type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Intensity', type: 'knob'     },
    ],
  },
  // Remaining 30 amps: captures pending
  lux_norm: {
    // Confirmed identical to lux_vib via XML diff and Wireshark 7/15/2026
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Volume',    type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',    type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',      type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',     type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',      type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Intensity', type: 'knob'     },
    ],
  },
  // Black family — confirmed via Wireshark 7/15/2026
  // Bright toggle: paramLo 0x0E, tfxKey sldE, vals 0=off 127=on
  // Sync selector fires 0x11+0x12 together when stepped — both marked selector
  black_vib: {
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Volume',    type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',    type: 'knob'     },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Mid',       type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',      type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',     type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',      type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Intensity', type: 'knob'     },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',    type: 'toggle'   },
    ],
  },
  black_sr: {
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Volume',    type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',    type: 'knob'     },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Mid',       type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',      type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',     type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',      type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Intensity', type: 'knob'     },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',    type: 'toggle'   },
    ],
  },
  black_mini: {
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Volume',    type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',    type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',      type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',     type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',      type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Intensity', type: 'knob'     },
    ],
  },
  black_duo: {
    // Confirmed via Wireshark 7/15/2026 — identical to black_vib/black_sr
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Volume',    type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',    type: 'knob'     },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Mid',       type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',      type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',     type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',      type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Intensity', type: 'knob'     },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',    type: 'toggle'   },
    ],
  }, ac_hi: {
    // Confirmed via Wireshark 7/15/2026
    knobs: [
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',       type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',        type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Depth',       type: 'knob'     },
      { lo: 0x07, tfxKey: 'sld7', label: 'Normal Vol',  type: 'knob'     },
      { lo: 0x08, tfxKey: 'sld8', label: 'Brill Vol',   type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',      type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',        type: 'knob'     },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Cut',         type: 'knob'     },
    ],
  }, plexi100: {
    // Confirmed via Wireshark 7/15/2026 — identical paramLos to PlexiVari and Plexi50
    knobs: [
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob' },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob' },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Mid',      type: 'knob' },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob' },
      { lo: 0x07, tfxKey: 'sld7', label: 'Vol 1',    type: 'knob' },
      { lo: 0x08, tfxKey: 'sld8', label: 'Vol 2',    type: 'knob' },
    ],
  }, plexi50: {
    // Confirmed via Wireshark 7/15/2026 — identical to plexi100
    knobs: [
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob' },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob' },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Mid',      type: 'knob' },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob' },
      { lo: 0x07, tfxKey: 'sld7', label: 'Vol 1',    type: 'knob' },
      { lo: 0x08, tfxKey: 'sld8', label: 'Vol 2',    type: 'knob' },
    ],
  },
  plexivari: {
    // Confirmed via Wireshark 7/15/2026 — identical to plexi100/50
    knobs: [
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob' },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob' },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Mid',      type: 'knob' },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob' },
      { lo: 0x07, tfxKey: 'sld7', label: 'Vol 1',    type: 'knob' },
      { lo: 0x08, tfxKey: 'sld8', label: 'Vol 2',    type: 'knob' },
    ],
  }, j45: {
    // Confirmed via Wireshark 7/15/2026
    knobs: [
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob' },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob' },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Mid',      type: 'knob' },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob' },
      { lo: 0x07, tfxKey: 'sld7', label: 'Vol 1',    type: 'knob' },
      { lo: 0x08, tfxKey: 'sld8', label: 'Vol 2',    type: 'knob' },
    ],
  }, blueline: {
    // Confirmed via Wireshark 7/15/2026
    // 0x19 (sldO) = Mid Freq — new paramLo not seen in other amps
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Volume',    type: 'knob'   },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',    type: 'knob'   },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Mid',       type: 'knob'   },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',      type: 'knob'   },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Ultra-Hi',  type: 'knob'   },
      { lo: 0x08, tfxKey: 'sld8', label: 'Ultra-Low', type: 'knob'   },
      { lo: 0x19, tfxKey: 'sldO', label: 'Mid Freq',  type: 'knob'   },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',    type: 'toggle' },
    ],
  }, lead800: {
    // Confirmed via Wireshark 7/15/2026
    knobs: [
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob' },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob' },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob' },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob' },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob' },
      { lo: 0x07, tfxKey: 'sld7', label: 'Pre Amp',  type: 'knob' },
    ],
  }, m2lead: {
    // Confirmed via Wireshark 7/15/2026
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Volume',   type: 'knob'   },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'   },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'   },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'   },
      { lo: 0x08, tfxKey: 'sld8', label: 'Drive',    type: 'knob'   },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob'   },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'   },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle' },
    ],
  }, sl100drive: {
    // Confirmed via Wireshark 7/15/2026
    // MOD toggle on Drive = same paramLo/tfxKey as Bright on other amps
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Preamp',   type: 'knob'   },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'   },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'   },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'   },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'   },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob'   },
      // Named MOD on this amp only — Crunch and Clean call the same
      // paramLo/tfxKey Bright (Tech Ref Sec 11). The button takes its text
      // from this label, so the GUI now matches the rack's front panel.
      { lo: 0x0E, tfxKey: 'sldE', label: 'MOD',      type: 'toggle' },
    ],
  }, sl100crunch: {
    // Confirmed via Wireshark 7/15/2026 — identical to sl100drive
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Preamp',   type: 'knob'   },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'   },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'   },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'   },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'   },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob'   },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle' },
    ],
  }, sl100clean: {
    // Confirmed via Wireshark 7/15/2026 — identical to sl100drive/crunch
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Preamp',   type: 'knob'   },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'   },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'   },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'   },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'   },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob'   },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle' },
    ],
  },
  treadmod: {
    // Confirmed via Wireshark 7/15/2026 — identical paramLos to treadvint
    knobs: [
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob' },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob' },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob' },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob' },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob' },
      { lo: 0x07, tfxKey: 'sld7', label: 'Gain',     type: 'knob' },
    ],
  }, treadvint: {
    // Confirmed via Wireshark 7/15/2026 — identical to treadmod
    knobs: [
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob' },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob' },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob' },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob' },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob' },
      { lo: 0x07, tfxKey: 'sld7', label: 'Gain',     type: 'knob' },
    ],
  }, ms30: {
    // Confirmed via Wireshark 7/15/2026
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Volume', type: 'knob' },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',   type: 'knob' },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble', type: 'knob' },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Cut',    type: 'knob' },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master', type: 'knob' },
    ],
  }, rb01b_red: {
    // Confirmed via Wireshark 7/15/2026
    knobs: [
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'   },
      { lo: 0x09, tfxKey: 'sld9', label: 'Volume',   type: 'knob'   },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'   },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'   },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'   },
      { lo: 0x07, tfxKey: 'sld7', label: 'Gain',     type: 'knob'   },
      { lo: 0x08, tfxKey: 'sld8', label: 'Boost',    type: 'knob'   },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle' },
    ],
  }, rb01b_blue: {
    // Confirmed via Wireshark 7/15/2026 — identical to rb01b_red
    knobs: [
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'   },
      { lo: 0x09, tfxKey: 'sld9', label: 'Volume',   type: 'knob'   },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'   },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'   },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'   },
      { lo: 0x07, tfxKey: 'sld7', label: 'Gain',     type: 'knob'   },
      { lo: 0x08, tfxKey: 'sld8', label: 'Boost',    type: 'knob'   },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle' },
    ],
  }, rb01b_green: {
    // Confirmed via Wireshark 7/15/2026 — identical to rb01b_red/blue
    knobs: [
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'   },
      { lo: 0x09, tfxKey: 'sld9', label: 'Volume',   type: 'knob'   },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'   },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'   },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'   },
      { lo: 0x07, tfxKey: 'sld7', label: 'Gain',     type: 'knob'   },
      { lo: 0x08, tfxKey: 'sld8', label: 'Boost',    type: 'knob'   },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle' },
    ],
  }, dc_mod_od: {
    // Confirmed via Wireshark 7/15/2026 — first 8-knob amp
    // Sync selector fires 0x11+0x12 together (same as Lux/Black family)
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Gain',      type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',      type: 'knob'     },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',    type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',    type: 'knob'     },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence',  type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',     type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',      type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Depth',     type: 'knob'     },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',    type: 'knob'     },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',    type: 'toggle'   },
    ],
  }, dc_mod_sod: {
    // Confirmed 7/15/2026 — same order as dc_mod_od
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Gain',     type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'     },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'     },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',    type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',     type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Depth',    type: 'knob'     },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob'     },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle'   },
    ],
  }, dc_mod800: {
    // Confirmed 7/15/2026 — same order as dc_mod_od
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Gain',     type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'     },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'     },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',    type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',     type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Depth',    type: 'knob'     },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob'     },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle'   },
    ],
  }, dc_mod_clean: {
    // Confirmed 7/15/2026 — same order as dc_mod_od
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Gain',     type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'     },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'     },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',    type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',     type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Depth',    type: 'knob'     },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob'     },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle'   },
    ],
  }, dc_vint_crunch: {
    // Confirmed 7/15/2026 — same order as dc_mod_od
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Gain',     type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'     },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'     },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',    type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',     type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Depth',    type: 'knob'     },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob'     },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle'   },
    ],
  }, dc_vint_od: {
    // Confirmed 7/15/2026 — same order as dc_mod_od
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Gain',     type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'     },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'     },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',    type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',     type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Depth',    type: 'knob'     },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob'     },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle'   },
    ],
  }, dc_vint_clean: {
    // Confirmed 7/15/2026 — same order as dc_mod_od
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Gain',     type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'     },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'     },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',    type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',     type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Depth',    type: 'knob'     },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob'     },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle'   },
    ],
  }, dc_bass: {
    // Confirmed 7/15/2026 — same order as dc_mod_od
    knobs: [
      { lo: 0x07, tfxKey: 'sld7', label: 'Gain',     type: 'knob'     },
      { lo: 0x0C, tfxKey: 'sldC', label: 'Bass',     type: 'knob'     },
      { lo: 0x0B, tfxKey: 'sldB', label: 'Middle',   type: 'knob'     },
      { lo: 0x0A, tfxKey: 'sldA', label: 'Treble',   type: 'knob'     },
      { lo: 0x0D, tfxKey: 'sldD', label: 'Presence', type: 'knob'     },
      { lo: 0x11, tfxKey: 'sldG', label: 'Speed',    type: 'knob'     },
      { lo: 0x12, tfxKey: 'Sync', label: 'Sync',     type: 'selector' },
      { lo: 0x10, tfxKey: 'sldF', label: 'Depth',    type: 'knob'     },
      { lo: 0x09, tfxKey: 'sld9', label: 'Master',   type: 'knob'     },
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle'   },
    ],
  },
};

// ════════════════════════════════════════════════════════════════════
// TREMOLO FEATURE SET — Depth 0x10 / Speed 0x11 / Sync 0x12 / On-Off 0x13
// ════════════════════════════════════════════════════════════════════
// Confirmed 7/23/2026 from two front-panel captures at 32.1 and 120 BPM.
//
// SYNC (paramLo 0x12) is a CONTINUOUS 0-127 value on the wire that the
// firmware quantises into 14 zones: OFF plus 13 note divisions. Zone width
// is 10, with the first and last zones truncated to 4 so the total is 128:
//     0-3     OFF
//     4-13    division 1
//     ...     (10 apart)
//     114-123 division 12
//     124-127 division 13
// Derived from the Speed value changing at decoded 64,74,84,94,104,114,124
// in the 120 BPM capture and at 114,124 only in the 32.1 capture (the slower
// divisions fall below the Speed floor and all read 0 — that is the hardware,
// not a decode fault).
//
// The division ORDER is whole note, then dotted / plain / triplet for half,
// quarter, eighth and sixteenth. Independently confirmed by the displayed
// Speed dipping at zones 8 and 11, which is exactly where a dotted note
// follows a triplet.
const SYNC_DIVISIONS = [
  { glyph: '\u2014',            text: 'OFF'           },  // zone 0
  { glyph: '\uD834\uDD5D',      text: '1/1'           },  // whole
  { glyph: '\uD834\uDD5E.',     text: '1/2 dotted'    },
  { glyph: '\uD834\uDD5E',      text: '1/2'           },
  { glyph: '\uD834\uDD5E\u00B3',text: '1/2 triplet'   },
  { glyph: '\u2669.',           text: '1/4 dotted'    },
  { glyph: '\u2669',            text: '1/4'           },
  { glyph: '\u2669\u00B3',      text: '1/4 triplet'   },
  { glyph: '\u266A.',           text: '1/8 dotted'    },
  { glyph: '\u266A',            text: '1/8'           },
  { glyph: '\u266A\u00B3',      text: '1/8 triplet'   },
  { glyph: '\u266C.',           text: '1/16 dotted'   },
  { glyph: '\u266C',            text: '1/16'          },
  { glyph: '\u266C\u00B3',      text: '1/16 triplet'  },
];

// Wire value (0-127, already offset-decoded) -> zone index 0-13.
function syncIndexFromV127(v) {
  if (v === null || v === undefined) return 0;
  if (v < 4) return 0;
  const i = 1 + Math.floor((v - 4) / 10);
  return i > 13 ? 13 : i;
}

// Zone index -> the value to WRITE. Uses the centre of the zone so a small
// rounding error either way still lands in the intended division.
function syncV127FromIndex(i) {
  if (i <= 0) return 0;
  if (i >= 13) return 125;
  return 8 + 10 * (i - 1);
}

// An amp has the tremolo feature set if its tone table carries the Sync
// selector. That is true of all 15 amps listed in Tech Ref Sec 11, so no
// separate list has to be maintained here.
function ampHasTremolo(key) {
  const ap = key ? AMP_TONE_PARAMS[key] : null;
  return !!(ap && ap.knobs && ap.knobs.some(k => k.lo === 0x12));
}

// ── Amp model integer → AMP key ──
const AMP_ID_TO_KEY = {
  0:          'tweed_lux',
  1:          'tweed_bass',
  2:          'lux_vib',
  3:          'lux_norm',
  4:          'ac_hi',
  5:          'black_duo',
  6:          'plexi100',
  7:          'lead800',
  8:          'm2lead',
  9:          'sl100drive',
  10:         'sl100crunch',
  11:         'sl100clean',
  12:         'treadmod',
  13:         'treadvint',
  14:         'dc_mod_od',
  15:         'dc_vint_crunch',
  1095980628: 'blueline',
  1112764530: 'black_sr',
  1112957526: 'black_vib',
  1128428337: 'dc_bass',
  1128940365: 'dc_mod800',
  1129136945: 'dc_mod_clean',
  1129726769: 'dc_vint_clean',
  1145261362: 'dc_mod_sod',
  1145263666: 'dc_vint_od',
  1247032373: 'j45',
  1296315184: 'ms30',
  1345663095: 'plexi50',
  1349277298: 'plexivari',
  1447258221: 'black_mini',
  1481917250: 'rb01b_blue',
  1481917255: 'rb01b_green',
  1481917266: 'rb01b_red',
  1574821341: 'treadvint',
  1861152494: 'dc_mod_od',
  2147483647: 'dc_vint_crunch',
};

// ── Amp model name map ──
const AMP_NAME_MAP = {
  tweed_lux:'59 Tweed Lux', tweed_bass:'59 Tweed Bass',
  lux_vib:'64 Lux Vib', lux_norm:'64 Lux Nor',
  black_vib:'64 Black Vib', black_sr:'65 Black SR',
  black_mini:'65 Black Mini', j45:'65 J45',
  ac_hi:'66 AC Hi Boost', black_duo:'67 Black Duo',
  plexivari:'67 Plexi Vari', plexi50:'68 Plexi 50W',
  plexi100:'69 Plexi 100W', blueline:'69 Blue Line',
  lead800:'82 Lead 800', m2lead:'85 M-2 Lead',
  sl100drive:'89 SL100 Drive', sl100crunch:'89 SL100 Crunch',
  sl100clean:'89 SL100 Clean', treadmod:'92 Tread Mod',
  treadvint:'92 Tread Vin', ms30:'93 MS-30',
  rb01b_red:'97 RB-01b Red', rb01b_blue:'97 RB-01b Blue',
  rb01b_green:'97 RB-01b Grn', dc_mod_od:'DC Mod OD',
  dc_mod_sod:'DC Mod SOD', dc_mod800:'DC Mod 800',
  dc_mod_clean:'DC Mod Cln', dc_vint_crunch:'DC Vint CR',
  dc_vint_od:'DC Vint OD', dc_vint_clean:'DC Vint Cln',
  dc_bass:'DC Bass',
};

// ── Amp SELECT list — CMD 0x11 paramId 0x0F, confirmed 7/10/2026 via a
// full walk-through capture of every position in Avid Editor's amp
// dropdown, in order, ending back where it started. This is a DIFFERENT
// numbering scheme than AMP_ID_TO_KEY (which is the internal TFX '6dls'
// identifier) — this is literally "position in the on-screen list",
// spread evenly across a 0-127 range with 7-bit wraparound (confirmed:
// ~3.85 apart per position, wraps right after M-2 Lead). Sent as the raw
// byte directly (see sendRawParamWrite) — NOT run through the (v127+64)
// %128 formula used for continuous knobs like Gate/Amp Out, since this
// isn't a scaled value, it's a specific confirmed position on the dial.
const AMP_SELECT_LIST = [
  { key:'tweed_lux',      label:"59 Tweed Lux",          v0:0x40 },
  { key:'tweed_bass',     label:"59 Tweed Bass",         v0:0x44 },
  { key:'lux_vib',        label:"64 Lux Vib",            v0:0x48 },
  { key:'lux_norm',       label:"64 Lux Norm",           v0:0x4C },
  { key:'black_vib',      label:"64 Black Vib",          v0:0x50 },
  { key:'black_sr',       label:"65 Black SR",           v0:0x54 },
  { key:'black_mini',     label:"65 Black Mini",         v0:0x58 },
  { key:'black_duo',      label:"67 Black Duo",          v0:0x64 },
  { key:'j45',            label:"65 J45",                v0:0x5C },
  { key:'ac_hi',          label:"66 AC Hi Boost",        v0:0x60 },
  { key:'plexivari',      label:"67 Plexi Vari",         v0:0x68 },
  { key:'plexi50',        label:"68 Plexi 50W",          v0:0x6C },
  { key:'plexi100',       label:"69 Plexi 100W",         v0:0x70 },
  { key:'blueline',       label:"69 Blue Line",          v0:0x74 },
  { key:'lead800',        label:"82 Lead 800",           v0:0x78 },
  { key:'m2lead',         label:"85 M-2 Lead",           v0:0x7C },
  { key:'sl100drive',     label:"89 SL-100 Drive",       v0:0x00 },
  { key:'sl100crunch',    label:"89 SL-100 Crunch",      v0:0x03 },
  { key:'sl100clean',     label:"89 SL-100 Clean",       v0:0x07 },
  { key:'treadmod',       label:"92 Treadplate Modern",  v0:0x0B },
  { key:'treadvint',      label:"92 Treadplate Vintage", v0:0x0F },
  { key:'ms30',           label:"93 MS-30",              v0:0x13 },
  { key:'rb01b_red',      label:"97 RB-01b Red",         v0:0x17 },
  { key:'rb01b_blue',     label:"97 RB-01b Blue",        v0:0x1B },
  { key:'rb01b_green',    label:"97 RB-01b Green",       v0:0x1F },
  { key:'dc_mod_od',      label:"DC Modern OD",          v0:0x23 },
  { key:'dc_mod_sod',     label:"DC Modern SOD",         v0:0x27 },
  { key:'dc_mod800',      label:"DC Modern 800",         v0:0x2B },
  { key:'dc_mod_clean',   label:"DC Modern Clean",       v0:0x2F },
  { key:'dc_vint_crunch', label:"DC Vintage Crunch",     v0:0x33 },
  { key:'dc_vint_od',     label:"DC Vintage OD",         v0:0x37 },
  { key:'dc_vint_clean',  label:"DC Vintage Clean",      v0:0x3B },
  { key:'dc_bass',        label:"DC Bass",               v0:0x3F },
];
const AMP_SELECT_BY_KEY = {};
const AMP_SELECT_BY_V0  = {};
AMP_SELECT_LIST.forEach(a => { AMP_SELECT_BY_KEY[a.key] = a; AMP_SELECT_BY_V0[a.v0] = a; });

// Amp tracking for gate controls
function decode7bit(enc) {
  const len = enc.length;
  const res = new Uint8Array(len);
  let begin = 0, shift = 1, i = 0;
  for (; begin + i < len - 1; i++) {
    res[i] = (((enc[begin + i] & 0xFF) << shift) & 0xFF)
           + (((enc[begin + i + 1] & 0xFF) >>> (7 - shift)) & 0xFF);
    res[i] &= 0xFF;
    shift++;
    if (shift === 8) { shift = 1; begin++; }
  }
  res[i] = ((enc[len - 1] & 0xFF) << shift) & 0xFF;
  // Correct output length: each group of 8 encoded bytes -> 7 decoded bytes.
  // Partial group of r encoded bytes -> r-1 decoded bytes. The post-loop
  // final byte is spurious when the last group is partial (len%8 != 0).
  const outLen = (len % 8 === 0) ? (len / 8) * 7
                                  : Math.floor(len / 8) * 7 + (len % 8) - 1;
  return res.slice(0, outLen);
}

// ── Inverse of decode7bit — confirmed 7/11/2026, not just derived on
// paper. Tested against a real captured Avid Editor write (loading "64
// Lux" into memory): encoding the same decoded body this function's
// counterpart produces reproduced Avid's actual wire bytes EXACTLY,
// and a full round-trip (encode then decode) reproduces the original
// body exactly too. The version documented in the old research notes
// (from ElevenHack's own source) does NOT correctly invert our
// decode7bit — don't reach for that one, this is the verified one. ──
function encode7bit(data) {
  const out = [];
  const n = data.length;
  for (let i = 0; i < n; i += 7) {
    const chunkLen = Math.min(7, n - i);
    const d = [0,0,0,0,0,0,0];
    for (let k = 0; k < chunkLen; k++) d[k] = data[i + k] & 0xFF;
    const encoded = [
      (d[0] >>> 1) & 0x7F,
      ((d[0] << 6) | (d[1] >>> 2)) & 0x7F,
      ((d[1] << 5) | (d[2] >>> 3)) & 0x7F,
      ((d[2] << 4) | (d[3] >>> 4)) & 0x7F,
      ((d[3] << 3) | (d[4] >>> 5)) & 0x7F,
      ((d[4] << 2) | (d[5] >>> 6)) & 0x7F,
      ((d[5] << 1) | (d[6] >>> 7)) & 0x7F,
      d[6] & 0x7F,
    ];
    // Full group of 7 bytes -> 8 encoded bytes.
    // Partial group of r bytes -> r+1 encoded bytes.
    // Confirmed 7/12/2026: previous version always output 8 bytes for
    // partial groups, producing 5 extra bytes for a 968-byte body
    // (968%7=2 remainder -> was 8, should be 3). Hardware rejected the
    // load with "DSP1/2> DIALOG(Bad Patch Data)" when encoding was wrong.
    const outCount = chunkLen === 7 ? 8 : chunkLen + 1;
    for (let k = 0; k < outCount; k++) out.push(encoded[k]);
  }
  return out;
}

// ── Extract a patch name from a decoded SEND_PATCH body — bytes 8-35
// are 7 "quadlets" (4-byte groups, each reversed — same quadToKey trick
// as everywhere else in this file format). Used when loading a TFX from
// disk, to get the real patch name to send via the CMD 0x05 name write,
// same as Avid does (confirmed in the load-from-disk capture). ──
function extractNameFromBody(body) {
  try {
    let name = '';
    for (let q = 0; q < 7; q++) {
      const off = 8 + q * 4;
      if (off + 3 >= body.length) break;
      name += String.fromCharCode(body[off+3], body[off+2], body[off+1], body[off]);
    }
    // Trim at the first null byte and any trailing junk
    const nullIdx = name.indexOf('\u0000');
    if (nullIdx >= 0) name = name.slice(0, nullIdx);
    return name.trim();
  } catch(e) { return ''; }
}

// ── Decode amp model from an already-decoded bulk body ──
// (body = decode7bit(payload) — done once by the caller and shared with
// decodeGateValues, since both read from the same decoded buffer)
// Returns { key, markerPos } — markerPos is the body index where the
// raw '6dls' bytes start, exposed so decodeGateValues can anchor off it
// (gate's offset moves with the amp's section — see below — but its
// DISTANCE from this marker is constant regardless of chain layout).
function decodeAmpKey(body) {
  try {
    // Scan every byte for '6dls' key (0x36 0x64 0x6C 0x73) — amp's own
    // per-effect section position varies with chain layout, so this has
    // to be a search, not a fixed offset.
    for (let j = 0; j < body.length - 7; j++) {
      if (body[j]===0x36 && body[j+1]===0x64 && body[j+2]===0x6C && body[j+3]===0x73) {
        let ampId = (body[j+4]) | (body[j+5]<<8) | (body[j+6]<<16) | (body[j+7]<<24);
        ampId = ampId >>> 0;
        appLog('decodeAmpKey: 6dls found at j=' + j + ' ampId=' + ampId + ' key=' + (AMP_ID_TO_KEY[ampId]||'unknown'));
        return { key: AMP_ID_TO_KEY[ampId] || null, markerPos: j };
      }
    }
    appLog('decodeAmpKey: 6dls key NOT found in body');
  } catch(e) { appLog('decodeAmpKey error: ' + e.message); }
  return null;
}

// ── Decode Gate Threshold/Release from the same decoded bulk body ──
// Originally used fixed body offsets (0x250/0x258), confirmed by
// controlled min/mid/max captures on 7/8/2026 — but a follow-up test
// that day (moving the amp to a different chain position, everything
// else unchanged) proved those offsets move with the amp's whole
// section, not fixed in the file. What IS fixed: the DISTANCE from the
// 'sld6' amp marker back to sld3 (-88 bytes) and sld4 (-80 bytes) —
// confirmed identical across two captures with the amp in very
// different chain positions. So this now anchors off wherever
// decodeAmpKey actually found the amp, the same way decodeAmpKey
// already had to search rather than trust a fixed offset for the amp
// itself. Both are still a signed 32-bit value spanning the FULL int32
// range linearly: 0x80000000 (INT32_MIN) = 0%, 0x7FFFFFFF (INT32_MAX) = 100%.
const GATE_THRESH_OFFSET_FROM_AMP  = -88;
const GATE_RELEASE_OFFSET_FROM_AMP = -80;

// Amp Out ('sld2') — confirmed 7/10/2026 via three controlled captures
// at -60dB, 0dB, and +18dB (the full documented range), same patch,
// nothing else touched. Decoded values matched the target dB EXACTLY —
// not approximately — confirming both the offset and the encoding in
// one pass. Lives in the amp's own per-effect section (same neighborhood
// as Gate and the amp model, NOT the global TOC section) — matches what
// Charlie described about Amp Out sitting directly in the signal chain
// between Amp and Cab, unlike Rig Volume which is patch-independent.
// Same anchor-to-amp-marker approach as Gate, for the same reason:
// chain-position-dependent, not a fixed file offset.
const AMP_OUT_OFFSET_FROM_AMP = -96;

// "headerCode" per TfxParser.java (parseMsgHeader) — read as a quadlet
// right after version, stored via rig.setSignature(). Not a mystery field
// after all, despite how much time it cost us tonight: it stayed
// identical in our one no-change control capture and moved every time
// real content changed in every other test, which is exactly what we
// want out of a change-detection fingerprint for the bank scan below.
const SIGNATURE_BODY_OFFSET = 0x04;

function readSignedLE32(body, off) {
  if (off < 0 || body.length < off + 4) return null;
  const u = (body[off] | (body[off+1]<<8) | (body[off+2]<<16) | (body[off+3]<<24)) >>> 0;
  return u > 0x7FFFFFFF ? u - 0x100000000 : u;
}

// Raw signed int32 (full range) -> 0-127 v-scale (same scale CMD 0x11 uses)
function gateRawToV127(signed) {
  const pct = (signed - (-2147483648)) / (2147483647 - (-2147483648));
  return Math.round(Math.max(0, Math.min(1, pct)) * 127);
}

// ampMarkerPos = the markerPos returned by decodeAmpKey for this same
// body — required now, since gate has no fixed offset of its own.
function decodeGateValues(body, ampMarkerPos) {
  try {
    if (ampMarkerPos == null) { appLog('decodeGateValues: no amp marker position given — cannot locate gate'); return null; }
    const threshValueOffset  = ampMarkerPos + GATE_THRESH_OFFSET_FROM_AMP  + 4;
    const releaseValueOffset = ampMarkerPos + GATE_RELEASE_OFFSET_FROM_AMP + 4;
    const threshSigned  = readSignedLE32(body, threshValueOffset);
    const releaseSigned = readSignedLE32(body, releaseValueOffset);
    if (threshSigned === null || releaseSigned === null) return null;
    const threshV  = gateRawToV127(threshSigned);
    const releaseV = gateRawToV127(releaseSigned);
    appLog('decodeGateValues: threshRaw=' + threshSigned + ' (v=' + threshV + ')  releaseRaw=' + releaseSigned + ' (v=' + releaseV + ')');
    return { threshV: threshV, releaseV: releaseV };
  } catch(e) { appLog('decodeGateValues error: ' + e.message); return null; }
}

// ampMarkerPos = the markerPos returned by decodeAmpKey for this same
// body — Amp Out has no fixed offset of its own, same reason as Gate.
function decodeAmpOutValue(body, ampMarkerPos) {
  try {
    if (ampMarkerPos == null) { appLog('decodeAmpOutValue: no amp marker position given — cannot locate Amp Out'); return null; }
    const valueOffset = ampMarkerPos + AMP_OUT_OFFSET_FROM_AMP + 4;
    const signed = readSignedLE32(body, valueOffset);
    if (signed === null) return null;
    const v = gateRawToV127(signed);
    appLog('decodeAmpOutValue: raw=' + signed + ' (v=' + v + ')');
    return v;
  } catch(e) { appLog('decodeAmpOutValue error: ' + e.message); return null; }
}

// ── Decode To Amp 1 & 2 volume from TFX body ──
// Offsets confirmed 7/17/2026 by diffing Avid-exported TFX files
// (raw 1016-byte body — Avid exports are NOT 7-bit encoded):
//   Amp 1 volume: body[52–55] — signed LE32, standard gateRawToV127
//   Amp 2 volume: body[60–63] — signed LE32, standard gateRawToV127
// MUTE = INT32_MIN (0x80000000) -> v=0; MAX = INT32_MAX (0x7FFFFFFF) -> v=127.
// Returns {amp1V, amp2V} (0-127 each) or null on error.
const TOAMP1_VOL_OFFSET = 52;
const TOAMP2_VOL_OFFSET = 60;
function decodeToAmpVolumes(body) {
  try {
    const s1 = readSignedLE32(body, TOAMP1_VOL_OFFSET);
    const s2 = readSignedLE32(body, TOAMP2_VOL_OFFSET);
    if (s1 === null || s2 === null) return null;
    const amp1V = gateRawToV127(s1);
    const amp2V = gateRawToV127(s2);
    appLog('decodeToAmpVolumes: amp1Raw=' + s1 + ' (v=' + amp1V + ')  amp2Raw=' + s2 + ' (v=' + amp2V + ')');
    return { amp1V, amp2V };
  } catch(e) { appLog('decodeToAmpVolumes error: ' + e.message); return null; }
}

// ── Decode tone knob values from a decoded bulk body ──
// Searches for each sldX key by name starting after the 6dls marker.
// Returns an array parallel to AMP_TONE_PARAMS[ampKey].knobs (knob-type
// entries only), each entry being a 0-127 value, or null if not found.
function decodeToneKnobValues(body, ampMarkerPos, ampKey) {
  try {
    if (ampMarkerPos == null || !ampKey) return null;
    const ap = AMP_TONE_PARAMS[ampKey];
    if (!ap || !ap.knobs) return null;
    const knobs = ap.knobs.filter(k => k.type === 'knob' || k.type === 'toggle');
    if (!knobs.length) return null;

    // Key stored reversed in body: 'sld7' -> [0x37,0x64,0x6C,0x73]
    // Use tfxKey directly from table — NOT derived from paramLo (mapping breaks above 0x0F)
    function keyBytes(s) {
      return [s.charCodeAt(3), s.charCodeAt(2), s.charCodeAt(1), s.charCodeAt(0)];
    }

    const results = [];
    for (const knob of knobs) {
      if (!knob.tfxKey || knob.tfxKey.length !== 4) {
        appLog('decodeToneKnob: ' + knob.label + ' — no valid tfxKey, skipping');
        results.push(null);
        continue;
      }
      const kb = keyBytes(knob.tfxKey);
      let found = null;
      // Search entire body — tone keys live BEFORE 6dls in the amp section
      for (let i = 0; i < body.length - 7; i++) {
        if (body[i]===kb[0] && body[i+1]===kb[1] && body[i+2]===kb[2] && body[i+3]===kb[3]) {
          const signed = readSignedLE32(body, i + 4);
          if (signed !== null) {
            // Toggles store 0=OFF, 1=ON as raw integers — NOT full int32 range
            // Continuous knobs use full int32 range scaled to 0-127
            found = (knob.type === 'toggle') ? (signed !== 0 ? 127 : 0) : gateRawToV127(signed);
            appLog('decodeToneKnob: ' + knob.label + ' (' + knob.tfxKey + ') @ body+' + i + ' raw=' + signed + ' v=' + found);
          }
          break;
        }
      }
      if (found === null) appLog('decodeToneKnob: ' + knob.label + ' key ' + knob.tfxKey + ' not found');
      results.push(found);
    }
    return results;
  } catch(e) { appLog('decodeToneKnobValues error: ' + e.message); return null; }
}

// ════════════════════════════════════════════════════════════════════
// CAB / MIC LOOKUP TABLES (confirmed 7/16/2026 via TFX diff + Wireshark)
// ════════════════════════════════════════════════════════════════════

// Cab type raw int32 value (from sldK in TFX body) -> display name.
// Order matches the hardware dropdown (confirmed via TFX captures).
const CAB_TYPE_LIST = [
  { raw: 1246976077, name: '1x8 Custom'          },
  { raw: 0,          name: '1x12 Black Panel Lux' },
  { raw: 1,          name: '1x12 Tweed Lux'       },
  { raw: 1127298382, name: '1x15 Open Back'        },
  { raw: 2,          name: '2x12 AC Blue'          },
  { raw: 3,          name: '2x12 Black Panel Duo'  },
  { raw: 846738224,  name: '2x12 B30'              },
  { raw: 1247902330, name: '2x12 Silver Cone'      },
  { raw: 4,          name: '4x10 Tweed Bass'       },
  { raw: 876827731,  name: '4x10 Black SR'         },
  { raw: 5,          name: '4x12 Classic 30'       },
  { raw: 880293429,  name: '4x12 65W'              },
  { raw: 6,          name: '4x12 Green 25W'        },
  { raw: 880292400,  name: '4x12 Green 20W'        },
  { raw: 944985684,  name: '8x10 Blue Line'        },
];

// Build reverse lookup: raw -> index (0-14)
const CAB_RAW_TO_INDEX = {};
CAB_TYPE_LIST.forEach(function(entry, idx) { CAB_RAW_TO_INDEX[entry.raw] = idx; });

// Mic type index (0-7) -> display name. Confirmed 0=Dyn7, 7=Ribbon121 via TFX.
const MIC_TYPE_NAMES = [
  'Dynamic 7', 'Dynamic 57', 'Dynamic 409', 'Dynamic 421',
  'Condenser 67', 'Condenser 87', 'Condenser 414', 'Ribbon 121',
];

// ── Decode cab/mic/axis/breakup from TFX body on patch load ──
// Returns { cabIndex, micIndex, axisOn, breakupV } or null on failure.
// cabIndex = 0-14, micIndex = 0-7, axisOn = bool, breakupV = 0-127.
function decodeCabMicValues(body) {
  try {
    function keyBytes(s) {
      return [s.charCodeAt(3), s.charCodeAt(2), s.charCodeAt(1), s.charCodeAt(0)];
    }
    function findKey(kb) {
      for (let i = 0; i < body.length - 7; i++) {
        if (body[i]===kb[0] && body[i+1]===kb[1] && body[i+2]===kb[2] && body[i+3]===kb[3]) {
          return readSignedLE32(body, i + 4);
        }
      }
      return null;
    }

    const cabRaw  = findKey(keyBytes('sldK'));
    const micRaw  = findKey(keyBytes('sldL'));
    const axisRaw = findKey(keyBytes('sldM'));
    const brkRaw  = findKey(keyBytes('sldN'));
    const sldJRaw = findKey(keyBytes('sldJ')); // Cab bypass: 0=active, 1=bypassed

    const cabIndex   = (cabRaw !== null && CAB_RAW_TO_INDEX[cabRaw] !== undefined)
                         ? CAB_RAW_TO_INDEX[cabRaw] : null;
    const micIndex   = micRaw !== null ? micRaw : null;
    const axisOn     = axisRaw !== null ? (axisRaw !== 0) : null;
    const breakupV   = brkRaw  !== null ? gateRawToV127(brkRaw) : null;
    const cabActive  = sldJRaw !== null ? (sldJRaw === 0) : null;
    // Amp bypass has no TFX key. Previously defaulted to true here, which made
    // a bypassed amp display as active until something happened to correct it.
    // Now returned as null (= unknown) and resolved by querying the hardware
    // once the chain map arrives — see requestAllBypass() in transport.js.
    const ampActive  = null;

    appLog('decodeCabMicValues: cabRaw=' + cabRaw + '(idx=' + cabIndex + ')'
      + ' mic=' + micIndex + ' axis=' + axisOn + ' breakup=' + breakupV
      + ' ampActive=' + ampActive + ' cabActive=' + cabActive);
    return { cabIndex: cabIndex, micIndex: micIndex, axisOn: axisOn, breakupV: breakupV,
             ampActive: ampActive, cabActive: cabActive };
  } catch(e) { appLog('decodeCabMicValues error: ' + e.message); return null; }
}

// ── Decode Mono/Stereo from TFX body ──
// Returns true=Mono, false=Stereo, null=not found.
function decodeMonoStereo(body) {
  try {
    // Key 'RMno' stored reversed: ['o','n','M','R'] = [0x6F,0x6E,0x4D,0x52]
    const kb = [0x6F, 0x6E, 0x4D, 0x52];
    for (let i = 0; i < body.length - 7; i++) {
      if (body[i]===kb[0] && body[i+1]===kb[1] && body[i+2]===kb[2] && body[i+3]===kb[3]) {
        const val = readSignedLE32(body, i + 4);
        appLog('decodeMonoStereo: raw=' + val + ' -> ' + (val !== 0 ? 'MONO' : 'STEREO'));
        return val !== 0;  // 1=Mono, 0=Stereo
      }
    }
    appLog('decodeMonoStereo: RMno key not found');
    return null;
  } catch(e) { appLog('decodeMonoStereo error: ' + e.message); return null; }
}

// ── Push decoded Gate Threshold/Release into the knob UI ──

// ════════════════════════════════════════════════════════════════════
// DIST EFFECT MODELS — paramLo numbers confirmed 7/21/2026 via Wireshark
// (Distorion_Captures_1.pcapng, Black Op sequential capture + 4 other patches)
//
// paramLos: all wire paramLos for this model — used by requestDistParams.
// rows: 2-D visual layout [ row [ {label, lo} | null ] ]
//   null = invisible spacer holding column alignment.
//   Labels match Avid editor names exactly (confirmed 7/21/2026).
// Encoding: standard (v127+64)%128, same as amp tone knobs.
// paramLo 0x01 = bypass (all blocks — handled globally, not listed here).
// ════════════════════════════════════════════════════════════════════
const DIST_MODELS = [
  // ── 1 row · 3 knobs
  { mid: 0x17, name: 'Tri-Knob Fuzz',
    paramLos: [0x02, 0x03, 0x04],
    rows: [
      [ {label:'Volume',  lo:0x02},
        {label:'Sustain', lo:0x03},
        {label:'Tone',    lo:0x04} ]
    ]
  },
  // ── 1 row · 3 knobs
  { mid: 0x18, name: 'Black Op Distortion',
    paramLos: [0x02, 0x03, 0x04],
    rows: [
      [ {label:'Distortion', lo:0x02},
        {label:'Cut',        lo:0x03},
        {label:'Volume',     lo:0x04} ]
    ]
  },
  // ── 2 rows · triangle: Overdrive & Level top (cols 0 & 2), Tone centred below (col 1)
  { mid: 0x19, name: 'Green JRC Overdrive',
    paramLos: [0x02, 0x03, 0x04],
    rows: [
      [ {label:'Overdrive', lo:0x02}, null,                  {label:'Level', lo:0x04} ],
      [ null,               {label:'Tone', lo:0x03}, null ]
    ]
  },
  // ── 2 rows · 2×2 grid: Gain/Volume top, Bass/Treble bottom
  { mid: 0x1A, name: 'White Boost',
    paramLos: [0x02, 0x03, 0x04, 0x05],
    rows: [
      [ {label:'Gain',   lo:0x02}, {label:'Volume', lo:0x05} ],
      [ {label:'Bass',   lo:0x04}, {label:'Treble', lo:0x03} ]
    ]
  },
  // ── 2 rows · Level/Treble/Bass top, Distortion centred below (col 1)
  { mid: 0x1B, name: 'DC Distortion',
    paramLos: [0x02, 0x03, 0x04, 0x05],
    rows: [
      [ {label:'Level',      lo:0x05}, {label:'Treble',      lo:0x03}, {label:'Bass', lo:0x04} ],
      [ null,                {label:'Distortion', lo:0x02}, null ]
    ]
  },
];
const DIST_MODEL_BY_MID = {};
DIST_MODELS.forEach(function(m) { DIST_MODEL_BY_MID[m.mid] = m; });

// ════════════════════════════════════════════════════════════════════
// REVERB EFFECT MODELS — paramLo numbers confirmed 7/22/2026 via Wireshark
// (Black_Panel_Reverb_Capture_1 + Eleven_SR_Reverb_Capture_1 + dropdown
// picker capture). Knob-turn order matched to capture notes; the three
// knobs shared by both models land on identical paramLo, cross-confirming
// the map, and it matches the Tech Ref Sec 23 parameter name order.
//
// TWO MODELS live in the REVERB slot:
//   Blackpanel Spring Reverb — mids 0x26 (mono) / 0x27 (stereo)   3 knobs
//   Eleven SR                — mids 0x28 (mono) / 0x29 / 0x2A     Type + 4 knobs
// Model switch = CMD 0x21 (same mechanism as DIST). We SEND the mono base
// mid; firmware re-instantiates and may pick the stereo variant by chain
// context. REVERB_MODEL_BY_MID maps EVERY variant to its model so readback
// resolves correctly regardless of which variant the firmware chose.
//
// paramLo: 0x02 Decay · 0x03 Tone · 0x04 Mix · 0x05 Type · 0x06 Pre-Delay
// paramLo 0x01 = bypass (all blocks — handled globally, not listed here).
// Encoding: standard (v127+64)%128, same as every other knob.
//
// TYPE (Eleven SR only, paramLo 0x05) is a NORMAL knob whose 0-127 range is
// quantised into 25 named zones. The dropdown just snaps the knob to a
// zone centre. v0 values below are the exact wire values captured from the
// hardware dropdown; v127 is the decoded knob position (v0-64 mod 128).
// ════════════════════════════════════════════════════════════════════
const REVERB_TYPE_LIST = [
  { name: 'Echo Room',       v0: 0x40 },
  { name: 'Studio',          v0: 0x45 },
  { name: 'Small Room',      v0: 0x4A },
  { name: 'Jazz Club',       v0: 0x50 },
  { name: 'Small Club',      v0: 0x55 },
  { name: 'Garage',          v0: 0x5A },
  { name: 'Medium Room',     v0: 0x60 },
  { name: 'Tiled Room',      v0: 0x65 },
  { name: 'Wood Room',       v0: 0x6A },
  { name: 'Small Theater',   v0: 0x70 },
  { name: 'Medium Theater',  v0: 0x75 },
  { name: 'Large Theater',   v0: 0x7A },
  { name: 'Rich Hall',       v0: 0x00 },
  { name: 'Concert Hall',    v0: 0x05 },
  { name: 'Bright Hall',     v0: 0x0A },
  { name: 'Church',          v0: 0x0F },
  { name: 'Cathedral',       v0: 0x15 },
  { name: 'Arena',           v0: 0x1A },
  { name: 'Small Plate',     v0: 0x1F },
  { name: 'Medium Plate',    v0: 0x25 },
  { name: 'Large Plate',     v0: 0x2A },
  { name: 'Canyon',          v0: 0x2F },
  { name: 'Supa Long',       v0: 0x35 },
  { name: 'Early Reflect 1', v0: 0x3A },
  { name: 'Early Reflect 2', v0: 0x3F },
];
// Decoded knob position (0-127) per type — v127 = (v0 - 64) mod 128.
REVERB_TYPE_LIST.forEach(function(t) { t.v127 = ((t.v0 - 64) + 128) % 128; });

// Map an incoming knob value (0-127) to the nearest Type index, so the
// dropdown tracks a hardware knob turn as well as a dropdown pick.
function reverbTypeIndexFromV127(v127) {
  var best = 0, bestD = 999;
  for (var i = 0; i < REVERB_TYPE_LIST.length; i++) {
    var d = Math.abs(REVERB_TYPE_LIST[i].v127 - v127);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

const REVERB_MODELS = [
  // ── Blackpanel Spring Reverb — 1 row · 3 knobs, no Type control
  { mid: 0x26, mids: [0x26, 0x27], name: 'Blackpanel Spring Reverb',
    paramLos: [0x02, 0x03, 0x04],
    typeControl: null,
    rows: [
      [ {label:'Decay', lo:0x02},
        {label:'Tone',  lo:0x03},
        {label:'Mix',   lo:0x04} ]
    ]
  },
  // ── Eleven SR — Type control (dropdown + knob) then 4 knobs.
  // Panel order matches the hardware: TYPE · DECAY · PRE-DELAY · TONE · MIX.
  { mid: 0x28, mids: [0x28, 0x29, 0x2A], name: 'Eleven SR',
    paramLos: [0x02, 0x03, 0x04, 0x05, 0x06],
    typeControl: { lo: 0x05, label: 'Type', list: REVERB_TYPE_LIST },
    rows: [
      [ {label:'Decay',     lo:0x02},
        {label:'Pre-Delay', lo:0x06, unit:'ms', max:200},
        {label:'Tone',      lo:0x03},
        {label:'Mix',       lo:0x04} ]
    ]
  },
];
const REVERB_MODEL_BY_MID = {};
REVERB_MODELS.forEach(function(m) {
  m.mids.forEach(function(mid) { REVERB_MODEL_BY_MID[mid] = m; });
});

// ════════════════════════════════════════════════════════════════════
// WAH MODELS — Shine Wah (0x23) and Black Wah (0x24).
// paramLos confirmed by Wireshark capture (2026-07-29):
//   0x02 = Position — continuous pedal sweep, full range. Both models
//          share the same single paramLo.
//   0x03 = internal model flag (0x40 on switch-to-Black, 0x3F on
//          switch-to-Shine); broadcast automatically on model change,
//          not a user-visible knob. Listed in paramLos for routing
//          so it doesn't fall through to the mismatch handler.
// ════════════════════════════════════════════════════════════════════
const WAH_MODELS = [
  { mid: 0x23, mids: [0x23], name: 'Shine Wah',
    paramLos: [0x02, 0x03],
    rows: [
      [ {label:'Position', lo:0x02} ]
    ]
  },
  { mid: 0x24, mids: [0x24], name: 'Black Wah',
    paramLos: [0x02, 0x03],
    rows: [
      [ {label:'Position', lo:0x02} ]
    ]
  },
];
const WAH_MODEL_BY_MID = {};
WAH_MODELS.forEach(function(m) {
  m.mids.forEach(function(mid) { WAH_MODEL_BY_MID[mid] = m; });
});

// ════════════════════════════════════════════════════════════════════
// VOL MODELS — Volume Pedal. Firmware picks mono (0x2B) or stereo
// (0x2C) by chain context; we expose one user-facing model and map
// both mids to it.
// paramLos confirmed by Wireshark capture (2026-07-29):
//   0x02 = Volume (Position) — continuous knob, full range
//   0x03 = Min Vol — continuous knob, full range
//   0x04 = Taper — binary toggle: v0=0x40 → Linear, v0=0x3F → Log
// ════════════════════════════════════════════════════════════════════
const VOL_MODELS = [
  { mid: 0x2B, mids: [0x2B, 0x2C], name: 'Volume Pedal',
    paramLos: [0x02, 0x03, 0x04],
    rows: [
      [ {label:'Volume',  lo:0x02},
        {label:'Min Vol', lo:0x03},
        {label:'Taper',   lo:0x04, toggle:true, options:['Linear','Log']} ]
    ]
  },
];
const VOL_MODEL_BY_MID = {};
VOL_MODELS.forEach(function(m) {
  m.mids.forEach(function(mid) { VOL_MODEL_BY_MID[mid] = m; });
});

// ════════════════════════════════════════════════════════════════════
// FX1 MODELS — FX1 is a GENERIC HOST SLOT (Tech Ref chain-map section):
// it can carry models from several other effect families, identified only
// by slot ID (0x08), never by mid range. FX2 (slot 0x09) hosts the same
// model set. The 10 mids below are confirmed via the dropdown capture
// (2026-07-30, FX1_Dropdown_Capture.pcapng) — only the paramLo layout is
// still being captured model by model (Session Log), so most entries here
// are STUBS (name/mid only, captured:false) until their own capture lands.
//
// C1 CHORUS/VIBRATO (mid 0x01) — fully captured 2026-07-30 (three captures:
// paramLo ID, toggle values, full Sync x Chorus/Rate matrix — Session Log).
//   paramLo 0x02 Chorus · 0x03 Depth (independent wet/dry mix, not linked to
//   Sync in testing) · 0x04 Rate · 0x05 Toggle (Chorus/Vibrato) · 0x06 Sync.
// TOGGLE (paramLo 0x05): v0 0x40 -> val 0 -> Chorus; v0 0x3F -> val 127 ->
//   Vibrato. Same two-state shape as VOL's Taper toggle.
// SYNC (paramLo 0x06): confirmed to reuse the SAME 14-zone quantization as
//   the amp Tremolo Sync (paramLo 0x12) — OFF + 13 divisions across 0-127,
//   see SYNC_DIVISIONS / syncIndexFromV127 / syncV127FromIndex below. No
//   separate zone table needed for this model. Engaging Sync overwrites
//   the live Chorus AND Rate values (confirmed matrix, Session Log
//   2026-07-30) — this is expected hardware behaviour, not a bug, and the
//   panel just displays whatever the hardware broadcasts back.
// Encoding: standard (v127+64)%128, same as every other knob.
// ════════════════════════════════════════════════════════════════════
// MID ASSIGNMENT CORRECTED 2026-07-30 (live hardware log): the dropdown
// capture's chain-map pairs carried two candidate values per step (a query
// and a settled broadcast) that disagreed by one position, and the first
// build picked the wrong one — every mid below was shifted one slot from
// the truth. Ground truth from Charlie's live log (C1-loaded patch, no
// dropdown touched): openFx1Panel reported mid=0x03 for C1 Chorus/Vibrato,
// not 0x01. Re-anchoring on that single confirmed point makes the rest of
// the capture self-consistent (the "back to start" pair's value now matches
// the baseline exactly, which it had NOT under the old assignment — see
// Session Log). Do not re-derive from the raw capture again; this is the
// corrected, hardware-confirmed table.
// MONO/STEREO MID VARIANTS (found 2026-07-30): like REVERB (0x26 mono /
// 0x27 stereo) and VOL (0x2B mono / 0x2C stereo), a model in a generic host
// slot can report a DIFFERENT mid depending on the chain's stereo/mono
// state — same model, different wire id. C1 Chorus/Vibrato confirmed:
// mono=0x01, stereo=0x03 (Charlie's log toggling Stereo<->Mono with the
// panel open — before this fix, toggling to MONO reported mid=0x01, which
// wasn't in this table at all, so the panel fell through to "Unknown
// model"). `mid` is the PRIMARY/send value (mono, matching the REVERB/VOL
// convention); `mids` lists every variant so FX1_MODEL_BY_MID resolves
// either one back to this entry.
// A THIRD MID (0x02) is also listed for C1 in Tech Ref Sec 23's CMD 0x20
// enumeration ("0x01-03 0x031 C1 Chorus/Vibrato") but has never been
// directly observed as a live chain-block instantiation (unlike 0x01/0x03,
// both now confirmed live) — included here on the strength of that
// enumeration alone. Harmless either way: it only affects lookup
// resolution, never what gets sent.
// PER CHARLIE (2026-07-30): of the 9 stub models below, all are "stereo by
// nature" EXCEPT Gray Compressor, which is mono-only — so C1 needing a
// dual mid is likely the exception here, not the rule. Still test each one
// for a mono/stereo mismatch when it's actually captured (don't assume),
// but don't expect to spend much time on it.
// FX2 (SLOT_FX2) HOSTS THE SAME MODEL FAMILY AS FX1 — per Charlie, whatever
// gets captured here is expected to apply directly to FX2 too (same mids,
// same paramLos), so an FX2 panel build should reuse FX1_MODELS rather than
// re-capturing from scratch. Some models here may ALSO turn up in MOD's
// roster — check for overlap before capturing a MOD model fresh.
const FX1_MODELS = [
  { mid: 0x01, mids: [0x01, 0x02, 0x03], name: 'C1 Chorus/Vibrato', captured: true,
    paramLos: [0x02, 0x03, 0x04, 0x05, 0x06],
    rows: [
      // R7 (Tech Ref Sec 20A) — BOTH Chorus and Rate are Sync-driven on this
      // model (confirmed by Charlie 2026-07-31: turning Chorus while Sync is
      // engaged did not clear Sync, same gap as Rate) — unlike the amp,
      // where only Speed is. Matches the earlier "Sync x Chorus/Rate matrix"
      // capture note above (engaging Sync overwrites BOTH live values, not
      // just Rate). The syncDriven flag is what fx-panels.js's FX1
      // drag/dblclick handlers check to apply the interlock generically —
      // any number of syncDriven cells per model works, not just one.
      [ {label:'Chorus', lo:0x02, syncDriven:true},
        {label:'Rate',   lo:0x04, syncDriven:true},
        {label:'Depth',  lo:0x03},
        {label:'Sync',   lo:0x06, sync:true},
        {label:'Mode',   lo:0x05, toggle:true, options:['Chorus','Vibrato']} ]
    ]
  },
  // ── DYN3 COMPRESSOR — paramLo confirmed 2026-07-30 (six knobs, each swept
  // low-high-low; all six are standard continuous (v127+64)%128 knobs, same
  // step size/shape as every other knob in the app — 0x02 Threshold, 0x03
  // Attack, 0x04 Release, 0x05 Ratio, 0x06 Knee, 0x07 Gain).
  // DISPLAY FORMULAS — Threshold/Knee/Gain are linear dB over Charlie's
  // stated ranges (same shape as Gate Threshold/Amp Out elsewhere); Attack/
  // Release reuse the SAME log-scale shape already confirmed for Gate
  // Release (valGateRelease, ui.js), just with this control's own min/max.
  // RATIO — CONFIRMED 2026-07-30 via a 19-point mouse-wheel sweep on the
  // Avid editor (1:1 to 100:1), read against Wireshark. Pure exponential,
  // no piecewise behaviour despite Charlie's suspicion it might have one:
  //   ratio = 100 ^ (v127/127)          (v127=0 -> 1:1, v127=127 -> 100:1)
  // Fits all 19 captured points within ~1.5 at the very top of the range
  // and under 0.3 almost everywhere else — well inside the rounding noise
  // of reading a wheel-click display by eye. Session Log has the raw points.
  // MONO/STEREO MID PAIR — FOUND MISSING 2026-07-31, same audit that caught
  // Graphic EQ's identical gap (see that entry's comment for the trace that
  // found this bug class). MODEL_NAMES/MODEL_OUT_STEREO above list mono
  // 0x15 and stereo 0x16 as "Dyn3 Compressor", but only 0x16 was registered
  // when this model was captured — a patch with Dyn3 in mono would have hit
  // the exact same "mid unknown" failure as Graphic EQ did.
  { mid: 0x16, mids: [0x15, 0x16], name: 'Dyn3 Compressor', captured: true,
    paramLos: [0x02, 0x03, 0x04, 0x05, 0x06, 0x07],
    rows: [
      [ {label:'Threshold', lo:0x02, display: function(v) { return (-60 + (v/127)*60).toFixed(1) + ' dB'; }},
        {label:'Attack',    lo:0x03, display: function(v) {
            var ms = 0.01 * Math.pow(30000, v/127);           // 10us .. 300ms
            return ms < 1 ? (ms*1000).toFixed(1) + ' us' : ms.toFixed(1) + ' ms';
          }},
        {label:'Release',   lo:0x04, display: function(v) {
            var ms = 5 * Math.pow(800, v/127);                 // 5ms .. 4.0s
            return ms >= 1000 ? (ms/1000).toFixed(1) + ' s' : ms.toFixed(1) + ' ms';
          }},
        {label:'Ratio',     lo:0x05, display: function(v) { return Math.pow(100, v/127).toFixed(1) + ':1'; }},
        {label:'Knee',      lo:0x06, display: function(v) { return ((v/127)*30).toFixed(1) + ' dB'; }},
        {label:'Gain',      lo:0x07, display: function(v) { return ((v/127)*40).toFixed(1) + ' dB'; }} ]
    ]
  },
  // ── FLANGER — captured 2026-07-31 (Wireshark, Flanger_Knob_Capture.pcapng,
  // Charlie's knob-by-knob sweep low-high-low with pauses between: Pre-Delay,
  // Depth, Rate, Feedback, then the Sync dropdown with Rate readback). All
  // five paramLos share handle 0x10 (a single-block capture, not a chain
  // position claim). paramLo assignment confirmed two ways: (1) sweep order
  // matches the timeline (0x05 moved first, 0x03 second, 0x02 third, 0x04
  // fourth); (2) 0x02 moved IN LOCKSTEP with the 0x06 Sync sweep (same
  // timestamps, both changing together) — independent proof 0x02 is Rate,
  // since only Rate is Sync-driven here, same as C1 Chorus's Rate.
  //   paramLo 0x02 Rate (syncDriven) · 0x03 Depth · 0x04 Feedback ·
  //   0x05 Pre-Delay · 0x06 Sync (reuses the same 14-zone SYNC_DIVISIONS
  //   table as every other FX1 Sync control — confirmed by the 13 v127
  //   breakpoints landing exactly on syncIndexFromV127's zone boundaries).
  // DISPLAY — all four continuous knobs are a plain 0-10 linear scale, one
  // decimal (Charlie: "all knobs have 0-10 scale"); v127*10/127 is exactly
  // valDisplay's existing default formula, confirmed against Charlie's own
  // Rate-under-Sync table (0x02 raw values 64/71/85/98/96/102/110/119/110
  // -> 5.0/5.6/6.7/7.7/7.6/8.0/8.7/9.3/8.7, matching his screengrab to
  // within transcription rounding) — no custom display fn needed, unlike
  // Dyn3's dB/ratio/log-scale knobs.
  // MONO/STEREO MID PAIR — mono=0x07, stereo=0x08 (MODEL_NAMES/
  // MODEL_OUT_STEREO above), same pattern as C1 Chorus (0x01/0x03). Only
  // ever captured against 0x07 in this session; the second mid is listed on
  // the strength of that established pattern, not independently observed —
  // worth a quick Stereo/Mono toggle check like C1 got, per Charlie's
  // 2026-07-30 note that stereo is the expected default for everything but
  // Gray Compressor.
  // PRIMARY MID IS 0x08, NOT 0x07 (fixed 2026-07-31, found by Charlie's live
  // test): the static <option value="8"> in index.html's fx1-model-select
  // predates this capture (it was seeded from the captured:false stub) and
  // every FX1 model's primary `mid` must equal its HTML option value —
  // openFx1Panel does `sel.value = String(openModel.mid)`, and a mismatch
  // (this was 0x07) sets a value with no matching <option>, leaving the
  // dropdown BLANK. That same mismatch made refreshFx1PanelAfterChainMap's
  // "did the model change?" check (parseInt(sel.value) !== refreshModel.mid)
  // fail on every chain map — including a plain mono/stereo toggle — forcing
  // an unwanted full knob-row rebuild + baseline wipe on every toggle. Same
  // root cause, both symptoms.
  { mid: 0x08, mids: [0x07, 0x08], name: 'Flanger', captured: true,
    paramLos: [0x02, 0x03, 0x04, 0x05, 0x06],
    rows: [
      [ {label:'Pre-Delay', lo:0x05},
        {label:'Depth',     lo:0x03},
        {label:'Rate',      lo:0x02, syncDriven:true},
        {label:'Feedback',  lo:0x04},
        {label:'Sync',      lo:0x06, sync:true} ]
    ]
  },
  // ── GRAPHIC EQ — captured 2026-07-31 (Wireshark, EQ_Vertical_Slider_
  // Capture.pcapng, handle 0x2e). First FX1 model with VERTICAL SLIDERS
  // instead of knobs (cell.slider:true — see drawEqSlider/eqSliderDb, ui.js).
  // paramLo assignment confirmed by six isolated 0->127->0 sweeps in the
  // exact left-to-right order Charlie tested the panel, no overlap between
  // any two paramLos' active windows:
  //   0x02 100 Hz (-12..+12) · 0x03 370 Hz (-18..+18) · 0x04 800 Hz
  //   (-18..+18) · 0x05 2 kHz (-18..+18) · 0x06 3.25 kHz (-12..+12) ·
  //   0x07 Output (-20..+6).
  // DISPLAY — dB range per band from Charlie's Avid-panel screenshot.
  // CONFIRMED 2026-07-31 by a second capture (EQ_Capture_Start_at_0_Mark.
  // pcapng) that parked every slider at 0.0 dB, swept to the extreme, then
  // tried to dial each back to exactly 0.0 dB:
  //   SYMMETRIC BANDS (100/370/800/2k/3.25k) — two-slope-anchored-at-v127=64
  //   (same shape as valToAmpVol; 0.0 dB exactly reachable, not interpolated
  //   near it). Charlie's return-to-zero attempts settled tightly on raw
  //   63/64 for every one of these — matches the formula exactly.
  //   OUTPUT (-20..+6) — plain proportional across the FULL 0-127 range
  //   (eqSliderDb/eqDbToV127's `linear` flag), NOT anchored at 64. The
  //   two-slope formula was flatly wrong here: Charlie's return-to-zero
  //   attempts clustered around raw 99-100 and never settled ("I never could
  //   land it back on zero") — 26 dB spread over 127 steps puts exact 0.0 dB
  //   at a non-integer raw ~97.7, so it may be genuinely unreachable at this
  //   resolution. See eqSliderDb's header comment (ui.js) for the full
  //   reasoning.
  // No Sync control on this model — every cell is a plain slider, R7 does
  // not apply here.
  // TICKS — printed calibration numbers per band, matching Avid's own panel
  // scale (drawEqSlider, ui.js draws them on BOTH sides of the groove now —
  // Charlie's 7/31 request, we have the panel width to spare where Avid only
  // has room for one side). 0 is always included so the 0 dB reference line
  // is always visible regardless of range.
  // MONO/STEREO MID PAIR — FOUND MISSING 2026-07-31 (a session log traced a
  // real "requestFx1Params: mid=0x10 unknown" failure to this exact gap; see
  // Session Log for the full trace). Graphic EQ has the same dual-mid pattern
  // as C1 Chorus (0x01/0x03) and Flanger (0x07/0x08) — MODEL_NAMES/
  // MODEL_OUT_STEREO above list BOTH 0x10 (mono) and 0x11 (stereo) as
  // "Graphic EQ" — but the mids[] pairing was left off when this model was
  // captured, unlike Chorus/Flanger where it was handled deliberately. A
  // patch whose FX1 slot held Graphic EQ in mono reported mid 0x10, which
  // wasn't in FX1_MODEL_BY_MID, so the panel opened but couldn't resolve a
  // model — same failure class as the Flanger dropdown bug, just silent
  // instead of visibly blank. Lesson for every future FX1/FX2/MOD/DELAY
  // model: always check MODEL_NAMES for a second mid before assuming a
  // model is single-mid, not just when Charlie happens to report a stereo/
  // mono symptom.
  { mid: 0x11, mids: [0x10, 0x11], name: 'Graphic EQ', captured: true,
    paramLos: [0x02, 0x03, 0x04, 0x05, 0x06, 0x07],
    rows: [
      [ {label:'100 Hz',   lo:0x02, slider:true, min:-12, max:12, ticks:[12,0,-12],
          display: function(v) { return eqSliderDb(v, -12, 12); }},
        {label:'370 Hz',   lo:0x03, slider:true, min:-18, max:18, ticks:[18,12,0,-12,-18],
          display: function(v) { return eqSliderDb(v, -18, 18); }},
        {label:'800 Hz',   lo:0x04, slider:true, min:-18, max:18, ticks:[18,12,0,-12,-18],
          display: function(v) { return eqSliderDb(v, -18, 18); }},
        {label:'2 kHz',    lo:0x05, slider:true, min:-18, max:18, ticks:[18,12,0,-12,-18],
          display: function(v) { return eqSliderDb(v, -18, 18); }},
        {label:'3.25 kHz', lo:0x06, slider:true, min:-12, max:12, ticks:[12,0,-12],
          display: function(v) { return eqSliderDb(v, -12, 12); }},
        {label:'Output',   lo:0x07, slider:true, min:-20, max:6, ticks:[6,0,-20], linear:true,
          display: function(v) { return eqSliderDb(v, -20, 6, true); }} ]
    ]
  },
  // ── GRAY COMPRESSOR — captured 2026-07-31 (Wireshark, Gray_Compressor_
  // Knob_Capture.pcapng, handle 0x32). Simplest FX1 model so far: two plain
  // knobs, no Sync/toggle, default 0-10 linear display (no custom formula —
  // Charlie: "nothing fancy on this one, just the standard issue knob
  // display"). paramLo confirmed by two cleanly isolated 0->127->0 sweeps,
  // no overlap: 0x02 first, 0x03 second — matches Tech Ref Sec 23's captured
  // param order "Sust, Levl" for this model (bridge-sourced label list).
  // MONO ONLY — the one confirmed exception to "every FX1 model is stereo-
  // capable" (Session Log 2026-07-30/31) — single mid, no mids[] pair like
  // C1 Chorus/Flanger needed.
  { mid: 0x14, name: 'Gray Compressor', captured: true,
    paramLos: [0x02, 0x03],
    rows: [
      [ {label:'Sustain', lo:0x02},
        {label:'Level',   lo:0x03} ]
    ]
  },
  // ── MULTICHORUS — captured 2026-07-31 (Wireshark, MultiChorus_Capture.
  // pcapng, handle 0x30). First FX1 model using the GROUPED LAYOUT
  // (fx-panels.js) — Avid boxes this one into an unlabeled Rate/Depth
  // column, a CHORUS box (Low Cut/Width), a MOD box (Pre Delay/Waveform),
  // and an unlabeled Voices/Mix column.
  // paramLo assignment confirmed by nine isolated changes, no overlap
  // between any two paramLos' active windows, in the exact test order
  // Charlie swept the panel (Rate, Low Cut, Width, Depth, Pre Delay, Mix,
  // then Sync, then Voices, then Waveform):
  //   0x02 Rate (syncDriven) · 0x08 Low Cut · 0x09 Width · 0x04 Depth ·
  //   0x06 Pre Delay · 0x05 Mix · 0x03 Sync · 0x07 Voices · 0x0A Waveform.
  // RATE x SYNC — confirmed Sync-driven exactly like C1 Chorus/Flanger's
  // Rate: 0x02 changed in lockstep with every 0x03 Sync-zone broadcast
  // during the sweep. Sync reuses the same 14-zone SYNC_DIVISIONS table as
  // every other FX1 Sync control (13 captured v127 breakpoints land exactly
  // on that table's zone boundaries, same as Flanger/Chorus).
  // RATE DISPLAY — CONFIRMED via Charlie's Sync-zone -> Rate spreadsheet
  // (13-point cross-check, all within ~0.03 of the captured raw value):
  //   rate_seconds = 0.01 * (10/0.01)^(v127/127)      (0.01s .. 10s)
  //   Same exponential shape as Dyn3's Ratio formula, just this control's
  //   own min/max — SEE 2026-07-30 DYN3 RATIO entry for why this shape was
  //   trusted generally; here it is independently re-confirmed by a
  //   13-point sweep, not just assumed from family resemblance.
  // LOW CUT (24.4 Hz .. 1 kHz) — INFERRED to use the SAME exponential shape
  // (log-scaled Hz is the standard convention for a filter cutoff control,
  // and Rate — the other log-scaled quantity on this model — confirmed
  // exponential), but UNLIKE Rate this one has no independent multi-point
  // cross-check, only the two endpoints. Flag for confirmation if Charlie's
  // live test shows Low Cut reading obviously wrong partway through its
  // travel.
  // WIDTH / MIX (0-100%) and DEPTH / PRE DELAY (0.0-24 ms) — plain linear,
  // no capture ambiguity (a percentage and a small millisecond range don't
  // have the "can't reach a round number" failure mode R5 warns about at
  // this resolution).
  // VOICES — RESOLVED 2026-07-31, two rounds. Round 1 (Charlie's live
  // test): dropdown only offered 1-5, but hardware position 5 was actually
  // voice 6 — assumed a lost capture step and temporarily widened to a
  // 6-way even spread as an unconfirmed placeholder. Round 2 (Charlie's
  // diagnostic recapture + a screenshot of Avid's own Voices dropdown):
  // Avid's list is 1, 2, 3, 4, 6 — IT SKIPS 5 ENTIRELY, there is no 6th
  // slot to invent. The ORIGINAL capture's 5 raw values (0, 32, 64, 95, 127)
  // were correct all along; the only defect was the label on the last
  // entry ("5" instead of "6"). Reverted to those 5 values, relabeled.
  // cell.select, not cell.sync (no tempo relationship).
  // WAVEFORM — Tri/Sine, plain cell.toggle (2 states only, same shape as
  // C1 Chorus's Mode) — captured sequence 127/0/127 confirms val=127 SINE,
  // val=0 TRI (the panel's load-state screenshot shows TRI selected as
  // default, matching an unbroadcast starting value of 0 before the first
  // move to Sine at 127).
  // MONO/STEREO MID PAIR — THREE mids this time, not two: MODEL_NAMES above
  // lists 0x04 'MultiChorus' (mono) and BOTH 0x05/0x06 'Multi Chorus' with
  // a space (stereo) — the same spelling quirk flagged in the Primer's
  // GRAPHICS section. Registered all three defensively (Graphic EQ/Dyn3
  // both had this exact class of bug from an incomplete mids[] — see
  // Session Log 2026-07-31) even though this capture only observed one
  // wire id; worth Charlie's usual Stereo/Mono toggle check on first test.
  { mid: 0x06, mids: [0x04, 0x05, 0x06], name: 'MultiChorus', captured: true,
    paramLos: [0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A],
    rows: [
      { rows: [
          [ {label:'Rate', lo:0x02, syncDriven:true,
              display: function(v) {
                var s = 0.01 * Math.pow(1000, v / 127);
                return (s < 1 ? s.toFixed(2) : s.toFixed(1)) + ' s';
              }},
            {label:'Sync', lo:0x03, sync:true} ],
          [ {label:'Depth', lo:0x04,
              display: function(v) { return ((v / 127) * 24).toFixed(1) + ' ms'; }} ]
        ]
      },
      { group:'CHORUS', rows: [
          [ {label:'Low Cut', lo:0x08,
              display: function(v) { return (24.4 * Math.pow(1000 / 24.4, v / 127)).toFixed(1) + ' Hz'; }},
            {label:'Width', lo:0x09,
              display: function(v) { return Math.round((v / 127) * 100) + '%'; }} ]
        ]
      },
      { group:'MOD', rows: [
          [ {label:'Pre Delay', lo:0x06,
              display: function(v) { return ((v / 127) * 24).toFixed(1) + ' ms'; }},
            {label:'Waveform', lo:0x0A, toggle:true, options:['Tri','Sine']} ]
        ]
      },
      { rows: [
          [ {label:'Voices', lo:0x07, select:true, options: [
              {label:'1', v127:0}, {label:'2', v127:32}, {label:'3', v127:64},
              {label:'4', v127:95}, {label:'6', v127:127} ] } ],
          [ {label:'Mix', lo:0x05,
              display: function(v) { return Math.round((v / 127) * 100) + '%'; }} ]
        ]
      }
    ]
  },
  { mid: 0x0C, name: 'Orange Phaser',    captured: false, paramLos: [], rows: [] },
  { mid: 0x13, name: 'Parametric EQ',    captured: false, paramLos: [], rows: [] },
  { mid: 0x0F, name: 'Roto Speaker',     captured: false, paramLos: [], rows: [] },
  { mid: 0x0A, name: 'Vibe Phaser',      captured: false, paramLos: [], rows: [] },
];
const FX1_MODEL_BY_MID = {};
FX1_MODELS.forEach(function(m) {
  (m.mids || [m.mid]).forEach(function(mid) { FX1_MODEL_BY_MID[mid] = m; });
});
