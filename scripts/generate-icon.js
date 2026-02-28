/**
 * generate-icon.js
 * Generates assets/icon.png — a 128×128 silver+blue gradient icon for Silver Engineer.
 * Uses only Node.js built-ins (zlib, fs) — no extra deps.
 *
 * Run: node scripts/generate-icon.js
 */
'use strict';

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const W = 128, H = 128;

// ── CRC32 table ────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeB  = Buffer.from(type, 'ascii');
  const lenB   = Buffer.alloc(4); lenB.writeUInt32BE(data.length, 0);
  const crcIn  = Buffer.concat([typeB, data]);
  const crcB   = Buffer.alloc(4); crcB.writeUInt32BE(crc32(crcIn), 0);
  return Buffer.concat([lenB, typeB, data, crcB]);
}

// ── IHDR ──────────────────────────────────────────────────────────────────
function makeIHDR(w, h) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8]  = 8;  // bit depth
  d[9]  = 2;  // colour type: RGB
  d[10] = 0; d[11] = 0; d[12] = 0; // compression, filter, interlace
  return pngChunk('IHDR', d);
}

// ── Pixel generation ───────────────────────────────────────────────────────
// Design: dark navy-to-charcoal radial background, silver circle badge,
// white "S" letter + sparkle dots — recognisable at 16px in the activity bar.

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function pixelAt(x, y) {
  const cx = W / 2, cy = H / 2;
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const normDist = dist / (W / 2);   // 0 = centre, 1 = edge

  // ── Background: deep navy gradient ──
  const bgR = Math.round(lerp(18, 10, normDist));
  const bgG = Math.round(lerp(26, 15, normDist));
  const bgB = Math.round(lerp(52, 28, normDist));

  // ── Silver circle (radius 54) ──
  const circleR = 54;
  const ringMin = circleR - 4, ringMax = circleR + 4;
  const inRing  = dist >= ringMin && dist <= ringMax;
  const ringT   = inRing ? 1 - Math.abs(dist - circleR) / 4 : 0;
  // Silver = mix of light grey + blue tint
  const silvR = Math.round(lerp(bgR, 210, ringT));
  const silvG = Math.round(lerp(bgG, 218, ringT));
  const silvB = Math.round(lerp(bgB, 235, ringT));

  // ── "S" letter mask (pixel-font, centred 36×48 bounding box) ──
  const lx = x - (cx - 18), ly = y - (cy - 24);   // letter-space coords
  function inS(px, py) {
    const scale = 1.5;
    const gx = Math.floor(px / scale), gy = Math.floor(py / scale);
    // 5×7 bitmap for letter S
    const rows = [
      [0,1,1,1,0],
      [1,0,0,0,1],
      [1,0,0,0,0],
      [0,1,1,1,0],
      [0,0,0,0,1],
      [1,0,0,0,1],
      [0,1,1,1,0],
    ];
    if (gy < 0 || gy >= rows.length) return false;
    if (gx < 0 || gx >= 5) return false;
    return rows[gy][gx] === 1;
  }
  const letterOn = inS(lx, ly);
  const letR = letterOn ? 255 : silvR;
  const letG = letterOn ? 255 : silvG;
  const letB = letterOn ? 255 : silvB + 10;

  // ── Sparkle dots (4 tiny dots around the S) ──
  function sparkle(sx, sy, r) {
    return Math.sqrt((x - sx) ** 2 + (y - sy) ** 2) < r;
  }
  const isSparkle =
    sparkle(cx + 34, cy - 34, 3) ||
    sparkle(cx - 36, cy + 32, 2) ||
    sparkle(cx + 26, cy + 36, 2.5);

  const fr = isSparkle ? 255 : letR;
  const fg = isSparkle ? 230 : letG;
  const fb = isSparkle ? 100 : letB;

  return [clamp(fr, 0, 255), clamp(fg, 0, 255), clamp(fb, 0, 255)];
}

// ── Build raw image rows ───────────────────────────────────────────────────
const rows = [];
for (let y = 0; y < H; y++) {
  const row = Buffer.alloc(1 + W * 3);
  row[0] = 0; // filter = None
  for (let x = 0; x < W; x++) {
    const [r, g, b] = pixelAt(x, y);
    row[1 + x * 3]     = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  rows.push(row);
}

const rawData  = Buffer.concat(rows);
const idatData = zlib.deflateSync(rawData, { level: 9 });

// ── Assemble PNG ───────────────────────────────────────────────────────────
const sig  = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const ihdr = makeIHDR(W, H);
const idat = pngChunk('IDAT', idatData);
const iend = pngChunk('IEND', Buffer.alloc(0));
const png  = Buffer.concat([sig, ihdr, idat, iend]);

const outPath = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);

console.log(`[icon] Generated ${outPath} (${(png.length / 1024).toFixed(1)} KB, ${W}×${H})`);
