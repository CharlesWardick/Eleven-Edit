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
      familyFolder: 'Distortion'   // Presets/Distortion/<Model>/
    }
  };

  // ── Provisional value scale per family (see header). Linear:
  //   v127 0..127  ⇄  float BP_SCALE[family].lo .. hi
  // EE uses these constants BOTH ways, so EE round-trip is exact regardless
  // of whether lo/hi match Avid. Tune lo/hi after a hardware reading to make
  // foreign imports land right. ────────────────────────────────────────
  // Distortion stores the actual 0.0–10.0 knob value (confirmed from Benoni
  // Green JRC presets: Drive 9.65 / Tone 9.15 / Level 7.93 …), so v127 maps
  // linearly to 0–10. Exact for EE round-trip; close for foreign presets.
  var BP_SCALE = {
    Dstr: { lo: 0.0, hi: 10.0 }
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
  function distModelName(mid) {
    return (typeof DIST_MODEL_BY_MID !== 'undefined' && DIST_MODEL_BY_MID[mid]) ? DIST_MODEL_BY_MID[mid].name : null;
  }
  function distCurrentModelName() {
    var b = distBlock();
    return b ? distModelName(b.modelId) : null;
  }

  // Scope = which folder the stepper + auto-step cycle. A model name, or the
  // ALL sentinel (recursive over every model subfolder). Defaults to the
  // current block model; reset on patch nav / manual model change.
  var SCOPE_ALL = '__ALL__';
  var distScope = null;   // model name or SCOPE_ALL; null = not yet initialised

  // ── EXPORT: current DIST block → file ──────────────────────────────
  function exportDist() {
    var blk = distBlock();
    if (!blk) { setStatus && setStatus('No DIST block to save.'); return; }
    var map = DIST_MAP[blk.modelId];
    var model = (typeof DIST_MODEL_BY_MID !== 'undefined') ? DIST_MODEL_BY_MID[blk.modelId] : null;
    if (!map || !model) { setStatus && setStatus('This distortion model has no preset mapping yet.'); return; }
    if (!distBaselineReady()) { setStatus && setStatus('Still reading the patch — try Save again in a moment.'); return; }

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
    // Save defaults into this model's own subfolder.
    window.electronAPI.saveBlockPreset(BLOCKS.dist.familyFolder, model.name, suggest, bytes).then(function (r) {
      if (r && r.ok) {
        bpSetLoadedName('dist', r.filename.replace(/\.tfx$/i, ''));
        bpLoadedPath.dist = r.path;
        setStatus && setStatus('Saved preset: ' + r.filename);
        distRefreshFolder();   // new file may have appeared; re-point the stepper
      } else if (r && !r.canceled) {
        setStatus && setStatus('Save failed: ' + (r.error || 'unknown error'));
      }
    });
  }

  // ── IMPORT: file → current DIST block ──────────────────────────────
  // Shared loader for a preset's bytes (used by the LOAD dialog and the +/-
  // stepper). Parses, gates on capability, auto-switches the model if needed,
  // then applies. On success, syncs the folder pointer to this file.
  // Parse + capability check. {ok:true, parsed} | {ok:false, kind:'parse'|'reject', msg}.
  function bpParseValid(bytes) {
    var parsed = parsePreset(bytes);
    if (!parsed.ok) return { ok: false, kind: 'parse', msg: parsed.error };
    if (BLOCKS.dist.families.indexOf(parsed.family) < 0)
      return { ok: false, kind: 'reject', msg: "That's not a distortion preset — DIST can't host it." };
    return { ok: true, parsed: parsed };
  }

  // Prominent modal for a deliberate (manual) wrong-type load.
  function bpRejectModal(name, msg) {
    if (typeof showModalMessage === 'function') {
      showModalMessage("Can't load this preset",
        '<div style="padding:4px 2px;line-height:1.5;">' + (msg || "This block can't host that preset.")
        + (name ? ('<br><br>File: <b>' + name + '</b>') : '') + '</div>');
    } else if (setStatus) { setStatus(msg); }
  }

  // Apply an already-validated preset (auto-switch model if needed, then set).
  function loadDistValidated(parsed, filename, fpath) {
    if (fpath) { bpLoadedPath.dist = fpath; distSyncRingIndex(fpath); }
    var targetMid = null;
    for (var mid in DIST_MAP) { if (DIST_MAP[mid].code === parsed.code) { targetMid = parseInt(mid, 10); break; } }
    var cur = distBlock();
    if (targetMid !== null && cur && cur.modelId !== targetMid) {
      bpPendingApply = { blk: 'dist', parsed: parsed, mid: targetMid, filename: filename };
      if (typeof sendDistModelChange === 'function') sendDistModelChange(targetMid);
      setStatus && setStatus('Switching DIST to load "' + filename.replace(/\.tfx$/i, '') + '"…');
      return;
    }
    applyDistParsed(parsed, filename);
  }

  function importDist() {
    var blk = distBlock();
    if (!blk) { setStatus && setStatus('Navigate to a patch first.'); return; }
    // Default the dialog into the current model's folder.
    window.electronAPI.loadBlockPresetDialog(BLOCKS.dist.familyFolder, distCurrentModelName()).then(function (r) {
      if (!r || r.canceled) return;
      if (!r.ok) { setStatus && setStatus('Load failed: ' + (r.error || 'unknown error')); return; }
      distRefreshFolder(function () {
        var v = bpParseValid(r.bytes);
        if (!v.ok) {
          if (v.kind === 'reject') bpRejectModal(r.filename.replace(/\.tfx$/i, ''), v.msg);
          else setStatus && setStatus(v.msg);
          return;
        }
        loadDistValidated(v.parsed, r.filename, r.path);
      });
    });
  }

  // ── +/- stepper + auto-step: cycle the SCOPE's RING ──────────────────
  // The ring = an optional virtual "Original" stop (the patch's saved state,
  // i.e. the RELOAD target) at the front, then the scope folder's files. So a
  // cycle is  Original → preset1 → … → presetN → Original …  and your starting
  // tone comes back around. Origin is included only when the scope is the
  // patch's own model or ALL (not when auditioning a different single type).
  var distFolder = [];        // [{name, path, model}] sorted (Windows order)
  var distRing = [];          // [ {origin:true} ? ] + distFolder
  var distRingIndex = -1;     // pointer into distRing

  function distOriginAvailable() {
    return (typeof blockSavedModel !== 'undefined' && typeof SLOT_DIST !== 'undefined'
      && blockSavedModel[SLOT_DIST] !== undefined);
  }
  function distOriginModelName() {
    return distOriginAvailable() ? distModelName(blockSavedModel[SLOT_DIST]) : null;
  }
  function distIncludeOrigin() {
    if (!distOriginAvailable()) return false;
    return (distScope === SCOPE_ALL) || (distScope === distOriginModelName());
  }
  function distBuildRing() {
    var origin = distIncludeOrigin()
      ? [{ origin: true, name: 'Original (' + distOriginModelName() + ')' }] : [];
    distRing = origin.concat(distFolder);
  }

  // Reload the scope's folder listing + rebuild the ring, then run cb.
  function distRefreshFolder(cb) {
    if (distScope === null) distScope = distCurrentModelName();   // default = current model
    var model = (distScope === SCOPE_ALL) ? null : distScope;
    window.electronAPI.listBlockPresets(BLOCKS.dist.familyFolder, model).then(function (r) {
      distFolder = (r && r.ok && r.files) ? r.files : [];
      distBuildRing();
      if (bpLoadedPath.dist) { distSyncRingIndex(bpLoadedPath.dist); distOnOrigin = false; }
      else { distRingIndex = distIncludeOrigin() ? 0 : -1; distOnOrigin = distIncludeOrigin(); }
      bpRefreshCaption('dist');
      updateDistStepperEnabled();
      updateDistCounter();
      if (typeof cb === 'function') cb();
    });
  }

  // Point the ring index at the file with this exact path (origin has no path).
  function distSyncRingIndex(fpath) {
    distRingIndex = -1;
    for (var i = 0; i < distRing.length; i++) {
      if (!distRing[i].origin && distRing[i].path === fpath) { distRingIndex = i; break; }
    }
    updateDistStepperEnabled();
    updateDistCounter();
  }

  // The block's baseline is "ready" once every paramLo of the current model
  // has been read back for this patch. Until then the bar is disabled — a load
  // / Original / Save against a half-read baseline moves the wrong knobs.
  function distBaselineReady() {
    var blk = distBlock();
    var model = (blk && typeof DIST_MODEL_BY_MID !== 'undefined') ? DIST_MODEL_BY_MID[blk.modelId] : null;
    if (!model) return false;
    var base = (typeof blockModelBaseline !== 'undefined' && blockModelBaseline[SLOT_DIST])
      ? blockModelBaseline[SLOT_DIST][blk.modelId] : null;
    if (!base) return false;
    return model.paramLos.every(function (lo) {
      return base[lo.toString(16).padStart(2, '0')] !== undefined;
    });
  }

  function bpDim(id, off) {
    var b = document.getElementById(id);
    if (b) { b.disabled = off; b.classList.toggle('bp-disabled', off); }
  }

  function updateDistStepperEnabled() {
    var ready = distBaselineReady();
    var hasFiles = distRing.length > 0;
    // These need a fully-read baseline (Save/Load/Reload/scope/interval).
    ['bp-save-dist', 'bp-load-dist', 'bp-scope-dist', 'bp-sec-dist', 'btn-dist-revert'].forEach(function (id) {
      bpDim(id, !ready);
    });
    // Stepper + auto also need presets in the ring.
    ['bp-prev-dist', 'bp-next-dist', 'bp-auto-dist'].forEach(function (id) {
      bpDim(id, !ready || !hasFiles);
    });
    // Only stop a running auto-step when the ring truly empties — NOT on the
    // transient not-ready during a cross-model apply (baseline fills in the
    // same synchronous loop). The disabled ▶ prevents starting before ready.
    if (!hasFiles) autoStop();
  }

  // A DIST baseline value just arrived — re-check readiness to (re-)enable the
  // bar the moment the block's read-back completes.
  function onDistBaselineProgress() { updateDistStepperEnabled(); }

  function updateDistCounter() {
    var el = document.getElementById('bp-count-dist');
    if (!el) return;
    var n = distRing.length;
    if (!n) { el.textContent = '0 / 0'; return; }
    el.textContent = (distRingIndex < 0 ? '—' : (distRingIndex + 1)) + ' / ' + n;
  }

  // Apply the virtual Original stop = restore the patch's saved state (model +
  // baseline), like RELOAD but keeping the ring position so auto-step rolls on.
  function distApplyOrigin(idx) {
    // Never apply a half-read Original — its knobs come from the baseline.
    if (!distBaselineReady()) { setStatus && setStatus('Original not ready — still reading the patch.'); return; }
    distRingIndex = idx;
    bpLoadedPath.dist = null;
    bpLoaded.dist = null;
    distOnOrigin = true;
    clearDistPresetRef();
    var savedMid = blockSavedModel[SLOT_DIST];
    var baseline = (typeof blockModelBaseline !== 'undefined' && blockModelBaseline[SLOT_DIST])
      ? blockModelBaseline[SLOT_DIST][savedMid] : null;
    var blk = distBlock();
    if (blk && savedMid !== blk.modelId) {
      bpPendingRestore = { mid: savedMid, values: baseline || {} };
      if (typeof sendDistModelChange === 'function') sendDistModelChange(savedMid);
    } else if (baseline) {
      applyDistValues(baseline);
    }
    bpRefreshCaption('dist');
    updateDistCounter();
  }

  // Step ±1 with WRAP through the ring. Origin is a stop; a file is read +
  // validated. In auto mode a non-loadable file is SKIPPED to the next valid
  // one (one lap max, then stop). Manual mode shows a modal on a wrong type.
  function distStep(dir, opts) {
    if (!distRing.length) return;
    opts = opts || {};
    var auto = !!opts.auto;
    var n = distRing.length;
    var fromIdx = (typeof opts.fromIdx === 'number') ? opts.fromIdx : distRingIndex;
    var tries = (typeof opts.tries === 'number') ? opts.tries : n;
    var idx = (fromIdx < 0) ? (dir > 0 ? 0 : n - 1) : (((fromIdx + dir) % n) + n) % n;
    var entry = distRing[idx];
    if (entry.origin) {
      // Origin needs a fully-read baseline. If it isn't ready, skip it in auto
      // (advance to the next stop) so the timer never applies a half-read
      // state; in manual, just say so.
      if (!distBaselineReady()) {
        if (auto && tries > 1) { distStep(dir, { auto: true, fromIdx: idx, tries: tries - 1 }); return; }
        if (!auto) setStatus && setStatus('Original not ready — still reading the patch.');
        return;
      }
      distApplyOrigin(idx); return;
    }
    window.electronAPI.readBlockPresetPath(entry.path).then(function (r) {
      var v = (r && r.ok) ? bpParseValid(r.bytes) : { ok: false, kind: 'parse', msg: 'Could not read preset.' };
      if (v.ok) { loadDistValidated(v.parsed, r.filename, entry.path); return; }
      if (auto) {
        if (tries > 1) { distStep(dir, { auto: true, fromIdx: idx, tries: tries - 1 }); return; }  // skip
        autoStop();
        setStatus && setStatus('Auto-step stopped — no loadable presets in this scope.');
        return;
      }
      if (v.kind === 'reject') bpRejectModal(entry.name, v.msg);
      else setStatus && setStatus(v.msg);
    });
  }

  // ── Auto-step: fire +1 every N seconds; ANY other interaction stops it. ──
  var autoTimer = null;
  function autoStepSeconds() {
    var f = document.getElementById('bp-sec-dist');
    var v = f ? parseInt(f.value, 10) : 5;
    return (isNaN(v) || v < 1) ? 5 : Math.min(v, 999);
  }
  function autoStart() {
    if (!distFolder.length) return;
    autoStop();
    autoTimer = setInterval(function () { distStep(1, { auto: true }); }, autoStepSeconds() * 1000);
    updateAutoBtn();
  }
  function autoStop() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; updateAutoBtn(); }
  }
  function autoToggle() { if (autoTimer) autoStop(); else autoStart(); }
  function updateAutoBtn() {
    var b = document.getElementById('bp-auto-dist');
    if (!b) return;
    b.textContent = autoTimer ? '■' : '▶';
    b.classList.toggle('bp-playing', !!autoTimer);
    b.title = autoTimer ? 'Stop auto-step' : 'Auto-step through the scope every N seconds';
  }
  // Any interaction anywhere (except the auto button itself) stops auto-step.
  document.addEventListener('pointerdown', function (e) {
    if (!autoTimer) return;
    if (e.target && e.target.closest && e.target.closest('#bp-auto-dist')) return;
    autoStop();
  }, true);
  document.addEventListener('keydown', function () { if (autoTimer) autoStop(); }, true);

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

    // Resolve each file param to its lo + v127 first, so the tick reference
    // (distPresetRef) is set BEFORE updateDistKnob paints — the knobs then
    // anchor their reference tick on the loaded preset's values.
    var applied = [], posIdx = 0;
    parsed.params.forEach(function (pm) {
      var lo = nameToLo[pm.name];
      if (lo === undefined) { lo = orderedLos[posIdx]; }   // positional fallback
      posIdx++;
      if (lo === undefined) return;
      var field = map.params[lo];
      var v127 = (pm.type === 'l' || (field && field.type === 'l'))
        ? Math.max(0, Math.min(127, pm.value | 0))
        : bpFloatToV127(map.family, pm.value);
      applied.push({ lo: lo, v127: v127 });
    });
    distPresetRef = {};
    applied.forEach(function (a) { distPresetRef[a.lo.toString(16).padStart(2, '0')] = a.v127; });
    applied.forEach(function (a) {
      if (typeof updateDistKnob === 'function') updateDistKnob(a.lo, a.v127);
      if (typeof sendDistParamWrite === 'function') sendDistParamWrite(a.lo, a.v127);
    });
    distOnOrigin = false;   // a preset is loaded, not the Original
    bpSetLoadedName('dist', filename.replace(/\.tfx$/i, ''));
    setStatus && setStatus('Loaded "' + filename.replace(/\.tfx$/i, '') + '"'
      + (applied.length ? '' : ' (no matching parameters).'));
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
    if (!distBaselineReady()) { setStatus && setStatus('Still reading the patch — try Reload in a moment.'); return; }
    clearDistPresetRef();   // ticks go back to the patch baseline
    bpLoadedPath.dist = null;
    distOnOrigin = true;    // RELOAD = the Original/patch state
    distRingIndex = distIncludeOrigin() ? 0 : -1;   // sit on Original in the ring
    updateDistCounter();
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
      // Apply SYNCHRONOUSLY, in the same frame the knobs just rendered, so the
      // default (64/centre) paint is overwritten before the browser shows it —
      // no midpoint flash. Returning true tells the caller to skip the rack
      // readback (we are authoritative on the values we just wrote).
      var pend = bpPendingApply; bpPendingApply = null;
      applyDistParsed(pend.parsed, pend.filename);
      return true;
    } else if (bpPendingRestore) {
      var rest = bpPendingRestore; bpPendingRestore = null;
      var m = applyDistValues(rest.values);
      setStatus && setStatus(m ? 'Reverted DIST to the patch\'s saved state.' : 'Reverted DIST model.');
      bpRefreshCaption('dist');
      updateDistCounter();
      return true;
    } else {
      // Genuine patch nav or manual model change — no preset is "loaded".
      // Reset the scope to the (new) current model and re-list its folder.
      bpLoaded.dist = null;
      bpLoadedPath.dist = null;
      distOnOrigin = false;
      clearDistPresetRef();   // ticks return to the patch baseline
      autoStop();
      distScope = distCurrentModelName();
      syncDistScopeSelect();
      distRefreshFolder();
      bpRefreshCaption('dist');
    }
    return false;
  }

  // ── PRESET bar caption ─────────────────────────────────────────────
  // Honest wording: with no preset loaded THIS session, show the patch's
  // saved block type ("Saved: Green JRC") — a patch never records where its
  // settings came from, so we never invent a preset source. After a real
  // file load, show that filename ("Loaded: <name>"). REVERT clears it.
  var bpLoaded = { dist: null };
  var bpLoadedPath = { dist: null };   // absolute path of the loaded preset (stepper anchor)
  var distOnOrigin = false;            // ring is sitting on the virtual "Original" stop

  // When a DIST preset is loaded, its values become the knobs' tick reference
  // (red/green shows change from the loaded preset). {loHex: v127} or null.
  // The patch baseline (blockModelBaseline) is untouched, so REVERT still
  // targets the patch's saved state.
  var distPresetRef = null;
  function distTickRef(loHex) {
    return (distPresetRef && distPresetRef[loHex] !== undefined) ? distPresetRef[loHex] : undefined;
  }
  function clearDistPresetRef() { distPresetRef = null; }

  function bpDistSavedName() {
    if (typeof blockSavedModel === 'undefined' || typeof SLOT_DIST === 'undefined') return null;
    var mid = blockSavedModel[SLOT_DIST];
    if (mid === undefined) {
      var blk = distBlock();
      mid = blk ? blk.modelId : undefined;
    }
    if (mid === undefined || typeof DIST_MODEL_BY_MID === 'undefined') return null;
    var model = DIST_MODEL_BY_MID[mid];
    return model ? model.name : null;
  }

  function bpRefreshCaption(blkKey) {
    var el = document.getElementById('bp-name-' + blkKey);
    if (!el) return;
    var pre, nm;
    if (blkKey === 'dist' && distOnOrigin) { pre = '★ Original'; nm = bpDistSavedName() || ''; }
    else if (bpLoaded[blkKey]) { pre = 'Loaded:'; nm = bpLoaded[blkKey]; }
    else { pre = 'Saved:'; nm = (blkKey === 'dist' ? bpDistSavedName() : null) || '—'; }
    // Fixed-width prefix column so the bold name never shifts between states.
    el.innerHTML = '<span class="bp-pre">' + pre + '</span><b>' + nm + '</b>';
  }

  function bpSetLoadedName(blkKey, name) {
    bpLoaded[blkKey] = name || null;
    bpRefreshCaption(blkKey);
  }

  // Build the scope dropdown options: every DIST model + ALL.
  function buildDistScopeOptions() {
    var sel = document.getElementById('bp-scope-dist');
    if (!sel || typeof DIST_MODELS === 'undefined') return;
    var opts = DIST_MODELS.map(function (m) {
      return '<option value="' + m.name.replace(/"/g, '') + '">' + m.name + '</option>';
    }).join('');
    sel.innerHTML = opts + '<option value="' + SCOPE_ALL + '">ALL</option>';
  }
  // Reflect distScope in the dropdown selection.
  function syncDistScopeSelect() {
    var sel = document.getElementById('bp-scope-dist');
    if (sel && distScope) sel.value = distScope;
  }

  function buildPresetBar(blkKey, onSave, onLoad, onStep) {
    var bar = document.createElement('div');
    bar.className = 'preset-bar';
    bar.id = 'bp-bar-' + blkKey;
    bar.innerHTML =
      '<span class="preset-tag">PRESET</span>'
      + '<button class="bt-btn" id="bp-save-' + blkKey + '">SAVE</button>'
      + '<button class="bt-btn" id="bp-load-' + blkKey + '">LOAD</button>'
      + '<select class="bp-scope" id="bp-scope-' + blkKey + '" title="Which presets − + and ▶ cycle"></select>'
      + '<span class="bp-step">'
      + '<button class="bt-btn bp-step-btn" id="bp-prev-' + blkKey + '" title="Previous preset">−</button>'
      + '<button class="bt-btn bp-step-btn" id="bp-next-' + blkKey + '" title="Next preset">+</button>'
      + '</span>'
      + '<button class="bt-btn bp-auto-btn" id="bp-auto-' + blkKey + '" title="Auto-step">▶</button>'
      + '<span class="bp-secwrap"><select class="bp-sec" id="bp-sec-' + blkKey + '">'
      + '<option>5</option><option>10</option><option>15</option><option>20</option><option>25</option><option>30</option>'
      + '</select><span>s</span></span>'
      + '<span class="bp-state">'
      + '<span class="bp-count" id="bp-count-' + blkKey + '">0 / 0</span>'
      + '<span class="pname" id="bp-name-' + blkKey + '">Saved: <b>—</b></span>'
      + '</span>';
    bar.querySelector('#bp-save-' + blkKey).addEventListener('click', onSave);
    bar.querySelector('#bp-load-' + blkKey).addEventListener('click', onLoad);
    bar.querySelector('#bp-prev-' + blkKey).addEventListener('click', function () { onStep(-1); });
    bar.querySelector('#bp-next-' + blkKey).addEventListener('click', function () { onStep(1); });
    bar.querySelector('#bp-auto-' + blkKey).addEventListener('click', autoToggle);
    bar.querySelector('#bp-scope-' + blkKey).addEventListener('change', function () {
      distScope = this.value;
      bpLoadedPath.dist = null;   // pointer meaningless in a different folder
      distRefreshFolder();
    });
    return bar;
  }

  function initPresetBars() {
    var distPanel = document.getElementById('panel-dist');
    if (distPanel && !document.getElementById('bp-bar-dist')) {
      // Top bar: sits directly under the panel header, above the knob row —
      // declutters the crowded bottom and never hops when knob rows change.
      var bar = buildPresetBar('dist', exportDist, importDist, distStep);
      var knobRow = document.getElementById('dist-knob-row');
      if (knobRow) distPanel.insertBefore(bar, knobRow); else distPanel.appendChild(bar);
      // REVERT lives as a ↺ icon in the panel header (right of the dropdown).
      var rev = document.getElementById('btn-dist-revert');
      if (rev) rev.addEventListener('click', revertDist);
      buildDistScopeOptions();
      distScope = distCurrentModelName();
      syncDistScopeSelect();
      bpRefreshCaption('dist');
      updateAutoBtn();
      updateDistStepperEnabled();
    }
  }

  // The patch's saved model just became known (first rack read-back after a
  // patch load/nav). Rebuild the ring so the virtual "Original" stop appears
  // (it couldn't be added earlier — blockSavedModel wasn't set yet).
  function onDistSavedModelKnown() {
    if (distScope === null) distScope = distCurrentModelName();
    distBuildRing();
    if (!bpLoadedPath.dist) {
      distRingIndex = distIncludeOrigin() ? 0 : -1;
      distOnOrigin = distIncludeOrigin();
    } else {
      distSyncRingIndex(bpLoadedPath.dist);
    }
    updateDistStepperEnabled();
    updateDistCounter();
    bpRefreshCaption('dist');
  }

  // Panel opened — default the scope to the current model and re-list.
  function onDistPanelOpen() {
    autoStop();
    distScope = distCurrentModelName();
    syncDistScopeSelect();
    bpRefreshCaption('dist');
    distRefreshFolder();
  }

  // Expose the hooks other modules call.
  window.blockPresets = {
    init: initPresetBars,
    onDistChainRefreshed: bpOnDistChainRefreshed,
    refreshCaption: bpRefreshCaption,
    distTickRef: distTickRef,
    refreshFolder: distRefreshFolder,
    onDistPanelOpen: onDistPanelOpen,
    onDistSavedModelKnown: onDistSavedModelKnown,
    onDistBaselineProgress: onDistBaselineProgress
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPresetBars);
  } else {
    initPresetBars();
  }
})();
