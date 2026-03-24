'use strict';

/**
 * Generates placeholder PNG icons for bracer-chat using only built-in Node.js modules.
 * Replace assets/tray.png and assets/icon.png with real Bracer-branded icons before
 * a production build. Run: node scripts/generate-icons.js
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── CRC32 ──────────────────────────────────────────────────────────────────

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const byte of buf) crc = CRC32_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG writer ─────────────────────────────────────────────────────────────

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf    = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput  = Buffer.concat([typeBytes, data]);
  const crcBuf    = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function makePNG(width, height, r, g, b) {
  // IHDR
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 2; // color type: RGB truecolor
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  // Raw pixel rows: filter byte (0 = None) + RGB per pixel
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.allocUnsafe(1 + width * 3);
    row[0] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      row[1 + x * 3]     = r;
      row[2 + x * 3]     = g;
      row[3 + x * 3]     = b;
    }
    rows.push(row);
  }

  const idat = zlib.deflateSync(Buffer.concat(rows));

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ── Write icons ────────────────────────────────────────────────────────────

const assetsDir = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

// Only write placeholder PNGs if the real icon.ico is not already present.
// If icon.ico exists (real Bracer icon), skip — don't overwrite with placeholders.
const icoPath = path.join(assetsDir, 'icon.ico');
if (!fs.existsSync(icoPath)) {
  // Bracer blue: #1565C0 (R=21, G=101, B=192)
  fs.writeFileSync(path.join(assetsDir, 'tray.png'),  makePNG(16,  16,  21, 101, 192));
  fs.writeFileSync(path.join(assetsDir, 'icon.png'),  makePNG(256, 256, 21, 101, 192));
  console.log('Placeholder icons written to assets/');
  console.log('Replace with real Bracer icons before production build.');
} else {
  console.log('Real icon.ico found — skipping placeholder generation.');
}
