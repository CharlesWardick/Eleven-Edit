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
//   12..15 family code (4 chars):  Dstr Rvrb Flng MCho DyDl "PEQ "
//   16..18 model code (3 chars):   TS8 SR2 GF2 MC2 AD2 PE2   (+ constant "uelck")
//   ~24    "Complete Controls State" + 00 padding
//   then, after a 01 01 01 01 marker: repeating 12-byte-ish param records:
//       6-byte name ("d_Xxxx"=float, "l_Xxxx"=int) + 2 pad + 4-byte value.
//   (Records scan by their d_/l_ name marker, robust to trailing padding.)
//
// SCOPE (this build): DISTORTION end-to-end. The Green JRC Overdrive (Avid
// "TS8", params Driv/Tone/Levl) is VERIFIED from a real sample. The other
// four DIST models' exact Avid codes/param names are UNVERIFIED (need one
// Avid export each) — import/export falls back to positional mapping for
// them, which round-trips within EE exactly but may not match Avid names.
//
// VALUE SCALE: the d_ float is a control POSITION on each knob's own scale,
// not the readout. Per Charlie's scope: EE round-trip must be EXACT (free —
// EE owns both ends via one reversible map), foreign import only "close
// enough". The float<->v127 map is isolated in bpFloatToV127 / bpV127ToFloat
// below with a provisional linear scale — tune after a hardware reading.
// ════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  var MAGIC = 'Digi';
  var STATE_LABEL = 'Complete Controls State';

  // ── EE block ⇄ Avid file identity ──────────────────────────────────
  // Each entry: the Avid family/model codes for an EE model mid, plus the
  // per-paramLo file field {name, type}. type 'd' = float, 'l' = int enum.
  // VERIFIED entries come from real sample files; others are provisional.
  //
  // DIST models (mids 0x17..0x1B). Only Green JRC is verified.
  // Param field names are the FULL 6-char record name (prefix + 4 chars),
  // matching what the parser extracts and what Avid writes: 'd_'+abbrev
  // (float) or 'l_'+abbrev (int enum).
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

  // Which EE block a family code can be hosted by, and how to reach that
  // block (slot + the getter/setters already in the app). This is the
  // per-block CAPABILITY gate: import only succeeds if the file's family is
  // hostable here. DIST is the only wired block this build.
  var BLOCKS = {
    dist: {
      slotName: 'SLOT_DIST',
      families: ['Dstr'],
      modelMap: DIST_MAP,
      subfolder: 'Distortion'
    }
  };

  // ── Provisional value scale per family (see header). Linear:
  //   v127 0..127  ⇄  float BP_SCALE[family].lo .. hi
  // EE uses these constants BOTH ways, so EE round-trip is exact regardless
  // of whether lo/hi match Avid. Tune lo/hi after a hardware reading to make
  // foreign imports land right. ────────────────────────────────────────
  var BP_SCALE = {
    Dstr: { lo: 0.0, hi: 4.0 }   // provisional — Benoni Green JRC floats sit ~2.5
  };

  function bpFloatToV127(family, f) {
    var s = BP_SCALE[family] || { lo: 0.0, hi: 4.0 };
    var v = Math.round((f - s.lo) / (s.hi - s.lo) * 127);
    return Math.max(0, Math.min(127, v));
  }
  function bpV127ToFloat(family, v127) {
    var s = BP_SCALE[family] || { lo: 0.0, hi: 4.0 };
    return s.lo + (v127 / 127) * (s.hi - s.lo);
  }

  // ── Low-level byte helpers ─────────────────────────────────────────
  // d_ values are 8-byte big-endian DOUBLES; l_ values are 4-byte big-endian
  // ints. (Confirmed byte-identical round-trip against Avid-authored files.)
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

  // ── Parse a block-preset file → { family, code, params:[{name,type,value}] } ──
  function parsePreset(bytes) {
    if (bytes.length < 24) return { ok: false, error: 'File too small to be a preset.' };
    var magic = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (magic !== MAGIC) return { ok: false, error: 'Not an Eleven Rack effect preset.' };
    var family = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    var code = String.fromCharCode(bytes[16], bytes[17], bytes[18]);
    // Scan for d_/l_ named records. d_ record = 6 name + 2 pad + 8 double
    // (16 bytes); l_ record = 6 name + 2 pad + 4 int (12 bytes).
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
    // header: length placeholder + FF*4 + "Digi" + family(4) + code(3) + "uelck"
    out.push(0, 0, 0, 0);
    out.push(0xFF, 0xFF, 0xFF, 0xFF);
    out = out.concat(ascii(MAGIC));
    out = out.concat(ascii((family + '    ').substring(0, 4)));
    out = out.concat(ascii((code + '   ').substring(0, 3)));
    out = out.concat(ascii('uelck'));
    out = out.concat(ascii(STATE_LABEL));
    // padding + 01 01 01 01 marker (match Avid's spacing: pad to a 0x3C-ish
    // boundary then the marker). Avid files show the marker at offset 56.
    while (out.length < 56) out.push(0);
    out.push(0x01, 0x01, 0x01, 0x01);
    // records: 6-byte name + 2 pad + 4 value
    params.forEach(function (pm) {
      out = out.concat(ascii((pm.name + '      ').substring(0, 6)));   // exactly 6-byte name
      out.push(0, 0);
      if (pm.type === 'd') putBEDouble(out, pm.value); else putBEInt(out, pm.value | 0);
    });
    // write total length
    var len = out.length;
    out[0] = (len >>> 24) & 0xFF; out[1] = (len >>> 16) & 0xFF;
    out[2] = (len >>> 8) & 0xFF;  out[3] = len & 0xFF;
    return out;
  }

  // ── DIST block accessors ───────────────────────────────────────────
  function distBlock() {
    if (typeof currentChain === 'undefined' || typeof SLOT_DIST === 'undefined') return null;
    return currentChain.find(function (b) { return b.slotId === SLOT_DIST; }) || null;
  }
  function distKnobV127(loHex) {
    var w = document.getElementById('dist-w-' + loHex);
    return w ? parseInt(w.dataset.value, 10) : undefined;
  }
  function distKnobOrig(loHex) {
    var w = document.getElementById('dist-w-' + loHex);
    return (w && w.dataset.orig !== undefined && w.dataset.orig !== '') ? parseInt(w.dataset.orig, 10) : undefined;
  }

  // ── EXPORT: current DIST block → file ──────────────────────────────
  function exportDist() {
    var blk = distBlock();
    if (!blk) { setStatus && setStatus('No DIST block to save.'); return; }
    var map = DIST_MAP[blk.modelId];
    var model = (typeof DIST_MODEL_BY_MID !== 'undefined') ? DIST_MODEL_BY_MID[blk.modelId] : null;
    if (!map || !model) { setStatus && setStatus('This distortion model has no preset mapping yet.'); return; }

    var params = [];
    model.paramLos.forEach(function (lo) {
      var field = map.params[lo];
      if (!field) return;
      var loHex = lo.toString(16).padStart(2, '0');
      var v127 = distKnobV127(loHex);
      if (v127 === undefined || isNaN(v127)) return;
      if (field.type === 'l') params.push({ name: field.name, type: 'l', value: v127 });
      else params.push({ name: field.name, type: 'd', value: bpV127ToFloat(map.family, v127) });
    });
    if (!params.length) { setStatus && setStatus('No values to save (open the panel first).'); return; }

    var bytes = serializePreset(map.family, map.code, params);
    var suggest = (model.name || 'Distortion');
    window.electronAPI.saveBlockPreset(BLOCKS.dist.subfolder, suggest, bytes).then(function (r) {
      if (r && r.ok) {
        bpSetLoadedName('dist', r.filename.replace(/\.tfx$/i, ''));
        setStatus && setStatus('Saved preset: ' + r.filename);
      } else if (r && !r.canceled) {
        setStatus && setStatus('Save failed: ' + (r.error || 'unknown error'));
      }
    });
  }

  // ── IMPORT: file → current DIST block ──────────────────────────────
  function importDist() {
    var blk = distBlock();
    if (!blk) { setStatus && setStatus('Navigate to a patch first.'); return; }
    window.electronAPI.loadBlockPresetDialog(BLOCKS.dist.subfolder).then(function (r) {
      if (!r || r.canceled) return;
      if (!r.ok) { setStatus && setStatus('Load failed: ' + (r.error || 'unknown error')); return; }
      var parsed = parsePreset(r.bytes);
      if (!parsed.ok) { setStatus && setStatus(parsed.error); return; }
      // Capability gate: DIST hosts only the Dstr family.
      if (BLOCKS.dist.families.indexOf(parsed.family) < 0) {
        setStatus && setStatus("That's not a distortion preset — DIST can't host it. Nothing changed.");
        return;
      }
      // Find the EE mid for this file's model code (auto-switch target).
      var targetMid = null;
      for (var mid in DIST_MAP) { if (DIST_MAP[mid].code === parsed.code) { targetMid = parseInt(mid, 10); break; } }
      var cur = distBlock();
      if (targetMid !== null && cur && cur.modelId !== targetMid) {
        // Auto-switch the DIST model, then apply once the new chain map arrives.
        bpPendingApply = { blk: 'dist', parsed: parsed, mid: targetMid, filename: r.filename };
        if (typeof sendDistModelChange === 'function') sendDistModelChange(targetMid);
        setStatus && setStatus('Switching DIST to load "' + r.filename.replace(/\.tfx$/i, '') + '"…');
        return;
      }
      applyDistParsed(parsed, r.filename);
    });
  }

  // Apply parsed params to whatever DIST model is currently loaded.
  function applyDistParsed(parsed, filename) {
    var blk = distBlock();
    if (!blk) return;
    var map = DIST_MAP[blk.modelId];
    if (!map) { setStatus && setStatus('No mapping for this distortion model.'); return; }
    // Build name→lo (verified) and an ordered lo list (positional fallback).
    var nameToLo = {};
    Object.keys(map.params).forEach(function (lo) { nameToLo[map.params[lo].name] = parseInt(lo, 10); });
    var orderedLos = Object.keys(map.params).map(function (x) { return parseInt(x, 10); }).sort(function (a, b) { return a - b; });

    var applied = 0, posIdx = 0;
    parsed.params.forEach(function (pm) {
      var lo = nameToLo[pm.name];
      if (lo === undefined) { lo = orderedLos[posIdx]; }   // positional fallback
      posIdx++;
      if (lo === undefined) return;
      var field = map.params[lo];
      var v127 = (pm.type === 'l' || (field && field.type === 'l'))
        ? Math.max(0, Math.min(127, pm.value | 0))
        : bpFloatToV127(map.family, pm.value);
      if (typeof updateDistKnob === 'function') updateDistKnob(lo, v127);
      if (typeof sendDistParamWrite === 'function') sendDistParamWrite(lo, v127);
      applied++;
    });
    bpSetLoadedName('dist', filename.replace(/\.tfx$/i, ''));
    setStatus && setStatus('Loaded "' + filename.replace(/\.tfx$/i, '') + '"'
      + (applied ? '' : ' (no matching parameters).'));
  }

  // Apply a {loHex: v127} baseline map to the current DIST model.
  function applyDistValues(valuesByLoHex) {
    var n = 0;
    Object.keys(valuesByLoHex).forEach(function (loHex) {
      var loNum = parseInt(loHex, 16), v = valuesByLoHex[loHex];
      if (v === undefined || isNaN(v)) return;
      if (typeof updateDistKnob === 'function') updateDistKnob(loNum, v);
      if (typeof sendDistParamWrite === 'function') sendDistParamWrite(loNum, v);
      n++;
    });
    return n;
  }

  // ── REVERT: restore the DIST block to the patch's SAVED state — the saved
  // model and its baseline knob values (blockSavedModel / blockModelBaseline,
  // reset only on patch nav / Save). Undoes a manual model switch, knob
  // edits, and preset loads alike. ──────────────────────────────────────
  function revertDist() {
    var blk = distBlock();
    if (!blk) return;
    var savedMid = (typeof blockSavedModel !== 'undefined' && typeof SLOT_DIST !== 'undefined')
      ? blockSavedModel[SLOT_DIST] : undefined;
    if (savedMid === undefined) { setStatus && setStatus('No saved state captured yet — open the panel on a patch first.'); return; }
    var baseline = (typeof blockModelBaseline !== 'undefined' && blockModelBaseline[SLOT_DIST])
      ? blockModelBaseline[SLOT_DIST][savedMid] : null;
    if (savedMid !== blk.modelId) {
      // Model was switched — switch back, then apply the saved knobs.
      bpPendingRestore = { mid: savedMid, values: baseline || {} };
      if (typeof sendDistModelChange === 'function') sendDistModelChange(savedMid);
      setStatus && setStatus('Reverting DIST to the patch\'s saved state…');
      bpSetLoadedName('dist', '');
      return;
    }
    var n = baseline ? applyDistValues(baseline) : 0;
    bpSetLoadedName('dist', '');
    setStatus && setStatus(n ? 'Reverted DIST to the patch\'s saved state.' : 'Nothing to revert.');
  }

  // Pending work completed by the model-change readback hook.
  var bpPendingApply = null;     // apply a parsed file after auto-switch (import)
  var bpPendingRestore = null;   // apply saved knobs after switch-back (revert)
  // Called from fx-panels.js refreshDistPanelAfterChainMap after a switch.
  function bpOnDistChainRefreshed() {
    if (bpPendingApply && bpPendingApply.blk === 'dist') {
      var pend = bpPendingApply; bpPendingApply = null;
      setTimeout(function () { applyDistParsed(pend.parsed, pend.filename); }, 60);
    } else if (bpPendingRestore) {
      var rest = bpPendingRestore; bpPendingRestore = null;
      setTimeout(function () {
        var m = applyDistValues(rest.values);
        setStatus && setStatus(m ? 'Reverted DIST to the patch\'s saved state.' : 'Reverted DIST model.');
      }, 60);
    }
  }

  // ── PRESET bar UI (injected into each wired panel) ─────────────────
  function bpSetLoadedName(blkKey, name) {
    var el = document.getElementById('bp-name-' + blkKey);
    if (el) el.innerHTML = name ? ('Loaded: <b>' + name + '</b>') : 'Loaded: <b>—</b>';
  }

  function buildPresetBar(blkKey, onSave, onLoad, onRevert) {
    var bar = document.createElement('div');
    bar.className = 'preset-bar';
    bar.id = 'bp-bar-' + blkKey;
    bar.innerHTML =
      '<span class="preset-tag">PRESET</span>'
      + '<button class="bt-btn" id="bp-save-' + blkKey + '">SAVE PRESET</button>'
      + '<button class="bt-btn" id="bp-load-' + blkKey + '">LOAD PRESET</button>'
      + '<button class="bt-btn" id="bp-revert-' + blkKey + '" title="Restore this block to the patch\'s saved state">↺ REVERT</button>'
      + '<span class="pname" id="bp-name-' + blkKey + '">Loaded: <b>—</b></span>';
    bar.querySelector('#bp-save-' + blkKey).addEventListener('click', onSave);
    bar.querySelector('#bp-load-' + blkKey).addEventListener('click', onLoad);
    bar.querySelector('#bp-revert-' + blkKey).addEventListener('click', onRevert);
    return bar;
  }

  function initPresetBars() {
    var distPanel = document.getElementById('panel-dist');
    if (distPanel && !document.getElementById('bp-bar-dist')) {
      distPanel.appendChild(buildPresetBar('dist', exportDist, importDist, revertDist));
    }
  }

  // Expose the hooks other modules call.
  window.blockPresets = {
    init: initPresetBars,
    onDistChainRefreshed: bpOnDistChainRefreshed
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPresetBars);
  } else {
    initPresetBars();
  }
})();
