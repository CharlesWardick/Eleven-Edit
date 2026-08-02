// ════════════════════════════════════════════════════════════════════
// SYSEX-HANDLER.JS — parseSysEx, the central dispatcher for every
// incoming SysEx message from the bridge. Large and central enough to
// get its own file rather than living inside protocol.js or
// transport.js — it calls into both, plus ui.js and capture-scan.js.
//
// STRUCTURE (reorganized 7/27): parseSysEx is now a thin dispatcher —
// it validates the header, then hands off to one handleXxx(data)
// function per CMD byte. Each handler is self-contained and can be
// read start to finish without the other 14 command types in the way.
// No behaviour changed in this pass; every branch, guard and early
// return was moved verbatim into its own function.
// ════════════════════════════════════════════════════════════════════

// Self-heal state for the amp-handle resync (see handleParamReadback's
// instId-mismatch branch).
var _handleMismatchCount    = 0;
var _lastHandleResyncMs     = 0;
var HANDLE_RESYNC_THRESHOLD = 5;      // consecutive unknown-handle broadcasts
var HANDLE_RESYNC_COOLDOWN  = 2000;   // ms between resync attempts

async function parseSysEx(data) {
  if (data.length < 6) return;
  if (data[0] !== 0xF0 || data[1] !== 0x13 || data[2] !== 0x0B ||
      (data[3] !== 0x0F && data[3] !== 0x0E)) return;

  const cmd = data[5];

  // ── DIAGNOSTIC — amp paramLo investigation, 2026-07-22.
  // Raw-dump, in full and undecoded, any response whose CMD is in
  // PROBE_DUMP_CMDS. Runs before normal dispatch and changes nothing else;
  // messages that already have a handler still reach it as usual.
  if (typeof PROBE_DUMP_CMDS !== 'undefined' && PROBE_DUMP_CMDS.indexOf(cmd) !== -1) {
    appLog('PROBE resp CMD 0x' + cmd.toString(16).padStart(2,'0').toUpperCase() +
           '  len=' + data.length + 'b  ' +
           Array.from(data).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' '));
  }

  switch (cmd) {
    case 0x00:
    case 0x01: return handleBulkTfxData(data, cmd);
    case 0x04: return handleSaveArm(data);
    case 0x02: return handleSlotConfirm(data);
    case 0x03: return handleSaveRigResponse(data);
    case 0x05: return handlePatchName(data);
    case 0x21: return handleChainMap(data);
    case 0x07: return handleRigVolumeBroadcast(data);
    case 0x40: return handleTunerBroadcast(data);
    case 0x0D: return handleMonoBroadcast(data);
    case 0x50: return handleRigTempoBroadcast(data);
    case 0x36: return handleToAmpVolumeBroadcast(data);
    case 0x3B: return handleMasterMuteBroadcast(data);
    case 0x3A: return handleToAmpSourceQueryResp(data);
    case 0x37: return handleToAmpSourceBroadcast(data);
    case 0x3D: return handleInputSelectorBroadcast(data);
    case 0x11: return handleParamReadback(data);
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x00 / 0x01 — Bulk TFX data
// ════════════════════════════════════════════════════════════════════
// CMD 0x00 — Bulk TFX data, spontaneous ASYNC broadcast (hardware save,
//   bank load). HAS a slot-number byte at data[6]; payload starts at 7.
// CMD 0x01 — Bulk TFX data, RESP to our own REQU SEND_PATCH. Confirmed
//   via real captured bytes (7/9/2026) that this does NOT have a slot-
//   number byte the way CMD 0x00 does — its payload starts ONE BYTE
//   EARLIER, at position 6. Decoding this with the CMD 0x00 layout
//   (payload at 7) silently fails to find anything, every time — this
//   was the actual reason our own on-demand pulls never updated amp/
//   gate, even after the REQU byte-format fix. Since this is a direct
//   response to something we asked for, treat it as being about
//   whatever slot we already believe we're on — no separate slot
//   number to check against.
//
// Bank load: CMD 0x04 for slot N arrives AFTER CMD 0x00 for slot N
//            so CMD 0x04 arms saveSequence, then CMD 0x00 for slot N+1 arrives
//            We detect this by checking if the slot in CMD 0x00 matches saveSequenceSlot
// Hardware save: CMD 0x04 for slot N, then CMD 0x00 for same slot N
async function handleBulkTfxData(data, cmd) {
  const isReqResp    = (cmd === 0x01);
  const slotNum       = isReqResp ? currentSlot : (data.length > 6 ? data[6] : currentSlot);
  const slotName      = slotLabel(slotNum);
  const payloadStart  = isReqResp ? 6 : 7;
  const payloadEnd    = data[data.length - 1] === 0xF7 ? data.length - 1 : data.length;
  const payload       = Array.from(data).slice(payloadStart, payloadEnd);

  if (payload.length < 100) {
    appLog('Bulk payload too small (' + payload.length + 'b) — ignored');
    return;
  }

  // Check if this is a hardware save — slot must match the armed save slot
  const isSave = saveSequenceDetected && (slotNum === saveSequenceSlot);
  appLog('Bulk data: ' + data.length + 'b slot=' + slotNum + ' (' + slotName + ') saveSeq=' + saveSequenceDetected + ' saveSlot=' + saveSequenceSlot + ' isSave=' + isSave);

  // Decode once, share with amp-key and gate decoding below
  const body = decode7bit(new Uint8Array(payload));
  appLog('Bulk body decoded: payload=' + payload.length + 'b body=' + body.length + 'b');

  // ── Bank scan waiting on this exact slot? Hand it the decoded data
  // directly and stop here — scan mode has its own progress UI and
  // doesn't want this also thrashing the normal live display. ──
  if (pendingScanResolve && slotNum === pendingScanSlot) {
    const resolve = pendingScanResolve;
    pendingScanResolve = null;
    pendingScanSlot = null;
    resolve({ body: body, slotNum: slotNum });
    return;
  }

  if (isSave) {
    // ── HARDWARE SAVE: capture TFX to disk ──
    saveSequenceDetected = false;
    saveSequenceSlot = -1;
    if (saveSequenceTimer) { clearTimeout(saveSequenceTimer); saveSequenceTimer = null; }

    captureCount++;
    appLog('Save confirmed — capturing TFX slot ' + slotNum + ' (' + slotName + ')');

    // Discrete controls (cab/mic, mono) are safe to apply from the body.
    const ampInfo = decodeAmpKey(body);
    const ampChanged = !!(ampInfo && ampInfo.key && ampInfo.key !== currentAmpKey);
    // Only re-render the amp when it ACTUALLY changed — setCurrentAmp ->
    // updateToneKnobs blanks the tone row to "--"/midpoint, so calling it on a
    // same-amp save would wipe the live tone values (regression 7/27).
    if (ampChanged) setCurrentAmp(ampInfo.key);
    updateCabMicReadouts(decodeCabMicValues(body));
    updateMonoIndicator(decodeMonoStereo(body));
    // Continuous red-tracked knobs (gate, amp out, tone, To-Amp vols) already
    // show the correct LIVE 0-127 values. Re-decoding them from the body rounds
    // a high-res int32 via gateRawToV127 and can land one unit off the live
    // value — the harmless difference our pixel-perfect red flags as phantom
    // red / the Save-to-Rack flash. So repaint them ONLY when there is no live
    // truth to preserve: the amp was just re-rendered (blanked), or the legacy
    // bulk-on-nav mode (nothing live-populated them). (7/27)
    if (ampChanged || REQUEST_BULK_ON_NAV) {
      updateGateReadout(decodeGateValues(body, ampInfo ? ampInfo.markerPos : null));
      updateAmpOutReadout(decodeAmpOutValue(body, ampInfo ? ampInfo.markerPos : null));
      updateToneReadouts(decodeToneKnobValues(body, ampInfo ? ampInfo.markerPos : null, ampInfo ? ampInfo.key : null), ampInfo ? ampInfo.key : null);
      updateToAmpVolumeReadouts(decodeToAmpVolumes(body));
    }
    captureKnobBaselines();   // saved values are the new "unchanged" baseline
    clearFxBaselines();       // effect truth is now the saved state:
    rebaselineOpenFxPanel();  //   re-anchor an open panel, others on next open
    if (typeof clearPatchDirty === 'function') clearPatchDirty();  // saved = clean
    // A save makes the rack re-instantiate the patch and REASSIGN block
    // handles, so currentParamHi (and the effect handles) are now stale —
    // SW knob writes would hit the old amp handle and appear dead until a HW
    // knob turn triggers the self-heal. Re-read the chain map now to refresh
    // all handles (and currentChain / bypass / effect panels) proactively.
    if (typeof REQU_CHAIN_MAP !== 'undefined') {
      appLog('Post-save: re-reading chain map to refresh reassigned block handles');
      sendHex(REQU_CHAIN_MAP);
    }
    const captureName = (currentPatchName || 'patch').replace(/[\\/:*?"<>|]/g, '_').substring(0,24);
    try {
      const result = await window.electronAPI.saveTfx(captureName, payload);
      if (result && result.ok) {
        document.getElementById('capture-info').innerHTML =
          'Captures this session: <span>' + captureCount + '</span> — last: ' + result.filename;
        appLog('TFX saved: ' + result.path);
      } else {
        document.getElementById('capture-info').textContent = 'TFX save failed: ' + (result ? result.error : 'unknown');
        appLog('TFX save failed: ' + (result ? result.error : 'unknown'));
      }
    } catch(e) {
      appLog('TFX save error: ' + e.message);
    }

  } else {
    // ── NOT A SAVE: bank load / navigation sync / manual capture ──
    // Only apply this if it matches currentSlot — currentSlot is
    // always correctly pre-aligned before any SEND_PATCH request goes
    // out now (goToSlot sets it immediately for both first-connect and
    // normal nav, the CMD 0x02 handler sets it for hardware-initiated
    // nav), so a plain exact match is both safe and correct everywhere.
    // This also protects against a stale response from an older
    // request arriving late during fast navigation and yanking the
    // display backward.
    if (slotNum === currentSlot) {
      const ampInfo = decodeAmpKey(body);
      const ampChanged = !!(ampInfo && ampInfo.key && ampInfo.key !== currentAmpKey);
      // Only re-render the amp if it actually changed (setCurrentAmp blanks the
      // tone row); otherwise leave the live knobs untouched.
      if (ampChanged) setCurrentAmp(ampInfo.key);
      updateCabMicReadouts(decodeCabMicValues(body));
      updateMonoIndicator(decodeMonoStereo(body));
      // Don't repaint the continuous red-tracked knobs from the body unless the
      // amp was just re-rendered or we're in legacy bulk-on-nav — they already
      // show the live 0-127 values, and a body re-decode rounds one unit off,
      // which shows as phantom red (the Save-to-Disk "knobs stay red" case). (7/27)
      if (ampChanged || REQUEST_BULK_ON_NAV) {
        updateGateReadout(decodeGateValues(body, ampInfo ? ampInfo.markerPos : null));
        updateAmpOutReadout(decodeAmpOutValue(body, ampInfo ? ampInfo.markerPos : null));
        updateToneReadouts(decodeToneKnobValues(body, ampInfo ? ampInfo.markerPos : null, ampInfo ? ampInfo.key : null), ampInfo ? ampInfo.key : null);
        updateToAmpVolumeReadouts(decodeToAmpVolumes(body));
      }
      // NOTE: do NOT re-baseline knob colours here. This branch is a generic
      // readback of the CURRENT buffer — it fires on manual "Capture Now" and
      // on Save-to-Disk, where the buffer may be dirty. Re-baselining would
      // wrongly turn red knobs amber. Baselines are set only on a true patch
      // load (end of the nav pull) and on a rack commit (save paths).
    } else {
      appLog('Bulk response for slot ' + slotNum + ' ignored — stale (currentSlot now ' + currentSlot + ')');
    }

    // Manual "Capture Current Patch Now" — save this pull to disk even
    // though it's not a hardware-detected save, so two controlled
    // captures (e.g. gate thresh at two different settings) can be
    // diffed byte-for-byte to find where that value lives in the file.
    if (pendingManualCapture) {
      pendingManualCapture = false;
      const captureName = (currentPatchName || 'patch').replace(/[\\/:*?"<>|]/g, '_').substring(0,24) + '_manual';
      try {
        const result = await window.electronAPI.saveTfx(captureName, payload, { incrementIfExists: true });
        if (result && result.ok) {
          appLog('Manual capture saved: ' + result.path);
          setStatus('Captured: ' + result.filename);
          document.getElementById('capture-info').innerHTML =
            'Manual capture saved — last: ' + result.filename;
        } else {
          appLog('Manual capture failed: ' + (result ? result.error : 'unknown'));
          setStatus('Manual capture failed: ' + (result ? result.error : 'unknown'));
        }
      } catch(e) { appLog('Manual capture error: ' + e.message); }
    }

    // Reset any armed save sequence since this bulk is for a different slot
    if (saveSequenceDetected && slotNum !== saveSequenceSlot) {
      saveSequenceDetected = false;
      saveSequenceSlot = -1;
      if (saveSequenceTimer) { clearTimeout(saveSequenceTimer); saveSequenceTimer = null; }
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x04 — Save slot/name confirmation
// ════════════════════════════════════════════════════════════════════
function handleSaveArm(data) {
  if (data.length < 8) return;
  const armed_slot = data[7];
  appLog('CMD 0x04 — arming save sequence for slot ' + armed_slot + ' (' + slotLabel(armed_slot) + ')');
  saveSequenceDetected = true;
  saveSequenceSlot = armed_slot;
  if (saveSequenceTimer) clearTimeout(saveSequenceTimer);
  saveSequenceTimer = setTimeout(function() {
    saveSequenceDetected = false;
    saveSequenceSlot = -1;
    saveSequenceTimer = null;
    appLog('Save sequence timeout — reset');
  }, 5000);
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x02 — Current rig number (slot confirmation)
// ════════════════════════════════════════════════════════════════════
function handleSlotConfirm(data) {
  if (data.length < 8) return;
  // Navigation broadcasts: data[6]=0x00, data[7]=raw slot number.
  // Commit echoes (from our own Save): data[6]=bank, data[7]=num,
  // which needs decoding as slot = bank*4 + num. Both formats agree
  // for bank A (data[6]=0), so this is safe to apply unconditionally.
  const confirmed = data[6] > 0 ? (data[6] * 4 + data[7]) : data[7];
  if (confirmed !== currentSlot) {
    currentSlot = confirmed;
    const el = document.getElementById('slot-display');
    el.textContent = slotLabel(confirmed);
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 80);
    document.getElementById('slot-num').textContent = 'Slot ' + confirmed;
    if (typeof updateNavDisplay === 'function') updateNavDisplay(confirmed);
    appLog('Slot confirmed: ' + confirmed + ' (' + slotLabel(confirmed) + ')');
    if (!scanInProgress) {
      // Fires for ANY slot change — our own PC send or the hardware's
      // own front panel nav — so patch name/amp/rig vol stay in sync
      // either way. Skipped during a bank scan, which drives its own
      // navigation and already has an explicit SEND_PATCH in flight
      // for each slot — this would just race it.
      clearStaleReadoutsOnNav();
      requestPatchStateAfterNav();
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x03 — Save rig response
// ════════════════════════════════════════════════════════════════════
// Two variants: data[7]=0x01 = save confirmation, data[7]=0x00 = slot confirmation
// Only pause roller on save confirmation (0x01)
function handleSaveRigResponse(data) {
  appLog('CMD 0x03 response: ' + Array.from(data).map(b=>b.toString(16).padStart(2,'0')).join(' '));
  if (data.length >= 8 && data[7] === 0x01 && autoStartTime !== null && !autoPaused) {
    togglePause();
    appLog('Roller paused — hardware save detected (CMD 0x03 save variant)');
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x05 — Patch name
// ════════════════════════════════════════════════════════════════════
function handlePatchName(data) {
  const bytes = [];
  for (let i = 6; i < data.length - 1; i++) {
    if (data[i] === 0) break;
    bytes.push(data[i]);
  }
  const name = bytes.map(b => String.fromCharCode(b)).join('');
  if (name) {
    currentPatchName = name;
    const nameEl = document.getElementById('patch-name');
    nameEl.textContent = name;
    nameEl.classList.add('live');
    setStatus(slotLabel(currentSlot) + ' — ' + name);
    appLog('Patch name: "' + name + '"');
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x21 — Chain map
// ════════════════════════════════════════════════════════════════════
// Message: F0 13 0B 0F [dir] 21 [11 triplets] [trailing] F7   (41 bytes)
// Triplet = [backLink][mid][handle], 3 bytes each, starting at data[6].
//
// The FIRST byte is a BACK-LINK holding the PREVIOUS block's slot ID —
// it is not a type tag. Slot IDs are recovered by shifting:
//     slotId(triplet N) = backLink(triplet N+1)
//     slotId(last)      = trailing byte
// Triplet 0 is the input block (slot 0x0B), not a chain block.
//
// Slot IDs are FIXED per block type in every patch (Tech Ref Sec 4):
//   0x00 AMP-CAB  0x03 WAH   0x06 DELAY  0x09 FX2
//   0x01 LOOP     0x04 MOD   0x07 DIST   0x0B INPUT
//   0x02 VOL      0x05 REVERB 0x08 FX1
//
// HISTORY — this handler previously searched for a first byte of 0x07 and
// treated that triplet as the amp, on the belief that the field was a type
// tag and 0x07 meant "amp". Because 0x07 is DIST's slot ID, that actually
// found "the block AFTER dist". It agreed with the amp only on patches
// where the amp immediately follows the distortion — true of the small set
// of test patches, false for 11 of 14 real patches checked on 2026-07-19.
// On the rest it addressed FX2, LOOP or REVERB, so every amp write (tone,
// gate, amp out, cab, mic, amp select) went to the wrong block and every
// incoming amp broadcast was discarded as "not ours".
function handleChainMap(data) {
  const TRIPLETS = 11;
  const base = 6;
  if (data.length < base + TRIPLETS * 3 + 2) {
    appLog('CMD 0x21: short chain map (' + data.length + 'b), ignored');
    return;
  }

  const trip = [];
  for (let n = 0; n < TRIPLETS; n++) {
    const i = base + n * 3;
    trip.push({ backLink: data[i], mid: data[i+1], handle: data[i+2] });
  }
  const trailing = data[base + TRIPLETS * 3];

  // Recover each triplet's own slot ID from the following triplet's back-link.
  const slotIds = [];
  for (let n = 0; n < TRIPLETS; n++) {
    slotIds.push(n < TRIPLETS - 1 ? trip[n+1].backLink : trailing);
  }

  // Chain blocks are triplets 1..10; triplet 0 is the input block.
  currentChain = [];
  for (let n = 1; n < TRIPLETS; n++) {
    currentChain.push({
      position: n,                       // 1..10, left to right
      slotId:   slotIds[n],
      name:     SLOT_ID_TO_NAME[slotIds[n]] || ('slot0x' + slotIds[n].toString(16)),
      modelId:  trip[n].mid,             // effect model — see Tech Ref Sec 23
      handle:   trip[n].handle           // instId for CMD 0x11 on this block
    });
  }
  currentChainInput = { slotId: slotIds[0], modelId: trip[0].mid, handle: trip[0].handle };

  // Amp handle = the block whose slot ID is 0x00. Position independent.
  const ampBlock = currentChain.find(b => b.slotId === SLOT_AMP);
  if (ampBlock) {
    currentParamHi = ampBlock.handle;
    appLog('CMD 0x21 chain: ' + currentChain.map(b => b.name).join(' > '));
    appLog('CMD 0x21 AMP paramHi: 0x' + currentParamHi.toString(16).padStart(2,'0').toUpperCase()
           + ' (chain position ' + ampBlock.position + ')');
    syncAmpSelectDropdown(currentAmpKey);
    // The TFX carries no amp-bypass key, so ask the hardware directly.
    // Handles are only valid once the chain map has arrived, which is now.
    renderChainRow();          // reorder slots, hover text, stereo connectors
    requestAllBypass();        // AFTER the row exists — needs currentChain populated
    // If DIST panel is open, update its dropdown/knobs with the new handle
    if (typeof refreshDistPanelAfterChainMap === 'function') refreshDistPanelAfterChainMap();
    if (typeof refreshReverbPanelAfterChainMap === 'function') refreshReverbPanelAfterChainMap();
    if (typeof refreshWahPanelAfterChainMap === 'function') refreshWahPanelAfterChainMap();
    if (typeof refreshVolPanelAfterChainMap === 'function') refreshVolPanelAfterChainMap();
    if (typeof refreshFxLoopPanelAfterChainMap === 'function') refreshFxLoopPanelAfterChainMap();
    if (typeof refreshDelayPanelAfterChainMap === 'function') refreshDelayPanelAfterChainMap();
    if (typeof refreshFxHostPanelAfterChainMap === 'function') refreshFxHostPanelAfterChainMap();
    // Release the post-nav pull's wait: currentParamHi and currentChain are
    // now valid, so amp-block queries can safely be addressed.
    chainMapRxSeq++;
  } else {
    // Should not happen — every rig has an amp block.
    appLog('CMD 0x21: no AMP block (slot 0x00) found in chain map, paramHi unchanged');
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x07 — Rig Volume hardware knob broadcast
// ════════════════════════════════════════════════════════════════════
function handleRigVolumeBroadcast(data) {
  const v0  = data[6];
  const val = (v0 >= 0x40) ? (v0 - 0x40) : (v0 + 64);
  const wrap = document.getElementById('rig-vol-wrap');
  if (wrap) {
    wrap.dataset.value = val;
    drawKnob(wrap.querySelector('canvas'), val);
    document.getElementById('rig-vol-val').textContent = valRigVol(val);
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x40 — Tuner state broadcast
// ════════════════════════════════════════════════════════════════════
// F0 13 0B 0F 02 40 [state] F7 — confirmed 7/15/2026 from session log
// data[6]=0x01 = tuner ON, data[6]=0x00 = tuner OFF
// Hardware never echoes CC 69 back — it responds with this SysEx instead.
function handleTunerBroadcast(data) {
  if (data.length < 7) return;
  handleTunerCC(data[6] === 0x01 ? 127 : 0);
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x0D — Stereo/Mono echo/broadcast
// ════════════════════════════════════════════════════════════════════
// Hardware echo after SW send is always 02 0D 01 regardless of direction —
// not a reliable state indicator. Suppress it for one cycle after a SW send.
// Unsolicited front-panel broadcasts are passed through normally.
function handleMonoBroadcast(data) {
  if (suppressMonoEcho) {
    suppressMonoEcho = false;
    appLog('CMD 0x0D echo suppressed (SW send in progress)');
    return;
  }
  const val = (data.length >= 9) ? data[7] : data[6];
  const isMono = (val === 0x01);
  updateMonoIndicator(isMono);
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x50 — Rig tempo
// ════════════════════════════════════════════════════════════════════
// Broadcast on every tempo change (front panel, Avid editor, or our own send
// echoed back) and also the reply to REQU_TEMPO_READ.
// Format: F0 13 0B 0F [dir] 50 d1 d2 d3 d4 F7 — four SIX-bit digits of the
// microseconds-per-beat value. dir is 0x02 for a broadcast and 0x12 for the
// reply to our query; both mean the same thing here.
// See protocol.js rigTempoDecodeUs for the encoding and why it is not the
// 7-bit format used elsewhere.
function handleRigTempoBroadcast(data) {
  if (data.length < 10) return;
  const us  = rigTempoDecodeUs(data[6], data[7], data[8], data[9]);
  const bpm = rigTempoUsToBpm(us);
  if (bpm !== null) updateTempoDisplay(bpm);
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x36 — To Amp / Master volume hardware knob broadcast
// ════════════════════════════════════════════════════════════════════
// Format: F0 13 0B 0F 02 36 [slot] [v0] 00 00 00 00 F7
// slot: 0x00=Main (Master), 0x02=ToAmp1, 0x03=ToAmp2. v0 = raw 0x00–0x7F
// (no formula). ToAmp1/2 confirmed 7/17/2026 from HW knob capture; Main
// added 7/29/2026 from Master_Volume_Mute_Phones_Capture.pcapng.
// Drag flags (toAmp1Dragging / toAmp2Dragging) suppress display update
// while user is actively dragging the SW knob.
function handleToAmpVolumeBroadcast(data) {
  if (data.length < 8) return;
  const slot = data[6];
  const v0   = data[7];
  const val  = (v0 >= 0x40) ? (v0 - 0x40) : (v0 + 64);
  if (slot === 0x00) {
    appLog('CMD 0x36 Master volume: v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase() + ' (' + valToMasterVol(val) + ')');
    updateMasterVolDisplay(val);
  } else if (slot === 0x02) {
    appLog('CMD 0x36 ToAmp1 volume: v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase() + ' (' + valToAmpVol(val) + ')');
    if (!toAmp1Dragging) {
      const wrap = document.getElementById('toamp1-vol-wrap');
      if (wrap) {
        wrap.dataset.value = val;
        drawKnob(wrap.querySelector('canvas'), val);
        document.getElementById('toamp1-vol-val').textContent = valToAmpVol(val);
      }
    }
  } else if (slot === 0x03) {
    appLog('CMD 0x36 ToAmp2 volume: v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase() + ' (' + valToAmpVol(val) + ')');
    if (!toAmp2Dragging) {
      const wrap = document.getElementById('toamp2-vol-wrap');
      if (wrap) {
        wrap.dataset.value = val;
        drawKnob(wrap.querySelector('canvas'), val);
        document.getElementById('toamp2-vol-val').textContent = valToAmpVol(val);
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x3B — Master Mute (Main / Phones) broadcast
// ════════════════════════════════════════════════════════════════════
// Format: F0 13 0B 0F [dir] 3B [channel] [state] F7 (9 bytes)
// channel: MUTE_CH_MAIN (0x00) / MUTE_CH_PHONES (0x01).
// state: 0x00 = unmuted, 0x01 = muted.
// Confirmed 7/29/2026 (Master_Volume_Mute_Phones_Capture.pcapng) — fires on
// our own SW send's HW echo the same as every other confirmed send/echo
// command here, so this one handler keeps the mute buttons lit correctly
// whether the change came from us, the front panel, or the Avid editor.
function handleMasterMuteBroadcast(data) {
  if (data.length < 8) return;
  const channel = data[6];
  const muted   = data[7] === 0x01;
  appLog('CMD 0x3B mute: channel=' + (channel === MUTE_CH_MAIN ? 'Main' : 'Phones') + ' muted=' + muted);
  updateMuteButton(channel, muted);
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x3A — To Amp source query response
// ════════════════════════════════════════════════════════════════════
// Format: F0 13 0B 0F 12 3A 07 [slot] [currentVal] F7  (10 bytes)
// data[6]=0x07, data[7]=slot, data[8]=currentVal
// Fires after our CMD 0x3A REQU. If a pendingToAmpSource matches this
// slot, send the queued CMD 0x37 now that HW has confirmed readiness.
// Confirmed 7/17/2026 — Avid always queries before writing; skipping caused assert.
function handleToAmpSourceQueryResp(data) {
  if (data.length < 10) return;
  const slot = data[7];
  const currentVal = data[8];
  appLog('CMD 0x3A ToAmp' + (slot === 0x00 ? '1' : '2') + ' source query resp: currentVal=0x' + currentVal.toString(16).padStart(2,'0').toUpperCase());
  if (pendingToAmpSource !== null && pendingToAmpSource.slot === slot) {
    const pending = pendingToAmpSource;
    pendingToAmpSource = null;
    appLog('CMD 0x3A response received — now sending CMD 0x37 slot=0x' + pending.slot.toString(16).padStart(2,'0') + ' val=0x' + pending.val.toString(16).padStart(2,'0'));
    sendToAmpSource(pending.slot, pending.val);
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x37 — To Amp source broadcast
// ════════════════════════════════════════════════════════════════════
// Format: F0 13 0B 0F 02 37 07 [slot] [val] F7
// slot: 0x00=ToAmp1, 0x01=ToAmp2.
// val:  0x00=Rig Input, 0x01=Amp Input, 0x02=Amp Output, 0x03=Rig Output.
// Confirmed 7/17/2026 from Avid editor capture.
function handleToAmpSourceBroadcast(data) {
  if (data.length < 9) return;
  const slot = data[6];
  const val  = data[7];
  const selId = (slot === 0x00) ? 'toamp1-src' : (slot === 0x01) ? 'toamp2-src' : null;
  if (selId) {
    const sel = document.getElementById(selId);
    if (sel) sel.value = String(val);
    appLog('CMD 0x37 ToAmp' + (slot+1) + ' source: val=0x' + val.toString(16).padStart(2,'0').toUpperCase());
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x3D — Input selector broadcast
// ════════════════════════════════════════════════════════════════════
function handleInputSelectorBroadcast(data) {
  const inputVal = data[6];
  appLog('CMD 0x3D input selector: 0x' + inputVal.toString(16).padStart(2,'0').toUpperCase());
  setInputButtons(inputVal);
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x11 — Parameter readback
// ════════════════════════════════════════════════════════════════════
// Two formats on the MIDI layer:
// FORMAT A — ASYNC broadcasts: data[6]=instId, data[7]=paramLo, data[8]=v0
// FORMAT B — RESP to explicit REQU: data[6]=0x04, data[7]=instId, data[8]=paramLo, data[9]=v0
function handleParamReadback(data) {
  if (data.length < 9) return;

  // ── BYPASS ROUTING — handled for EVERY block, not just the amp. Must run
  // before the amp-only instId guard further down, and before FORMAT A/B are
  // otherwise decoded, since bypass has its own instId/paramLo/v0 reading
  // that covers both formats itself.
  if (routeBypassMessage(data)) return;

  // FORMAT B check
  if (data[6] === 0x04 && currentParamHi >= 0 && data[7] === currentParamHi && data.length >= 10) {
    routeFormatBAmpMessage(data);
    return;
  }

  const instId  = data[6];
  const paramLo = data[7];
  const v0      = data[8];
  const val     = (v0 >= 0x40) ? (v0 - 0x40) : (v0 + 64);

  // ── DIST parameter routing — handled before the amp-only instId guard
  // so DIST broadcasts (different handle) are not silently discarded.
  // Only route when the DIST panel is open; no-op otherwise.
  if (distPanelOpen) {
    const distBlk = currentChain.find(b => b.slotId === SLOT_DIST);
    if (distBlk && instId === distBlk.handle) {
      if (paramLo === 0x02 || paramLo === 0x03 || paramLo === 0x04 || paramLo === 0x05) {
        if (typeof updateDistKnob === 'function') updateDistKnob(paramLo, val);
        appLog('CMD 0x11 DIST paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  // ── REVERB parameter routing — same shape as DIST above. paramLo 0x05
  // is the Eleven SR Type control; updateReverbKnob also moves the Type
  // dropdown to the nearest zone for it.
  if (reverbPanelOpen) {
    const rvBlk = currentChain.find(b => b.slotId === SLOT_REVERB);
    if (rvBlk && instId === rvBlk.handle) {
      if (paramLo >= 0x02 && paramLo <= 0x06) {
        if (typeof updateReverbKnob === 'function') updateReverbKnob(paramLo, val);
        appLog('CMD 0x11 REVERB paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  // ── WAH parameter routing — same shape as DIST/REVERB.
  // 0x02 = Position (user knob). 0x03 = internal model flag broadcast
  // on model change — absorbed here so it doesn't hit the mismatch handler.
  if (wahPanelOpen) {
    const wahBlk = currentChain.find(b => b.slotId === SLOT_WAH);
    if (wahBlk && instId === wahBlk.handle) {
      if (paramLo === 0x02) {
        if (typeof updateWahKnob === 'function') updateWahKnob(paramLo, val);
        appLog('CMD 0x11 WAH paramLo=0x02 val=' + val);
        return;
      }
      if (paramLo === 0x03) {
        appLog('CMD 0x11 WAH paramLo=0x03 (model flag) val=' + val + ' — absorbed');
        return;
      }
    }
  }

  // ── VOL parameter routing — same shape as DIST/REVERB.
  if (volPanelOpen) {
    const volBlk = currentChain.find(b => b.slotId === SLOT_VOL);
    if (volBlk && instId === volBlk.handle) {
      if (paramLo >= 0x02 && paramLo <= 0x04) {
        if (typeof updateVolKnob === 'function') updateVolKnob(paramLo, val);
        appLog('CMD 0x11 VOL paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  // ── FX LOOP parameter routing — same shape as VOL.
  if (fxLoopPanelOpen) {
    const loopBlk = currentChain.find(b => b.slotId === SLOT_LOOP);
    if (loopBlk && instId === loopBlk.handle) {
      if (paramLo >= 0x02 && paramLo <= 0x04) {
        if (typeof updateFxLoopKnob === 'function') updateFxLoopKnob(paramLo, val);
        appLog('CMD 0x11 FX LOOP paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  // ── DELAY parameter routing — same shape as VOL/FX LOOP. paramLo 0x05
  // (Sync) is the SAME plain single-byte `val` every other Sync control
  // uses (amp Tremolo, FX1 C1 Chorus) — retracted 2026-08-02's wide
  // 28-bit raw-extraction misread; see protocol.js's DELAY SYNC comment.
  if (delayPanelOpen) {
    const delayBlk = currentChain.find(b => b.slotId === SLOT_DELAY);
    if (delayBlk && instId === delayBlk.handle) {
      if (paramLo === 0x05) {
        if (typeof updateDelaySync === 'function') updateDelaySync(val);
        appLog('CMD 0x11 DELAY Sync val=' + val + ' -> zone ' + syncIndexFromV127(val));
        return;
      }
      if (paramLo >= 0x02 && paramLo <= 0x0A) {
        // Drag guard (state.js delayDragLo) — same pattern as To Amp 1/2
        // (ui.js toAmp1Dragging/toAmp2Dragging): skip repainting THIS
        // paramLo while it's the user's active drag target, so a
        // broadcast racing the drag (e.g. the Sync-clear write on Delay
        // knob touch, R7) can't visually stomp on it mid-drag.
        if (paramLo === delayDragLo) {
          appLog('CMD 0x11 DELAY paramLo=0x' + paramLo.toString(16).padStart(2,'0')
            + ' val=' + val + ' — skipped, actively dragging');
          return;
        }
        if (typeof updateDelayKnob === 'function') updateDelayKnob(paramLo, val);
        appLog('CMD 0x11 DELAY paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  // ── FX-HOST parameter routing (2026-08-01 refactor) — one generic block
  // for every GENERIC HOST SLOT (FX1/FX2/MOD), replacing what used to be an
  // FX1-only copy (same shape would otherwise get pasted again for FX2 and
  // MOD). openFxHostSlot (state.js) is which slot's panel is open, if any —
  // only one can be open at a time. The paramLo range routed here is
  // whichever model is currently loaded in that slot (see FX1_MODELS in
  // protocol.js, the shared model table every host slot reads from).
  // Uncaptured models simply have an empty paramLos list, so nothing routes
  // for them yet — no crash, no-op.
  if (openFxHostSlot !== null) {
    const fxHostBlk = currentChain.find(b => b.slotId === openFxHostSlot);
    if (fxHostBlk && instId === fxHostBlk.handle) {
      const fxHostModel = FX1_MODEL_BY_MID[fxHostBlk.modelId];
      if (fxHostModel && fxHostModel.paramLos.indexOf(paramLo) !== -1) {
        if (typeof updateFxHostKnob === 'function') updateFxHostKnob(paramLo, val);
        appLog('CMD 0x11 FX-HOST slot=0x' + openFxHostSlot.toString(16).padStart(2,'0')
          + ' paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  // instId matches currentParamHi (runtime handle from chain map)
  if (instId !== currentParamHi || currentParamHi < 0) {
    appLog('CMD 0x11 instId=0x' + instId.toString(16).padStart(2,'0') +
      ' — does not match currentParamHi=0x' + (currentParamHi<0?'(none)':currentParamHi.toString(16).padStart(2,'0')) + ', ignored');
    // SELF-HEAL (item, 7/26): a run of mismatches means the rack reassigned the
    // amp's handle (e.g. after a flood) and is broadcasting from one we no
    // longer recognise — the "knobs go dead both ways" state. Re-read the chain
    // map once to re-establish currentParamHi, debounced so a burst triggers a
    // single resync, not a storm. The throttle above should prevent the flood
    // that gets us here; this is the safety net if one ever slips through.
    _handleMismatchCount++;
    var _nowMs = Date.now();
    if (_handleMismatchCount >= HANDLE_RESYNC_THRESHOLD &&
        (_nowMs - _lastHandleResyncMs) > HANDLE_RESYNC_COOLDOWN) {
      _lastHandleResyncMs = _nowMs;
      _handleMismatchCount = 0;
      appLog('Self-heal: ' + HANDLE_RESYNC_THRESHOLD + '+ broadcasts for an unknown handle — re-reading chain map to resync');
      if (typeof REQU_CHAIN_MAP !== 'undefined') sendHex(REQU_CHAIN_MAP);
    }
    return;
  }
  _handleMismatchCount = 0;   // a match means we are back in sync

  routeAmpBlockParam(paramLo, v0, val);
}

// ── Bypass routing helper for handleParamReadback ──
// paramLo 0x01 = block bypass   0x06 = amp bypass   0x14 = cab bypass
// v0 0x40 = active, 0x3F = bypassed
//
// HANDLE GUARD (added 7/22): amp-bypass (0x06) and cab-bypass (0x14) are
// only meaningful on the AMP block's handle. Other blocks reuse paramLo
// 0x06 for their own parameters — e.g. Eleven SR REVERB Pre-Delay is
// paramLo 0x06 on the reverb handle. Without this guard a Pre-Delay turn
// was read as an amp-bypass event (and its readback was swallowed here
// instead of reaching the reverb knob). So 0x06/0x14 only count as bypass
// when they arrive on currentParamHi; anything else falls through to the
// per-block routing below. Same bug family as the 0x04-handle case:
// a value that is a control code in one context is plain data in another.
//
// FORMAT B DETECTION NOTE: Format B has 0x04 as a literal marker byte at
// data[6], NOT a handle. However, a block's runtime handle CAN legitimately
// be 0x04 (e.g. MOD in certain chain orders), producing a Format A response
// that starts with the same byte. Disambiguate by checking whether 0x04
// exists as a real handle in currentChain — if it does, data[6] IS the
// handle and this is Format A.
//
// Returns true if this message was a bypass message and has been fully
// handled (caller should stop dispatching); false otherwise.
function routeBypassMessage(data) {
  let bInst, bLo, bV0;
  const handleAtData6 = currentChain.find(x => x.handle === data[6]);
  if (data[6] === 0x04 && !handleAtData6 && data.length >= 10) { // FORMAT B
    bInst = data[7]; bLo = data[8]; bV0 = data[9];
  } else {                                                         // FORMAT A
    bInst = data[6]; bLo = data[7]; bV0 = data[8];
  }
  const isAmpBypassMsg = (bLo === BYPASS_PARAMLO_AMP || bLo === BYPASS_PARAMLO_CAB)
                         && bInst === currentParamHi;
  const isBlockBypassMsg = (bLo === BYPASS_PARAMLO_BLOCK);
  if (!isAmpBypassMsg && !isBlockBypassMsg) return false;

  const isActive = (bV0 !== BYPASS_V0_BYPASSED);
  const blk = currentChain.find(x => x.handle === bInst);
  const who = blk ? blk.name : ('handle 0x' + bInst.toString(16).padStart(2,'0'));

  if (bLo === BYPASS_PARAMLO_CAB) {
    cabBypassActive = isActive;
    updateCabBypassDisplay(isActive);
    appLog('Bypass: CAB -> ' + (isActive ? 'ACTIVE' : 'BYPASSED'));
  } else if (bLo === BYPASS_PARAMLO_AMP) {
    blockBypass[SLOT_AMP] = isActive;
    updateAmpBypassDisplay(isActive);
    appLog('Bypass: AMP -> ' + (isActive ? 'ACTIVE' : 'BYPASSED'));
  } else if (blk) {
    blockBypass[blk.slotId] = isActive;
    refreshBlockBypassDisplays();
    appLog('Bypass: ' + who + ' -> ' + (isActive ? 'ACTIVE' : 'BYPASSED'));
  } else {
    appLog('Bypass: unknown ' + who + ' (not in chain map), state not stored');
  }
  return true;
}

// ── FORMAT B (explicit-query-response) routing for the amp block only.
// paramLo 0x06 / 0x14 (amp / cab bypass) are handled by routeBypassMessage
// above, for every handle — they never reach here.
function routeFormatBAmpMessage(data) {
  const paramLo = data[8];
  const v0      = data[9];
  const val     = (v0 >= 0x40) ? (v0 - 0x40) : (v0 + 64);
  appLog('CMD 0x11 FORMAT-B paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' v0=0x' + v0.toString(16).padStart(2,'0'));
  if (paramLo === 0x15) { const idx = CAB_V0_TO_INDEX[v0]; if (idx !== undefined) updateCabTypeDisplay(idx); return; }
  if (paramLo === 0x16) { const idx = MIC_V0_TO_INDEX[v0]; if (idx !== undefined) updateMicTypeDisplay(idx); return; }
  if (paramLo === 0x17) { updateAxisDisplay(v0 === 0x3F); return; }
  if (paramLo === 0x18) { updateBreakupDisplay(val); return; }
  appLog('CMD 0x11 FORMAT-B unhandled paramLo=0x' + paramLo.toString(16).padStart(2,'0'));
}

// ── Amp-block (FORMAT A, on currentParamHi) paramLo dispatch — cab/mic,
// gate, amp out, bright, amp select, sync/tremolo, and the tone knobs.
// paramLo 0x06 / 0x14 (amp / cab bypass) are handled by routeBypassMessage
// above — they never reach here.
function routeAmpBlockParam(paramLo, v0, val) {
  if (paramLo === 0x15) {
    const idx = CAB_V0_TO_INDEX[v0];
    if (idx !== undefined) updateCabTypeDisplay(idx);
    else appLog('CMD 0x11 cab type unknown v0=0x' + v0.toString(16).padStart(2,'0'));
    return;
  }
  if (paramLo === 0x16) {
    const idx = MIC_V0_TO_INDEX[v0];
    if (idx !== undefined) updateMicTypeDisplay(idx);
    else appLog('CMD 0x11 mic type unknown v0=0x' + v0.toString(16).padStart(2,'0'));
    return;
  }
  if (paramLo === 0x17) { updateAxisDisplay(v0 === 0x3F); return; }
  if (paramLo === 0x18) { updateBreakupDisplay(val); return; }

  // paramLo 0x04 = Gate Threshold
  if (paramLo === 0x04) {
    const wrap = document.getElementById('gate-thresh-wrap');
    if (wrap) {
      wrap.dataset.value = val;
      drawKnob(wrap.querySelector('canvas'), val);
      document.getElementById('gate-thresh-val').textContent = valGateThresh(val);
    }
    return;
  }

  // paramLo 0x05 = Gate Release
  if (paramLo === 0x05) {
    const wrap = document.getElementById('gate-release-wrap');
    if (wrap) {
      wrap.dataset.value = val;
      drawKnob(wrap.querySelector('canvas'), val);
      document.getElementById('gate-release-val').textContent = valGateRelease(val);
    }
    return;
  }

  // paramLo 0x0E = Bright toggle
  if (paramLo === 0x0E) {
    updateBrightReadout(val);
    return;
  }

  // paramLo 0x03 = Amp Out
  if (paramLo === 0x03) {
    updateAmpOutReadout(val);
    return;
  }

  // paramLo 0x0F = Amp Select — raw v0, not scaled
  if (paramLo === 0x0F) {
    // Signal the post-nav pull that amp identity has landed, BEFORE any
    // early return below, so a value we cannot match still releases the
    // wait rather than stalling it to timeout.
    ampSelectRxSeq++;
    const match = AMP_SELECT_BY_V0[v0];
    if (match) {
      appLog('Amp Select readback: v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase() + ' -> ' + match.label);
      if (match.key !== currentAmpKey) {
        setCurrentAmp(match.key);
        // setCurrentAmp -> updateToneKnobs has just relabelled the tone
        // stack and blanked every knob to "--". The stored values are
        // still in the rack (amp params are per SLOT, not per model), so
        // ask for them back. Without this the knobs sit at "--" forever,
        // which is the whole reason this call exists. See
        // requestAmpBlockParamsAfterAmpChange in transport.js.
        //
        // Deliberately fires on ANY amp identity change, whether the user
        // picked it in our dropdown, changed it on the rack's front panel,
        // or the Avid editor changed it — all three arrive here the same
        // way. The post-nav pull sets it too, but that path re-queries
        // everything itself a moment later, and the sequence guard means
        // the later of the two simply supersedes this one.
        if (typeof requestAmpBlockParamsAfterAmpChange === 'function') {
          requestAmpBlockParamsAfterAmpChange();
        }
      }
    } else {
      appLog('Amp Select readback: v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase() + ' — no matching entry');
    }
    return;
  }

  // paramLo 0x12 = Sync selector, 0x13 = Tremolo on/off.
  // Both confirmed 7/23/2026. They are amp-block parameters and only reach
  // here on the amp handle, so no extra gating is needed — but they must be
  // routed BEFORE the tone-knob loop, because Sync is a 'selector' entry in
  // AMP_TONE_PARAMS and would otherwise fall through to "unhandled paramLo".
  if (paramLo === 0x12) { updateSyncReadout(val); return; }
  if (paramLo === 0x13) { updateTremReadout(val); return; }

  // Tone knobs — route by paramLo against current amp's AMP_TONE_PARAMS
  const ap = currentAmpKey ? AMP_TONE_PARAMS[currentAmpKey] : null;
  if (ap && ap.knobs) {
    const knobs = ap.knobs.filter(k => k.type === 'knob');
    for (let i = 0; i < knobs.length; i++) {
      if (paramLo === knobs[i].lo) {
        const wrap = document.getElementById('tone-w' + i);
        if (wrap) {
          wrap.dataset.value = val;
          drawKnob(wrap.querySelector('canvas'), val);
          document.getElementById('tone-v' + i).textContent = valDisplay(val);
        }
        appLog('CMD 0x11 tone ' + knobs[i].label + ' paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  appLog('CMD 0x11 unhandled paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
}

// Open captures folder
document.getElementById('btn-open-captures').addEventListener('click', async function() {
  try {
    const dir = await window.electronAPI.getCapturesDir();
    await window.electronAPI.openPath(dir);
    appLog('Opened captures folder: ' + dir);
  } catch(e) {
    appLog('Open folder error: ' + e.message);
  }
});

document.getElementById('btn-change-captures').addEventListener('click', async function() {
  try {
    const result = await window.electronAPI.chooseCapturesDir();
    if (result && result.ok) {
      document.getElementById('capture-path').textContent = 'Folder: ' + result.dir;
      setStatus('Captures folder changed');
      appLog('Captures folder changed to: ' + result.dir);
    }
  } catch(e) {
    appLog('Change captures folder error: ' + e.message);
  }
});

document.getElementById('btn-reset-captures').addEventListener('click', async function() {
  try {
    const result = await window.electronAPI.resetCapturesDir();
    if (result && result.ok) {
      document.getElementById('capture-path').textContent = 'Folder: ' + result.dir;
      setStatus('Captures folder reset to default');
      appLog('Captures folder reset to default: ' + result.dir);
    }
  } catch(e) {
    appLog('Reset captures folder error: ' + e.message);
  }
});

document.getElementById('btn-open-log').addEventListener('click', async function() {
  try {
    const logPath = await window.electronAPI.getLogPath();
    // Derive folder by stripping filename from path
    const logDir = logPath.substring(0, Math.max(logPath.lastIndexOf('\\'), logPath.lastIndexOf('/') ));
    await window.electronAPI.openPath(logDir);
    appLog('Opened log folder: ' + logDir);
  } catch(e) {
    appLog('Open log folder error: ' + e.message);
  }
});

// ════════════════════════════════════════════════════════════════════
// NAVIGATION
// ════════════════════════════════════════════════════════════════════
