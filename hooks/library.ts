// The clips: where they are, what Monet keeps about them, and the ffmpeg
// commands that turn them into small frames. Pure code: register.tsx makes
// every call on `$` (the engine allows `$` only in the hooks module itself).
//
// A clip is converted one piece (about 20 seconds) at a time, only when that
// piece is about to play. So a long video costs no more disk than the pieces
// played, and the cache stays under the limit in the settings.

import type { MonetClip } from '../types'

const MEDIA = /\.(mp4|m4v|mov|mkv|webm|avi|gif|apng|png|jpe?g|webp)$/i
const STILL = /\.(png|jpe?g|webp)$/i

// The mosaic frames: never more than this many pixels across or down. A pane
// is rarely wider than 96 cells, and a braille cell needs 2 pixels across.
const MOSAIC_W = 96
const MOSAIC_H = 128
// The real-pixel frames for kitty and Ghostty.
const PIXELS_W = 320
// One piece must stay under the 4 MiB that one `$.fs.read` takes.
const PIECE_BYTES = 3.5 * 1024 * 1024
const META_VERSION = 2

export type Places = {
  /** Where the person puts videos. */
  folder: string
  /** Where Monet keeps the converted frames: `<Claude config>/monet/.cache`. */
  cache: string
  /** Claude Code's config folder, `~/.claude`. */
  config: string
  /** The folder as the pane shows it, `~` for the home folder. */
  shown: string
  isWindows: boolean
}

const slashes = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '')

/** The clip folder in plain sight, where a person drags videos; the cache under Claude's config. */
export function placesFrom(home: string, configDir: string | undefined, isWindows: boolean, folderPath: string): Places {
  const folder = slashes(folderPath.replace(/^~(?=$|[\\/])/, home))
  const homeSlash = slashes(home)
  const shown = homeSlash && folder.startsWith(`${homeSlash}/`) ? `~${folder.slice(homeSlash.length)}` : folder
  const config = slashes(configDir ?? `${home}/.claude`)
  return { folder, cache: `${config}/monet/.cache`, config, shown, isWindows }
}

export const FOLDER_README = `Drop videos, GIFs or pictures in this folder. Monet plays them in Claude Code.

Any format that ffmpeg reads works: mp4, webm, mov, mkv, gif, png, jpg and more.
Long videos are fine: Monet converts only the parts that play.
`

const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'clip'

const title = (file: string) =>
  file
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())

/** The clips among a folder's entries, by name. */
export function clipsFrom(
  entries: readonly { name: string; kind: string }[],
  dir: string,
  isSample: boolean,
): MonetClip[] {
  return entries
    .filter(entry => entry.kind === 'file' && MEDIA.test(entry.name) && !entry.name.startsWith('.'))
    .map(entry => ({
      id: `${isSample ? 's' : 'u'}-${slug(entry.name)}`,
      name: title(entry.name),
      file: `${dir}/${entry.name}`,
      isSample,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** What Monet knows about one clip at one frame rate. */
export type Meta = {
  version: number
  file: string
  size: number
  mtimeMs: number
  fps: number
  isStill: boolean
  /** The mosaic frames' size in pixels. */
  width: number
  height: number
  /** The real-pixel frames' size. */
  pixelsWidth: number
  pixelsHeight: number
  totalFrames: number
  framesPerPiece: number
  pieces: number
  /** The pieces converted: mosaic frames, and real-pixel frames. */
  done: number[]
  donePixels: number[]
}

export const ffprobeArgv = (file: string) => [
  'ffprobe', '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file,
]

/** Builds the meta from ffprobe's JSON output; throws when it has no video. */
export function metaFrom(
  probeJson: string,
  file: { path: string; size: number; mtimeMs: number },
  fps: number,
): Meta {
  const info = JSON.parse(probeJson) as {
    streams?: { width?: number; height?: number }[]
    format?: { duration?: string }
  }
  const w = info.streams?.[0]?.width ?? 0
  const h = info.streams?.[0]?.height ?? 0
  if (w <= 0 || h <= 0) throw new Error('it has no video')
  const duration = Number(info.format?.duration)
  const isStill = STILL.test(file.path) || !Number.isFinite(duration) || duration <= 0
  const k = Math.min(1, MOSAIC_W / w, MOSAIC_H / h)
  const width = Math.max(1, Math.round(w * k))
  const height = Math.max(1, Math.round(h * k))
  const pk = Math.min(1, PIXELS_W / w)
  const framesPerPiece = Math.max(1, Math.floor(PIECE_BYTES / (width * height * 3)))
  const totalFrames = isStill ? 1 : Math.max(1, Math.floor(duration * fps))
  return {
    version: META_VERSION,
    file: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    fps,
    isStill,
    width,
    height,
    pixelsWidth: Math.max(2, Math.round((w * pk) / 2) * 2),
    pixelsHeight: Math.max(2, Math.round((h * pk) / 2) * 2),
    totalFrames,
    framesPerPiece,
    pieces: Math.ceil(totalFrames / framesPerPiece),
    done: [],
    donePixels: [],
  }
}

/** Whether a kept meta still describes the file. */
export const isFresh = (kept: Meta | undefined, file: { path: string; size: number; mtimeMs: number }, fps: number) =>
  kept?.version === META_VERSION &&
  kept.file === file.path &&
  kept.size === file.size &&
  kept.mtimeMs === file.mtimeMs &&
  kept.fps === fps

export const clipDir = (places: Places, clip: MonetClip, fps: number) => `${places.cache}/${clip.id}/${fps}fps`

export const metaPath = (places: Places, clip: MonetClip, fps: number) => `${clipDir(places, clip, fps)}/meta.json`

const pad = (n: number) => String(n).padStart(4, '0')

export const piecePath = (places: Places, clip: MonetClip, meta: Meta, piece: number) =>
  `${clipDir(places, clip, meta.fps)}/m${pad(piece)}.rgb`

export const pixelsDir = (places: Places, clip: MonetClip, meta: Meta, piece: number) =>
  `${clipDir(places, clip, meta.fps)}/p${pad(piece)}`

export const pixelsPath = (places: Places, clip: MonetClip, meta: Meta, frame: number) =>
  `${pixelsDir(places, clip, meta, pieceOf(meta, frame))}/${pad((frame % meta.framesPerPiece) + 1)}.png`

export const pieceOf = (meta: Meta, frame: number) => Math.floor(frame / meta.framesPerPiece)

// The input part of an ffmpeg command for one piece. One thread: a piece of
// 1080p video takes about 1.3 s of one core, and the other cores stay free.
function inputArgs(meta: Meta, piece: number, scale: string): string[] {
  if (meta.isStill) {
    return ['-threads', '1', '-i', meta.file, '-frames:v', '1', '-filter_threads', '1', '-vf', scale]
  }
  const start = (piece * meta.framesPerPiece) / meta.fps
  const frames = Math.min(meta.framesPerPiece, meta.totalFrames - piece * meta.framesPerPiece)
  return [
    '-threads', '1', '-ss', start.toFixed(3), '-i', meta.file,
    '-frames:v', String(frames), '-an', '-sn', '-filter_threads', '1',
    '-vf', `fps=${meta.fps},${scale}`,
  ]
}

/** ffmpeg: one piece of mosaic frames, raw RGB, into one file. */
export const pieceArgv = (places: Places, clip: MonetClip, meta: Meta, piece: number) => [
  'ffmpeg', '-v', 'error', '-nostdin', '-y',
  ...inputArgs(meta, piece, `scale=${meta.width}:${meta.height}:flags=area`),
  '-pix_fmt', 'rgb24', '-f', 'rawvideo', piecePath(places, clip, meta, piece),
]

/**
 * ffmpeg: one piece of real-pixel frames, one PNG each. 128 colors for the
 * whole piece keep a frame near 50 KB, a quarter of a full-color PNG.
 */
export const pixelsArgv = (places: Places, clip: MonetClip, meta: Meta, piece: number) => [
  'ffmpeg', '-v', 'error', '-nostdin', '-y',
  ...inputArgs(
    meta,
    piece,
    `scale=${meta.pixelsWidth}:${meta.pixelsHeight}:flags=lanczos,split[a][b];` +
      '[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
  ),
  '-compression_level', '9', `${pixelsDir(places, clip, meta, piece)}/%04d.png`,
]

/** The command that deletes a file or folder under the cache; undefined for any other path. */
export function removeArgv(places: Places, path: string, isDir = true): string[] | undefined {
  if (!path.startsWith(`${places.cache}/`) || path.includes('..')) return undefined
  if (!places.isWindows) return ['rm', '-rf', path]
  const native = path.replaceAll('/', '\\')
  return isDir ? ['cmd', '/c', 'rd', '/s', '/q', native] : ['cmd', '/c', 'del', '/q', native]
}

/** The commands that may open a folder in the file manager, in the order to try. */
export const openFolderArgvs = (places: Places) =>
  places.isWindows
    ? [['explorer', places.folder.replaceAll('/', '\\')]]
    : [['xdg-open', places.folder], ['open', places.folder]]

/**
 * The clips to delete so the cache fits `limitMB`, played longest ago first,
 * never `keep`; and how many bytes are still over the limit after that.
 */
export function clipsToTrim(
  clips: readonly { id: string; bytes: number; newest: number }[],
  limitMB: number,
  keep: string | null,
): { ids: string[]; over: number } {
  let total = clips.reduce((sum, c) => sum + c.bytes, 0)
  const limit = limitMB * 1024 * 1024
  const ids: string[] = []
  for (const c of [...clips].sort((a, b) => a.newest - b.newest)) {
    if (total <= limit) break
    if (c.id === keep) continue
    ids.push(c.id)
    total -= c.bytes
  }
  return { ids, over: Math.max(0, total - limit) }
}

/** The pieces of the clip on show that already played: all before the one before `current`. */
export const playedPieces = (meta: Meta, current: number) =>
  [...new Set([...meta.done, ...meta.donePixels])].filter(n => n < current - 1)

/** The last line a command wrote, for a short error. */
export const lastLine = (text: string) => text.trim().split('\n').pop()?.slice(0, 200) ?? ''
