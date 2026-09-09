/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// ════════════════════════════════════════════════════════════════════
// ZIP-WRITER.JS — dependency-free ZIP archive writer for the bank export
// feature (2026-08-10). Node's built-in zlib does DEFLATE compression but
// not the ZIP container format itself, and this project carries zero
// runtime npm dependencies — so this hand-rolls the standard local-file-
// header + central-directory + end-of-central-directory structure (the
// same format any zip tool reads/writes; nothing proprietary, no
// encryption — "no secrets hidden", same principle as EHB).
// Main-process only (require('./src/js/zip-writer.js') from main.js) —
// no DOM, no Electron API, just Buffer/zlib.
// ════════════════════════════════════════════════════════════════════
const zlib = require('zlib');

// Standard CRC-32 (ISO 3309 / ITU-T V.42), the polynomial ZIP requires.
const CRC_TABLE = (function() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// DOS date/time encoding — ZIP has no other timestamp format.
function dosDateTime(d) {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0xF) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

// entries: [{ name: 'A1-Above Symmetry.tfx', data: Buffer }, ...]
// Returns a Buffer — the complete .zip file. Every entry is stored with
// DEFLATE (method 8) when compression actually helps, STORED (method 0)
// otherwise (tiny/incompressible files: no point paying the local-header
// overhead for a negative saving).
function buildZip(entries) {
  const now = dosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? 8 : 0;
    const compData = useDeflate ? deflated : data;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);   // local file header signature
    localHeader.writeUInt16LE(20, 4);            // version needed to extract
    localHeader.writeUInt16LE(0, 6);             // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(now.time, 10);
    localHeader.writeUInt16LE(now.date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compData.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);            // extra field length

    localParts.push(localHeader, nameBuf, compData);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);  // central directory signature
    centralHeader.writeUInt16LE(20, 4);           // version made by
    centralHeader.writeUInt16LE(20, 6);           // version needed
    centralHeader.writeUInt16LE(0, 8);            // flags
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(now.time, 12);
    centralHeader.writeUInt16LE(now.date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compData.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);           // extra field length
    centralHeader.writeUInt16LE(0, 32);           // comment length
    centralHeader.writeUInt16LE(0, 34);           // disk number start
    centralHeader.writeUInt16LE(0, 36);           // internal attributes
    centralHeader.writeUInt32LE(0, 38);           // external attributes
    centralHeader.writeUInt32LE(offset, 42);      // local header offset

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compData.length;
  }

  const centralDirStart = offset;
  const centralDirBuf = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);              // EOCD signature
  eocd.writeUInt16LE(0, 4);                        // disk number
  eocd.writeUInt16LE(0, 6);                        // central dir disk
  eocd.writeUInt16LE(entries.length, 8);           // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);          // total entries
  eocd.writeUInt32LE(centralDirBuf.length, 12);    // central dir size
  eocd.writeUInt32LE(centralDirStart, 16);         // central dir offset
  eocd.writeUInt16LE(0, 20);                       // comment length

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}

// ── ZIP READER (2026-08-10, Import Rigs) ──
// Dependency-free counterpart to buildZip — parses the central directory
// (scanning backward for the EOCD record rather than assuming it's the
// last 22 bytes, so this isn't limited to reading only zips this app
// wrote; any zip using STORE or DEFLATE, which covers our own writer,
// Windows' built-in "Send to compressed folder", and 7-Zip's defaults,
// will parse). Returns [{name, data: Buffer}, ...], fully decompressed.
function readZip(buf) {
  const EOCD_SIG = 0x06054b50;
  const minEOCD = 22;
  let eocdOffset = -1;
  const searchFloor = Math.max(0, buf.length - minEOCD - 65536);
  for (let i = buf.length - minEOCD; i >= searchFloor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('Not a valid ZIP file (no end-of-central-directory record found)');

  const totalEntries     = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const dirEntries = [];
  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('Malformed ZIP central directory');
    const method            = buf.readUInt16LE(offset + 10);
    const compSize          = buf.readUInt32LE(offset + 20);
    const nameLen            = buf.readUInt16LE(offset + 28);
    const extraLen           = buf.readUInt16LE(offset + 30);
    const commentLen         = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    dirEntries.push({ name, method, compSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return dirEntries.map((e) => {
    const lh = e.localHeaderOffset;
    const lNameLen  = buf.readUInt16LE(lh + 26);
    const lExtraLen = buf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lNameLen + lExtraLen;
    const compData = buf.slice(dataStart, dataStart + e.compSize);
    let data;
    if (e.method === 8) data = zlib.inflateRawSync(compData);
    else if (e.method === 0) data = compData;
    else throw new Error('Unsupported ZIP compression method (' + e.method + ') for entry "' + e.name + '"');
    return { name: e.name, data };
  });
}

module.exports = { buildZip, readZip, crc32 };
