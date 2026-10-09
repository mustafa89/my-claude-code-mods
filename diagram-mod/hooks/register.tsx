import type { Args, EngineInterface, Register, Timer, ToolCallResult } from 'claude-code'

import { layout, type Layout } from './layout'
import { encode, paint, toText } from './render'
import { INPUT_SCHEMA, parseSpec, type DiagramSpec } from './spec'

const PANE = 'diagram'
const RASTER = 'diagram'
const TOOL = 'mcp__diagram-mod__show_diagram'
const FRAME_MS = 33 // about 30 fps
const CARD_MARGIN = 8 // a tool card's border and padding around the row (tool-cards)
const MOUNT_WAIT_FRAMES = 300 // stop an inline timer whose row never mounts (10 s)

const DESCRIPTION = [
  'Show an animated box-and-arrow diagram in the terminal.',
  'Use it when the user asks for a diagram, a flow or a visual explanation.',
  'Give nodes and edges only; the layout is computed top to bottom.',
  'Keep it to one idea, about 12 nodes at most, labels of 1-3 words.',
  'Packets loop along named edges (edge id is "from->to"); log lines type out under the diagram.',
].join(' ')

type Shown = { spec: DiagramSpec; layout: Layout }

// inline: the tool's transcript row draws the diagram; only the newest row animates.
const drawn = new Map<string, Shown>()
let live: { id: string; tick: number; timer?: Timer; isMounted: boolean; misses: number } | undefined
let isBusy = false

// pane: one pane the tool opens; q or Esc closes it.
let shown: Shown | undefined
let tick = 0
let timer: Timer | undefined

export const register: Register = (on, options) => {
  const isPane = options.display === 'pane'

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'show_diagram', description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    return next(e)
  })

  on('tool.call', { tool: TOOL }, ($, e) => (isPane ? callPane($, e) : callInline($, e))).catch(() => ({
    deny: 'show_diagram failed to draw the diagram',
  }))

  // While a turn runs the frames would compete with the streaming reply: hold the still picture.
  on('turn.start', ($, e, next) => {
    isBusy = true
    stopInline()
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) return next(e) // a subagent's run, not the main turn
    isBusy = false
    if (!isPane) startInline($)
    return next(e)
  })

  // The diagram is the row itself, so a card around the row (tool-cards) can fold it.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    const row = drawn.get(e.requestId)
    if (isPane || e.props.tool !== TOOL || !row || e.surface !== 'terminal' || e.props.isErrored) return next(e)
    if ((e.viewport?.columns ?? Infinity) - CARD_MARGIN < row.layout.width) return next(e)

    const isLive = live?.id === e.requestId
    if (isLive) {
      // Pause off screen; `undefined` means the surface does not say, so keep going.
      if (e.props.onScreen === null) stopInline()
      else startInline($)
    }
    const { Raster } = $.ui.resolve(e)
    const cells = encode(paint(row.spec, row.layout, live?.tick ?? 0, isLive && !isBusy))
    return <Raster key={RASTER} columns={row.layout.width} rows={row.layout.height} cells={cells} />
  })

  // The row already draws the diagram; the result block under it stays empty.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    const row = drawn.get(e.requestId)
    if (isPane || e.props.tool !== TOOL || !row || e.surface !== 'terminal' || e.props.isErrored) return next(e)
    if ((e.viewport?.columns ?? Infinity) - CARD_MARGIN < row.layout.width) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) forgetPane()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (!shown) return <Text dimColor>No diagram to show. Ask Claude for one.</Text>
    // No Raster off the terminal; a pane narrower than the diagram gets the still text, which scrolls.
    if (e.surface !== 'terminal' || e.props.bodyColumns < shown.layout.width) {
      return <Text>{toText(shown.spec, shown.layout)}</Text>
    }

    const { Raster, Button } = $.ui.resolve(e)
    const { width, height } = shown.layout
    return (
      <Box flexDirection="column">
        <Raster key={RASTER} columns={width} rows={height} cells={encode(paint(shown.spec, shown.layout, tick))} />
        <Button key="close" hotkey="q" plain onPress={() => {
            forgetPane()
            return $.ui.close({ id: PANE })
          }}>
          close
        </Button>
      </Box>
    )
  })
}

function parsedOf(e: Args<'tool.call'>) {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...input } = e as Record<string, unknown>
  return parseSpec(input)
}

async function callInline($: EngineInterface, e: Args<'tool.call'>): Promise<ToolCallResult> {
  const parsed = parsedOf(e)
  if ('error' in parsed) return { deny: `show_diagram: ${parsed.error}` }

  const row = { spec: parsed.spec, layout: layout(parsed.spec) }
  stopInline()
  drawn.set(e.tool_use_id, row)
  live = { id: e.tool_use_id, tick: 0, isMounted: false, misses: 0 }
  startInline($)
  return {
    result: `Drawn in the transcript row above; it animates once this turn ends. Do not repeat it in the reply. Static version for reference:\n\n${toText(row.spec, row.layout)}`,
  }
}

function startInline($: EngineInterface) {
  const current = live
  const row = current && drawn.get(current.id)
  if (!current || !row || current.timer || isBusy) return
  current.isMounted = false
  current.misses = 0
  current.timer = $.clock.every(FRAME_MS, () => {
    current.tick++
    void $.ui.blit({ requestId: current.id, key: RASTER, cells: encode(paint(row.spec, row.layout, current.tick)) }).then(r => {
      if (!r.deny) current.isMounted = true
      else if (current.isMounted || ++current.misses > MOUNT_WAIT_FRAMES) stopInline()
    })
  })
}

function stopInline() {
  live?.timer?.cancel()
  if (live) live.timer = undefined
}

async function callPane($: EngineInterface, e: Args<'tool.call'>): Promise<ToolCallResult> {
  const parsed = parsedOf(e)
  if ('error' in parsed) return { deny: `show_diagram: ${parsed.error}` }

  stopPane()
  const next = { spec: parsed.spec, layout: layout(parsed.spec) }
  const opened = await $.ui.open({
    id: PANE,
    title: parsed.spec.title,
    focus: true,
    closeOnEscape: true,
    rows: next.layout.height + 1,
    columns: next.layout.width,
  })
  if (!opened.isPlaced) {
    forgetPane()
    await $.ui.close({ id: PANE })
    return {
      result: `The terminal is too narrow for the diagram pane (${opened.reason}). Static version:\n\n${toText(next.spec, next.layout)}`,
    }
  }

  shown = next
  tick = 0
  $.ui.invalidate('ui.render')
  timer = $.clock.every(FRAME_MS, () => {
    if (!shown) return stopPane()
    tick++
    void $.ui.blit({ requestId: PANE, key: RASTER, cells: encode(paint(shown.spec, shown.layout, tick)) })
  })
  return { result: `Showing "${parsed.spec.title}" in the diagram pane (q or Esc closes it).` }
}

function stopPane() {
  timer?.cancel()
  timer = undefined
}

// The person's close (Esc, the close mark) arrives at the ui.close hook;
// our own $.ui.close does not pass through it, so q stops the timer here.
function forgetPane() {
  stopPane()
  shown = undefined
}
