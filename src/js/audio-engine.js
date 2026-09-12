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
    deviceId:  null,       // null until the user picks one (first-run → Setup)
    inputMode: 'mono',     // 'mono' | 'stereo'
    inMono:    0,          // 0-based input channel for mono
    inL:       0,
    inR:       1,          // 0-based input channels for stereo
    outPair:   0,          // left channel index of output pair (0 => outputs 1+2)
    rate:      48000,
    frames:    128,
    inGain:    70,
    outGain:   80
  };

  var running = false;
  var devicesById = {};    // id -> {name, in, out, ...}

  // --- elements ---
  function $(id) { return document.getElementById(id); }
  var elToggle = $('btn-audio');
  var elStrip  = $('audiostrip');
  var elIn     = $('audio-in');
  var elOut    = $('audio-out');
  var elInVal  = $('audio-in-val');
  var elOutVal = $('audio-out-val');
  var elMeter  = $('audio-meter');
  var elDevLbl = $('audio-dev-label');

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

  function startOpts() {
    var ch = deriveChannels();
    return {
      deviceId: settings.deviceId,
      rate:     settings.rate,
      frames:   settings.frames,
      inGain:   settings.inGain,
      outGain:  settings.outGain,
      inChannels:  ch.inChannels,
      outChannels: ch.outChannels
    };
  }

  function saveSettings() { if (api.saveAudioSettings) api.saveAudioSettings(settings); }

  function applyIfRunning() {
    if (running) api.audioStart(startOpts());   // helper restarts on new geometry
  }

  function showStrip(show) { if (elStrip) elStrip.style.display = show ? 'flex' : 'none'; }

  function setToggleState(on) {
    running = on;
    if (elToggle) { elToggle.textContent = on ? 'ON' : 'OFF'; elToggle.classList.toggle('on', on); }
    showStrip(on);
    if (!on && elMeter) elMeter.style.width = '0%';
  }

  function startEngine() {
    if (settings.deviceId == null) {
      status('Audio: choose a device and inputs first.');
      openAudioPanel();
      setupStatus('Pick your device and input(s), then turn the engine on.');
      return;
    }
    log('Audio: requesting engine ON');
    status('Audio engine starting…');
    api.audioStart(startOpts());
  }

  function stopEngine() {
    log('Audio: requesting engine OFF (releasing device)');
    api.audioStop();
    setToggleState(false);
    status('Audio engine stopped — device released.');
  }

  if (elToggle) {
    elToggle.addEventListener('click', function () { if (running) stopEngine(); else startEngine(); });
  }

  // --- gain sliders (audio bar) ---
  function wireSlider(el, valEl, key) {
    if (!el) return;
    el.addEventListener('input', function () {
      var v = parseInt(el.value, 10);
      settings[key] = v;
      if (valEl) valEl.textContent = v;
      if (running && api.audioSetGain) api.audioSetGain({ inGain: settings.inGain, outGain: settings.outGain });
      saveSettings();
    });
  }
  wireSlider(elIn,  elInVal,  'inGain');
  wireSlider(elOut, elOutVal, 'outGain');

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
  if ((b = $('audio-rescan-btn'))) b.addEventListener('click', requestDevices);

  function requestDevices() {
    setupStatus('Scanning devices…');
    if (api.audioListDevices) api.audioListDevices();
  }

  function opt(value, label, selected) {
    var o = document.createElement('option');
    o.value = value; o.textContent = label; if (selected) o.selected = true;
    return o;
  }

  function fillChannelSelects(dev) {
    var inN = (dev && dev.in) || 0, outN = (dev && dev.out) || 0, i;
    var mono = $('audio-in-mono'), l = $('audio-in-l'), r = $('audio-in-r'), out = $('audio-out-select');
    if (mono) { mono.innerHTML = ''; for (i = 0; i < inN; i++) mono.appendChild(opt(i, 'Input ' + (i + 1), i === settings.inMono)); }
    if (l)    { l.innerHTML = '';    for (i = 0; i < inN; i++) l.appendChild(opt(i, 'Input ' + (i + 1), i === settings.inL)); }
    if (r)    { r.innerHTML = '';    for (i = 0; i < inN; i++) r.appendChild(opt(i, 'Input ' + (i + 1), i === settings.inR)); }
    if (out)  { out.innerHTML = '';  for (i = 0; i + 1 < outN; i += 2) out.appendChild(opt(i, 'Output ' + (i + 1) + ' + ' + (i + 2), i === settings.outPair)); }
  }

  function refreshModeRows() {
    var mono = $('audio-row-mono'), stereo = $('audio-row-stereo');
    if (mono)   mono.style.display   = settings.inputMode === 'mono'   ? 'flex' : 'none';
    if (stereo) stereo.style.display = settings.inputMode === 'stereo' ? 'flex' : 'none';
  }

  function populateDevices(devices) {
    devicesById = {};
    var sel = $('audio-device-select');
    if (sel) sel.innerHTML = '';
    if (!devices || !devices.length) {
      if (sel) sel.appendChild(opt('', 'No ASIO devices found', true));
      setupStatus('No ASIO devices found.');
      return;
    }
    devices.forEach(function (d) {
      devicesById[d.id] = d;
      if (sel) sel.appendChild(opt(d.id, d.name, d.id === settings.deviceId));
    });
    // If nothing chosen yet, default to the first device (user still picks inputs).
    if (settings.deviceId == null || !devicesById[settings.deviceId]) {
      settings.deviceId = devices[0].id;
      if (sel) sel.value = String(settings.deviceId);
    }
    fillChannelSelects(devicesById[settings.deviceId]);
    refreshModeRows();
    setupStatus(running ? 'Engine running.' : 'Ready — turn the engine on from the top bar.');
    updateBarLabel();
  }

  // --- setup control changes ---
  function onCtl(id, handler) { var e = $(id); if (e) e.addEventListener('change', handler); }

  onCtl('audio-device-select', function () {
    settings.deviceId = parseInt(this.value, 10);
    fillChannelSelects(devicesById[settings.deviceId]);
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
  onCtl('audio-rate-select',   function () { settings.rate = parseInt(this.value, 10); saveSettings(); applyIfRunning(); updateBarLabel(); });
  onCtl('audio-buffer-select', function () { settings.frames = parseInt(this.value, 10); saveSettings(); applyIfRunning(); updateBarLabel(); });

  function applySettingsToControls() {
    var e;
    if ((e = $('audio-mode-select')))   e.value = settings.inputMode;
    if ((e = $('audio-rate-select')))   e.value = String(settings.rate);
    if ((e = $('audio-buffer-select'))) e.value = String(settings.frames);
    if (elIn)  elIn.value  = settings.inGain;
    if (elOut) elOut.value = settings.outGain;
    if (elInVal)  elInVal.textContent  = settings.inGain;
    if (elOutVal) elOutVal.textContent = settings.outGain;
    refreshModeRows();
  }

  function updateBarLabel() {
    if (!elDevLbl) return;
    var dev = settings.deviceId != null ? devicesById[settings.deviceId] : null;
    var name = dev ? dev.name : ('device ' + settings.deviceId);
    elDevLbl.textContent = name + ' · ' + (settings.rate / 1000) + 'k · ' + settings.frames +
      ' · ' + (settings.inputMode === 'stereo' ? 'stereo' : 'mono');
  }

  // --- events from main/helper ---
  if (api.onAudioStatus) {
    api.onAudioStatus(function (s) {
      if (s.error) { log('Audio error: ' + s.error); status('Audio engine error — ' + s.error); setToggleState(false); setupStatus('Error: ' + s.error); return; }
      setToggleState(!!s.running);
      if (s.running) { status('Audio engine ON.'); updateBarLabel(); setupStatus('Engine running.'); }
    });
  }
  if (api.onAudioLevel) {
    api.onAudioLevel(function (v) {
      if (!elMeter) return;
      elMeter.style.width = Math.max(0, Math.min(100, Math.round(v * 100))) + '%';
    });
  }
  if (api.onAudioDevices) api.onAudioDevices(function (devices) { populateDevices(devices); });

  // --- restore saved settings ---
  document.addEventListener('DOMContentLoaded', function () {
    function done() { applySettingsToControls(); updateBarLabel(); }
    if (api.getAudioSettings) {
      Promise.resolve(api.getAudioSettings()).then(function (saved) {
        if (saved && typeof saved === 'object') { for (var k in settings) if (saved[k] != null) settings[k] = saved[k]; }
        done();
      }).catch(done);
    } else { done(); }
  });
})();
