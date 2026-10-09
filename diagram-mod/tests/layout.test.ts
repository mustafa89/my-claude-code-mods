import { describe, expect, test } from 'claude-code/testing'

import { layout } from '../hooks/layout'
import { packetCell, paint } from '../hooks/render'
import { parseSpec, type DiagramSpec } from '../hooks/spec'

const specOf = (input: unknown): DiagramSpec => {
  const parsed = parseSpec(input)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed.spec
}

const node = (id: string) => ({ id, label: id.toUpperCase() })
const centerOf = (b: { x: number; w: number }) => b.x + Math.floor(b.w / 2)

describe('layout', () => {
  test('a 3-node chain stacks top to bottom on one column', () => {
    const l = layout(specOf({ title: 'chain', nodes: ['a', 'b', 'c'].map(node), edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] }))
    const [a, b, c] = ['a', 'b', 'c'].map(id => l.boxes.get(id)!)
    expect([a!.layer, b!.layer, c!.layer]).toEqual([0, 1, 2])
    expect(a!.y + a!.h).toBeLessThan(b!.y)
    expect(b!.y + b!.h).toBeLessThan(c!.y)
    expect(centerOf(a!)).toBe(centerOf(b!))
    expect(centerOf(b!)).toBe(centerOf(c!))
    const route = l.routes.get('a->b')!
    expect(route.cells[0]).toEqual([centerOf(a!), a!.y + a!.h])
    expect(route.cells[route.cells.length - 1]).toEqual([centerOf(b!), b!.y - 1])
  })

  test('a fan-out of 1 to 3 puts the children on one row, left to right, parent centered', () => {
    const l = layout(specOf({
      title: 'fan',
      nodes: ['p', 'x', 'y', 'z'].map(node),
      edges: ['x', 'y', 'z'].map(to => ({ from: 'p', to })),
    }))
    const [p, x, y, z] = ['p', 'x', 'y', 'z'].map(id => l.boxes.get(id)!)
    expect([x!.layer, y!.layer, z!.layer]).toEqual([1, 1, 1])
    expect(x!.y).toBe(y!.y)
    expect(x!.x + x!.w).toBeLessThan(y!.x)
    expect(y!.x + y!.w).toBeLessThan(z!.x)
    expect(Math.abs(centerOf(p!) - centerOf(y!))).toBeLessThanOrEqual(1)
    const starts = ['p->x', 'p->y', 'p->z'].map(id => l.routes.get(id)!.cells[0])
    expect(starts[1]).toEqual(starts[0])
    expect(starts[2]).toEqual(starts[0])
  })

  test('a source with one deep child sits just above it, not in the top row', () => {
    const l = layout(specOf({
      title: 'source',
      nodes: ['a', 'b', 'c', 't'].map(node),
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 't', to: 'c' }],
    }))
    expect(l.boxes.get('t')!.layer).toBe(1)
    expect(l.boxes.get('a')!.layer).toBe(0)
  })

  test('edge labels never overlap each other or an edge line', () => {
    const l = layout(specOf({
      title: 'labels',
      nodes: ['p', 'x', 'y', 'z'].map(node),
      edges: [
        { from: 'p', to: 'x', label: 'forwarded' },
        { from: 'p', to: 'y', label: 'read' },
        { from: 'p', to: 'z', label: 'complete' },
      ],
    }))
    const lines = new Set([...l.routes.values()].flatMap(r => r.cells.map(([x, y]) => `${x},${y}`)))
    const used = new Set<string>()
    for (const r of l.routes.values()) {
      for (let i = 0; i < r.label!.text.length; i++) {
        const cell = `${r.label!.x + i},${r.label!.y}`
        expect(lines.has(cell)).toBe(false)
        expect(used.has(cell)).toBe(false)
        used.add(cell)
      }
    }
  })

  test('a packet draws a fading trail behind it, never over the arrowhead', () => {
    const spec = specOf({ title: 't', nodes: ['a', 'b'].map(node), edges: [{ from: 'a', to: 'b' }], packets: [{ edge: 'a->b' }] })
    const l = layout(spec)
    const route = l.routes.get('a->b')!
    const glyphAt = (grid: ReturnType<typeof paint>, [x, y]: [number, number]) =>
      String.fromCodePoint(grid.words[(y * grid.columns + x) * 3]!)
    const frame = paint(spec, l, 6) // head at cell 3
    expect(glyphAt(frame, route.cells[3]!)).toBe('●')
    expect(glyphAt(frame, route.cells[2]!)).toBe('•')
    expect(glyphAt(frame, route.cells[1]!)).toBe('·')
    const first = paint(spec, l, 0) // head at cell 0: no tail wraps to the arrow
    expect(glyphAt(first, route.cells[route.cells.length - 1]!)).toBe('▼')
  })

  test('a log wider than the boxes keeps the boxes centered in the canvas', () => {
    const l = layout(specOf({ title: 't', nodes: [node('a')], log: ['x'.repeat(60)] }))
    const a = l.boxes.get('a')!
    const left = a.x
    const right = l.width - 1 - (a.x + a.w)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
  })

  test('the canvas is wide enough for the longest log line', () => {
    const line = 'client sends a request to the server'
    const l = layout(specOf({ title: 't', nodes: [node('a')], log: [line] }))
    expect(l.width).toBeGreaterThanOrEqual(line.length + 2)
  })

  test('a packet moves half a cell per tick along its edge and loops', () => {
    const l = layout(specOf({ title: 'p', nodes: ['a', 'b'].map(node), edges: [{ from: 'a', to: 'b' }] }))
    const route = l.routes.get('a->b')!
    expect(packetCell(route, 0)).toEqual(route.cells[0])
    expect(packetCell(route, 1)).toEqual(route.cells[0])
    expect(packetCell(route, 2)).toEqual(route.cells[1])
    expect(packetCell(route, 4)).toEqual(route.cells[2])
    expect(packetCell(route, 2 * route.cells.length)).toEqual(route.cells[0])
    expect(packetCell(route, 4, 0.5)).toEqual(route.cells[1])
  })
})
