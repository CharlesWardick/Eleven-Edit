/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// ════════════════════════════════════════════════════════════════════
// TUNER PANEL (build 114, v1.2.0). Opens in the panel area while the rack's
// tuner is on (TUNER button or front panel) and restores the previous panel
// when it goes off. Protocol (captured + hardware-tested 2026-09-26):
//   CMD 0x41 settings  set 00 41 [ref][mute] · read 01 41 -> 12 41 · rack
//                      broadcasts 02 41 on every change (front panel too)
//                      ref 0x22..0x68 = 410..480 Hz (Hz = ref + 376), mute 00 = muted, 01 = sound passes (fixed build 116)
//   CMD 0x42 note+tune poll 01 42 -> 12 42 [note][tune]; note = linear
//                      semitone index (strings step by 5; Eb2 = 0x11), name =
//                      NOTES[(note+10) % 12] (build 115), tune 0x40 = centre. Idle = 00 40. The rack
//                      volunteers nothing — must be polled.
// TUNE SCALE: raw offset (tune - 0x40) shown as-is until checked against the
// rack's own "+N" readout (TUNER_SCALE below).
// ════════════════════════════════════════════════════════════════════
var TUNER_NOTES = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
var TUNER_SCALE = 1;            // meter units per raw tune step (pending rack comparison)
var TUNER_POLL_MS = 50;         // ~20 Hz, Avid polls ~32 Hz
var tunerRef = 0x40, tunerMute = 1, tunerPollTimer = null;
var tunerPanelShown = false, tunerHidden = [];

function tunerStyle() { try { return localStorage.getItem('tunerStyle') || 'meter'; } catch (e) { return 'meter'; } }

function tunerApplyStyle() {
  var s = tunerStyle();
  var sel = document.getElementById('tuner-style'); if (sel) sel.value = s;
  var p = document.getElementById('panel-tuner'); if (!p) return;
  p.classList.toggle('ts-meter', s === 'meter');
  p.classList.toggle('ts-leds', s === 'leds');
  p.classList.toggle('ts-big', s === 'big');
}

function tunerShowSettings() {
  var v = document.getElementById('tuner-ref-sel'); if (v) v.value = String(tunerRef);
  var m = document.getElementById('tuner-mute'); if (m) m.classList.toggle('on', tunerMute === 0);   // 00 = muted
}

function tunerSendSettings(ref, mute) {
  ref = Math.max(0x22, Math.min(0x68, ref));
  sendHex('F0 13 0B 0F 00 41 ' + ref.toString(16).padStart(2, '0').toUpperCase() + ' 0' + (mute ? 1 : 0) + ' F7');
}

function tunerPollStart() {
  if (tunerPollTimer) return;
  tunerPollTimer = setInterval(function() { sendHex('F0 13 0B 0F 01 42 F7'); }, TUNER_POLL_MS);
}
function tunerPollStop() {
  if (tunerPollTimer) { clearInterval(tunerPollTimer); tunerPollTimer = null; }
}

// Swap the panel area to the tuner (remember what was showing) or back.
function tunerPanelOpen() {
  if (tunerPanelShown) return;
  var main = document.getElementById('main'), p = document.getElementById('panel-tuner');
  if (!main || !p) return;
  tunerHidden = [];
  Array.prototype.forEach.call(main.children, function(el) {
    if (el === p || !el.id || el.id.indexOf('panel-') !== 0 || el.offsetParent === null) return;
    tunerHidden.push({ el: el, disp: el.style.display });
    el.style.display = 'none';
  });
  p.style.display = '';
  tunerPanelShown = true;
  tunerApplyStyle();
  tunerShowNote(0, 0x40);
  sendHex('F0 13 0B 0F 01 41 F7');   // read current Mute + Reference
  tunerPollStart();
  appLog('Tuner panel opened');
}
function tunerPanelClose(restore) {
  tunerPollStop();
  if (!tunerPanelShown) return;
  document.getElementById('panel-tuner').style.display = 'none';
  if (restore) tunerHidden.forEach(function(h) { h.el.style.display = h.disp; });
  tunerHidden = [];
  tunerPanelShown = false;
  appLog('Tuner panel closed');
}

// Called whenever tunerOn changes (hardware-confirmed or the nav mimic).
function tunerPanelSync() {
  if (tunerOn) tunerPanelOpen(); else tunerPanelClose(true);
}

function tunerShowNote(note, tune) {
  var noSig = (note === 0 && tune === 0x40);
  var off = (tune - 0x40) * TUNER_SCALE;
  var a = Math.abs(off), inTune = !noSig && a <= 2;
  var col = noSig ? '#3a3f46' : inTune ? 'var(--green)' : a <= 10 ? 'var(--amber, #ff9a2a)' : 'var(--red)';
  var n = document.getElementById('tuner-note');
  if (n) {
    n.textContent = noSig ? '—' : TUNER_NOTES[(note + 10) % 12];
    n.style.color = noSig ? '#555' : inTune ? 'var(--green)' : '#ddd';
    n.style.textShadow = inTune ? '0 0 14px var(--green)' : 'none';
  }
  var nd = document.getElementById('tuner-needle');
  if (nd) {
    var pos = Math.max(-50, Math.min(50, noSig ? 0 : off));
    nd.style.left = (50 + pos * 0.96) + '%';
    nd.style.background = col; nd.style.boxShadow = noSig ? 'none' : '0 0 8px ' + col;
  }
  var leds = document.querySelectorAll('#tuner-leds .tn-led'), on = Math.round(Math.max(-50, Math.min(50, off)) / 5) + 10;
  leds.forEach(function(x, j) {
    var lit = !noSig && (j === on || (inTune && j === 10)), c = j === 10 && inTune ? 'var(--green)' : col;
    x.style.background = lit ? c : '#1d2126'; x.style.boxShadow = lit ? '0 0 8px ' + c : 'none';
  });
  var fl = document.getElementById('tuner-flat'), sh = document.getElementById('tuner-sharp');
  if (fl) fl.style.color = noSig ? '#2a2e34' : off < -2 ? 'var(--amber, #ff9a2a)' : inTune ? 'var(--green)' : '#2a2e34';
  if (sh) sh.style.color = noSig ? '#2a2e34' : off > 2 ? 'var(--amber, #ff9a2a)' : inTune ? 'var(--green)' : '#2a2e34';
  var c = document.getElementById('tuner-cents');
  if (c) c.textContent = noSig ? '' : (off > 0 ? '+' : '') + Math.round(off);
}

// Hooked from the SysEx dispatcher for CMD 0x41 / 0x42.
function tunerHandle(data) {
  if (typeof tunHandle === 'function') tunHandle(data);   // TUN dev tool (logging)
  if (data[5] === 0x41 && data.length >= 9) {
    tunerRef = data[6]; tunerMute = data[7]; tunerShowSettings();
  } else if (data[5] === 0x42 && data.length >= 9 && tunerPanelShown) {
    tunerShowNote(data[6], data[7]);
  }
}

document.addEventListener('DOMContentLoaded', function() {
  var byId = function(id) { return document.getElementById(id); };
  var leds = byId('tuner-leds');
  if (leds) for (var k = 0; k < 21; k++) { var d = document.createElement('div'); d.className = 'tn-led'; leds.appendChild(d); }
  var meter = byId('tuner-meter');
  if (meter) for (k = 0; k <= 20; k++) {
    var t = document.createElement('div'); t.className = 'tn-tick';
    t.style.left = (2 + k * 4.8) + '%'; t.style.height = (k % 5 ? 10 : 24) + 'px'; meter.appendChild(t);
  }
  var rs = byId('tuner-ref-sel');
  if (rs) {
    for (var r = 0x22; r <= 0x68; r++) { var o = document.createElement('option'); o.value = String(r); o.textContent = 'A = ' + (r + 376) + ' Hz'; rs.appendChild(o); }
    rs.value = String(tunerRef);
    rs.addEventListener('change', function() { tunerSendSettings(parseInt(this.value, 10), tunerMute); });
  }
  if (byId('tuner-style')) byId('tuner-style').addEventListener('change', function() {
    try { localStorage.setItem('tunerStyle', this.value); } catch (e) {}
    tunerApplyStyle();
  });
  if (byId('tuner-mute')) byId('tuner-mute').addEventListener('click', function() { tunerSendSettings(tunerRef, tunerMute ? 0 : 1); });
  if (byId('tuner-ref-dn')) byId('tuner-ref-dn').addEventListener('click', function() { tunerSendSettings(tunerRef - 1, tunerMute); });
  if (byId('tuner-ref-up')) byId('tuner-ref-up').addEventListener('click', function() { tunerSendSettings(tunerRef + 1, tunerMute); });
  if (byId('btn-tuner-close')) byId('btn-tuner-close').addEventListener('click', function() { sendCC(CC_TUNER, 0); });
  // Opening anything else in the panel area (chain block, gear) while the tuner
  // is up: put the old panel back and turn the tuner off, then let the click
  // do its normal job.
  ['chainstrip', 'chainstrip-modern', 'btn-settings'].forEach(function(id) {
    var el = byId(id);
    if (el) el.addEventListener('click', function() {
      if (!tunerPanelShown) return;
      tunerPanelClose(true);
      sendCC(CC_TUNER, 0);
    }, true);
  });
  tunerApplyStyle();
});
