#!/usr/bin/env node
// Builds the atelier samples: samples/cauldron.mp4, scrying-orb.mp4,
// spellbook.mp4, wisps.mp4 and bonfire.mp4. The first four are the scenes of
// Monet's first design, drawn here frame by frame; the bonfire is wide, the
// shape of the bottom strip.
//
//   node scripts/make-atelier-samples.mjs [out-dir] [only-this-name]
//
// Each clip loops without a seam: its last second fades into its first.
// Needs ffmpeg on PATH.

import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.argv[2] ?? join(ROOT, 'samples')
const ONLY = process.argv[3]
const FPS = 24
const FADE = 1

const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
const fract = v => v - Math.floor(v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const add = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sst = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const hash = n => fract(Math.sin(n * 12.9898 + 4.1414) * 43758.5453);
const h2 = (x, y) => hash(x * 127.1 + y * 311.7);
function vn(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const a = h2(ix, iy), b = h2(ix + 1, iy), c = h2(ix, iy + 1), d = h2(ix + 1, iy + 1);
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
const fbm = (x, y) => 0.5 * vn(x, y) + 0.25 * vn(x * 2.03 + 1.7, y * 2.03 + 9.2) + 0.125 * vn(x * 4.01 + 3.1, y * 4.01 + 5.3);
function stars(x, y, t) {
  const gx = Math.floor(x * 34), gy = Math.floor(y * 34), h = h2(gx, gy);
  return h < 0.982 ? 0 : 0.5 + 0.5 * Math.sin(t * 2.5 + h * 60);
}

// The scenes: x in [0, A] across, y in [0, 1] down, t in seconds; each returns [r, g, b] in 0..1.
function cauldron(x, y, t, A) {
  const cx = A / 2, dx = x - cx;
  let c = mix([0.06, 0.045, 0.1], [0.13, 0.07, 0.15], y);
  if (y < 0.5) c = add(c, [0.85, 0.8, 1], 0.55 * stars(x, y, t) * (1 - y * 1.6));
  c = add(c, [0.25, 0.9, 0.55], 0.22 * Math.exp(-(dx * dx / 0.09 + (y - 0.36) * (y - 0.36) / 0.03)));
  const st = fbm(dx * 5 + Math.sin(t * 0.7) * 0.4, y * 4 + t * 0.9) * sst(0.46, 0.1, y) * sst(0.3, 0.04, Math.abs(dx));
  c = mix(c, [0.5, 0.85, 0.68], clamp(st * 0.9));
  if (y > 0.68) {
    const n = fbm(dx * 9, y * 7 - t * 5), m = sst(0.34, 0.12, Math.abs(dx));
    const f = clamp((n * 1.5 + (y - 0.68) * 2 - 0.75) * m * 2.2);
    if (f > 0) {
      const fc = f < 0.5 ? mix([0.45, 0.04, 0.02], [1, 0.45, 0.08], f * 2) : mix([1, 0.45, 0.08], [1, 0.92, 0.55], (f - 0.5) * 2);
      c = mix(c, fc, clamp(f * 1.6));
    }
  }
  if (y > 0.93 && Math.abs(dx) < 0.3) c = mix([0.18, 0.09, 0.05], [0.32, 0.16, 0.07], fract(x * 9) * 0.6);
  if (y > 0.78 && y < 0.9 && (Math.abs(dx - 0.17) < 0.028 || Math.abs(dx + 0.17) < 0.028)) c = [0.12, 0.11, 0.15];
  const e = (dx / 0.3) ** 2 + ((y - 0.6) / 0.24) ** 2;
  if (e < 1 && y > 0.4) {
    let pc = mix([0.07, 0.065, 0.09], [0.3, 0.28, 0.36], 0.55 + 0.45 * clamp(0.5 - dx / 0.6));
    const fl = 0.6 + 0.4 * Math.sin(t * 9) * Math.sin(t * 5.3);
    pc = add(pc, [1, 0.45, 0.1], 0.35 * fl * sst(0.66, 0.84, y));
    pc = add(pc, [0.4, 0.35, 0.5], 0.25 * sst(0.78, 1, e) * (dx < 0 ? 1 : 0.3));
    c = pc;
  }
  if ((dx / 0.33) ** 2 + ((y - 0.4) / 0.07) ** 2 < 1) c = mix([0.22, 0.2, 0.27], [0.5, 0.47, 0.57], clamp(0.6 - dx));
  if ((dx / 0.28) ** 2 + ((y - 0.4) / 0.045) ** 2 < 1) c = mix([0.12, 0.6, 0.38], [0.6, 1, 0.75], fbm(x * 14 + t * 1.2, y * 40 - t * 0.8));
  for (let i = 0; i < 7; i++) {
    const p = fract(t * 0.42 + hash(i + 1));
    const bx = cx + (hash(i + 7) - 0.5) * 0.42 + 0.025 * Math.sin(t * 3 + i), by = 0.4 - p * 0.36;
    const r = 0.014 + 0.03 * (1 - p), d = Math.hypot(x - bx, y - by);
    if (d < r) c = mix(c, [0.6, 1, 0.78], (0.35 + 0.65 * sst(r * 0.45, r, d)) * (1 - p * 0.6));
  }
  return c;
}

function orb(x, y, t, A) {
  const cx = A / 2, oy = 0.42, R = 0.29, dx = x - cx, dy = y - oy, d = Math.hypot(dx, dy);
  let c = mix([0.03, 0.035, 0.09], [0.07, 0.05, 0.13], y);
  c = add(c, [0.8, 0.85, 1], 0.5 * stars(x + 3, y, t));
  const pulse = 0.75 + 0.25 * Math.sin(t * 1.6);
  if (d > R) c = add(c, [0.45, 0.3, 0.95], 0.5 * pulse * Math.exp(-(((d - R) / 0.07) ** 2)));
  if (y > 0.9) { c = mix([0.1, 0.06, 0.05], [0.16, 0.09, 0.06], fract(x * 3 + y * 0.5) * 0.4); c = add(c, [0.5, 0.35, 0.9], 0.3 * pulse * Math.exp(-(dx * dx) / 0.04)); }
  if (y > 0.66 && y < 0.9) {
    const hw = 0.08 + (y - 0.66) * 0.55;
    if (Math.abs(dx) < hw) {
      c = mix([0.25, 0.16, 0.06], [0.88, 0.68, 0.32], 0.55 + 0.45 * clamp(0.5 - dx / (hw * 2)));
      if (Math.abs(y - 0.79) < 0.014) c = mix(c, [1, 0.88, 0.55], 0.5);
    }
  }
  if (y > 0.86 && y < 0.92 && Math.abs(dx) < 0.25) c = mix([0.3, 0.2, 0.08], [0.82, 0.62, 0.3], clamp(0.6 - dx));
  if (d < R) {
    const rr = d / R, ang = t * 0.9 * (1 - rr * rr) + (1 - rr) * 1.5, ca = Math.cos(ang), sa = Math.sin(ang);
    const u = (dx * ca - dy * sa) / R, v = (dx * sa + dy * ca) / R;
    const n = fbm(u * 2.6 + 5, v * 2.6 + t * 0.25), n2 = fbm(u * 5 - t * 0.3, v * 5 + 2);
    let oc = n < 0.42 ? mix([0.1, 0.03, 0.22], [0.55, 0.15, 0.6], n / 0.42) : mix([0.55, 0.15, 0.6], [0.45, 0.9, 1], clamp((n - 0.42) / 0.3));
    oc = add(oc, [0.9, 0.6, 1], 0.4 * sst(0.5, 0.75, n2));
    oc = mix(oc, [0.02, 0.01, 0.06], sst(0.7, 1, rr) * 0.5);
    oc = add(oc, [0.55, 0.65, 1], 0.35 * sst(0.88, 1, rr));
    oc = mix(oc, [1, 1, 1], sst(0.065, 0.02, Math.hypot(dx + 0.1, dy + 0.11)) * 0.9);
    oc = mix(oc, [1, 1, 1], sst(0.03, 0.01, Math.hypot(dx - 0.12, dy - 0.13)) * 0.6);
    c = oc;
  }
  return c;
}

function rune(seed, gx, gy) {
  if (Math.abs(gx) < 0.009 && Math.abs(gy) < 0.03) return true;
  const k = Math.floor(hash(seed) * 3) - 1;
  if (Math.abs(gy - k * 0.016) < 0.008 && gx > 0 && gx < 0.024) return true;
  if (hash(seed + 0.5) > 0.5 && Math.abs(gy + gx * 0.9 + 0.012) < 0.008 && gx < 0 && gx > -0.024) return true;
  return false;
}

function book(x, y, t, A) {
  const cx = A / 2, dx = x - cx, ax = Math.abs(dx), PW = 0.4, PER = 6;
  const ph = fract(t / PER), cyc = Math.floor(t / PER), flipping = ph > 0.84;
  let c = mix([0.11, 0.07, 0.06], [0.05, 0.03, 0.03], y);
  c = add(c, [1, 0.7, 0.35], 0.14 * Math.exp(-((dx + 0.5) ** 2 + (y - 0.05) ** 2) / 0.25));
  if (ax < PW + 0.035 && y > 0.24 && y < 0.9) c = mix([0.28, 0.08, 0.07], [0.42, 0.14, 0.1], clamp(0.5 - dx));
  const sag = 0.025 * Math.sin(Math.PI * clamp(ax / PW));
  const top = 0.28 - sag, bot = 0.86 - sag;
  if (ax < PW && y > top && y < bot) {
    let pc = mix([0.55, 0.45, 0.32], [0.91, 0.84, 0.67], sst(0, 0.07, ax));
    pc = mix(pc, [0.75, 0.66, 0.48], sst(PW - 0.05, PW, ax) * 0.6);
    const li = Math.floor((y - 0.33) / 0.075), ly = 0.33 + li * 0.075 + 0.035;
    if (dx < 0) {
      if (li >= 0 && li < 7 && Math.abs(y - ly) < 0.012) {
        const w = 0.06 + hash(li + cyc * 13) * 0.14;
        if (x > cx - PW + 0.05 && x < cx - 0.05 - w * 0.4 && fract((x - cx) * 14 + hash(li)) < 0.82) pc = mix(pc, [0.3, 0.2, 0.14], 0.85);
      }
    } else if (!flipping) {
      const total = 35, wp = clamp(ph / 0.8) * total, gj = Math.floor((dx - 0.06) / 0.062);
      if (li >= 0 && li < 7 && gj >= 0 && gj < 5) {
        const idx = li * 5 + gj;
        if (idx < wp && rune(idx + cyc * 35, dx - (0.06 + gj * 0.062 + 0.031), y - ly)) {
          const glow = Math.exp(-(wp - idx) * 0.35);
          pc = mix(pc, mix([0.45, 0.25, 0.12], [0.35, 0.95, 1], glow), 0.9);
        }
      }
    }
    c = pc;
  }
  if (flipping) {
    const p = (ph - 0.84) / 0.16, ex = Math.cos(Math.PI * p) * PW, lift = Math.sin(Math.PI * p) * 0.08;
    if (dx > Math.min(0, ex) && dx < Math.max(0, ex) && y > top - lift && y < bot - lift) {
      c = mix([0.6, 0.52, 0.38], [0.95, 0.88, 0.7], 0.35 + 0.65 * Math.abs(Math.cos(Math.PI * p)));
      if (Math.abs(dx - ex) < 0.012) c = mix(c, [0.4, 0.32, 0.22], 0.6);
    }
  }
  for (let i = 0; i < 6; i++) {
    const p = fract(t * 0.3 + hash(i + 20));
    const sx = cx + 0.05 + hash(i + 30) * 0.34 + 0.02 * Math.sin(t * 2 + i), sy = 0.55 - p * 0.5;
    const d = Math.hypot(x - sx, y - sy);
    if (d < 0.024) c = mix(c, [1, 0.86, 0.45], (1 - p) * sst(0.024, 0.006, d));
  }
  return c;
}

function tree(c, x, y, dens, topMin, col, seed) {
  const i0 = Math.floor(x * dens);
  for (let i = i0 - 1; i <= i0 + 1; i++) {
    const tx = (i + 0.5 + (hash(i * 3.1 + seed) - 0.5) * 0.6) / dens, top = topMin + hash(i * 7.7 + seed) * 0.3;
    if (y < top) continue;
    const h = y - top, hw = h * 0.32 * (0.55 + 0.45 * fract(h * 9)) + 0.006;
    if (Math.abs(x - tx) < hw) return col;
  }
  return c;
}
const WISP = [[0.55, 1, 0.95], [0.75, 1, 0.6], [0.8, 0.6, 1], [1, 0.8, 0.45]];
function wisps(x, y, t, A) {
  let c = mix([0.015, 0.03, 0.07], [0.04, 0.11, 0.12], y);
  c = add(c, [0.85, 0.9, 1], 0.5 * stars(x + 7, y, t) * (1 - y));
  const mx = A * 0.8, my = 0.2, md = Math.hypot(x - mx, y - my);
  if (md > 0.075) c = add(c, [0.7, 0.8, 0.75], 0.2 * Math.exp(-(((md - 0.075) / 0.06) ** 2)));
  else { c = mix([0.85, 0.87, 0.75], [0.97, 0.97, 0.88], sst(0.075, 0.03, md)); if (Math.hypot(x - mx - 0.02, y - my + 0.01) < 0.02) c = mix(c, [0.72, 0.73, 0.64], 0.5); }
  c = tree(c, x, y, 7, 0.35, [0.04, 0.09, 0.1], 11);
  c = mix(c, [0.25, 0.4, 0.42], clamp(fbm(x * 3 + t * 0.12, y * 5) * sst(0.55, 0.85, y) * 0.55));
  for (let i = 0; i < 4; i++) {
    const fl = 0.75 + 0.25 * Math.sin(t * 8 + i * 3);
    for (let k = 0; k < 3; k++) {
      const tt = t - k * 0.14;
      const wx = A * (0.5 + 0.4 * Math.sin(tt * 0.33 * (1 + i * 0.23) + i * 2.1));
      const wy = 0.58 + 0.16 * Math.sin(tt * 0.51 * (1 + i * 0.17) + i * 1.3);
      const d2 = (x - wx) ** 2 + (y - wy) ** 2, r = 0.045 * (1 - k * 0.3);
      c = add(c, WISP[i], (k === 0 ? 1 : 0.35) * fl * Math.exp(-d2 / (r * r)));
      if (k === 0) c = add(c, WISP[i], 0.18 * fl * Math.exp(-d2 / 0.014));
    }
  }
  c = tree(c, x, y, 4, 0.15, [0.01, 0.025, 0.03], 3);
  if (y > 0.92 + 0.025 * Math.sin(x * 9)) c = [0.01, 0.02, 0.02];
  return c;
}

// A bonfire: a coiled sword thrust into a mound of ash, flames along its
// blade, and embers that rise into the dark. It is pixel art on the bottom
// strip's own grid, 30 x 16 mosaic pixels. The video is 60 x 32, small
// enough that Monet keeps its size, so each strip pixel averages 2 x 2 video
// pixels of one color, and the strip shows the art pixel for pixel.
function bonfirePixel(gx, gy, t) {
  const dx = gx + 0.5 - 15
  const flick = 0.8 + 0.2 * vn(t * 5.3, 1.7)
  // the dark, warm near the fire
  const glow = Math.exp(-(dx * dx / 60 + (gy - 11) ** 2 / 26))
  let c = add([0.02, 0.015, 0.02], [0.5, 0.17, 0.04], glow * flick)
  // embers rising into the dark
  for (let i = 0; i < 8; i++) {
    const span = 1.5 + hash(i) * 1.1
    const life = fract(t / span + hash(i + 9))
    const ex = Math.round(14.5 + (hash(i + 20) - 0.5) * 8 + 1.8 * Math.sin(t * 2.1 + i * 2.3) * life)
    const ey = Math.round(10 - life * 11)
    if (gx === ex && gy === ey) c = mix(c, [1, 0.6, 0.2], 1 - life * 0.8)
  }
  // the sword, lit from below: pommel, grip, guard and the coiled blade
  const lit = sst(3, 11, gy) * flick
  const steel = k => add(mix([0.12, 0.11, 0.13], [0.66, 0.64, 0.66], k), [0.9, 0.4, 0.1], 0.5 * lit)
  const blade = gx === 14 || gx === 15
  if (gy === 0 && blade) c = gx === 14 ? [0.62, 0.54, 0.4] : [0.38, 0.32, 0.25]
  if ((gy === 1 || gy === 2) && blade) c = gx === 14 ? [0.34, 0.2, 0.12] : [0.18, 0.1, 0.07]
  if (gy === 3 && gx >= 11 && gx <= 18) c = steel(gx === 11 || gx === 18 ? 0.3 : gx < 15 ? 0.9 : 0.55)
  if (gy >= 4 && gy <= 11 && blade) c = steel([[1, 0.4], [0.4, 0.05], [0.05, 0.75]][gy % 3][gx - 14])
  // the flames: each column's reach flickers; white only at the heart, red at the tips
  const side = Math.abs(dx)
  const sway = Math.round(1.2 * Math.sin(t * 2.3 + gy * 0.6))
  const tongue = 0.35 + 0.45 * vn((gx + sway) * 1.3, t * 5.5) + 0.35 * vn(gx * 2.7 + 7, t * 11)
  const reach = Math.max(0, 8.2 - side * 1.25) * tongue
  const up = 11 - gy
  if (up >= 0 && up < reach) {
    const f = (1 - up / reach) * (1 - (side / 7.5) ** 2)
    const gap = f < 0.35 && vn(gx * 1.4, gy * 0.9 + t * 9) < 0.35
    if (!gap && f > 0.04) {
      const fc = f > 0.8 ? [1, 0.94, 0.66] : f > 0.55 ? [1, 0.72, 0.22] : f > 0.3 ? [0.96, 0.42, 0.08] : [0.62, 0.13, 0.03]
      c = mix(c, fc, blade && f < 0.55 ? 0.55 : clamp(f * 4))
    }
  }
  // the mound of ash and bones, the fire's light on its top, embers in it
  const half = [4.5, 7.5, 10.5, 12.5][gy - 12]
  if (half && Math.abs(dx) < half) {
    const g = h2(gx, gy)
    c = mix([0.15, 0.13, 0.13], [0.33, 0.3, 0.29], g)
    c = add(c, [1, 0.42, 0.1], 0.32 * flick * sst(half, 0, Math.abs(dx)) * (gy === 12 ? 1 : gy === 13 ? 0.55 : 0.2))
    if ((gx === 9 && gy === 14) || (gx === 20 && gy === 13) || (gx === 22 && gy === 15) || (gx === 11 && gy === 15)) {
      c = [0.8, 0.74, 0.64]
    } else if (g > 0.84) {
      c = mix(c, [1, 0.5, 0.12], 0.45 + 0.4 * Math.sin(t * 4 + g * 40))
    }
  }
  return c
}

function bonfire(x, y, t, A) {
  return bonfirePixel(Math.floor((x / A) * 30), Math.floor(y * 16), t)
}

const SCENES = [
  { file: 'cauldron.mp4', scene: cauldron, seconds: 8 },
  { file: 'scrying-orb.mp4', scene: orb, seconds: 8 },
  { file: 'spellbook.mp4', scene: book, seconds: 12 },
  { file: 'wisps.mp4', scene: wisps, seconds: 10 },
  { file: 'bonfire.mp4', scene: bonfire, seconds: 8, width: 60, height: 32, crf: 8 },
]

function frameAt(scene, t, W, H) {
  const out = new Float32Array(W * H * 3)
  const A = W / H
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const c = scene(((i + 0.5) / W) * A, (j + 0.5) / H, t, A)
      const o = (j * W + i) * 3
      out[o] = c[0]
      out[o + 1] = c[1]
      out[o + 2] = c[2]
    }
  }
  return out
}

async function build({ file, scene, seconds, width: W = 240, height: H = 192, crf = 24 }) {
  const path = join(OUT, file)
  const ffmpeg = spawn(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  )
  const done = new Promise((resolve, reject) =>
    ffmpeg.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))),
  )
  const frames = seconds * FPS
  for (let f = 0; f < frames; f++) {
    const t = f / FPS
    const now = frameAt(scene, t, W, H)
    // The first second fades from the frame one loop later, so the end meets the start.
    const k = t < FADE ? t / FADE : 1
    const later = k < 1 ? frameAt(scene, t + seconds, W, H) : now
    const bytes = Buffer.alloc(W * H * 3)
    for (let i = 0; i < bytes.length; i++) {
      const v = later[i] + (now[i] - later[i]) * k
      bytes[i] = Math.round(clamp(v) * 255)
    }
    if (!ffmpeg.stdin.write(bytes)) await new Promise(r => ffmpeg.stdin.once('drain', r))
  }
  ffmpeg.stdin.end()
  await done
  console.log(`wrote ${path}`)
}

for (const one of SCENES) if (!ONLY || one.file.startsWith(ONLY)) await build(one)
