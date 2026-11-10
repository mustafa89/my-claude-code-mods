# CodeMode

Claude Code mod. It gives Claude one tool, `mcp__CodeMode__run`, that runs a JavaScript function body. Inside
the script, every tool Claude has is an async function: `tools.Bash`, `tools.Read`, and every MCP tool. The
script can chain calls, filter what they return, and give back only the answer. The raw output of those calls
does not go into the context.

```js
const r = await tools["mcp__logs__search_alerts"]({ name: "checkout" })
return r.text.split("\n").filter(l => /name|query/i.test(l)).slice(0, 40)
```

CodeMode is a modified copy of an MIT-licensed Claude Code mod; its original copyright notice is in
[`LICENSE`](LICENSE). The script runs on opencode's code mode interpreter
(`@opencode/codemode` 2.2.7), bundled with Effect 4.1.0 and acorn in `hooks/runtime.js`, `vendor.js`,
`effect.js` and `acorn.js`. See [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

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
nested calls and 100 KB of output for each run. The language has no classes, imports, timers, fetch or `Intl`.

`tools` holds the tools Claude can call now. A deferred MCP tool shows up only after Claude loads it with
ToolSearch; a script that names it before then fails with `UnknownTool`. `search({ query })` lists the tools
a script can call.

## Safety

- **Permissions**: each nested call goes through Claude Code's hooks and permission checks, one at a time. In
  auto mode, the classifier judges each call. [secret-mask](../secret-mask) masks what the script returns, the
  only part that reaches the model.
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

## Changes from the original mod

- Removed the T3 Code parts: the `html_render` guard, its description lines, and the `t3_thread_read`
  example.
- The tool description names MCP search, list and query tools, and its slice example uses one.
- The big-output hint measures MCP output too. Before, it read only `text`, which MCP tools often leave
  empty, so it never fired for them.
- Hint limits apply to each turn, not to the whole session. A turn's state is dropped when it ends, so
  subagents do not leave entries behind.
- `ToolSearch`, `Agent` and other tools a script cannot call no longer count toward the single-read streak.
- A `run` call ends the single-read streak, and image results count as markers, not base64, for the size hint.
- `git -C` counts as a read in repos under `~/code` (was `~/dev` and `~/.t3/worktrees`).
- The tool description shows `search({ query })` (it said `search("query")`, which fails) and says to load
  a deferred MCP tool with ToolSearch first.
- The bundle is rebuilt with `@opencode/codemode` 2.2.7 and Effect 4.1.0 (was 2.1.4 and 4.0.1). A build
  step drops 2.2's experimental bytecode VM (`engine: "vm"`), which it loads with a dynamic import that the
  mod loader refuses. The mod uses the default engine.
- Renamed to CodeMode, so the tool is `mcp__CodeMode__run`.

## Build

The bundle is built from `build/runtime.ts` with the dependencies pinned in `package.json` and `bun.lock`:

```sh
claude --plugin-dir ./CodeMode -p "hi"   # once: Claude Code writes .claude-plugin/types and tsconfig.json
cd CodeMode
bun install --frozen-lockfile --ignore-scripts
./node_modules/.bin/vp pack            # writes hooks/runtime.js, vendor.js, effect.js, acorn.js
```

`vp` is [Vite+](https://viteplus.dev), from `devDependencies`. `vite.config.ts` minifies the bundle, splits
it so each file stays under the plugin directory's 256 KiB limit, writes it as ASCII, escapes `import(` in
strings (the mod loader refuses that text), and drops the VM engine. The same steps on the original mod's own
lockfile rebuild its shipped bundle byte for byte.
