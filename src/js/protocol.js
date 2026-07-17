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

// ── Per-amp tone knob paramLo table — confirmed via Wireshark 7/14/2026.
// paramLo values only — paramHi is read at runtime from the CMD 0x21 chain
// map (third byte of typeA=0x07 triplet) and stored as currentParamHi.
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
      { lo: 0x0E, tfxKey: 'sldE', label: 'Bright',   type: 'toggle' },
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
    // Amp bypass has no TFX key — default to active (true) on patch load.
    // Live CMD 0x11 paramLo 0x06 will update if amp is actually bypassed.
    const ampActive  = true;

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
