#!/usr/bin/env node
// Builds samples/starry-night.mp4: Van Gogh's "The Starry Night" (1889, public
// domain) with a flowing sky, twinkling stars and a flickering cypress.
//
//   node scripts/make-starry-night.mjs [painting.jpg] [out.mp4]
//
// With no painting given, the script downloads a 1280 px copy from Wikimedia
// Commons. It needs ffmpeg on PATH and nothing else.

import { spawnSync, spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_URL =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/' +
  'Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg/' +
  '1280px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg'

const W = 320
const H = 254
const FPS = 24
const SECONDS = 8
const FRAMES = FPS * SECONDS
// The flow restarts this many times in one loop; a whole number keeps the
// loop seamless.
const FLOW_CYCLES = 4
// How far (in image widths) the sky drifts in one flow cycle.
const FLOW_REACH = 0.035

async function download(path) {
  const response = await fetch(SOURCE_URL, {
    headers: { 'user-agent': 'terminal-monet sample builder' },
  })
  if (!response.ok) throw new Error(`download failed: ${response.status}`)
  writeFileSync(path, Buffer.from(await response.arrayBuffer()))
  return path
}

function decode(path, width, height) {
  const ran = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-vf', `scale=${width}:${height}:flags=lanczos`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  )
  if (ran.status !== 0) throw new Error(`ffmpeg could not read ${path}: ${ran.stderr}`)
  return { width, height, data: new Float32Array(ran.stdout) }
}

async function encode(path, src) {
  const ffmpeg = spawn(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '24',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  )
  const done = new Promise((resolve, reject) =>
    ffmpeg.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))),
  )
  const field = flowField()
  for (let f = 0; f < FRAMES; f++) {
    const frame = render(src, field, f / FRAMES)
    if (!ffmpeg.stdin.write(frame)) await new Promise(r => ffmpeg.stdin.once('drain', r))
  }
  ffmpeg.stdin.end()
  await done
}

// ---------- the scene, in coordinates of 0..1 across and down ----------

// The swirls of the sky: centre, radius, strength (+ is counterclockwise).
const SWIRLS = [
  { x: 0.50, y: 0.33, r: 0.17, s: 1.0 },
  { x: 0.67, y: 0.47, r: 0.09, s: -0.9 },
  { x: 0.90, y: 0.17, r: 0.12, s: 0.5 },
]

// The stars and the moon: centre, glow radius.
const STARS = [
  [0.105, 0.045, 0.035], [0.232, 0.033, 0.025], [0.345, 0.042, 0.03],
  [0.412, 0.065, 0.028], [0.607, 0.082, 0.04], [0.236, 0.172, 0.04],
  [0.705, 0.232, 0.04], [0.326, 0.325, 0.03], [0.036, 0.45, 0.025],
  [0.13, 0.477, 0.035], [0.353, 0.527, 0.05], [0.9, 0.17, 0.09],
]

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const lerpTable = (table, x) => {
  for (let i = 1; i < table.length; i++) {
    const [x0, y0] = table[i - 1]
    const [x1, y1] = table[i]
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
  }
  return table[table.length - 1][1]
}

// The line where the sky meets the hills.
const HORIZON = [[0, 0.7], [0.4, 0.7], [0.55, 0.64], [0.75, 0.6], [0.88, 0.53], [1, 0.52]]
// The left and right edges of the cypress, top to bottom.
const CYPRESS_L = [[0.05, 0.19], [0.3, 0.16], [0.6, 0.13], [1, 0.12]]
const CYPRESS_R = [[0.05, 0.2], [0.3, 0.26], [0.6, 0.36], [0.8, 0.42], [1, 0.47]]

function cypressMask(x, y) {
  if (y < 0.04) return 0
  const l = lerpTable(CYPRESS_L, y)
  const r = lerpTable(CYPRESS_R, y)
  return smooth(l - 0.02, l + 0.01, x) * (1 - smooth(r - 0.01, r + 0.02, x))
}

// Per pixel: the drift of the sky, the rise of the cypress, the star glow.
function flowField() {
  const n = W * H
  const fx = new Float32Array(n)
  const fy = new Float32Array(n)
  const glow = new Float32Array(n * STARS.length)
  const aspect = W / H
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = (i + 0.5) / W
      const y = (j + 0.5) / H
      const k = j * W + i
      const sky = 1 - smooth(-0.03, 0.02, y - lerpTable(HORIZON, x))
      const tree = cypressMask(x, y)
      let vx = 0
      let vy = 0
      // The long wave that runs left to right through the middle of the sky.
      vx += 0.55 * smooth(0.15, 0.3, y) * (1 - smooth(0.55, 0.68, y))
      for (const s of SWIRLS) {
        const dx = (x - s.x) * aspect
        const dy = y - s.y
        const d = Math.hypot(dx, dy) + 1e-6
        const fall = Math.exp(-((d / s.r) ** 2))
        vx += (-dy / d) * s.s * fall
        vy += (dx / d) * s.s * fall
      }
      fx[k] = vx * sky * (1 - tree)
      fy[k] = vy * sky * (1 - tree) - 0.6 * tree
      for (let m = 0; m < STARS.length; m++) {
        const [sx, sy, sr] = STARS[m]
        const d = Math.hypot((x - sx) * aspect, y - sy)
        glow[k * STARS.length + m] = Math.exp(-((d / sr) ** 2))
      }
    }
  }
  return { fx, fy, glow }
}

function sample(src, x, y, out, o) {
  const { width, height, data } = src
  x = Math.min(width - 1.001, Math.max(0, x))
  y = Math.min(height - 1.001, Math.max(0, y))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const ax = x - x0
  const ay = y - y0
  const a = (y0 * width + x0) * 3
  const b = a + 3
  const c = a + width * 3
  const d = c + 3
  for (let ch = 0; ch < 3; ch++) {
    const top = data[a + ch] + (data[b + ch] - data[a + ch]) * ax
    const bot = data[c + ch] + (data[d + ch] - data[c + ch]) * ax
    out[o + ch] = top + (bot - top) * ay
  }
}

function render(src, field, t) {
  const frame = Buffer.alloc(W * H * 3)
  const p0 = (t * FLOW_CYCLES) % 1
  const p1 = (p0 + 0.5) % 1
  const mixB = Math.abs(0.5 - p0) / 0.5
  const reach = FLOW_REACH * W
  const twinkle = STARS.map((_, m) => 1 + 0.35 * Math.sin(2 * Math.PI * (t * (2 + (m % 3)) + m * 0.37)))
  const a = new Float32Array(3)
  const b = new Float32Array(3)
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i
      const vx = field.fx[k] * reach
      const vy = field.fy[k] * reach * 0.6
      sample(src, i - vx * p0, j - vy * p0, a, 0)
      sample(src, i - vx * p1, j - vy * p1, b, 0)
      let light = 1
      for (let m = 0; m < STARS.length; m++) {
        light += (twinkle[m] - 1) * field.glow[k * STARS.length + m]
      }
      for (let ch = 0; ch < 3; ch++) {
        const v = (a[ch] + (b[ch] - a[ch]) * mixB) * light
        frame[k * 3 + ch] = v > 255 ? 255 : v < 0 ? 0 : v
      }
    }
  }
  return frame
}

const args = process.argv.slice(2)
const out = args[1] ?? join(ROOT, 'samples', 'starry-night.mp4')
const work = mkdtempSync(join(tmpdir(), 'monet-starry-'))

try {
  const painting = args[0] ?? (await download(join(work, 'starry.jpg')))
  const src = decode(painting, W, H)
  await encode(out, src)
  console.log(`wrote ${out}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
