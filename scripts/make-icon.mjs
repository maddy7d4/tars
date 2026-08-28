import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/**
 * Renders the marketplace icon from the same geometry as `media/tars.svg`.
 *
 * A script rather than a committed binary, for two reasons. The marketplace
 * requires PNG and the activity bar requires SVG, so the two must agree — and a
 * checked-in PNG drifts from the SVG the moment either is touched, silently.
 * And a binary nobody can regenerate is a binary nobody can review.
 *
 * Written by hand because no rasteriser is available in this toolchain, and
 * adding one (`sharp`, `librsvg`) to draw four rectangles would be a native
 * dependency in the install path of every contributor for no benefit.
 */

const SIZE = 128;
/** The SVG's coordinate space, so both files describe the same shape. */
const VIEWBOX = 24;
const SCALE = SIZE / VIEWBOX;
/** 2×2 supersampling: enough to keep the strokes clean, cheap at this size. */
const SAMPLES = 2;

// Matches `galleryBanner.color` in the manifest, so the card reads as one piece.
const BACKGROUND = [0x1e, 0x1e, 0x1e];
const FOREGROUND = [0xe8, 0xe8, 0xe8];

const STROKE = 1.6;

/** The two slabs and their indicator lines, in SVG coordinates. */
const SLABS = [
  { x: 6, y: 2.5, w: 5, h: 19, r: 1 },
  { x: 13, y: 2.5, w: 5, h: 19, r: 1 },
];
const LINES = [
  { x1: 6, y1: 9, x2: 11, y2: 9 },
  { x1: 13, y1: 15, x2: 18, y2: 15 },
];

/** Signed distance from a point to a rounded rectangle's outline. */
function distanceToRoundedRectOutline(px, py, rect) {
  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  const cx = rect.x + halfW;
  const cy = rect.y + halfH;

  // Fold into one quadrant; the shape is symmetric about both axes.
  const dx = Math.abs(px - cx) - (halfW - rect.r);
  const dy = Math.abs(py - cy) - (halfH - rect.r);

  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  // Distance to the *outline*, not the filled shape, so the stroke is hollow.
  return Math.abs(outside + inside - rect.r);
}

/** Distance from a point to a line segment. */
function distanceToSegment(px, py, line) {
  const vx = line.x2 - line.x1;
  const vy = line.y2 - line.y1;
  const lengthSquared = vx * vx + vy * vy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - line.x1) * vx + (py - line.y1) * vy) / lengthSquared));
  return Math.hypot(px - (line.x1 + t * vx), py - (line.y1 + t * vy));
}

/** Coverage at one point, in 0..1, from the nearest stroke. */
function coverageAt(px, py) {
  let nearest = Infinity;
  for (const slab of SLABS) {
    nearest = Math.min(nearest, distanceToRoundedRectOutline(px, py, slab));
  }
  for (const line of LINES) {
    nearest = Math.min(nearest, distanceToSegment(px, py, line));
  }
  return nearest <= STROKE / 2 ? 1 : 0;
}

/** Raw RGBA rows, each prefixed with PNG filter type 0. */
function render() {
  const stride = SIZE * 4 + 1;
  const raw = Buffer.alloc(stride * SIZE);

  for (let y = 0; y < SIZE; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;

    for (let x = 0; x < SIZE; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = (x + (sx + 0.5) / SAMPLES) / SCALE;
          const py = (y + (sy + 0.5) / SAMPLES) / SCALE;
          hits += coverageAt(px, py);
        }
      }
      const alpha = hits / (SAMPLES * SAMPLES);

      const at = rowStart + 1 + x * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        // Composited against the background rather than left transparent: the
        // marketplace renders the icon on a light card, and a bare light mark
        // would vanish into it.
        raw[at + channel] = Math.round(
          BACKGROUND[channel] * (1 - alpha) + FOREGROUND[channel] * alpha,
        );
      }
      raw[at + 3] = 0xff;
    }
  }
  return raw;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', 'packages', 'extension', 'media', 'icon.png');
const bytes = png(render());
writeFileSync(target, bytes);
process.stdout.write(`wrote ${target} (${String(bytes.length)} bytes, ${String(SIZE)}px)\n`);
