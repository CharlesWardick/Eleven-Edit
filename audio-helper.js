/*
 * Eleven Edit — Audio Helper (v2.0.0 audio engine)
 * Copyright (c) 2026 Charles Wardick
 *
 * Separate audio-passthrough process, spawned by main.js on engine ON and
 * killed on engine OFF (mirrors the Java MIDI bridge "program within the
 * program" pattern). Uses `audify` (RtAudio) for low-latency ASIO duplex
 * passthrough: audio in from the chosen ASIO device -> gain -> audio out on
 * the same device. No DSP beyond a simple volume multiply.
 *
 * NOTE ON LICENSING: `audify` and RtAudio are MIT/permissive, but audify's
 * prebuilt binary contains code compiled against Steinberg's ASIO SDK. That
 * SDK's terms still apply to the shipped binary — to be cleared before ship.
 * Kept as a SEPARATE PROCESS so the boundary stays clean.
 *
 * PROTOCOL (newline-delimited JSON, both directions):
 *   stdin  (commands from main.js):
 *     {"cmd":"start","deviceId":1,"rate":48000,"channels":2,"frames":128,
 *                    "inGain":70,"outGain":80}
 *     {"cmd":"stop"}
 *     {"cmd":"setGain","inGain":70,"outGain":80}
 *     {"cmd":"list"}
 *   stdout (events to main.js):
 *     {"type":"ready"}
 *     {"type":"started","deviceId":1,"rate":48000,"channels":2,"frames":128}
 *     {"type":"stopped"}
 *     {"type":"level","in":0.42}                 // input peak 0..1, ~10/sec
 *     {"type":"devices","api":"ASIO","devices":[...]}
 *     {"type":"error","message":"..."}
 */

'use strict';

var audify = require('audify');
var RtAudio = audify.RtAudio;
var RtAudioApi = audify.RtAudioApi;
var RtAudioFormat = audify.RtAudioFormat;

var rt = null;
var inGain = 0.7;      // 0..1 (from 0..100 slider)
var outGain = 0.8;
var lastPeak = 0;
var meterTimer = null;

function send(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (e) {}
}

function stopEngine() {
  if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
  if (rt) {
    try { rt.stop(); } catch (e) {}
    try { rt.closeStream(); } catch (e) {}
    rt = null;
  }
  lastPeak = 0;
}

// The audio callback: input PCM (interleaved Int16LE) arrives, we apply gain
// and write it straight back out on the same device. We also track the input
// PEAK (pre-gain) for the signal meter in the UI.
function onInput(pcm) {
  var g = inGain * outGain;
  var n = pcm.length >> 1;             // number of Int16 samples
  var peak = 0;
  for (var i = 0; i < n; i++) {
    var off = i << 1;
    var s = pcm.readInt16LE(off);
    var a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    s = Math.round(s * g);
    if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
    pcm.writeInt16LE(s, off);
  }
  if (peak > lastPeak) lastPeak = peak;   // hold peak between meter ticks
  if (rt) { try { rt.write(pcm); } catch (e) {} }
}

function startEngine(o) {
  stopEngine();  // clean any prior stream first

  try {
    rt = new RtAudio(RtAudioApi.WINDOWS_ASIO);
  } catch (e) {
    send({ type: 'error', message: 'ASIO init failed: ' + e.message });
    rt = null;
    return;
  }

  var channels = o.channels || 2;
  var rate = o.rate || 48000;
  var frames = o.frames || 128;
  var dev = (o.deviceId != null) ? o.deviceId : 0;
  if (o.inGain != null) inGain = o.inGain / 100;
  if (o.outGain != null) outGain = o.outGain / 100;

  try {
    rt.openStream(
      { deviceId: dev, nChannels: channels, firstChannel: 0 },   // output
      { deviceId: dev, nChannels: channels, firstChannel: 0 },   // input
      RtAudioFormat.RTAUDIO_SINT16,
      rate,
      frames,
      'ee-audio-passthrough',
      onInput,
      null
    );
    rt.start();
  } catch (e) {
    send({ type: 'error', message: 'open/start failed: ' + e.message });
    stopEngine();
    return;
  }

  // Emit the input meter ~10x/sec (peak since last tick, then reset).
  meterTimer = setInterval(function () {
    var v = lastPeak / 32768;
    lastPeak = 0;
    send({ type: 'level', in: v });
  }, 100);

  send({ type: 'started', deviceId: dev, rate: rate, channels: channels, frames: frames });
}

function setGain(o) {
  if (o.inGain != null) inGain = o.inGain / 100;
  if (o.outGain != null) outGain = o.outGain / 100;
}

function listDevices() {
  try {
    var r = new RtAudio(RtAudioApi.WINDOWS_ASIO);
    var devices = r.getDevices().map(function (d, i) {
      return {
        id: i, name: d.name,
        in: d.inputChannels, out: d.outputChannels, duplex: d.duplexChannels,
        rate: d.preferredSampleRate,
        defaultIn: d.isDefaultInput, defaultOut: d.isDefaultOutput
      };
    });
    send({ type: 'devices', api: 'ASIO', devices: devices });
  } catch (e) {
    send({ type: 'error', message: 'device list failed: ' + e.message });
  }
}

function handle(msg) {
  switch (msg && msg.cmd) {
    case 'start':   startEngine(msg); break;
    case 'stop':    stopEngine(); send({ type: 'stopped' }); break;
    case 'setGain': setGain(msg); break;
    case 'list':    listDevices(); break;
    default: break;
  }
}

// --- stdin: newline-delimited JSON commands ---
var buf = '';
process.stdin.on('data', function (d) {
  buf += d.toString();
  var idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    var line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    var msg = null;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    handle(msg);
  }
});
process.stdin.on('end', function () { stopEngine(); process.exit(0); });

function shutdown() { stopEngine(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

send({ type: 'ready' });
