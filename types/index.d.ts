// The values Monet keeps in `$.state` for the session. The settings are also
// kept in `$.store`, so they last between sessions.

/** How a frame is drawn. `auto` picks `pixels` where the terminal can. */
export type MonetLook = 'auto' | 'half' | 'braille' | 'ascii' | 'pixels'

export type MonetSettings = {
  /** The clip to play: its id, or `*` to shuffle the whole folder. */
  clip: string
  look: MonetLook
  /** Frames per second: 8, 12 or 24. */
  fps: number
  /** `always`, or only `working` (while Claude works; a still frame between turns). */
  play: 'always' | 'working'
  /**
   * `ambient` shows the whole frame and fills the sides with a dim enlarged
   * copy; `fit` shows the whole frame alone; `fill` crops it to fill the pane.
   */
  fit: 'ambient' | 'fit' | 'fill'
  /**
   * Seconds each clip gets when shuffling: a short clip loops until then, a
   * long one stops there. 0 plays each clip once, to its end.
   */
  hold: number
  /** The most disk space the converted frames may take, in megabytes. */
  cacheMB: number
  /**
   * Where Monet shows itself at start: `auto` (the side pane where it has
   * room, else the band above the prompt), `pane`, `band`, or `off` (only on
   * /monet).
   */
  show: 'auto' | 'pane' | 'band' | 'off'
  /** The words: `atelier` (the witch's workshop) or `plain`. */
  style: 'atelier' | 'plain'
  /** Also say what Claude does in Claude Code's status line. */
  statusLine: boolean
  /** The clip folder; empty for the default, `Monet` in the Videos folder. */
  folder: string
  /**
   * Include the six clips that ship with Monet: Starry Night and the atelier
   * scenes (Cauldron, Scrying Orb, Spellbook, Wisps, Bonfire).
   */
  samples: boolean
  /**
   * The pane's background: `terminal` (the color Monet finds in the
   * terminal's settings), `claude` (Claude Code's own), or a `#rrggbb` color.
   */
  paneColor: string
}

export type MonetClip = {
  /** The cache folder's name: the file name, made safe. */
  id: string
  /** What the pane shows: the file name without its extension. */
  name: string
  /** The absolute path of the video, GIF or picture. */
  file: string
  isSample: boolean
  /** Set once ffprobe or ffmpeg could not read it. */
  isFailed?: true
}

export type MonetView = 'player' | 'settings'

/** Where Monet draws now. */
export type MonetSite = 'pane' | 'band' | 'none'

/** What Claude's own lines say: the spinner's word, and the tail of the hint under the prompt. */
export type MonetLine = { step: string; tail: string }

export type MonetNow = {
  /** The clip on show, or null with none ready. */
  clipId: string | null
  /** The size of the clip's frames, in pixels. */
  width: number
  height: number
  /** A line under the picture: what plays, or what is wrong. */
  caption: string
  isPaused: boolean
  /** The look in use after `auto` and fallbacks resolved. */
  look: Exclude<MonetLook, 'auto'>
  /** Whether Claude Code uses the Monet theme, which paints the dock's own rows too. */
  isThemed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    monet: {
      settings: MonetSettings
      library: MonetClip[]
      view: MonetView
      site: MonetSite
      line: MonetLine
      now: MonetNow
    }
  }
}
