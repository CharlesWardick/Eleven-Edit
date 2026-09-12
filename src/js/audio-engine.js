/*
 * Eleven Edit — Audio Engine UI wiring (v2.0.0)
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 *
 * Drives the topbar AUDIO toggle and the audio strip (IN/OUT sliders + signal
 * meter). Talks to main.js over the electronAPI audio bridge; main.js owns the
 * audio-helper.js child process that actually does the ASIO passthrough.
 *
 * TONIGHT'S SCOPE (initial increment):
 *  - Device is HARDCODED to the Focusrite ASIO (see DEFAULT_ASIO_DEVICE_ID)
 *    until the device picker / Audio Setup panel exists. A saved deviceId in
 *    settings, if present, overrides it.
 *  - No /AUDIOON launch switch yet, no first-run Setup prompt yet.
 */

(function () {
  'use strict';

  var api = window.electronAPI;
  if (!api || !api.audioStart) return; // not in Electron / API missing

  // TEMPORARY: Focusrite USB ASIO was device id 1 in Charlie's list.js scan.
  // Replaced by the device picker in a later increment.
  var DEFAULT_ASIO_DEVICE_ID = 1;

  var settings = {
    deviceId: DEFAULT_ASIO_DEVICE_ID,
    inGain:   70,
    outGain:  80,
    rate:     48000,
    channels: 2,
    frames:   128
  };

  var running = false;

  var elToggle = document.getElementById('btn-audio');
  var elStrip  = document.getElementById('audiostrip');
  var elIn     = document.getElementById('audio-in');
  var elOut    = document.getElementById('audio-out');
  var elInVal  = document.getElementById('audio-in-val');
  var elOutVal = document.getElementById('audio-out-val');
  var elMeter  = document.getElementById('audio-meter');
  var elDevLbl = document.getElementById('audio-dev-label');

  function log(msg) { if (typeof appLog === 'function') appLog(msg); }
  function status(msg) { if (typeof setStatus === 'function') setStatus(msg); }

  function applySettingsToUI() {
    if (elIn)  elIn.value  = settings.inGain;
    if (elOut) elOut.value = settings.outGain;
    if (elInVal)  elInVal.textContent  = settings.inGain;
    if (elOutVal) elOutVal.textContent = settings.outGain;
  }

  function saveSettings() {
    if (api.saveAudioSettings) api.saveAudioSettings(settings);
  }

  function showStrip(show) {
    if (elStrip) elStrip.style.display = show ? 'flex' : 'none';
  }

  function setToggleState(on) {
    running = on;
    if (elToggle) {
      elToggle.textContent = on ? 'ON' : 'OFF';
      elToggle.classList.toggle('on', on);
    }
    showStrip(on);
    if (!on && elMeter) elMeter.style.width = '0%';
  }

  function startEngine() {
    log('Audio: requesting engine ON (device ' + settings.deviceId + ')');
    status('Audio engine starting…');
    api.audioStart({
      deviceId: settings.deviceId,
      rate:     settings.rate,
      channels: settings.channels,
      frames:   settings.frames,
      inGain:   settings.inGain,
      outGain:  settings.outGain
    });
  }

  function stopEngine() {
    log('Audio: requesting engine OFF (releasing device)');
    api.audioStop();
    setToggleState(false);          // release visually right away
    status('Audio engine stopped — device released.');
  }

  // --- toggle ---
  if (elToggle) {
    elToggle.addEventListener('click', function () {
      if (running) stopEngine(); else startEngine();
    });
  }

  // --- sliders ---
  function wireSlider(el, valEl, key) {
    if (!el) return;
    el.addEventListener('input', function () {
      var v = parseInt(el.value, 10);
      settings[key] = v;
      if (valEl) valEl.textContent = v;
      if (running && api.audioSetGain) {
        api.audioSetGain({ inGain: settings.inGain, outGain: settings.outGain });
      }
      saveSettings();
    });
  }
  wireSlider(elIn,  elInVal,  'inGain');
  wireSlider(elOut, elOutVal, 'outGain');

  // --- events from main/helper ---
  if (api.onAudioStatus) {
    api.onAudioStatus(function (s) {
      if (s.error) {
        log('Audio error: ' + s.error);
        status('Audio engine error — ' + s.error);
        setToggleState(false);
        return;
      }
      setToggleState(!!s.running);
      if (s.running) {
        status('Audio engine ON.');
        if (elDevLbl) elDevLbl.textContent =
          'ASIO device ' + s.deviceId + ' · ' + settings.rate / 1000 + 'k · ' + settings.frames;
      }
    });
  }

  if (api.onAudioLevel) {
    api.onAudioLevel(function (v) {
      if (!elMeter) return;
      var pct = Math.max(0, Math.min(100, Math.round(v * 100)));
      elMeter.style.width = pct + '%';
    });
  }

  // --- restore saved settings on load ---
  document.addEventListener('DOMContentLoaded', function () {
    if (api.getAudioSettings) {
      Promise.resolve(api.getAudioSettings()).then(function (saved) {
        if (saved && typeof saved === 'object') {
          for (var k in settings) {
            if (saved[k] != null) settings[k] = saved[k];
          }
        }
        applySettingsToUI();
      });
    } else {
      applySettingsToUI();
    }
  });
})();
