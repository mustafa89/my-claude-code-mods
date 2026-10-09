import { describe, expect, test } from 'claude-code/testing'

import { layout } from '../hooks/layout'
import { BRAILLE, paint } from '../hooks/render'
import { parseSpec, type DiagramSpec } from '../hooks/spec'
import { frameAt, loopMs } from '../hooks/timeline'

const specOf = (input: unknown): DiagramSpec => {
  const parsed = parseSpec(input)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed.spec
}

const STORY = {
  title: 'story',
  nodes: [
    { id: 'p', label: 'Panel', side: 'left', items: ['first', 'second'] },
    { id: 'a', label: 'A', meters: [{ label: 'load', value: 0.2 }] },
    { id: 'b', label: 'B', status: 'queued', tone: 'dim' },
  ],
  edges: [{ from: 'a', to: 'b' }, { from: 'p', to: 'a' }],
  counters: { jobs: 0 },
  steps: [
    { duration: 1000, active: ['p->a'], nodes: { p: { highlight: 0 } }, log: [{ actor: 'p', text: 'hello', status: '[ok]', tone: 'ok' }], counters: { jobs: 10 } },
    { duration: 1000, active: ['a->b'], nodes: { a: { meters: [0.8] }, b: { status: 'running', tone: 'run' } }, log: [{ actor: 'b', text: 'working' }], counters: { jobs: 30 } },
  ],
}

describe('story', () => {
  test('steps play in order, each lighting its own edges', () => {
    const spec = specOf(STORY)
    expect(frameAt(spec, 100).step).toBe(0)
    expect([...frameAt(spec, 100).active]).toEqual(['p->a'])
    expect(frameAt(spec, 1100).step).toBe(1)
    expect([...frameAt(spec, 1100).active]).toEqual(['a->b'])
  })

  test('the story holds its last frame with nothing moving, then loops', () => {
    const spec = specOf(STORY)
    expect(frameAt(spec, 2500).active.size).toBe(0)
    expect(frameAt(spec, 2500).nodes.get('b')!.status).toBe('running')
    expect(frameAt(spec, loopMs(spec) + 100).step).toBe(0)
    expect(frameAt(spec, loopMs(spec) + 100).nodes.get('b')!.status).toBe('queued')
  })

  test('meters ease to a step value, counters count up across the step', () => {
    const spec = specOf(STORY)
    const early = frameAt(spec, 1100).nodes.get('a')!.meters[0]!
    const late = frameAt(spec, 1900).nodes.get('a')!.meters[0]!
    expect(early).toBeGreaterThan(0.2)
    expect(early).toBeLessThan(0.8)
    expect(late).toBe(0.8)
    const [, mid] = frameAt(spec, 1500).counters[0]!
    expect(mid).toBeGreaterThan(10)
    expect(mid).toBeLessThan(30)
  })

  test('log rows appear with their step and type out', () => {
    const spec = specOf(STORY)
    expect(frameAt(spec, 50).log).toHaveLength(1)
    expect(frameAt(spec, 50).log[0]!.typed).toBeLessThan(5)
    expect(frameAt(spec, 900).log[0]!.typed).toBe(5)
    expect(frameAt(spec, 1500).log).toHaveLength(2)
  })

  test('a highlighted panel item is painted on a shaded row; a still picture holds no comets', () => {
    const spec = specOf(STORY)
    const l = layout(spec)
    const p = l.panels.get('p')!
    const frame = paint(spec, l, 200)
    const itemRow = p.y + 3
    const bg = frame.words[(itemRow * frame.columns + p.x + 2) * 3 + 2]
    expect(bg).not.toBe(0x01000000)
    const still = paint(spec, l, 200, false)
    let braille = 0
    for (let i = 0; i < still.words.length; i += 3) if ((still.words[i]! & 0xff00) === BRAILLE) braille++
    expect(braille).toBe(0)
  })

  test('lists and objects sent as JSON text are read as such', () => {
    const parsed = parseSpec({ ...STORY, steps: JSON.stringify(STORY.steps), counters: JSON.stringify(STORY.counters) })
    expect('spec' in parsed && parsed.spec.steps).toHaveLength(2)
  })

  test('a step naming an unknown edge or node is refused', () => {
    const edge = parseSpec({ ...STORY, steps: [{ active: ['nope'] }] })
    expect('error' in edge && edge.error).toContain('unknown edge')
    const node = parseSpec({ ...STORY, steps: [{ nodes: { ghost: { status: 'x' } } }] })
    expect('error' in node && node.error).toContain('unknown node')
  })
})
