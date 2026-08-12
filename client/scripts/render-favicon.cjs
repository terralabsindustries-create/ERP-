/**
 * Rasterises the SerpY mark to PNG/ICO with no image dependencies.
 * Geometry is kept identical to public/favicon.svg: a white disc, a black ring,
 * and one blade rotated 90° four times. The SVG rounds corners with a 1.2-wide
 * stroke, which is a Minkowski sum with a disc of radius 0.6 — so here a pixel
 * belongs to a blade when its distance to the triangle is <= 0.6.
 */
const fs = require('fs');
const zlib = require('zlib');

const SALMON = [0xfe, 0x93, 0x71];
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

const C = 32, DISC_R = 29, RING_R = 28, RING_HALF = 1.05, ROUND = 0.6;
const TRI = [[6.5, 29.76], [25.5, 12.4], [25.5, 29.76]];

const distToSegment = (px, py, [ax, ay], [bx, by]) => {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
};

const sign = (px, py, a, b) => (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);

const distToTriangle = (px, py) => {
  const d1 = sign(px, py, TRI[0], TRI[1]);
  const d2 = sign(px, py, TRI[1], TRI[2]);
  const d3 = sign(px, py, TRI[2], TRI[0]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  if (!(hasNeg && hasPos)) return 0; // inside
  return Math.min(
    distToSegment(px, py, TRI[0], TRI[1]),
    distToSegment(px, py, TRI[1], TRI[2]),
    distToSegment(px, py, TRI[2], TRI[0])
  );
};

// Colour of the artwork at a point in 64-unit space; null = transparent.
const colorAt = (x, y) => {
  for (let i = 0; i < 4; i++) {
    // Undo this blade's rotation instead of rotating the triangle.
    const a = (-i * Math.PI) / 2;
    const dx = x - C, dy = y - C;
    const rx = C + dx * Math.cos(a) - dy * Math.sin(a);
    const ry = C + dx * Math.sin(a) + dy * Math.cos(a);
    if (distToTriangle(rx, ry) <= ROUND) return i % 2 === 0 ? BLACK : SALMON;
  }
  const d = Math.hypot(x - C, y - C);
  if (Math.abs(d - RING_R) <= RING_HALF) return BLACK;
  if (d <= DISC_R) return WHITE;
  return null;
};

/** @param opaque fill the whole square white (iOS tiles ignore transparency) */
const render = (size, opaque) => {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // 4x4 supersampling
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = ((x + (sx + 0.5) / SS) / size) * 64;
          const uy = ((y + (sy + 0.5) / SS) / size) * 64;
          const c = colorAt(ux, uy) || (opaque ? WHITE : null);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS, i = (y * size + x) * 4;
      // Un-premultiply so edge pixels keep their colour at partial alpha.
      px[i] = a ? Math.round(r / (a / 255)) : 0;
      px[i + 1] = a ? Math.round(g / (a / 255)) : 0;
      px[i + 2] = a ? Math.round(b / (a / 255)) : 0;
      px[i + 3] = Math.round(a / n);
    }
  }
  return px;
};

const crc32 = zlib.crc32 || (() => {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  return (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};

const encodePNG = (px, size) => {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
};

// ICO carrying a PNG payload — understood by every browser that still asks for
// /favicon.ico, and far smaller than a BMP-encoded icon.
const encodeICO = (png, size) => {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = size === 256 ? 0 : size;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([dir, entry, png]);
};

// Usage: node scripts/render-favicon.js public
const out = process.argv[2] || 'public';
const png32 = encodePNG(render(32, false), 32);
fs.writeFileSync(`${out}/favicon.ico`, encodeICO(png32, 32));
fs.writeFileSync(`${out}/apple-touch-icon.png`, encodePNG(render(180, true), 180));
console.log('favicon.ico        ', fs.statSync(`${out}/favicon.ico`).size, 'bytes');
console.log('apple-touch-icon.png', fs.statSync(`${out}/apple-touch-icon.png`).size, 'bytes');
