/*
 * Eleven Edit — Audio Engine UI wiring (v2.0.0)
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 *
 * Drives the topbar AUDIO toggle, the audio strip (IN/OUT sliders + meter),
 * and the Audio Setup panel (device / mono|stereo input / output / rate /
 * buffer). Talks to main.js over electronAPI; main.js owns the audio-helper.js
 * child process that does the ASIO passthrough.
 *
 * Channel model: ASIO holds the whole device exclusively while ON. We select
 * which channels to MONITOR:
 *   - Mono   → one input channel, duplicated to both monitors.
 *   - Stereo → left + right input channels, mapped L/R.
 *   - Output → a stereo monitor pair.
 */

(function () {
  'use strict';

  var api = window.electronAPI;
  if (!api || !api.audioStart) return;

  var settings = {
    deviceType:  'none',   // 'none' | 'asio' | 'wasapi' | 'ds'
    asioDevName: null,     // ASIO device NAME (indices reshuffle; names are stable)
    inDevName:   null,     // non-ASIO input device NAME
    outDevName:  null,     // non-ASIO output device NAME
    inputMode: 'mono',     // 'mono' | 'stereo'
    inMono:    0,          // 0-based input channel for mono
    inL:       0,
    inR:       1,          // 0-based input channels for stereo
    outPair:   0,          // left channel index of output pair (0 => outputs 1+2)
    rate:      48000,
    frames:    128,
    outGain:   100,        // monitor level 0..100 (no input gain — see helper)
    barPosition: 'bottom', // 'bottom' (above status bar, default) | 'top' (under toolbar)
    barVisible:  true,     // false = hide the bar entirely (for non-audio users)
    configured: false      // false until first successful setup → first start is muted
  };

  var running = false;
  var muted   = false;     // runtime only (not persisted)
  var busy    = false;     // guards against machine-gunning the engine toggle
  var busyTimer = null;
  // Per-API device caches (ASIO can't be enumerated while a device is open, so
  // we keep the last good scan for each API). Keyed by both id and NAME so we
  // can resolve a saved name to whatever index it currently occupies.
  var devCache  = { asio: null, wasapi: null, ds: null };  // arrays
  var devById   = { asio: {}, wasapi: {}, ds: {} };        // id -> device
  var devByName = { asio: {}, wasapi: {}, ds: {} };        // name -> device
  var legacyIdx = { asio: null };  // one-time migration from index-based saves
  var actualFrames = null; // buffer the driver actually granted (from 'started')
  var actualRate   = null;

  // --- elements ---
  function $(id) { return document.getElementById(id); }
  var elToggle = $('audio-engine-toggle');
  var elStrip  = $('audiostrip');
  var elOut    = $('audio-out');
  var elOutVal = $('audio-out-val');
  var elMeterL = $('audio-meter-l');
  var elMeterR = $('audio-meter-r');
  var elDevLbl = $('audio-dev-label');
  var elMute   = $('audio-mute-btn');
  var elMuteP  = $('audio-mute-panel');   // mirror copy in the Setup panel
  var elClip   = $('audio-clip');

  var panelAmp   = $('panel-ampcab');
  var panelSet   = $('panel-settings');
  var panelAudio = $('panel-audio-settings');
  var btnGear    = $('btn-settings');

  function log(m)    { if (typeof appLog === 'function') appLog(m); }
  function status(m) { if (typeof setStatus === 'function') setStatus(m); }
  function setupStatus(m) { var e = $('audio-setup-status'); if (e) e.textContent = m; }

  function deriveChannels() {
    var inChannels = settings.inputMode === 'stereo' ? [settings.inL, settings.inR] : [settings.inMono];
    var outChannels = [settings.outPair, settings.outPair + 1];
    return { inChannels: inChannels, outChannels: outChannels };
  }

  // Resolve a saved device NAME to its current id (index) via the latest scan.
  function resolveId(apiName, name) {
    if (name == null) return null;
    var d = devByName[apiName] && devByName[apiName][name];
    return d ? d.id : null;
  }
  function inputDevice() {
    var t = settings.deviceType, name = (t === 'asio') ? settings.asioDevName : settings.inDevName;
    return (devByName[t] || {})[name];
  }
  function outputDevice() {
    var t = settings.deviceType, name = (t === 'asio') ? settings.asioDevName : settings.outDevName;
    return (devByName[t] || {})[name];
  }
  // The two device ids for the current type (ASIO = same device for both).
  function deriveDevices() {
    var t = settings.deviceType;
    if (t === 'asio') { var id = resolveId('asio', settings.asioDevName); return { inDeviceId: id, outDeviceId: id }; }
    return { inDeviceId: resolveId(t, settings.inDevName), outDeviceId: resolveId(t, settings.outDevName) };
  }
  // A device name has been chosen (may or may not be currently present).
  function namesChosen() {
    var t = settings.deviceType;
    if (t === 'asio') return settings.asioDevName != null;
    if (t === 'wasapi' || t === 'ds') return settings.inDevName != null && settings.outDevName != null;
    return false;
  }
  // Chosen AND currently present (resolvable to a live device).
  function devicesReady() {
    var dv = deriveDevices();
    if (settings.deviceType === 'asio') return dv.inDeviceId != null;
    if (settings.deviceType === 'wasapi' || settings.deviceType === 'ds') return dv.inDeviceId != null && dv.outDeviceId != null;
    return false;
  }
  // Chosen but NOT currently present (interface off / unplugged / reshuffled away).
  function deviceMissing() { return namesChosen() && !devicesReady(); }

  function closeDeviceModal() { var m = $('audio-device-modal'); if (m) m.classList.remove('open'); }
  function showInterfaceModal() {
    var m = $('audio-device-modal'), body = $('audio-device-modal-body');
    if (!m || !body) { status('Audio device not available — turn on your interface, then toggle the engine.'); return; }
    var t = settings.deviceType;
    var who = (t === 'asio') ? ('“' + (settings.asioDevName || '') + '”')
      : ('input “' + (settings.inDevName || '?') + '” / output “' + (settings.outDevName || '?') + '”');
    body.innerHTML = '<div style="color:var(--red);margin-bottom:8px;">The audio device ' + who + ' isn’t available right now.</div>'
      + '<div style="color:#b3b3b3;">Turn your interface on, then <b>Try Again</b>. '
      + 'Or <b>Open Audio Setup</b> to choose a different device.</div>';
    m.classList.add('open');
  }
  var bb;
  if ((bb = $('audio-device-modal-retry'))) bb.addEventListener('click', function () {
    closeDeviceModal();
    if (!running && !busy) { setBusy(true); startEngine(); }   // re-scans + starts, or re-shows modal
  });
  if ((bb = $('audio-device-modal-setup'))) bb.addEventListener('click', function () {
    closeDeviceModal();
    openAudioPanel();
  });

  function startOpts() {
    var ch = deriveChannels();
    var dv = deriveDevices();
    return {
      api:         settings.deviceType,
      inDeviceId:  dv.inDeviceId,
      outDeviceId: dv.outDeviceId,
      rate:        settings.rate,
      frames:      settings.frames,
      outGain:     settings.outGain,
      muted:       muted,
      inChannels:  ch.inChannels,
      outChannels: ch.outChannels
    };
  }

  function updateMuteBtn() {
    if (elMute)  { elMute.textContent  = muted ? 'MUTED' : 'MUTE'; elMute.classList.toggle('muted', muted); }
    if (elMuteP) { elMuteP.textContent = muted ? 'MUTED' : 'MUTE'; elMuteP.classList.toggle('muted', muted); }
  }

  function doMuteToggle() {
    muted = !muted;
    updateMuteBtn();
    if (api.audioSetMute) api.audioSetMute({ muted: muted });
  }

  function setClip(on) { if (elClip) elClip.classList.toggle('on', on); }

  var errTimer = null;
  function flashToggleErr() {
    if (!elToggle) return;
    elToggle.classList.add('err');
    if (errTimer) clearTimeout(errTimer);
    errTimer = setTimeout(function () { if (elToggle) elToggle.classList.remove('err'); }, 4000);
  }

  // Lock the engine toggle between a click and the confirmed state change, so a
  // fast OFF→ON can't spawn a new helper while the old one still holds the
  // device. Safety timeout clears it if no status ever comes back.
  function setBusy(b) {
    busy = b;
    if (elToggle) { elToggle.style.opacity = b ? '0.6' : ''; elToggle.style.pointerEvents = b ? 'none' : ''; }
    if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
    if (b) busyTimer = setTimeout(function () { setBusy(false); }, 4000);
  }

  function saveSettings() { if (api.saveAudioSettings) api.saveAudioSettings(settings); }

  function applyIfRunning() {
    if (running) api.audioStart(startOpts());   // helper restarts on new geometry
  }

  function applyBarVisibility() {
    if (!elStrip) return;
    if (settings.barVisible) {
      elStrip.style.display = '';       // back to CSS flex
      placeBar();
    } else {
      if (running) stopEngine();        // hiding removes the only engine control → stop it
      elStrip.style.display = 'none';
    }
  }

  function placeBar() {
    if (!elStrip) return;
    var sb = document.getElementById('statusbar');
    var tb = document.getElementById('topbar');
    if (settings.barPosition === 'bottom') {
      elStrip.classList.add('bottom');
      if (sb && sb.parentNode) sb.parentNode.insertBefore(elStrip, sb);
    } else {
      elStrip.classList.remove('bottom');
      if (tb && tb.parentNode) tb.parentNode.insertBefore(elStrip, tb.nextSibling);
    }
  }

  function setToggleState(on) {
    running = on;
    if (elToggle) {
      elToggle.textContent = on ? '● AUDIO ENGINE ON' : '● AUDIO ENGINE OFF';
      elToggle.classList.toggle('on', on);
      if (on) elToggle.classList.remove('err');
    }
    if (elStrip) elStrip.classList.toggle('engine-off', !on);
    if (!on) {
      if (elMeterL) elMeterL.style.width = '0%';
      if (elMeterR) elMeterR.style.width = '0%';
      setClip(false);
    }
  }

  // Explicit auto-start (/AUDIOON). Overrides a hidden bar for THIS session
  // (so there's a control to stop it) without changing the saved preference.
  function autoStartEngine() {
    if (!settings.configured || !namesChosen()) {
      log('Audio: auto-start skipped — not configured yet.');
      return;
    }
    if (!settings.barVisible) {
      settings.barVisible = true;   // session-only override; NOT saved
      applyBarVisibility();
      var vsel = $('audio-barvisible-select'); if (vsel) vsel.value = 'shown';
    }
    // startEngine() re-scans and pops the modal itself if the device is absent.
    if (!running && !busy) { setBusy(true); startEngine(); }
  }

  var pendingStart = false;

  function startEngine() {
    if (settings.deviceType === 'none' || !namesChosen()) {
      setBusy(false);           // nothing chosen yet — send them to setup
      status('Audio: choose a device type and device(s) first.');
      openAudioPanel();
      setupStatus('Pick a Device Type and device(s), then turn the engine on.');
      return;
    }
    // Re-scan right before starting: an interface's ASIO driver only appears in
    // the list while it's powered, so the cache goes stale the moment it's
    // switched on/off. finishStart() runs when the fresh scan lands.
    if (!running && api.audioListDevices) { pendingStart = true; api.audioListDevices(settings.deviceType); }
    else finishStart();
  }

  function finishStart() {
    if (deviceMissing()) {      // chosen, but still not connected after a fresh scan
      setBusy(false);
      flashToggleErr();
      showInterfaceModal();
      setupStatus('Selected device isn’t connected — reconnect it or pick another.');
      return;
    }
    // First-ever bring-up starts MUTED (from the first sample) so nothing blasts.
    if (!settings.configured) muted = true;
    updateMuteBtn();
    setClip(false);
    log('Audio: requesting engine ON' + (muted ? ' (muted)' : ''));
    status('Audio engine starting…' + (muted ? ' (muted — raise/unmute when ready)' : ''));
    api.audioStart(startOpts());
  }

  function stopEngine() {
    log('Audio: requesting engine OFF (releasing device)');
    api.audioStop();
    setToggleState(false);
    status('Audio engine stopped — device released.');
  }

  if (elToggle) {
    elToggle.addEventListener('click', function () {
      if (busy) return;                 // ignore machine-gun clicks mid-transition
      setBusy(true);
      if (running) stopEngine(); else startEngine();
    });
  }

  // MUTE toggles (bar + panel mirror; runtime only, not persisted)
  if (elMute)  elMute.addEventListener('click', doMuteToggle);
  if (elMuteP) elMuteP.addEventListener('click', doMuteToggle);
  // Clip latch — click to clear
  if (elClip) elClip.addEventListener('click', function () { setClip(false); });

  // Restart Engine — close & reopen the stream (recover a silent driver drop)
  if ((b = $('audio-restart-btn'))) b.addEventListener('click', function () {
    if (running) { setClip(false); status('Restarting audio engine…'); api.audioStart(startOpts()); }
    else startEngine();
  });
  // Reset First-Run (dev) — re-arm the muted first-time setup
  if ((b = $('audio-reset-firstrun-btn'))) b.addEventListener('click', function () {
    settings.configured = false; saveSettings();
    setupStatus('First-run re-armed — the next engine start will be muted.');
  });

  // --- monitor level slider (audio bar) ---
  if (elOut) {
    elOut.addEventListener('input', function () {
      settings.outGain = parseInt(elOut.value, 10);
      if (elOutVal) elOutVal.textContent = settings.outGain;
      if (running && api.audioSetGain) api.audioSetGain({ outGain: settings.outGain });
      saveSettings();
    });
  }

  // ── Audio Setup panel ─────────────────────────────────────────────────
  function openAudioPanel() {
    if (!panelAudio) return;
    if (panelSet)  panelSet.style.display = 'none';
    if (panelAmp)  { var h = panelAmp.offsetHeight; if (h) panelAudio.style.minHeight = h + 'px'; panelAmp.style.display = 'none'; }
    panelAudio.style.display = 'flex';
    if (btnGear) btnGear.classList.add('active');
    requestDevices();
  }
  function backToSettings() {
    if (panelAudio) panelAudio.style.display = 'none';
    if (panelSet)   panelSet.style.display = 'flex';
  }
  function closeAudioPanel() {
    if (panelAudio) panelAudio.style.display = 'none';
    if (panelAmp)   panelAmp.style.display = '';
    if (btnGear)    btnGear.classList.remove('active');
  }

  var b;
  if ((b = $('settings-btn-audio-setup'))) b.addEventListener('click', openAudioPanel);
  if ((b = $('btn-audio-back')))  b.addEventListener('click', backToSettings);
  if ((b = $('btn-audio-close'))) b.addEventListener('click', closeAudioPanel);
  if ((b = $('audio-rescan-btn'))) b.addEventListener('click', function () {
    // A device can't be enumerated while it's open, so stop the engine first,
    // then rescan once it has released (helper kill ~200ms).
    if (running) { stopEngine(); setupStatus('Engine stopped for rescan…'); setTimeout(requestDevices, 500); }
    else requestDevices();
  });

  function opt(value, label, selected) {
    var o = document.createElement('option');
    o.value = value; o.textContent = label; if (selected) o.selected = true;
    return o;
  }

  function updateDeviceRows() {
    var t = settings.deviceType, nonAsio = (t === 'wasapi' || t === 'ds'), cfg = (t !== 'none');
    function show(id, on) { var e = $(id); if (e) e.style.display = on ? 'flex' : 'none'; }
    show('audio-none-row',   t === 'none');
    show('audio-asio-row',   t === 'asio');
    show('audio-indev-row',  nonAsio);
    show('audio-outdev-row',  nonAsio);
    show('audio-mode-row',   cfg);
    show('audio-out-row',    cfg);
    show('audio-rate-row',   cfg);
    show('audio-buffer-row', cfg);
    if (cfg) refreshModeRows();
    else { var m = $('audio-row-mono'), s = $('audio-row-stereo'); if (m) m.style.display = 'none'; if (s) s.style.display = 'none'; }
  }

  function requestDevices(apiArg) {
    var apiName = apiArg || settings.deviceType;
    updateDeviceRows();
    if (apiName === 'none') { setupStatus('No audio device selected.'); return; }
    // A device can't be enumerated while it's open, so reuse the cache while running.
    if (running) {
      if (devCache[apiName] && devCache[apiName].length) { populateDevices(apiName); setupStatus('Engine running — showing last scan. Stop the engine to rescan.'); }
      else setupStatus('Turn the engine OFF to scan for audio devices.');
      return;
    }
    setupStatus('Scanning ' + apiName.toUpperCase() + ' devices…');
    if (api.audioListDevices) api.audioListDevices(apiName);
  }

  function handleDevices(payload) {
    var apiName = (payload && payload.api) ? payload.api : 'asio';
    var devices = (payload && payload.devices) ? payload.devices : [];
    if (devices.length) {
      devCache[apiName] = devices;
      devById[apiName] = {};
      devByName[apiName] = {};
      devices.forEach(function (d) { devById[apiName][d.id] = d; devByName[apiName][d.name] = d; });
      // One-time migration: an old index-based ASIO save → resolve to a name now.
      if (apiName === 'asio' && settings.asioDevName == null && legacyIdx.asio != null && devById.asio[legacyIdx.asio]) {
        settings.asioDevName = devById.asio[legacyIdx.asio].name;
        legacyIdx.asio = null; saveSettings();
      }
    }
    if (apiName === settings.deviceType) {
      populateDevices(apiName);
      // A start was waiting on this fresh scan (interface may have just powered on).
      if (pendingStart) { pendingStart = false; finishStart(); }
    }
  }

  // Keep channel picks within the current device's real channel counts — a
  // device with fewer channels (e.g. switching an 18-in ASIO rig to a 2-in
  // WASAPI/DS device) would otherwise ask for channels that don't exist and
  // the driver refuses to open ("can't have more than two inputs").
  function clampChannels(inN, outN) {
    var before = [settings.inMono, settings.inL, settings.inR, settings.outPair].join('/');
    if (settings.inMono >= inN) settings.inMono = 0;
    if (settings.inL    >= inN) settings.inL = 0;
    if (settings.inR    >= inN) settings.inR = (inN > 1 ? 1 : 0);
    if (settings.outPair + 1 >= outN) settings.outPair = 0;
    return before !== [settings.inMono, settings.inL, settings.inR, settings.outPair].join('/');
  }

  function fillChannelSelects(inN, outN) {
    var i;
    var mono = $('audio-in-mono'), l = $('audio-in-l'), r = $('audio-in-r'), out = $('audio-out-select');
    if (mono) { mono.innerHTML = ''; for (i = 0; i < inN; i++) mono.appendChild(opt(i, 'Input ' + (i + 1), i === settings.inMono)); }
    if (l)    { l.innerHTML = '';    for (i = 0; i < inN; i++) l.appendChild(opt(i, 'Input ' + (i + 1), i === settings.inL)); }
    if (r)    { r.innerHTML = '';    for (i = 0; i < inN; i++) r.appendChild(opt(i, 'Input ' + (i + 1), i === settings.inR)); }
    if (out)  { out.innerHTML = '';  for (i = 0; i + 1 < outN; i += 2) out.appendChild(opt(i, 'Output ' + (i + 1) + ' + ' + (i + 2), i === settings.outPair)); }
  }

  var FALLBACK_RATES = [44100, 48000, 88200, 96000];
  function fillRateSelect(dev) {
    var sel = $('audio-rate-select');
    if (!sel) return;
    var rates = (dev && dev.sampleRates && dev.sampleRates.length) ? dev.sampleRates.slice() : FALLBACK_RATES;
    if (rates.indexOf(settings.rate) === -1) settings.rate = (dev && dev.rate) || rates[0];
    sel.innerHTML = '';
    rates.forEach(function (r) { sel.appendChild(opt(r, r + ' Hz', r === settings.rate)); });
  }

  var BUFFERS = [16, 32, 48, 64, 96, 128, 160, 192, 256];
  function fillBufferSelect() {
    var sel = $('audio-buffer-select');
    if (!sel) return;
    sel.innerHTML = '';
    // No ms here: samples/rate is only one buffer period, not round-trip — the
    // interface's own panel reports true round-trip latency; showing a partial
    // number next to it just misleads.
    BUFFERS.forEach(function (n) {
      sel.appendChild(opt(n, n + ' samples', n === settings.frames));
    });
  }

  function refreshModeRows() {
    var mono = $('audio-row-mono'), stereo = $('audio-row-stereo');
    if (mono)   mono.style.display   = settings.inputMode === 'mono'   ? 'flex' : 'none';
    if (stereo) stereo.style.display = settings.inputMode === 'stereo' ? 'flex' : 'none';
    updateMeterMode();
  }

  function updateMeterMode() {
    var m = $('audio-meters');
    if (m) m.classList.toggle('mono', settings.inputMode === 'mono');
  }

  function populateDevices(apiName) {
    apiName = apiName || settings.deviceType;
    updateDeviceRows();
    if (apiName === 'none') { updateBarLabel(); return; }
    var devices = devCache[apiName] || [];

    // Fill a device <select> by NAME. If the saved name isn't present, DON'T
    // silently switch to another device (that's the Windows-reshuffle bug) —
    // show it as "(not connected)" and keep the saved name so it resolves when
    // the device returns.
    function fillDevSelect(sel, list, savedName, setName) {
      if (!sel) return;
      sel.innerHTML = '';
      if (!list.length) { sel.appendChild(opt('', 'No devices found', true)); return; }
      var present = savedName != null && devByName[apiName][savedName];
      if (savedName == null) { setName(list[0].name); savedName = list[0].name; }  // first-time default
      else if (!present) sel.appendChild(opt(savedName, '(not connected) ' + savedName, true));
      list.forEach(function (d) { sel.appendChild(opt(d.name, d.name, d.name === savedName)); });
      sel.value = savedName;
    }

    if (apiName === 'asio') {
      fillDevSelect($('audio-device-select'), devices, settings.asioDevName, function (n) { settings.asioDevName = n; });
      var dev = devByName.asio[settings.asioDevName];
      var ain = (dev && dev.in) || 0, aout = (dev && dev.out) || 0;
      if (clampChannels(ain, aout)) saveSettings();
      fillChannelSelects(ain, aout);
      fillRateSelect(dev);
    } else {
      var ins  = devices.filter(function (d) { return d.in > 0; });
      var outs = devices.filter(function (d) { return d.out > 0; });
      fillDevSelect($('audio-indev-select'),  ins,  settings.inDevName,  function (n) { settings.inDevName = n; });
      fillDevSelect($('audio-outdev-select'), outs, settings.outDevName, function (n) { settings.outDevName = n; });
      var idev = devByName[apiName][settings.inDevName], odev = devByName[apiName][settings.outDevName];
      var nin = (idev && idev.in) || 0, nout = (odev && odev.out) || 0;
      if (clampChannels(nin, nout)) saveSettings();
      fillChannelSelects(nin, nout);
      fillRateSelect(odev || idev);
    }
    if (deviceMissing()) setupStatus('Selected device isn’t connected — reconnect it or pick another.');
    fillBufferSelect();
    setupStatus(running ? 'Engine running.' : 'Ready — turn the engine on from the bar.');
    updateBarLabel();
  }

  // --- setup control changes ---
  function onCtl(id, handler) { var e = $(id); if (e) e.addEventListener('change', handler); }

  onCtl('audio-type-select', function () {
    // Changing device type always stops the engine first (it releases the old
    // device so the new API can be enumerated cleanly).
    var wasRunning = running;
    if (wasRunning) { stopEngine(); setupStatus('Engine stopped — switching device type…'); }
    settings.deviceType = this.value;
    saveSettings();
    setTimeout(requestDevices, wasRunning ? 500 : 0);   // scan the new API (or show 'none')
    updateBarLabel();
  });
  onCtl('audio-device-select', function () {   // ASIO device (by name)
    settings.asioDevName = this.value;
    var d = devByName.asio[settings.asioDevName];
    fillChannelSelects((d && d.in) || 0, (d && d.out) || 0); fillRateSelect(d);
    saveSettings(); applyIfRunning(); updateBarLabel();
  });
  onCtl('audio-indev-select', function () {    // non-ASIO input device (by name)
    settings.inDevName = this.value;
    var idev = devByName[settings.deviceType][settings.inDevName], odev = outputDevice();
    fillChannelSelects((idev && idev.in) || 0, (odev && odev.out) || 0);
    saveSettings(); applyIfRunning(); updateBarLabel();
  });
  onCtl('audio-outdev-select', function () {   // non-ASIO output device (by name)
    settings.outDevName = this.value;
    var odev = devByName[settings.deviceType][settings.outDevName], idev = inputDevice();
    fillChannelSelects((idev && idev.in) || 0, (odev && odev.out) || 0); fillRateSelect(odev);
    saveSettings(); applyIfRunning(); updateBarLabel();
  });
  onCtl('audio-mode-select', function () {
    settings.inputMode = this.value;
    refreshModeRows(); saveSettings(); applyIfRunning(); updateBarLabel();
  });
  onCtl('audio-in-mono', function () { settings.inMono = parseInt(this.value, 10); saveSettings(); applyIfRunning(); });
  onCtl('audio-in-l',    function () { settings.inL    = parseInt(this.value, 10); saveSettings(); applyIfRunning(); });
  onCtl('audio-in-r',    function () { settings.inR    = parseInt(this.value, 10); saveSettings(); applyIfRunning(); });
  onCtl('audio-out-select', function () { settings.outPair = parseInt(this.value, 10); saveSettings(); applyIfRunning(); });
  onCtl('audio-rate-select',   function () { settings.rate = parseInt(this.value, 10); fillBufferSelect(); saveSettings(); applyIfRunning(); updateBarLabel(); });
  onCtl('audio-barpos-select', function () { settings.barPosition = this.value; placeBar(); saveSettings(); });
  onCtl('audio-barvisible-select', function () { settings.barVisible = (this.value === 'shown'); applyBarVisibility(); saveSettings(); });
  onCtl('audio-buffer-select', function () { settings.frames = parseInt(this.value, 10); saveSettings(); applyIfRunning(); updateBarLabel(); });

  function applySettingsToControls() {
    var e;
    if ((e = $('audio-type-select')))   e.value = settings.deviceType;
    if ((e = $('audio-mode-select')))   e.value = settings.inputMode;
    if ((e = $('audio-rate-select')))   e.value = String(settings.rate);
    if ((e = $('audio-barpos-select'))) e.value = settings.barPosition;
    if ((e = $('audio-barvisible-select'))) e.value = settings.barVisible ? 'shown' : 'hidden';
    fillBufferSelect();
    if (elOut) elOut.value = settings.outGain;
    if (elOutVal) elOutVal.textContent = settings.outGain;
    updateMuteBtn();
    updateDeviceRows();
  }

  function updateBarLabel() {
    if (!elDevLbl) return;
    if (settings.deviceType === 'none') { elDevLbl.textContent = 'no device'; return; }
    var idev = inputDevice(), odev = outputDevice();
    var name = settings.deviceType === 'asio'
      ? ((idev && idev.name) || 'ASIO device')
      : ((odev && odev.name) || 'output');
    var rate = (running && actualRate) ? actualRate : settings.rate;
    var frames = (running && actualFrames) ? actualFrames : settings.frames;
    elDevLbl.textContent = settings.deviceType.toUpperCase() + ' · ' + name + ' · ' +
      (rate / 1000) + 'k · ' + frames + ' · ' + (settings.inputMode === 'stereo' ? 'stereo' : 'mono');
  }

  // --- events from main/helper ---
  if (api.onAudioStatus) {
    api.onAudioStatus(function (s) {
      setBusy(false);   // state change confirmed — release the toggle lock
      if (s.error) {
        log('Audio error: ' + s.error);
        setToggleState(false);
        flashToggleErr();
        var hint = 'Audio engine couldn’t start — is your interface on? Turn it on, then click AUDIO ENGINE OFF→ON, or open Audio Setup.';
        status(hint);
        setupStatus('Couldn’t start: ' + s.error + ' — check the interface / device, then try again.');
        return;
      }
      setToggleState(!!s.running);
      if (s.running) {
        actualFrames = s.frames || null;
        actualRate   = s.rate || null;
        // First successful bring-up → mark configured so future starts aren't auto-muted.
        if (!settings.configured) { settings.configured = true; saveSettings(); }
        updateMuteBtn();
        status('Audio engine ON.' + (muted ? ' (muted)' : ''));
        updateBarLabel();
        var snap = (s.requestedFrames && s.frames && s.requestedFrames !== s.frames)
          ? ' (driver set ' + s.frames + ', you asked ' + s.requestedFrames + ')' : '';
        setupStatus('Engine running — ' + (s.rate / 1000) + 'k · ' + s.frames + ' buffer' + snap +
          (muted ? ' · MUTED' : '') + '.');
      } else {
        actualFrames = null; actualRate = null;
      }
    });
  }
  if (api.onAudioLevel) {
    api.onAudioLevel(function (lv) {
      var l = (lv && lv.l != null) ? lv.l : 0;
      var r = (lv && lv.r != null) ? lv.r : 0;
      if (elMeterL) elMeterL.style.width = Math.max(0, Math.min(100, Math.round(l * 100))) + '%';
      if (elMeterR) elMeterR.style.width = Math.max(0, Math.min(100, Math.round(r * 100))) + '%';
      if (l >= 0.99 || r >= 0.99) setClip(true);   // latches until cleared / engine restart
    });
  }
  if (api.onAudioDevices) api.onAudioDevices(function (payload) { handleDevices(payload); });
  if (api.onAudioAutostart) api.onAudioAutostart(function () { autoStartEngine(); });

  // --- restore saved settings ---
  document.addEventListener('DOMContentLoaded', function () {
    function done() {
      applySettingsToControls();
      setToggleState(false);   // start in the OFF (dimmed) state
      applyBarVisibility();    // places the bar (top/bottom) or hides it
      updateBarLabel();
      // /AUDIOON: explicit launch intent (cold-start flag, or the live event from
      // a second-instance launch).
      log('Audio: /AUDIOON=' + !!api.audioAutoStart + ' configured=' + settings.configured +
          ' type=' + settings.deviceType + ' barVisible=' + settings.barVisible);
      if (api.audioAutoStart) setTimeout(autoStartEngine, 1800);
      // Prime the device cache for the chosen type at startup (engine off here),
      // so the Setup panel has the list even before it's opened. 'none' → skip.
      if (settings.deviceType !== 'none') setTimeout(function () { if (!running) requestDevices(); }, 1500);
    }
    if (api.getAudioSettings) {
      Promise.resolve(api.getAudioSettings()).then(function (saved) {
        if (saved && typeof saved === 'object') {
          for (var k in settings) if (saved[k] != null) settings[k] = saved[k];
          // Migrate index-based saves → names. We can't map an index to a name
          // until the first scan, so stash it and resolve it in handleDevices.
          if (settings.asioDevName == null) {
            if (saved.deviceType == null && saved.deviceId != null) { settings.deviceType = 'asio'; legacyIdx.asio = saved.deviceId; }
            else if (saved.asioDev != null) { legacyIdx.asio = saved.asioDev; }
          }
        }
        done();
      }).catch(done);
    } else { done(); }
  });
})();
