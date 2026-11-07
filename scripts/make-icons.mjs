// Draws every icon Wordsmith uses from one definition, with no dependencies: the app,
// the tray, the Office add-in, the browser extension, and the web page.
// Run with: npm run icons
//
// The idea comes from the name. The W is metal straight from the forge: white-hot at
// the top, cooling to ember red, chiselled along its edges, throwing sparks.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- The artwork, on a 24-unit grid ---------- */

const W_OUTLINE = [
  [3.1, 6.3],
  [6.75, 6.3],
  [8.55, 13.6],
  [10.35, 6.3],
  [13.65, 6.3],
  [15.45, 13.6],
  [17.25, 6.3],
  [20.9, 6.3],
  [17.15, 18.2],
  [13.95, 18.2],
  [12, 11.3],
  [10.05, 18.2],
  [6.85, 18.2],
];

/** Four-pointed sparks, thrown up and to the right from the hammer's last blow. */
const SPARKS = [
  { x: 19.3, y: 3.7, r: 1.05 },
  { x: 16.9, y: 4.4, r: 0.5 },
  { x: 21.1, y: 5.5, r: 0.42 },
  { x: 4.7, y: 4.5, r: 0.55 },
];

const TILE_TOP = [52, 56, 66];
const TILE_BOTTOM = [17, 18, 23];
const EMBER_GLOW = [255, 96, 20];
const WHITE_HOT = [255, 247, 214];
const GOLD = [255, 190, 72];
const ORANGE = [250, 112, 30];
const EMBER = [206, 44, 18];
const BEVEL_DARK = [122, 26, 10];
const BEVEL_LIGHT = [255, 240, 196];

/** Light falls from the upper left, as from the mouth of the forge. */
const LIGHT = [-0.52, -0.85];
/** How far the chiselled edges reach into the letter. */
const BEVEL = 0.6;

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));

/** Colour by height: the top of the letter is hottest. */
function heat(t) {
  if (t < 0.34) return mix(WHITE_HOT, GOLD, t / 0.34);
  if (t < 0.7) return mix(GOLD, ORANGE, (t - 0.34) / 0.36);
  return mix(ORANGE, EMBER, (t - 0.7) / 0.3);
}

function inPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j];
    const [bx, by] = polygon[i];
    if (by > y !== ay > y && x < ((ax - bx) * (y - by)) / (ay - by) + bx) inside = !inside;
  }
  return inside;
}

/** Distance to the letter's edge, negative inside. */
function letterDistance(x, y) {
  let nearest = Infinity;
  for (let i = 0, j = W_OUTLINE.length - 1; i < W_OUTLINE.length; j = i++) {
    const [ax, ay] = W_OUTLINE[j];
    const [bx, by] = W_OUTLINE[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy));
    nearest = Math.min(nearest, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return inPolygon(x, y, W_OUTLINE) ? -nearest : nearest;
}

/** Each edge's direction away from the letter. */
const EDGE_NORMALS = (() => {
  let area = 0;
  const edges = W_OUTLINE.map(([ax, ay], i) => {
    const [bx, by] = W_OUTLINE[(i + 1) % W_OUTLINE.length];
    area += ax * by - bx * ay;
    const length = Math.hypot(bx - ax, by - ay);
    return [(by - ay) / length, -(bx - ax) / length];
  });
  return area > 0 ? edges : edges.map(([x, y]) => [-x, -y]);
})();

/** The letter's flat top: its outline moved inward, with corners that stay sharp. */
const TOP_FACE = W_OUTLINE.map(([px, py], i) => {
  const [ax, ay] = EDGE_NORMALS[(i + W_OUTLINE.length - 1) % W_OUTLINE.length];
  const [bx, by] = EDGE_NORMALS[i];
  // Where the two moved edges cross.
  const det = ax * by - ay * bx;
  return [px + (-BEVEL * by + BEVEL * ay) / det, py + (-BEVEL * ax + BEVEL * bx) / det];
});

/** One chiselled face per edge, between the outline and the flat top. */
const FACES = W_OUTLINE.map((point, i) => {
  const next = (i + 1) % W_OUTLINE.length;
  return { corners: [point, W_OUTLINE[next], TOP_FACE[next], TOP_FACE[i]], normal: EDGE_NORMALS[i] };
});

function tileEdge(x, y, inset, radius) {
  const qx = Math.abs(x - 12) - (12 - inset - radius);
  const qy = Math.abs(y - 12) - (12 - inset - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function sparkField(x, y) {
  let core = 0;
  let glow = 0;
  for (const { x: sx, y: sy, r } of SPARKS) {
    const dx = Math.abs(x - sx) / r;
    const dy = Math.abs(y - sy) / r;
    if (dx ** 0.62 + dy ** 0.62 <= 1) core = 1;
    glow = Math.max(glow, Math.exp(-((Math.hypot(x - sx, y - sy) / (r * 1.1)) ** 2)));
  }
  return { core, glow };
}

/** One sample of the icon. Returns colour and coverage. */
function shade(x, y, style) {
  const { inset, radius, detail, scale } = style;
  const edge = tileEdge(x, y, inset, radius);
  if (edge > 0) return null;

  // Steel, lit from above, with the forge glowing from below the letter.
  const down = clamp((y - inset) / (24 - 2 * inset));
  let color = mix(TILE_TOP, TILE_BOTTOM, down ** 0.8);
  const forge = Math.exp(-((Math.hypot((x - 12) / 1.5, y - 20.5) / 9) ** 2));
  color = mix(color, EMBER_GLOW, forge * 0.26);
  // A fine bright rim along the top edge, as on a bevelled plate.
  if (detail && edge > -0.16) color = mix(color, [255, 255, 255], 0.14 * clamp(1 - down * 2));

  // The letter is drawn larger at small sizes, where every pixel counts.
  const lx = (x - 12) / scale + 12;
  const ly = (y - 12.25) / scale + 12.25;
  const distance = letterDistance(lx, ly);

  if (distance > 0) {
    color = mix(color, EMBER_GLOW, 0.6 * Math.exp(-((distance / (detail ? 1.25 : 1)) ** 1.3)));
    if (detail) {
      const spark = sparkField(x, y);
      color = mix(color, GOLD, 0.8 * spark.glow);
      if (spark.core) color = WHITE_HOT;
    }
    return color;
  }

  const height = clamp((ly - 6.3) / (18.2 - 6.3));
  const top = heat(height);
  if (!detail || inPolygon(lx, ly, TOP_FACE)) return top;

  // Chiselled faces catch the light or fall into shade, depending on which way they look.
  const face = FACES.find(({ corners }) => inPolygon(lx, ly, corners));
  if (!face) return top;
  const facing = face.normal[0] * LIGHT[0] + face.normal[1] * LIGHT[1];
  return facing > 0 ? mix(top, BEVEL_LIGHT, 0.85 * facing) : mix(top, BEVEL_DARK, 0.75 * -facing);
}

const LARGE = { inset: 1.9, radius: 5, detail: true, scale: 1 };
/** For small sizes: a fuller tile, a bigger letter, and nothing too fine to survive. */
const SMALL = { inset: 0.6, radius: 4.4, detail: false, scale: 1.1 };

/** Render with supersampling. Returns RGBA bytes, not premultiplied. */
function draw(size, style = size >= 48 ? LARGE : SMALL) {
  const samples = size >= 512 ? 3 : 5;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = ((px + (sx + 0.5) / samples) / size) * 24;
          const y = ((py + (sy + 0.5) / samples) / size) * 24;
          const color = shade(x, y, style);
          if (!color) continue;
          hits++;
          for (let c = 0; c < 3; c++) sum[c] += color[c];
        }
      }
      if (hits === 0) continue;
      const at = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) pixels[at + c] = Math.round(sum[c] / hits);
      pixels[at + 3] = Math.round((hits / (samples * samples)) * 255);
    }
  }
  return pixels;
}

/** The letter alone in black, which macOS tints to suit the menu bar. */
function drawTemplate(size) {
  const samples = 6;
  const pixels = Buffer.alloc(size * size * 4);
  const scale = 0.92;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (((px + (sx + 0.5) / samples) / size) * 24 - 12) / scale + 12;
          const y = (((py + (sy + 0.5) / samples) / size) * 24 - 12) / scale + 12.25;
          if (inPolygon(x, y, W_OUTLINE)) hits++;
        }
      }
      pixels[(py * size + px) * 4 + 3] = Math.round((hits / (samples * samples)) * 255);
    }
  }
  return pixels;
}

/* ---------- File formats ---------- */

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

/* ---------- Writing every size ---------- */

const rendered = new Map();
function icon(size) {
  if (!rendered.has(size)) rendered.set(size, png(size, draw(size)));
  return rendered.get(size);
}

function write(folder, name, data) {
  const directory = join(ROOT, folder);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), data);
  console.log(`${folder}/${name}  ${(data.length / 1024).toFixed(1)} KB`);
}

write('resources', 'icon.png', icon(1024));
write('resources', 'icon.ico', ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: icon(size) }))));
write(
  'resources',
  'icon.icns',
  icns([
    { type: 'ic07', data: icon(128) },
    { type: 'ic08', data: icon(256) },
    { type: 'ic09', data: icon(512) },
    { type: 'ic10', data: icon(1024) },
  ]),
);

write('resources', 'tray.png', icon(16));
write('resources', 'tray@2x.png', icon(32));
write('resources', 'trayTemplate.png', png(16, drawTemplate(16)));
write('resources', 'trayTemplate@2x.png', png(32, drawTemplate(32)));

for (const size of [16, 32, 64, 80, 128]) write('src/addin/assets', `icon-${size}.png`, icon(size));
for (const size of [16, 32, 48, 128]) write('src/extension/assets', `icon-${size}.png`, icon(size));
write('src/renderer/public', 'favicon.png', icon(64));
