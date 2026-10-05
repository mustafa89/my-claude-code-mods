# week-calendar

Claude Code mod. `/week` builds a one-file HTML calendar of this week's Claude Code and Codex sessions, writes a 3-line report, opens the calendar, and puts a summary on the status line.

## Install

    cp -r week-calendar ~/mods/
    claude --plugin-dir ~/mods/week-calendar          # one session
    # or permanently: add ~/mods/week-calendar to CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json "env"
    claude plugin validate ~/mods/week-calendar

Requires Claude Code >= 2.1.287, Node, git.

## Use

    /week          this week
    /week last     last week (/week -2 for two weeks back)

Standalone, without Claude Code: `node bin/build.mjs [--offset -1]` (the Shipped line stays empty).

## Files

- `bin/build.mjs`: reads `~/.claude/projects/**/*.jsonl` (skips `subagents/`) and `~/.codex/sessions/**/*.jsonl`, splits sessions on gaps > 30 min, matches your commits (`git config user.email`) per block, writes `~/.calendar/week-<monday>.html`.
- `bin/calendar.html`: template; data is inlined, no network.
- `hooks/register.js`: registers `/week`, calls `sonnet` once for the Shipped line, patches it into the HTML.

## Settings

`~/.calendar/config.json` is created on first run: `theme` (dark/light), `accent`, `weekStart` (mon/sun), `dayStartHour` (default 6: work before 06:00 counts toward the previous day), `gapMinutes`, `minNoCommitMinutes` (default 15), `palette`, `sources`.
