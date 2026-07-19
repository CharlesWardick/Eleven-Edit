// ════════════════════════════════════════════════════════════════════
// TRANSPORT.JS — the Java bridge WebSocket connection: connecting,
// sending, the request/response plumbing. Everything that actually
// talks to ElevenRackBridge.jar.
// ════════════════════════════════════════════════════════════════════

function isVendorSpecific(name, desc) {
  var n = ((name||'') + ' ' + (desc||'')).toLowerCase();
  return n.includes('eleven') && (n.includes('no detail') || n.includes('vendor'));
}
function isExternalMidiPort(name, desc) {
  var n = ((name||'') + ' ' + (desc||'')).toLowerCase();
  return n.includes('eleven') && n.includes('external');
}

async function initMIDI() {
  setStatus('Connecting to Java bridge...');
  connectBridgeWs();
}

function connectBridgeWs() {
  try {
    if (bridgeWs && bridgeWs.readyState < 2) { try { bridgeWs.close(); } catch(e) {} }
    bridgeWs = new WebSocket(BRIDGE_URL);

    bridgeWs.onopen = function() {
      bridgeReady = true;
      clearTimeout(bridgeReconnectTimer);
      setStatus('Bridge connected — finding ports...');
      appLog('Bridge WS connected');
      // NOTE: no explicit list_ports request here — the bridge already
      // sends the port list automatically the instant a client connects
      // (see ElevenRackBridge.java handleClient). Asking again here was
      // triggering a full second connect cycle back-to-back with the
      // first one, right at the exact moment the hardware was settling
      // in — very likely why some broadcasts weren't arriving reliably.
    };

    bridgeWs.onclose = function() {
      bridgeReady = false;
      bridgeMidiReady = false;
      document.getElementById('midi-dot').classList.remove('connected');
      document.getElementById('midi-label').textContent = 'Bridge disconnected';
      setStatus('Bridge disconnected — retrying...');
      appLog('Bridge WS closed — will retry');
      setVolumeControlsEnabled(false);
      setGateControlsEnabled(false);
      currentAmpKey = null; currentAmpName = null; currentParamHi = -1; hasReceivedAmpOutValue = false;
      currentChain = []; currentChainInput = null;  // handles are per-session, never reuse across a disconnect
      blockBypass = {}; cabBypassActive = undefined;
      document.getElementById('amp-name-display').textContent = '';
      clearTimeout(bridgeReconnectTimer);
      bridgeReconnectTimer = setTimeout(connectBridgeWs, 3000);
    };

    bridgeWs.onerror = function() {
      setStatus('Bridge error — is ElevenRackBridge.jar running?');
    };

    bridgeWs.onmessage = function(e) {
      try { handleBridgeMsg(JSON.parse(e.data)); }
      catch(ex) { appLog('Bridge msg parse error: ' + ex.message); }
    };
  } catch(e) { setStatus('Bridge connect error: ' + e.message); }
}

function handleBridgeMsg(msg) {
  switch (msg.type) {
    case 'ports':
      populateBridgePorts(msg.devices || []);
      break;
    case 'connected':
      bridgeMidiReady = true;
      midiOutName = 'Eleven Rack (Java bridge)';
      document.getElementById('midi-dot').classList.add('connected');
      document.getElementById('midi-label').textContent = midiOutName;
      setStatus('Ready — ' + midiOutName);
      monitorLog('OUT', 'Bridge MIDI connected — IN=' + msg.inPort + ' OUT=' + msg.outPort);
      appLog('Bridge MIDI connected — IN=' + msg.inPort + ' OUT=' + msg.outPort);
      setVolumeControlsEnabled(true);
      clearStaleReadoutsOnNav();
      if (!hasCompletedInitialConnect) {
        hasCompletedInitialConnect = true;
        appLog('First connect this session — starting on A1 for a predictable state');
        setTimeout(function() {
          goToSlot(0); // handles its own safe name/amp/gate/rig-vol refresh
          setTimeout(function() { requestFullState(); }, 500); // one-time setup only now
        }, 300);
      } else {
        appLog('Reconnect — leaving hardware on whatever patch it currently has');
        setTimeout(function() {
          requestPatchStateAfterNav(); // refresh name/amp/gate/rig-vol for whatever slot we're already on
          requestFullState();          // one-time setup (curr rig confirm, chain map)
        }, 500);
      }
      // NOTE: auto-scan-on-connect was here and got reverted — a full
      // patient, one-slot-at-a-time scan turned out to behave exactly
      // like the fast reactive pulls, just ~3 minutes slower to reach
      // the same result. No proven benefit right now to eating that
      // delay on every launch. The scan itself is still available via
      // the "Scan Bank" button whenever it's worth trying again (e.g.
      // once the real reactive-pull issue is found via Wireshark/MIDI-OX).
      break;
    case 'disconnected':
      bridgeMidiReady = false;
      document.getElementById('midi-dot').classList.remove('connected');
      setStatus('Bridge MIDI disconnected');
      setVolumeControlsEnabled(false);
      setGateControlsEnabled(false);
      currentAmpKey = null; currentAmpName = null; currentParamHi = -1; hasReceivedAmpOutValue = false;
      currentChain = []; currentChainInput = null;  // handles are per-session, never reuse across a disconnect
      blockBypass = {}; cabBypassActive = undefined;
      document.getElementById('amp-name-display').textContent = '';
      break;
    case 'midi_in':
      if (msg.bytes && msg.bytes[0] === 0xF0) {
        const hex = msg.hex || '';
        monitorLog('IN', 'BRIDGE [' + msg.bytes.length + 'b] ' + hex.slice(0,72) + (hex.length>72?'…':''));
        appLog('BRIDGE IN [' + msg.bytes.length + 'b] ' + hex.slice(0, 120));
      }
      // Tuner state — CC 69 (0x45), confirmed via real capture 7/11/2026:
      // hardware broadcasts 0x40 for ON / 0x3F for OFF, reliably, whether
      // triggered by us, the physical front-panel button, or Avid. This
      // is the actual state signal — NOT the same as the separate,
      // high-volume real-time pitch-display stream we deliberately don't
      // want or use.
      if (msg.bytes && msg.bytes.length === 3 && msg.bytes[0] === 0xB0 && msg.bytes[1] === CC_TUNER) {
        handleTunerCC(msg.bytes[2]);
      }
      parseSysEx(msg.bytes || []);
      break;
    case 'error':
      appLog('Bridge error: ' + msg.message);
      setStatus('Bridge: ' + msg.message);
      break;
    case 'log':
      appLog('[bridge] ' + msg.message);
      break;
  }
}

// Populate both port selects from the bridge's device list, auto-detecting
// the Eleven Rack ports, but leaving them user-overridable (Charlie runs
// two units — manual override lets him pick the other one).
//
// NOTE: Windows/Java Sound often returns the same generic getDescription()
// text (or even the same name) for multiple sub-devices of one physical
// USB MIDI interface, so name/desc matching alone isn't fully reliable.
// We treat "auto-detect picked the same device for both IN and OUT" as a
// failed detection rather than silently connecting a port to itself.
function populateBridgePorts(devices) {
  try {
    bridgePorts = devices;
    var outSel = document.getElementById('midi-out-select');
    var inSel  = document.getElementById('midi-in-select');
    outSel.innerHTML = '<option value="">— Select MIDI Output —</option>';
    inSel.innerHTML  = '<option value="">— Select MIDI Input —</option>';

    var autoOut = -1, autoIn = -1;
    devices.forEach(function(d) {
      var label = '[' + d.index + '] ' + d.name + (d.desc ? ' — ' + d.desc : '');
      var o1 = document.createElement('option'); o1.value = String(d.index); o1.textContent = label;
      outSel.appendChild(o1);
      var o2 = document.createElement('option'); o2.value = String(d.index); o2.textContent = label;
      inSel.appendChild(o2);
      if (autoOut < 0 && isExternalMidiPort(d.name, d.desc)) autoOut = d.index;
      if (autoIn  < 0 && isVendorSpecific(d.name, d.desc))   autoIn  = d.index;
    });

    if (autoIn >= 0 && autoIn === autoOut) {
      appLog('Port auto-detect: IN and OUT both matched device [' + autoIn + '] — treating as ambiguous, not auto-connecting');
      autoIn = -1; autoOut = -1;
    }

    window.electronAPI.getSavedPorts().then(function(saved) {
      if (saved) {
        // Prefer an exact (index AND name) match — safe even if multiple
        // devices happen to share a name. Only fall back to a name-only
        // search, and only if that search finds a single unambiguous hit.
        if (saved.outIndex != null && devices[saved.outIndex] && devices[saved.outIndex].name === saved.outName) {
          autoOut = saved.outIndex;
        } else if (saved.outName) {
          var outMatches = devices.filter(d => d.name === saved.outName);
          if (outMatches.length === 1) autoOut = outMatches[0].index;
        }
        if (saved.inIndex != null && devices[saved.inIndex] && devices[saved.inIndex].name === saved.inName) {
          autoIn = saved.inIndex;
        } else if (saved.inName) {
          var inMatches = devices.filter(d => d.name === saved.inName);
          if (inMatches.length === 1) autoIn = inMatches[0].index;
        }
      }
      finishPortSelection(autoIn, autoOut, devices);
    }).catch(function() { finishPortSelection(autoIn, autoOut, devices); });
  } catch(e) { setStatus('Port populate error: ' + e.message); }
}

function finishPortSelection(autoIn, autoOut, devices) {
  var outSel = document.getElementById('midi-out-select');
  var inSel  = document.getElementById('midi-in-select');
  if (autoOut >= 0) outSel.value = String(autoOut);
  if (autoIn  >= 0) inSel.value  = String(autoIn);

  if (autoIn < 0) appLog('IN: "Eleven Rack No details available" port not found — select manually');
  if (autoOut < 0) appLog('OUT: "Eleven Rack External MIDI Port" not found — select manually');

  if (autoIn >= 0 && autoOut >= 0 && autoIn !== autoOut) {
    connectBridgeMidi(autoIn, autoOut, devices);
  } else if (autoIn >= 0 && autoOut >= 0) {
    setStatus('Select IN and OUT ports manually — auto-detect picked the same device for both');
  } else {
    setStatus('Select IN and OUT ports manually');
  }
}

function connectBridgeMidi(inIdx, outIdx, devices) {
  if (!bridgeReady || !bridgeWs) return;
  bridgeInIdx = inIdx; bridgeOutIdx = outIdx;
  bridgeWs.send(JSON.stringify({ cmd: 'connect', inPort: inIdx, outPort: outIdx }));
  var inDev  = (devices || bridgePorts).find(d => d.index === inIdx);
  var outDev = (devices || bridgePorts).find(d => d.index === outIdx);
  window.electronAPI.savePorts({
    inIndex:  inIdx,
    inName:   inDev  ? inDev.name  : null,
    outIndex: outIdx,
    outName:  outDev ? outDev.name : null,
  }).catch(function() {});
}

document.getElementById('midi-out-select').addEventListener('change', function(e) {
  var idx = parseInt(e.target.value, 10);
  if (isNaN(idx) || idx < 0) return;
  var inIdx = bridgeInIdx !== null ? bridgeInIdx : idx;
  connectBridgeMidi(inIdx, idx);
});
document.getElementById('midi-in-select').addEventListener('change', function(e) {
  var idx = parseInt(e.target.value, 10);
  if (isNaN(idx) || idx < 0) return;
  var outIdx = bridgeOutIdx !== null ? bridgeOutIdx : idx;
  connectBridgeMidi(idx, outIdx);
});

function sendHex(hex) {
  if (!bridgeReady || !bridgeWs || bridgeWs.readyState !== 1) {
    setStatus('Bridge not connected');
    return false;
  }
  bridgeWs.send(JSON.stringify({ cmd: 'send', hex: hex }));
  return true;
}

// ── CMD 0x11 SysEx parameter write — the real control mechanism the
// Avid Editor uses for at least Amp Out (paramId 0x03) and Gate Release
// (paramId 0x05), confirmed via Wireshark capture 7/9/2026. Format:
//   F0 13 0B 0F 00 11 [instId] [paramId] [v0][v1][v2][v3][v4] F7
// v0 formula CONFIRMED (79/79 real samples matched, zero mismatches):
//   v0 = (targetV127 + 64) mod 128
// v1-v4 are NOT simply derived from the target value — real samples show
// the SAME v0 arriving with different v1-v4 across different captures,
// so these clearly encode something about the knob-turn gesture/timing,
// not just the destination. For a one-shot software write (not a live
// drag), one real sample at the center value (v0=0x40) shows v1-v4 all
// zero — used here as the "just set it directly" pattern. This part is
// NOT proven the way v0 is; test before trusting fully.
function sendGateParamWrite(instId, paramId, v127) {
  if (instId == null || instId < 0) {
    appLog('sendGateParamWrite: no valid instance id, not sending');
    return false;
  }
  const v0 = ((v127 + 64) % 128) & 0x7F;
  const hex = 'F0 13 0B 0F 00 11 '
    + instId.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramId.toString(16).padStart(2,'0').toUpperCase() + ' '
    + v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00 F7';
  return sendHex(hex);
}

// ── CMD 0x11 parameter write — confirmed wire format 7/14/2026.
// 'instId' in the message IS currentParamHi (runtime handle from chain map).
// paramLo identifies the specific control (consistent across amps).
// Format: F0 13 0B 0F 00 11 [currentParamHi] [paramLo] [v0] 00 00 00 00 F7
function sendParamWrite(paramLo, v127) {
  if (currentParamHi < 0) {
    appLog('sendParamWrite: currentParamHi not set yet, not sending');
    return false;
  }
  const v0 = ((v127 + 64) % 128) & 0x7F;
  const hex = 'F0 13 0B 0F 00 11 '
    + currentParamHi.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramLo.toString(16).padStart(2,'0').toUpperCase() + ' '
    + v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00 F7';
  return sendHex(hex);
}

// ── CMD 0x11 cab/mic/speaker parameter write.
// Cab and mic use non-standard v0 encoding (confirmed 7/16/2026 from Avid editor walk capture).
// Cab: v0 steps by 9 per index, skipping 0x7F. Mic: v0 steps by 18, same skip.
// Axis and bypass use standard (v127+64)%128 encoding.
// All receive as FORMAT B: data[6]=0x04, data[7]=currentParamHi, data[8]=paramLo, data[9]=v0.
// Sends use FORMAT A (without 0x04): hardware accepts and echoes back as FORMAT B.

const CAB_INDEX_TO_V0 = [
  0x40, 0x49, 0x52, 0x5B, 0x64, 0x6D, 0x76, 0x00,
  0x09, 0x12, 0x1B, 0x24, 0x2D, 0x36, 0x3F
];
const MIC_INDEX_TO_V0 = [0x40, 0x52, 0x64, 0x76, 0x09, 0x1B, 0x2D, 0x3F];

// v0 -> index reverse lookups (built once)
const CAB_V0_TO_INDEX = {};
CAB_INDEX_TO_V0.forEach(function(v0, idx) { CAB_V0_TO_INDEX[v0] = idx; });
const MIC_V0_TO_INDEX = {};
MIC_INDEX_TO_V0.forEach(function(v0, idx) { MIC_V0_TO_INDEX[v0] = idx; });

function sendCabParamWrite(paramLo, v127) {
  if (currentParamHi < 0) {
    appLog('sendCabParamWrite: currentParamHi not set, not sending');
    return false;
  }
  let v0;
  if (paramLo === 0x15) {
    // Cab type: direct lookup
    v0 = CAB_INDEX_TO_V0[v127];
    if (v0 === undefined) { appLog('sendCabParamWrite: invalid cab index ' + v127); return false; }
  } else if (paramLo === 0x16) {
    // Mic type: direct lookup
    v0 = MIC_INDEX_TO_V0[v127];
    if (v0 === undefined) { appLog('sendCabParamWrite: invalid mic index ' + v127); return false; }
  } else {
    // Axis, bypass, breakup: standard encoding
    v0 = ((v127 + 64) % 128) & 0x7F;
  }
  const hex = 'F0 13 0B 0F 00 11 '
    + currentParamHi.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramLo.toString(16).padStart(2,'0').toUpperCase() + ' '
    + v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00 F7';
  appLog('sendCabParamWrite: paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' v127=' + v127 + ' v0=0x' + v0.toString(16).padStart(2,'0'));
  return sendHex(hex);
}

// ── CMD 0x36 — To Amp volume (global). slot: 0x02=ToAmp1, 0x03=ToAmp2.
// Confirmed wire format 7/17/2026 from send/echo analysis:
//   F0 13 0B 0F 00 36 [slot] [v0] 00 00 00 00 F7
// slot goes directly at byte[6] — no extra fixed byte before it.
// HW was reading the extra 0x02 byte as slot (always To Amp 1) and
// our slot byte as v0, causing both knobs to control To Amp 1.
// v0 = raw 0x00–0x7F (direct, no formula).
function sendToAmpVolume(slot, v127) {
  const v0 = ((v127 + 64) % 128) & 0x7F;
  const hex = 'F0 13 0B 0F 00 36 '
    + slot.toString(16).padStart(2,'0').toUpperCase() + ' '
    + v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00 F7';
  appLog('sendToAmpVolume: slot=0x' + slot.toString(16).padStart(2,'0') + ' v127=' + v127 + ' v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase());
  return sendHex(hex);
}

// ── CMD 0x3A — To Amp source query. slot: 0x00=ToAmp1, 0x01=ToAmp2.
// Avid editor always sends this REQU before changing the source via CMD 0x37.
// Confirmed 7/17/2026 from Avid editor capture — skipping this caused HW assert.
// Format: F0 13 0B 0F 01 3A [slot] F7
// Response: F0 13 0B 0F 12 3A 07 [slot] [currentVal] F7
function sendToAmpSourceQuery(slot) {
  const hex = 'F0 13 0B 0F 01 3A '
    + slot.toString(16).padStart(2,'0').toUpperCase() + ' F7';
  appLog('sendToAmpSourceQuery: slot=0x' + slot.toString(16).padStart(2,'0'));
  return sendHex(hex);
}

// ── Query-then-write pattern for CMD 0x37.
// Stores the pending slot+val, sends CMD 0x3A query.
// CMD 0x3A response handler in sysex-handler.js then fires CMD 0x37.
var pendingToAmpSource = null; // { slot, val } or null
function sendToAmpSourceQueried(slot, val) {
  if (!bridgeMidiReady) {
    appLog('sendToAmpSourceQueried: bridge not ready');
    return;
  }
  pendingToAmpSource = { slot: slot, val: val };
  appLog('sendToAmpSourceQueried: queuing slot=0x' + slot.toString(16).padStart(2,'0') + ' val=0x' + val.toString(16).padStart(2,'0') + ' — sending CMD 0x3A query first');
  sendToAmpSourceQuery(slot);
}
// val: 0x00=Rig Input, 0x01=Amp Input, 0x02=Amp Output, 0x03=Rig Output.
// Confirmed wire format 7/17/2026 from Avid editor capture (USB framing stripped):
//   F0 13 0B 0F 00 37 07 [slot] [val] F7
// Hardware echoes back with dir=0x02, same format.
// Global setting — not per-patch, not in TFX body.
function sendToAmpSource(slot, val) {
  const hex = 'F0 13 0B 0F 00 37 07 '
    + slot.toString(16).padStart(2,'0').toUpperCase() + ' '
    + (val & 0x7F).toString(16).padStart(2,'0').toUpperCase() + ' F7';
  appLog('sendToAmpSource: slot=0x' + slot.toString(16).padStart(2,'0') + ' val=0x' + (val & 0x7F).toString(16).padStart(2,'0').toUpperCase());
  return sendHex(hex);
}

// ── CMD 0x0D — Stereo/Mono set command.
// Confirmed 2026-07-18 from Avid Diag5 capture (not a toggle — it IS a set).
// Format: F0 13 0B 0F 00 0D [val] F7
// The 0x04 / 0x06 bytes visible in USB captures are USB-MIDI packet framing
// (one per 4-byte group), NOT part of the message. Including 0x06 literally
// made the hardware read it as the value on every send.
// val: 0x01=Mono, 0x00=Stereo.
// Echo suppressed via suppressMonoEcho — echo is not a reliable state indicator.
// Unsolicited HW front panel broadcast: F0 13 0B 0F 02 0D [val] F7
//   broadcast val: 0x00=Stereo, 0x01=Mono.
var suppressMonoEcho = false;
function sendMonoStereo(isMono) {
  if (!bridgeMidiReady) { appLog('sendMonoStereo: bridge not ready'); return; }
  const val = isMono ? 0x01 : 0x00;
  const hex = 'F0 13 0B 0F 00 0D ' + val.toString(16).padStart(2,'0').toUpperCase() + ' F7';
  appLog('sendMonoStereo: ' + (isMono ? 'MONO' : 'STEREO') + ' val=0x' + val.toString(16).padStart(2,'0').toUpperCase());
  suppressMonoEcho = true;
  sendHex(hex);
}

// ── Chain reorder — CMD 0x21 sent back with dir=0x00 (Tech Ref Sec 4).
// There is no dedicated reorder command: you send a COMPLETE chain map
// describing the order you want, re-using each block's existing model id and
// handle, and re-linking the back-links to describe the new sequence.
//
//   F0 13 0B 0F 00 21 [11 triplets] [trailing] F7          41 bytes
//   triplet = [backLink][mid][handle]
//   backLink of triplet N = slot ID of triplet N-1
//   triplet 0 is the input block and back-links to ITSELF (head marker)
//   trailing byte = slot ID of the LAST block
//
// The hardware replies with a dir=0x02 broadcast of the arrangement it
// actually adopted, which may differ from what we sent — it recomputes
// mono/stereo propagation and re-instantiates any block whose channel
// configuration changed, giving those blocks new model ids and handles.
// ADOPT THE BROADCAST. Do not assume our send stuck; renderChainRow() runs
// off the broadcast, so the row is always drawing what the hardware has.
function sendChainOrder(newOrder) {
  if (!bridgeMidiReady) { appLog('sendChainOrder: bridge not ready'); return false; }
  if (!currentChainInput) { appLog('sendChainOrder: no input block yet'); return false; }
  if (!newOrder || newOrder.length !== 10) {
    appLog('sendChainOrder: expected 10 blocks, got ' + (newOrder ? newOrder.length : 0));
    return false;
  }
  const b = [0xF0,0x13,0x0B,0x0F,0x00,0x21];
  b.push(SLOT_INPUT, currentChainInput.modelId, currentChainInput.handle);
  for (let i = 0; i < 10; i++) {
    const backLink = (i === 0) ? SLOT_INPUT : newOrder[i-1].slotId;
    b.push(backLink, newOrder[i].modelId, newOrder[i].handle);
  }
  b.push(newOrder[9].slotId, 0xF7);
  const hex = b.map(x => x.toString(16).padStart(2,'0').toUpperCase()).join(' ');
  appLog('sendChainOrder: ' + newOrder.map(x => x.name).join(' > '));
  sendHex(hex);
  return true;
}

// ── Bypass — CMD 0x11 on the block's OWN handle (Tech Ref Sec 3, 4).
//   normal block  paramLo 0x01
//   amp           paramLo 0x06
//   cab           paramLo 0x14   (same handle as the amp — one block, two flags)
//   v0 0x40 = active, 0x3F = bypassed
// Wire format is the standard param write:
//   F0 13 0B 0F 00 11 [handle] [paramLo] [v0] 00 00 00 00 F7
//
// NOTE the handle MUST come from the chain map. Addressing a fixed handle is
// what kept amp/cab bypass broken until 2026-07-19 — see sysex-handler.js.
function sendBypassWrite(handle, paramLo, isActive) {
  if (!bridgeMidiReady) { appLog('sendBypassWrite: bridge not ready'); return false; }
  if (handle === undefined || handle === null || handle < 0) {
    appLog('sendBypassWrite: no handle, not sending');
    return false;
  }
  const v0 = isActive ? BYPASS_V0_ACTIVE : BYPASS_V0_BYPASSED;
  const hex = 'F0 13 0B 0F 00 11 '
    + handle.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramLo.toString(16).padStart(2,'0').toUpperCase() + ' '
    + v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00 F7';
  appLog('sendBypassWrite: handle=0x' + handle.toString(16).padStart(2,'0').toUpperCase()
    + ' paramLo=0x' + paramLo.toString(16).padStart(2,'0').toUpperCase()
    + ' -> ' + (isActive ? 'ACTIVE' : 'BYPASSED'));
  sendHex(hex);
  return true;
}

function ampBlockHandle() {
  const b = currentChain.find(x => x.slotId === SLOT_AMP);
  return b ? b.handle : -1;
}

function sendAmpBypass(isActive) {
  return sendBypassWrite(ampBlockHandle(), BYPASS_PARAMLO_AMP, isActive);
}
function sendCabBypass(isActive) {
  return sendBypassWrite(ampBlockHandle(), BYPASS_PARAMLO_CAB, isActive);
}

// ── Read bypass state from the hardware.
// REQU PARAM: F0 13 0B 0F 01 11 [handle] [paramLo] F7
// The handle is the block's own handle from the chain map. An older revision
// of the reference doc showed a literal 0x07 here, which silently fails on any
// patch where that is not the block you want — do not reintroduce it.
//
// Needed because the TFX carries no amp-bypass key: without this the amp
// always displays as active. Called once after each chain map arrives.
function requestAmpCabBypass() {
  if (!bridgeMidiReady) return;
  const h = ampBlockHandle();
  if (h < 0) { appLog('requestAmpCabBypass: no amp handle yet'); return; }
  const hh = h.toString(16).padStart(2,'0').toUpperCase();
  appLog('requestAmpCabBypass: querying amp/cab bypass on handle 0x' + hh);
  sendHex('F0 13 0B 0F 01 11 ' + hh + ' 06 F7');
  sendHex('F0 13 0B 0F 01 11 ' + hh + ' 14 F7');
}

// Same wire format as sendGateParamWrite, but takes the raw byte to send
// directly rather than a 0-127 "scaled value" run through the (v+64)%128
// formula — used for Amp Select (paramId 0x0F), where we already have
// the exact confirmed byte for each amp from a real capture, not a
// continuous value that needs scaling.
function sendRawParamWrite(instId, paramId, rawV0) {
  if (instId == null || instId < 0) {
    appLog('sendRawParamWrite: no valid instance id, not sending');
    return false;
  }
  const hex = 'F0 13 0B 0F 00 11 '
    + instId.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramId.toString(16).padStart(2,'0').toUpperCase() + ' '
    + (rawV0 & 0x7F).toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00 F7';
  return sendHex(hex);
}

async function sendCC(cc, val) {
  if (!bridgeMidiReady) { setStatus('Bridge MIDI not connected'); return; }
  var hex = 'B0 ' + cc.toString(16).padStart(2,'0').toUpperCase() + ' ' + val.toString(16).padStart(2,'0').toUpperCase();
  if (sendHex(hex)) monitorLog('OUT', 'CC ' + cc + ' → ' + val);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Manual "Capture Current Patch Now" — see the bulk TFX handler in
// parseSysEx for where this actually gets saved to disk.
//
// This used to bounce to a different slot and back before requesting the
// patch, based on an earlier (pre-double-connect-fix) observation that a
// cold REQU SEND_PATCH didn't seem to get a response. In hindsight that
// was very likely a symptom of the duplicate list_ports/double-connect
// bug (fixed since) racing the MIDI port right at startup — not a real
// hardware requirement. Direct on-demand REQU SEND_PATCH already works
// fine elsewhere (connect, per-nav refresh) without any bounce, so this
// does too. The bounce was also almost certainly the actual cause of
// gate/amp not updating from a manual capture — it moved currentSlot out
// from under this request via its own async CMD 0x02 confirmations,
// racing the direct fix below in the bulk handler. ──
async function requestFullState() {
  if (!bridgeMidiReady) return;
  sendHex(REQU_CURR_RIG);   await sleep(150);
  sendHex(REQU_CHAIN_MAP);
  appLog('Requested one-time setup state (curr rig confirm, chain map)');
}

// Amp, name, Rig Vol, and CHAIN_MAP are all per-patch — refresh all four
// shortly after every navigation, whether we sent the nav ourselves or
// the hardware's own front panel did (this is called from the CMD 0x02
// slot-confirm handler below, which fires either way). CHAIN_MAP matters
// here specifically because currentParamHi can differ per patch — without
// refreshing it on every nav, the live CMD 0x11 gate/amp-out receive
// filter keeps checking incoming broadcasts against a STALE instance ID
// from whatever patch was active when CHAIN_MAP was last fetched (i.e.
// only ever the very first patch visited after connect), silently
// dropping every physical knob turn on any patch visited after that one.
// currentSlot is already correctly set by the time this runs (by
// updateDisplay, or by the CMD 0x02 handler itself for hardware-
// initiated nav), so a plain exact-match check against it is safe —
// protects against a stale response for an older slot arriving late
// during fast navigation (auto-roll) and yanking the display backward.
async function requestPatchStateAfterNav() {
  if (!bridgeMidiReady) return;
  await sleep(200);
  sendHex(REQU_SEND_PATCH); await sleep(150);
  sendHex(REQU_PATCH_NAME); await sleep(150);
  sendHex(REQU_CHAIN_MAP);  await sleep(150);
  sendHex(REQU_RIG_VOL);
}

// ════════════════════════════════════════════════════════════════════
// BANK SCAN — walk every slot on our own terms and build a local
// reference (amp, gate, name, per slot), instead of depending on a
// live pull landing correctly in the moment. Read-only throughout —
// navigates and pulls, never writes anything to the hardware.
// ════════════════════════════════════════════════════════════════════

// Navigate to one slot, wait for it to settle, then request and await
// its patch data. Resolves with {body, slotNum} on success, or null on
// timeout — never rejects, so the scan loop can just move on either way.
