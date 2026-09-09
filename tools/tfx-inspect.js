#!/usr/bin/env node
// tfx-inspect.js — decode and print everything currently known about a
// TFX file's global (TOC-section) parameters, without needing to upload
// it anywhere for analysis. Run this any time you want a quick sanity
// check on a capture, or to spot-check gate readback on a different amp.
//
// Usage:  node tfx-inspect.js <file.tfx> [file2.tfx ...]
//
// Global fields (RVol, Vol1/2, RMno, Tmpo, PIGI, WorB, ExpT) read from a
// FIXED body offset — these live in the file's own "section B", which per
// TFX_Parameter_Keys.txt is always-present and separate from the per-effect
// chain sections (C-L). Confirmed empirically too: unchanged across a
// same-patch reorder test that moved other effects around.
//
// Gate (sld3/sld4) is NOT fixed-offset, despite an earlier version of this
// script assuming it was — a follow-up test on 7/8/2026 (moving the AMP
// itself to a different chain position, nothing else changed) proved gate's
// whole block moves with the amp's own per-effect section. What IS fixed:
// the DISTANCE from the 'sld6' amp marker back to sld3/sld4, confirmed
// identical across two captures with the amp in very different chain
// positions. So gate here is now found by anchoring off wherever the amp
// marker actually is, the same way the amp marker itself was always found
// by search rather than a fixed offset.

const fs = require('fs');

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

// ── Confirmed field offsets (body-relative, i.e. file offset - 56) ──
const FIELDS = {
  RVol: 0x28,   // Rig Volume
  Vol1: 0x30,   // To AMP 1 level
  Vol2: 0x38,   // To AMP 2 level
  RMno: 0x40,   // Mono/Stereo
  Tmpo: 0x48,   // Tempo
  PIGI: 0x58,   // True Z setting
  WorB: 0x98,   // Input Selector
  ExpT: 0x68,   // Expression Pedal assignment
};

// Confirmed 7/8/2026 — fixed DISTANCE from the amp marker, not a fixed
// file offset (see header comment above). markerPos = body index where
// the amp's own 'sld6' key starts (found by search, same as amp ID).
const GATE_THRESH_OFFSET_FROM_AMP  = -88;
const GATE_RELEASE_OFFSET_FROM_AMP = -80;

function decode7bit(enc) {
  const len = enc.length;
  const res = Buffer.alloc(len);
  let begin = 0, shift = 1, i = 0;
  for (; begin + i < len - 1; i++) {
    res[i] = (((enc[begin + i] & 0xFF) << shift) & 0xFF)
           + (((enc[begin + i + 1] & 0xFF) >>> (7 - shift)) & 0xFF);
    res[i] &= 0xFF;
    shift++;
    if (shift === 8) { shift = 1; begin++; }
  }
  res[i] = ((enc[0 + len - 1] & 0xFF) << shift) & 0xFF;
  return res.slice(0, i + 1);
}

function readLE32(buf, off) {
  if (buf.length < off + 4) return null;
  return (buf[off] | (buf[off+1]<<8) | (buf[off+2]<<16) | (buf[off+3]<<24)) >>> 0;
}
function readSignedLE32(buf, off) {
  const u = readLE32(buf, off);
  if (u === null) return null;
  return u > 0x7FFFFFFF ? u - 0x100000000 : u;
}
function gateRawToV127(signed) {
  const pct = (signed - (-2147483648)) / (2147483647 - (-2147483648));
  return Math.round(Math.max(0, Math.min(1, pct)) * 127);
}
function valGateThresh(v127) {
  if (v127 === 0) return 'OFF';
  return (-90 + (v127 / 127) * 70).toFixed(1) + ' dB';
}
function valGateRelease(v127) {
  if (v127 === 0) return '10 ms';
  const ms = 10 * Math.pow(300, v127 / 127);
  return ms >= 1000 ? (ms/1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';
}
function valRigVol(v127) {
  return (-24 + (v127 / 127) * 24).toFixed(1) + ' dB';
}

function inspect(filename) {
  const fileBuf = fs.readFileSync(filename);
  const body = fileBuf.slice(56); // strip the 56-byte TFX file header

  console.log('=== ' + filename + ' (' + fileBuf.length + ' bytes, body=' + body.length + ') ===');

  // Amp ID — search for '6dls' marker (position varies with chain layout,
  // so this is a search, not a fixed offset). markerPos is reused below
  // to locate gate, which moves with this same section.
  let ampId = null, ampMarkerPos = null;
  for (let j = 0; j < body.length - 7; j++) {
    if (body[j]===0x36 && body[j+1]===0x64 && body[j+2]===0x6C && body[j+3]===0x73) {
      ampId = readLE32(body, j + 4);
      ampMarkerPos = j;
      break;
    }
  }
  const ampKey = ampId !== null ? (AMP_ID_TO_KEY[ampId] || ('unknown (id=' + ampId + ')')) : 'not found';
  console.log('  Amp:            ' + ampKey);

  // Rig Volume — same v127 scale/formula as the live CMD 0x07 broadcast
  const rvolRaw = readSignedLE32(body, FIELDS.RVol);
  if (rvolRaw !== null) {
    const rvolV = gateRawToV127(rvolRaw); // same full-int32-range encoding
    console.log('  Rig Volume:     ' + valRigVol(rvolV) + '  (raw=' + rvolRaw + ')');
  }

  // Gate — anchored off the amp marker position found above, not a fixed
  // file offset (see header comment)
  if (ampMarkerPos !== null) {
    const threshRaw  = readSignedLE32(body, ampMarkerPos + GATE_THRESH_OFFSET_FROM_AMP  + 4);
    const releaseRaw = readSignedLE32(body, ampMarkerPos + GATE_RELEASE_OFFSET_FROM_AMP + 4);
    if (threshRaw !== null && releaseRaw !== null) {
      const threshV  = gateRawToV127(threshRaw);
      const releaseV = gateRawToV127(releaseRaw);
      console.log('  Gate Threshold: ' + valGateThresh(threshV) + '  (raw=' + threshRaw + ', v=' + threshV + '/127)');
      console.log('  Gate Release:   ' + valGateRelease(releaseV) + '  (raw=' + releaseRaw + ', v=' + releaseV + '/127)');
    }
  } else {
    console.log('  Gate Threshold: (amp marker not found, cannot locate gate)');
  }

  // Other confirmed-named fields — raw values only, display formula not
  // yet worked out for these (they're not v127-scale like Vol/Gate are;
  // treat as informational until decoded properly)
  console.log('  Vol1 (To Amp1): raw=' + readSignedLE32(body, FIELDS.Vol1));
  console.log('  Vol2 (To Amp2): raw=' + readSignedLE32(body, FIELDS.Vol2));
  console.log('  Mono/Stereo:    raw=' + readSignedLE32(body, FIELDS.RMno));
  console.log('  Tempo:          raw=' + readLE32(body, FIELDS.Tmpo));
  console.log('  True Z:         raw=' + readLE32(body, FIELDS.PIGI));
  console.log('  Input Selector: raw=' + readLE32(body, FIELDS.WorB));
  console.log('  Expr Pedal:     raw=' + readLE32(body, FIELDS.ExpT));
  console.log('');
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('Usage: node tfx-inspect.js <file.tfx> [file2.tfx ...]');
  process.exit(1);
}
for (const f of files) {
  try { inspect(f); }
  catch(e) { console.log('=== ' + f + ' — ERROR: ' + e.message + ' ===\n'); }
}
