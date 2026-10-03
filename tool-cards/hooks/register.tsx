import { atom, read, update } from 'claude-code'
import type { Register, RenderElement } from 'claude-code'

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

  // Bash cards carry their own output, so its separate result block goes.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.props.tool !== 'Bash' || e.surface !== 'terminal') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
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
        const limit = isFull ? FULL_LINES : PREVIEW_LINES
        body.push(rule)
        body.push(
          <Box key="out" flexDirection="column">
            {shown.length === 0 ? <Text color={C.muted}>(no output)</Text> : null}
            {shown.slice(0, limit).map((l, i) => (
              <Text key={`o${i}`} color={l.isErr ? C.fail : C.text} wrap={isFull ? 'wrap' : 'truncate-end'}>
                {l.text === '' ? ' ' : l.text}
              </Text>
            ))}
            {shown.length > PREVIEW_LINES ? (
              <Box key="more" gap={2}>
                {shown.length > limit ? <Text color={C.muted}>{`… ${shown.length - limit} more lines`}</Text> : null}
                <Button
                  key={`toggle-${p.tool_use_id}`}
                  plain
                  dimColor
                  label={isFull ? '▴ collapse' : '▾ expand'}
                  onPress={() => update($, expanded, m => ({ ...m, [p.tool_use_id]: !isFull }))}
                />
              </Box>
            ) : null}
          </Box>,
        )
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
