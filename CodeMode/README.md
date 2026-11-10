# CodeMode

Claude Code mod. It gives Claude one tool, `mcp__CodeMode__run`, that runs a JavaScript function body. Inside
the script, every tool Claude has is an async function: `tools.Bash`, `tools.Read`, and every MCP tool. The
script can chain calls, filter what they return, and give back only the answer. The raw output of those calls
does not go into the context.

```js
const r = await tools["mcp__gw__coralogix-mcp___search_alert_definitions"]({ name: ["gunicorn"] })
return r.text.split("\n").filter(l => /name|query/i.test(l)).slice(0, 40)
```

This is a modified copy of [cc-codemod](https://github.com/darjss/claude-code-codemode) v0.8.2 (commit
`57334d4`) by darjss, MIT License. The script runs on opencode's code mode interpreter
(`@opencode/codemode`), bundled with Effect and acorn in `hooks/runtime.js`, `vendor.js`, `effect.js` and
`acorn.js`. See [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## When it helps

- **A big output when you need only part of it.** MCP search, list and query tools often return more than
  10K characters. A direct call keeps all of it in the context for the rest of the session.
- **A chain of reads.** When one call's output decides the next one (`rg`, then read around each hit), a
  script does the whole chain in one turn. Each turn re-reads the whole context.

For one call whose whole output you need, call the tool directly. On small edits the script adds tokens and
saves none.

## What a call returns

- The script's return value, `console.log` lines, and images that nested calls returned.
- A summary line: `[4 tool calls · 1 failed · 3 started early · saved pkg, log]`. With
  [tool-cards](../tool-cards), the card shows the script and puts this line in its footer.

Each nested call resolves to `{ text, isError, result }`. A failed or denied call does not throw. Limits: 200
nested calls and 100 KB of output for each run. The language has no classes, imports, timers or fetch.

## Safety

- **Permissions**: each nested call goes through Claude Code's hooks and permission checks, one at a time. In
  auto mode, the classifier judges each call. [secret-mask](../secret-mask) masks nested output too.
- **Early starts**: read-only calls with literal arguments at the top level start before the script reaches
  them. A call starts early only when Claude Code holds it read-only and does not deny it. `git -C` counts as
  a read only in repos under `~/code`.
- **No network**: the mod itself sends nothing. Nested tools send what they always send.
- **Notebook**: top-level JSON values of a run are kept for the session (100 KB each, 1 MB in total), so a
  later run can filter them again without a new call.

## Hints

After a direct call where a script would have cost less, the next turn gets one line of advice:

- after an output of more than 10K characters (MCP output included), once in each turn;
- after 3 turns in a row that each made one read, up to 3 times in each turn. `ToolSearch`, `Agent` and other
  tools that a script cannot call do not count.

## Changes from cc-codemod

- Removed the T3 Code parts: the `html_render` guard, its description lines, and the `t3_thread_read`
  example.
- The tool description names MCP search, list and query tools, and its slice example uses one.
- The big-output hint measures MCP output too. Before, it read only `text`, which MCP tools often leave
  empty, so it never fired for them.
- Hint limits apply to each turn, not to the whole session. A turn's state is dropped when it ends, so
  subagents do not leave entries behind.
- `ToolSearch`, `Agent` and other tools a script cannot call no longer count toward the single-read streak.
- `git -C` counts as a read in repos under `~/code` (was `~/dev` and `~/.t3/worktrees`).
- Renamed to CodeMode, so the tool is `mcp__CodeMode__run`.
