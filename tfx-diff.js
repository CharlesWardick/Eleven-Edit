#!/usr/bin/env node
// tfx-diff.js — compare two TFX files byte-for-byte and print every
// offset where they differ. Use this to find where a specific parameter
// (gate threshold, gate release, rig volume, etc.) lives in the file:
//
//   1. Set up a patch. Capture it with "CAPTURE CURRENT PATCH NOW".
//   2. Change ONLY the one thing you're trying to locate (e.g. turn the
//      gate threshold knob to a different value). Don't touch anything
//      else, including the patch name.
//   3. Capture again with "CAPTURE CURRENT PATCH NOW".
//   4. Run:  node tfx-diff.js capture1.tfx capture2.tfx
//
// Every offset it prints is a candidate — if you only changed one thing,
// there should be very few differing bytes, and one of them is almost
// certainly the value you changed. If you know the two knob values you
// set (e.g. hardware showed 20% and turned to 60%), you can often
// confirm which offset it is by checking whether the byte values are
// consistent with those percentages (0-127 range, same v0 encoding used
// elsewhere in the protocol: v0>=0x40 -> v0-0x40, else v0+64).
//
// Usage: node tfx-diff.js file1.tfx file2.tfx

const fs = require('fs');

const [,, fileA, fileB] = process.argv;

if (!fileA || !fileB) {
  console.log('Usage: node tfx-diff.js <file1.tfx> <file2.tfx>');
  process.exit(1);
}

const bufA = fs.readFileSync(fileA);
const bufB = fs.readFileSync(fileB);

console.log('File A: ' + fileA + ' (' + bufA.length + ' bytes)');
console.log('File B: ' + fileB + ' (' + bufB.length + ' bytes)');

if (bufA.length !== bufB.length) {
  console.log('NOTE: files are different lengths — offsets after the shorter file\'s end won\'t align meaningfully.');
}

const len = Math.min(bufA.length, bufB.length);
let diffCount = 0;

console.log('\nOffset      A (hex/dec)      B (hex/dec)      A-as-v0-decode   B-as-v0-decode   preceding 2 bytes (possible [instId][paramId])');
console.log('----------------------------------------------------------------------------------------------------------------------------');

for (let i = 0; i < len; i++) {
  if (bufA[i] !== bufB[i]) {
    diffCount++;
    const a = bufA[i], b = bufB[i];
    // Same v0 decode used throughout the protocol for knob/param values
    const decodeV0 = v => (v >= 0x40) ? (v - 0x40) : (v + 64);
    const offsetHex = '0x' + i.toString(16).padStart(4, '0');

    // The live CMD 0x11 parameter broadcast format is [instId][paramId][v0].
    // If SEND_PATCH's bulk body uses the same layout internally, the two
    // bytes right before a changed value should look like a plausible
    // [instanceId][paramId] pair — small numbers, not random noise. This
    // won't be definitive on its own, but consistent small values here
    // across multiple diffs is a strong hint the structure matches.
    const prev2 = i >= 2 ? bufA[i-2] : null;
    const prev1 = i >= 1 ? bufA[i-1] : null;
    const context = (prev2 !== null && prev1 !== null)
      ? '0x' + prev2.toString(16).padStart(2,'0') + ' 0x' + prev1.toString(16).padStart(2,'0')
      : '(start of file)';

    console.log(
      offsetHex.padEnd(12) +
      ('0x' + a.toString(16).padStart(2,'0') + ' / ' + a).padEnd(18) +
      ('0x' + b.toString(16).padStart(2,'0') + ' / ' + b).padEnd(18) +
      String(decodeV0(a)).padEnd(17) +
      String(decodeV0(b)).padEnd(17) +
      context
    );
  }
}

if (bufA.length !== bufB.length) {
  console.log('\n(' + Math.abs(bufA.length - bufB.length) + ' extra byte(s) in the longer file, beyond the compared range)');
}

console.log('\n' + diffCount + ' differing byte(s) out of ' + len + ' compared.');
if (diffCount === 0) {
  console.log('Files are identical in the compared range — the change you made may not have been saved, or may not live in this file at all.');
} else if (diffCount > 20) {
  console.log('That\'s a lot of differences for a single changed knob — double check nothing else (patch name, other settings) changed between captures.');
}
