// ════════════════════════════════════════════════════════════════════
// CHAIN ROW GRAPHICS — MID-to-image resolution
// NEW 7/29/2026. Pulled out as its own data file (pattern: like
// fx-transport.js/fx-panels.js) per the Session Log's "MAPPING TABLE
// ARCHITECTURE" note (7/28) — this is CODE DATA, not documentation, and
// must never be pasted into a doc as a raw table.
//
// STATUS: infrastructure only. The actual MID->filename entries below are
// NOT YET FILLED IN — Charlie's real folder listing (11R_Image_Paths.txt,
// 3934 lines / 3623 PNGs, confirmed structure
// <Family>.aaxplugin\Contents\Resources\Images\<Name>.png) was shared into
// a prior chat session and was never committed to this repo (same as any
// other capture evidence). Until it's shared again — or main.js's
// scan-avid-graphics IPC handler is run against a real install/copy — this
// file has nothing concrete to match against.
//
// WHAT THIS FILE DOES INSTEAD: given a scan manifest (the
// { families: { <FolderName>: [pngBasename, ...] } } shape returned by
// main.js's scan-avid-graphics handler), resolveChainGraphics() attempts a
// fuzzy name match per block/amp and sorts results into CONFIDENT (exactly
// one candidate matched), AMBIGUOUS (2+ candidates — flagged for Charlie to
// confirm, never silently guessed), and UNRESOLVED (0 candidates). This
// lets the scanner be genuinely useful against Charlie's real folder the
// moment he sets it in Settings, without this file needing real filenames
// hardcoded first.
//
// AMP IMAGES ARE MANY-TO-ONE (Session Log 7/28): only 17 amp_*.png files
// exist for 33 documented amp models — several amps share one thumbnail
// (same physical chassis). Fuzzy name matching alone will likely under-
// resolve the amp table; that's expected, not a bug in this pass. Expect
// AMBIGUOUS/UNRESOLVED entries there until Charlie confirms the sharing
// groups from a real scan.
// ════════════════════════════════════════════════════════════════════

// Effect-block mid -> plugin folder family, from MODEL_NAMES (protocol.js).
// Confirmed 11 top-level plugin folders (Session Log 7/28): AmpsCabs, Delay,
// Distortion, Dynamics, EQ, FX Loop, Modulation, Reverb, Tuner, Volume, WAH.
// Entries marked [best guess] follow the obvious family but were not
// individually confirmed against the real listing — flag any mismatch here
// once Charlie's folder is scanned for real.
const CHAIN_BLOCK_FAMILY_BY_MID = {
  0x01: 'Modulation', 0x02: 'Modulation', 0x03: 'Modulation', // C1 Chorus/Vibrato
  0x04: 'Modulation', 0x05: 'Modulation', 0x06: 'Modulation', // MultiChorus (spelled two ways in the real folder — Session Log 7/28)
  0x07: 'Modulation', 0x08: 'Modulation',                     // Flanger
  0x09: 'Modulation', 0x0A: 'Modulation',                     // Vibe Phaser
  0x0B: 'Modulation', 0x0C: 'Modulation',                     // Orange Phaser
  0x0D: 'Modulation', 0x0E: 'Modulation', 0x0F: 'Modulation', // Roto Speaker [best guess]
  0x10: 'EQ', 0x11: 'EQ',                                     // Graphic EQ
  0x12: 'EQ', 0x13: 'EQ',                                     // Parametric EQ
  0x14: 'Dynamics',                                           // Gray Compressor
  0x15: 'Dynamics', 0x16: 'Dynamics',                         // Dyn3 Compressor
  0x17: 'Distortion',                                         // Tri-Knob Fuzz
  0x18: 'Distortion',                                         // Black Op Distortion
  0x19: 'Distortion',                                         // Green JRC Overdrive (real file: GreenJVCOD, not GreenJRCOD)
  0x1A: 'Distortion',                                         // White Boost
  0x1B: 'Distortion',                                         // DC Distortion
  0x1C: 'Delay', 0x1D: 'Delay',                               // EP Tape Echo
  0x1E: 'Delay', 0x1F: 'Delay',                               // BBD Delay
  0x20: 'Delay', 0x21: 'Delay', 0x22: 'Delay',                // Dyn Delay
  0x23: 'WAH',                                                // Shine Wah
  0x24: 'WAH',                                                // Black Wah
  0x25: 'Tuner',                                               // Tuner
  0x26: 'Reverb', 0x27: 'Reverb',                             // Blackpanel Spring Reverb
  0x28: 'Reverb', 0x29: 'Reverb', 0x2A: 'Reverb',             // Eleven SR
  0x2B: 'Volume', 0x2C: 'Volume',                             // Volume Pedal
  0x2D: 'FX Loop', 0x2E: 'FX Loop', 0x2F: 'FX Loop',
  0x30: 'FX Loop', 0x31: 'FX Loop', 0x32: 'FX Loop', 0x33: 'FX Loop',
};

// Known real-file spelling quirks (Session Log 7/28) — searched as an
// ALTERNATE token alongside the normal display name, never in place of it.
const CHAIN_NAME_ALT_TOKENS = {
  'Green JRC Overdrive': ['GreenJVCOD'],
};

// AMP-CAB block's own family is always AmpsCabs — amp identity comes from
// AMP_SELECT_LIST / AMP_NAME_MAP (protocol.js), not MODEL_NAMES, since it's
// identified by the TFX '6dls' key, not a chain-map mid.
const CHAIN_AMPCAB_FAMILY = 'AmpsCabs';

function normalizeForMatch(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// candidates: array of png basenames (no path) from one family's scan list.
// nameTokens: array of strings to try matching against each candidate (the
// display name plus any known alt spelling). Returns the list of basenames
// that contain (or are contained by) any token, normalized.
function matchCandidates(candidates, nameTokens) {
  const norm = nameTokens.map(normalizeForMatch).filter(Boolean);
  return candidates.filter(function(c) {
    const nc = normalizeForMatch(c.replace(/\.png$/i, ''));
    return norm.some(function(t) { return nc.indexOf(t) !== -1 || t.indexOf(nc) !== -1; });
  });
}

// manifest: the { families: {...} } object from main.js's scan-avid-graphics.
// Returns { confident: {key: {family, file}}, ambiguous: {key: {family, files:[]}},
//           unresolved: [{key, family, name}] }
// key = 'block:0x1A' style for effect blocks, 'amp:sl100drive' style for amps.
function resolveChainGraphics(manifest) {
  const result = { confident: {}, ambiguous: {}, unresolved: [] };
  if (!manifest || !manifest.families) return result;
  const families = manifest.families;

  Object.keys(CHAIN_BLOCK_FAMILY_BY_MID).forEach(function(midStr) {
    const mid = Number(midStr);
    const family = CHAIN_BLOCK_FAMILY_BY_MID[mid];
    const name = (typeof MODEL_NAMES !== 'undefined' && MODEL_NAMES[mid]) || null;
    if (!name) return;
    const key = 'block:0x' + mid.toString(16).padStart(2, '0');
    const pool = families[family] || [];
    const tokens = [name].concat(CHAIN_NAME_ALT_TOKENS[name] || []);
    const hits = matchCandidates(pool, tokens);
    if (hits.length === 1) result.confident[key] = { family: family, file: hits[0] };
    else if (hits.length > 1) result.ambiguous[key] = { family: family, files: hits };
    else result.unresolved.push({ key: key, family: family, name: name });
  });

  if (typeof AMP_SELECT_LIST !== 'undefined') {
    const pool = families[CHAIN_AMPCAB_FAMILY] || [];
    AMP_SELECT_LIST.forEach(function(a) {
      const key = 'amp:' + a.key;
      const label = (typeof AMP_NAME_MAP !== 'undefined' && AMP_NAME_MAP[a.key]) || a.label;
      const hits = matchCandidates(pool, [label]);
      if (hits.length === 1) result.confident[key] = { family: CHAIN_AMPCAB_FAMILY, file: hits[0] };
      else if (hits.length > 1) result.ambiguous[key] = { family: CHAIN_AMPCAB_FAMILY, files: hits };
      else result.unresolved.push({ key: key, family: CHAIN_AMPCAB_FAMILY, name: label });
    });
  }

  return result;
}
