// What Claude is doing, as Monet says it: under the picture, and in the
// status line under the prompt. Pure code; register.tsx feeds it events.

import { DEFAULT_COLOR } from './draw'

export type Status = {
  /** The task in progress, or the prompt that started the work. */
  goal: string
  /** The tool call that runs now, in words. */
  step: string
  startedAt: number
  /** 0 while Claude works. */
  endedAt: number
  /** Tasks done and in all, from the agent's own task list; total 0 with no list. */
  done: number
  total: number
  /** Subagents that run now. */
  agents: number
  /** Since the prompt: tool calls, files changed, calls that failed. */
  tools: number
  files: number
  failed: number
}

export const IDLE: Status = {
  goal: '', step: '', startedAt: 0, endedAt: 0, done: 0, total: 0, agents: 0, tools: 0, files: 0, failed: 0,
}

type Style = 'atelier' | 'plain'

// One word list for each style. The atelier is the witch's workshop.
const WORDS = {
  plain: {
    read: 'Reading', edit: 'Editing', write: 'Writing', run: 'Running', grep: 'Searching for',
    glob: 'Finding', fetch: 'Reading', web: 'Searching the web for', agent: 'Starting an agent:',
    skill: 'Using the skill', use: 'Using', thinking: 'Thinking', done: 'Done', waiting: 'Waiting for a prompt',
    agents: ['agent', 'agents'], took: 'took', mark: '',
  },
  atelier: {
    read: 'Studying', edit: 'Inscribing', write: 'Penning', run: 'Brewing:', grep: 'Scrying for',
    glob: 'Seeking', fetch: 'Consulting', web: 'Scrying the web for', agent: 'Summoning a familiar:',
    skill: 'Opening the grimoire:', use: 'Calling on', thinking: 'Pondering', done: 'The spell is cast',
    waiting: 'The atelier is quiet', agents: ['familiar', 'familiars'], took: 'in', mark: '☽ ',
  },
}

const GOLD = 0xd8b45f
const AMBER = 0xe0904a
const RED = 0xe0605a
const MUTED = 0x8a8494
const TRACK = 0x5a5464
const METER_WIDTH = 10
const LABEL_WIDTH = 9

/** The first line of a text, cut to `max` characters. */
export const firstLine = (text: string, max = 160) => {
  const line = text.trim().split('\n')[0]!.trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const fileName = (path: unknown) => String(path ?? '').split(/[\\/]/).pop()

/** A tool call in a few words: "Editing draw.ts", or "Inscribing draw.ts" in the atelier. */
export function describeTool(tool: string, input: Record<string, unknown>, style: Style): string {
  const w = WORDS[style]
  switch (tool) {
    case 'Read':
      return `${w.read} ${fileName(input.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `${w.edit} ${fileName(input.file_path)}`
    case 'Write':
      return `${w.write} ${fileName(input.file_path)}`
    case 'NotebookEdit':
      return `${w.edit} ${fileName(input.notebook_path)}`
    case 'Bash': {
      const what = String(input.description || String(input.command ?? '').split(/\s+/).slice(0, 3).join(' '))
      return firstLine(style === 'plain' && input.description ? what : `${w.run} ${what}`)
    }
    case 'Grep':
      return `${w.grep} ${firstLine(String(input.pattern ?? ''), 40)}`
    case 'Glob':
      return `${w.glob} ${input.pattern}`
    case 'WebFetch':
      return `${w.fetch} ${String(input.url ?? '').replace(/^https?:\/\/([^/]+).*$/, '$1')}`
    case 'WebSearch':
      return `${w.web} ${input.query}`
    case 'Agent':
    case 'Task':
      return `${w.agent} ${input.description ?? ''}`
    case 'Skill':
      return `${w.skill} ${input.skill}`
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return mcp ? `${w.use} ${mcp[1]} ${mcp[2]}` : `${w.use} ${tool}`
}

/** The word for Claude's spinner: the step, or empty to keep the engine's own. */
export const spinnerWord = (s: Status, style: Style) => (s.endedAt === 0 && s.startedAt > 0 ? s.step || WORDS[style].thinking : '')

/** "41s", "3m 05s", "1h 02m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

// The time, the tasks and the counters, joined with dots.
function facts(s: Status, now: number, style: Style, withTools: boolean): string {
  const w = WORDS[style]
  const isWorking = s.endedAt === 0
  const out = [isWorking ? duration(now - s.startedAt) : `${w.took} ${duration(s.endedAt - s.startedAt)}`]
  if (s.total > 0) out.push(`task ${Math.min(s.done + 1, s.total)} of ${s.total}`)
  if (s.agents > 0) out.push(`${s.agents} ${w.agents[s.agents === 1 ? 0 : 1]}`)
  if (s.files > 0) out.push(s.files === 1 ? '1 file' : `${s.files} files`)
  if (withTools && s.tools > 0) out.push(s.tools === 1 ? '1 tool' : `${s.tools} tools`)
  if (s.failed > 0) out.push(`${s.failed} failed`)
  return out.join(' · ')
}

/** The status line under the prompt; empty before the first prompt. */
export function statusLineText(s: Status, now: number, style: Style): string {
  if (s.startedAt === 0) return ''
  const w = WORDS[style]
  const step = s.endedAt === 0 ? s.step || w.thinking : w.done
  return `${w.mark}${firstLine(s.goal || 'Working', 48)} › ${step} · ${facts(s, now, style, true)}`
}

/**
 * A line of words: `label` (muted, in a column of its own), then a `meter`
 * (0 to 1) when it has one, then `text` in `color`.
 */
type Line = { text: string; color: number; label?: string; meter?: number }

/** The session's figures, as Claude Code's own status line has them. */
export type SessionStats = {
  model: string
  prompts: number
  startedAt: number
  contextPercent?: number
  contextWindow?: number
  limits: readonly { kind: string; percentUsed: number }[]
  usd?: number
}

const thousands = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
const LIMIT_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly' }

/** The stats block: one figure a row, its name in the label column, a meter for what fills up. */
export function sessionLines(stats: SessionStats, now: number): Line[] {
  const out: Line[] = [
    { label: 'Model', text: stats.model, color: DEFAULT_COLOR },
    { label: 'Session', text: duration(now - stats.startedAt), color: DEFAULT_COLOR },
    { label: 'Prompts', text: String(stats.prompts), color: DEFAULT_COLOR },
  ]
  if (stats.contextPercent !== undefined) {
    const of = stats.contextWindow ? ` of ${thousands(stats.contextWindow)}` : ''
    out.push({ label: 'Context', meter: stats.contextPercent / 100, text: `${Math.round(stats.contextPercent)}%${of}`, color: DEFAULT_COLOR })
  }
  for (const l of stats.limits) {
    out.push({ label: LIMIT_NAMES[l.kind] ?? l.kind, meter: l.percentUsed / 100, text: `${Math.round(l.percentUsed)}%`, color: DEFAULT_COLOR })
  }
  if (stats.usd !== undefined && stats.usd > 0) {
    out.push({ label: 'Cost', text: stats.usd < 0.01 ? 'under $0.01' : `$${stats.usd.toFixed(2)}`, color: DEFAULT_COLOR })
  }
  return out
}

// The stats in one line, for a short box: "Opus 5.5 · ctx 38% · 1h 12m".
function sessionLine(stats: SessionStats, now: number): Line {
  const parts = [stats.model]
  if (stats.contextPercent !== undefined) parts.push(`ctx ${Math.round(stats.contextPercent)}%`)
  parts.push(duration(now - stats.startedAt))
  return { text: parts.join(' · '), color: MUTED }
}

// Cuts a text into lines of `width`, at spaces where it can.
function wrap(text: string, width: number, max: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest && out.length < max) {
    if (rest.length <= width) {
      out.push(rest)
      return out
    }
    const cut = rest.lastIndexOf(' ', width)
    const at = cut > width / 2 ? cut : width
    out.push(rest.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  if (rest && out.length > 0) out[out.length - 1] = `${out[out.length - 1]!.slice(0, width - 1)}…`
  return out
}

type LinesOptions = {
  /** A tall box (the docked pane): the full stats block last. */
  isTall?: boolean
  session?: SessionStats
  /** The clip's name, first in gold, where no frame carries it (the band). */
  title?: string
}

/** The words beside or under the picture, for a box `width` cells wide. */
export function statusLines(s: Status, now: number, width: number, style: Style, options: LinesOptions = {}): Line[] {
  const w = WORDS[style]
  const { isTall = false, session, title } = options
  const out: Line[] = []
  if (title) out.push({ text: `${w.mark}${title}`, color: GOLD })
  if (s.startedAt === 0) out.push({ text: w.waiting, color: MUTED })
  else {
    // Under a title the goal reads as plain words; alone it leads in gold.
    const goal = title ? s.goal || 'Working' : `${w.mark}${s.goal || 'Working'}`
    out.push(...wrap(goal, width, title ? 1 : 2).map(text => ({ text, color: title ? DEFAULT_COLOR : GOLD })))
    out.push({ text: s.endedAt === 0 ? s.step || w.thinking : w.done, color: DEFAULT_COLOR })
    out.push({ text: facts(s, now, style, false), color: MUTED })
  }
  if (session) {
    out.push({ text: '', color: MUTED })
    out.push(...(isTall ? sessionLines(session, now) : [sessionLine(session, now)]))
  }
  return out
}

// A Raster takes width-1 characters only: wide ones (CJK, emoji) become "?".
const isNarrow = (cp: number) =>
  (cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp < 0x0530) || (cp >= 0x2000 && cp < 0x2600) || '☽✦'.includes(String.fromCodePoint(cp))

/**
 * Raster cells that write `lines` from the top left, in the background of
 * what holds them, so the pane takes the color of the pane's box.
 */
export function textCells(lines: readonly Line[], columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let r = 0; r < rows; r++) {
    const line = lines[r]
    const label = line?.label === undefined ? '' : line.label.padEnd(LABEL_WIDTH)
    // A meter: heavy line for what is used, light line for the rest; amber from 75%, red from 90%.
    const fill = line?.meter === undefined ? 0 : Math.round(Math.min(1, Math.max(0, line.meter)) * METER_WIDTH)
    const meter = line?.meter === undefined ? '' : `${'━'.repeat(fill)}${'─'.repeat(METER_WIDTH - fill)} `
    const level = (line?.meter ?? 0) >= 0.9 ? RED : (line?.meter ?? 0) >= 0.75 ? AMBER : GOLD
    const chars = line ? Array.from(`${label}${meter}${line.text}`.slice(0, columns * 2)) : []
    for (let c = 0; c < columns; c++) {
      const i = (r * columns + c) * 3
      const cp = chars[c]?.codePointAt(0) ?? 0x20
      const m = c - label.length
      words[i] = c === columns - 1 && chars.length > columns ? 0x2026 : isNarrow(cp) ? cp : 0x3f
      words[i + 1] =
        c < label.length ? MUTED : m < fill ? level : m < METER_WIDTH && meter ? TRACK : (line?.color ?? DEFAULT_COLOR)
      words[i + 2] = DEFAULT_COLOR
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}
