/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
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

  // Load persisted tone-knob reorder prefs, if any — MUST happen before any
  // amp identifies and the tone row paints for the first time (initMIDI, a
  // few lines down), so a saved custom order is what's drawn on the very
  // first render rather than default-then-jump (Amp Controls reorder, 2026-08-03).
  try {
    const savedOrder = await window.electronAPI.getToneKnobOrder();
    if (savedOrder && typeof savedOrder === 'object') {
      toneKnobOrderPrefs = savedOrder;
      appLog('Tone knob order prefs loaded — ' + Object.keys(toneKnobOrderPrefs).length + ' amp(s) customized');
    }
  } catch(e) {}

  // Load persisted numeric-readout visibility (amp panel), global app
  // preference — not per-patch, so this restores before the first paint
  // the same way the tone-knob order does.
  try {
    const savedMode = await window.electronAPI.getNumberDisplayMode();
    if (typeof savedMode === 'number') {
      numberDisplayMode = savedMode;
      applyNumberDisplayMode();
    }
  } catch(e) {}

  // Kick off the Avid graphics folder auto-scan (chain row pedal thumbnails)
  // here, not from the inline <script> in index.html where it used to live —
  // that script runs at HTML PARSE TIME, before chain-graphics.js/ui.js even
  // load, so its scan could resolve before setAvidGraphicsManifest/
  // renderChainRow existed and silently do nothing (the likely real cause of
  // "chain row graphics sometimes blank on load", 2026-08-03). init() only
  // ever runs after every script has fully loaded, so every dependency this
  // needs is guaranteed to exist by now. Fire-and-forget — it repaints the
  // chain row itself once the scan lands; nothing here needs to await it.
  //
  // (2026-08-03: briefly delayed 3s chasing a reported white flash at the
  // splash->main reveal. CONFIRMED UNRELATED same day — reproduces only on
  // VMs (virtualized/software GPU rendering, a known-for-years Chromium
  // compositor bug, not this app). Reverted to firing immediately — the
  // delay was making the chain-row graphics noticeably slower to appear for
  // no actual benefit.)
  if (typeof startAvidGraphicsAutoScan === 'function') startAvidGraphicsAutoScan();

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
    // disabled + selected (2026-09-03 fix) — Cab/Mic's own static placeholder
    // options (index.html) already work this way: greyed out, not a real
    // pickable choice, just the pre-connect empty state. This one was built
    // in JS and missed both attributes — selectable (and shown in the
    // live/white font, not the dropdown's own dim/disabled option colour)
    // even though picking it does nothing, a real amp never reports back
    // as "no amp". Charlie's live report, caught by eye in the dropdown.
    placeholder.value = ''; placeholder.textContent = '— Amp —';
    placeholder.disabled = true;
    placeholder.selected = true;
    sel.appendChild(placeholder);
    AMP_SELECT_LIST.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.key; opt.textContent = a.label;
      sel.appendChild(opt);
    });
    // Debounced (2026-09-02, Charlie's live report) — a native <select>
    // fires a real 'change' event per arrow-key repeat while a key is held
    // down, and NOTHING used to throttle that: every single one triggered
    // a full hardware model-change write plus its whole settle-then-
    // requery chain (AMP_CHANGE_SETTLE + one query per paramLo,
    // transport.js). Holding the key fires far faster than the rack can
    // process, backing up a queue of confirmations that took a 19,000-
    // line log a very long time to drain, visibly stuck oscillating among
    // a handful of amps near wherever the backlog built up — which looked
    // like "the list wrapped around many times" but wasn't; the dropdown
    // itself never wrapped, the hardware was just still catching up on
    // writes from seconds-old keystrokes. Same debounce shape
    // queueKnobSend (ui.js) already uses for knob-drag writes — only the
    // LAST value after ampSelectSendInterval ms of no further change wins;
    // every intermediate amp passed through in under that window was never
    // actually seen/used, so skipping its write changes nothing real.
    var ampSelectSendTimer = null, ampSelectSendPending = null;
    var AMP_SELECT_SEND_INTERVAL = 150;  // longer than KNOB_SEND_INTERVAL (60)
                                          // on purpose — a model change is a
                                          // much heavier operation than a
                                          // knob write (relabels/blanks the
                                          // tone stack, then a multi-query
                                          // settle chain), so it needs more
                                          // headroom above typical OS key-
                                          // repeat rate (~30-50ms) to
                                          // actually coalesce a held key
                                          // down to one real write.
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
      ampSelectSendPending = chosen;
      if (ampSelectSendTimer) return;  // a send is already scheduled
      ampSelectSendTimer = setTimeout(function() {
        ampSelectSendTimer = null;
        const c = ampSelectSendPending;
        ampSelectSendPending = null;
        if (!c || currentParamHi < 0) return;
        // Tone-stack cache (2026-09-02, experiment branch) — snapshot the
        // OUTGOING amp's current tone-knob values before switching away, so
        // returning to it later THIS patch-load (via another dropdown pick)
        // restores them instead of showing whatever the hardware's shared-
        // paramLo storage happens to display under the new amp's labels.
        // Same generic engine DIST/REVERB/WAH/FX1 use (blockCacheSave,
        // fx-panels.js), SLOT_AMP as a new caller, amp KEY as the cache
        // key. Moved inside the debounced callback (merged with the
        // debounce fix) — currentAmpKey only ever changes once a real
        // hardware confirmation lands, which can't happen until THIS
        // callback actually sends something, so reading it here instead
        // of at every raw keystroke is exactly as correct and far cheaper.
        if (currentAmpKey && typeof blockCacheSave === 'function' && typeof ampCacheCells === 'function') {
          var outgoingKey = currentAmpKey;
          // ampCacheCells (2026-09-02, ui.js) — the whole amp block: tone
          // knobs, Bright/MOD, Sync, Tremolo On/Off, Amp Out, Gate Thresh/
          // Release, Cab Type, Mic Type, Mic Axis, Speaker Breakup
          // (Charlie's own final scoping — "all of it is one entity").
          // Rig Vol/To Amp Volume/To Amp Source stay out (see ui.js).
          var outgoingCells = ampCacheCells(outgoingKey);
          blockCacheSave(SLOT_AMP, outgoingKey, outgoingCells,
            function(cell) { return ampCacheCellReadValue(outgoingKey, cell); });
          // AUDIT LOG (2026-09-02, Charlie's ask — can't eyeball-verify 33
          // amps' worth of knob values from memory) — one line, every value
          // just captured, so a later "AMPCACHE APPLY key=<this same key>"
          // line can be compared against it directly instead of trusting
          // the screen. Left in permanently, not a TEMP DIAGNOSTIC — this
          // is the verification tool itself, not a bug hunt aid to remove
          // after.
          appLog('AMPCACHE SAVE key=' + outgoingKey + ' ' + outgoingCells.map(function(c2) {
            return c2.label + '(lo=0x' + c2.lo.toString(16).padStart(2,'0') + ')=' + ampCacheCellReadValue(outgoingKey, c2);
          }).join(', '));
        }
        // Amp Select: instId=currentParamHi, paramLo=0x0F, raw v0 (not scaled)
        const hex = 'F0 13 0B 0F 00 11 '
          + currentParamHi.toString(16).padStart(2,'0').toUpperCase() + ' 0F '
          + c.v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00 F7';
        sendHex(hex);
        appLog('Amp Select: sent ' + c.label + ' (v0=0x' + c.v0.toString(16).padStart(2,'0').toUpperCase() + ')');
      }, AMP_SELECT_SEND_INTERVAL);
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

  // Input is GLOBAL and the rack answers a 01 3D query on connect (confirmed
  // 2026-08-30 against Avid's own startup captures), so we no longer force
  // Guitar — requestFullState()'s sendInputSelectorQuery() reads the real input
  // and the CMD 0x3D reply lights the matching button. Show a neutral state
  // until that reply lands so a stale forced value is never briefly displayed.
  setInputButtons(-1);

  // ── Bright toggle button ──
  document.getElementById('btn-bright').addEventListener('click', function() {
    if (currentParamHi < 0) return;
    brightOn = !brightOn;
    updateBrightButton();
    // val=127=ON, val=0=OFF — encode for CMD 0x11
    sendParamWrite(0x0E, brightOn ? 127 : 0);
    appLog('Bright toggled -> ' + (brightOn ? 'ON' : 'OFF'));
  });

  // ── Tremolo on/off button — paramLo 0x13, same two-state encoding as
  // Bright. Refuses to act until the hardware has told us the current state,
  // so a first click can never invert a value we are only guessing at. ──
  document.getElementById('btn-trem').addEventListener('click', function() {
    if (currentParamHi < 0) return;
    if (tremOn === undefined) {
      appLog('Tremolo: state unknown yet, ignoring click');
      setStatus('Tremolo: waiting for a readback from the hardware first');
      return;
    }
    tremOn = !tremOn;
    updateTremButton();
    sendParamWrite(0x13, tremOn ? 127 : 0);
    appLog('Tremolo toggled -> ' + (tremOn ? 'ON' : 'OFF'));
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
