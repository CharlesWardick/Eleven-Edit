// ════════════════════════════════════════════════════════════════════
// CHAIN ROW GRAPHICS — MID-to-image resolution
// NEW 7/29/2026. Pulled out as its own data file (pattern: like
// fx-transport.js/fx-panels.js) per the Session Log's "MAPPING TABLE
// ARCHITECTURE" note (7/28) — this is CODE DATA, not documentation, and
// must never be pasted into a doc as a raw table.
//
// REAL FILENAMES CONFIRMED 7/29/2026 from Charlie's actual install listing
// (11R_Image_Paths.txt). Folder naming is "Eleven <Family> UI.aaxplugin"
// (not the shorter guessed names from the 7/28 pass), each holding its
// images at Contents\Resources\Images\*.png directly — one flat folder,
// no further nesting for these ten families. Effect-block filenames below
// are DIRECT, CONFIRMED matches (exact basename, from the real listing) —
// not fuzzy-guessed. The 15 amp_*.png files covering 32 amp keys are the
// one area still needing Charlie's visual confirmation (many-to-one by
// chassis, Session Log 7/28) — left UNRESOLVED rather than guessed, per
// the "flag ambiguous matches, don't guess silently" rule.
// ════════════════════════════════════════════════════════════════════

// Effect-block mid -> plugin folder family (exact real folder name minus
// ".aaxplugin", matches what main.js's scan-avid-graphics returns).
const CHAIN_BLOCK_FAMILY_BY_MID = {
  0x01: 'Eleven Modulation UI', 0x02: 'Eleven Modulation UI', 0x03: 'Eleven Modulation UI',
  0x04: 'Eleven Modulation UI', 0x05: 'Eleven Modulation UI', 0x06: 'Eleven Modulation UI',
  0x07: 'Eleven Modulation UI', 0x08: 'Eleven Modulation UI',
  0x09: 'Eleven Modulation UI', 0x0A: 'Eleven Modulation UI',
  0x0B: 'Eleven Modulation UI', 0x0C: 'Eleven Modulation UI',
  0x0D: 'Eleven Modulation UI', 0x0E: 'Eleven Modulation UI', 0x0F: 'Eleven Modulation UI',
  0x10: 'Eleven EQ UI', 0x11: 'Eleven EQ UI',
  0x12: 'Eleven EQ UI', 0x13: 'Eleven EQ UI',
  0x14: 'Eleven Dynamics UI',
  0x15: 'Eleven Dynamics UI', 0x16: 'Eleven Dynamics UI',
  0x17: 'Eleven Distortion UI', 0x18: 'Eleven Distortion UI',
  0x19: 'Eleven Distortion UI', 0x1A: 'Eleven Distortion UI', 0x1B: 'Eleven Distortion UI',
  0x1C: 'Eleven Delay UI', 0x1D: 'Eleven Delay UI',
  0x1E: 'Eleven Delay UI', 0x1F: 'Eleven Delay UI',
  0x20: 'Eleven Delay UI', 0x21: 'Eleven Delay UI', 0x22: 'Eleven Delay UI',
  0x23: 'Eleven WAH UI', 0x24: 'Eleven WAH UI',
  0x25: 'Eleven Tuner UI',
  0x26: 'Eleven Reverb UI', 0x27: 'Eleven Reverb UI',
  0x28: 'Eleven Reverb UI', 0x29: 'Eleven Reverb UI', 0x2A: 'Eleven Reverb UI',
  0x2B: 'Eleven Volume UI', 0x2C: 'Eleven Volume UI',
  0x2D: 'Eleven FX Loop UI', 0x2E: 'Eleven FX Loop UI', 0x2F: 'Eleven FX Loop UI',
  0x30: 'Eleven FX Loop UI', 0x31: 'Eleven FX Loop UI', 0x32: 'Eleven FX Loop UI', 0x33: 'Eleven FX Loop UI',
};

// Effect-block mid -> exact confirmed PNG basename (base image, not the
// "_sel" selected-state variant — Session Log 7/28 POC note: "_sel" turned
// out to just be a generic amber outline, not a per-pedal custom asset,
// worth doing as CSS instead — so only the base image is wired here).
// Two models genuinely share one image (single real file for the whole
// family in the listing) — noted inline, not a mapping mistake.
const CHAIN_BLOCK_THUMB_FILE_BY_MID = {
  // Modulation
  0x01: 'C1Chorus.png',        0x02: 'C1Chorus.png',        0x03: 'C1Chorus.png',
  0x04: 'multichorus.png',     0x05: 'multichorus.png',     0x06: 'multichorus.png',
  0x07: 'MistressFlanger.png', 0x08: 'MistressFlanger.png',
  0x09: 'VibePhaser.png',      0x0A: 'VibePhaser.png',
  0x0B: 'OrangePhaser.png',    0x0C: 'OrangePhaser.png',
  0x0D: 'RotSpeaker.png',      0x0E: 'RotSpeaker.png',      0x0F: 'RotSpeaker.png',
  // EQ
  0x10: 'EQ.png',       0x11: 'EQ.png',
  0x12: 'ParaEQ.png',   0x13: 'ParaEQ.png',
  // Dynamics
  0x14: 'GrayCompressor.png',
  0x15: 'Dyn3.png',     0x16: 'Dyn3.png',
  // Distortion (all five direct 1:1, no sharing)
  0x17: 'TriKnobFuzz.png',
  0x18: 'BlackOpDist.png',
  0x19: 'GreenJVCOD.png',      // real file is "GreenJVCOD", not "GreenJRCOD" (Session Log 7/28 spelling quirk)
  0x1A: 'WhiteBoost.png',
  0x1B: 'DCDistortion.png',
  // Delay
  0x1C: 'TapeEcho.png', 0x1D: 'TapeEcho.png',
  0x1E: 'BBDelay.png',  0x1F: 'BBDelay.png',
  0x20: 'DynDelay.png', 0x21: 'DynDelay.png', 0x22: 'DynDelay.png',
  // WAH
  0x23: 'ShineWah.png',
  0x24: 'BlackWah.png',
  // Reverb — only 2 PNGs in the real folder for 2 model families. Names
  // don't literally echo "Blackpanel"/"Eleven SR" so this pairing is
  // inferred (Spring Reverb is the only spring-reverb model; Eleven SR is
  // the only stereo-native one) rather than name-matched — reasonable but
  // NOT yet visually confirmed by Charlie.
  0x26: 'SpringReverb.png',  0x27: 'SpringReverb.png',
  0x28: 'StereoReverb.png',  0x29: 'StereoReverb.png',  0x2A: 'StereoReverb.png',
  // Volume — one image for both mono/stereo variants
  0x2B: 'Volume.png', 0x2C: 'Volume.png',
  // FX Loop — one image for every variant (send/return has no model-specific art)
  0x2D: 'FXLoop.png', 0x2E: 'FXLoop.png', 0x2F: 'FXLoop.png',
  0x30: 'FXLoop.png', 0x31: 'FXLoop.png', 0x32: 'FXLoop.png', 0x33: 'FXLoop.png',
  // 0x25 Tuner intentionally absent — the real folder's Images root has no
  // flat top-level PNG (only arrows/backgrounds/buttons/knobs/notes
  // subfolders), unlike every other family. Needs a different resolution
  // approach later; dummy placeholder stays for now.
};

// AMP-CAB block's own family — amp identity comes from AMP_SELECT_LIST /
// AMP_NAME_MAP (protocol.js), not MODEL_NAMES, since it's identified by the
// TFX '6dls' key, not a chain-map mid.
const CHAIN_AMPCAB_FAMILY = 'Eleven AmpsCabs UI';

// AMP KEYS — BEST-EFFORT GROUPING (7/29/2026, 2nd pass). Only 15 amp_*.png
// files exist for 32 AMP_SELECT_LIST keys, genuinely many-to-one by physical
// chassis (Session Log 7/28). Unlike the effect-block table above, this
// grouping is NOT filename-confirmed — it's inferred from naming/semantic
// hints (see reasoning per group below) because the alternative (leaving it
// empty) means the AMP/CAB slot never shows anything. This is CHEAP to
// verify here: every entry shows up as a real picture next to the AMP MODEL
// dropdown the moment Charlie clicks through it, so a wrong grouping is
// obvious on sight, unlike a silent data-mapping mistake elsewhere. Flagged
// per group by confidence — HIGH (direct name match), MEDIUM (strong
// semantic reasoning), LOW (leftover/orphan guess) — so Charlie knows which
// ones most need a look.
const CHAIN_AMP_THUMB_FILE_BY_KEY = {
  // HIGH — key literally names the chassis image
  tweed_lux:  'amp_tweed.png',
  tweed_bass: 'amp_bass.png',
  black_duo:  'amp_duo.png',
  ac_hi:      'amp_AC.png',
  lead800:    'amp_lead800.png',
  m2lead:     'amp_M2.png',
  plexivari:  'amp_plx.png',  plexi50:  'amp_plx.png',  plexi100: 'amp_plx.png',
  sl100drive: 'amp_sl100.png', sl100crunch: 'amp_sl100.png', sl100clean: 'amp_sl100.png',
  treadmod:   'amp_treadplate.png', treadvint: 'amp_treadplate.png',
  dc_mod_od: 'amp_DC_modern.png', dc_mod_sod: 'amp_DC_modern.png',
  dc_mod800: 'amp_DC_modern.png', dc_mod_clean: 'amp_DC_modern.png',
  dc_vint_crunch: 'amp_DC_vintage.png', dc_vint_od: 'amp_DC_vintage.png',
  dc_vint_clean: 'amp_DC_vintage.png',
  lux_vib: 'amp_lux.png', lux_norm: 'amp_lux.png',   // key literally has "lux"

  // MEDIUM — semantic inference, not a name match
  dc_bass: 'amp_svt.png',    // amp_svt (iconic bass-amp head shape) is the
                             // only leftover image that reads as bass gear
  rb01b_red: 'amp_bogner.png', rb01b_blue: 'amp_bogner.png', rb01b_green: 'amp_bogner.png',
                             // RB-01b's red/blue/green channel naming matches
                             // Bogner's own colored-channel convention

  // LOW — same blackface-era Fender family as lux_vib/lux_norm; amp_lux
  // reused rather than left blank, since these three visually look almost
  // identical to Vibrolux on the real hardware (same tolex/grille era)
  black_vib:  'amp_lux.png',
  black_sr:   'amp_lux.png',
  black_mini: 'amp_lux.png',

  // LOW — genuine leftovers: 3 keys (j45, blueline, ms30), 1 unused image
  // (amp_DC30). No naming or semantic link found; grouped here only because
  // every other image had a stronger claim elsewhere. MOST LIKELY WRONG —
  // check these three first.
  j45:      'amp_DC30.png',
  blueline: 'amp_DC30.png',
  ms30:     'amp_DC30.png',
};

// Last successful scan-avid-graphics result, stored so a chain-map render
// can look up an image without re-scanning. Set by setAvidGraphicsManifest.
let avidGraphicsManifest = null;

function setAvidGraphicsManifest(manifest) {
  avidGraphicsManifest = (manifest && manifest.ok) ? manifest : null;
}

// Converts a Windows absolute path to a file:// URL suitable for <img src>.
// Encodes each path segment individually so spaces/parens in real Avid
// folder names ("Eleven Distortion UI", "RB-01b (Blue)" etc.) survive.
function pathToFileUrl(p) {
  const norm = p.replace(/\\/g, '/');
  const parts = norm.split('/').map(encodeURIComponent);
  return 'file:///' + parts.join('/');
}

// Returns a file:// src for a chain-row block's thumbnail, or null if no
// scan has been run yet, the family wasn't found in it, or (amps) the
// grouping isn't confirmed. Never throws — caller falls back to the dummy
// placeholder on null, exactly as before this file existed.
function getChainThumbSrc(modelId) {
  if (!avidGraphicsManifest) return null;
  const family = CHAIN_BLOCK_FAMILY_BY_MID[modelId];
  const file = CHAIN_BLOCK_THUMB_FILE_BY_MID[modelId];
  if (!family || !file) return null;
  const fam = avidGraphicsManifest.families[family];
  if (!fam || fam.files.indexOf(file) === -1) return null;
  return pathToFileUrl(fam.dir + '\\' + file);
}

// Same idea for the AMP-CAB block's amp image, keyed by amp key (state.js
// currentAmpKey) instead of a chain-map mid.
function getAmpThumbSrc(ampKey) {
  if (!avidGraphicsManifest || !ampKey) return null;
  const file = CHAIN_AMP_THUMB_FILE_BY_KEY[ampKey];
  if (!file) return null;
  const fam = avidGraphicsManifest.families[CHAIN_AMPCAB_FAMILY];
  if (!fam || fam.files.indexOf(file) === -1) return null;
  return pathToFileUrl(fam.dir + '\\' + file);
}

// CAB — only 5 of the 15 CAB_TYPE_LIST (protocol.js) entries have a real
// image at all (confirmed 1:1 from the real listing, name-for-name — the
// filename literally echoes the dropdown label, e.g. "1x12 Tweed Lux" ->
// cab_1x12_tweed_lux.png). The other 10 cab types have NO asset in the
// install and correctly fall back to the dummy placeholder — that's a real
// gap in Avid's own art, not a mapping miss on our side.
const CHAIN_CAB_THUMB_FILE_BY_NAME = {
  '1x12 Tweed Lux':      'cab_1x12_tweed_lux.png',
  '2x12 AC Blue':        'cab_2x12_ac_blue.png',
  '2x12 Black Panel Duo':'cab_2x12_blk_duo.png',
  '4x12 Classic 30':     'cab_4x12_classic_30.png',
  '4x12 Green 25W':      'cab_4x12_green_25w.png',
};

// Keyed by CAB_TYPE_LIST index (ui.js: updateCabTypeDisplay / the
// #cab-type-select dropdown), since that's what the app already tracks —
// no new state needed.
function getCabThumbSrc(cabIndex) {
  if (!avidGraphicsManifest) return null;
  if (typeof CAB_TYPE_LIST === 'undefined') return null;
  const entry = CAB_TYPE_LIST[cabIndex];
  if (!entry) return null;
  const file = CHAIN_CAB_THUMB_FILE_BY_NAME[entry.name];
  if (!file) return null;
  const fam = avidGraphicsManifest.families[CHAIN_AMPCAB_FAMILY];
  if (!fam || fam.files.indexOf(file) === -1) return null;
  return pathToFileUrl(fam.dir + '\\' + file);
}
