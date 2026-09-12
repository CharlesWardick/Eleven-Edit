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
    outGain:   100,        // monitor level 0..100 (no input gain — see helper)
    barPosition: 'bottom', // 'bottom' (above status bar, default) | 'top' (under toolbar)
    barVisible:  true,     // false = hide the bar entirely (for non-audio users)
    configured: false      // false until first successful setup → first start is muted
  };

  var running = false;
  var muted   = false;     // runtime only (not persisted)
  var devicesById = {};    // id -> {name, in, out, ...}
  var lastDevices = null;  // cached scan (ASIO can't be enumerated while a device is open)
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

  function startOpts() {
    var ch = deriveChannels();
    return {
      deviceId: settings.deviceId,
      rate:     settings.rate,
      frames:   settings.frames,
      outGain:  settings.outGain,
      muted:    muted,
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
    }
    if (elStrip) elStrip.classList.toggle('engine-off', !on);
    if (!on) {
      if (elMeterL) elMeterL.style.width = '0%';
      if (elMeterR) elMeterR.style.width = '0%';
      setClip(false);
    }
  }

  function startEngine() {
    if (settings.deviceId == null) {
      status('Audio: choose a device and inputs first.');
      openAudioPanel();
      setupStatus('Pick your device and input(s), then turn the engine on.');
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
    elToggle.addEventListener('click', function () { if (running) stopEngine(); else startEngine(); });
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
    if (running) setupStatus('Stop the engine first to rescan devices.');
    else requestDevices();
  });

  function requestDevices() {
    // ASIO can't be enumerated while the engine holds a device — the scan comes
    // back empty. So only do a live scan when the engine is OFF; otherwise reuse
    // the cached list.
    if (running) {
      if (lastDevices && lastDevices.length) {
        populateDevices(lastDevices);
        setupStatus('Engine running — showing last scan. Stop the engine to rescan.');
      } else {
        setupStatus('Turn the engine OFF to scan for audio devices.');
      }
      return;
    }
    setupStatus('Scanning devices…');
    if (api.audioListDevices) api.audioListDevices();
  }

  function handleDevices(devices) {
    if (devices && devices.length) { lastDevices = devices; populateDevices(devices); }
    else if (lastDevices && lastDevices.length) { populateDevices(lastDevices); } // ignore a failed/empty scan
    else { populateDevices([]); }
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

  var FALLBACK_RATES = [44100, 48000, 88200, 96000];
  function fillRateSelect(dev) {
    var sel = $('audio-rate-select');
    if (!sel) return;
    var rates = (dev && dev.sampleRates && dev.sampleRates.length) ? dev.sampleRates.slice() : FALLBACK_RATES;
    // Snap current rate to the device's preferred if it isn't supported here.
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
    fillRateSelect(devicesById[settings.deviceId]);
    fillBufferSelect();
    refreshModeRows();
    setupStatus(running ? 'Engine running.' : 'Ready — turn the engine on from the top bar.');
    updateBarLabel();
  }

  // --- setup control changes ---
  function onCtl(id, handler) { var e = $(id); if (e) e.addEventListener('change', handler); }

  onCtl('audio-device-select', function () {
    settings.deviceId = parseInt(this.value, 10);
    fillChannelSelects(devicesById[settings.deviceId]);
    fillRateSelect(devicesById[settings.deviceId]);
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
    if ((e = $('audio-mode-select')))   e.value = settings.inputMode;
    if ((e = $('audio-rate-select')))   e.value = String(settings.rate);
    if ((e = $('audio-barpos-select'))) e.value = settings.barPosition;
    if ((e = $('audio-barvisible-select'))) e.value = settings.barVisible ? 'shown' : 'hidden';
    fillBufferSelect();
    if (elOut) elOut.value = settings.outGain;
    if (elOutVal) elOutVal.textContent = settings.outGain;
    updateMuteBtn();
    refreshModeRows();
  }

  function updateBarLabel() {
    if (!elDevLbl) return;
    var dev = settings.deviceId != null ? devicesById[settings.deviceId] : null;
    var name = dev ? dev.name : ('device ' + settings.deviceId);
    var rate = (running && actualRate) ? actualRate : settings.rate;
    var frames = (running && actualFrames) ? actualFrames : settings.frames;
    elDevLbl.textContent = name + ' · ' + (rate / 1000) + 'k · ' + frames +
      ' · ' + (settings.inputMode === 'stereo' ? 'stereo' : 'mono');
  }

  // --- events from main/helper ---
  if (api.onAudioStatus) {
    api.onAudioStatus(function (s) {
      if (s.error) { log('Audio error: ' + s.error); status('Audio engine error — ' + s.error); setToggleState(false); setupStatus('Error: ' + s.error); return; }
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
  if (api.onAudioDevices) api.onAudioDevices(function (devices) { handleDevices(devices); });

  // --- restore saved settings ---
  document.addEventListener('DOMContentLoaded', function () {
    function done() {
      applySettingsToControls();
      setToggleState(false);   // start in the OFF (dimmed) state
      applyBarVisibility();    // places the bar (top/bottom) or hides it
      updateBarLabel();
      // /AUDIOON: auto-start on launch, but only if audio was set up before and
      // the bar is visible (so there's a control to stop it).
      if (api.audioAutoStart && settings.configured && settings.barVisible) {
        setTimeout(function () { if (!running) startEngine(); }, 1800);
      }
      // Prime the device cache once at startup (engine is off here) so the Setup
      // panel always has the list, even if the user turns the engine on before
      // ever opening the panel.
      setTimeout(function () { if (!running) requestDevices(); }, 1500);
    }
    if (api.getAudioSettings) {
      Promise.resolve(api.getAudioSettings()).then(function (saved) {
        if (saved && typeof saved === 'object') { for (var k in settings) if (saved[k] != null) settings[k] = saved[k]; }
        done();
      }).catch(done);
    } else { done(); }
  });
})();
