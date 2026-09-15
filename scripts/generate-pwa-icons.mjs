/**
 * Generates the PWA icon set under `public/icons/` from scratch.
 *
 * No third-party image is downloaded or redistributed: every pixel here is drawn by this
 * script from a handful of analytic shapes (a rounded square, a half-disc, three bars and a
 * clapper disc) that read as a ringside bell — the same glyph the app header uses. The PNGs
 * are encoded by hand (IHDR/IDAT/IEND + a CRC-32 table + `zlib.deflateSync`) so the project
 * needs no image dependency at build time.
 *
 * Run with `node scripts/generate-pwa-icons.mjs`. The output is deterministic, so the
 * committed files are reproducible byte-for-byte and re-running never dirties the tree.
 *
 * The brand red is the resolved `--primary` from `app/globals.css` (`hsl(0 84% 55%)`), which
 * is also the manifest `theme_color` (requirement 11.10) — `app/pwa-assets.test.ts` asserts
 * the three stay in lockstep.
 *
 * Requirements: 11.1, 11.10
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'public', 'icons')

/** The resolved `--primary` red, `hsl(0 84% 55%)`. Keep in step with `app/globals.css`. */
const RED = [0xed, 0x2c, 0x2c]
/** A slightly deeper red for the bottom of the plate's vertical gradient. */
const RED_DEEP = [0xc0, 0x1d, 0x1d]
const WHITE = [0xff, 0xff, 0xff]

// --------------------------------------------------------------------------------------
// PNG encoding
// --------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** Encodes an RGBA pixel buffer (`size * size * 4`) as a PNG. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // One filter byte (0 = None) per scanline, then the raw row.
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --------------------------------------------------------------------------------------
// Shapes, in normalised [0, 1] coordinates
// --------------------------------------------------------------------------------------

/** Inside a rounded rectangle? */
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

function inDisc(x, y, cx, cy, r) {
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/**
 * The bell glyph, centred in a `[0,1]²` box: a hanging loop, a domed body on a flared rim,
 * and the clapper swinging below it.
 */
function inBell(x, y) {
  // Hanging loop above the dome (an annulus, so the icon reads at 192 px too).
  const loopDx = x - 0.5
  const loopDy = y - 0.245
  const loopR2 = loopDx * loopDx + loopDy * loopDy
  if (loopR2 <= 0.055 * 0.055 && loopR2 >= 0.028 * 0.028 && y <= 0.275) return true

  // Domed body: the upper half of a disc, closed off by a straight waist.
  if (y >= 0.27 && y <= 0.565 && inDisc(x, y, 0.5, 0.565, 0.215)) return true
  // Waist between dome and rim.
  if (x >= 0.285 && x <= 0.715 && y > 0.565 && y <= 0.625) return true
  // Flared rim.
  if (inRoundedRect(x, y, 0.235, 0.625, 0.765, 0.7, 0.032)) return true
  // Clapper.
  if (inDisc(x, y, 0.5, 0.775, 0.062)) return true
  return false
}

// --------------------------------------------------------------------------------------
// Rasterisation
// --------------------------------------------------------------------------------------

const SAMPLES = 4 // 4x4 supersampling — enough anti-aliasing at 192 px.

/**
 * Draws one icon.
 *
 * @param size    Pixel width and height.
 * @param maskable When true the red plate bleeds to every edge and the glyph shrinks into
 *                 the 80 % safe zone, so a launcher may crop the icon to any shape
 *                 (requirement 11.1's maskable entry). Otherwise the plate is a rounded
 *                 square on transparency.
 */
function drawIcon(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4)
  // A maskable icon must survive a circular crop, so its glyph occupies less of the canvas.
  const glyphScale = maskable ? 0.6 : 0.78

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let plate = 0
      let glyph = 0

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + (sx + 0.5) / SAMPLES) / size
          const y = (py + (sy + 0.5) / SAMPLES) / size

          const onPlate = maskable ? true : inRoundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)
          if (onPlate) plate += 1

          // Map the pixel into the glyph's own box before testing it.
          const gx = (x - 0.5) / glyphScale + 0.5
          const gy = (y - 0.5) / glyphScale + 0.5
          if (onPlate && gx >= 0 && gx <= 1 && gy >= 0 && gy <= 1 && inBell(gx, gy)) glyph += 1
        }
      }

      const total = SAMPLES * SAMPLES
      const plateAlpha = plate / total
      const glyphAlpha = glyph / total

      // Vertical gradient across the plate keeps a 512 px icon from looking flat.
      const t = py / (size - 1)
      const base = [0, 1, 2].map((i) => Math.round(RED[i] + (RED_DEEP[i] - RED[i]) * t))
      // Composite the white glyph over the plate, then the plate over transparency.
      const colour = [0, 1, 2].map((i) =>
        Math.round(base[i] * (1 - glyphAlpha) + WHITE[i] * glyphAlpha)
      )

      const offset = (py * size + px) * 4
      rgba[offset] = colour[0]
      rgba[offset + 1] = colour[1]
      rgba[offset + 2] = colour[2]
      rgba[offset + 3] = Math.round(plateAlpha * 255)
    }
  }

  return encodePng(size, rgba)
}

// --------------------------------------------------------------------------------------

const TARGETS = [
  // Manifest entries (requirement 11.1).
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'maskable-512.png', size: 512, maskable: true },
  // `apple-touch-icon` (requirement 11.2). iOS ignores transparency and squares the image,
  // so the maskable full-bleed plate is the right source for it.
  { file: 'apple-touch-icon.png', size: 180, maskable: true },
]

mkdirSync(OUT_DIR, { recursive: true })
for (const { file, size, maskable } of TARGETS) {
  const png = drawIcon(size, maskable)
  writeFileSync(path.join(OUT_DIR, file), png)
  console.log(`wrote public/icons/${file} (${size}x${size}, ${png.length} bytes)`)
}
