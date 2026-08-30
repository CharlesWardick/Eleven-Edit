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
  splashSetProgress('Starting Java bridge...', 0.1);
  armStartupGate();
  connectBridgeWs();
}

// Arms the startup-only connect gate: if the rack still isn't found after
// a few seconds' grace for normal connect latency, and this is still the
// FIRST connect of the session, show the blocking modal. No-op if the
// initial connect already succeeded once (see hasCompletedInitialConnect).
function armStartupGate() {
  clearTimeout(startupGateTimer);
  startupGateTimer = setTimeout(function() {
    if (!bridgeMidiReady && !hasCompletedInitialConnect) showStartupGate();
  }, STARTUP_GATE_TIMEOUT_MS);
}

// Splash reveal — fires electronAPI.appReady() exactly once, the first
// time the chain map, the post-nav param pull, AND the firmware identity
// check have all landed (see initialChainMapDone/initialNavPullDone/
// firmwareCheckDone, state.js). Called from handleChainMap
// (sysex-handler.js), requestPatchStateAfterNav's finish() below, and
// handleIdentityReply/armFirmwareCheckTimeout, each time any of the
// three completes.
// FIRMWARE GATE (2026-08-28): if the check completed but didn't match
// (wrong build, or no reply at all), the main window is NEVER revealed —
// showFirmwareGate takes over instead, same "stay hidden behind the
// splash forever rather than show dead/wrong controls" contract the
// no-hardware gate already uses. This only runs once per session
// (appRevealed guards re-entry); a mid-session reconnect doesn't re-gate.
function checkInitialPopulateReady() {
  if (appRevealed) return;
  if (!initialChainMapDone || !initialNavPullDone || !firmwareCheckDone) return;
  if (!firmwareOk) {
    if (typeof showFirmwareGate === 'function') showFirmwareGate(firmwareVersionSeen);
    return;
  }
  appRevealed = true;
  splashSetProgress('Ready', 1);
  if (window.electronAPI) window.electronAPI.appReady();
  appLog('Startup: initial chain/knob state populated — revealing main window');
}

function sendIdentityRequest() {
  sendHex('F0 7E 7F 06 01 F7');
  appLog('Sent MIDI Identity Request (firmware check)');
}

// Fail closed: if nothing replies within the timeout, treat the check as
// failed rather than leaving it pending forever (which would leave the
// app stuck on the splash with no explanation).
function armFirmwareCheckTimeout() {
  clearTimeout(firmwareCheckTimer);
  firmwareCheckTimer = setTimeout(function() {
    if (firmwareCheckDone) return;
    firmwareCheckDone = true;
    firmwareOk = false;
    firmwareVersionSeen = null;
    appLog('Firmware identity check: no reply within ' + FIRMWARE_CHECK_TIMEOUT_MS + 'ms — treating as unverified/blocked');
    checkInitialPopulateReady();
  }, FIRMWARE_CHECK_TIMEOUT_MS);
}

function connectBridgeWs() {
  try {
    if (bridgeWs && bridgeWs.readyState < 2) { try { bridgeWs.close(); } catch(e) {} }
    bridgeWs = new WebSocket(BRIDGE_URL);

    bridgeWs.onopen = function() {
      bridgeReady = true;
      clearTimeout(bridgeReconnectTimer);
      setStatus('Bridge connected — finding ports...');
      splashSetProgress('Bridge connected — looking for Eleven Rack...', 0.3);
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
      blockBypass = {}; cabBypassActive = undefined; globalCabBypass = undefined;
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
      clearTimeout(startupGateTimer);
      hideStartupGate();
      splashSetProgress('Eleven Rack found — reading current patch...', 0.6);
      midiOutName = 'Eleven Rack (Java bridge)';
      document.getElementById('midi-dot').classList.add('connected');
      document.getElementById('midi-label').textContent = 'Connected';
      setStatus('Ready — ' + midiOutName);
      monitorLog('OUT', 'Bridge MIDI connected — IN=' + msg.inPort + ' OUT=' + msg.outPort);
      appLog('Bridge MIDI connected — IN=' + msg.inPort + ' OUT=' + msg.outPort);
      setVolumeControlsEnabled(true);
      clearStaleReadoutsOnNav();
      if (!hasCompletedInitialConnect) {
        hasCompletedInitialConnect = true;
        // Firmware check (2026-08-28) — only on the FIRST connect of the
        // session, same scope as the reveal gate itself; a mid-session
        // reconnect doesn't re-block (matches the no-hardware gate's own
        // "mid-session drop is the status bar's job" scoping).
        firmwareCheckDone = false; firmwareOk = false; firmwareVersionSeen = null;
        sendIdentityRequest();
        armFirmwareCheckTimeout();
        appLog('First connect this session — reflecting the rack\'s current patch (no forced nav)');
        setTimeout(function() {
          // Behave like Avid: land on whatever patch the rack is already on
          // instead of forcing A1. Force the next slot confirmation to register
          // as a change (currentSlot starts at 0, and the rack may be on A1)
          // so the CMD 0x02 handler runs its clearStaleReadoutsOnNav +
          // requestPatchStateAfterNav for us. requestFullState's REQU_CURR_RIG
          // is what elicits that confirmation; it also refreshes the chain map.
          currentSlot = -1;
          requestFullState();
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
      //
      // The Jump List "by name" scan (2026-08-03) is NOT that reverted
      // scan — it's 104 tiny read-only name queries (no per-slot patch
      // recall/navigation at all), so it doesn't carry the same 3-minute
      // cost. Delayed 2s so it doesn't compete with the startup-gate-
      // critical chain-map/nav pull above; fire-and-forget, replies land
      // asynchronously via handlePatchNameEnumReply (sysex-handler.js)
      // whenever they arrive.
      //
      // (2026-08-03: briefly bumped to 5s chasing a reported white flash at
      // the splash->main reveal, on the theory this scan's main-thread work
      // could be overlapping that transition. CONFIRMED UNRELATED same
      // day — the flash only reproduces on VMs (virtualized/software GPU
      // rendering, a known-for-years Chromium compositor bug unrelated to
      // this app), never on real hardware. Reverted back to 2s — the delay
      // was making the by-name list and chain-row graphics noticeably
      // slower to populate for no actual benefit.)
      setTimeout(function() {
        if (typeof scanPatchNames === 'function') scanPatchNames();
      }, 2000);
      break;
    case 'disconnected':
      bridgeMidiReady = false;
      document.getElementById('midi-dot').classList.remove('connected');
      setStatus('Bridge MIDI disconnected');
      setVolumeControlsEnabled(false);
      setGateControlsEnabled(false);
      currentAmpKey = null; currentAmpName = null; currentParamHi = -1; hasReceivedAmpOutValue = false;
      currentChain = []; currentChainInput = null;  // handles are per-session, never reuse across a disconnect
      blockBypass = {}; cabBypassActive = undefined; globalCabBypass = undefined;
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

// ── Patch name query (CMD 0x04, REQU form) — Jump List "by name" view,
// 2026-08-03. Read-only, cheap: no patch recall, no navigation, unlike the
// existing (hidden) Scan Bank feature.
// ADDRESSING — CONFIRMED LIVE 2026-08-03 (Charlie's first test + session
// log F0 13 0B 0F 01 04 [space] [slot] F7 request/reply pairs), NOT the
// same scheme as the SAVE protocol's CMD 0x04 write form:
//   [space] = 0x00 USER patches, 0x01 FACTORY patches. Only two valid
//             values — this is NOT bank=floor(slot/4) the way the SAVE
//             form's first byte is.
//   [slot]  = the FULL raw slot index (0-103 / 0x00-0x67) within that
//             space — NOT num=slot%4.
// The first (wrong) version of this function reused the SAVE form's
// bank/num split, which only ever asked slot%4 (0-3) of either space —
// coincidentally correct for A1-A4 (space=0 IS user, and floor(slot/4)=0
// happens to equal 0 same as the real space byte there), then silently
// wrong from slot 4 (B1) onward: bank=1,num=0 under the old scheme reads
// as [space=1(FACTORY), slot=0] = factory a1, not user B1 — exactly the
// "B1-B4 show a1-a4" bug Charlie caught. Bank 2+ under the old scheme
// isn't a valid [space] value at all, which is why nothing past B4 ever
// got a reply (matches the blank C1 onward Charlie saw).
// spaceIdx defaults to 0 (user) — this app only ever browses user patches
// (Charlie's call, 2026-08-03); factory a1-z4 stays unused for now.
function sendPatchNameQuery(slot, spaceIdx) {
  const spaceHex = (spaceIdx || 0).toString(16).padStart(2,'0').toUpperCase();
  const slotHex  = slot.toString(16).padStart(2,'0').toUpperCase();
  sendHex('F0 13 0B 0F 01 04 ' + spaceHex + ' ' + slotHex + ' F7');
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
// Per-patch write wrapper (item, 7/26): any write that changes patch data goes
// through here so the SAVE button latches green (dirty). Global writes (To Amp
// source) and all queries/readbacks keep calling sendHex directly and never
// mark dirty. The latch is cleared on patch nav and on save.
function sendPatchWrite(hex) {
  if (typeof markPatchDirty === 'function') markPatchDirty();
  return sendHex(hex);
}

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
  return sendPatchWrite(hex);
}

// ── CMD 0x11 parameter write — confirmed wire format 7/14/2026.
// 'instId' in the message IS currentParamHi (runtime handle from chain map).
// paramLo identifies the specific control (consistent across amps).
// Format: F0 13 0B 0F 00 11 [currentParamHi] [paramLo] [v0] 00 00 00 00 F7
// ── STOPGAP, 2026-07-23 — Speed and Sync are READ-ONLY.
// On the DC models these two are interlocked in the hardware: selecting a
// Sync division forces Speed to a fixed value, and turning the real Speed
// knob on the rack resets Sync to OFF. Our writes do neither, so the hardware
// fights them and snaps Speed back — the erratic knob behaviour.
// Wire evidence (session 2026-07-23-063859): Sync always broadcasts trailing
// bytes 00 00 00 10, Speed mostly 7F 7F 7F 1F, while sendParamWrite sends
// trailing 00 00 00 00 — matching neither. Depth tolerates it; Speed does not
// and the rack forces Speed to 0 in response.
// Until the interlock and the trailing-byte meaning are properly established,
// display these two but never write them. Set to [] to re-enable writes.
// EMPTIED 7/23/2026. Both are now writable. The Avid capture
// Avid_Shark_Sync_Test.pcapng settled why writes used to fail: it was the
// Sync interlock, not a malformed message. With Sync on a division the rack
// IGNORES every Speed write — Avid sent ~40 in that capture and the hardware
// echoed the same unchanged value back each time. Avid never clears Sync
// first, so its Speed knob does nothing in that state either.
// Our rule instead mirrors the hardware: turning Speed clears Sync to OFF
// first, exactly as the rack does when its own Speed knob is turned.
// The trailing 00 00 00 00 this file already sent was never wrong. Avid's own
// Sync-OFF write is byte identical to ours; the 0x10 that appears in the
// final byte of every hardware BROADCAST is added by the rack on the way out.
// Put 0x11 and/or 0x12 back in this array to make either read-only again —
// the knob styling and the dropdown both follow it automatically.
var READ_ONLY_PARAM_LOS = [];

function sendParamWrite(paramLo, v127) {
  if (READ_ONLY_PARAM_LOS.indexOf(paramLo) !== -1) {
    appLog('sendParamWrite: paramLo 0x' +
           paramLo.toString(16).padStart(2,'0').toUpperCase() +
           ' is read-only (Speed/Sync interlock) — write suppressed');
    return false;
  }
  if (currentParamHi < 0) {
    appLog('sendParamWrite: currentParamHi not set yet, not sending');
    return false;
  }
  // ENDPOINT SENTINELS (added 7/23/2026). A CMD 0x11 value is five 7-bit
  // bytes, not one: v1..v4 are the LOW-ORDER bits of the same quantity, not
  // padding. Sending v0 with 00 00 00 00 therefore asks for the very BOTTOM of
  // that step. Most controls are quantised to the byte and cannot tell, but
  // Speed carries real sub-step precision and reported 9.9 when asked for
  // 10.0 — it was doing exactly as told.
  // Section 7 already documents the true endpoints: min 40 00 00 00,
  // max 3F 7F 7F 7F. Writes carry 0F in the final byte where broadcasts carry
  // 1F, that 0x10 being added by the rack on the way out (confirmed against
  // Avid's own writes in Avid_Shark_Sync_Test.pcapng).
  // Applies to every knob: for controls already reaching 10.0 this asks for a
  // value strictly closer to true maximum than before, so nothing visible
  // changes, and any future high-precision control is right from the start.
  let tail;
  if (v127 >= 127)     { tail = '3F 7F 7F 7F 0F'; }
  else if (v127 <= 0)  { tail = '40 00 00 00 00'; }
  else {
    const v0 = ((v127 + 64) % 128) & 0x7F;
    tail = v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00';
  }
  const hex = 'F0 13 0B 0F 00 11 '
    + currentParamHi.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramLo.toString(16).padStart(2,'0').toUpperCase() + ' '
    + tail + ' F7';
  return sendPatchWrite(hex);
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
  return sendPatchWrite(hex);
}

// ── CMD 0x36 — To Amp volume. PER-PATCH, NOT GLOBAL (corrected 7/23/2026;
// this comment said "global" for weeks and was simply wrong — the values live
// in the TFX body and return with the patch. Tech Ref Sec 18 / C13).
// slot: 0x02=ToAmp1, 0x03=ToAmp2.
// Confirmed wire format 7/17/2026 from send/echo analysis:
//   F0 13 0B 0F 00 36 [slot] [v0] 00 00 00 00 F7
// slot goes directly at byte[6] — no extra fixed byte before it.
// HW was reading the extra 0x02 byte as slot (always To Amp 1) and
// our slot byte as v0, causing both knobs to control To Amp 1.
// v0 = raw 0x00–0x7F (direct, no formula).
// ENDPOINT SENTINEL (added 2026-08-27 — the "9.9 bug", ported here from
// sendParamWrite/CMD 0x11). Sec 7 already documents CMD 0x36 as part of the
// same single-byte-offset-binary family as 0x11/0x07, sentinels included
// (min 0x40 00 00 00, max 0x3F 7F 7F 7F) — this command just never got the
// fix applied. A plain "v0 00 00 00 00" tail asks for the BOTTOM of v0's
// step, not its top; for the true max (v0=0x3F) that lands about one step
// short of +12.0 dB, matching Charlie's report of maxing out at 11.8. The
// true min (v0=0x40 00 00 00) was already correct by coincidence — the
// bottom of that step IS the true minimum, so mute was never affected.
function sendToAmpVolume(slot, v127) {
  let v0, tail;
  if (v127 >= 127)     { v0 = 0x3F; tail = '7F 7F 7F 7F'; }
  else if (v127 <= 0)  { v0 = 0x40; tail = '00 00 00 00'; }
  else                 { v0 = ((v127 + 64) % 128) & 0x7F; tail = '00 00 00 00'; }
  const hex = 'F0 13 0B 0F 00 36 '
    + slot.toString(16).padStart(2,'0').toUpperCase() + ' '
    + v0.toString(16).padStart(2,'0').toUpperCase() + ' ' + tail + ' F7';
  appLog('sendToAmpVolume: slot=0x' + slot.toString(16).padStart(2,'0') + ' v127=' + v127 + ' v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase());
  return sendPatchWrite(hex);
}

// ── CMD 0x36 outSel 0x00 — Master (Main) output volume.
// Same wire family as To Amp 1/2 above, outSel goes in the exact same byte
// position as their "slot" byte. Confirmed 7/29/2026 from Charlie's live
// Main-knob drag in Avid Editor (Master_Volume_Mute_Phones_Capture.pcapng):
// the HW/echo side streamed F0 13 0B 0F 02 36 00 [v0] 00 00 00 00 F7 exactly
// like a To Amp knob. The SW WRITE direction below was not separately
// captured (a drag only ever shows the echo) — it mirrors sendToAmpVolume's
// pattern, untested until the first hardware build with this feature.
// v0<->v127 byte encoding confirmed identical to To Amp 1/2 (SW send + HW
// readback tracking both work, per Charlie 7/29/2026) — but the DISPLAY
// scale is NOT the same: Main Volume is a plain 0-10 linear dial (see
// valToMasterVol in ui.js), not To Amp's -12..+12 dB (valToAmpVol). Confirmed
// by Charlie's hardware test the same day (the only thing wrong initially).
// PER-PATCH VS GLOBAL UNKNOWN — see Tech Ref. Not sent via sendPatchWrite
// (does not light the SAVE dirty latch) so an eventual "actually global"
// answer costs nothing to correct for.
function sendMasterVolume(v127) {
  const v0 = ((v127 + 64) % 128) & 0x7F;
  const hex = 'F0 13 0B 0F 00 36 00 '
    + v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00 F7';
  appLog('sendMasterVolume: v127=' + v127 + ' v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase());
  return sendHex(hex);
}

// ── CMD 0x3B — Master Mute (Main / Phones).
// Confirmed 7/29/2026 from Avid Editor USB capture: SW send AND HW echo use
// the same 9-byte form. Retracts the old "front-panel only [DEAD-send]"
// reading of this command — that reading only ever saw a front-panel
// broadcast, never a software send.
//   F0 13 0B 0F 00 3B [channel] [state] F7
// channel: MUTE_CH_MAIN (0x00) / MUTE_CH_PHONES (0x01). state: 0x00/0x01.
// Global (output/monitoring) setting — plain sendHex, no dirty-latch marking.
function sendMute(channel, muted) {
  const hex = 'F0 13 0B 0F 00 3B '
    + channel.toString(16).padStart(2,'0').toUpperCase() + ' '
    + (muted ? '01' : '00') + ' F7';
  appLog('sendMute: channel=' + (channel === MUTE_CH_MAIN ? 'Main' : 'Phones') + ' muted=' + muted);
  return sendHex(hex);
}

// ── CMD 0x3A — To Amp source query. slot: 0x00=ToAmp1, 0x01=ToAmp2.
// RETIRED 2026-08-29 (dormant, not called by any active path). The 2026-08-29
// ToAmp_Source capture shows the Avid editor sends NO CMD 0x3A before a source
// change — six changes, zero queries. The old "must query first or it asserts"
// belief was a side effect of the real bug: the malformed 0x37 (extra 0x07
// framing byte, now fixed) was what asserted, not the missing query. Source is
// now sent bare, matching Avid exactly. Left here in case a connect-time
// "read current source" is ever wanted (would need a fresh 0x3A response
// capture to confirm the true reply length — the 07 below is likely framing too).
// Format: F0 13 0B 0F 01 3A [slot] F7
// Response (per 7/17 read, unverified against the framing correction):
//   F0 13 0B 0F 12 3A 07 [slot] [currentVal] F7
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
// slot: 0x00=ToAmp1, 0x01=ToAmp2.
// CORRECTED WIRE FORMAT (2026-08-29, ToAmp_Source capture, Opus session):
//   F0 13 0B 0F 00 37 [slot] [val] F7          <- 9 bytes, what Avid sends
// The old "F0 13 0B 0F 00 37 07 [slot] [val] F7" was WRONG: that 0x07 is a
// USB-MIDI packet-framing byte (the CIN header on the final 4-byte packet,
// 0x07 = "SysEx ends, 3 data bytes"), NOT part of the message. It was misread
// off the 7/17 capture and baked in here. Sending it shifted every byte over —
// the rack read slot=0x07 (out of range; only 0x00/0x01 exist), which is why
// (a) the source never moved and (b) it bricked: a bad index into a 2-entry
// ROUTING table. Exact same class of bug already fixed on CMD 0x0D Stereo/Mono
// (see sendMonoStereo below — "the 0x04 / 0x06 bytes are USB-MIDI framing").
// The Java bridge adds the USB-MIDI framing on the way out, so we send the
// clean SysEx only. Hardware echoes back dir=0x02, same 9-byte layout.
// Global setting — not per-patch, not in TFX body, does NOT light the SAVE latch.
function sendToAmpSource(slot, val) {
  const hex = 'F0 13 0B 0F 00 37 '
    + slot.toString(16).padStart(2,'0').toUpperCase() + ' '
    + (val & 0x7F).toString(16).padStart(2,'0').toUpperCase() + ' F7';
  appLog('sendToAmpSource: slot=0x' + slot.toString(16).padStart(2,'0') + ' val=0x' + (val & 0x7F).toString(16).padStart(2,'0').toUpperCase());
  return sendHex(hex);
}

// ── CMD 0x38 — Global cabinet bypass ("Cab Always Off"). GLOBAL, not per-patch.
// READ:  F0 13 0B 0F 01 38 F7   -> reply F0 13 0B 0F 12 38 [state] F7
//   Confirmed to be exactly what the Avid editor sends on startup
//   (Avid_Startup_With_Rack_On.pcapng, 2026-08-30) — the rack does not
//   volunteer this state on connect/nav, so we must ask, like Avid does.
// SET:   F0 13 0B 0F 00 38 [state] F7   (state 0x01 = engaged/no cab, 0x00 = clear)
//   The old "0x38 front-panel only / dead-send" note is unverified against this;
//   Avid's own "master cabinet bypass is on — turn it off?" prompt clears it, so
//   the set is expected to work. NOT a brick-class command (only 0x37 bricks).
// Replies/echoes route to handleGlobalCabBypass (sysex-handler.js) via the cmd
// dispatch, which updates globalCabBypass and the chain CAB display.
function sendGlobalCabBypassQuery() {
  if (!bridgeMidiReady) return;
  appLog('sendGlobalCabBypassQuery: reading global cab-off state (01 38)');
  return sendHex('F0 13 0B 0F 01 38 F7');
}
function sendGlobalCabBypassSet(engaged) {
  if (!bridgeMidiReady) return;
  const hex = 'F0 13 0B 0F 00 38 ' + (engaged ? '01' : '00') + ' F7';
  appLog('sendGlobalCabBypassSet: ' + (engaged ? 'engage (no cab)' : 'clear'));
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
  sendPatchWrite(hex);
}

// ── CMD 0x50 — Rig tempo set.
// Format: F0 13 0B 0F 00 50 d1 d2 d3 d4 F7, the four 6-bit digits of the
// microseconds-per-beat value (protocol.js, rigTempoBpmToDigits).
// The rack echoes the same value straight back with dir 0x02, so there is no
// need to suppress the echo the way CMD 0x0D does — the echo agrees with what
// we sent and simply repaints the same number.
// COST WARNING: every tempo change makes the rack rebroadcast the parameters
// of every tempo-synced block. Three CMD 0x11 messages in the calibration
// capture, but an earlier front-panel sweep produced 753. Callers must
// throttle; ui.js does this on a trailing timer.
function sendRigTempo(bpm) {
  if (!bridgeMidiReady) { appLog('sendRigTempo: bridge not ready'); return; }
  if (bpm < TEMPO_BPM_MIN) bpm = TEMPO_BPM_MIN;
  if (bpm > TEMPO_BPM_MAX) bpm = TEMPO_BPM_MAX;
  var d = rigTempoBpmToDigits(bpm);
  var hh = function(v) { return v.toString(16).padStart(2, '0').toUpperCase(); };
  var hex = 'F0 13 0B 0F 00 50 ' + hh(d[0]) + ' ' + hh(d[1]) + ' '
          + hh(d[2]) + ' ' + hh(d[3]) + ' F7';
  appLog('sendRigTempo: ' + bpm.toFixed(1) + ' BPM  ('
         + Math.round(60000000 / bpm) + ' us/beat)  ' + hex);
  return sendPatchWrite(hex);
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
  sendPatchWrite(hex);
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
  sendPatchWrite(hex);
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


// ── Read bypass state for EVERY chain block from the hardware.
// REQU PARAM: F0 13 0B 0F 01 11 [handle] [paramLo] F7
// The handle is the block's own handle from the chain map. An older revision
// of the reference doc showed a literal 0x07 here, which silently fails on any
// patch where that is not the block you want — do not reintroduce it.
//
// Queries all ten blocks: paramLo 0x01 for the nine ordinary blocks, plus
// 0x06 and 0x14 on the amp block for its two independent flags.
//
// WHY ALL TEN: nothing pushes bypass state to us unprompted. An earlier
// version asked only for amp and cab, and the other nine slots appeared to
// work purely because the Avid editor happened to be open alongside and its
// own queries produced broadcasts we picked up. With our app running alone,
// those nine stayed 'unknown' forever and their clicks were silently ignored.
// Called once after each chain map, which covers patch load, stereo/mono
// toggle and reorder — all the events that can invalidate handles.
// PACED (2026-08-29) — was a synchronous forEach firing all 11+ queries in
// one zero-delay burst. Same unthrottled-flood shape as the pre-existing
// knob-write flood that needed queueKnobSend's 60ms throttle (this file's
// own history — a flood here could desync the amp handle and freeze
// knobs). requestAllBypass runs right after EVERY chain-map refresh,
// including the one immediately after every Save (post-save handle
// reassignment) — i.e. right on top of whatever traffic a block/model
// edit just put in flight. Prime suspect (not yet proven, see session log
// 2026-08-29 "timing and flood" entry) for the FX1/amp corruption Charlie
// hit repeatedly the same day. Paced with the same NAV_QUERY_GAP already
// used for every other post-nav query burst (requestPatchStateAfterNav,
// this file) rather than inventing a new interval.
// SERIALIZED (2026-08-29) against requestFxHostParams via runPacedBurst
// (see its own comment, this file) — without this, a bypass sweep and an
// FX-host param query triggered around the same event could interleave
// their sends on the wire.
function requestAllBypass() {
  return runPacedBurst(requestAllBypassImpl);
}
async function requestAllBypassImpl() {
  if (!bridgeMidiReady) return;
  if (!currentChain.length) { appLog('requestAllBypass: no chain map yet'); return; }
  let n = 0;
  for (const blk of currentChain) {
    const hh = blk.handle.toString(16).padStart(2,'0').toUpperCase();
    if (blk.slotId === SLOT_AMP) {
      sendHex('F0 13 0B 0F 01 11 ' + hh + ' 06 F7');   // amp
      await sleep(NAV_QUERY_GAP);
      sendHex('F0 13 0B 0F 01 11 ' + hh + ' 14 F7');   // cab
      await sleep(NAV_QUERY_GAP);
      // AMP SELECT re-verify (paramLo 0x0F) — added 2026-08-29. Found via a
      // Wireshark comparison against the Avid Editor doing the identical
      // Save-to-Rack + FX-host-model-change sequence (Charlie's own
      // capture): Avid re-queries paramLo 0x0F EVERY time the chain map
      // refreshes (initial load, post-save, post-model-change) — this app
      // never did, anywhere, at all, after the one-time startup readback.
      // That's a real, confirmed gap regardless of what turns out to be
      // causing the actual amp corruption Charlie's been chasing all day:
      // he can SEE the amp change on the rack's own front panel when it
      // happens, but this app had no code path that would ever notice or
      // update its display to match, since it never asked again. Adding
      // this both fixes that (a real bug on its own) and gives the next
      // test run direct evidence, in OUR OWN log, of exactly when/whether
      // the amp value actually changes on hardware — the same visibility
      // Avid's own capture already had and this app didn't.
      sendHex('F0 13 0B 0F 01 11 ' + hh + ' 0F F7');   // amp select
      await sleep(NAV_QUERY_GAP);
      n += 3;
    } else {
      sendHex('F0 13 0B 0F 01 11 ' + hh + ' 01 F7');   // block bypass
      await sleep(NAV_QUERY_GAP);
      n += 1;
    }
  }
  appLog('requestAllBypass: queried ' + n + ' bypass flags across ' + currentChain.length + ' blocks');
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

// Serializes paced query bursts (requestAllBypass, requestFxHostParams) so
// two of them can't interleave their sends on the wire. Found 2026-08-29:
// once both were converted to paced async functions (each awaiting
// NAV_QUERY_GAP between sends), nothing stopped two from running at the
// SAME time if both got triggered around the same event (e.g. a chain-map
// reply firing both a bypass sweep and an FX-host panel refresh) — their
// individual awaited sends round-robin on the event loop and end up
// shuffled together on the wire, e.g. a bypass query for one handle
// immediately followed by an FX-host param query for a different handle,
// where before pacing existed each burst was atomic. runPacedBurst chains
// callers onto one shared promise so each burst runs to completion before
// the next one starts, while each burst keeps its own internal pacing.
let pacedBurstQueue = Promise.resolve();
function runPacedBurst(fn) {
  const run = pacedBurstQueue.then(fn, fn);
  pacedBurstQueue = run.catch(() => {});
  return run;
}

// CCs that carry PER-PATCH values (so a change should light the SAVE latch).
// Only Rig Volume (CC 17) qualifies. Input select (CC 65/66/67) is a GLOBAL
// hardware setting and the Tuner (CC 69) is transient — neither belongs to the
// patch, so they must NOT mark it dirty. (7/27)
var PER_PATCH_CCS = [17];

async function sendCC(cc, val) {
  if (!bridgeMidiReady) { setStatus('Bridge MIDI not connected'); return; }
  var hex = 'B0 ' + cc.toString(16).padStart(2,'0').toUpperCase() + ' ' + val.toString(16).padStart(2,'0').toUpperCase();
  var ok = (PER_PATCH_CCS.indexOf(cc) !== -1) ? sendPatchWrite(hex) : sendHex(hex);
  if (ok) monitorLog('OUT', 'CC ' + cc + ' → ' + val);
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
  // Global cab bypass (CMD 0x38) is GLOBAL and never volunteered on connect/nav,
  // so query it here like Avid does at startup — otherwise the chain CAB block
  // can't know it's forced off (2026-08-30). Reply -> handleGlobalCabBypass.
  await sleep(80);
  sendGlobalCabBypassQuery();
  appLog('Requested one-time setup state (curr rig confirm, chain map, global cab)');
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
// DIAGNOSTIC FLAG — flicker investigation, 2026-07-22.
// The Avid editor never requests CMD 0x01 (the ~1.2 KB bulk TFX dump) after a
// patch recall; we do, and it is the only large transfer in our post-nav
// sequence. Set this false to skip it during navigation and see whether the
// second front-panel flicker disappears.
// WHILE FALSE, everything decoded from the bulk body goes stale or blank:
// amp name, tone knobs, gate, amp out, cab/mic, stereo/mono, to-amp volumes.
// That is expected. Set back to true to restore normal behaviour.
var REQUEST_BULK_ON_NAV = false;

// DIAGNOSTIC — amp paramLo investigation, 2026-07-22.
// After each nav, fire the five queries the Avid editor sends that we have
// never decoded, and dump the replies in full. Looking for a parameter
// descriptor for the current amp.
var PROBE_UNKNOWN_QUERIES = false;

// DIAGNOSTIC — sweep the amp's own parameters, paramLo 0x01..0x19, against the
// runtime handle from CMD 0x21, and log each reply in full. The Wireshark
// captures lost the 5th value byte of every reply; our own log does not, so
// this gives clean values to correlate against the readouts.
var PROBE_AMP_PARAM_SWEEP = false;

async function probeUnknownQueries() {
  if (!bridgeMidiReady) return;
  appLog('PROBE ---- unknown-query probe start ----');
  var list = [['0x03', REQU_PROBE_03], ['0x08', REQU_PROBE_08],
              ['0x0A', REQU_PROBE_0A], ['0x34', REQU_PROBE_34],
              ['0x50', REQU_PROBE_50],
              ['0x36 bare',   REQU_PROBE_36],
              ['0x36 slot02', REQU_PROBE_36_S2],
              ['0x36 slot03', REQU_PROBE_36_S3],
              ['0x0D mono',   REQU_PROBE_0D]];
  for (var i = 0; i < list.length; i++) {
    appLog('PROBE  -> query CMD ' + list[i][0]);
    sendHex(list[i][1]);
    await sleep(250);
  }
  appLog('PROBE ---- unknown-query probe end ----');
}

async function probeAmpParamSweep() {
  if (!bridgeMidiReady) return;
  if (typeof currentParamHi === 'undefined' || currentParamHi === null) {
    appLog('PROBE sweep skipped — no amp paramHi yet (CMD 0x21 not seen)');
    return;
  }
  var hi = currentParamHi;
  appLog('PROBE ---- amp param sweep start, paramHi=0x' +
         hi.toString(16).padStart(2, '0').toUpperCase() + ' ----');
  var hh = function(v) { return v.toString(16).padStart(2, '0').toUpperCase(); };
  for (var lo = 0x01; lo <= 0x19; lo++) {
    sendHex('F0 13 0B 0F 01 11 ' + hh(hi) + ' ' + hh(lo) + ' F7');
    await sleep(120);
  }
  appLog('PROBE ---- amp param sweep end ----');
}

// ════════════════════════════════════════════════════════════════════
// POST-NAV STATE PULL
//
// Two modes, chosen by REQUEST_BULK_ON_NAV.
//
//   TRUE  — legacy: request the ~1.2 KB bulk TFX dump (CMD 0x01) and decode
//           every readout from its body. Correct, but the bulk request is
//           what makes the hardware front panel flicker a second time
//           (confirmed 2026-07-22).
//   FALSE — targeted: read each value with its own small query, the way the
//           Avid editor does. No bulk, no second flicker.
//
// Kept as a flag so one edit returns to known-good behaviour if the targeted
// path ever misbehaves.
//
// TFX capture on hardware save is NOT affected by either mode — saves arrive
// as an unprompted CMD 0x00 broadcast on a separate path.
// ════════════════════════════════════════════════════════════════════

// ── Post-nav timing. All four are tuning knobs; adjust here, nowhere else.
//
// Measured from the real Avid editor (Avid_Edit_Patch_Changes_.pcapng,
// 2026-07-22): it issues 47 queries per recall in ~660 ms, average gap
// 14.3 ms, MEDIAN gap 1.1 ms. It fires most queries back-to-back and only
// pauses for the bulky replies (max observed gap 190 ms). Our first build
// used 120 ms flat, roughly ten times slower than the hardware needs, which
// is why panel refresh felt sluggish.
//
// These values put us at Avid's pace with a little margin. If anything reads
// stale or arrives out of order, raise NAV_QUERY_GAP first.
var NAV_QUERY_GAP    = 15;   // between ordinary queries
var NAV_RECALL_SETTLE = 100; // after the patch recall, before querying
var NAV_CHAIN_TIMEOUT = 900; // max wait for the chain map reply (see below)
var NAV_AMP_TIMEOUT   = 700; // max wait for the amp identity reply (see below)
var ROLLER_NAV_SETTLE_GUARD = 2000; // ms after a recall during which an
  // incoming CMD 0x03 dirty-flag broadcast is treated as settle/query noise
  // from the recall itself (worst case: NAV_RECALL_SETTLE + NAV_CHAIN_TIMEOUT
  // + NAV_AMP_TIMEOUT + several NAV_QUERY_GAPs), not a genuine user edit —
  // see sysex-handler.js handleSaveRigResponse and the 2026-08-11 bug report.
var NAV_BASELINE_SETTLE = 250; // after the last query, before snapshotting the
                               // knob-colour baseline (item A) — lets the async
                               // CMD 0x11 replies land first. Raise if a freshly
                               // navigated patch shows red knobs it should not.

// Incremented on every nav. A sequence that finds its id superseded, or the
// slot changed underneath it, abandons the rest of its queries so replies
// for an abandoned patch cannot paint stale values during fast navigation
// or auto-roll.
var navSeqId = 0;

// ── SHARED AMP BLOCK PARAM LIST ──────────────────────────────────────
// The set of paramLo values worth querying on the amp block for whatever
// amp is currently selected. Used by BOTH the post-nav pull (Phase 3) and
// the amp-type-change refresh, so the two can never fall out of step.
//
// Only types the app can actually route and display are included. This
// mirrors decodeToneKnobValues(), which filters to the same two, so the
// targeted path reads exactly what the bulk path decoded — no more, no less.
// 'selector' entries (15 across the amp table, e.g. Sync on the DC models)
// are deliberately EXCLUDED from the generic loop: ui.js has no selector
// rendering. Sync is added explicitly below because it DOES have a display
// path. When general selector readback is implemented, add 'selector' here.
function ampBlockParamLos(who) {
  var los = [0x03,        // amp out
             0x04, 0x05,  // gate threshold, gate release
             0x0E,        // bright
             0x15, 0x16,  // cab type, mic type
             0x17, 0x18]; // mic axis, speaker breakup

  var ap = (typeof AMP_TONE_PARAMS !== 'undefined' && currentAmpKey)
           ? AMP_TONE_PARAMS[currentAmpKey] : null;
  if (ap && ap.knobs) {
    for (var k = 0; k < ap.knobs.length; k++) {
      var kt = ap.knobs[k].type;
      if (kt !== 'knob' && kt !== 'toggle') continue;
      var klo = ap.knobs[k].lo;
      if (typeof klo === 'number' && los.indexOf(klo) === -1) los.push(klo);
    }
    // Tremolo feature set — Sync (0x12) and On/Off (0x13). Sync is a
    // 'selector' and 0x13 is not in the tone table at all, so neither is
    // picked up by the filter above; both now have a display path, so both
    // are queried here. Adds 2 queries, and only on the 15 amps that have
    // tremolo. Depth (0x10) and Speed (0x11) are plain knobs and already
    // came through the loop above.
    if (typeof ampHasTremolo === 'function' && ampHasTremolo(currentAmpKey)) {
      if (los.indexOf(0x12) === -1) los.push(0x12);
      if (los.indexOf(0x13) === -1) los.push(0x13);
    }
  } else {
    appLog((who || 'ampBlockParamLos') + ': no tone map for amp "'
           + (currentAmpKey || 'unknown') + '"');
  }
  return los;
}


// ── AMP TYPE CHANGE — RE-QUERY THE BLOCK ─────────────────────────────
// WHY THIS EXISTS (confirmed 2026-07-24, hardware, cross-checked against
// the Avid editor):
//   Amp parameters are stored PER CHAIN SLOT, not per amp model. Changing
//   the amp model changes only which parameters are exposed and what they
//   are called; the stored values are untouched. Avid shows values after an
//   amp change because it re-reads the block. We showed "--" because
//   setCurrentAmp -> updateToneKnobs blanks every knob to 64 and nothing
//   ever asked the hardware again.
//
//   NOTE — this is NOT a chain map change. Amp type is CMD 0x11 paramLo
//   0x0F, a parameter INSIDE the amp block. The block's slot and runtime
//   handle do not move, so unlike the DIST/REVERB model change (CMD 0x21,
//   which gets a fresh handle) there is nothing to re-read from the chain
//   map here. Do not add a chain map request to this path.
//
//   Consequence worth knowing when testing: a control shared by two models
//   under different names is ONE stored value. Editing 59 Tweed's "Tone"
//   and switching back to a Treadplate shows that value on "Treble". That
//   is real hardware behaviour, matches Avid, and is not a bug.
var AMP_CHANGE_SETTLE = 100;   // ms after the 0x0F echo before re-querying.
                               // Same figure the REVERB panel uses after a
                               // model change. Provisional — raise it if the
                               // log shows queries going unanswered.
var ampChangeReqSeq = 0;       // cancels an in-flight refresh if the amp
                               // changes again before it runs

// Standalone CMD 0x11 read builder. Deliberately NOT the paramQuery() inside
// requestPatchStateAfterNav — that one is a private helper of the nav pull and
// also increments the nav query counter feeding the Dev timings panel. Reusing
// it would both be out of scope (the error that broke the first build) and
// pollute the nav timing figures with queries the nav pull never made.
function ampParamQuery(hi, lo) {
  function hh(v) { return v.toString(16).padStart(2, '0').toUpperCase(); }
  return 'F0 13 0B 0F 01 11 ' + hh(hi) + ' ' + hh(lo) + ' F7';
}

async function requestAmpBlockParamsAfterAmpChange() {
  var mySeq = ++ampChangeReqSeq;
  var slotAtStart = (typeof currentSlot !== 'undefined') ? currentSlot : null;

  await sleep(AMP_CHANGE_SETTLE);

  // Superseded by a newer amp change, or the user navigated away.
  if (mySeq !== ampChangeReqSeq) {
    appLog('Amp change refresh abandoned — amp changed again');
    return;
  }
  if (typeof currentSlot !== 'undefined' && currentSlot !== slotAtStart) {
    appLog('Amp change refresh abandoned — patch changed');
    return;
  }
  if (!bridgeMidiReady) return;
  if (typeof currentParamHi !== 'number' || currentParamHi < 0) {
    appLog('Amp change refresh: no amp handle — skipped');
    return;
  }

  var hi  = currentParamHi;
  var los = ampBlockParamLos('Amp change refresh');
  appLog('Amp change refresh: querying ' + los.length + ' params for '
         + (currentAmpName || currentAmpKey || 'unknown')
         + ' handle=0x' + hi.toString(16).padStart(2,'0').toUpperCase());

  for (var i = 0; i < los.length; i++) {
    if (mySeq !== ampChangeReqSeq) {
      appLog('Amp change refresh abandoned mid-query — amp changed again');
      return;
    }
    sendHex(ampParamQuery(hi, los[i]));
    await sleep(NAV_QUERY_GAP);
  }
}


async function requestPatchStateAfterNav() {
  if (!bridgeMidiReady) return;

  var mySeq     = ++navSeqId;
  var startSlot = currentSlot;
  var tStart    = Date.now();
  var qCount    = 0;

  function stale() {
    if (mySeq !== navSeqId) return true;
    if (currentSlot !== startSlot) return true;
    return false;
  }
  function hh(v) { return v.toString(16).padStart(2, '0').toUpperCase(); }
  function paramQuery(hi, lo) {
    qCount++;
    return 'F0 13 0B 0F 01 11 ' + hh(hi) + ' ' + hh(lo) + ' F7';
  }
  function finish() {
    var ms = Date.now() - tStart;
    appLog('Nav pull complete: ' + qCount + ' param queries, ' + ms + ' ms');
    initialNavPullDone = true;
    checkInitialPopulateReady();
  }

  await sleep(NAV_RECALL_SETTLE);
  if (stale()) { appLog('Nav pull abandoned — slot changed'); return; }

  // ── Legacy bulk path ──
  if (REQUEST_BULK_ON_NAV) {
    sendHex(REQU_SEND_PATCH); await sleep(150);
    sendHex(REQU_PATCH_NAME); await sleep(150);
    sendHex(REQU_CHAIN_MAP);  await sleep(150);
    sendHex(REQU_RIG_VOL);
    if (PROBE_UNKNOWN_QUERIES) { await sleep(300); await probeUnknownQueries(); }
    if (PROBE_AMP_PARAM_SWEEP) { await sleep(300); await probeAmpParamSweep(); }
    return;
  }

  // ── Targeted path ──
  // PHASE 1 — structure. The chain map sets currentParamHi and currentChain,
  // and its handler fires requestAllBypass, so bypass flags come along free.
  sendHex(REQU_PATCH_NAME); await sleep(NAV_QUERY_GAP);
  if (stale()) { appLog('Nav pull abandoned — slot changed'); return; }
  // Wait for the chain map to be APPLIED, not a fixed delay. Until it is,
  // currentParamHi belongs to the previous patch, and every amp-block query
  // would address the wrong block.
  var chainBefore = chainMapRxSeq;
  sendHex(REQU_CHAIN_MAP);
  var cwaited = 0;
  while (chainMapRxSeq === chainBefore && cwaited < NAV_CHAIN_TIMEOUT) {
    await sleep(10);
    cwaited += 10;
    if (stale()) { appLog('Nav pull abandoned — slot changed'); return; }
  }
  if (chainMapRxSeq === chainBefore) {
    appLog('Nav pull: chain map did not arrive within ' + NAV_CHAIN_TIMEOUT +
           'ms — amp block queries skipped this pass');
    if (stale()) return;
  }

  if (typeof currentParamHi !== 'number' || currentParamHi < 0) {
    appLog('Nav pull: no amp paramHi after chain map — amp block queries skipped');
  } else {
    var hi = currentParamHi;

    // PHASE 2 — amp identity FIRST. Tone knob paramLo values are looked up
    // per amp, so currentAmpKey must be set before phase 3 or the tone
    // replies arrive unroutable. This ordering was the fault in the
    // 2026-07-22 diagnostic build.
    // Wait for the REPLY, not a fixed delay. The tone list built below is
    // per-amp, so if currentAmpKey still holds the previous patch's amp we
    // query the wrong paramLo set — observed 2026-07-22, where navigating to
    // Bassguy 59 used lead800's knobs, leaving Vol Norm (0x08) unread and
    // 0x09 unroutable. Polling the receipt counter adapts to however long the
    // hardware actually takes; the timeout only bounds a lost reply.
    var seqBefore = ampSelectRxSeq;
    sendHex(paramQuery(hi, 0x0F));
    var waited = 0;
    while (ampSelectRxSeq === seqBefore && waited < NAV_AMP_TIMEOUT) {
      await sleep(10);
      waited += 10;
      if (stale()) { appLog('Nav pull abandoned — slot changed'); return; }
    }
    if (ampSelectRxSeq === seqBefore) {
      appLog('Nav pull: amp identity did not arrive within ' + NAV_AMP_TIMEOUT +
             'ms — tone list may use the previous amp');
    }
    if (stale()) { appLog('Nav pull abandoned — slot changed'); return; }

    // PHASE 3 — amp block. Fixed params first, then this amp's tone controls.
    // List built by the shared builder (see ampBlockParamLos) so this path and
    // the amp-type-change path can never drift apart.
    var los = ampBlockParamLos('Nav pull');

    for (var i = 0; i < los.length; i++) {
      if (stale()) { appLog('Nav pull abandoned — slot changed'); return; }
      sendHex(paramQuery(hi, los[i]));
      await sleep(NAV_QUERY_GAP);
    }
  }

  // PHASE 4 — rig level. Each has its own command, none needs the amp handle.
  if (stale()) { appLog('Nav pull abandoned — slot changed'); return; }
  sendHex(REQU_RIG_VOL);            await sleep(NAV_QUERY_GAP);
  if (stale()) return;
  sendHex(REQU_TOAMP1_READ);        await sleep(NAV_QUERY_GAP);
  if (stale()) return;
  sendHex(REQU_TOAMP2_READ);        await sleep(NAV_QUERY_GAP);
  if (stale()) return;
  sendHex(REQU_MASTER_VOL_READ);    await sleep(NAV_QUERY_GAP);
  if (stale()) return;
  sendHex(REQU_MONO_READ);          await sleep(NAV_QUERY_GAP);
  if (stale()) return;
  // Rig tempo is NOT per patch, so this is strictly a refresh — it costs one
  // query and keeps the clock honest if the tempo was changed from the front
  // panel while we were not listening.
  sendHex(REQU_TEMPO_READ);
  finish();

  // Knob-colour baseline (item A). Normal navigation uses this targeted pull,
  // not the CMD 0x01 bulk decode, so the main-panel knobs are populated by the
  // async CMD 0x11 replies above. Snapshot their loaded values as the "unchanged"
  // reference once those replies have settled; a later move (drag, front panel,
  // Avid) then reads as red. Effect-panel knobs baseline themselves separately.
  await sleep(NAV_BASELINE_SETTLE);
  if (!stale() && typeof captureKnobBaselines === 'function') captureKnobBaselines();

  if (PROBE_UNKNOWN_QUERIES) { await sleep(300); await probeUnknownQueries(); }
  if (PROBE_AMP_PARAM_SWEEP) { await sleep(300); await probeAmpParamSweep(); }
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
