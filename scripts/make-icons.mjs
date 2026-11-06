// Draws every app and tray icon from one definition, with no dependencies: the mark
// is simple enough to rasterize directly, and PNG, ICO, and ICNS are simple containers.
// Run with: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'resources');

const TILE = [31, 111, 84];
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/** The W, on a 24-unit grid. The same strokes as the mark in the app's sidebar. */
const W_POINTS = [
  [5.5, 7.5],
  [8.7, 17],
  [12, 9.6],
  [15.3, 17],
  [18.5, 7.5],
];
const W_WIDTH = 2.3;

/** Macs expect an icon to leave room around its tile; Windows looks fine with the same margin. */
const TILE_INSET = 1.9;
const TILE_RADIUS = 5;

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function inW(x, y, scale, center) {
  const ux = (x - 12) * scale + 12;
  const uy = (y - 12) * scale + center;
  for (let i = 0; i + 1 < W_POINTS.length; i++) {
    if (distanceToSegment(ux, uy, W_POINTS[i], W_POINTS[i + 1]) <= W_WIDTH / 2) return true;
  }
  return false;
}

function inTile(x, y, inset, radius) {
  const low = inset;
  const high = 24 - inset;
  const cx = Math.max(low + radius, Math.min(x, high - radius));
  const cy = Math.max(low + radius, Math.min(y, high - radius));
  return Math.hypot(x - cx, y - cy) <= radius && x >= low && x <= high && y >= low && y <= high;
}

/** Render with supersampling. Returns RGBA bytes, not premultiplied. */
function draw(size, { tile = true, inset = TILE_INSET, radius = TILE_RADIUS, mark = WHITE, markScale = 1 } = {}) {
  const samples = size >= 512 ? 3 : 6;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tileHits = 0;
      let markHits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = ((px + (sx + 0.5) / samples) / size) * 24;
          const y = ((py + (sy + 0.5) / samples) / size) * 24;
          if (inW(x, y, markScale, 12.25)) markHits++;
          else if (tile && inTile(x, y, inset, radius)) tileHits++;
        }
      }
      const total = samples * samples;
      const alpha = (tileHits + markHits) / total;
      const offset = (py * size + px) * 4;
      if (alpha === 0) continue;
      const markShare = markHits / (tileHits + markHits);
      for (let c = 0; c < 3; c++) pixels[offset + c] = Math.round(mark[c] * markShare + TILE[c] * (1 - markShare));
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Windows accepts PNG data inside an ICO, at every size. */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach(({ size, data }, index) => {
    const at = index * 16;
    directory[at] = size >= 256 ? 0 : size;
    directory[at + 1] = size >= 256 ? 0 : size;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

function icns(entries) {
  const parts = entries.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

mkdirSync(OUT, { recursive: true });
const write = (name, data) => {
  writeFileSync(join(OUT, name), data);
  console.log(`${name}  ${(data.length / 1024).toFixed(1)} KB`);
};
const appPng = (size) => png(size, draw(size));

write('icon.png', appPng(1024));
write(
  'icon.ico',
  ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: appPng(size) }))),
);
write(
  'icon.icns',
  icns([
    { type: 'ic07', data: appPng(128) },
    { type: 'ic08', data: appPng(256) },
    { type: 'ic09', data: appPng(512) },
    { type: 'ic10', data: appPng(1024) },
  ]),
);

// A tray icon is tiny, so the tile fills it and the mark is drawn a little larger.
const trayOptions = { inset: 0.5, radius: 5, markScale: 0.88 };
write('tray.png', png(16, draw(16, trayOptions)));
write('tray@2x.png', png(32, draw(32, trayOptions)));

// macOS tints template images to suit the menu bar, so they are the mark alone.
const templateOptions = { tile: false, mark: BLACK, markScale: 0.72 };
write('trayTemplate.png', png(16, draw(16, templateOptions)));
write('trayTemplate@2x.png', png(32, draw(32, templateOptions)));
