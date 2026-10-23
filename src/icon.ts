// Draws the menu bar monocle as a PNG with no dependencies.
// The rim is the progress ring. Output is a macOS "template" image: black with
// alpha, which the system recolours for light and dark menu bars. Colour (the
// orange "needs you" dot in the mockup) needs a non-template image; that is for
// the native app. Here the badge is a shape: filled dot = needs you, ring = failing.

import * as zlib from 'node:zlib';

export type Badge = 'none' | 'attention' | 'failing' | 'done' | 'idle';

type Pt = [number, number];

// Geometry in the 18-unit glyph space. Menu bar version: lens and sheen only. The chain
// and eyelet from the app icon turn to noise at 18pt, so they are left out here.
const LENS: Pt = [9, 9];
const LENS_R = 6.3;
const RIM_W = 1.7;
const SHEEN_R = 3.9;
const SHEEN_W = 1.25;
const PROG_R = 3.6;
const PROG_W = 1.9;
const BADGE: Pt = [15, 3.1];

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Angle clockwise from 12 o'clock, 0..1 */
function turn(p: Pt): number {
  let a = Math.atan2(p[0] - LENS[0], -(p[1] - LENS[1])) / (2 * Math.PI);
  return a < 0 ? a + 1 : a;
}

/** Alpha 0..1 at a point in glyph space. */
function sample(p: Pt, pct: number, badge: Badge): number {
  let alpha = 0;
  const d = Math.hypot(p[0] - LENS[0], p[1] - LENS[1]);
  const ang = turn(p);
  // The rim is always solid, so the icon is as crisp as the system icons beside it
  // (a half-transparent rim read as greyed out). Progress fills the lens instead.
  if (Math.abs(d - LENS_R) <= RIM_W / 2) alpha = 1;
  const inProgress = badge !== 'done' && pct > 0 && pct < 1;
  if (inProgress && Math.abs(d - PROG_R) <= PROG_W / 2 && ang <= pct) alpha = 1;
  // Glass sheen, upper left, when there is no progress to show.
  if (badge !== 'done' && !inProgress && Math.abs(d - SHEEN_R) <= SHEEN_W / 2 && ang >= 0.72 && ang <= 0.9) alpha = 1;
  if (badge === 'done') {
    const tick: Pt[] = [[6.2, 9.2], [8.2, 11.2], [11.9, 7.2]];
    if (segDist(p, tick[0] as Pt, tick[1] as Pt) <= 0.7 || segDist(p, tick[1] as Pt, tick[2] as Pt) <= 0.7) alpha = 1;
  }
  if (badge === 'attention' || badge === 'failing') {
    const db = Math.hypot(p[0] - BADGE[0], p[1] - BADGE[1]);
    if (db <= 3.2) alpha = 0; // knockout so the badge reads as separate
    if (badge === 'attention' && db <= 2.2) alpha = 1;
    if (badge === 'failing' && Math.abs(db - 1.7) <= 0.55) alpha = 1;
  }
  return alpha;
}

export function renderMonocle(pct: number, badge: Badge = 'none', size = 36): Buffer {
  const scale = size / 18;
  const ss = 4; // supersampling per axis
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          sum += sample([(x + (sx + 0.5) / ss) / scale, (y + (sy + 0.5) / ss) / scale], pct, badge);
        }
      }
      const a = Math.round((sum / (ss * ss)) * 255);
      const o = row + 1 + x * 4;
      raw[o] = 0;
      raw[o + 1] = 0;
      raw[o + 2] = 0;
      raw[o + 3] = a;
    }
  }
  return encodePng(size, size, raw);
}

// ---------- minimal PNG encoder ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(w: number, h: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    // 144 dpi: macOS reads a 36px image as 18pt, i.e. a Retina menu bar icon, not a 36pt one.
    chunk('pHYs', Buffer.from([0, 0, 0x16, 0x25, 0, 0, 0x16, 0x25, 1])),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
