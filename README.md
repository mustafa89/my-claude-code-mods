# my-claude-code-mods

Three mods for [Claude Code](https://code.claude.com): a one-line status bar, image previews for pasted
screenshots, and boxed cards for tool calls.

Mods are Claude Code plugins built from function hooks. They need **Claude Code 2.1.287 or newer**. Mods
are an early-access feature: the hooks API can change between releases.

| Mod | What it does |
|---|---|
| [`slick-bar`](#slick-bar) | Replaces the hint line under the prompt with a one-line bar: model, effort, folder, branch, context gauge, rate-limit gauges |
| [`image-peek`](#image-peek) | Shows a preview of a pasted image above the prompt and under the message that sent it |
| [`tool-cards`](#tool-cards) | Draws each tool call as a boxed card: highlighted command, output preview, timing footer |

## Install

1. Clone the repo:

   ```sh
   git clone https://github.com/mustafa89/my-claude-code-mods.git ~/.claude/mods
   ```

2. Tell Claude Code to load the mods. Add this to the `env` block of `~/.claude/settings.json`
   (paths separated by `:`; `~` is allowed):

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/slick-bar:~/.claude/mods/image-peek:~/.claude/mods/tool-cards"
     }
   }
   ```

   Leave out the mods you do not want.

3. Start a new Claude Code session. Each mod prints `<name>: loaded` in the transcript.

To try one mod for a single session only:

```sh
claude --plugin-dir ~/.claude/mods/slick-bar
```

**If you use a `statusLine` command**, the bar does not replace it. The bar sits on the hint line under
the prompt; your status line stays below it. Remove `statusLine` from your settings if you want only the bar.

## slick-bar

![slick-bar](docs/screenshots/slick-bar.png)

One line under the prompt, after Claude Code's own permission-mode label:

- **Model and effort**: `✻ Opus 5.5 1M · medium`. The `✻` turns into `◉` while a turn runs.
- **Folder and branch**: repository name (plus subfolder), branch, `±` when the tree has changes, `↑`/`↓`
  for commits ahead of or behind the upstream.
- **Context gauge**: how full the context window is, green → amber → red.
- **Rate-limit gauges** (subscription plans): 5-hour and 7-day usage, the time until each window resets
  (`↻ 3h12m`), and a `┃` tick that marks how much of the window has passed. Usage to the right of the tick
  means you are using it faster than the window allows; the percentage turns amber when the current pace
  projects past 100%.

When the terminal is narrow, segments drop in this order: hint text, 7-day gauge, token count, branch,
folder. The model and the context gauge always stay.

The bar needs a [Nerd Font](https://www.nerdfonts.com) for the pill shapes and icons.

## image-peek

![image-peek](docs/screenshots/image-peek.png)

- While you write a prompt, every pasted image shows above the prompt with its size (`Image #3 · 1246×846`).
- After you send it, the image shows under your message in the transcript.

image-peek draws real images through the
[kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/), so it needs a terminal that
supports it, such as kitty or Ghostty. Elsewhere it shows the image's label instead.

It also needs macOS: it uses `sips` to make a smaller copy of each image.

**Terminal multiplexers**: inside a multiplexer that passes kitty graphics through but identifies itself
differently (for example herdr, which reports `libghostty`), Claude Code turns graphics off. To turn them on,
add this to the same `env` block:

```json
"CLAUDE_CODE_FORCE_TERMINAL_IMAGES": "1"
```

Only do this if your terminal really supports kitty graphics. Otherwise images draw as empty boxes.

## tool-cards

![tool-cards](docs/screenshots/tool-cards.png)

Every tool call becomes a card:

- **Header**: tool name and status: `✓` done, `◌` running, `✗` error, `⊘` interrupted. The command's
  description follows.
- **Bash**: the command with syntax colours, then the first 5 lines of output (errors in red).
- **Other tools**: one line saying what the call acted on, for example `src/cart/total.js:10-30` for a Read.
  Results that Claude Code draws itself, such as edit diffs, stay under the card.
- **Footer**: how long the call took, how many words it printed, and the Bash timeout if one was set.

Claude Code normally folds runs of reads and searches into one line (`Searched for 2 patterns`).
tool-cards unfolds them, so each call gets its own card.

### Expanding output

- Click `▾ expand` on a card to see all of its output (up to 400 lines). Clicks reach the card in
  fullscreen mode.
- `/cards full` expands every card; `/cards compact` goes back to the 5-line preview; `/cards` switches
  between the two.

`Ctrl+o` does not expand a card. Claude Code does not tell mods when the `Ctrl+o` view is open.

## Development

Each mod is a folder:

```
<mod>/
  .claude-plugin/plugin.json   name, version, description, types
  hooks/hooks.json             { "modules": ["./register.tsx"] }
  hooks/register.tsx           the hooks
  types/index.d.ts             the state the mod keeps
  tests/*.test.tsx             tests
```

Check and test a mod:

```sh
claude plugin validate ./slick-bar
claude plugin test ./slick-bar
```

Claude Code writes the API types into `<mod>/.claude-plugin/types/` the first time it loads a mod; those
files are not committed. A session started with `--plugin-dir` reloads a mod when you save its files.

## Limits

These come from the mods API, not from the mods:

- **Permission mode**: mods cannot read it, so the bar sits after Claude Code's own mode label.
- **Space above the prompt**: the empty row between the transcript and the prompt belongs to Claude Code.
- **`Ctrl+o`**: tool rows do not report the expanded view (see [Expanding output](#expanding-output)).

## License

[MIT](LICENSE)
