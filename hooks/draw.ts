// Turns one RGB frame into the cells of a Raster: each cell a glyph, a
// foreground and a background, packed as the Raster's `cells` want them.
// Pure code: no `$`, so the tests and the preview script can run it too.

type CellLook = 'half' | 'braille' | 'ascii'
type Fit = 'fit' | 'fill' | 'ambient'

/** The terminal's own color, as a Raster cell spells it. */
export const DEFAULT_COLOR = 0x01000000

/** Where the frame goes: the cells it takes and the part of the frame it shows. */
export type Layout = {
  columns: number
  rows: number
  cropX: number
  cropY: number
  cropW: number
  cropH: number
}

/**
 * Sizes the picture for a room of cells. A terminal cell is about twice as
 * tall as it is wide, so one cell holds a column of two square pixels.
 * `fit` shows the whole frame; `fill` uses the whole room and crops.
 */
export function fitLayout(
  room: { columns: number; rows: number },
  frame: { width: number; height: number },
  fit: Fit,
): Layout {
  const columns = Math.max(1, Math.floor(room.columns))
  const rows = Math.max(1, Math.floor(room.rows))
  const aspect = frame.width / frame.height
  const roomAspect = columns / (rows * 2)
  const full = { cropX: 0, cropY: 0, cropW: frame.width, cropH: frame.height }
  if (fit === 'fill') {
    if (aspect > roomAspect) {
      const cropW = frame.height * roomAspect
      return { columns, rows, ...full, cropX: (frame.width - cropW) / 2, cropW }
    }
    const cropH = frame.width / roomAspect
    return { columns, rows, ...full, cropY: (frame.height - cropH) / 2, cropH }
  }
  if (aspect > roomAspect) {
    return { columns, rows: Math.max(1, Math.min(rows, Math.round(columns / aspect / 2))), ...full }
  }
  return { columns: Math.max(1, Math.min(columns, Math.round(rows * 2 * aspect))), rows, ...full }
}

/** What one look needs for one layout and frame size, built once and reused. */
export type Sampler = {
  look: CellLook
  layout: Layout
  frameWidth: number
  gridX: number
  gridY: number
  xs: Int32Array
  ys: Int32Array
  sub: Float32Array
  words: Uint32Array
  /** Ambient: the whole frame, drawn over this dim copy at `inset` columns from the left. */
  front?: Sampler
  inset?: number
}

export function makeSampler(
  look: CellLook,
  layout: Layout,
  frame: { width: number; height: number },
): Sampler {
  const gridX = look === 'braille' ? layout.columns * 2 : layout.columns
  const gridY = look === 'braille' ? layout.rows * 4 : layout.rows * 2
  return {
    look,
    layout,
    frameWidth: frame.width,
    gridX,
    gridY,
    xs: spans(gridX, layout.cropX, layout.cropW, frame.width),
    ys: spans(gridY, layout.cropY, layout.cropH, frame.height),
    sub: new Float32Array(gridX * gridY * 3),
    words: new Uint32Array(layout.columns * layout.rows * 3),
  }
}

// For each of `count` steps across the crop: the first and the last + 1
// source pixel it averages.
function spans(count: number, start: number, length: number, size: number): Int32Array {
  const out = new Int32Array(count * 2)
  for (let i = 0; i < count; i++) {
    const a = start + (i * length) / count
    const b = start + ((i + 1) * length) / count
    const lo = Math.min(size - 1, Math.max(0, Math.floor(a)))
    const hi = Math.min(size, Math.max(lo + 1, Math.round(b)))
    out[i * 2] = lo
    out[i * 2 + 1] = hi
  }
  return out
}

// Averages the source pixels under each point of the sampler's grid.
function gather(s: Sampler, data: Uint8Array, offset: number): void {
  const { gridX, gridY, xs, ys, sub, frameWidth } = s
  for (let gy = 0; gy < gridY; gy++) {
    const y0 = ys[gy * 2]!
    const y1 = ys[gy * 2 + 1]!
    for (let gx = 0; gx < gridX; gx++) {
      const x0 = xs[gx * 2]!
      const x1 = xs[gx * 2 + 1]!
      let r = 0
      let g = 0
      let b = 0
      for (let y = y0; y < y1; y++) {
        let p = offset + (y * frameWidth + x0) * 3
        for (let x = x0; x < x1; x++, p += 3) {
          r += data[p]!
          g += data[p + 1]!
          b += data[p + 2]!
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const o = (gy * gridX + gx) * 3
      sub[o] = r / n
      sub[o + 1] = g / n
      sub[o + 2] = b / n
    }
  }
}

const pack = (r: number, g: number, b: number) =>
  ((Math.min(255, r) & 255) << 16) | ((Math.min(255, g) & 255) << 8) | (Math.min(255, b) & 255)

/** How light a color is, from 0 to 1, for channels from 0 to 255. */
export const luma = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

// Lifts a dark color so a glyph drawn in it still reads on a dark background.
function lifted(r: number, g: number, b: number): number {
  const top = Math.max(r, g, b)
  if (top <= 0) return pack(0, 0, 0)
  const k = Math.max(top, 160) / top
  return pack(r * k, g * k, b * k)
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
// Braille dots by row, then by column: ⠁⠈ ⠂⠐ ⠄⠠ ⡀⢀
const DOTS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80]
const RAMP = ' .:-=+*#%@'

/**
 * A picture as wide as the room in half-blocks: the whole frame in the middle,
 * at its own size, and a dim copy enlarged to fill the sides.
 */
export function makeAmbient(room: { columns: number; rows: number }, frame: { width: number; height: number }): Sampler {
  const front = fitLayout(room, frame, 'fit')
  const back = makeSampler('half', fitLayout({ columns: room.columns, rows: front.rows }, frame, 'fill'), frame)
  back.front = makeSampler('half', front, frame)
  back.inset = Math.floor((room.columns - front.columns) / 2)
  return back
}

const AMBIENT_LIGHT = 0.3
const dim = (c: number) =>
  pack(((c >> 16) & 255) * AMBIENT_LIGHT, ((c >> 8) & 255) * AMBIENT_LIGHT, (c & 255) * AMBIENT_LIGHT)

/** Draws one frame (`width * height` RGB pixels from `offset`) into the sampler's words. */
export function drawFrame(s: Sampler, data: Uint8Array, offset: number): Uint32Array {
  if (s.front && s.inset !== undefined) {
    const words = drawCells(s, data, offset)
    for (let i = 0; i < words.length; i += 3) {
      words[i + 1] = dim(words[i + 1]!)
      words[i + 2] = dim(words[i + 2]!)
    }
    const front = drawCells(s.front, data, offset)
    const { columns, rows } = s.front.layout
    for (let r = 0; r < rows; r++) {
      words.set(front.subarray(r * columns * 3, (r + 1) * columns * 3), (r * s.layout.columns + s.inset) * 3)
    }
    return words
  }
  return drawCells(s, data, offset)
}

function drawCells(s: Sampler, data: Uint8Array, offset: number): Uint32Array {
  gather(s, data, offset)
  const { look, layout, sub, words, gridX } = s
  const { columns, rows } = layout
  // Braille and ASCII show light as shape, so stretch the frame's light from
  // its darkest to its brightest point first.
  let low = 1
  let high = 0
  if (look !== 'half') {
    for (let i = 0; i < sub.length; i += 3) {
      const l = luma(sub[i]!, sub[i + 1]!, sub[i + 2]!)
      if (l < low) low = l
      if (l > high) high = l
    }
  }
  const span = Math.max(0.08, high - low)
  const level = (r: number, g: number, b: number) => (luma(r, g, b) - low) / span
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      const w = (cy * columns + cx) * 3
      if (look === 'half') {
        const top = (cy * 2 * gridX + cx) * 3
        const bot = top + gridX * 3
        words[w] = 0x2580
        words[w + 1] = pack(sub[top]!, sub[top + 1]!, sub[top + 2]!)
        words[w + 2] = pack(sub[bot]!, sub[bot + 1]!, sub[bot + 2]!)
      } else if (look === 'ascii') {
        const top = (cy * 2 * gridX + cx) * 3
        const bot = top + gridX * 3
        const r = (sub[top]! + sub[bot]!) / 2
        const g = (sub[top + 1]! + sub[bot + 1]!) / 2
        const b = (sub[top + 2]! + sub[bot + 2]!) / 2
        const ch = RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.floor(level(r, g, b) * RAMP.length)))]!
        words[w] = ch.charCodeAt(0)
        words[w + 1] = ch === ' ' ? DEFAULT_COLOR : lifted(r, g, b)
        words[w + 2] = DEFAULT_COLOR
      } else {
        let bits = 0
        let r = 0
        let g = 0
        let b = 0
        let on = 0
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const gx = cx * 2 + dx
            const gy = cy * 4 + dy
            const o = (gy * gridX + gx) * 3
            const threshold = 0.1 + (0.8 * (BAYER[(gy % 4) * 4 + (gx % 4)]! + 0.5)) / 16
            if (level(sub[o]!, sub[o + 1]!, sub[o + 2]!) > threshold) {
              bits |= DOTS[dy * 2 + dx]!
              r += sub[o]!
              g += sub[o + 1]!
              b += sub[o + 2]!
              on++
            }
          }
        }
        words[w] = bits === 0 ? 0x20 : 0x2800 + bits
        words[w + 1] = on === 0 ? DEFAULT_COLOR : lifted(r / on, g / on, b / on)
        words[w + 2] = DEFAULT_COLOR
      }
    }
  }
  return words
}

/** The cells of one frame, ready for a Raster or `$.ui.blit`. */
export function frameCells(s: Sampler, data: Uint8Array, offset: number): string {
  const words = drawFrame(s, data, offset)
  return new Uint8Array(words.buffer, words.byteOffset, words.byteLength).toBase64()
}
