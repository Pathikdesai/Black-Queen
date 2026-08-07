'use strict';
/* Draws the home screen icons into public/icons.
   Run with `npm run icons` after changing anything here.

   The icons are committed, so this only needs running when the artwork changes.
   Everything is written by hand rather than pulled from an image library: the
   game has exactly one dependency and it seemed a shame to add a second one for
   three small squares. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---- PNG container ---- */
const CRCT = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRCT[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  // 10..12 stay zero: deflate, adaptive filtering, no interlace
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---- the artwork ---- */
/* A spade built from a triangle, two lobes and a flared stem. Coordinates run
   -1.2 to 1.2 across the square, y downwards. */
function inSpade(x, y) {
  if (y >= -1 && y <= 0.15 && Math.abs(x) <= 0.85 * (y + 1) / 1.15) return true;
  if (Math.hypot(x + 0.45, y - 0.15) <= 0.55) return true;
  if (Math.hypot(x - 0.45, y - 0.15) <= 0.55) return true;
  if (y >= 0.15 && y <= 0.96) {
    const t = (y - 0.15) / 0.81;
    if (Math.abs(x) <= 0.10 + 0.42 * Math.pow(t, 2.4)) return true;
  }
  return false;
}
const TOP = [0x12, 0x70, 0x3F];    // baize, lit from above
const BOT = [0x06, 0x2C, 0x1B];    // and falling into shadow
const BRASS = [0xE0, 0xAE, 0x3A];
const SS = 4;                       // supersampling, for edges that do not stair-step

/* span is the width of the drawing box the square maps onto. The spade itself
   spans 2.0, so anything above that is padding: the bigger the span, the more
   room around the artwork. */
function draw(size, span) {
  const buf = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    // vertical gradient, computed once per row
    const g = py / (size - 1);
    const bg = [0, 1, 2].map(k => Math.round(TOP[k] + (BOT[k] - TOP[k]) * g));
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = ((px + (sx + 0.5) / SS) / size) * span - span / 2;
        const y = ((py + (sy + 0.5) / SS) / size) * span - span / 2;
        if (inSpade(x, y)) hits++;
      }
      const a = hits / (SS * SS);
      const o = (py * size + px) * 3;
      for (let k = 0; k < 3; k++) buf[o + k] = Math.round(bg[k] * (1 - a) + BRASS[k] * a);
    }
  }
  return png(size, size, buf);
}

const dir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(dir, { recursive: true });
/* Maskable icons get cropped to a circle on some launchers, so the spade is
   drawn smaller there to stay inside the safe zone. The Apple icon is never
   cropped, so it can fill more of the square. */
const jobs = [
  ['icon-192.png', 192, 2.9],
  ['icon-512.png', 512, 2.9],
  ['apple-touch-icon.png', 180, 2.5]
];
for (const [name, size, span] of jobs) {
  const out = draw(size, span);
  fs.writeFileSync(path.join(dir, name), out);
  console.log(name, size + 'x' + size, (out.length / 1024).toFixed(1) + ' kB');
}
