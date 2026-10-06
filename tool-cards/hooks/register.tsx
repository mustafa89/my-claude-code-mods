import { atom, read, update } from 'claude-code'
import type { Elements, Hook, Register, RenderElement } from 'claude-code'

const times = atom({ plugin: 'tool-cards', key: 'times' } as const, {})
const expanded = atom({ plugin: 'tool-cards', key: 'expanded' } as const, {})
const showAll = atom({ plugin: 'tool-cards', key: 'showAll' } as const, false)

const C = {
  frame: '#3B414D',
  name: '#E8A15A',
  ok: '#7EE787',
  fail: '#FF7B72',
  busy: '#F2CC60',
  cmd: '#E8A15A',
  arg: '#9FCB78',
  text: '#D7DCE4',
  muted: '#7F8796',
}

const PREVIEW_LINES = 5
// An expanded card stops here; beyond it the output is better read in a file.
const FULL_LINES = 400
const COMMAND_LINES = 3
const KEEP_TIMES = 300
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

type Kind = 'cmd' | 'flag' | 'str' | 'op' | 'arg' | 'ws'

// Splits a shell command into coloured tokens: the command word of each pipeline stage,
// its flags, quoted strings, operators and plain arguments.
function shellTokens(command: string) {
  const re = /(\s+)|('[^']*'|"(?:\\.|[^"\\])*")|(\|\||&&|[|;&<>]+)|([^\s'"|;&<>]+)/g
  const out: { text: string; kind: Kind }[] = []
  let expectCommand = true
  for (const m of command.matchAll(re)) {
    if (m[1] !== undefined) out.push({ text: m[1], kind: 'ws' })
    else if (m[2] !== undefined) out.push({ text: m[2], kind: 'str' })
    else if (m[3] !== undefined) {
      out.push({ text: m[3], kind: 'op' })
      expectCommand = true
    } else if (m[4] !== undefined) {
      const word = m[4]
      if (expectCommand && !/^\w+=/.test(word)) {
        out.push({ text: word, kind: 'cmd' })
        expectCommand = false
      } else out.push({ text: word, kind: word.startsWith('-') ? 'flag' : 'arg' })
    }
  }
  return out
}

const TOKEN_COLOR: Record<Kind, string> = {
  cmd: C.cmd,
  flag: C.cmd,
  op: C.cmd,
  str: C.arg,
  arg: C.arg,
  ws: C.text,
}

function duration(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function words(text: string) {
  const n = text.match(/\S+/g)?.length ?? 0
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k words` : `~${n} words`
}

function lines(text: string) {
  const all = text.replace(ANSI, '').replace(/\s+$/, '').split('\n')
  return all.length === 1 && all[0] === '' ? [] : all
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

// One line saying what a non-Bash call acted on.
function summary(tool: string, input: Record<string, unknown>, cwd: string) {
  const rel = (p: string) => (p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p)
  const path = str(input.file_path) ?? str(input.notebook_path)
  switch (tool) {
    case 'Read': {
      const offset = typeof input.offset === 'number' ? input.offset : undefined
      const limit = typeof input.limit === 'number' ? input.limit : undefined
      const range = offset !== undefined ? `:${offset}${limit !== undefined ? `-${offset + limit}` : ''}` : ''
      return path !== undefined ? `${rel(path)}${range}` : ''
    }
    case 'Grep':
      return `${str(input.pattern) ?? ''}${str(input.path) ? `  in ${rel(str(input.path)!)}` : ''}`
    case 'Glob':
      return str(input.pattern) ?? ''
    case 'WebFetch':
      return str(input.url) ?? ''
    case 'WebSearch':
      return str(input.query) ?? ''
    case 'Agent':
      return `${str(input.subagent_type) ?? 'agent'} · ${str(input.description) ?? ''}`
    default:
      if (path !== undefined) return rel(path)
      return Object.entries(input)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, ' ')}`)
        .join('  ')
  }
}

type Api = Parameters<Hook<'ui.render'>>[0]
type UI = Elements['terminal']
type Line = { text: string; isErr: boolean }

function toggle($: Api, ui: UI, id: string, isFull: boolean, label: string) {
  const { Button } = ui
  return (
    <Button
      key={`toggle-${id}`}
      plain
      dimColor
      label={label}
      onPress={() => update($, expanded, m => ({ ...m, [id]: !isFull }))}
    />
  )
}

// Output lines with a preview cut and the expand button; a preview of 0 starts folded.
function outputBlock($: Api, ui: UI, id: string, shown: Line[], isFull: boolean, preview: number) {
  const { Box, Text } = ui
  const limit = isFull ? FULL_LINES : preview
  const hidden = shown.length - Math.min(shown.length, limit)
  const label = isFull ? '▴ collapse' : limit === 0 ? `▾ output · ${shown.length} lines` : '▾ expand'
  return (
    <Box key="out" flexDirection="column">
      {shown.length === 0 ? <Text color={C.muted}>(no output)</Text> : null}
      {shown.slice(0, limit).map((l, i) => (
        <Text key={`o${i}`} color={l.isErr ? C.fail : C.text} wrap={isFull ? 'wrap' : 'truncate-end'}>
          {l.text === '' ? ' ' : l.text}
        </Text>
      ))}
      {shown.length > preview ? (
        <Box key="more" gap={2}>
          {limit > 0 && hidden > 0 ? <Text color={C.muted}>{`… ${hidden} more lines`}</Text> : null}
          {toggle($, ui, id, isFull, label)}
        </Box>
      ) : null}
    </Box>
  )
}

// The text an MCP result carries: its text blocks, JSON pretty-printed.
function mcpText(out: unknown): string {
  if (typeof out === 'string') {
    const t = out.trim()
    if (/^[[{]/.test(t)) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2)
      } catch {}
    }
    return out
  }
  if (Array.isArray(out)) {
    return out
      .map(b => {
        const block = (b ?? {}) as { type?: unknown; text?: unknown }
        return block.type === 'text' ? mcpText(String(block.text ?? '')) : `[${String(block.type ?? 'block')}]`
      })
      .join('\n')
  }
  const content = out && typeof out === 'object' ? (out as { content?: unknown }).content : undefined
  if (Array.isArray(content)) return mcpText(content)
  return out === undefined ? '' : JSON.stringify(out, null, 2)
}

type Hunk = { oldStart: number; newStart: number; lines: string[] }
type Span = { text: string; hot: boolean }
type Side = { n: number; text: string; kind: 'del' | 'add' | 'ctx'; spans?: Span[] }
type Gap = { gap: true }
type Row = { left?: Side; right?: Side } | Gap

const DIFF_PREVIEW = 16
// Below this many columns per side, old stacks over new.
const SPLIT_MIN = 40
const BAR = 20
const DIFF = {
  del: { num: C.fail, bg: '#3A2228', hot: '#7A2F3A' },
  add: { num: '#A6D86E', bg: '#2C3A1F', hot: '#4E6E26' },
  ctx: { num: C.muted, bg: undefined, hot: undefined },
}
// Word highlights skip long lines (the LCS is quadratic) and pairs that share too little to read as an edit.
const WORD_TOKENS = 300
const WORD_SHARED = 0.3

// Marks the words that differ between a removed line and the line that replaced it.
function wordSpans(a: string, b: string): [Span[], Span[]] | undefined {
  const x = a.match(/\w+|\s+|[^\w\s]/g) ?? []
  const y = b.match(/\w+|\s+|[^\w\s]/g) ?? []
  if (x.length === 0 || y.length === 0 || x.length > WORD_TOKENS || y.length > WORD_TOKENS) return undefined
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const keepX = new Array<boolean>(x.length).fill(false)
  const keepY = new Array<boolean>(y.length).fill(false)
  for (let i = 0, j = 0; i < x.length && j < y.length; ) {
    if (x[i] === y[j]) {
      keepX[i++] = true
      keepY[j++] = true
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
    else j++
  }
  const shared = x.filter((t, i) => keepX[i] && /\S/.test(t)).length
  const total = Math.max(x.filter(t => /\S/.test(t)).length, y.filter(t => /\S/.test(t)).length)
  if (total === 0 || shared / total < WORD_SHARED) return undefined
  const spans = (tokens: string[], keep: boolean[]) =>
    tokens.reduce<Span[]>((out, text, i) => {
      // Whitespace between two changed words joins them into one highlight.
      const hot = !keep[i] || (/^\s+$/.test(text) && !keep[i - 1] && !keep[i + 1] && i > 0 && i < tokens.length - 1)
      const last = out[out.length - 1]
      if (last && last.hot === hot) last.text += text
      else out.push({ text, hot })
      return out
    }, [])
  return [spans(x, keepX), spans(y, keepY)]
}

function patchOf(output: unknown) {
  const p = output && typeof output === 'object' ? (output as { structuredPatch?: unknown }).structuredPatch : undefined
  return Array.isArray(p) && p.length > 0 ? (p as Hunk[]) : undefined
}

// Pairs a patch side by side: context on both sides, each run of removals beside the additions that replaced it.
function splitRows(patch: Hunk[]) {
  const rows: Row[] = []
  let adds = 0
  let dels = 0
  patch.forEach((h, i) => {
    if (i > 0) rows.push({ gap: true })
    let o = h.oldStart
    let n = h.newStart
    let left: Side[] = []
    let right: Side[] = []
    const flush = () => {
      for (let k = 0; k < Math.max(left.length, right.length); k++) {
        const l = left[k]
        const r = right[k]
        const spans = l && r ? wordSpans(l.text, r.text) : undefined
        rows.push(spans ? { left: { ...l!, spans: spans[0] }, right: { ...r!, spans: spans[1] } } : { left: l, right: r })
      }
      left = []
      right = []
    }
    for (const line of h.lines) {
      const text = line.slice(1).replace(/\t/g, '  ')
      if (line[0] === '-') {
        left.push({ n: o++, text, kind: 'del' })
        dels++
      } else if (line[0] === '+') {
        right.push({ n: n++, text, kind: 'add' })
        adds++
      } else if (line[0] !== '\\') {
        flush()
        rows.push({ left: { n: o++, text, kind: 'ctx' }, right: { n: n++, text, kind: 'ctx' } })
      }
    }
    flush()
  })
  return { rows, adds, dels }
}

// The same rows one above the other: removals, then their additions, context once.
function stackRows(rows: Row[]) {
  const out: (Side | Gap)[] = []
  let pending: Side[] = []
  const flush = () => {
    out.push(...pending)
    pending = []
  }
  for (const r of rows) {
    if ('gap' in r) {
      flush()
      out.push(r)
    } else if (r.left?.kind === 'ctx') {
      flush()
      out.push(r.left)
    } else {
      if (r.left) out.push(r.left)
      if (r.right) pending.push(r.right)
    }
  }
  flush()
  return out
}

function cell(ui: UI, side: Side | undefined, w: number, key: string) {
  const { Box, Text } = ui
  if (!side) return <Box key={key} width={w} flexShrink={0} />
  const tone = DIFF[side.kind]
  return (
    <Box key={key} width={w} flexShrink={0}>
      <Box width={6} flexShrink={0}>
        <Text color={tone.num}>{`${side.kind === 'ctx' ? ' ' : '▌'}${String(side.n).padStart(4)}`}</Text>
      </Box>
      <Box flexGrow={1} {...(tone.bg ? { backgroundColor: tone.bg } : {})}>
        <Text color={C.text} wrap="wrap">
          {side.text === '' ? ' ' : side.spans ? side.spans.map((sp, i) => (
            <Text key={`w${i}`} {...(sp.hot && tone.hot ? { backgroundColor: tone.hot } : {})}>
              {sp.text}
            </Text>
          )) : side.text}
        </Text>
      </Box>
    </Box>
  )
}

function diffBlock($: Api, ui: UI, id: string, patch: Hunk[], inner: number, isFull: boolean) {
  const { Box, Text } = ui
  const { rows, adds, dels } = splitRows(patch)
  const half = Math.floor((inner - 1) / 2)
  const isSplit = half >= SPLIT_MIN
  const all: (Row | Side)[] = isSplit ? rows : stackRows(rows)
  const limit = isFull ? FULL_LINES : DIFF_PREVIEW
  const green = adds + dels > 0 ? Math.round((BAR * adds) / (adds + dels)) : 0
  return [
    <Box key="diffhead" gap={1}>
      <Text color={C.muted}>↳ diff</Text>
      <Text color={DIFF.add.num}>{`+${adds}`}</Text>
      <Text color={DIFF.del.num}>{`-${dels}`}</Text>
      <Text color={C.muted}>{isSplit ? 'split' : 'stacked'}</Text>
      <Text>
        <Text color={C.muted}>[</Text>
        <Text color={DIFF.add.num}>{'━'.repeat(green)}</Text>
        <Text color={DIFF.del.num}>{'━'.repeat(BAR - green)}</Text>
        <Text color={C.muted}>]</Text>
      </Text>
    </Box>,
    <Box key="diff" flexDirection="column">
      {isSplit ? (
        <Box key="cols" gap={1}>
          <Box width={half} flexShrink={0}>
            <Text color={C.muted}>{'  old'}</Text>
          </Box>
          <Text color={C.muted}>{'  new'}</Text>
        </Box>
      ) : null}
      {all.slice(0, limit).map((r, i) =>
        'gap' in r ? (
          <Text key={`r${i}`} color={C.muted}>
            {'    ⋯'}
          </Text>
        ) : 'kind' in r ? (
          cell(ui, r, inner, `r${i}`)
        ) : (
          <Box key={`r${i}`} gap={1}>
            {cell(ui, r.left, half, 'l')}
            {cell(ui, r.right, half, 'r')}
          </Box>
        ),
      )}
      {all.length > DIFF_PREVIEW ? (
        <Box key="more" gap={2}>
          {all.length > limit ? <Text color={C.muted}>{`… ${all.length - limit} more rows`}</Text> : null}
          {toggle($, ui, id, isFull, isFull ? '▴ collapse' : '▾ expand')}
        </Box>
      ) : null}
    </Box>,
  ]
}

const isMcp = (tool: string) => tool.startsWith('mcp__')

// Calls whose card draws the result, so the engine's own result block goes.
function ownsResult(tool: string, output: unknown, isErrored: boolean) {
  if (tool === 'Bash' || isMcp(tool)) return true
  return (tool === 'Edit' || tool === 'Write') && !isErrored && patchOf(output) !== undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cards',
      description: 'Tool cards: show full output on every card (/cards full) or the 5-line preview (/cards compact)',
    })
    return next(e)
  })

  on('command.run', { command: 'cards' }, async ($, e) => {
    const arg = e.args.trim()
    const next = arg === 'full' ? true : arg === 'compact' ? false : !(await read($, showAll))
    await update($, showAll, () => next)
    await update($, expanded, () => ({}))
    return { text: next ? 'Tool cards show their full output.' : 'Tool cards show a 5-line preview.' }
  })

  on('tool.call', async ($, e, next) => {
    const start = await $.clock.now()
    const result = await next(e)
    const ms = (await $.clock.now()) - start
    await update($, times, map => {
      const keys = Object.keys(map)
      const kept = keys.length >= KEEP_TIMES ? Object.fromEntries(keys.slice(-KEEP_TIMES + 1).map(k => [k, map[k]!])) : map
      return { ...kept, [e.tool_use_id]: ms }
    })
    return result
  })

  // Folded runs of reads and searches unfold, so every call gets its own card.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) =>
    e.surface === 'terminal' && !e.props.isExpanded ? next({ ...e, props: { ...e.props, isExpanded: true } }) : next(e),
  )

  // Bash, MCP and diff cards carry their own output, so the separate result block goes.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.surface !== 'terminal' || !ownsResult(e.props.tool, e.props.output, e.props.isErrored)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const p = e.props
    const input = (p.input ?? {}) as Record<string, unknown>
    const isBash = p.tool === 'Bash'
    const width = Math.max(40, (e.viewport?.columns ?? 100) - 2)
    const inner = width - 6
    const rule = <Text color={C.frame}>{'─'.repeat(inner)}</Text>
    const [timeMap, open, all] = await Promise.all([read($, times), read($, expanded), read($, showAll)])
    const ms = timeMap[p.tool_use_id]
    // A card's own button wins over the /cards mode.
    const isFull = open[p.tool_use_id] ?? all

    const status = p.isRunning
      ? { mark: '◌', color: C.busy }
      : p.isInterrupted
        ? { mark: '⊘', color: C.muted }
        : p.isErrored
          ? { mark: '✗', color: C.fail }
          : { mark: '✓', color: C.ok }
    const note = str(input.description)

    const header = (
      <Box key="head" gap={1}>
        <Text color={C.name} bold>{`→ ${p.tool}`}</Text>
        <Text color={status.color} bold>{status.mark}</Text>
        {note !== undefined ? <Text color={C.frame}>│</Text> : null}
        {note !== undefined ? <Text color={C.muted} wrap="truncate-end">{note}</Text> : null}
      </Box>
    )

    const body: RenderElement[] = []
    const footer: string[] = []
    if (ms !== undefined) footer.push(`◷ ${duration(ms)}`)

    if (isBash) {
      const command = str(input.command) ?? ''
      const cmdLines = command.split('\n')
      body.push(
        <Box key="cmd" flexDirection="column">
          {cmdLines.slice(0, COMMAND_LINES).map((line, i) => (
            <Text key={`c${i}`} wrap="truncate-end">
              <Text color={C.muted}>{i === 0 ? '$ ' : '  '}</Text>
              {shellTokens(line).map((t, j) => (
                <Text key={`t${j}`} color={TOKEN_COLOR[t.kind]}>{t.text}</Text>
              ))}
            </Text>
          ))}
          {cmdLines.length > COMMAND_LINES ? <Text color={C.muted}>{`  … ${cmdLines.length - COMMAND_LINES} more lines`}</Text> : null}
        </Box>,
      )

      if (!p.isRunning) {
        const out = p.output as { stdout?: string; stderr?: string } | string | undefined
        const stdout = typeof out === 'string' ? out : (out?.stdout ?? '')
        const stderr = typeof out === 'string' ? '' : (out?.stderr ?? '')
        const shown = [
          ...lines(stdout).map(text => ({ text, isErr: p.isErrored && typeof out === 'string' })),
          ...lines(stderr).map(text => ({ text, isErr: true })),
        ]
        body.push(rule)
        body.push(outputBlock($, ui, p.tool_use_id, shown, isFull, PREVIEW_LINES))
        const total = `${stdout}\n${stderr}`.trim()
        if (total) footer.push(`✎ ${words(total)}`)
      }
      if (typeof input.timeout === 'number') footer.push(`■ timeout ${duration(input.timeout).replace('.00', '')}`)
    } else {
      const line = summary(p.tool, input, await $.session.cwd())
      if (line) {
        body.push(
          <Text key="args" color={C.arg} wrap="truncate-end">
            {line}
          </Text>,
        )
      }
      const patch = (p.tool === 'Edit' || p.tool === 'Write') && !p.isErrored ? patchOf(p.output) : undefined
      if (patch) {
        body.push(rule)
        body.push(...diffBlock($, ui, p.tool_use_id, patch, inner, isFull))
      } else if (isMcp(p.tool) && !p.isRunning) {
        const text = mcpText(p.output)
        const isErr = p.isErrored || (p.output as { isError?: unknown } | undefined)?.isError === true
        body.push(rule)
        body.push(outputBlock($, ui, p.tool_use_id, lines(text).map(t => ({ text: t, isErr })), isFull, 0))
        if (text.trim()) footer.push(`✎ ${words(text)}`)
      }
    }

    return (
      <Box flexDirection="column" borderStyle="single" borderColor={C.frame} paddingX={2} width={width} marginTop={1}>
        {header}
        {body.length > 0 ? rule : null}
        {body}
        {footer.length > 0 ? rule : null}
        {footer.length > 0 ? <Text color={C.muted}>{footer.join(' · ')}</Text> : null}
      </Box>
    )
  })
}
