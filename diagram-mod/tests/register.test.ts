import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { BRAILLE } from '../hooks/render'

const TOOL = 'mcp__diagram-mod__show_diagram'
const PANE_PROPS = {
  title: 'Two steps',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const
const SPEC = {
  title: 'Two steps',
  nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
  edges: [{ from: 'a', to: 'b' }],
  packets: [{ edge: 'a->b' }],
}

/** The world beneath the mod: a session, a pane that is placed or not, blits recorded. */
function world(on: On, placed: boolean) {
  const clock = mock.clock(on)
  const blits: string[] = []
  const blitTargets: string[] = []
  const closed: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__diagram-mod__${e.name}` } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.open', () => ({ value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'below 144 columns (80 now)' } }))
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.blit', ($, e) => {
    if ('cells' in e) {
      blits.push(e.cells)
      blitTargets.push(e.requestId)
    }
    return { value: {} }
  })
  return { clock, blits, blitTargets, closed }
}

/** The packet's braille cells in a blit, as `index:glyph` pairs; empty when no packet shows. */
function packetAt(cells: string): string {
  const bin = atob(cells)
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  const found: string[] = []
  for (let i = 0; i < words.length; i += 3) if ((words[i]! & 0xff00) === BRAILLE) found.push(`${i / 3}:${words[i]}`)
  return found.join(' ')
}

const PANE_MODE = { options: { display: 'pane' } }

describe('register: pane', () => {
  test('each tick blits a frame with the packet a little further on', PANE_MODE, async ($, on) => {
    const { clock, blits } = world(on, true)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
    const ran = await $.tool.call({ tool: TOOL, ...SPEC })
    expect(String(ran.result)).toContain('diagram pane')

    for (let i = 0; i < 4; i++) await clock.advance(16)
    expect(blits).toHaveLength(4)
    // A quarter cell per frame: the braille dots shift on every frame.
    const at = blits.map(packetAt)
    expect(at[0]).not.toBe('')
    expect(at[1]).not.toBe(at[0])
    expect(at[2]).not.toBe(at[1])
    expect(at[3]).not.toBe(at[2])
  })

  test('closing the pane with q clears the timer', PANE_MODE, async ($, on) => {
    const { clock, blits, closed } = world(on, true)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
    await $.tool.call({ tool: TOOL, ...SPEC })
    await clock.advance(16)
    expect(blits).toHaveLength(1)

    const ui = await $.ui.mount({ plugin: 'diagram-mod', surface: 'terminal', component: 'Pane', requestId: 'diagram', props: PANE_PROPS })
    expect(await ui.find({ type: 'Raster', key: 'diagram' })).toBeDefined()
    await ui.press({ key: 'close' })
    expect(closed).toEqual(['diagram'])
    await clock.advance(2000)
    expect(blits).toHaveLength(1)
  })

  test('a terminal too narrow for the pane gets the static diagram in the result', PANE_MODE, async ($, on) => {
    const { clock, blits, closed } = world(on, false)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
    const ran = await $.tool.call({ tool: TOOL, ...SPEC })
    const text = String(ran.result)
    expect(text).toContain('too narrow')
    expect(text).toContain('Two steps')
    expect(text).toContain('╭')
    expect(text).toContain('▼')
    expect(closed).toEqual(['diagram'])

    await clock.advance(1000)
    expect(blits).toHaveLength(0)
  })

  test('a pane narrower than the diagram draws the still text, not the Raster', PANE_MODE, async ($, on) => {
    world(on, true)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
    await $.tool.call({ tool: TOOL, ...SPEC })
    const props = { ...PANE_PROPS, bodyColumns: 8 }
    const ui = await $.ui.mount({ plugin: 'diagram-mod', surface: 'terminal', component: 'Pane', requestId: 'diagram', props })
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /Two steps/ }))?.text).toContain('╭')
  })

  test('a spec naming an unknown node is refused', PANE_MODE, async ($, on) => {
    world(on, true)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
    const ran = await $.tool.call({ tool: TOOL, title: 'x', nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'nope' }] })
    expect(String(ran.deny ?? ran.text)).toContain('unknown node')
  })
})

const rowProps = (tool_use_id: string, onScreen?: { first: number; last: number; of: number } | null) => ({
  tool_use_id,
  tool: TOOL,
  input: SPEC,
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: 'x',
  ...(onScreen === undefined ? {} : { onScreen }),
})

const mountRow = ($: Engine, id: string, onScreen?: { first: number; last: number; of: number } | null) =>
  $.ui.mount({ plugin: 'diagram-mod', surface: 'terminal', component: 'ToolUse', requestId: id, props: rowProps(id, onScreen), viewport: { columns: 138, rows: 40 } })

describe('register: inline', () => {
  test('the tool row draws a Raster and each tick blits it with the packet moving', async ($, on) => {
    const { clock, blits, blitTargets } = world(on, true)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
    const ran = await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', ...SPEC })
    expect(String(ran.result)).toContain('╭')

    const row = await mountRow($, 'tu1')
    expect(await row.find({ type: 'Raster', key: 'diagram' })).toBeDefined()
    await clock.advance(16)
    await clock.advance(16)
    expect(blitTargets).toEqual(['tu1', 'tu1'])
    expect(packetAt(blits[1]!)).not.toBe(packetAt(blits[0]!))
  })

  test('the row scrolled off screen stops the timer; back on screen restarts it', async ($, on) => {
    const { clock, blits } = world(on, true)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
    await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', ...SPEC })
    const row = await mountRow($, 'tu1', { first: 0, last: 10, of: 20 })
    await clock.advance(16)
    expect(blits).toHaveLength(1)

    await row.redraw(rowProps('tu1', null))
    await clock.advance(1000)
    expect(blits).toHaveLength(1)

    await row.redraw(rowProps('tu1', { first: 0, last: 10, of: 20 }))
    await clock.advance(16)
    expect(blits).toHaveLength(2)
  })

  test('a newer diagram takes the animation; the older row holds its still frame', async ($, on) => {
    const { clock, blitTargets } = world(on, true)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
    await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', ...SPEC })
    await $.tool.call({ tool: TOOL, tool_use_id: 'tu2', ...SPEC })
    const old = await mountRow($, 'tu1')
    expect(await old.find({ type: 'Raster' })).toBeDefined()
    await clock.advance(16 * 3)
    expect(new Set(blitTargets)).toEqual(new Set(['tu2']))
  })

  test('a running turn holds the still picture; the animation starts when the turn ends', async ($, on) => {
    const { clock, blits } = world(on, true)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
    await $.turn.start({ text: 'draw it', turnId: 't1' })
    await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', ...SPEC })
    await mountRow($, 'tu1')
    await clock.advance(1000)
    expect(blits).toHaveLength(0)

    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(16)
    expect(blits).toHaveLength(1)
  })

  test('the result block under the row stays empty while the row draws the diagram', async ($, on) => {
    world(on, true)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
    await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', ...SPEC })
    const result = await $.ui.mount({
      plugin: 'diagram-mod', surface: 'terminal', component: 'ToolResult', requestId: 'tu1',
      props: { tool_use_id: 'tu1', tool: TOOL, output: 'x', isErrored: false }, viewport: { columns: 138, rows: 40 },
    })
    expect(await result.find({ type: 'Raster' })).toBeUndefined()
  })

  test('a terminal narrower than the diagram leaves the row to the engine', async ($, on) => {
    world(on, true)
    on('ui.render', { component: 'ToolUse' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, { key: 'engine' }, 'engine row') as never
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
    await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', ...SPEC })
    const row = await $.ui.mount({ plugin: 'diagram-mod', surface: 'terminal', component: 'ToolUse', requestId: 'tu1', props: rowProps('tu1'), viewport: { columns: 8, rows: 40 } })
    expect(await row.find({ type: 'Raster' })).toBeUndefined()
    expect(await row.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  })
})
