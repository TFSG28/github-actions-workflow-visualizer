// Generates images/icon.png (128x128) with no external dependencies.
// Draws the extension's motif: a small job DAG (nodes + edges) on the
// GitHub Actions blue, echoing the run-graph the extension renders.
// Rendered at 4x and box-downsampled for clean anti-aliased edges.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../images/icon.png', import.meta.url));
const SIZE = 128;
const SS = 4; // supersample factor
const S = SIZE * SS;

// RGBA buffer at supersampled resolution.
const buf = new Uint8Array(S * S * 4);
const set = (x, y, [r, g, b, a]) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // straight-alpha over compositing onto existing pixel
  const sa = a / 255;
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;
  buf[i] = (r * sa + buf[i] * da * (1 - sa)) / oa;
  buf[i + 1] = (g * sa + buf[i + 1] * da * (1 - sa)) / oa;
  buf[i + 2] = (b * sa + buf[i + 2] * da * (1 - sa)) / oa;
  buf[i + 3] = oa * 255;
};

const BLUE = [0x20, 0x88, 0xff];
const DARK = [0x0d, 0x11, 0x17];
const WHITE = [0xff, 0xff, 0xff];

// Rounded-rect background.
const radius = 26 * SS;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let inside = true;
    const corners = [
      [radius, radius], [S - radius, radius],
      [radius, S - radius], [S - radius, S - radius]
    ];
    if (x < radius && y < radius) inside = Math.hypot(x - corners[0][0], y - corners[0][1]) <= radius;
    else if (x > S - radius && y < radius) inside = Math.hypot(x - corners[1][0], y - corners[1][1]) <= radius;
    else if (x < radius && y > S - radius) inside = Math.hypot(x - corners[2][0], y - corners[2][1]) <= radius;
    else if (x > S - radius && y > S - radius) inside = Math.hypot(x - corners[3][0], y - corners[3][1]) <= radius;
    if (inside) set(x, y, [...BLUE, 255]);
  }
}

// Anti-aliased line via signed distance to a segment.
function line(x1, y1, x2, y2, width, color) {
  x1 *= SS; y1 *= SS; x2 *= SS; y2 *= SS; width *= SS;
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - width));
  const maxX = Math.min(S - 1, Math.ceil(Math.max(x1, x2) + width));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - width));
  const maxY = Math.min(S - 1, Math.ceil(Math.max(y1, y2) + width));
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
      const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      const a = Math.max(0, Math.min(1, width - d));
      if (a > 0) set(x, y, [...color, a * 255]);
    }
  }
}

// Anti-aliased filled disc.
function disc(cx, cy, r, color) {
  cx *= SS; cy *= SS; r *= SS;
  const minX = Math.max(0, Math.floor(cx - r - 1));
  const maxX = Math.min(S - 1, Math.ceil(cx + r + 1));
  const minY = Math.max(0, Math.floor(cy - r - 1));
  const maxY = Math.min(S - 1, Math.ceil(cy + r + 1));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy)));
      if (a > 0) set(x, y, [...color, a * 255]);
    }
  }
}

// DAG layout (in 128px space): one source fanning out to two nodes.
const nodes = { a: [40, 64], b: [88, 42], c: [88, 86] };
line(...nodes.a, ...nodes.b, 5, WHITE);
line(...nodes.a, ...nodes.c, 5, WHITE);
disc(...nodes.a, 15, WHITE);
disc(...nodes.b, 12, WHITE);
disc(...nodes.c, 12, WHITE);
// Inner dots tint the nodes with the dark brand color for contrast.
disc(...nodes.a, 7, DARK);
disc(...nodes.b, 5.5, DARK);
disc(...nodes.c, 5.5, DARK);

// Box-downsample supersampled buffer to final size.
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
      }
    }
    const n = SS * SS;
    const o = (y * SIZE + x) * 4;
    out[o] = Math.round(r / n);
    out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n);
    out[o + 3] = Math.round(a / n);
  }
}

// Encode PNG (RGBA, 8-bit) with zlib.
function crc32(data) {
  let c = ~0;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type RGBA
// filter type 0 per scanline
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`Wrote ${OUT} (${png.length} bytes)`);
