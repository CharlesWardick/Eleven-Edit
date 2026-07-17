// ════════════════════════════════════════════════════════════════════
// APP-INIT.JS — page bootstrap: init() wires up every button/knob event
// listener and kicks off the bridge connection. Loads LAST, since it
// calls into everything defined in the other files. This is the one
// file that's genuinely specific to this exact page's DOM, rather than
// generic/reusable logic.
// ════════════════════════════════════════════════════════════════════

async function init() {
  // Load zoom
  try {
    const zoom = await window.electronAPI.getZoom();
    zoomFactor = zoom;
    window.electronAPI.setZoom(zoom);
  } catch(e) {}

  // Load persisted bank scan cache, if any — signature-based change
  // detection means a rescan skips re-decoding anything unchanged
  try {
    const cached = await window.electronAPI.getBankCache();
    if (cached && typeof cached === 'object') {
      bankCache = cached;
      appLog('Bank cache loaded — ' + Object.keys(bankCache).length + ' slot(s) known from a previous scan');
    }
  } catch(e) {}

  // Check /LOGS flag — show/hide log UI elements accordingly
  try {
    logsEnabled = await window.electronAPI.getLogsEnabled();
    if (!logsEnabled) {
      document.getElementById('log-path-label').style.display = 'none';
      document.getElementById('btn-open-log').style.display = 'none';
    } else {
      const lp = await window.electronAPI.getLogPath();
      if (lp) document.getElementById('log-path-label').textContent = lp;
    }
  } catch(e) {}

  setStatus('Ready — select MIDI ports');

  // Check Avid editor state
  try {
    const running = await window.electronAPI.checkAvidEditor();
    updateAvidStatus(running);
  } catch(e) {}

  // Poll editor state every 3 seconds
  setInterval(async () => {
    try {
      const running = await window.electronAPI.checkAvidEditor();
      updateAvidStatus(running);
    } catch(e) {}
  }, 3000);

  // Watchdog
  try { await window.electronAPI.startWatchdog(3); } catch(e) {}

  // Init MIDI
  await new Promise(r => setTimeout(r, 400));
  await initMIDI();

  // Show captures dir
  try {
    const dir = await window.electronAPI.getCapturesDir();
    document.getElementById('capture-path').textContent = 'Folder: ' + dir;
  } catch(e) {}

  appLog('Eleven Edit initialized');

  // ── Volume knobs — start disabled, enabled when Avid editor detected ──
  // initKnob sets up interaction but knob-disabled class blocks mouse events
  initKnob('rig-vol-wrap', 'rig-vol-val', valRigVol, val => sendCC(17, val));
  // Amp Out: write mechanism confirmed 7/9/2026 (CMD 0x11 SysEx write,
  // paramId 0x03, not the CC 92 guess that used to cause an unintended
  // amp model change). Startup readback confirmed 7/10/2026 via three
  // controlled TFX captures at -60dB/0dB/+18dB — decoded values matched
  // the target dB exactly. The guard below should rarely if ever trigger
  // now that a real value gets read back on connect/nav, but it stays in
  // as a safety net — this knob previously WAS able to silently transmit
  // an arbitrary default position the instant it was touched, confirmed
  // to move the real hardware output level with no value ever read back.
  initKnob('amp-out-wrap', 'amp-out-val', valAmpOut, val => {
    if (!hasReceivedAmpOutValue) {
      appLog('Amp Out: refusing to send — no real value received yet this session');
      setStatus('Amp Out: waiting for a real readback before this can be adjusted');
      return;
    }
    sendParamWrite(0x03, val);
  });

  // ── Amp Select — confirmed 7/10/2026, CMD 0x11 paramId 0x0F. Disabled
  // until an amp has actually been identified (needs currentParamHi, same
  // gating as Gate). Sends the raw confirmed byte for the chosen amp —
  // no scaling, this isn't a continuous knob. ──
  (function() {
    const sel = document.getElementById('amp-select');
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = '— Amp —';
    sel.appendChild(placeholder);
    AMP_SELECT_LIST.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.key; opt.textContent = a.label;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function() {
      if (ampSelectSyncing) return; // programmatic sync, not a real user pick
      const chosen = AMP_SELECT_BY_KEY[sel.value];
      if (!chosen) return;
      if (currentParamHi < 0) {
        appLog('Amp Select: no instance id yet, not sending');
        setStatus('Amp Select: waiting for amp to be identified first');
        syncAmpSelectDropdown(currentAmpKey);
        return;
      }
      // Amp Select: instId=currentParamHi, paramLo=0x0F, raw v0 (not scaled)
      const hex = 'F0 13 0B 0F 00 11 '
        + currentParamHi.toString(16).padStart(2,'0').toUpperCase() + ' 0F '
        + chosen.v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00 F7';
      sendHex(hex);
      appLog('Amp Select: sent ' + chosen.label + ' (v0=0x' + chosen.v0.toString(16).padStart(2,'0').toUpperCase() + ')');
    });
  })();

  // ── Gate knobs — two-byte paramId, paramLo consistent across all amps ──
  initKnob('gate-thresh-wrap', 'gate-thresh-val', valGateThresh, val => {
    sendParamWrite(0x04, val);
  });
  initKnob('gate-release-wrap', 'gate-release-val', valGateRelease, val => {
    sendParamWrite(0x05, val);
  });

  // ── Input selector ──
  const INPUT_BTNS = ['btn-input-guitar','btn-input-mic','btn-input-line','btn-input-dig'];
  INPUT_BTNS.forEach(id => {
    document.getElementById(id).addEventListener('click', function() {
      INPUT_BTNS.forEach(bid => document.getElementById(bid).classList.remove('active'));
      this.classList.add('active');
      sendCC(parseInt(this.dataset.cc), parseInt(this.dataset.ccval));
    });
  });

  // Force Guitar on startup — button and hardware always match
  setInputButtons(0x00);
  setTimeout(() => { try { sendCC(65, 0); appLog('Startup: forced Guitar input'); } catch(e) {} }, 1200);

  // ── Bright toggle button ──
  document.getElementById('btn-bright').addEventListener('click', function() {
    if (currentParamHi < 0) return;
    brightOn = !brightOn;
    updateBrightButton();
    // val=127=ON, val=0=OFF — encode for CMD 0x11
    sendParamWrite(0x0E, brightOn ? 127 : 0);
    appLog('Bright toggled -> ' + (brightOn ? 'ON' : 'OFF'));
  });
}

// ── Input selector button state helper ──
async function applyZoom(delta) {
  zoomFactor = Math.max(0.6, Math.min(2.0, zoomFactor + delta));
  try { await window.electronAPI.setZoom(zoomFactor); } catch(e) {}
}
document.getElementById('btn-zoom-in').addEventListener('click',  () => applyZoom(0.1));
document.getElementById('btn-zoom-out').addEventListener('click', () => applyZoom(-0.1));

// ════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════
populateRangeSelects();
updateDisplay(0);
setTimeout(init, 150);
