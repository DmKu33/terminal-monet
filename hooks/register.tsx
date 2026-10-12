// Monet: plays the videos in ~/Videos/Monet (~/Movies/Monet on macOS,
// Videos\Monet on Windows) as a color mosaic in a pane of Claude Code. In
// kitty and Ghostty it can show real pixels instead. ~/.claude/monet holds
// only the cache of converted frames.
//
// The pane is drawn by the `ui.render` hook at the end. A timer moves the
// picture: each tick draws one frame with `$.ui.blit`, so the pane itself is
// drawn again only when the clip, the size or the settings change.

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, Timer } from 'claude-code'

import type { MonetClip, MonetLine, MonetLook, MonetNow, MonetSettings, MonetSite, MonetView } from '../types'
import { fitLayout, frameCells, makeAmbient, makeSampler } from './draw'
import type { Layout, Sampler } from './draw'
import {
  FOLDER_README,
  clipsFrom,
  clipsToTrim,
  ffprobeArgv,
  isFresh,
  lastLine,
  metaFrom,
  metaPath,
  openFolderArgvs,
  pieceArgv,
  pieceOf,
  piecePath,
  pixelsArgv,
  pixelsDir,
  pixelsPath,
  placesFrom,
  playedPieces,
  removeArgv,
} from './library'
import type { Meta, Places } from './library'
import { IDLE, describeTool, firstLine, sessionLines, spinnerWord, statusLineText, statusLines, textCells } from './status'
import type { SessionStats, Status } from './status'
import { parseColor, terminalFrom, themeFor } from './terminal'
import type { TerminalInfo } from './terminal'

type $ = EngineInterface
type Look = Exclude<MonetLook, 'auto'>

const PANE = 'monet'
const GOLD = '#d8b45f'
const DIM_GOLD = '#8c7a4a'

const DEFAULTS: MonetSettings = {
  clip: '*',
  look: 'auto',
  fps: 12,
  play: 'always',
  fit: 'ambient',
  hold: 120,
  cacheMB: 300,
  samples: true,
  paneColor: 'terminal',
  show: 'auto',
  style: 'atelier',
  statusLine: true,
  folder: '',
}

const FIRST_NOW: MonetNow = {
  clipId: null,
  width: 0,
  height: 0,
  caption: 'Starting…',
  isPaused: false,
  look: 'half',
  isThemed: false,
}

const settingsAtom = atom({ plugin: 'monet', key: 'settings' } as const, DEFAULTS)
const libraryAtom = atom({ plugin: 'monet', key: 'library' } as const, [])
const viewAtom = atom({ plugin: 'monet', key: 'view' } as const, 'player')
const siteAtom = atom({ plugin: 'monet', key: 'site' } as const, 'none')
const lineAtom = atom({ plugin: 'monet', key: 'line' } as const, { step: '', tail: '' })
const nowAtom = atom({ plugin: 'monet', key: 'now' } as const, FIRST_NOW)

const INSTALL_FFMPEG =
  'Monet needs ffmpeg. Linux: sudo apt install ffmpeg · macOS: brew install ffmpeg · Windows: winget install ffmpeg'

// ---------- the module's own state (a reload starts it over) ----------

let places: Places | null = null
let terminal: TerminalInfo = { name: 'terminal', hasPixels: false }
let terminalColor: string | undefined
let hasTools = true
let settings: MonetSettings = DEFAULTS
let library: MonetClip[] = []
let positions: Record<string, number> = {}

let clip: MonetClip | null = null
let meta: Meta | null = null
let frame = 0
let clipStartedAt = 0
let generation = 0
const pieces = new Map<number, Uint8Array>()
const loading = new Set<number>()

let timer: Timer | null = null
let site: MonetSite = 'none'
let isTurnRunning = false
let isPaused = false
let pixelsFailed = false

// What Claude is doing, for the words under the picture.
let status: Status = IDLE
const turns = new Set<string>()
const tasks = new Map<string, { subject: string; activeForm?: string; status: string }>()
const changed = new Set<string>()
let clockTimer: Timer | null = null

type Area = { columns: number; rows: number }

// What the pane or the band mounted at its last draw, so a tick knows what
// to blit, and where (`site`: the pane's id or the band's request id).
type Mounted = { site: string; layout: Layout; look: Look; clipId: string; info: Area; isDock: boolean; title?: string; stats?: Area }
let mounted: Mounted | null = null
let sampler: Sampler | null = null

// ffmpeg runs one at a time, so Monet never takes more than one core.
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.catch(() => undefined)
  return run
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 160)

// ---------- the engine calls: folder, ffmpeg, cache ----------

// What a command wrote, with no white space at its ends; undefined when it
// cannot start, fails or times out.
async function output($: $, argv: string[], ms: number): Promise<string | undefined> {
  const ran = await $.process.run(argv, { timeoutMs: ms }).catch(() => undefined)
  return ran?.exitCode === 0 ? ran.stdout.trim() : undefined
}

async function findPlaces($: $): Promise<Places> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const folder = settings.folder || (await videosFolder($, home, isWindows))
  return placesFrom(home, await $.env.get('CLAUDE_CONFIG_DIR'), isWindows, folder)
}

// Monet in the Videos folder, where a person finds it to drag files in: its
// local name on Linux (xdg-user-dir), Movies on macOS.
async function videosFolder($: $, home: string, isWindows: boolean): Promise<string> {
  if (!isWindows) {
    const dir = await output($, ['xdg-user-dir', 'VIDEOS'], 5000)
    if (dir && dir !== home) return `${dir}/Monet`
    if (await $.fs.exists(`${home}/Movies`)) return `${home}/Movies/Monet`
  }
  return `${home}/Videos/Monet`
}

async function ensureFolder($: $, where: Places): Promise<void> {
  if (!(await $.fs.exists(`${where.folder}/README.txt`))) {
    await $.fs.write(`${where.folder}/README.txt`, FOLDER_README).catch(() => undefined)
  }
}

async function detectTerminal($: $): Promise<TerminalInfo> {
  const [TERM, TERM_PROGRAM, TMUX, KITTY_WINDOW_ID, GHOSTTY_RESOURCES_DIR, VTE_VERSION] = await Promise.all([
    $.env.get('TERM'),
    $.env.get('TERM_PROGRAM'),
    $.env.get('TMUX'),
    $.env.get('KITTY_WINDOW_ID'),
    $.env.get('GHOSTTY_RESOURCES_DIR'),
    $.env.get('VTE_VERSION'),
  ])
  return terminalFrom({ TERM, TERM_PROGRAM, TMUX, KITTY_WINDOW_ID, GHOSTTY_RESOURCES_DIR, VTE_VERSION })
}

// The terminal's background, where its settings say it: Ghostty's config,
// or a GNOME Terminal profile with its own colors. Undefined elsewhere.
async function detectBackground($: $): Promise<string | undefined> {
  if (terminal.name === 'Ghostty') {
    const config = await output($, ['ghostty', '+show-config', '--default'], 5000)
    return parseColor(config?.split('\n').find(line => line.startsWith('background =')) ?? '')
  }
  if (terminal.name === 'GNOME Terminal') {
    const id = (await output($, ['gsettings', 'get', 'org.gnome.Terminal.ProfilesList', 'default'], 5000))?.replaceAll("'", '')
    const profile = `org.gnome.Terminal.Legacy.Profile:/org/gnome/terminal/legacy/profiles:/:${id}/`
    if (!id) return undefined
    if ((await output($, ['gsettings', 'get', profile, 'use-theme-colors'], 5000)) === 'true') {
      // Ubuntu patches the theme colors to its aubergine; other systems: unknown.
      const os = await $.fs.read('/etc/os-release').catch(() => '')
      return /^ID=ubuntu$/m.test(os) ? '#300a24' : undefined
    }
    return parseColor((await output($, ['gsettings', 'get', profile, 'background-color'], 5000)) ?? '')
  }
  return undefined
}

// ---------- the Monet theme: the dock's own rows in the terminal's color ----------

const THEME = 'custom:monet'
let claudeTheme = ''

async function readTheme($: $): Promise<string> {
  const row = (await $.config.list()).find(one => one.key === 'theme')
  claudeTheme = String(row?.value ?? 'dark')
  await setNow($, { isThemed: claudeTheme === THEME })
  return claudeTheme
}

// Writes ~/.claude/themes/monet.json for the pane's color; Claude Code reads it as "custom:monet".
async function writeTheme($: $): Promise<boolean> {
  const color = paneColor()
  if (!color || !places) return false
  await $.fs.write(`${places.config}/themes/monet.json`, themeFor(color))
  return true
}

/**
 * Readies the Monet theme and opens Claude Code's /theme picker on it: a mod
 * may set the built-in themes only, so the person picks "Monet" there. Off,
 * it puts back the built-in theme Claude Code had before.
 */
async function useTheme($: $, isOn: boolean): Promise<string> {
  const current = await readTheme($)
  if (isOn) {
    if (!(await writeTheme($))) return 'Monet needs your terminal color first: /monet settings → My color.'
    if (current !== THEME) await $.store.set('previousTheme', current)
    // After this command's own turn: a command cannot run another while it runs.
    $.clock.after(300, () => void $.command.run({ command: 'theme', args: '' }).catch(() => undefined))
    return 'Pick "Monet" in the theme list: it paints the whole side pane in your terminal color.'
  }
  const value = String((await $.store.get('previousTheme')) ?? 'dark')
  const result = await $.config.set({ key: 'theme', value })
  if (result.deny) return 'Pick your theme again with /theme.'
  claudeTheme = value
  await setNow($, { isThemed: false })
  return `Claude Code is back on the ${value} theme.`
}

const paneColor = () =>
  settings.paneColor === 'claude' ? undefined : settings.paneColor === 'terminal' ? terminalColor : settings.paneColor

async function scan($: $, where: Places, withSamples: boolean): Promise<MonetClip[]> {
  const own = clipsFrom(await $.fs.list(where.folder).catch(() => []), where.folder, false)
  const samplesDir = `${$.plugin.root}/samples`
  const samples = withSamples ? clipsFrom(await $.fs.list(samplesDir).catch(() => []), samplesDir, true) : []
  return [...own, ...samples]
}

async function writeMeta($: $, where: Places, c: MonetClip, m: Meta): Promise<void> {
  await $.fs.write(metaPath(where, c, m.fps), JSON.stringify(m))
}

// The clip's size and length from ffprobe, or the meta of an earlier run.
async function prepare($: $, where: Places, c: MonetClip, fps: number): Promise<Meta> {
  const stat = await $.fs.stat(c.file)
  const file = { path: c.file, size: stat.size, mtimeMs: stat.mtimeMs }
  const kept = await $.fs
    .read(metaPath(where, c, fps))
    .then(text => JSON.parse(text) as Meta)
    .catch(() => undefined)
  if (kept && isFresh(kept, file, fps)) return kept
  const probe = await $.process.run(ffprobeArgv(c.file), { timeoutMs: 30_000 })
  if (probe.exitCode !== 0) throw new Error(lastLine(probe.stderr) || 'ffprobe cannot read it')
  const m = metaFrom(probe.stdout, file, fps)
  await writeMeta($, where, c, m)
  return m
}

// Converts one piece to mosaic frames, or to real-pixel frames. It answers
// whether ffmpeg ran, so the cache trim runs only then.
async function convert($: $, where: Places, c: MonetClip, m: Meta, piece: number, isPixels: boolean): Promise<boolean> {
  if ((isPixels ? m.donePixels : m.done).includes(piece)) return false
  if (isPixels) await $.fs.write(`${pixelsDir(where, c, m, piece)}/.keep`, '')
  const argv = isPixels ? pixelsArgv(where, c, m, piece) : pieceArgv(where, c, m, piece)
  const ran = await $.process.run(argv, { timeoutMs: 300_000 })
  if (ran.exitCode !== 0) throw new Error(lastLine(ran.stderr) || `ffmpeg exited ${ran.exitCode}`)
  // The cache trim may have replaced the lists while ffmpeg ran.
  if (isPixels) m.donePixels.push(piece)
  else m.done.push(piece)
  await writeMeta($, where, c, m)
  return true
}

async function sizeOf($: $, dir: string): Promise<{ bytes: number; newest: number }> {
  let bytes = 0
  let newest = 0
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    if (entry.kind === 'dir') {
      const inner = await sizeOf($, `${dir}/${entry.name}`)
      bytes += inner.bytes
      newest = Math.max(newest, inner.newest)
    } else {
      bytes += entry.size
      newest = Math.max(newest, entry.mtimeMs)
    }
  }
  return { bytes, newest }
}

async function removeCached($: $, where: Places, path: string, isDir = true): Promise<void> {
  const argv = removeArgv(where, path, isDir)
  if (argv) await $.process.run(argv, { timeoutMs: 60_000 }).catch(() => undefined)
}

// Keeps the cache under the limit. It deletes whole clips first, played
// longest ago first. If the clip on show is still too big (a long movie), it
// deletes that clip's pieces that already played.
async function trimCache($: $, where: Places, limitMB: number): Promise<void> {
  const clips = []
  for (const entry of await $.fs.list(where.cache).catch(() => [])) {
    if (entry.kind === 'dir') clips.push({ id: entry.name, ...(await sizeOf($, `${where.cache}/${entry.name}`)) })
  }
  const c = clip
  const m = meta
  const plan = clipsToTrim(clips, limitMB, c?.id ?? null)
  for (const id of plan.ids) await removeCached($, where, `${where.cache}/${id}`)
  if (plan.over === 0 || !c || !m) return
  const played = playedPieces(m, pieceOf(m, frame))
  if (played.length === 0) return
  for (const n of played) {
    await removeCached($, where, piecePath(where, c, m, n), false)
    await removeCached($, where, pixelsDir(where, c, m, n))
  }
  m.done = m.done.filter(n => !played.includes(n))
  m.donePixels = m.donePixels.filter(n => !played.includes(n))
  await writeMeta($, where, c, m)
}

async function clearCache($: $, where: Places): Promise<void> {
  for (const entry of await $.fs.list(where.cache).catch(() => [])) {
    if (entry.kind === 'dir') await removeCached($, where, `${where.cache}/${entry.name}`)
  }
}

async function openFolder($: $, where: Places): Promise<boolean> {
  // xdg-open writes nothing when it works: only undefined is a failure.
  for (const argv of openFolderArgvs(where)) {
    if ((await output($, argv, 10_000)) !== undefined) return true
  }
  return false
}

// ---------- state the pane draws from ----------

async function setNow($: $, patch: Partial<MonetNow>): Promise<void> {
  await update($, nowAtom, n => ({ ...n, ...patch }))
}

async function setLibrary($: $, next: MonetClip[]): Promise<void> {
  library = next
  await update($, libraryAtom, () => library)
}

function resolveLook(): Look {
  const look = settings.look === 'auto' ? (terminal.hasPixels ? 'pixels' : 'half') : settings.look
  return look === 'pixels' && pixelsFailed ? 'half' : look
}

// ---------- playback ----------

function pickNext(): MonetClip | null {
  const playable = library.filter(c => !c.isFailed)
  if (playable.length === 0) return null
  // A clip picked by name plays on; one deleted from the folder falls back to shuffle.
  const chosen = settings.clip === '*' ? undefined : playable.find(c => c.id === settings.clip)
  if (chosen) return chosen
  const others = playable.filter(c => c.id !== clip?.id)
  const pool = others.length > 0 ? others : playable
  return pool[Math.floor(Math.random() * pool.length)]!
}

async function savePosition($: $): Promise<void> {
  if (!clip || !meta) return
  // Only long clips resume where they stopped.
  if (meta.totalFrames < 60 * meta.fps) return
  positions = { ...positions, [clip.id]: frame }
  await $.store.set('positions', positions)
}

async function startClip($: $, next: MonetClip | null, startFrame?: number): Promise<void> {
  await savePosition($)
  generation += 1
  const gen = generation
  clip = next
  meta = null
  frame = 0
  pieces.clear()
  loading.clear()
  clipStartedAt = Date.now()
  if (!next) {
    const empty = hasTools
      ? `Drop videos in ${places?.shown ?? 'the Monet folder'}. Monet finds them within 20 seconds.`
      : INSTALL_FFMPEG
    await setNow($, { clipId: null, width: 0, height: 0, caption: empty })
    return
  }
  await setNow($, { clipId: null, caption: `Opening ${next.name}…` })
  if (!hasTools || !places) {
    await setNow($, { caption: INSTALL_FFMPEG })
    return
  }
  const where = places
  try {
    const m = await enqueue(() => prepare($, where, next, settings.fps))
    if (gen !== generation) return
    meta = m
    const resume = startFrame ?? positions[next.id] ?? 0
    frame = resume < m.totalFrames - m.fps ? Math.max(0, resume) : 0
    // A fresh write marks the clip as recently played for the cache trim.
    await writeMeta($, where, next, m)
    await setNow($, {
      clipId: next.id,
      width: m.width,
      height: m.height,
      look: resolveLook(),
      isPaused,
    })
    want($, pieceOf(m, frame))
  } catch (err) {
    if (gen !== generation) return
    await setLibrary(
      $,
      library.map(c => (c.id === next.id ? { ...c, isFailed: true as const } : c)),
    )
    await setNow($, { clipId: null, caption: `Monet cannot play ${next.name}: ${errorText(err)}` })
    if (library.some(c => !c.isFailed)) {
      $.clock.after(3000, () => void startClip($, pickNext()))
    }
  }
}

// Loads a piece of frames, converting it first when no earlier run did.
function want($: $, piece: number): void {
  const m = meta
  const c = clip
  const where = places
  if (!m || !c || !where || piece >= m.pieces || pieces.has(piece) || loading.has(piece)) return
  loading.add(piece)
  const gen = generation
  const withPixels = resolveLook() === 'pixels'
  enqueue(async () => {
    if (gen !== generation) return
    let isNew = await convert($, where, c, m, piece, false)
    if (withPixels) {
      isNew = (await convert($, where, c, m, piece, true).catch(async () => {
        pixelsFailed = true
        await setNow($, { look: resolveLook() })
        return false
      })) || isNew
    }
    const { base64 } = await $.fs.read(piecePath(where, c, m, piece), { as: 'bytes' })
    const data = Uint8Array.fromBase64(base64)
    if (gen !== generation) return
    pieces.set(piece, data)
    const current = pieceOf(m, frame)
    for (const kept of [...pieces.keys()]) {
      if (kept !== current && kept !== current + 1 && kept !== piece) pieces.delete(kept)
    }
    if (isNew) await trimCache($, where, settings.cacheMB)
  })
    .catch(async err => {
      if (gen === generation) await setNow($, { caption: `ffmpeg failed on ${c.name}: ${errorText(err)}` })
    })
    .finally(() => loading.delete(piece))
}

// The next clip: a random other one when shuffling, else the next one by name.
async function nextClip($: $): Promise<void> {
  const playable = library.filter(c => !c.isFailed)
  const at = playable.findIndex(c => c.id === settings.clip)
  if (at < 0) {
    await startClip($, pickNext(), 0)
    return
  }
  const following = playable[(at + 1) % playable.length]!
  await change($, { clip: following.id })
}

// Runs after each frame; `atEnd` once the clip played its last one. A shuffle
// starts the next clip once this one's time is over (at its end with no hold
// time). Else a clip at its end starts again.
async function endOfClip($: $, atEnd: boolean): Promise<void> {
  const isShuffle = !library.some(c => c.id === settings.clip) && library.filter(c => !c.isFailed).length > 1
  const isOver = settings.hold === 0 ? atEnd : Date.now() - clipStartedAt >= settings.hold * 1000
  if (isShuffle && isOver) await startClip($, pickNext(), 0)
  else if (atEnd) frame = 0
}

function tick($: $): void {
  const m = meta
  const c = clip
  if (!m || !c || !mounted || mounted.clipId !== c.id) return
  const piece = pieceOf(m, frame)
  const data = pieces.get(piece)
  if (!data) {
    want($, piece)
    return
  }
  const frameBytes = m.width * m.height * 3
  const inPiece = frame - piece * m.framesPerPiece
  const count = Math.floor(data.length / frameBytes)
  if (inPiece >= count) {
    // ffmpeg gave fewer frames than planned. Go on to the next piece; an
    // empty piece means the video ends sooner than its header said.
    if (count > 0 && piece + 1 < m.pieces) frame = (piece + 1) * m.framesPerPiece
    else void endOfClip($, true)
    return
  }
  draw($, c, m, data, inPiece * frameBytes, frame)
  if (inPiece >= m.framesPerPiece / 3) want($, piece + 1)
  frame += 1
  void endOfClip($, frame >= m.totalFrames)
}

function draw($: $, c: MonetClip, m: Meta, data: Uint8Array, offset: number, f: number): void {
  if (!mounted || !places) return
  if (mounted.look === 'pixels') {
    if (!m.donePixels.includes(pieceOf(m, f))) return
    const file = pixelsPath(places, c, m, f)
    void $.ui.blit({ requestId: mounted.site, key: 'pixels', source: { file, format: 'png' } }).then(async result => {
      // The terminal drew the alt text: it has no pictures, so draw a mosaic.
      if (result.deny && /\balt\b/.test(result.deny) && !pixelsFailed) {
        pixelsFailed = true
        await setNow($, { look: resolveLook() })
      }
    })
    return
  }
  if (!sampler) return
  void $.ui.blit({
    requestId: mounted.site,
    key: 'mosaic',
    cells: frameCells(sampler, data, offset),
    columns: mounted.layout.columns,
    rows: mounted.layout.rows,
  })
}

// What the sampler was made for: a new look, fit, room or frame size makes a new one.
let samplerKey = ''

function syncTimer($: $): void {
  const shouldRun = site !== 'none' && !isPaused && (settings.play === 'always' || isTurnRunning)
  timer?.cancel()
  timer = shouldRun ? $.clock.every(Math.round(1000 / settings.fps), () => tick($)) : null
}

// ---------- what Claude is doing ----------

// The stats go under the status words, unless the box has a column of its own for them.
const infoCells = (m: Pick<Mounted, 'info' | 'isDock' | 'title' | 'stats'>) =>
  textCells(
    statusLines(status, Date.now(), m.info.columns, settings.style, {
      isTall: m.isDock,
      ...(session && !m.stats ? { session } : {}),
      ...(m.title ? { title: m.title } : {}),
    }),
    m.info.columns,
    m.info.rows,
  )

// The session's figures for the stats block; read again every 5 seconds while Monet shows.
let session: SessionStats | undefined

// "claude-opus-5-5" reads as "Opus 5.5"; any other name stays as it is.
const modelName = (id: string) =>
  id.replace(/^claude-([a-z]+)-(\d+)-(\d+).*$/, (_, name: string, major: string, minor: string) =>
    `${name[0]!.toUpperCase()}${name.slice(1)} ${major}.${minor}`)

async function refreshSession($: $): Promise<void> {
  const [model, prompts, usage] = await Promise.all([$.session.model(), $.session.turns(), $.session.usage()])
  session = {
    model: modelName(model),
    prompts,
    startedAt: usage.startedAt,
    contextPercent: usage.context.percent,
    contextWindow: usage.context.window,
    limits: usage.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed })),
    usd: usage.cost?.usd,
  }
  setStatus($, {})
}

const statsCells = (area: Area) => textCells(session ? sessionLines(session, Date.now()) : [], area.columns, area.rows)

let line: MonetLine = { step: '', tail: '' }

function setStatus($: $, patch: Partial<Status>): void {
  status = { ...status, ...patch }
  if (mounted) void $.ui.blit({ requestId: mounted.site, key: 'info', cells: infoCells(mounted), ...mounted.info })
  if (mounted?.stats) void $.ui.blit({ requestId: mounted.site, key: 'stats', cells: statsCells(mounted.stats), ...mounted.stats })
  // The spinner and the hint line under the prompt draw from this value.
  const next = { step: spinnerWord(status, settings.style), tail: statusLineText(status, Date.now(), settings.style) }
  if (next.step !== line.step || next.tail !== line.tail) {
    line = next
    void update($, lineAtom, () => next)
  }
}

function countTasks(): Partial<Status> {
  const all = [...tasks.values()]
  return { done: all.filter(t => t.status === 'completed').length, total: all.length }
}

// ---------- where Monet shows: the pane, the band, or nowhere ----------

async function setSite($: $, next: MonetSite): Promise<void> {
  site = next
  await update($, siteAtom, () => next)
  syncTimer($)
}

async function openPane($: $, view: MonetView = 'player'): Promise<boolean> {
  await update($, viewAtom, () => view)
  const opened = await $.ui.open({
    id: PANE,
    title: 'Monet',
    columns: 50,
    rows: 10,
    ...(view === 'settings' ? { focus: true as const } : {}),
  })
  return opened.isPlaced
}

/**
 * Shows Monet as the settings say: the side pane where it has room, else the
 * band above the prompt. Asked (/monet), it shows even when the setting is
 * off, and a pane-only setting places the pane at any width.
 */
async function show($: $, isAsked: boolean): Promise<void> {
  const mode = settings.show === 'off' && isAsked ? 'auto' : settings.show
  if (mode === 'off') return setSite($, 'none')
  if (mode === 'band') {
    await $.ui.close({ id: PANE }).catch(() => undefined)
    return setSite($, 'band')
  }
  const isPlaced = await openPane($)
  await setSite($, isPlaced ? 'pane' : mode === 'auto' ? 'band' : 'none')
  // Once ever: the side panel is Claude's gray until the Monet theme paints it all.
  if (isPlaced && claudeTheme !== THEME && paneColor() && !(await $.store.get('themeTip'))) {
    $.ui.toast("Tip: /monet theme paints the whole side panel in your terminal's color.")
    await $.store.set('themeTip', true)
  }
}

// A pane that waited undrawn is placed once the terminal widens, and hides
// behind another pane's tab: the band takes over while it does.
async function checkPane($: $): Promise<void> {
  if (settings.show !== 'auto' || site === 'none') return
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  const isUp = pane?.isPlaced === true && pane.isShown
  if (isUp !== (site === 'pane')) await setSite($, isUp ? 'pane' : 'band')
}

// ---------- the folder and the settings ----------

async function rescan($: $): Promise<void> {
  if (!places) return
  const found = await scan($, places, settings.samples)
  const known = new Map(library.map(c => [c.id, c]))
  const next = found.map(c => known.get(c.id) ?? c)
  const isSame = next.length === library.length && next.every((c, i) => c.id === library[i]?.id)
  if (!isSame) await setLibrary($, next)
  const isGone = clip !== null && !next.some(c => c.id === clip?.id)
  if (clip === null || isGone) {
    if (next.some(c => !c.isFailed)) await startClip($, pickNext())
    else if (isGone) await startClip($, null)
  }
}

async function change($: $, patch: Partial<MonetSettings>): Promise<void> {
  const before = settings
  settings = { ...settings, ...patch }
  await update($, settingsAtom, () => settings)
  await $.store.set('settings', settings)
  if (patch.folder !== undefined && patch.folder !== before.folder) {
    places = await findPlaces($)
    await ensureFolder($, places)
  }
  if (patch.samples !== undefined || patch.folder !== undefined) await rescan($)
  if (patch.look !== undefined) {
    pixelsFailed = false
    // The pieces load again, with real-pixel frames when the new look needs them.
    pieces.clear()
    await setNow($, { look: resolveLook() })
  }
  if (patch.fps !== undefined && patch.fps !== before.fps) {
    syncTimer($)
    if (clip) await startClip($, clip, Math.round((frame * patch.fps) / before.fps))
  }
  if (patch.clip !== undefined && patch.clip !== before.clip) {
    await startClip($, patch.clip === '*' ? pickNext() : library.find(c => c.id === patch.clip) ?? null)
  }
  if (patch.play !== undefined) syncTimer($)
  if (patch.cacheMB !== undefined && places) await trimCache($, places, settings.cacheMB)
  if (patch.show !== undefined && patch.show !== before.show && site !== 'none') await show($, false)
  if (patch.style !== undefined) setStatus($, {})
  if (patch.paneColor !== undefined && claudeTheme === THEME) await writeTheme($)
}

async function togglePause($: $): Promise<void> {
  isPaused = !isPaused
  syncTimer($)
  await setNow($, { isPaused })
}

async function boot($: $): Promise<void> {
  settings = { ...DEFAULTS, ...((await $.store.get('settings')) as Partial<MonetSettings> | undefined) }
  positions = ((await $.store.get('positions')) as Record<string, number> | undefined) ?? {}
  await update($, settingsAtom, () => settings)
  places = await findPlaces($)
  await ensureFolder($, places)
  terminal = await detectTerminal($)
  terminalColor = await detectBackground($)
  // Claude Code lists custom themes as a session starts: write the file every
  // start, so "Monet" is in /theme from the next session on.
  await readTheme($).catch(() => '')
  await writeTheme($).catch(() => undefined)
  hasTools =
    (await output($, ['ffmpeg', '-version'], 10_000)) !== undefined &&
    (await output($, ['ffprobe', '-version'], 10_000)) !== undefined
  await setLibrary($, await scan($, places, settings.samples))
  await show($, false)
  await startClip($, pickNext())
  // New files in the folder show up within 20 seconds; the pane is checked every 5.
  $.clock.every(20_000, () => void rescan($))
  $.clock.every(5_000, () => {
    void checkPane($)
    // The person may pick the Monet theme in /theme at any time.
    void readTheme($).catch(() => '')
    if (site !== 'none') void refreshSession($).catch(() => undefined)
  })
  await refreshSession($).catch(() => undefined)
}

// ---------- drawing: one tree for the pane and the band ----------

type Ui = Elements['terminal']

type PlayerArgs = {
  ui: Ui
  /** The pane's id or the band's request id: where ticks blit. */
  siteId: string
  /**
   * A docked pane: the picture on top, in Monet's own frame with the clip's
   * name in its top border, as the engine draws none there. Else the words
   * at the picture's right.
   */
  isDock: boolean
  columns: number
  rows: number
  shown: MonetNow
  s: MonetSettings
  paint: object
}

function playerTree($: $, { ui, siteId, isDock, columns, rows, shown, s, paint }: PlayerArgs) {
  const { Box, Button, Image, Raster, Text } = ui
  const isAtelier = s.style === 'atelier'
  // A frame takes a row above and below, and a border and a space at each side.
  const inner = isDock ? { columns: columns - 4, rows: rows - 2 } : { columns, rows }
  const title = clip && shown.clipId ? `${isAtelier ? '☽ ' : ''}${clip.name}` : 'Monet'
  const frameColor = isAtelier ? DIM_GOLD : 'inactive'
  // `ruleAt`: the row of a rule that joins the frame's sides, "├──── ✦ ────┤".
  const framed = (body: ReturnType<typeof h>, ruleAt?: number) => {
    const side = '─'.repeat(Math.max(0, Math.floor((columns - 5) / 2)))
    const rest = '─'.repeat(Math.max(0, columns - 5 - side.length))
    return (
      <Box flexDirection="column" {...paint}>
        {isDock ? (
          <Box borderStyle="round" borderColor={frameColor} paddingX={1} flexDirection="column" height={rows}>
            {body}
          </Box>
        ) : body}
        {/* Drawn after the frame, so they paint over it: the rule, then the title "╭─ ☽ Cauldron ──╮". */}
        {isDock && ruleAt !== undefined && (
          <Box position="absolute" top={ruleAt} left={0}>
            <Text color={frameColor}>
              ├{side}
              <Text color={GOLD}>{isAtelier ? ' ✦ ' : '───'}</Text>
              {rest}┤
            </Text>
          </Box>
        )}
        {isDock && (
          <Box position="absolute" top={0} left={2}>
            <Text color={GOLD}> {title} </Text>
          </Box>
        )}
      </Box>
    )
  }
  // "p: pause  n: next  s: settings" takes 30 columns: narrower, one under another.
  const controls = (isRow: boolean) => (
    <Box gap={isRow ? 2 : 0} flexDirection={isRow ? 'row' : 'column'}>
      <Button key="pause" plain hotkey="p" label={shown.isPaused ? 'play' : 'pause'} onPress={() => void togglePause($)} />
      <Button key="next" plain hotkey="n" label="next" onPress={() => void nextClip($)} />
      <Button key="settings" plain hotkey="s" label="settings" onPress={() => void openPane($, 'settings').catch(() => undefined)} />
    </Box>
  )

  if (shown.clipId === null || shown.width === 0 || !meta || !clip) {
    if (mounted?.site === siteId) mounted = null
    return framed(
      <Box flexDirection="column">
        <Text wrap="wrap">{shown.caption}</Text>
        {controls(inner.columns >= 30)}
      </Box>,
    )
  }

  // The words are Raster cells in the background of what holds them, so a
  // painted pane keeps one color behind the picture, the words and the buttons.
  // A docked pane keeps 14 rows under the picture: the status and the stats.
  const look = shown.look
  // Beside the words the picture gets a box as wide as the first design's, 30 x 8.
  const room = isDock
    ? { columns: inner.columns, rows: Math.max(3, inner.rows - 14) }
    : { columns: Math.min(Math.floor(inner.columns / 2), Math.round(inner.rows * 3.75)), rows: inner.rows }
  // Ambient fill is a half-block picture; real pixels and the other looks fit.
  const fit = look === 'pixels' || (s.fit === 'ambient' && look !== 'half') ? 'fit' : s.fit
  if (look !== 'pixels') {
    const key = [look, fit, room.columns, room.rows, shown.width, shown.height].join(':')
    if (!sampler || samplerKey !== key) {
      sampler = fit === 'ambient' ? makeAmbient(room, shown) : makeSampler(look, fitLayout(room, shown, fit), shown)
      samplerKey = key
    }
  }
  const layout = look === 'pixels' || !sampler ? fitLayout(room, shown, 'fit') : sampler.layout
  const wordsColumns = isDock ? inner.columns : Math.max(10, inner.columns - layout.columns - 2)
  const buttonRows = wordsColumns >= 30 ? 1 : 3
  // A wide strip gives the stats a column of their own, the same stats as the side panel.
  const statsColumns = !isDock && wordsColumns >= 72 ? 32 : 0
  const info = isDock
    ? { columns: inner.columns, rows: inner.rows - layout.rows - 1 - buttonRows }
    : { columns: wordsColumns - (statsColumns ? statsColumns + 2 : 0), rows: Math.max(3, layout.rows - buttonRows) }
  const stats = statsColumns ? { columns: statsColumns, rows: Math.max(3, layout.rows) } : undefined
  // With no frame to carry it, the clip's name leads the words.
  mounted = {
    site: siteId, layout, look, clipId: shown.clipId, info, isDock,
    ...(isDock ? {} : { title: clip.name }),
    ...(stats ? { stats } : {}),
  }

  let picture
  if (look === 'pixels') {
    sampler = null
    picture = (
      <Image
        key="pixels"
        source={{ file: pixelsPath(places!, clip, meta, frame), format: 'png' }}
        columns={layout.columns}
        rows={layout.rows}
        alt="This terminal shows no pictures. Pick a mosaic look in /monet settings."
      />
    )
  } else {
    const data = pieces.get(pieceOf(meta, frame))
    const bytes = meta.width * meta.height * 3
    const at = (frame - pieceOf(meta, frame) * meta.framesPerPiece) * bytes
    const cells = data && data.length >= at + bytes && sampler ? frameCells(sampler, data, at) : textCells([], layout.columns, layout.rows)
    picture = <Raster key="mosaic" columns={layout.columns} rows={layout.rows} cells={cells} />
  }

  const words = <Raster key="info" columns={info.columns} rows={info.rows} cells={infoCells(mounted)} />
  return framed(
    isDock ? (
      <Box flexDirection="column">
        <Box justifyContent="center">{picture}</Box>
        {/* The row the rule paints over. */}
        <Box height={1} />
        {words}
        {controls(buttonRows === 1)}
      </Box>
    ) : (
      <Box gap={2}>
        {picture}
        <Box flexDirection="column">
          {words}
          {controls(buttonRows === 1)}
        </Box>
        {stats && <Raster key="stats" columns={stats.columns} rows={stats.rows} cells={statsCells(stats)} />}
      </Box>
    ),
    isDock ? 1 + layout.rows : undefined,
  )
}

function settingsTree($: $, ui: Ui, s: MonetSettings, clips: MonetClip[], shown: MonetNow, columns: number, paint: object) {
  const { Box, Button, Input, Select, Text } = ui
  const pick = (key: string, label: string, value: string, options: { value: string; label: string }[], onPick: (v: string) => Promise<void>, isFirst = false) => (
    <Select
      key={key}
      label={label}
      value={options.some(o => o.value === value) ? value : options[0]!.value}
      options={options}
      onSelect={v => void onPick(v)}
      {...(isFirst ? { autoFocus: true as const } : {})}
    />
  )
  // Done goes back to the picture; a pane opened from the band closes again.
  const done = async () => {
    await update($, viewAtom, () => 'player')
    if (site !== 'pane') await $.ui.close({ id: PANE }).catch(() => undefined)
  }
  return (
    <Box flexDirection="column" {...paint}>
      <Text bold color={GOLD}>{s.style === 'atelier' ? '☽ The atelier' : 'Monet settings'}</Text>
      {pick('clip', 'Clip       ', s.clip, [
        { value: '*', label: 'Shuffle all' },
        ...clips.map(c => ({ value: c.id, label: `${c.name}${c.isSample ? ' (sample)' : ''}` })),
      ], v => change($, { clip: v }), true)}
      {pick('show', 'Show       ', s.show, [
        { value: 'auto', label: 'Side, or bottom when narrow' },
        { value: 'pane', label: 'Side: a panel at the right' },
        { value: 'band', label: 'Bottom: under the spinner' },
        { value: 'off', label: 'Off (only on /monet)' },
      ], v => change($, { show: v as MonetSettings['show'] }))}
      {pick('style', 'Words      ', s.style, [
        { value: 'atelier', label: "Witch's atelier" },
        { value: 'plain', label: 'Plain' },
      ], v => change($, { style: v as MonetSettings['style'] }))}
      {pick('status', 'Status line', s.statusLine ? 'on' : 'off', [
        { value: 'on', label: 'Say what Claude does' },
        { value: 'off', label: 'Off' },
      ], v => change($, { statusLine: v === 'on' }))}
      {pick('look', 'Look       ', s.look, [
        { value: 'auto', label: terminal.hasPixels ? 'Auto (real pixels here)' : 'Auto (mosaic here)' },
        { value: 'half', label: 'Mosaic ▀ (half-blocks)' },
        { value: 'braille', label: 'Dots ⣿ (braille)' },
        { value: 'ascii', label: 'Letters @ (ASCII)' },
        { value: 'pixels', label: 'Real pixels (kitty, Ghostty)' },
      ], v => change($, { look: v as MonetLook }))}
      {pick('fps', 'Speed      ', String(s.fps), [
        { value: '8', label: '8 frames a second (lightest)' },
        { value: '12', label: '12 frames a second' },
        { value: '24', label: '24 frames a second (smoothest)' },
      ], v => change($, { fps: Number(v) }))}
      {pick('play', 'Play       ', s.play, [
        { value: 'always', label: 'Always' },
        { value: 'working', label: 'Only while Claude works' },
      ], v => change($, { play: v as MonetSettings['play'] }))}
      {pick('fit', 'Fit        ', s.fit, [
        { value: 'ambient', label: 'Whole frame, its glow at the sides' },
        { value: 'fit', label: 'Whole frame only' },
        { value: 'fill', label: 'Fill the pane (crop)' },
      ], v => change($, { fit: v as MonetSettings['fit'] }))}
      {pick('hold', 'Next clip  ', String(s.hold), [
        { value: '0', label: 'When the clip ends' },
        { value: '30', label: 'After 30 seconds' },
        { value: '120', label: 'After 2 minutes' },
        { value: '600', label: 'After 10 minutes' },
      ], v => change($, { hold: Number(v) }))}
      {pick('cache', 'Disk space ', String(s.cacheMB), [
        { value: '100', label: 'Up to 100 MB' },
        { value: '300', label: 'Up to 300 MB' },
        { value: '1000', label: 'Up to 1 GB' },
        { value: '5000', label: 'Up to 5 GB' },
      ], v => change($, { cacheMB: Number(v) }))}
      {pick('samples', 'Samples    ', s.samples ? 'yes' : 'no', [
        { value: 'yes', label: 'Include the atelier scenes and Starry Night' },
        { value: 'no', label: 'Only my clips' },
      ], v => change($, { samples: v === 'yes' }))}
      {pick('color', 'Pane color ', s.paneColor.startsWith('#') ? 'custom' : s.paneColor, [
        { value: 'terminal', label: terminalColor ? `Match the terminal (${terminalColor}), with the Monet theme` : 'Match the terminal (type its color below)' },
        { value: 'claude', label: "Claude Code's gray" },
        ...(s.paneColor.startsWith('#') ? [{ value: 'custom', label: `My color (${s.paneColor})` }] : []),
      ], v => (v === 'custom' ? Promise.resolve() : change($, { paneColor: v })))}
      {pick('theme', 'Claude theme', claudeTheme === THEME ? 'on' : 'off', [
        { value: 'on', label: 'Monet: the whole pane in the terminal color' },
        { value: 'off', label: 'Keep my theme' },
      ], v => useTheme($, v === 'on').then(text => $.ui.toast(text)))}
      <Input
        key="hex"
        label="My color   "
        placeholder="#282c34"
        submitLabel="use it"
        onSubmit={v => {
          const hex = parseColor(v.trim().replace(/^([0-9a-f]{6})$/i, '#$1'))
          if (hex) void change($, { paneColor: hex })
        }}
      />
      <Input
        key="folder"
        label="Folder     "
        placeholder={places?.shown ?? '~/Videos/Monet'}
        submitLabel="use it"
        onSubmit={v => void change($, { folder: v.trim() })}
      />
      <Text dimColor wrap="truncate">Now playing: {clips.find(c => c.id === shown.clipId)?.name ?? 'nothing'}</Text>
      <Text dimColor wrap="truncate">
        {terminal.name}: {terminal.hasPixels ? 'real pixels or mosaic' : 'mosaic'} · ffmpeg {hasTools ? 'found' : 'missing'}
      </Text>
      <Box gap={columns >= 48 ? 2 : 0} flexDirection={columns >= 48 ? 'row' : 'column'}>
        <Button key="folder-open" plain hotkey="o" label="open folder" onPress={() => void (places && openFolder($, places))} />
        <Button key="rescan" plain hotkey="r" label="rescan" onPress={() => void rescan($)} />
        <Button key="clear" plain hotkey="c" label="clear cache" onPress={() => void (places && clearCache($, places).then(() => clip && startClip($, clip)))} />
        <Button key="done" plain hotkey="d" variant="primary" label="done" onPress={() => void done()} />
      </Box>
    </Box>
  )
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'monet',
      description: 'Show or hide Monet (next, shuffle, pause, play, side, bottom, theme, theme off, settings, folder, list, or a clip name)',
      argumentHint: '[next | shuffle | pause | play | side | bottom | theme | theme off | settings | folder | list | <clip>]',
    })
    void boot($).catch(err => $.ui.log(`monet: ${errorText(err)}`, { to: 'debug' }))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = null
    await savePosition($).catch(() => undefined)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    // A subagent's turn runs inside the main one: only the first turn sets the goal.
    if (turns.size === 0) {
      const goal = firstLine(e.text)
      if (goal) {
        tasks.clear()
        changed.clear()
      }
      setStatus($, {
        startedAt: Date.now(), endedAt: 0, step: '', agents: 0,
        ...(goal ? { goal, done: 0, total: 0, tools: 0, files: 0, failed: 0 } : {}),
      })
      clockTimer ??= $.clock.every(1000, () => setStatus($, {}))
    }
    turns.add(e.turnId)
    isTurnRunning = true
    syncTimer($)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    turns.delete(e.turnId)
    if (turns.size === 0) {
      clockTimer?.cancel()
      clockTimer = null
      isTurnRunning = false
      setStatus($, { endedAt: Date.now() })
      syncTimer($)
      void refreshSession($).catch(() => undefined)
    }
    return next(e)
  })

  // Every tool call names the step; the agent's task list names the goal.
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const isMain = e.agentId === undefined
    if (isMain) setStatus($, { step: describeTool(e.tool, input, settings.style), tools: status.tools + 1 })
    const path = input.file_path ?? input.notebook_path
    if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(e.tool) && typeof path === 'string') {
      changed.add(path)
      setStatus($, { files: changed.size })
    }
    if (e.tool === 'TodoWrite') {
      const active = e.todos.find(t => t.status === 'in_progress')
      setStatus($, {
        ...(active ? { goal: active.activeForm || active.content } : {}),
        done: e.todos.filter(t => t.status === 'completed').length,
        total: e.todos.length,
      })
    }
    if (e.tool === 'TaskUpdate') {
      const known = tasks.get(e.taskId) ?? { subject: '', status: 'pending' }
      const task = { subject: e.subject ?? known.subject, activeForm: e.activeForm ?? known.activeForm, status: e.status ?? known.status }
      if (task.status === 'deleted') tasks.delete(e.taskId)
      else tasks.set(e.taskId, task)
      setStatus($, { ...(e.status === 'in_progress' ? { goal: task.activeForm || task.subject } : {}), ...countTasks() })
    }
    const isAgent = String(e.tool) === 'Agent' || String(e.tool) === 'Task'
    if (isAgent) setStatus($, { agents: status.agents + 1 })
    try {
      const ran = await next(e)
      if (isMain && ran.isError) setStatus($, { failed: status.failed + 1 })
      if (e.tool === 'TaskCreate') {
        const id = /#?(\d+)/.exec(ran.text ?? '')?.[1]
        if (id) tasks.set(id, { subject: e.subject, activeForm: e.activeForm, status: 'pending' })
        setStatus($, countTasks())
      }
      return ran
    } finally {
      if (isAgent) setStatus($, { agents: Math.max(0, status.agents - 1) })
    }
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (mounted?.site === PANE) mounted = null
    // The person closed it: it stays hidden for this session.
    if (e.origin.kind === 'person' && site === 'pane') {
      await setSite($, 'none')
      $.ui.toast('Monet is hidden. /monet shows it again; /monet settings turns it off for good.')
    }
    return next(e)
  })

  // The answers go to toasts, not the transcript, so the model reads nothing.
  // Monet shows itself, where it is hidden, for "next", "side", "bottom" and a clip's name.
  on('command.run', { command: 'monet' }, async ($, e) => {
    const arg = e.args.trim()
    const word = arg.toLowerCase()
    let shouldShow = false
    if (word === '') {
      shouldShow = site === 'none'
      if (!shouldShow) {
        await setSite($, 'none')
        await $.ui.close({ id: PANE }).catch(() => undefined)
      }
    } else if (word === 'next') {
      await nextClip($)
      shouldShow = true
    } else if (word === 'side' || word === 'bottom') {
      await change($, { show: word === 'side' ? 'pane' : 'band' })
      shouldShow = true
    } else if (word === 'theme' || word === 'theme off') {
      $.ui.toast(await useTheme($, word === 'theme'))
    } else if (word === 'shuffle') {
      await change($, { clip: '*' })
      $.ui.toast(`Monet shuffles ${library.length} clips.`)
    } else if (word === 'pause' || word === 'play') {
      if ((word === 'pause') !== isPaused) await togglePause($)
    } else if (word === 'settings') {
      await openPane($, 'settings')
    } else if (word === 'folder') {
      const isOpened = places ? await openFolder($, places) : false
      $.ui.toast(`${isOpened ? 'Opened' : 'Your Monet folder is'} ${places?.folder ?? ''}`)
    } else if (word === 'list') {
      return {
        text: library.length === 0
          ? `No clips yet. Drop videos in ${places?.shown ?? 'the Monet folder'}.`
          : library.map(c => `${c.name}${c.isSample ? ' (sample)' : ''}`).join('\n'),
      }
    } else {
      // "starry", "starry-night" and "Starry Night" all name the same clip.
      const plain = (text: string) => text.toLowerCase().replace(/[-_\s]+/g, ' ').trim()
      const wanted = plain(arg)
      const match =
        library.find(c => plain(c.name) === wanted) ??
        library.find(c => plain(c.name).startsWith(wanted)) ??
        library.find(c => plain(c.name).includes(wanted))
      if (match) await change($, { clip: match.id })
      else $.ui.toast(`No clip named "${arg}". /monet list shows the clips.`)
      shouldShow = match !== undefined
    }
    if (shouldShow && site === 'none') await show($, true)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view = await read($, viewAtom)
    const s = await read($, settingsAtom)
    const shown = await read($, nowAtom)
    const clips = await read($, libraryAtom)
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Monet plays in the terminal.</Text>
    }
    const ui = $.ui.resolve(e)
    const columns = Math.max(8, e.props.bodyColumns)
    const isDock = e.props.placement === 'dock'
    const bodyRows = Math.max(5, e.props.scroll.bodyRows)
    // Docked, the pane fills its whole height, but Claude Code draws the dock's
    // top and bottom rows itself, in its theme's gray. So the pane takes the
    // terminal's color only with the Monet theme, which paints those rows too.
    const background = isDock && !shown.isThemed ? undefined : paneColor()
    const paint = {
      ...(background ? { backgroundColor: background } : {}),
      ...(isDock ? { height: bodyRows } : {}),
    }
    if (view === 'settings') {
      if (mounted?.site === PANE) mounted = null
      return settingsTree($, ui, s, clips, shown, columns, paint)
    }
    // Inline above the prompt the engine draws a border; docked it draws none, so Monet frames itself.
    return playerTree($, { ui, siteId: PANE, isDock, columns, rows: isDock ? bodyRows : Math.min(bodyRows, 10), shown, s, paint })
  })

  // Claude's spinner says the step ("Inscribing draw.ts… (12s · 300 tokens)"),
  // unless the engine has a message of its own to show there.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const s = await read($, settingsAtom)
    const { step } = await read($, lineAtom)
    if (!s.statusLine || !step || e.props.message !== null) return next(e)
    return next({ ...e, props: { ...e.props, word: step } })
  })

  // The dim hint line under the prompt ends with the status of the work.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const s = await read($, settingsAtom)
    const { tail } = await read($, lineAtom)
    if (!s.statusLine || !tail || e.props.isDraft) return next(e)
    return next({ ...e, props: { ...e.props, tail: `  ${tail}` } })
  })

  // The band above the prompt: Monet where the side pane has no room.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const where = await read($, siteAtom)
    if (where !== 'band' || e.surface !== 'terminal' || e.props.hasSurvey) {
      if (mounted?.site === e.requestId) mounted = null
      return next(e)
    }
    const s = await read($, settingsAtom)
    const shown = await read($, nowAtom)
    // As the first design had it: a row under the spinner, two columns in, the
    // picture at the left and the words at its right.
    const rows = Math.max(4, Math.min(e.props.maxRows - 1, 8))
    const columns = e.props.bodyColumns - 2
    return playerTree($, { ui: $.ui.resolve(e), siteId: e.requestId, isDock: false, columns, rows, shown, s, paint: { paddingTop: 1, paddingLeft: 2 } })
  })
}
