// ════════════════════════════════════════════════════════════════════
// BLOCK PRESETS (Part IX, build 167+) — save / load a single FX block's
// settings as a .tfx "Complete Controls State" file, cross-compatible with
// the standalone Avid Eleven Rack Editor (proven: Avid writes this exact
// layout, byte-for-byte, and there is NO checksum).
//
// FILE FORMAT (big-endian throughout), decoded from Benoni + Avid-authored
// samples:
//   0..3   uint32  total file length
//   4..7   FF FF FF FF
//   8..11  "Digi"
//   12..15 family code (4 chars):  Dstr Rvrb Sprn Flng MCho DyDl "PEQ "
//   16..18 model code (3 chars):   TS8 SR2 Sp2 GF2 MC2 AD2 PE2  (+ constant "uelck")
//   ~24    "Complete Controls State" + 00 padding to offset 56
//   56..59 01 01 01 01 marker, then repeating param records:
//       6-byte name ("d_Xxxx"=float, "l_Xxxx"=int) + 2 pad + value
//       (d_ = 8-byte double, l_ = 4-byte int). Records scan by their d_/l_
//       name marker, robust to trailing padding.
//
// SCOPE: DISTORTION (build 167+) and REVERB (build 201+). Both end-to-end,
// same LOCKED SPEC bar. This module is a generic per-block engine
// (makeBlock) instantiated once per block; DIST and REVERB differ only in
// their config object (family/model codes, accessors, and — for REVERB —
// the Eleven SR Type enum + its per-Type baseline). The block-specific
// value hooks (enumSave/enumLoadV127/collectSavedValues/baselineReady) keep
// the engine itself block-agnostic.
//
// REVERB specifics (samples verified 2026-09-30):
//   • Two models with DIFFERENT file families: Eleven SR = Rvrb / SR2,
//     Blackpanel Spring = Sprn / Sp2. The reverb block hosts BOTH families.
//   • Eleven SR's Type is a parameter (l_Type, an INDEX into
//     REVERB_TYPE_LIST), not a separate model — stored in the preset, set on
//     load. Model-level scope (Charlie 2026-09-30): scope = the two models +
//     ALL; a preset captures its own Type.
//   • d_ knob values are the direct 0–10 display value (Decay/Tone/Mix);
//     Pre-Delay is whole ms on a 0–200 scale (per-param scale override).
//
// VALUE SCALE: the d_ float is the control's readout value, mapped to/from
// v127 by bpFloatToV127 / bpV127ToFloat with a per-family (or per-param)
// linear scale. EE uses the same constants both ways, so EE round-trip is
// exact regardless of whether lo/hi match Avid; foreign import lands right
// when lo/hi are correct (confirmed 0–10 for DIST + REVERB).
// ════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  var MAGIC = 'Digi';
  var STATE_LABEL = 'Complete Controls State';
  var SCOPE_ALL = '__ALL__';

  // ── Feature opt-in (localStorage 'blockPresetsEnabled', default OFF) ──
  // Block presets ship OFF so a v1.1 user installing v1.2 sees the exact same
  // panels until they tick Settings → Other Configuration → Panel presets.
  // When off, the preset bar + ↺ RELOAD buttons are hidden AND every
  // window.blockPresets.* hook goes inert (returns the falsy/undefined value
  // the fx-panels guards fall back on), so the panels behave identically to
  // dev — no second panel implementation, the dev path is simply what runs.
  var bpFeatureEnabled = false;
  function bpLoadEnabled() {
    try { bpFeatureEnabled = window.localStorage.getItem('blockPresetsEnabled') === '1'; }
    catch (e) { bpFeatureEnabled = false; }
  }
  function bpApplyEnabled() {
    ['dist', 'reverb', 'delay'].forEach(function (K) {
      var bar = document.getElementById('bp-bar-' + K);
      if (bar) bar.style.display = bpFeatureEnabled ? '' : 'none';
      var rev = document.getElementById('btn-' + K + '-revert');
      if (rev) rev.style.display = bpFeatureEnabled ? '' : 'none';
    });
    if (!bpFeatureEnabled) { autoStop(); }
    else { dist.onPanelOpen(); reverb.onPanelOpen(); delay.onPanelOpen(); }   // populate the open panel's bar now
  }
  function bpSetEnabled(on) {
    bpFeatureEnabled = !!on;
    try { window.localStorage.setItem('blockPresetsEnabled', on ? '1' : '0'); } catch (e) {}
    bpApplyEnabled();
  }

  // ── EE block ⇄ Avid file identity ──────────────────────────────────
  // Each entry: the Avid family/model codes for an EE base mid, plus the
  // per-paramLo file field {name, type, scale?}. type 'd' = float (8 bytes),
  // 'l' = int enum (4 bytes). An optional per-param `scale` overrides the
  // family scale (used for Pre-Delay's 0–200 ms).
  var DIST_MAP = {
    0x19: { family: 'Dstr', code: 'TS8', verified: true,   // Green JRC Overdrive (Tube Screamer)
            params: { 0x02: {name:'d_Driv', type:'d'}, 0x03: {name:'d_Tone', type:'d'}, 0x04: {name:'d_Levl', type:'d'} } },
    // ── UNVERIFIED below: codes/names are best-effort; confirm from an Avid export. ──
    0x17: { family: 'Dstr', code: 'TKF', verified: false,  // Tri-Knob Fuzz
            params: { 0x02: {name:'d_Volu', type:'d'}, 0x03: {name:'d_Sust', type:'d'}, 0x04: {name:'d_Tone', type:'d'} } },
    0x18: { family: 'Dstr', code: 'BOD', verified: false,  // Black Op Distortion
            params: { 0x02: {name:'d_Dist', type:'d'}, 0x03: {name:'d_Cut ', type:'d'}, 0x04: {name:'d_Volu', type:'d'} } },
    0x1A: { family: 'Dstr', code: 'WBO', verified: false,  // White Boost
            params: { 0x02: {name:'d_Gain', type:'d'}, 0x03: {name:'d_Treb', type:'d'}, 0x04: {name:'d_Bass', type:'d'}, 0x05: {name:'d_Volu', type:'d'} } },
    0x1B: { family: 'Dstr', code: 'DCD', verified: false,  // DC Distortion
            params: { 0x02: {name:'d_Dist', type:'d'}, 0x03: {name:'d_Treb', type:'d'}, 0x04: {name:'d_Bass', type:'d'}, 0x05: {name:'d_Levl', type:'d'} } }
  };

  // REVERB models (base mids 0x26 Blackpanel Spring, 0x28 Eleven SR). Both
  // VERIFIED from real Avid-authored samples (2026-09-30). Record ORDER = the
  // model's paramLos order, which matches Avid's byte layout exactly:
  //   Eleven SR: d_Dcay d_Tone d_RMix l_Type d_PDly  (los 02 03 04 05 06)
  //   Spring:    d_Dcay d_Tone d_RMix                 (los 02 03 04)
  var REVERB_MAP = {
    0x26: { family: 'Sprn', code: 'Sp2', verified: true,   // Blackpanel Spring Reverb
            params: { 0x02: {name:'d_Dcay', type:'d'}, 0x03: {name:'d_Tone', type:'d'}, 0x04: {name:'d_RMix', type:'d'} } },
    0x28: { family: 'Rvrb', code: 'SR2', verified: true,   // Eleven SR
            params: { 0x02: {name:'d_Dcay', type:'d'}, 0x03: {name:'d_Tone', type:'d'}, 0x04: {name:'d_RMix', type:'d'},
                      0x05: {name:'l_Type', type:'l'},                                        // enum index into REVERB_TYPE_LIST
                      0x06: {name:'d_PDly', type:'d', scale:{lo:0, hi:200}} } }                // whole ms, 0–200
  };

  // DELAY models — THREE file families, one per model (samples verified
  // 2026-09-30, byte-identical round-trip): EP Tape Echo = EcPl/EC2, BBD
  // Delay = MeMn/MM2, Dyn Delay = DyDl/AD2. Record order = paramLos ascending
  // (matches Avid). Each param carries its own `enc` (see encToFile). The Dyn
  // log curves (HiCt/LoCt/Rate), bipolar sign (EnFb/EnMx) and Feedback-Mode
  // index order are the inferred-not-proven ones — verify on hardware.
  var FBMODE_OPTS = [ {v127:0}, {v127:42}, {v127:85}, {v127:127} ];   // Mono/Stereo/Cross/Pong
  var DELAY_MAP = {
    0x1C: { family: 'EcPl', code: 'EC2', verified: true,   // EP Tape Echo
            params: {
              0x02: {name:'d_Vol ', type:'d', enc:{kind:'linear', lo:1, hi:9}},   // Mix 1–9
              0x03: {name:'d_Sust', type:'d', enc:{kind:'linear', lo:1, hi:9}},   // Feedback 1–9
              0x04: {name:'d_EDly', type:'d', enc:{kind:'frac'}},                 // Delay (position)
              0x05: {name:'l_Sync', type:'l', enc:{kind:'sync'}},
              0x06: {name:'d_Rec ', type:'d', enc:{kind:'linear', lo:0, hi:10}},  // Rec Level 0–10
              0x07: {name:'d_Wow ', type:'d', enc:{kind:'linear', lo:0, hi:2}},   // Wow/Flutter 0–2%
              0x08: {name:'d_Tilt', type:'d', enc:{kind:'linear', lo:0, hi:10}},  // Head Tilt 0–10
              0x09: {name:'l_4X  ', type:'l', enc:{kind:'toggle'}},               // Expanded Delay
              0x0A: {name:'l_Hiss', type:'l', enc:{kind:'toggle'}} } },
    0x1E: { family: 'MeMn', code: 'MM2', verified: true,   // BBD Delay (Memory Man)
            params: {
              0x02: {name:'d_Blnd', type:'d', enc:{kind:'linear', lo:0, hi:10}},  // Mix 0–10
              0x03: {name:'d_Fdbk', type:'d', enc:{kind:'linear', lo:0, hi:10}},  // Feedback 0–10
              0x04: {name:'d_Dly ', type:'d', enc:{kind:'frac'}},                 // Delay (position)
              0x05: {name:'l_Sync', type:'l', enc:{kind:'sync'}},
              0x06: {name:'d_InLv', type:'d', enc:{kind:'linear', lo:0, hi:10}},  // Input 0–10
              0x07: {name:'d_Dpth', type:'d', enc:{kind:'linear', lo:0, hi:10}},  // Depth 0–10
              0x08: {name:'l_ChVb', type:'l', enc:{kind:'toggle'}},               // Chorus/Vibrato
              0x09: {name:'l_4X  ', type:'l', enc:{kind:'toggle'}},               // Expanded Delay
              0x0A: {name:'l_Nois', type:'l', enc:{kind:'toggle'}} } },
    0x20: { family: 'DyDl', code: 'AD2', verified: true,   // Dyn Delay
            params: {
              0x02: {name:'d_DMix', type:'d', enc:{kind:'frac'}},                 // Mix 0–100%
              0x03: {name:'d_Fdbk', type:'d', enc:{kind:'frac'}},                 // Feedback 0–100%
              0x04: {name:'d_Dly ', type:'d', enc:{kind:'frac'}},                 // Delay (position)
              0x05: {name:'l_Sync', type:'l', enc:{kind:'sync'}},
              0x06: {name:'l_Mode', type:'l', enc:{kind:'select', options:FBMODE_OPTS}},  // Feedback Mode (order: verify HW)
              0x07: {name:'d_Rtio', type:'d', enc:{kind:'frac'}},                 // L/R Ratio (position)
              0x08: {name:'d_Wdth', type:'d', enc:{kind:'frac'}},                 // Stereo Width 0–100%
              0x09: {name:'d_HiCt', type:'d', enc:{kind:'log', lo:1000, hi:20000}}, // High Cut Hz (verify HW)
              0x0A: {name:'d_LoCt', type:'d', enc:{kind:'log', lo:20, hi:1000}},    // Low Cut Hz (verify HW)
              0x0B: {name:'d_EnRt', type:'d', enc:{kind:'log', lo:0.01, hi:1}},     // Env Rate s (verify HW)
              0x0C: {name:'d_EnFb', type:'d', enc:{kind:'bipolar'}},                // Env FBK ±% (verify HW)
              0x0D: {name:'d_EnMx', type:'d', enc:{kind:'bipolar'}} } }            // Env Mix ±% (verify HW)
  };

  // ── Value scale per family (linear v127 0..127 ⇄ float lo..hi). A param's
  // own `scale` (see d_PDly) wins over the family scale. ────────────────
  var BP_SCALE = {
    Dstr: { lo: 0.0, hi: 10.0 },
    Rvrb: { lo: 0.0, hi: 10.0 },
    Sprn: { lo: 0.0, hi: 10.0 }
  };
  function paramScale(map, baseMid, lo) {
    var f = map[baseMid] && map[baseMid].params[lo];
    if (f && f.scale) return f.scale;
    var fam = map[baseMid] ? map[baseMid].family : null;
    return BP_SCALE[fam] || { lo: 0.0, hi: 4.0 };
  }
  function bpFloatToV127(scale, f) {
    var v = Math.round((f - scale.lo) / (scale.hi - scale.lo) * 127);
    return Math.max(0, Math.min(127, v));
  }
  function bpV127ToFloat(scale, v127) {
    return scale.lo + (v127 / 127) * (scale.hi - scale.lo);
  }

  // ── Per-param encoders (DELAY) ──────────────────────────────────────
  // DELAY's stored floats are NOT one uniform family scale — each param has
  // its own encoding. A field carries an `enc`; when present it wins over the
  // family scale. enc.kind:
  //   frac            v127/127 (0–1 normalised)
  //   linear(lo,hi)   display units, linear
  //   log(lo,hi)      display units, log (Hz / time knobs)  [Dyn — verify HW]
  //   bipolar         ±% around centre v127=64               [Dyn — verify HW]
  //   sync            SYNC_DIVISIONS index  (l_)
  //   select(options) option index, v127 = options[i].v127  (l_)
  //   toggle          0/1 ↔ off/on                           (l_)
  // encToFile: v127 → stored value. encFromFile: stored value → v127.
  function encToFile(enc, v127) {
    switch (enc.kind) {
      case 'frac':    return v127 / 127;
      case 'linear':  return enc.lo + (v127 / 127) * (enc.hi - enc.lo);
      case 'log':     return enc.lo * Math.pow(enc.hi / enc.lo, v127 / 127);
      case 'bipolar': return (v127 < 64) ? (v127 - 64) * (100 / 64) : (v127 - 64) * (100 / 63);
      case 'sync':    return (typeof syncIndexFromV127 === 'function') ? syncIndexFromV127(v127) : 0;
      case 'select':  { var b = 0, bd = Infinity; enc.options.forEach(function (o, i) { var d = Math.abs(o.v127 - v127); if (d < bd) { bd = d; b = i; } }); return b; }
      case 'toggle':  return v127 >= 64 ? 1 : 0;
    }
    return v127;
  }
  function encFromFile(enc, fv) {
    var frac;
    switch (enc.kind) {
      case 'frac':    frac = fv; break;
      case 'linear':  frac = (fv - enc.lo) / (enc.hi - enc.lo); break;
      case 'log':     frac = Math.log(fv / enc.lo) / Math.log(enc.hi / enc.lo); break;
      case 'bipolar': { var v = (fv < 0) ? Math.round(64 + fv * 64 / 100) : Math.round(64 + fv * 63 / 100); return Math.max(0, Math.min(127, v)); }
      case 'sync':    return (typeof syncV127FromIndex === 'function') ? syncV127FromIndex(fv | 0) : 0;
      case 'select':  { var i = Math.max(0, Math.min(enc.options.length - 1, fv | 0)); return enc.options[i].v127; }
      case 'toggle':  return (fv | 0) > 0 ? 127 : 0;
      default:        frac = fv;
    }
    if (isNaN(frac)) return 0;
    return Math.max(0, Math.min(127, Math.round(frac * 127)));
  }

  // ── Low-level byte helpers ─────────────────────────────────────────
  function beDouble(bytes, off) {
    return new DataView(new Uint8Array(bytes.slice(off, off + 8)).buffer).getFloat64(0, false);
  }
  function beInt(bytes, off) {
    return new DataView(new Uint8Array(bytes.slice(off, off + 4)).buffer).getInt32(0, false);
  }
  function putBEDouble(arr, f) {
    var b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, f, false);
    for (var i = 0; i < 8; i++) arr.push(b[i]);
  }
  function putBEInt(arr, n) {
    arr.push((n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF);
  }
  function ascii(s) { var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i)); return a; }
  function hex(n) { return n.toString(16).padStart(2, '0'); }
  function stripExt(f) { return String(f).replace(/\.tfx$/i, ''); }
  function setStatusSafe(m) { if (typeof setStatus === 'function') setStatus(m); }

  // ── Parse a block-preset file → { family, code, params:[{name,type,value}] } ──
  function parsePreset(bytes) {
    if (bytes.length < 24) return { ok: false, error: 'File too small to be a preset.' };
    var magic = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (magic !== MAGIC) return { ok: false, error: 'Not an Eleven Rack effect preset.' };
    var family = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    var code = String.fromCharCode(bytes[16], bytes[17], bytes[18]);
    var params = [];
    var i = 24;
    while (i + 12 <= bytes.length) {
      var p = bytes[i], u = bytes[i + 1];
      if ((p === 0x64 || p === 0x6C) && u === 0x5F) {   // 'd_' or 'l_'
        var name = '';
        for (var k = 0; k < 6; k++) name += String.fromCharCode(bytes[i + k]);
        if (p === 0x64) {
          if (i + 16 > bytes.length) break;
          params.push({ name: name, type: 'd', value: beDouble(bytes, i + 8) });
          i += 16;
        } else {
          params.push({ name: name, type: 'l', value: beInt(bytes, i + 8) });
          i += 12;
        }
      } else {
        i++;
      }
    }
    if (!params.length) return { ok: false, error: 'No parameters found in preset.' };
    return { ok: true, family: family, code: code, params: params };
  }

  // ── Serialize { family, code, params:[{name,type,value}] } → byte array ──
  function serializePreset(family, code, params) {
    var out = [];
    out.push(0, 0, 0, 0);
    out.push(0xFF, 0xFF, 0xFF, 0xFF);
    out = out.concat(ascii(MAGIC));
    out = out.concat(ascii((family + '    ').substring(0, 4)));
    out = out.concat(ascii((code + '   ').substring(0, 3)));
    out = out.concat(ascii('uelck'));
    out = out.concat(ascii(STATE_LABEL));
    while (out.length < 56) out.push(0);
    out.push(0x01, 0x01, 0x01, 0x01);
    params.forEach(function (pm) {
      out = out.concat(ascii((pm.name + '      ').substring(0, 6)));   // exactly 6-byte name
      out.push(0, 0);
      if (pm.type === 'd') putBEDouble(out, pm.value); else putBEInt(out, pm.value | 0);
    });
    var len = out.length;
    out[0] = (len >>> 24) & 0xFF; out[1] = (len >>> 16) & 0xFF;
    out[2] = (len >>> 8) & 0xFF;  out[3] = len & 0xFF;
    return out;
  }

  function bpDim(id, off) {
    var b = document.getElementById(id);
    if (b) { b.disabled = off; b.classList.toggle('bp-disabled', off); }
  }

  function bpRejectModal(name, msg) {
    if (typeof showModalMessage === 'function') {
      showModalMessage("Can't load this preset",
        '<div style="padding:4px 2px;line-height:1.5;">' + (msg || "This block can't host that preset.")
        + (name ? ('<br><br>File: <b>' + name + '</b>') : '') + '</div>');
    } else { setStatusSafe(msg); }
  }

  // ── Shared auto-step: one timer at a time (only one panel is open). Any
  // interaction anywhere except the running block's own ▶ stops it. ──────
  var AUTO = {};              // blkKey -> { step, hasFiles, secId, autoId }
  var autoTimer = null, autoKey = null;
  function autoSeconds(key) {
    var f = document.getElementById(AUTO[key].secId);
    var v = f ? parseInt(f.value, 10) : 5;
    return (isNaN(v) || v < 1) ? 5 : Math.min(v, 999);
  }
  function autoStart(key) {
    if (!AUTO[key] || !AUTO[key].hasFiles()) return;
    autoStop();
    autoKey = key;
    autoTimer = setInterval(function () { AUTO[key].step(1, { auto: true }); }, autoSeconds(key) * 1000);
    updateAutoBtn(key);
  }
  function autoStop() {
    if (autoTimer) { var k = autoKey; clearInterval(autoTimer); autoTimer = null; autoKey = null; if (k) updateAutoBtn(k); }
  }
  function autoToggle(key) { if (autoTimer && autoKey === key) autoStop(); else autoStart(key); }
  function updateAutoBtn(key) {
    var b = document.getElementById(AUTO[key].autoId);
    if (!b) return;
    var on = !!(autoTimer && autoKey === key);
    b.textContent = on ? '■' : '▶';
    b.classList.toggle('bp-playing', on);
    b.title = on ? 'Stop auto-step' : 'Auto-step through the scope every N seconds';
  }
  document.addEventListener('pointerdown', function (e) {
    if (!autoTimer) return;
    if (e.target && e.target.closest && AUTO[autoKey] && e.target.closest('#' + AUTO[autoKey].autoId)) return;
    autoStop();
  }, true);
  document.addEventListener('keydown', function () { if (autoTimer) autoStop(); }, true);

  // ── Preset bar DOM (generic; ids keyed by blkKey) ───────────────────
  function buildPresetBar(K, onSave, onLoad, onStep, onScope) {
    var bar = document.createElement('div');
    bar.className = 'preset-bar';
    bar.id = 'bp-bar-' + K;
    bar.innerHTML =
      '<span class="preset-tag">PRESET</span>'
      + '<button class="bt-btn" id="bp-save-' + K + '">SAVE</button>'
      + '<button class="bt-btn" id="bp-load-' + K + '">LOAD</button>'
      + '<select class="bp-scope" id="bp-scope-' + K + '" title="Which presets − + and ▶ cycle"></select>'
      + '<span class="bp-step">'
      + '<button class="bt-btn bp-step-btn" id="bp-prev-' + K + '" title="Previous preset">−</button>'
      + '<button class="bt-btn bp-step-btn" id="bp-next-' + K + '" title="Next preset">+</button>'
      + '</span>'
      + '<button class="bt-btn bp-auto-btn" id="bp-auto-' + K + '" title="Auto-step">▶</button>'
      + '<span class="bp-secwrap"><select class="bp-sec" id="bp-sec-' + K + '">'
      + '<option>5</option><option>10</option><option>15</option><option>20</option><option>25</option><option>30</option>'
      + '</select><span>s</span></span>'
      + '<span class="bp-state">'
      + '<span class="bp-count" id="bp-count-' + K + '">0 / 0</span>'
      + '<span class="pname" id="bp-name-' + K + '">Saved: <b>—</b></span>'
      + '</span>';
    bar.querySelector('#bp-save-' + K).addEventListener('click', onSave);
    bar.querySelector('#bp-load-' + K).addEventListener('click', onLoad);
    bar.querySelector('#bp-prev-' + K).addEventListener('click', function () { onStep(-1); });
    bar.querySelector('#bp-next-' + K).addEventListener('click', function () { onStep(1); });
    bar.querySelector('#bp-auto-' + K).addEventListener('click', function () { autoToggle(K); });
    bar.querySelector('#bp-scope-' + K).addEventListener('change', function () { onScope(this.value); });
    return bar;
  }

  // ════════════════════════════════════════════════════════════════════
  // GENERIC PER-BLOCK ENGINE
  // ════════════════════════════════════════════════════════════════════
  function makeBlock(cfg) {
    var K = cfg.key;
    var st = {
      folder: [],        // [{name, path, model}] sorted (Windows order)
      ring: [],          // [ {origin:true} ? ] + folder
      ringIndex: -1,
      scope: null,       // model name | SCOPE_ALL | null (uninit)
      onOrigin: false,   // ring sits on the virtual "Original" stop
      loaded: null,      // loaded preset name for the caption
      loadedPath: null,  // absolute path of the loaded preset (stepper anchor)
      presetRef: null,   // {loHex: v127} tick reference while a preset is loaded
      pendingApply: null,   // apply a parsed file after an auto-switch (import)
      pendingRestore: null  // apply saved knobs after a switch-back (revert/origin)
    };

    function block() { return cfg.block(); }
    function baseMidOf() { var b = block(); return b ? cfg.baseMid(b.modelId) : null; }
    function curModelName() { return cfg.currentModelName(); }

    // ── Caption ──
    function savedModelName() {
      var mid = cfg.savedMidNumeric();
      if (mid === undefined || isNaN(mid)) { var b = block(); mid = b ? cfg.baseMid(b.modelId) : undefined; }
      if (mid === undefined) return null;
      return cfg.modelName(mid);
    }
    function refreshCaption() {
      var el = document.getElementById('bp-name-' + K);
      if (!el) return;
      var pre, nm;
      if (st.onOrigin) { pre = '★ Original'; nm = savedModelName() || ''; }
      else if (st.loaded) { pre = 'Loaded:'; nm = st.loaded; }
      else {
        // No preset loaded and not on the Original stop. If we're viewing the
        // patch's OWN saved model, the knobs are the patch's stored tone →
        // "Saved: <model>". If the user switched to a DIFFERENT model, there's
        // no saved reference for it (its Original would be another model), so
        // show the current model honestly → "Model: <model>". (RULE 4.)
        var cur = curModelName();
        var saved = savedModelName();
        if (cur && saved && cur !== saved) { pre = 'Model:'; nm = cur; }
        else { pre = 'Saved:'; nm = saved || '—'; }
      }
      el.innerHTML = '<span class="bp-pre">' + pre + '</span><b>' + nm + '</b>';
    }
    function setLoadedName(name) { st.loaded = name || null; refreshCaption(); }

    // ── Tick reference (loaded-preset deviation) ──
    function tickRef(loHex) {
      if (!bpFeatureEnabled) return undefined;
      return (st.presetRef && st.presetRef[loHex] !== undefined) ? st.presetRef[loHex] : undefined;
    }
    function clearPresetRef() { st.presetRef = null; }

    // ── EXPORT ──
    function doExport() {
      var blk = block();
      if (!blk) { setStatusSafe('No ' + cfg.label + ' block to save.'); return; }
      var bmid = cfg.baseMid(blk.modelId);
      var entry = cfg.map[bmid];
      var model = cfg.modelByMid[blk.modelId];
      if (!entry || !model) { setStatusSafe('This ' + cfg.lower + ' model has no preset mapping yet.'); return; }
      if (!cfg.baselineReady()) { setStatusSafe('Still reading the patch — try Save again in a moment.'); return; }

      var params = [];
      model.paramLos.forEach(function (lo) {
        var field = entry.params[lo];
        if (!field) return;
        var v127 = cfg.knobV127(hex(lo));
        if (v127 === undefined || isNaN(v127)) return;
        if (field.enc) params.push({ name: field.name, type: field.type, value: encToFile(field.enc, v127) });
        else if (field.type === 'l') params.push({ name: field.name, type: 'l', value: cfg.enumSave(lo, v127) });
        else params.push({ name: field.name, type: 'd', value: bpV127ToFloat(paramScale(cfg.map, bmid, lo), v127) });
      });
      if (!params.length) { setStatusSafe('No values to save (open the panel first).'); return; }

      var bytes = serializePreset(entry.family, entry.code, params);
      var suggest = (model.name || cfg.label);
      window.electronAPI.saveBlockPreset(cfg.familyFolder, model.name, suggest, bytes).then(function (r) {
        if (r && r.ok) {
          setLoadedName(stripExt(r.filename));
          st.loadedPath = r.path;
          setStatusSafe('Saved preset: ' + r.filename);
          refreshFolder();
        } else if (r && !r.canceled) {
          setStatusSafe('Save failed: ' + (r.error || 'unknown error'));
        }
      });
    }

    // ── Parse + capability gate ──
    function parseValid(bytes) {
      var parsed = parsePreset(bytes);
      if (!parsed.ok) return { ok: false, kind: 'parse', msg: parsed.error };
      if (cfg.families.indexOf(parsed.family) < 0) return { ok: false, kind: 'reject', msg: cfg.rejectMsg };
      return { ok: true, parsed: parsed };
    }

    // ── Apply a validated preset (auto-switch model if needed, then set). ──
    function loadValidated(parsed, filename, fpath) {
      if (fpath) { st.loadedPath = fpath; syncRingIndex(fpath); }
      var targetMid = null;
      for (var mid in cfg.map) { if (cfg.map[mid].code === parsed.code) { targetMid = parseInt(mid, 10); break; } }
      var cur = block();
      if (targetMid !== null && cur && cfg.baseMid(cur.modelId) !== targetMid) {
        st.pendingApply = { parsed: parsed, mid: targetMid, filename: filename };
        cfg.sendModelChange(targetMid);
        setStatusSafe('Switching ' + cfg.label + ' to load "' + stripExt(filename) + '"…');
        return;
      }
      applyParsed(parsed, filename);
    }

    function applyParsed(parsed, filename) {
      var blk = block();
      if (!blk) return;
      var bmid = cfg.baseMid(blk.modelId);
      var entry = cfg.map[bmid];
      if (!entry) { setStatusSafe('No mapping for this ' + cfg.lower + ' model.'); return; }
      var nameToLo = {};
      Object.keys(entry.params).forEach(function (lo) { nameToLo[entry.params[lo].name] = parseInt(lo, 10); });
      var orderedLos = Object.keys(entry.params).map(function (x) { return parseInt(x, 10); }).sort(function (a, b) { return a - b; });

      var applied = [], posIdx = 0;
      parsed.params.forEach(function (pm) {
        var lo = nameToLo[pm.name];
        if (lo === undefined) { lo = orderedLos[posIdx]; }   // positional fallback
        posIdx++;
        if (lo === undefined) return;
        var field = entry.params[lo];
        var v127;
        if (field && field.enc) v127 = encFromFile(field.enc, pm.value);
        else if (pm.type === 'l' || (field && field.type === 'l')) v127 = cfg.enumLoadV127(lo, pm.value | 0);
        else v127 = bpFloatToV127(paramScale(cfg.map, bmid, lo), pm.value);
        applied.push({ lo: lo, v127: v127 });
      });
      // Block-specific apply order (REVERB: Type control first, so the knob
      // cells settle under the loaded Type — see cfg.applyOrder).
      if (cfg.applyOrder) applied = cfg.applyOrder(bmid, applied);

      st.presetRef = {};
      applied.forEach(function (a) { st.presetRef[hex(a.lo)] = a.v127; });
      applied.forEach(function (a) { cfg.updateKnob(a.lo, a.v127); cfg.sendParamWrite(a.lo, a.v127); });
      st.onOrigin = false;
      setLoadedName(stripExt(filename));
      setStatusSafe('Loaded "' + stripExt(filename) + '"' + (applied.length ? '' : ' (no matching parameters).'));
    }

    // Apply an ordered [{lo,v127}] list to the current model (origin/revert).
    function applyValueList(list) {
      var n = 0;
      (list || []).forEach(function (a) {
        if (a.v127 === undefined || isNaN(a.v127)) return;
        cfg.updateKnob(a.lo, a.v127); cfg.sendParamWrite(a.lo, a.v127); n++;
      });
      return n;
    }

    function doImport() {
      var blk = block();
      if (!blk) { setStatusSafe('Navigate to a patch first.'); return; }
      window.electronAPI.loadBlockPresetDialog(cfg.familyFolder, curModelName()).then(function (r) {
        if (!r || r.canceled) return;
        if (!r.ok) { setStatusSafe('Load failed: ' + (r.error || 'unknown error')); return; }
        refreshFolder(function () {
          var v = parseValid(r.bytes);
          if (!v.ok) {
            if (v.kind === 'reject') bpRejectModal(stripExt(r.filename), v.msg);
            else setStatusSafe(v.msg);
            return;
          }
          loadValidated(v.parsed, r.filename, r.path);
        });
      });
    }

    // ── Ring (virtual Original + folder) ──
    function originAvailable() {
      var m = cfg.savedMidNumeric();
      return m !== undefined && m !== null && !isNaN(m);
    }
    function originModelName() { return originAvailable() ? cfg.modelName(cfg.savedMidNumeric()) : null; }
    function includeOrigin() {
      if (!originAvailable()) return false;
      return (st.scope === SCOPE_ALL) || (st.scope === originModelName());
    }
    function buildRing() {
      var origin = includeOrigin() ? [{ origin: true, name: 'Original (' + originModelName() + ')' }] : [];
      st.ring = origin.concat(st.folder);
    }

    function refreshFolder(cb) {
      if (st.scope === null) st.scope = curModelName();
      var model = (st.scope === SCOPE_ALL) ? null : st.scope;
      window.electronAPI.listBlockPresets(cfg.familyFolder, model).then(function (r) {
        st.folder = (r && r.ok && r.files) ? r.files : [];
        buildRing();
        if (st.loadedPath) { syncRingIndex(st.loadedPath); st.onOrigin = false; }
        else { st.ringIndex = includeOrigin() ? 0 : -1; st.onOrigin = includeOrigin(); }
        refreshCaption();
        updateStepperEnabled();
        updateCounter();
        if (typeof cb === 'function') cb();
      });
    }

    function syncRingIndex(fpath) {
      st.ringIndex = -1;
      for (var i = 0; i < st.ring.length; i++) {
        if (!st.ring[i].origin && st.ring[i].path === fpath) { st.ringIndex = i; break; }
      }
      updateStepperEnabled();
      updateCounter();
    }

    function updateCounter() {
      var el = document.getElementById('bp-count-' + K);
      if (!el) return;
      var n = st.ring.length;
      if (!n) { el.textContent = '0 / 0'; return; }
      el.textContent = (st.ringIndex < 0 ? '—' : (st.ringIndex + 1)) + ' / ' + n;
    }

    function updateStepperEnabled() {
      var ready = cfg.baselineReady();
      var hasFiles = st.ring.length > 0;
      ['bp-save-', 'bp-load-', 'bp-scope-', 'bp-sec-'].forEach(function (p) { bpDim(p + K, !ready); });
      bpDim('btn-' + K + '-revert', !ready);
      ['bp-prev-', 'bp-next-', 'bp-auto-'].forEach(function (p) { bpDim(p + K, !ready || !hasFiles); });
      if (!hasFiles) autoStop();   // only one auto-step runs at a time
    }

    // Apply the virtual Original stop = restore the patch's saved state.
    function applyOrigin(idx) {
      if (!cfg.baselineReady()) { setStatusSafe('Original not ready — still reading the patch.'); return; }
      st.ringIndex = idx;
      st.loadedPath = null;
      st.loaded = null;
      st.onOrigin = true;
      clearPresetRef();
      var savedMid = cfg.savedMidNumeric();
      var blk = block();
      var vals = cfg.collectSavedValues(savedMid);
      if (blk && savedMid !== cfg.baseMid(blk.modelId)) {
        st.pendingRestore = { mid: savedMid, values: vals };
        cfg.sendModelChange(savedMid);
      } else {
        applyValueList(vals);
      }
      refreshCaption();
      updateCounter();
    }

    // Step ±1 with WRAP through the ring. Origin is a stop; a file is read +
    // validated. In auto mode a non-loadable file is SKIPPED (one lap, then
    // stop). Manual mode shows a modal on a wrong type.
    function step(dir, opts) {
      if (!st.ring.length) return;
      opts = opts || {};
      var auto = !!opts.auto;
      var n = st.ring.length;
      var fromIdx = (typeof opts.fromIdx === 'number') ? opts.fromIdx : st.ringIndex;
      var tries = (typeof opts.tries === 'number') ? opts.tries : n;
      var idx = (fromIdx < 0) ? (dir > 0 ? 0 : n - 1) : (((fromIdx + dir) % n) + n) % n;
      var entry = st.ring[idx];
      if (entry.origin) {
        if (!cfg.baselineReady()) {
          if (auto && tries > 1) { step(dir, { auto: true, fromIdx: idx, tries: tries - 1 }); return; }
          if (!auto) setStatusSafe('Original not ready — still reading the patch.');
          return;
        }
        applyOrigin(idx); return;
      }
      window.electronAPI.readBlockPresetPath(entry.path).then(function (r) {
        var v = (r && r.ok) ? parseValid(r.bytes) : { ok: false, kind: 'parse', msg: 'Could not read preset.' };
        if (v.ok) { loadValidated(v.parsed, r.filename, entry.path); return; }
        if (auto) {
          if (tries > 1) { step(dir, { auto: true, fromIdx: idx, tries: tries - 1 }); return; }  // skip
          autoStop();
          setStatusSafe('Auto-step stopped — no loadable presets in this scope.');
          return;
        }
        if (v.kind === 'reject') bpRejectModal(entry.name, v.msg);
        else setStatusSafe(v.msg);
      });
    }

    // ── RELOAD (↺) — restore the block to the patch's SAVED state. ──
    function revert() {
      var blk = block();
      if (!blk) return;
      if (!cfg.baselineReady()) { setStatusSafe('Still reading the patch — try Reload in a moment.'); return; }
      clearPresetRef();
      st.loadedPath = null;
      st.onOrigin = true;
      st.ringIndex = includeOrigin() ? 0 : -1;
      updateCounter();
      var savedMid = cfg.savedMidNumeric();
      if (savedMid === undefined || isNaN(savedMid)) { setStatusSafe('No saved state captured yet — open the panel on a patch first.'); return; }
      var vals = cfg.collectSavedValues(savedMid);
      if (savedMid !== cfg.baseMid(blk.modelId)) {
        st.pendingRestore = { mid: savedMid, values: vals };
        cfg.sendModelChange(savedMid);
        setStatusSafe('Reverting ' + cfg.label + ' to the patch\'s saved state…');
        setLoadedName('');
        return;
      }
      var n = applyValueList(vals);
      setLoadedName('');
      setStatusSafe(n ? 'Reverted ' + cfg.label + ' to the patch\'s saved state.' : 'Nothing to revert.');
    }

    // Called from the block's refresh…AfterChainMap after a model switch.
    function onChainRefreshed() {
      if (!bpFeatureEnabled) return false;   // inert → fx-panels runs the dev readback path
      if (st.pendingApply) {
        var p = st.pendingApply; st.pendingApply = null;
        applyParsed(p.parsed, p.filename);   // synchronous → overwrites the default paint, no flash
        return true;
      }
      if (st.pendingRestore) {
        var rest = st.pendingRestore; st.pendingRestore = null;
        var m = applyValueList(rest.values);
        setStatusSafe(m ? 'Reverted ' + cfg.label + ' to the patch\'s saved state.' : 'Reverted ' + cfg.label + ' model.');
        refreshCaption();
        updateCounter();
        return true;
      }
      // Genuine patch nav or manual model change — no preset is "loaded".
      st.loaded = null;
      st.loadedPath = null;
      st.onOrigin = false;
      clearPresetRef();
      autoStop();
      st.scope = curModelName();
      syncScopeSelect();
      refreshFolder();
      refreshCaption();
      return false;
    }

    function onSavedModelKnown() {
      if (!bpFeatureEnabled) return;
      if (st.scope === null) st.scope = curModelName();
      buildRing();
      if (!st.loadedPath) { st.ringIndex = includeOrigin() ? 0 : -1; st.onOrigin = includeOrigin(); }
      else { syncRingIndex(st.loadedPath); }
      updateStepperEnabled();
      updateCounter();
      refreshCaption();
    }

    function onBaselineProgress() { if (!bpFeatureEnabled) return; updateStepperEnabled(); }

    function onPanelOpen() {
      if (!bpFeatureEnabled) return;
      autoStop();
      st.scope = curModelName();
      syncScopeSelect();
      refreshCaption();
      refreshFolder();
    }

    function buildScopeOptions() {
      var sel = document.getElementById('bp-scope-' + K);
      if (!sel) return;
      var opts = cfg.scopeModels().map(function (nm) {
        return '<option value="' + nm.replace(/"/g, '') + '">' + nm + '</option>';
      }).join('');
      sel.innerHTML = opts + '<option value="' + SCOPE_ALL + '">ALL</option>';
    }
    function syncScopeSelect() {
      var sel = document.getElementById('bp-scope-' + K);
      if (sel && st.scope) sel.value = st.scope;
    }

    function initBar() {
      var panel = document.getElementById(cfg.panelId);
      if (!panel || document.getElementById('bp-bar-' + K)) return;
      var bar = buildPresetBar(K, doExport, doImport, step, function (val) {
        st.scope = val;
        st.loadedPath = null;   // pointer meaningless in a different folder
        refreshFolder();
      });
      var knobRow = document.getElementById(cfg.knobRowId);
      if (knobRow) panel.insertBefore(bar, knobRow); else panel.appendChild(bar);
      var rev = document.getElementById('btn-' + K + '-revert');
      if (rev) rev.addEventListener('click', revert);
      buildScopeOptions();
      st.scope = curModelName();
      syncScopeSelect();
      refreshCaption();
      updateAutoBtn(K);
      updateStepperEnabled();
    }

    // Register this block's auto-step hooks.
    AUTO[K] = { step: step, hasFiles: function () { return st.folder.length > 0; }, secId: 'bp-sec-' + K, autoId: 'bp-auto-' + K };

    return {
      initBar: initBar,
      onChainRefreshed: onChainRefreshed,
      tickRef: tickRef,
      onPanelOpen: onPanelOpen,
      onSavedModelKnown: onSavedModelKnown,
      onBaselineProgress: onBaselineProgress,
      refreshCaption: refreshCaption,
      refreshFolder: refreshFolder
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // BLOCK CONFIGS
  // ════════════════════════════════════════════════════════════════════
  var dist = makeBlock({
    key: 'dist', label: 'DIST', lower: 'distortion',
    familyFolder: 'Distortion', families: ['Dstr'],
    rejectMsg: "That's not a distortion preset — DIST can't host it.",
    map: DIST_MAP,
    modelByMid: (typeof DIST_MODEL_BY_MID !== 'undefined') ? DIST_MODEL_BY_MID : {},
    panelId: 'panel-dist', knobRowId: 'dist-knob-row',
    block: function () {
      return (typeof currentChain !== 'undefined' && typeof SLOT_DIST !== 'undefined')
        ? (currentChain.find(function (b) { return b.slotId === SLOT_DIST; }) || null) : null;
    },
    baseMid: function (mid) { return mid; },
    modelName: function (mid) { return (typeof DIST_MODEL_BY_MID !== 'undefined' && DIST_MODEL_BY_MID[mid]) ? DIST_MODEL_BY_MID[mid].name : null; },
    currentModelName: function () {
      var b = (typeof currentChain !== 'undefined' && typeof SLOT_DIST !== 'undefined')
        ? currentChain.find(function (x) { return x.slotId === SLOT_DIST; }) : null;
      return (b && typeof DIST_MODEL_BY_MID !== 'undefined' && DIST_MODEL_BY_MID[b.modelId]) ? DIST_MODEL_BY_MID[b.modelId].name : null;
    },
    knobV127: function (loHex) { var w = document.getElementById('dist-w-' + loHex); return w ? parseInt(w.dataset.value, 10) : undefined; },
    updateKnob: function (lo, v) { if (typeof updateDistKnob === 'function') updateDistKnob(lo, v); },
    sendParamWrite: function (lo, v) { if (typeof sendDistParamWrite === 'function') sendDistParamWrite(lo, v); },
    sendModelChange: function (mid) { if (typeof sendDistModelChange === 'function') sendDistModelChange(mid); },
    scopeModels: function () { return (typeof DIST_MODELS !== 'undefined') ? DIST_MODELS.map(function (m) { return m.name; }) : []; },
    enumSave: function (lo, v127) { return v127; },
    enumLoadV127: function (lo, intVal) { return Math.max(0, Math.min(127, intVal)); },
    baselineReady: function () {
      var b = (typeof currentChain !== 'undefined' && typeof SLOT_DIST !== 'undefined')
        ? currentChain.find(function (x) { return x.slotId === SLOT_DIST; }) : null;
      var model = (b && typeof DIST_MODEL_BY_MID !== 'undefined') ? DIST_MODEL_BY_MID[b.modelId] : null;
      if (!model) return false;
      var base = (typeof blockModelBaseline !== 'undefined' && blockModelBaseline[SLOT_DIST]) ? blockModelBaseline[SLOT_DIST][model.mid] : null;
      if (!base) return false;
      return model.paramLos.every(function (lo) { return base[hex(lo)] !== undefined; });
    },
    savedMidNumeric: function () { return (typeof blockSavedModel !== 'undefined') ? blockSavedModel[SLOT_DIST] : undefined; },
    collectSavedValues: function (savedMid) {
      var base = (typeof blockModelBaseline !== 'undefined' && blockModelBaseline[SLOT_DIST]) ? (blockModelBaseline[SLOT_DIST][savedMid] || {}) : {};
      return Object.keys(base).map(function (loHex) { return { lo: parseInt(loHex, 16), v127: base[loHex] }; });
    }
  });

  var reverb = makeBlock({
    key: 'reverb', label: 'REVERB', lower: 'reverb',
    familyFolder: 'Reverb', families: ['Rvrb', 'Sprn'],
    rejectMsg: "That's not a reverb preset — REVERB can't host it.",
    map: REVERB_MAP,
    modelByMid: (typeof REVERB_MODEL_BY_MID !== 'undefined') ? REVERB_MODEL_BY_MID : {},
    panelId: 'panel-reverb', knobRowId: 'reverb-knob-row',
    block: function () {
      return (typeof currentChain !== 'undefined' && typeof SLOT_REVERB !== 'undefined')
        ? (currentChain.find(function (b) { return b.slotId === SLOT_REVERB; }) || null) : null;
    },
    baseMid: function (mid) { var m = (typeof REVERB_MODEL_BY_MID !== 'undefined') ? REVERB_MODEL_BY_MID[mid] : null; return m ? m.mid : mid; },
    modelName: function (mid) { var m = (typeof REVERB_MODEL_BY_MID !== 'undefined') ? REVERB_MODEL_BY_MID[mid] : null; return m ? m.name : null; },
    currentModelName: function () {
      var b = (typeof currentChain !== 'undefined' && typeof SLOT_REVERB !== 'undefined')
        ? currentChain.find(function (x) { return x.slotId === SLOT_REVERB; }) : null;
      var m = (b && typeof REVERB_MODEL_BY_MID !== 'undefined') ? REVERB_MODEL_BY_MID[b.modelId] : null;
      return m ? m.name : null;
    },
    knobV127: function (loHex) { var w = document.getElementById('reverb-w-' + loHex); return w ? parseInt(w.dataset.value, 10) : undefined; },
    updateKnob: function (lo, v) { if (typeof updateReverbKnob === 'function') updateReverbKnob(lo, v, false); },   // non-interactive: never trips the Type sub-cache
    sendParamWrite: function (lo, v) { if (typeof sendReverbParamWrite === 'function') sendReverbParamWrite(lo, v); },
    sendModelChange: function (mid) { if (typeof sendReverbModelChange === 'function') sendReverbModelChange(mid); },
    scopeModels: function () { return (typeof REVERB_MODELS !== 'undefined') ? REVERB_MODELS.map(function (m) { return m.name; }) : []; },
    enumSave: function (lo, v127) { return (typeof reverbTypeIndexFromV127 === 'function') ? reverbTypeIndexFromV127(v127) : v127; },
    enumLoadV127: function (lo, intVal) {
      if (typeof REVERB_TYPE_LIST === 'undefined') return Math.max(0, Math.min(127, intVal));
      var i = Math.max(0, Math.min(REVERB_TYPE_LIST.length - 1, intVal | 0));
      return REVERB_TYPE_LIST[i].v127;
    },
    applyOrder: function (bmid, applied) {
      var model = (typeof REVERB_MODEL_BY_MID !== 'undefined') ? REVERB_MODEL_BY_MID[bmid] : null;
      if (!model || !model.typeControl) return applied;
      var t = [], rest = [];
      applied.forEach(function (a) { if (a.lo === model.typeControl.lo) t.push(a); else rest.push(a); });
      return t.concat(rest);
    },
    baselineReady: function () {
      var b = (typeof currentChain !== 'undefined' && typeof SLOT_REVERB !== 'undefined')
        ? currentChain.find(function (x) { return x.slotId === SLOT_REVERB; }) : null;
      var model = (b && typeof REVERB_MODEL_BY_MID !== 'undefined') ? REVERB_MODEL_BY_MID[b.modelId] : null;
      if (!model) return false;
      var bm = (typeof blockModelBaseline !== 'undefined') ? (blockModelBaseline[SLOT_REVERB] || {}) : {};
      return model.paramLos.every(function (lo) {
        var key = (typeof reverbBaselineKey === 'function') ? reverbBaselineKey(model, lo) : String(model.mid);
        var base = bm[key];
        return base && base[hex(lo)] !== undefined;
      });
    },
    savedMidNumeric: function () {
      if (typeof blockSavedModel === 'undefined') return undefined;
      var s = blockSavedModel[SLOT_REVERB];
      return (s === undefined) ? undefined : parseInt(s, 10);
    },
    collectSavedValues: function (savedMid) {
      var out = [];
      var model = (typeof REVERB_MODEL_BY_MID !== 'undefined') ? REVERB_MODEL_BY_MID[savedMid] : null;
      var bm = (typeof blockModelBaseline !== 'undefined') ? (blockModelBaseline[SLOT_REVERB] || {}) : {};
      if (model && model.typeControl) {
        // Type value is keyed under the outer model mid; the knob values under
        // the SAVED Type's key (reverbLoadTypeKey, set on patch load). Type first.
        var byMid = bm[String(savedMid)] || {};
        var tHex = hex(model.typeControl.lo);
        if (byMid[tHex] !== undefined) out.push({ lo: model.typeControl.lo, v127: byMid[tHex] });
        var knobs = (typeof reverbLoadTypeKey !== 'undefined' && reverbLoadTypeKey && bm[reverbLoadTypeKey]) ? bm[reverbLoadTypeKey] : {};
        Object.keys(knobs).forEach(function (loHex) { out.push({ lo: parseInt(loHex, 16), v127: knobs[loHex] }); });
      } else {
        var byMid2 = bm[String(savedMid)] || {};
        Object.keys(byMid2).forEach(function (loHex) { out.push({ lo: parseInt(loHex, 16), v127: byMid2[loHex] }); });
      }
      return out;
    }
  });

  var delay = makeBlock({
    key: 'delay', label: 'DELAY', lower: 'delay',
    familyFolder: 'Delay', families: ['DyDl', 'EcPl', 'MeMn'],
    rejectMsg: "That's not a delay preset — DELAY can't host it.",
    map: DELAY_MAP,
    modelByMid: (typeof DELAY_MODEL_BY_MID !== 'undefined') ? DELAY_MODEL_BY_MID : {},
    panelId: 'panel-delay', knobRowId: 'delay-knob-row',
    block: function () {
      return (typeof currentChain !== 'undefined' && typeof SLOT_DELAY !== 'undefined')
        ? (currentChain.find(function (b) { return b.slotId === SLOT_DELAY; }) || null) : null;
    },
    baseMid: function (mid) { var m = (typeof DELAY_MODEL_BY_MID !== 'undefined') ? DELAY_MODEL_BY_MID[mid] : null; return m ? m.mid : mid; },
    modelName: function (mid) { var m = (typeof DELAY_MODEL_BY_MID !== 'undefined') ? DELAY_MODEL_BY_MID[mid] : null; return m ? m.name : null; },
    currentModelName: function () {
      var b = (typeof currentChain !== 'undefined' && typeof SLOT_DELAY !== 'undefined')
        ? currentChain.find(function (x) { return x.slotId === SLOT_DELAY; }) : null;
      var m = (b && typeof DELAY_MODEL_BY_MID !== 'undefined') ? DELAY_MODEL_BY_MID[b.modelId] : null;
      return m ? m.name : null;
    },
    knobV127: function (loHex) { var w = document.getElementById('delay-w-' + loHex); return w ? parseInt(w.dataset.value, 10) : undefined; },
    updateKnob: function (lo, v) { if (typeof updateDelayKnob === 'function') updateDelayKnob(lo, v); },
    sendParamWrite: function (lo, v) { if (typeof sendDelayParamWrite === 'function') sendDelayParamWrite(lo, v); },
    sendModelChange: function (mid) { if (typeof sendDelayModelChange === 'function') sendDelayModelChange(mid); },
    scopeModels: function () { return (typeof DELAY_MODELS !== 'undefined') ? DELAY_MODELS.map(function (m) { return m.name; }) : []; },
    enumSave: function (lo, v127) { return v127; },                                  // unused — every delay field carries enc
    enumLoadV127: function (lo, intVal) { return Math.max(0, Math.min(127, intVal)); },
    applyOrder: function (bmid, applied) {
      // Enum/toggle/sync params first — Sync must go OFF before the Delay knob
      // (the rack refuses a Delay write while Sync sits on a division).
      var entry = DELAY_MAP[bmid]; if (!entry) return applied;
      var ls = [], ds = [];
      applied.forEach(function (a) { var f = entry.params[a.lo]; if (f && f.type === 'l') ls.push(a); else ds.push(a); });
      return ls.concat(ds);
    },
    baselineReady: function () {
      var b = (typeof currentChain !== 'undefined' && typeof SLOT_DELAY !== 'undefined')
        ? currentChain.find(function (x) { return x.slotId === SLOT_DELAY; }) : null;
      var model = (b && typeof DELAY_MODEL_BY_MID !== 'undefined') ? DELAY_MODEL_BY_MID[b.modelId] : null;
      if (!model) return false;
      var base = (typeof delayModelBaseline !== 'undefined') ? delayModelBaseline[model.mid] : null;
      if (!base) return false;
      return model.paramLos.every(function (lo) { return base[hex(lo)] !== undefined; });
    },
    savedMidNumeric: function () { return (typeof delaySavedModel !== 'undefined') ? delaySavedModel : undefined; },
    collectSavedValues: function (savedMid) {
      var base = (typeof delayModelBaseline !== 'undefined') ? (delayModelBaseline[savedMid] || {}) : {};
      return Object.keys(base).map(function (loHex) { return { lo: parseInt(loHex, 16), v127: base[loHex] }; });
    }
  });

  function initPresetBars() {
    bpLoadEnabled();
    dist.initBar();
    reverb.initBar();
    delay.initBar();
    var cb = document.getElementById('bp-enable-checkbox');
    if (cb) { cb.checked = bpFeatureEnabled; cb.addEventListener('change', function () { bpSetEnabled(cb.checked); }); }
    // Hide the bars + RELOAD buttons when the feature is off (default). Don't
    // call bpApplyEnabled's enable-side refresh here — just set visibility.
    ['dist', 'reverb', 'delay'].forEach(function (K) {
      var bar = document.getElementById('bp-bar-' + K);
      if (bar) bar.style.display = bpFeatureEnabled ? '' : 'none';
      var rev = document.getElementById('btn-' + K + '-revert');
      if (rev) rev.style.display = bpFeatureEnabled ? '' : 'none';
    });
  }

  // ── Public API (per-block hooks the app calls) ──────────────────────
  window.blockPresets = {
    init: initPresetBars,
    // DIST
    onDistChainRefreshed: dist.onChainRefreshed,
    distTickRef: dist.tickRef,
    onDistPanelOpen: dist.onPanelOpen,
    onDistSavedModelKnown: dist.onSavedModelKnown,
    onDistBaselineProgress: dist.onBaselineProgress,
    // REVERB
    onReverbChainRefreshed: reverb.onChainRefreshed,
    reverbTickRef: reverb.tickRef,
    onReverbPanelOpen: reverb.onPanelOpen,
    onReverbSavedModelKnown: reverb.onSavedModelKnown,
    onReverbBaselineProgress: reverb.onBaselineProgress,
    // DELAY
    onDelayChainRefreshed: delay.onChainRefreshed,
    delayTickRef: delay.tickRef,
    onDelayPanelOpen: delay.onPanelOpen,
    onDelaySavedModelKnown: delay.onSavedModelKnown,
    onDelayBaselineProgress: delay.onBaselineProgress,
    // generic
    refreshCaption: function (k) { (k === 'reverb' ? reverb : k === 'delay' ? delay : dist).refreshCaption(); },
    refreshFolder: function (k) { (k === 'reverb' ? reverb : k === 'delay' ? delay : dist).refreshFolder(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPresetBars);
  } else {
    initPresetBars();
  }
})();
