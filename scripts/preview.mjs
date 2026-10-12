#!/usr/bin/env node
// Plays a clip the way Monet draws it, right in this terminal, without
// Claude Code. Use it to see how a video looks, or how your terminal shows
// the mosaic. Press Ctrl+C to stop.
//
//   node scripts/preview.mjs <video> [--look half|braille|ascii] [--fps 12]
//                                    [--columns 60] [--rows 20] [--fit fit|fill]
//   node scripts/preview.mjs <video> --html frame.html [--at 2.5]
//
// --html writes one frame (at --at seconds) as a web page instead.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

register('./ts-resolve.mjs', import.meta.url)
const { DEFAULT_COLOR, drawFrame, fitLayout, makeSampler } = await import('../hooks/draw.ts')
const lib = await import('../hooks/library.ts')

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    look: { type: 'string', default: 'half' },
    fps: { type: 'string', default: '12' },
    columns: { type: 'string', default: String(Math.min(80, process.stdout.columns || 80)) },
    rows: { type: 'string', default: String(Math.max(4, (process.stdout.rows || 24) - 2)) },
    fit: { type: 'string', default: 'fit' },
    html: { type: 'string' },
    at: { type: 'string', default: '0' },
  },
})

const video = positionals[0] && resolve(positionals[0])
if (!video) {
  console.error('Usage: node scripts/preview.mjs <video> [--look half|braille|ascii] [--fps 12]')
  process.exit(2)
}

const fps = Number(values.fps)
const work = mkdtempSync(join(tmpdir(), 'monet-preview-'))
const places = lib.placesFrom(work, work, process.platform === 'win32', work)
const clip = { id: 'preview', name: 'preview', file: video, isSample: false }

function run(argv) {
  const ran = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (ran.error) throw new Error(`${argv[0]} did not start: ${ran.error.message}. Is ffmpeg installed?`)
  if (ran.status !== 0) throw new Error(lib.lastLine(ran.stderr) || `${argv[0]} exited ${ran.status}`)
  return ran.stdout
}

const stat = statSync(video)
const meta = lib.metaFrom(run(lib.ffprobeArgv(video)), { path: video, size: stat.size, mtimeMs: stat.mtimeMs }, fps)
const pieceDir = lib.clipDir(places, clip, fps)
mkdirSync(pieceDir, { recursive: true })

const loaded = new Map()
function piece(n) {
  if (!loaded.has(n)) {
    run(lib.pieceArgv(places, clip, meta, n))
    loaded.clear()
    loaded.set(n, new Uint8Array(readFileSync(lib.piecePath(places, clip, meta, n))))
  }
  return loaded.get(n)
}

const room = { columns: Number(values.columns), rows: Number(values.rows) }
const layout = fitLayout(room, meta, values.fit)
const sampler = makeSampler(values.look, layout, meta)
const frameBytes = meta.width * meta.height * 3

function words(frame) {
  const n = lib.pieceOf(meta, frame)
  const data = piece(n)
  const offset = (frame - n * meta.framesPerPiece) * frameBytes
  if (offset + frameBytes > data.length) return null
  return drawFrame(sampler, data, offset)
}

const hex = c => `#${c.toString(16).padStart(6, '0')}`
const sgr = (c, layer) =>
  c === DEFAULT_COLOR ? `\x1b[${layer === 38 ? 39 : 49}m` : `\x1b[${layer};2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}m`

function ansi(w) {
  let out = ''
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.columns; c++) {
      const i = (r * layout.columns + c) * 3
      out += sgr(w[i + 1], 38) + sgr(w[i + 2], 48) + String.fromCodePoint(w[i])
    }
    out += '\x1b[0m\n'
  }
  return out
}

function html(w) {
  let rows = ''
  for (let r = 0; r < layout.rows; r++) {
    let line = ''
    for (let c = 0; c < layout.columns; c++) {
      const i = (r * layout.columns + c) * 3
      const fg = w[i + 1] === DEFAULT_COLOR ? 'inherit' : hex(w[i + 1])
      const bg = w[i + 2] === DEFAULT_COLOR ? 'transparent' : hex(w[i + 2])
      const ch = String.fromCodePoint(w[i]).replace('&', '&amp;').replace('<', '&lt;')
      line += `<span style="color:${fg};background:${bg}">${ch}</span>`
    }
    rows += `${line}\n`
  }
  return `<!doctype html><meta charset="utf-8"><title>Monet preview</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Ubuntu+Mono&display=swap">
<body style="margin:0;padding:16px;background:#1b1a20;color:#dcd9e2">
<pre style="font:16px/1 'Ubuntu Mono','DejaVu Sans Mono',monospace;margin:0">${rows}</pre></body>`
}

try {
  if (values.html) {
    const frame = Math.min(meta.totalFrames - 1, Math.round(Number(values.at) * fps))
    writeFileSync(values.html, html(words(frame) ?? words(0)))
    console.log(`wrote ${values.html}: ${layout.columns}×${layout.rows} cells, ${values.look}`)
  } else {
    let frame = 0
    let stop = false
    process.on('SIGINT', () => (stop = true))
    process.stdout.write('\x1b[?25l\x1b[2J')
    // Each loop of the clip keeps its own time, so every loop plays at the same speed.
    let started = Date.now()
    while (!stop) {
      const w = words(frame)
      if (!w || frame >= meta.totalFrames) {
        frame = 0
        started = Date.now()
        continue
      }
      process.stdout.write(`\x1b[H${ansi(w)}${layout.columns}×${layout.rows} cells · ${values.look} · ${fps} fps · Ctrl+C stops`)
      frame += 1
      const due = started + (frame * 1000) / fps
      await new Promise(r => setTimeout(r, Math.max(0, due - Date.now())))
    }
    process.stdout.write('\x1b[0m\x1b[?25h\n')
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
