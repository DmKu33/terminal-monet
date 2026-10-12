// Which terminal Claude Code runs in, from the environment it set. Only the
// name and whether it draws real pixels (the kitty graphics protocol) matter.
// register.tsx reads the variables; this file only decides.

import { luma } from './draw'

type TerminalEnv = {
  TERM?: string
  TERM_PROGRAM?: string
  TMUX?: string
  KITTY_WINDOW_ID?: string
  GHOSTTY_RESOURCES_DIR?: string
  VTE_VERSION?: string
}

export type TerminalInfo = { name: string; hasPixels: boolean }

/** A color as `#rrggbb`, from `#RRGGBB` or `rgb(r, g, b)` in a text; undefined with none. */
export function parseColor(text: string): string | undefined {
  const hex = /#([0-9a-f]{6})\b/i.exec(text)
  if (hex) return `#${hex[1]!.toLowerCase()}`
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(text)
  return rgb ? `#${rgb.slice(1, 4).map(n => Number(n).toString(16).padStart(2, '0')).join('')}` : undefined
}

/**
 * A Claude Code theme that keeps the dark (or light) one and paints its side
 * pane, the dock's own rows too, in `color`: what a mod cannot paint itself.
 */
export function themeFor(color: string): string {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)) as [number, number, number]
  const base = luma(r, g, b) > 0.5 ? 'light' : 'dark'
  return `${JSON.stringify({ name: 'Monet', base, overrides: { composerSidebarBackground: color } }, null, 2)}\n`
}

export function terminalFrom(env: TerminalEnv): TerminalInfo {
  const term = env.TERM ?? ''
  const program = env.TERM_PROGRAM ?? ''
  const inTmux = env.TMUX !== undefined
  const isKitty = term === 'xterm-kitty' || env.KITTY_WINDOW_ID !== undefined
  const isGhostty = program === 'ghostty' || term === 'xterm-ghostty' || env.GHOSTTY_RESOURCES_DIR !== undefined
  let name = program || term || 'terminal'
  if (isKitty) name = 'kitty'
  else if (isGhostty) name = 'Ghostty'
  else if (env.VTE_VERSION !== undefined) name = 'GNOME Terminal'
  if (inTmux) name += ' in tmux'
  // tmux does not pass the pictures through, so a mosaic is drawn there.
  return { name, hasPixels: (isKitty || isGhostty) && !inTmux }
}
