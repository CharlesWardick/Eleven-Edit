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

// Channel routing (set in startEngine). RtAudio opens a CONTIGUOUS block, so
// we open from the lowest to highest selected channel and cherry-pick the
// ones we want inside the callback. Offsets are positions WITHIN the opened
// block (0-based).
var stereoIn  = false;
var inCount   = 1;   // channels in the opened input block
var outCount  = 2;   // channels in the opened output block
var inLoff = 0, inRoff = 0;    // input L/R positions within the input frame
var outLoff = 0, outRoff = 1;  // output L/R positions within the output frame
var outBuf = null;             // reused, zero-filled output scratch buffer

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

// The audio callback: input PCM (interleaved Int16LE) arrives on the opened
// input block. We pick the selected L/R input channels, apply gain, and place
// them at the selected L/R OUTPUT channels (all other opened output channels
// stay silent). Mono input (stereoIn=false) is duplicated to both outputs.
// We also track the input PEAK (pre-gain) for the UI signal meter.
function onInput(pcm) {
  var g = inGain * outGain;
  var frames = (pcm.length / (inCount * 2)) | 0;
  var needed = frames * outCount * 2;
  if (!outBuf || outBuf.length !== needed) outBuf = Buffer.alloc(needed); // zero-filled
  var peak = 0;
  for (var f = 0; f < frames; f++) {
    var inBase = f * inCount * 2;
    var sL = pcm.readInt16LE(inBase + inLoff * 2);
    var sR = stereoIn ? pcm.readInt16LE(inBase + inRoff * 2) : sL;
    var aL = sL < 0 ? -sL : sL; if (aL > peak) peak = aL;
    var aR = sR < 0 ? -sR : sR; if (aR > peak) peak = aR;
    var oL = Math.round(sL * g); if (oL > 32767) oL = 32767; else if (oL < -32768) oL = -32768;
    var oR = Math.round(sR * g); if (oR > 32767) oR = 32767; else if (oR < -32768) oR = -32768;
    var outBase = f * outCount * 2;
    outBuf.writeInt16LE(oL, outBase + outLoff * 2);
    outBuf.writeInt16LE(oR, outBase + outRoff * 2);
  }
  if (peak > lastPeak) lastPeak = peak;   // hold peak between meter ticks
  if (rt) { try { rt.write(outBuf); } catch (e) {} }
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

  var rate = o.rate || 48000;
  var frames = o.frames || 128;
  var dev = (o.deviceId != null) ? o.deviceId : 0;
  if (o.inGain != null) inGain = o.inGain / 100;
  if (o.outGain != null) outGain = o.outGain / 100;

  // Channel selection (0-based). inChannels = [ch] (mono) or [L,R] (stereo).
  // outChannels = [L,R].
  var inCh = (Array.isArray(o.inChannels) && o.inChannels.length) ? o.inChannels : [0];
  var outCh = (Array.isArray(o.outChannels) && o.outChannels.length >= 2) ? o.outChannels : [0, 1];
  stereoIn = inCh.length >= 2;
  var inL = inCh[0], inR = stereoIn ? inCh[1] : inCh[0];
  var outL = outCh[0], outR = outCh[1];

  var inFirst = Math.min(inL, inR);
  inCount = Math.max(inL, inR) - inFirst + 1;
  inLoff = inL - inFirst;
  inRoff = inR - inFirst;

  var outFirst = Math.min(outL, outR);
  outCount = Math.max(outL, outR) - outFirst + 1;
  outLoff = outL - outFirst;
  outRoff = outR - outFirst;
  outBuf = null; // force realloc for the new geometry

  var actualFrames = frames;
  try {
    var ret = rt.openStream(
      { deviceId: dev, nChannels: outCount, firstChannel: outFirst },  // output block
      { deviceId: dev, nChannels: inCount,  firstChannel: inFirst },   // input block
      RtAudioFormat.RTAUDIO_SINT16,
      rate,
      frames,
      'ee-audio-passthrough',
      onInput,
      null
    );
    // RtAudio may snap the buffer to the driver's nearest legal size. If audify
    // returns the granted frame count, report the TRUTH instead of what we asked.
    if (typeof ret === 'number' && ret > 0) actualFrames = ret;
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

  send({ type: 'started', deviceId: dev, rate: rate, frames: actualFrames, requestedFrames: frames,
         mode: stereoIn ? 'stereo' : 'mono', inChannels: inCh, outChannels: outCh });
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
        sampleRates: d.sampleRates || [],
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

// Graceful fail: if the ASIO stream is pulled out from under us (e.g. the user
// changes rate/buffer in the interface's own ASIO control panel while running —
// a driver reset our audio layer can't follow), surface it and exit cleanly so
// the app flips the engine OFF instead of sitting on a broken stream.
process.on('uncaughtException', function (e) {
  send({ type: 'error', message: 'audio stream stopped: ' + (e && e.message ? e.message : e) });
  stopEngine();
  process.exit(1);
});

send({ type: 'ready' });
