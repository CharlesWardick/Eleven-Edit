/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// ════════════════════════════════════════════════════════════════════
// TUNER TEST (build 112, Charlie's dev tool) — header TUN button.
// Proves, from EE, the 2026-09-26 capture finding: CMD 0x41 carries the
// tuner SETTINGS — F0 13 0B 0F 00 41 [ref] [mute] F7 (set, as the Avid
// editor sends it), rack answers 02 41 [ref] [mute]; REQU 01 41 -> 12 41.
//   ref  0x22..0x68 = 410..480 Hz (Hz = ref + 376; 0x40 = 440)
//   mute 01 = muted (tuner-on default), 00 = unmuted
// Also polls REQU 01 42 (note + tune) to show the needle data. Every send
// and every 0x41 reply is logged as TUNTEST; 0x42 replies only on change.
// ════════════════════════════════════════════════════════════════════
var tunRef = 0x40, tunMute = 1, tunPollTimer = null, tunLast42 = '';
var TUN_NOTES = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];

function tunHex(b) { return b.map(function(x) { return x.toString(16).padStart(2, '0').toUpperCase(); }).join(' '); }
function tunSend(bytes, why) {
  var ok = sendHex(tunHex(bytes));   // bridge wants space-separated hex
  appLog('TUNTEST send ' + tunHex(bytes) + '  (' + why + ')' + (ok ? '' : ' — NOT SENT, bridge down'));
}
function tunSet(ref, mute, why) {
  ref = Math.max(0x22, Math.min(0x68, ref));
  tunSend([0xF0,0x13,0x0B,0x0F,0x00,0x41,ref,mute,0xF7], why + ': ref ' + (ref + 376) + ' Hz, mute ' + (mute ? 'ON' : 'OFF'));
}
function tunShow() {
  var e = document.getElementById('tun-state');
  if (e) e.textContent = 'Rack says: Reference ' + (tunRef + 376) + ' Hz  ·  Mute ' + (tunMute ? 'ON' : 'OFF');
}

// Hooked from the SysEx dispatcher (sysex-handler.js) for CMD 0x41 / 0x42.
function tunHandle(data) {
  var cmd = data[5];
  if (cmd === 0x41) {
    appLog('TUNTEST recv ' + tunHex(Array.from(data)) + (data.length >= 9 ? '  -> ref ' + (data[6] + 376) + ' Hz, mute ' + (data[7] ? 'ON' : 'OFF') : ''));
    if (data.length >= 9) { tunRef = data[6]; tunMute = data[7]; tunShow(); }
  } else if (cmd === 0x42 && data.length >= 9) {
    var n = data[6], t = data[7];
    var txt = (n === 0 && t === 0x40) ? 'no signal' :
      TUN_NOTES[n & 0x0F] + (n >> 4) + '  tune ' + (t - 0x40 > 0 ? '+' : '') + (t - 0x40) + (t === 0x40 ? ' (in tune)' : '');
    var e = document.getElementById('tun-note'); if (e) e.textContent = 'Note: ' + txt;
    var key = tunHex(Array.from(data));
    if (key !== tunLast42) { tunLast42 = key; appLog('TUNTEST recv ' + key + '  -> ' + txt); }
  }
}

function tunPoll(on) {
  if (tunPollTimer) { clearInterval(tunPollTimer); tunPollTimer = null; }
  if (on) tunPollTimer = setInterval(function() { sendHex('F0 13 0B 0F 01 42 F7'); }, 50);
  appLog('TUNTEST note poll ' + (on ? 'START (20 Hz)' : 'STOP'));
  var b = document.getElementById('tun-poll'); if (b) b.textContent = on ? 'Stop note poll' : 'Start note poll';
}

document.addEventListener('DOMContentLoaded', function() {
  var byId = function(id) { return document.getElementById(id); };
  var on = function(id, fn) { if (byId(id)) byId(id).addEventListener('click', fn); };
  on('btn-tuntest', function() { byId('tun-modal').classList.add('open'); tunShow(); });
  on('tun-close', function() { tunPoll(false); byId('tun-modal').classList.remove('open'); });
  on('tun-on',  function() { sendCC(CC_TUNER, 127); appLog('TUNTEST tuner ON (CC 69)'); });
  on('tun-off', function() { tunPoll(false); sendCC(CC_TUNER, 0); appLog('TUNTEST tuner OFF (CC 69)'); });
  on('tun-read', function() { tunSend([0xF0,0x13,0x0B,0x0F,0x01,0x41,0xF7], 'read settings'); });
  on('tun-mute-on',  function() { tunSet(tunRef, 1, 'Mute ON'); });
  on('tun-mute-off', function() { tunSet(tunRef, 0, 'Mute OFF'); });
  on('tun-410', function() { tunSet(0x22, tunMute, 'Ref 410'); });
  on('tun-440', function() { tunSet(0x40, tunMute, 'Ref 440'); });
  on('tun-480', function() { tunSet(0x68, tunMute, 'Ref 480'); });
  on('tun-dn',  function() { tunSet(tunRef - 1, tunMute, 'Ref -1'); });
  on('tun-up',  function() { tunSet(tunRef + 1, tunMute, 'Ref +1'); });
  on('tun-poll', function() { tunPoll(!tunPollTimer); });
});
