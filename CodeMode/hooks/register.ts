import type { Register, ToolCallArgs } from 'claude-code'
import { callKey, execute, shellQuote, shellSegments, type Result, type Speculate } from './runtime.js'

const SELF = 'mcp__CodeMode__run'
const RETURN_NUDGE = 8_000
// Images nested calls return reach the model with the run's result, up to this many.
const MAX_IMAGES = 20
const NOTEBOOK = { plugin: 'CodeMode', key: 'notebook' } as const
// Tools whose every call is a read, so one with a computed argument doesn't stop later calls from starting early.
const READS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])
// A command that waits for something has to run in its place, after what came before it.
const WAITS = /\b(sleep|until|while|wait|watch|timeout)\b/
// Reads core won't vouch for because they go over the network: gh views and lists, gh api without a write flag, and
// package registry lookups.
const LISTED_READS: ReadonlyArray<(words: ReadonlyArray<string>) => boolean> = [
  ([cmd, noun, verb]) =>
    cmd === 'gh' &&
    ['pr', 'run', 'issue', 'repo', 'release', 'workflow'].includes(noun ?? '') &&
    ['view', 'list', 'checks', 'diff', 'status'].includes(verb ?? ''),
  ([cmd, noun, ...rest]) =>
    cmd === 'gh' && noun === 'api' && !rest.some(word => /^(-X|--method|-f|-F|--field|--raw-field|--input)/.test(word)),
  ([cmd, noun]) => cmd === 'gh' && noun === 'search',
  ([cmd, verb]) => cmd === 'npm' && ['view', 'info', 'ls', 'list', 'outdated'].includes(verb ?? ''),
  ([cmd, verb]) => cmd === 'pnpm' && ['ls', 'list', 'why'].includes(verb ?? ''),
  ([cmd, noun, verb]) => cmd === 'bun' && noun === 'pm' && verb === 'ls',
]
// Core won't call git read-only in another directory, since that repo's own config can run commands. Repos under
// this root are ones the person cloned or made, so git there reads like it does in the working directory.
const isOwnRepo = (path: string, home: string) => {
  const full = path === '~' || path.startsWith('~/') ? home + path.slice(1) : path
  if (full.split('/').includes('..')) return false
  return !full.startsWith('/') || `${full}/`.startsWith(`${home}/code/`)
}

const DESCRIPTION = `Run JavaScript that calls your other tools and return only what answers the question. Reach for it when one call's output decides the next (rg, then read around the hits; list, then fetch each), when you need a slice of a big output (a thread, logs, JSON, a long file), or to fan out over many files or repos. Each turn re-reads your whole context, and every output stays in it, so a chain of reads in one script costs one turn and only what it returns. For one call whose whole output you need, or a few independent calls, call the tools directly.
- \`code\` is an async function body: top-level await and return work. The language is a JavaScript subset: no classes, imports, timers or fetch.
- \`await tools.Bash({ command })\`, \`tools.Read({ file_path, offset, limit })\`, \`tools["mcp__server__tool"]({...})\` take the same arguments as the direct tools. Each resolves to \`{ text, isError, result }\`: \`text\` is what you would have read, but whole where a direct call gets a saved-to-file notice, \`result\` the tool's structured output. A failing call resolves with isError true; it does not throw.
- Read-only calls with literal arguments at the top level start before the program reaches them, so sequential \`await\`s of independent reads run in parallel. Use \`Promise.all\` for calls built at run time.
- Top-level \`const\` and \`let\` values are kept for the session as JSON. A later run can use them by name, so fetch once and filter again without re-reading.
- Filter before returning: slice lines, match a regex, count, pick fields. The return value and console.log lines are all that reaches your context, plus any images the nested calls returned.
- MCP search, list and query tools often return over 10K characters (alert definitions, logs, JSON). Call them from a script and return only the fields you need.
- \`search({ query: "..." })\` finds a tool and its exact path.
- \`tools\` holds the tools you can call now. A deferred MCP tool appears only after you load it with ToolSearch, so load it before the script names it.
- A chain: \`const hits = (await tools.Bash({ command: "rg -n -m2 'createUser' src" })).text.trim().split("\\n"); return Promise.all(hits.map(h => { const [f, n] = h.split(":"); return tools.Bash({ command: "sed -n " + Math.max(1, n - 5) + "," + (+n + 15) + "p " + f }).then(r => h + "\\n" + r.text) }))\`
- A slice: \`const r = await tools["mcp__logs__search_alerts"]({ name: "checkout" }); return r.text.split("\\n").filter(l => /name|query/i.test(l)).slice(0, 40)\``

// After a direct call, a one-line hint where a script would have cost less: the big-output one once in each agent loop,
// the chain one on each new streak of single reads, up to CHAIN_HINTS times, since long loops keep chaining after one.
const HINT_CHARS = 10_000
const HINT_STREAK = 3
const CHAIN_HINTS = 3
// The chain seen most in Bash: rg, then sed -n around a hit, then again.
const BASH_CHAIN = ' Its description has the recipe for rg and then sed -n around every hit, in one call.'
// Their output can't be sliced by a script that calls them.
const NO_HINT = new Set([SELF, 'Agent', 'Task', 'TaskOutput', 'Skill', 'AskUserQuestion', 'ToolSearch'])
type Loop = { inFlight: number; calls: number; streak: number; big: boolean; chains: number }
// The notice core answers with in place of an output too big for the model, which it saved to the file named here.
const SPILL =
  /^(?:<persisted-output>\nOutput too large \([^)]*\)\. Full output saved to: |Error: result \([\d,]+ characters\) exceeds maximum allowed tokens\. Output has been saved to )(\S+?)\.?\n/

type Block = { readonly type: string }
const isImage = (block: unknown): block is Block =>
  typeof block === 'object' && block !== null && 'type' in block && block.type === 'image'
// The script sees where an image was, not its base64, so a saved value doesn't carry the bytes.
const plain = (value: unknown) =>
  value === undefined
    ? null
    : JSON.parse(
        JSON.stringify(
          Array.isArray(value) ? value.map(b => (isImage(b) ? { type: 'image', attached: true } : b)) : value,
        ),
      )

// A return that carries a nested tool's output unchanged and large is the waste worth flagging.
// A script that sliced or filtered what it read is left alone, however long its answer.
const passedThrough = (returned: string, outputs: ReadonlyArray<string>) =>
  outputs.some(t => t.length > RETURN_NUDGE / 2 && returned.includes(t.slice(t.length / 2 - 250, t.length / 2 + 250)))

const render = (r: Result, outputs: ReadonlyArray<string>, failed: number, images: number) => {
  const out: string[] = []
  if (r.ok) out.push(typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 1))
  else out.push(`${r.error.kind}: ${r.error.message}`)
  if (r.logs?.length) out.push(`<console>\n${r.logs.join('\n')}\n</console>`)
  if (r.ok && r.warnings?.length) out.push(`warnings: ${r.warnings.map(w => `${w.kind}: ${w.message}`).join('; ')}`)
  if (r.truncated) out.push('(output truncated at 100 KB)')
  const text = out.join('\n')
  const footer = [
    `${r.toolCalls.length} tool calls`,
    failed > 0 && `${failed} failed`,
    images > 0 && `${Math.min(images, MAX_IMAGES)} images attached`,
    images > MAX_IMAGES && `${images - MAX_IMAGES} images left out`,
    r.early > 0 && `${r.early} started early`,
    r.unused > 0 && `${r.unused} started early and unused`,
    r.saved.length > 0 && `saved ${r.saved.join(', ')}`,
    r.tooBig.length > 0 && `not saved, over 100 KB: ${r.tooBig.join(', ')}`,
    text.length > RETURN_NUDGE &&
      passedThrough(text, outputs) &&
      `returned ${text.length} chars of raw tool output: slice or filter it in the script next time`,
  ].filter(part => typeof part === 'string')
  return `${text}\n[${footer.join(' · ')}]`
}

export const register: Register = on => {
  // Core's read-only verdict for an input reaches only tool.check hooks, so a query of our own records it here.
  const readOnly = new Map<string, boolean>()
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id === undefined && next.origin.plugin === $.plugin.name)
      readOnly.set(callKey(e.tool, e.input), e.isReadOnly === true)
    return verdict
  })

  // A turn is the calls that overlap in one loop. Read-only calls of one turn run together, so a turn with a single
  // read that follows two others like it is a chain a script would fold.
  const loops = new Map<string, Loop>()
  // Hint budgets are per turn: a new turn starts them fresh, and an ended turn drops its entry so subagents don't pile up.
  on('turn.start', async ($, e, next) => {
    loops.delete(e.agentId ?? '')
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    loops.delete(e.agentId ?? '')
    return next(e)
  })
  on('tool.call', async ($, e, next) => {
    if (next.origin.plugin === $.plugin.name) return next(e)
    const key = e.agentId ?? ''
    const loop = loops.get(key) ?? { inFlight: 0, calls: 0, streak: 0, big: false, chains: 0 }
    loops.set(key, loop)
    if (loop.inFlight === 0) loop.calls = 0
    loop.inFlight += 1
    loop.calls += 1
    const r = await next(e).finally(() => {
      loop.inFlight -= 1
    })
    // A script ends a streak. Other calls a script can't make (ToolSearch, Agent, ...) leave it where it was.
    if (loop.inFlight === 0 && e.tool === SELF) loop.streak = 0
    else if (loop.inFlight === 0 && !NO_HINT.has(e.tool))
      loop.streak = loop.calls === 1 && r.isReadOnly === true ? loop.streak + 1 : 0
    if (r.deny !== undefined || NO_HINT.has(e.tool)) return r
    const hints: string[] = []
    // MCP tools may answer with structured `result` and no `text`; measure what the model reads either way, with
    // images counted as markers, since their base64 reaches the model as an image and a script can't slice it.
    const shown = r.text ?? JSON.stringify(plain(r.result) ?? '')
    const chars = shown.length
    const persisted = SPILL.test(shown)
    if ((chars > HINT_CHARS || persisted) && !loop.big) {
      loop.big = true
      hints.push(
        `CodeMode: that ${e.tool} output ${persisted ? 'was too big to show' : `was ${chars} characters`}, and what you read stays in your context for the rest of the session. When you need only part of an output this size, call the tool inside mcp__CodeMode__run and return the slice.`,
      )
    }
    if (loop.streak === HINT_STREAK && loop.chains < CHAIN_HINTS) {
      loop.chains += 1
      hints.push(
        `CodeMode: that was ${HINT_STREAK} single reads in ${HINT_STREAK} turns, and each turn re-read your whole context. Reads that don't depend on each other go in one turn as parallel calls. When the next read depends on this output, write the steps as one mcp__CodeMode__run script.${e.tool === 'Bash' ? BASH_CHAIN : ''}`,
      )
    }
    return hints.length > 0 ? { ...r, context: [...(r.context ?? []), ...hints] } : r
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'run',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', description: 'JavaScript source, run as an async function body' } },
        required: ['code'],
      },
      isDeferred: false,
    })
    return started
  })

  on('tool.call', { tool: /^mcp__CodeMode__run$/ }, async ($, e, next) => {
    const code = (e as { code?: unknown }).code
    if (typeof code !== 'string' || code.trim() === '') return { deny: 'CodeMode: pass JavaScript source as `code`.' }

    const tools = (await $.tool.list())
      .filter(t => t.name !== SELF)
      .map(t => ({ name: t.name, description: (t.description.split('\n')[0] ?? '').slice(0, 200) }))

    const check = async (tool: string, input: unknown) => {
      const { decision } = await $.tool.check({ tool, input })
      const key = callKey(tool, input)
      const isReadOnly = readOnly.get(key) === true
      readOnly.delete(key)
      return { decision, isReadOnly }
    }
    const home = await $.env.get('HOME')
    // Core cuts a nested call's big output to a notice as it does a direct one's. The script is there to slice that
    // output, so it gets the whole file core saved.
    const unspill = async (text: string) => {
      const path = SPILL.exec(text)?.[1]
      return home !== undefined && path?.startsWith(`${home}/`) && path.includes('/tool-results/')
        ? $.fs.read(path).catch(() => text)
        : text
    }
    // Core judges a shell line whole. Where it won't vouch for one, each simple command in it still counts as a read
    // when core holds it read-only on its own, it's a listed read, or it's git in one of the person's own repos.
    const bashReadOnly = async (command: string) => {
      const segments = home === undefined ? undefined : shellSegments(command, home)
      if (home === undefined || segments === undefined) return false
      // Where the line has moved to, undefined while it's still in the working directory.
      let dir: string | undefined
      const resolve = (path: string) => (dir === undefined || /^[/~]/.test(path) ? path : `${dir}/${path}`)
      for (const { words, text } of segments) {
        const [cmd, flag, path, ...rest] = words
        if (cmd === 'cd') {
          dir = resolve(flag ?? '~')
          continue
        }
        if (LISTED_READS.some(read => read(words))) continue
        const gitDir = cmd === 'git' ? (flag === '-C' ? resolve(path ?? '') : dir) : undefined
        if (gitDir !== undefined && !isOwnRepo(gitDir, home)) return false
        const own = cmd === 'git' && flag === '-C' ? shellQuote(['git', ...rest]) : text
        if (!(await check('Bash', { command: own })).isReadOnly) return false
      }
      return true
    }
    // A call starts early only where core holds it read-only and doesn't refuse it. Core answers `ask` for most Bash
    // reads, which auto mode's classifier settles, and which would be asked anyway once the program got there.
    const speculate: Speculate = async (name, input) => {
      if (input === undefined) return READS.has(name) ? 'pass' : 'stop'
      if (!READS.has(name) && name !== 'Bash') return 'stop'
      if (name === 'Bash' && WAITS.test(JSON.stringify(input))) return 'stop'
      const { decision, isReadOnly } = await check(name, input)
      if (decision === 'deny') return 'stop'
      if (isReadOnly) return 'start'
      const command = typeof input === 'object' && input !== null && 'command' in input ? input.command : undefined
      return name === 'Bash' && typeof command === 'string' && (await bashReadOnly(command)) ? 'start' : 'stop'
    }
    const { value: notebook = {} } = await $.state.get(NOTEBOOK)

    let started = 0
    let done = 0
    let failed = 0
    const outputs: string[] = []
    const images: Block[] = []
    return execute(
      code,
      tools,
      async (name, input) => {
        started += 1
        $.ui.status(`codemode ${done}/${started} · ${name}`)
        const args = typeof input === 'object' && input !== null ? input : {}
        // The script's arguments are only known at run time. Core checks them against the tool's own schema.
        const ran = await $.tool.call({ ...args, tool: name } as ToolCallArgs)
        done += 1
        $.ui.status(`codemode ${done}/${started} · ${name}`)
        if (ran.deny !== undefined) {
          failed += 1
          return { text: ran.deny, isError: true, result: null }
        }
        if (ran.isError === true) failed += 1
        if (Array.isArray(ran.result)) images.push(...ran.result.filter(isImage))
        const text = await unspill(ran.text ?? JSON.stringify(ran.result))
        outputs.push(text)
        return { text, isError: ran.isError === true, result: plain(ran.result) }
      },
      { signal: next.signal, notebook, speculate },
    )
      .then(
        async result => {
          const text = render(result, outputs, failed, images.length)
          // A deny is how a hook marks its answer an error, so a failed program reads as a failed call.
          if (!result.ok) return { deny: text }
          if (result.notebook) await $.state.set(NOTEBOOK, result.notebook)
          return { result: images.length > 0 ? [{ type: 'text', text }, ...images.slice(0, MAX_IMAGES)] : text }
        },
        // An abort or an interpreter crash rejects, and fails the call the same way. An abort reads as Effect's fiber
        // interruption, so it's named for what happened.
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          return {
            deny:
              next.signal.aborted || message.startsWith('All fibers interrupted')
                ? `CodeMode: run interrupted after ${done} of ${started} tool calls finished.`
                : `CodeMode: ${message}`,
          }
        },
      )
      .finally(() => $.ui.status(undefined))
  })
}
