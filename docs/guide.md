# Terminal Monet: the full guide

Monet is a mod for [Claude Code](https://claude.com/claude-code). It plays your videos as a color mosaic beside the conversation, and it says what Claude works on now. Drop videos in a folder, start Claude Code, and Monet plays them. You type nothing.

- **Any video:** mp4, webm, mov, mkv, GIF, or a still picture. Any length, a full movie too.
- **Any terminal:** a full-color mosaic everywhere, real pixels in kitty and Ghostty.
- **Any OS:** Linux, macOS and Windows. The only extra tool is ffmpeg.
- **Says what Claude does:** the goal, the step that runs now and the time, under the picture and in Claude's own status lines.
- **A witch's atelier:** six animated scenes ship with it, and the words can speak like a workshop of spells. Plain words are one setting away.
- **Light:** frames are converted in small pieces, only when they play. The disk space has a limit that you set.

## Install

1. Install ffmpeg, if you do not have it:

   | OS | Command |
   | --- | --- |
   | Ubuntu, Debian | `sudo apt install ffmpeg` |
   | Fedora | `sudo dnf install ffmpeg` |
   | Arch | `sudo pacman -S ffmpeg` |
   | macOS | `brew install ffmpeg` |
   | Windows | `winget install ffmpeg` |

2. In Claude Code, type:

   ```
   /plugin install monet --marketplace DmKu33/terminal-monet
   ```

   Answer `y` to add the marketplace. Then pick the user scope with Enter.

3. Start a new Claude Code session. Monet shows itself and plays the samples.

## Your clips

Drop videos, GIFs or pictures in the **Monet** folder in your Videos folder:

| OS | Folder |
| --- | --- |
| Linux | `~/Videos/Monet` (the Videos folder in your language) |
| macOS | `~/Movies/Monet` |
| Windows | `Videos\Monet` in your user folder |

Monet makes the folder the first time it starts. It finds new files within 20 seconds and shuffles all the clips. To use another folder, type its path in `/monet settings` → **Folder**.

## Where Monet shows itself

Monet shows itself when the session starts. You do not type `/monet`.

- **Side:** a panel at the right, in a wide terminal (144 columns or more, or 110 after you opened it once). The picture is on top and the words are under it. Drag the panel's edge to make it wider or narrower. `/monet side` keeps it there.
- **Bottom:** a strip under the spinner, in a narrower terminal. The picture is on the left, the words in the middle, and the stats at the right, as in the first design. `/monet bottom` keeps it there.

To hide it, click `×` on the side panel or `[-]` on the bottom strip, or type `/monet`. To keep it off, set **Show** to **Off** in `/monet settings`.

To use the keys, click the panel or the strip, or press Ctrl+X, then Tab. Then press `p` to pause, `n` for the next clip, and `s` for the settings.

## What Monet says

Monet draws a frame with the clip's name in its border. Under the picture, it says what Claude is doing, and the figures of the session. It updates by itself:

```
╭─ ☽ Cauldron ──────────────────────╮
│  (the picture)                     │
├──────────────── ✦ ─────────────────┤
│ ☽ Fix the pane colors              │  ← the goal: the task in progress, or your prompt
│ Inscribing register.tsx            │  ← the step that runs now
│ 1m 12s · task 3 of 5 · 2 files     │  ← the time, the tasks, the subagents, the files changed
│                                    │
│ Model    Opus 5.5                  │
│ Session  2h 51m                    │
│ Prompts  14                        │
│ Context  ━━━━━━──── 63% of 1M      │  ← the meters turn amber at 75% and red at 90%
│ 5-hour   ━───────── 10%            │
│ Weekly   ━───────── 12%            │
│ Cost     $28.52                    │
│ p: pause  n: next  s: settings     │
╰────────────────────────────────────╯
```

The goal comes from Claude's own task list when it has one. Otherwise it is the first line of your prompt. When the turn ends, Monet says "The spell is cast" and how long it took. The bottom strip shows the same: the stats in a column at the right, or on one line when the terminal is narrow (`Opus 5.5 · ctx 38% · 1h 12m`).

Monet also writes into Claude Code's own lines:

- **The spinner** says the step instead of a random word: `✻ Inscribing register.tsx… (12s · 300 tokens)`.
- **The dim line under the prompt** ends with the whole status: the goal, the step, the time, the tasks, the subagents, the files changed, the tool calls and the failures.

The **Words** setting picks the voice:

| Claude does | Witch's atelier | Plain |
| --- | --- | --- |
| Thinks | Pondering | Thinking |
| Reads a file | Studying draw.ts | Reading draw.ts |
| Edits a file | Inscribing draw.ts | Editing draw.ts |
| Runs a command | Brewing: Run the tests | Run the tests |
| Searches | Scrying for blit | Searching for blit |
| Starts a subagent | Summoning a familiar | Starting an agent |
| Ends the turn | The spell is cast | Done |

## Commands

You need no command to start Monet. A command answers in a short toast, if at all, so it adds nothing that the model reads.

| Command | What it does |
| --- | --- |
| `/monet` | Shows or hides Monet. |
| `/monet next` | Plays the next clip. |
| `/monet cauldron` | Plays the clip whose name starts with "cauldron". |
| `/monet shuffle` | Shuffles all the clips again. |
| `/monet pause`, `/monet play` | Stops or starts the picture. |
| `/monet side`, `/monet bottom` | Shows Monet as the side panel, or as the strip at the bottom. |
| `/monet theme` | Opens Claude Code's theme picker with the **Monet** theme ready. |
| `/monet theme off` | Goes back to the theme you had before. |
| `/monet settings` | Opens the settings. |
| `/monet folder` | Opens the clip folder. |
| `/monet list` | Lists the clips. |

## Settings

Type `/monet settings`. Monet keeps the settings between sessions.

| Setting | Choices | Default |
| --- | --- | --- |
| Clip | Shuffle all, or one clip | Shuffle all |
| Show | Side (bottom when narrow), side, bottom, or off | Side, bottom when narrow |
| Words | Witch's atelier, or plain | Witch's atelier |
| Status line | Say what Claude does in the spinner and the hint line, or off | On |
| Look | Auto, Mosaic ▀, Dots ⣿, Letters @, Real pixels | Auto |
| Speed | 8, 12 or 24 frames a second | 12 |
| Play | Always, or only while Claude works | Always |
| Fit | Whole frame with its glow at the sides, whole frame only, or fill the pane | Whole frame with its glow |
| Next clip | When the clip ends, after 30 s, 2 min or 10 min | After 2 min |
| Disk space | Up to 100 MB, 300 MB, 1 GB or 5 GB | 300 MB |
| Samples | Include the atelier scenes and Starry Night, or only your clips | Include |
| Pane color | Match the terminal, Claude Code's gray, or your own `#rrggbb` | Match the terminal |
| Claude theme | Monet (the whole pane in the terminal color), or keep yours | Keep yours |
| Folder | Any folder | Monet in your Videos folder |

**Auto** look shows real pixels in kitty and Ghostty, and the mosaic in all other terminals.

**Pane color:** Claude Code paints its side panel gray, and draws the panel's top row (with `×`) and bottom row itself. So the side panel stays Claude's gray, all of it, until you turn on the Monet theme (below). Then the whole panel takes your terminal's background color and looks like part of the terminal. Monet reads that color from Ghostty's settings and from GNOME Terminal (a profile's own colors, or Ubuntu's aubergine theme colors). In other terminals, type the color once in **My color** (for example `#282c34`).

**The Monet theme:** Claude Code's own rows of the side panel (the one with `×` and the one under the panel) stay gray, because a mod cannot paint them. Monet writes a Claude Code theme for that, `~/.claude/themes/monet.json`: your dark (or light) theme with the side panel in your terminal color. Type `/monet theme` and pick **Monet** in the list. Within 5 seconds the side panel switches to your terminal's color. Claude Code lets only you pick a custom theme, so Monet cannot switch it for you. Claude Code reads custom themes when a session starts: if Monet is not in the list, start a new session and try again. `/monet theme off` goes back.

## The samples

| Scene | |
| --- | --- |
| Cauldron | A green brew bubbles over a fire. |
| Scrying Orb | Mist turns in a crystal ball. |
| Spellbook | Runes write themselves, then the page turns. |
| Wisps | Lights drift through a forest under the moon. |
| Bonfire | A coiled sword burns in a mound of ash. It is pixel art made for the bottom strip. |
| Starry Night | Van Gogh's sky flows and its stars twinkle. |

To play only your own clips, set **Samples** to **Only my clips**.

## Terminals

| Terminal | What you see |
| --- | --- |
| GNOME Terminal, Tilix, Terminator (Linux) | Mosaic, full color |
| Ghostty (Linux, macOS) | Real pixels or mosaic |
| kitty (Linux, macOS) | Real pixels or mosaic |
| WezTerm, Konsole, Alacritty, foot | Mosaic, full color |
| iTerm2 (macOS) | Mosaic, full color |
| Terminal.app (macOS) | Mosaic, 256 colors only |
| Windows Terminal | Mosaic, full color |
| Any terminal inside tmux | Mosaic (tmux does not pass pictures through) |

## FAQ

**How long can a video be? Can it be a full movie?**
Yes, any length. Monet does not convert the whole file. It converts about 20 seconds at a time, a few seconds before that part plays. A long movie remembers where it stopped and continues there next time.

**How much disk space does it use? Can I change it?**
The mosaic frames take about 11 MB for each minute that plays (a 16:9 video at 12 frames a second). Real pixels in kitty and Ghostty add about 20 to 40 MB a minute. The **Disk space** setting sets the limit (300 MB by default). When the cache is full, Monet deletes the clips that played longest ago, then the parts of a long movie that already played. The cache is `~/.claude/monet/.cache`. You can delete it at any time.

**Is it heavy? Does it slow down Claude Code?**
No. These are measured numbers:
- Drawing one frame takes about 0.06 ms, so 12 frames a second use about 0.1% of one CPU core.
- Each frame sends about 15 KB to the terminal.
- ffmpeg runs on one thread only. It converts about 20 seconds of a 1080p video in about 2.4 seconds. On average this is about 12% of one core while a new video plays, and nothing when a clip is already converted.
- Memory: at most two pieces of frames, about 7 MB.

For less work, set **Speed** to 8 or **Play** to "only while Claude works".

**Does it cost tokens?**
No. Monet uses no model. Its commands answer in toasts, if at all, so the model reads nothing from them. Only `/monet list` writes a line in the transcript.

**Does it work on macOS and Windows?**
Yes. Monet runs inside Claude Code, so the code is the same on every OS. It needs `ffmpeg` and `ffprobe` on the PATH.

**Which files work?**
Every format that ffmpeg reads: mp4, m4v, mov, mkv, webm, avi, gif, apng, png, jpg and webp. A picture shows as a still frame.

**Is there sound?**
No. Monet plays the picture only.

**Why is there no app or web page for the settings?**
Because the settings are inside Claude Code. So there is no extra app to install and no local port to open.

**What does Monet run on my computer?**
Only these commands:
- `ffmpeg` and `ffprobe`, to convert the clips.
- `rm` (or `rd` and `del` on Windows), only inside its own cache folder.
- `xdg-user-dir`, once at start (not on Windows), to find your Videos folder.
- `ghostty +show-config` or `gsettings get`, once at start, to read the terminal's background color. With GNOME Terminal's theme colors it also reads `/etc/os-release`.
- `xdg-open`, `open` or `explorer`, when you ask it to open the folder.

It writes only its cache, its clip folder's README, and `~/.claude/themes/monet.json`.

Apart from that, it reads only your clip folder. It makes no network calls. It reads the names of Claude's tool calls to say what Claude does, and keeps nothing of them.

**How do I remove it?**
Type `/plugin uninstall monet`. Then delete the Monet folder and `~/.claude/monet`.

## Develop

You need Node 22.18 or newer, ffmpeg, and Claude Code 2.1.296 or newer.

```sh
npm run dev        # Claude Code with Monet loaded from this folder
npm test           # claude plugin test .
npm run validate   # claude plugin validate .
npm run typecheck  # tsc on the mod (after one load, Claude Code writes the types)
npm run preview -- samples/cauldron.mp4 --look braille   # play a clip in any terminal, without Claude Code
npm run samples    # build the six samples again
```

```
.claude-plugin/
  plugin.json        the mod
  marketplace.json   makes this repository a marketplace
hooks/
  register.tsx       the hooks: side panel, bottom strip, player, settings, /monet; every call to Claude Code is here
  draw.ts            one frame to terminal cells (half-blocks, braille, ASCII)
  library.ts         the folder, the cache and the ffmpeg commands
  status.ts          what Monet says about Claude's work, in the atelier's words or plain ones
  terminal.ts        which terminal this is, its background color, and whether it shows pictures
types/index.d.ts     the values Monet keeps in the session state
tests/               claude plugin test
samples/             the atelier scenes and Starry Night
scripts/             the sample builders and the preview player
docs/                the banner, the demo and this guide
```

## Credits

The atelier scenes (Cauldron, Scrying Orb, Spellbook, Wisps, Bonfire) are drawn by code in `scripts/make-atelier-samples.mjs`.

*The Starry Night* (1889) by Vincent van Gogh is in the public domain. The sample uses the Google Art Project scan from Wikimedia Commons. `scripts/make-starry-night.mjs` makes the sky flow and the stars twinkle.

## License

MIT
