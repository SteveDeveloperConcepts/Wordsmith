/**
 * Draws the toolbar and store icons at build time: a white W on a dark green
 * rounded square. Plain arithmetic and zlib, so the build needs no image library.
 */
import { crc32, deflateSync } from 'node:zlib';

const GREEN = [20, 83, 54];
const WHITE = [255, 255, 255];

/** Corner radius as a share of the icon's width. */
const RADIUS = 0.22;
/** Samples per pixel along each axis. Small icons need this to keep the W's diagonals clean. */
const SAMPLES = 6;

/** The letter's outline in a unit square, symmetric about x = 0.5. */
const W: Array<[number, number]> = [
  [0.14, 0.27],
  [0.275, 0.27],
  [0.36, 0.59],
  [0.44, 0.27],
  [0.56, 0.27],
  [0.64, 0.59],
  [0.725, 0.27],
  [0.86, 0.27],
  [0.71, 0.75],
  [0.585, 0.75],
  [0.5, 0.46],
  [0.415, 0.75],
  [0.29, 0.75],
];

function insideLetter(x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = W.length - 1; i < W.length; j = i++) {
    const [xi, yi] = W[i];
    const [xj, yj] = W[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideSquare(x: number, y: number): boolean {
  const dx = Math.max(RADIUS - x, x - (1 - RADIUS), 0);
  const dy = Math.max(RADIUS - y, y - (1 - RADIUS), 0);
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

function pixels(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const total = SAMPLES * SAMPLES;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let square = 0;
      let letter = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if (!insideSquare(x, y)) continue;
          square++;
          if (insideLetter(x, y)) letter++;
        }
      }
      const offset = (py * size + px) * 4;
      const white = square === 0 ? 0 : letter / square;
      for (let c = 0; c < 3; c++) rgba[offset + c] = Math.round(GREEN[c] + (WHITE[c] - GREEN[c]) * white);
      rgba[offset + 3] = Math.round((255 * square) / total);
    }
  }
  return rgba;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** One icon as a PNG file. */
export function renderIcon(size: number): Buffer {
  const rgba = pixels(size);
  const stride = size * 4;
  const rows = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rows.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}
