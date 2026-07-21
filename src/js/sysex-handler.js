// ════════════════════════════════════════════════════════════════════
// SYSEX-HANDLER.JS — parseSysEx, the central dispatcher for every
// incoming SysEx message from the bridge. Large and central enough to
// get its own file rather than living inside protocol.js or
// transport.js — it calls into both, plus ui.js and capture-scan.js.
// ════════════════════════════════════════════════════════════════════

async function parseSysEx(data) {
  if (data.length < 6) return;
  if (data[0] !== 0xF0 || data[1] !== 0x13 || data[2] !== 0x0B ||
      (data[3] !== 0x0F && data[3] !== 0x0E)) return;

  const dirByte = data[4];
  const cmd     = data[5];

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
  if (cmd === 0x00 || cmd === 0x01) {
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

      // Decode amp model, gate, Amp Out, and tone knob values from the shared body
      const ampInfo = decodeAmpKey(body);
      if (ampInfo && ampInfo.key) setCurrentAmp(ampInfo.key);
      updateGateReadout(decodeGateValues(body, ampInfo ? ampInfo.markerPos : null));
      updateAmpOutReadout(decodeAmpOutValue(body, ampInfo ? ampInfo.markerPos : null));
      updateToneReadouts(decodeToneKnobValues(body, ampInfo ? ampInfo.markerPos : null, ampInfo ? ampInfo.key : null), ampInfo ? ampInfo.key : null);
      updateCabMicReadouts(decodeCabMicValues(body));
      updateMonoIndicator(decodeMonoStereo(body));
      updateToAmpVolumeReadouts(decodeToAmpVolumes(body));
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
        // Decode amp model, gate, Amp Out, and tone knob values from the shared body
        const ampInfo = decodeAmpKey(body);
        if (ampInfo && ampInfo.key) setCurrentAmp(ampInfo.key);
        updateGateReadout(decodeGateValues(body, ampInfo ? ampInfo.markerPos : null));
        updateAmpOutReadout(decodeAmpOutValue(body, ampInfo ? ampInfo.markerPos : null));
        updateToneReadouts(decodeToneKnobValues(body, ampInfo ? ampInfo.markerPos : null, ampInfo ? ampInfo.key : null), ampInfo ? ampInfo.key : null);
        updateCabMicReadouts(decodeCabMicValues(body));
        updateMonoIndicator(decodeMonoStereo(body));
        updateToAmpVolumeReadouts(decodeToAmpVolumes(body));
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
    return;
  }

  // CMD 0x04 — Save slot/name confirmation
  if (cmd === 0x04 && data.length >= 8) {
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
    return;
  }

  // CMD 0x02 — Current rig number (slot confirmation)
  if (cmd === 0x02 && data.length >= 8) {
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
    return;
  }

  // CMD 0x03 — Save rig response
  // Two variants: data[7]=0x01 = save confirmation, data[7]=0x00 = slot confirmation
  // Only pause roller on save confirmation (0x01)
  if (cmd === 0x03) {
    appLog('CMD 0x03 response: ' + Array.from(data).map(b=>b.toString(16).padStart(2,'0')).join(' '));
    if (data.length >= 8 && data[7] === 0x01 && autoStartTime !== null && !autoPaused) {
      togglePause();
      appLog('Roller paused — hardware save detected (CMD 0x03 save variant)');
    }
    return;
  }

  // CMD 0x05 — Patch name
  if (cmd === 0x05) {
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
    return;
  }

  // CMD 0x21 — Chain map.
  //
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
  if (cmd === 0x21) {
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
    } else {
      // Should not happen — every rig has an amp block.
      appLog('CMD 0x21: no AMP block (slot 0x00) found in chain map, paramHi unchanged');
    }
    return;
  }

  // CMD 0x07 — Rig Volume hardware knob broadcast
  if (cmd === 0x07) {
    const v0  = data[6];
    const val = (v0 >= 0x40) ? (v0 - 0x40) : (v0 + 64);
    const wrap = document.getElementById('rig-vol-wrap');
    if (wrap) {
      wrap.dataset.value = val;
      drawKnob(wrap.querySelector('canvas'), val);
      document.getElementById('rig-vol-val').textContent = valRigVol(val);
    }
    return;
  }

  // CMD 0x40 — Tuner state broadcast
  // F0 13 0B 0F 02 40 [state] F7 — confirmed 7/15/2026 from session log
  // data[6]=0x01 = tuner ON, data[6]=0x00 = tuner OFF
  // Hardware never echoes CC 69 back — it responds with this SysEx instead.
  if (cmd === 0x40 && data.length >= 7) {
    handleTunerCC(data[6] === 0x01 ? 127 : 0);
    return;
  }

  // CMD 0x0D — Stereo/Mono echo/broadcast.
  // Hardware echo after SW send is always 02 0D 01 regardless of direction —
  // not a reliable state indicator. Suppress it for one cycle after a SW send.
  // Unsolicited front-panel broadcasts are passed through normally.
  if (cmd === 0x0D) {
    if (suppressMonoEcho) {
      suppressMonoEcho = false;
      appLog('CMD 0x0D echo suppressed (SW send in progress)');
      return;
    }
    const val = (data.length >= 9) ? data[7] : data[6];
    const isMono = (val === 0x01);
    updateMonoIndicator(isMono);
    return;
  }

  // CMD 0x36 — To Amp volume hardware knob broadcast
  // Format: F0 13 0B 0F 02 36 [slot] [v0] 00 00 00 00 F7
  // slot: 0x02=ToAmp1, 0x03=ToAmp2. v0 = raw 0x00–0x7F (no formula).
  // Confirmed 7/17/2026 from HW knob capture.
  // Drag flags (toAmp1Dragging / toAmp2Dragging) suppress display update
  // while user is actively dragging the SW knob.
  if (cmd === 0x36 && data.length >= 8) {
    const slot = data[6];
    const v0   = data[7];
    const val  = (v0 >= 0x40) ? (v0 - 0x40) : (v0 + 64);
    if (slot === 0x02) {
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
    return;
  }

  // CMD 0x3A — To Amp source query response
  // Format: F0 13 0B 0F 12 3A 07 [slot] [currentVal] F7  (10 bytes)
  // data[6]=0x07, data[7]=slot, data[8]=currentVal
  // Fires after our CMD 0x3A REQU. If a pendingToAmpSource matches this
  // slot, send the queued CMD 0x37 now that HW has confirmed readiness.
  // Confirmed 7/17/2026 — Avid always queries before writing; skipping caused assert.
  if (cmd === 0x3A && data.length >= 10) {
    const slot = data[7];
    const currentVal = data[8];
    appLog('CMD 0x3A ToAmp' + (slot === 0x00 ? '1' : '2') + ' source query resp: currentVal=0x' + currentVal.toString(16).padStart(2,'0').toUpperCase());
    if (pendingToAmpSource !== null && pendingToAmpSource.slot === slot) {
      const pending = pendingToAmpSource;
      pendingToAmpSource = null;
      appLog('CMD 0x3A response received — now sending CMD 0x37 slot=0x' + pending.slot.toString(16).padStart(2,'0') + ' val=0x' + pending.val.toString(16).padStart(2,'0'));
      sendToAmpSource(pending.slot, pending.val);
    }
    return;
  }

  // CMD 0x37 — To Amp source broadcast
  // Format: F0 13 0B 0F 02 37 07 [slot] [val] F7
  // slot: 0x00=ToAmp1, 0x01=ToAmp2.
  // val:  0x00=Rig Input, 0x01=Amp Input, 0x02=Amp Output, 0x03=Rig Output.
  // Confirmed 7/17/2026 from Avid editor capture.
  if (cmd === 0x37 && data.length >= 9) {
    const slot = data[6];
    const val  = data[7];
    const selId = (slot === 0x00) ? 'toamp1-src' : (slot === 0x01) ? 'toamp2-src' : null;
    if (selId) {
      const sel = document.getElementById(selId);
      if (sel) sel.value = String(val);
      appLog('CMD 0x37 ToAmp' + (slot+1) + ' source: val=0x' + val.toString(16).padStart(2,'0').toUpperCase());
    }
    return;
  }

  // CMD 0x3D — Input selector broadcast
  if (cmd === 0x3D) {
    const inputVal = data[6];
    appLog('CMD 0x3D input selector: 0x' + inputVal.toString(16).padStart(2,'0').toUpperCase());
    setInputButtons(inputVal);
    return;
  }

  // CMD 0x11 — Parameter readback. Two formats on MIDI layer:
  // FORMAT A — ASYNC broadcasts: data[6]=instId, data[7]=paramLo, data[8]=v0
  // FORMAT B — RESP to explicit REQU: data[6]=0x04, data[7]=instId, data[8]=paramLo, data[9]=v0
  if (cmd === 0x11 && data.length >= 9) {

    // ── BYPASS ROUTING — handled for EVERY block, not just the amp.
    // Bypass lives on each block's own handle, so it must be processed before
    // the amp-only instId guard below (which exists because all the other amp
    // parameters are meaningless coming from another block).
    //   paramLo 0x01 = block bypass   0x06 = amp bypass   0x14 = cab bypass
    //   v0 0x40 = active, 0x3F = bypassed
    //
    // FORMAT B DETECTION NOTE: Format B has 0x04 as a literal marker byte at
    // data[6], NOT a handle. However, a block's runtime handle CAN legitimately
    // be 0x04 (e.g. MOD in certain chain orders), producing a Format A response
    // that starts with the same byte. Disambiguate by checking whether 0x04
    // exists as a real handle in currentChain — if it does, data[6] IS the
    // handle and this is Format A.
    {
      let bInst, bLo, bV0;
      const handleAtData6 = currentChain.find(x => x.handle === data[6]);
      if (data[6] === 0x04 && !handleAtData6 && data.length >= 10) { // FORMAT B
        bInst = data[7]; bLo = data[8]; bV0 = data[9];
      } else {                                                         // FORMAT A
        bInst = data[6]; bLo = data[7]; bV0 = data[8];
      }
      if (bLo === BYPASS_PARAMLO_BLOCK || bLo === BYPASS_PARAMLO_AMP || bLo === BYPASS_PARAMLO_CAB) {
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
        return;
      }
    }

    // FORMAT B check
    if (data[6] === 0x04 && currentParamHi >= 0 && data[7] === currentParamHi && data.length >= 10) {
      const paramLo = data[8];
      const v0      = data[9];
      const val     = (v0 >= 0x40) ? (v0 - 0x40) : (v0 + 64);
      appLog('CMD 0x11 FORMAT-B paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' v0=0x' + v0.toString(16).padStart(2,'0'));
      // paramLo 0x06 / 0x14 (amp / cab bypass) are handled by the bypass
      // routing block above, for every handle — they never reach here.
      if (paramLo === 0x15) { const idx = CAB_V0_TO_INDEX[v0]; if (idx !== undefined) updateCabTypeDisplay(idx); return; }
      if (paramLo === 0x16) { const idx = MIC_V0_TO_INDEX[v0]; if (idx !== undefined) updateMicTypeDisplay(idx); return; }
      if (paramLo === 0x17) { updateAxisDisplay(v0 === 0x3F); return; }
      if (paramLo === 0x18) { updateBreakupDisplay(val); return; }
      appLog('CMD 0x11 FORMAT-B unhandled paramLo=0x' + paramLo.toString(16).padStart(2,'0'));
      return;
    }

    const instId  = data[6];
    const paramLo = data[7];
    const v0      = data[8];
    const val     = (v0 >= 0x40) ? (v0 - 0x40) : (v0 + 64);

    // instId matches currentParamHi (runtime handle from chain map)
    if (instId !== currentParamHi || currentParamHi < 0) {
      appLog('CMD 0x11 instId=0x' + instId.toString(16).padStart(2,'0') +
        ' — does not match currentParamHi=0x' + (currentParamHi<0?'(none)':currentParamHi.toString(16).padStart(2,'0')) + ', ignored');
      return;
    }

    // paramLo 0x06 / 0x14 (amp / cab bypass) handled by the bypass routing
    // block above — they never reach here.
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
      const match = AMP_SELECT_BY_V0[v0];
      if (match) {
        appLog('Amp Select readback: v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase() + ' -> ' + match.label);
        if (match.key !== currentAmpKey) setCurrentAmp(match.key);
      } else {
        appLog('Amp Select readback: v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase() + ' — no matching entry');
      }
      return;
    }

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
