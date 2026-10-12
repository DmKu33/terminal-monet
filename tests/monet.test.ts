import { expect, test } from 'claude-code/testing'

import { DEFAULT_COLOR, drawFrame, fitLayout, makeAmbient, makeSampler } from '../hooks/draw'
import { clipsFrom, clipsToTrim, metaFrom, pixelsPath, placesFrom, playedPieces, removeArgv } from '../hooks/library'
import { IDLE, describeTool, duration, statusLineText, statusLines, textCells } from '../hooks/status'
import { terminalFrom, themeFor } from '../hooks/terminal'

const PANE_PROPS = {
  title: 'Monet',
  isFocused: false,
  bodyColumns: 48,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

// The words of a Raster's cells: a glyph, a foreground and a background for each cell.
const wordsOf = (cells: string) => new Uint32Array(Uint8Array.fromBase64(cells).buffer)

test('a wide clip fits a narrow pane by its width', async () => {
  const layout = fitLayout({ columns: 48, rows: 30 }, { width: 96, height: 54 }, 'fit')
  expect(layout.columns).toBe(48)
  expect(layout.rows).toBe(14)
})

test('fill uses the whole pane and crops the sides', async () => {
  const layout = fitLayout({ columns: 48, rows: 30 }, { width: 96, height: 54 }, 'fill')
  expect(layout.columns).toBe(48)
  expect(layout.rows).toBe(30)
  expect(layout.cropH).toBe(54)
  expect(layout.cropW < 96).toBe(true)
})

test('a half-block cell takes the top pixel as text color and the bottom as background', async () => {
  // A 1x2 frame: red above blue.
  const data = new Uint8Array([255, 0, 0, 0, 0, 255])
  const layout = fitLayout({ columns: 1, rows: 1 }, { width: 1, height: 2 }, 'fit')
  const words = drawFrame(makeSampler('half', layout, { width: 1, height: 2 }), data, 0)
  expect(Array.from(words)).toEqual([0x2580, 0xff0000, 0x0000ff])
})

test('ambient fill keeps the whole frame in the middle and a dim copy at the sides', async () => {
  // A 2x2 white frame in a room 6 cells wide and 1 row tall: the frame takes 2 cells.
  const data = new Uint8Array(2 * 2 * 3).fill(255)
  const s = makeAmbient({ columns: 6, rows: 1 }, { width: 2, height: 2 })
  expect([s.layout.columns, s.layout.rows, s.inset, s.front?.layout.columns]).toEqual([6, 1, 2, 2])
  const words = drawFrame(s, data, 0)
  expect(words[1]).toBe(0x4c4c4c)
  expect(words[2 * 3 + 1]).toBe(0xffffff)
})

test('a black frame in braille draws no dots', async () => {
  const data = new Uint8Array(2 * 4 * 3)
  const layout = { columns: 1, rows: 1, cropX: 0, cropY: 0, cropW: 2, cropH: 4 }
  const words = drawFrame(makeSampler('braille', layout, { width: 2, height: 4 }), data, 0)
  expect(Array.from(words)).toEqual([0x20, DEFAULT_COLOR, DEFAULT_COLOR])
})

test('the folder lists videos, GIFs and pictures, and skips the rest', async () => {
  const clips = clipsFrom(
    [
      { name: 'starry_night.mp4', kind: 'file' },
      { name: 'cat.gif', kind: 'file' },
      { name: 'README.txt', kind: 'file' },
      { name: '.cache', kind: 'dir' },
    ],
    '/home/a/.claude/monet',
    false,
  )
  expect(clips.map(c => c.name)).toEqual(['Cat', 'Starry Night'])
  expect(clips[1]?.id).toBe('u-starry-night-mp4')
})

test('a two-hour movie is cut into pieces that each fit one read', async () => {
  const probe = JSON.stringify({ streams: [{ width: 1920, height: 1080 }], format: { duration: '7200' } })
  const meta = metaFrom(probe, { path: '/v/movie.mkv', size: 1, mtimeMs: 1 }, 12)
  expect(meta.width).toBe(96)
  expect(meta.height).toBe(54)
  expect(meta.totalFrames).toBe(86_400)
  expect(meta.framesPerPiece * meta.width * meta.height * 3 <= 4 * 1024 * 1024).toBe(true)
  expect(meta.pieces).toBe(Math.ceil(86_400 / meta.framesPerPiece))
})

test('a picture is one frame', async () => {
  const probe = JSON.stringify({ streams: [{ width: 640, height: 480 }], format: {} })
  const meta = metaFrom(probe, { path: '/v/sunset.png', size: 1, mtimeMs: 1 }, 12)
  expect(meta.isStill).toBe(true)
  expect(meta.totalFrames).toBe(1)
})

test('real-pixel frames are numbered inside their piece', async () => {
  const places = placesFrom('/home/a', undefined, false, '/home/a/Videos/Monet')
  const probe = JSON.stringify({ streams: [{ width: 1920, height: 1080 }], format: { duration: '60' } })
  const meta = metaFrom(probe, { path: '/v/a.mp4', size: 1, mtimeMs: 1 }, 12)
  const clip = { id: 'u-a-mp4', name: 'A', file: '/v/a.mp4', isSample: false }
  expect(pixelsPath(places, clip, meta, meta.framesPerPiece)).toBe(
    '/home/a/.claude/monet/.cache/u-a-mp4/12fps/p0001/0001.png',
  )
})

test('the cache trim deletes the clips played longest ago, never the one playing', async () => {
  const MB = 1024 * 1024
  const clips = [
    { id: 'old', bytes: 200 * MB, newest: 1 },
    { id: 'playing', bytes: 200 * MB, newest: 0 },
    { id: 'new', bytes: 200 * MB, newest: 3 },
  ]
  expect(clipsToTrim(clips, 300, 'playing')).toEqual({ ids: ['old', 'new'], over: 0 })
  expect(clipsToTrim(clips, 1000, 'playing')).toEqual({ ids: [], over: 0 })
  expect(clipsToTrim(clips, 100, 'playing')).toEqual({ ids: ['old', 'new'], over: 100 * MB })
})

test('a long movie over the limit drops the pieces it already played', async () => {
  const probe = JSON.stringify({ streams: [{ width: 1920, height: 1080 }], format: { duration: '7200' } })
  const meta = { ...metaFrom(probe, { path: '/v/movie.mkv', size: 1, mtimeMs: 1 }, 12), done: [0, 1, 2, 3, 4], donePixels: [3] }
  expect(playedPieces(meta, 4)).toEqual([0, 1, 2])
  expect(playedPieces(meta, 1)).toEqual([])
})

test('Monet deletes only inside its cache', async () => {
  const places = placesFrom('/home/a', undefined, false, '/home/a/Videos/Monet')
  expect(removeArgv(places, '/home/a/.claude/monet/.cache/u-a')).toEqual(['rm', '-rf', '/home/a/.claude/monet/.cache/u-a'])
  expect(removeArgv(places, '/home/a/.claude/monet')).toBe(undefined)
  expect(removeArgv(places, '/home/a/.claude/monet/.cache/../../x')).toBe(undefined)
  const windows = placesFrom('C:\\Users\\a', undefined, true, 'C:\\Users\\a\\Videos\\Monet')
  expect(removeArgv(windows, 'C:/Users/a/.claude/monet/.cache/u-a/12fps/m0001.rgb', false)).toEqual(
    ['cmd', '/c', 'del', '/q', 'C:\\Users\\a\\.claude\\monet\\.cache\\u-a\\12fps\\m0001.rgb'],
  )
})

test('the clips sit in plain sight, the cache in the Claude config folder, on every OS', async () => {
  const mac = placesFrom('/Users/a', undefined, false, '/Users/a/Movies/Monet')
  expect(mac).toEqual({
    folder: '/Users/a/Movies/Monet', cache: '/Users/a/.claude/monet/.cache', config: '/Users/a/.claude', shown: '~/Movies/Monet', isWindows: false,
  })
  expect(placesFrom('C:\\Users\\a', undefined, true, 'C:\\Users\\a\\Videos\\Monet').folder).toBe('C:/Users/a/Videos/Monet')
  expect(placesFrom('/home/a', '/data/claude', false, '~/Desktop/clips/').folder).toBe('/home/a/Desktop/clips')
  expect(placesFrom('/home/a', '/data/claude', false, '~/Desktop/clips').cache).toBe('/data/claude/monet/.cache')
})

test('the Monet theme paints the side pane in the terminal color, on the matching base', async () => {
  expect(JSON.parse(themeFor('#300a24'))).toEqual({ name: 'Monet', base: 'dark', overrides: { composerSidebarBackground: '#300a24' } })
  expect(JSON.parse(themeFor('#fdf6e3')).base).toBe('light')
})

test('kitty and Ghostty get real pixels, other terminals and tmux get the mosaic', async () => {
  expect(terminalFrom({ TERM: 'xterm-ghostty' }).hasPixels).toBe(true)
  expect(terminalFrom({ TERM: 'xterm-kitty' }).hasPixels).toBe(true)
  expect(terminalFrom({ TERM: 'xterm-kitty', TMUX: '/tmp/tmux' }).hasPixels).toBe(false)
  expect(terminalFrom({ TERM: 'xterm-256color', VTE_VERSION: '7600' })).toEqual({ name: 'GNOME Terminal', hasPixels: false })
})

test('a tool call reads as a short step', async () => {
  expect(describeTool('Edit', { file_path: '/repo/hooks/draw.ts' }, 'plain')).toBe('Editing draw.ts')
  expect(describeTool('Edit', { file_path: '/repo/hooks/draw.ts' }, 'atelier')).toBe('Inscribing draw.ts')
  expect(describeTool('Bash', { command: 'npm test -- --watch', description: 'Run the tests' }, 'plain')).toBe('Run the tests')
  expect(describeTool('Bash', { command: 'npm test -- --watch', description: 'Run the tests' }, 'atelier')).toBe('Brewing: Run the tests')
  expect(describeTool('Bash', { command: 'npm test -- --watch' }, 'plain')).toBe('Running npm test --')
  expect(describeTool('mcp__github__create_issue', {}, 'plain')).toBe('Using github create_issue')
})

test('the words under the picture say the goal, the step and the time', async () => {
  const working = { ...IDLE, goal: 'Fix the pane colors', step: 'Editing draw.ts', startedAt: 1000, done: 2, total: 5, agents: 1, files: 2, tools: 9 }
  expect(statusLines(working, 42_000, 40, 'plain').map(l => l.text)).toEqual([
    'Fix the pane colors',
    'Editing draw.ts',
    '41s · task 3 of 5 · 1 agent · 2 files',
  ])
  const done = { ...working, endedAt: 73_000, failed: 1 }
  expect(statusLines(done, 99_000, 40, 'plain').map(l => l.text)).toEqual(['Fix the pane colors', 'Done', 'took 1m 12s · task 3 of 5 · 1 agent · 2 files · 1 failed'])
  expect(statusLines(IDLE, 0, 40, 'plain').map(l => l.text)).toEqual(['Waiting for a prompt'])
  expect(duration(3_723_000)).toBe('1h 02m')
  expect(duration((701 * 60 + 56) * 60_000)).toBe('29d 05h')
})

test('the atelier says it with a moon and familiars', async () => {
  const working = { ...IDLE, goal: 'Fix the pane colors', step: 'Inscribing draw.ts', startedAt: 1000, agents: 2 }
  expect(statusLines(working, 42_000, 21, 'atelier', { isTall: true }).map(l => l.text)).toEqual([
    '☽ Fix the pane colors',
    'Inscribing draw.ts',
    '41s · 2 familiars',
  ])
  expect(statusLineText({ ...working, tools: 9 }, 42_000, 'atelier')).toBe('☽ Fix the pane colors › Inscribing draw.ts · 41s · 2 familiars · 9 tools')
  expect(statusLineText(IDLE, 0, 'plain')).toBe('')
})

test('a tall box ends with the session stats, a short one with one line of them', async () => {
  const session = {
    model: 'Opus 5.5', prompts: 14, startedAt: 0, contextPercent: 38.2, contextWindow: 200_000,
    limits: [{ kind: 'five_hour', percentUsed: 42 }, { kind: 'seven_day', percentUsed: 12.5 }], usd: 1.844,
  }
  const tall = statusLines(IDLE, 4_320_000, 30, 'plain', { isTall: true, session })
  expect(tall.map(l => `${l.label ?? ''}|${l.meter ?? ''}|${l.text}`)).toEqual([
    '||Waiting for a prompt',
    '||',
    'Model||Opus 5.5',
    'Session||1h 12m',
    'Prompts||14',
    'Context|0.382|38% of 200k',
    '5-hour|0.42|42%',
    'Weekly|0.125|13%',
    'Cost||$1.84',
  ])
  expect(statusLines(IDLE, 4_320_000, 30, 'plain', { session }).at(-1)?.text).toBe('Opus 5.5 · ctx 38% · 1h 12m')
})

test('a tall side panel lists the last steps in the middle and keeps the stats at the bottom', async () => {
  const session = {
    model: 'Opus 5', prompts: 3, startedAt: 0, contextPercent: 26, contextWindow: 1_000_000,
    limits: [], usd: 0.5,
  }
  const working = { ...IDLE, goal: 'Fix the cache', step: 'Reading draw.ts', startedAt: 90_000 }
  const recent = [
    { text: 'Reading draw.ts', at: 96_000 },
    { text: 'Editing status.ts', at: 60_000 },
    { text: 'Running npm test', at: 0 },
  ]
  const lines = statusLines(working, 100_000, 28, 'plain', { isTall: true, rows: 16, recent, session })
  expect(lines.length).toBe(16)
  expect(lines.slice(0, 3).map(l => l.text)).toEqual(['Fix the cache', 'Reading draw.ts', '10s'])
  expect(lines.slice(4, 8).map(l => l.text)).toEqual([
    'Recent',
    '· Reading draw.ts         4s',
    '· Editing status.ts      40s',
    '· Running npm test        1m',
  ])
  expect(lines.at(-1)?.text).toBe('$0.50')
  // With no room to spare, the steps make way for the stats.
  expect(statusLines(working, 100_000, 28, 'plain', { isTall: true, rows: 9, recent, session }).some(l => l.text === 'Recent')).toBe(false)
})

test('a long goal wraps to two lines and ends with an ellipsis', async () => {
  const lines = statusLines({ ...IDLE, goal: 'make the pane take the color of the terminal theme', startedAt: 1 }, 2, 20, 'plain')
  expect(lines[0]?.text).toBe('make the pane take')
  expect(lines[1]?.text.endsWith('…')).toBe(true)
})

test('a meter fills with heavy lines and turns red from 90%', async () => {
  const words = wordsOf(textCells([{ label: 'Context', meter: 0.95, text: '95%', color: DEFAULT_COLOR }], 24, 1))
  const text = Array.from({ length: 24 }, (_, c) => String.fromCodePoint(words[c * 3]!)).join('')
  expect(text).toBe('Context  ━━━━━━━━━━ 95% ')
  expect(words[9 * 3 + 1]).toBe(0xe0605a)
})

test('the words use the terminal background, and wide characters become ?', async () => {
  const words = wordsOf(textCells([{ text: 'a猫', color: 0xd8b45f }], 3, 1))
  expect(Array.from(words)).toEqual([0x61, 0xd8b45f, DEFAULT_COLOR, 0x3f, 0xd8b45f, DEFAULT_COLOR, 0x20, 0xd8b45f, DEFAULT_COLOR])
})

test('the pane draws its controls before a clip is ready', async $ => {
  const ui = await $.ui.mount({ plugin: 'monet', surface: 'terminal', component: 'Pane', requestId: 'monet', props: PANE_PROPS })
  expect(await ui.find({ key: 'next' })).toBeDefined()
  expect(await ui.find({ key: 'settings' })).toBeDefined()
  await ui.press({ key: 'settings' })
  expect(await ui.find({ key: 'look' })).toBeDefined()
  await ui.press({ key: 'done' })
  expect(await ui.find({ key: 'next' })).toBeDefined()
  await ui.unmount()
})

test('the pane says the mosaic is for the terminal on other surfaces', async $ => {
  const ui = await $.ui.mount({ plugin: 'monet', surface: 'desktop', component: 'Pane', requestId: 'monet', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /terminal/ })).toBeDefined()
  await ui.unmount()
})
