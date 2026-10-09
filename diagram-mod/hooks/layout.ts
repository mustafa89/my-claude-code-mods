import { edgeIdOf, type DiagramSpec } from './spec'

export type Placed = { id: string; layer: number; x: number; y: number; w: number; h: number }

/** An edge's cells from source to arrowhead, in travel order. */
export type Route = {
  id: string
  cells: [number, number][]
  dashed: boolean
  arrow: '▼' | '◀'
  label?: { x: number; y: number; text: string }
}

export type Layout = {
  width: number
  height: number
  boxes: Map<string, Placed>
  routes: Map<string, Route>
  logTop: number
}

const ROW_GAP = 4
const COL_GAP = 3
const MIN_BOX = 10
const MAX_BOX = 40

/** Layer per node by longest path from the roots; back edges (cycles) are skipped. */
export function layersOf(spec: DiagramSpec): { layer: Map<string, number>; back: Set<string> } {
  const out = new Map(spec.nodes.map(n => [n.id, [] as { to: string; id: string }[]]))
  for (const e of spec.edges ?? []) out.get(e.from)?.push({ to: e.to, id: edgeIdOf(e) })

  const state = new Map<string, 'open' | 'done'>()
  const back = new Set<string>()
  const post: string[] = []
  const visit = (id: string) => {
    state.set(id, 'open')
    for (const { to, id: edgeId } of out.get(id) ?? []) {
      if (state.get(to) === 'open') back.add(edgeId)
      else if (!state.has(to)) visit(to)
    }
    state.set(id, 'done')
    post.push(id)
  }
  for (const n of spec.nodes) if (!state.has(n.id)) visit(n.id)

  const layer = new Map(spec.nodes.map(n => [n.id, 0]))
  for (const id of post.reverse()) {
    for (const { to, id: edgeId } of out.get(id) ?? []) {
      if (!back.has(edgeId)) layer.set(to, Math.max(layer.get(to) ?? 0, (layer.get(id) ?? 0) + 1))
    }
  }
  // A source sits just above its nearest child, not in the top row with long edges down.
  const hasParent = new Set((spec.edges ?? []).filter(e => !back.has(edgeIdOf(e))).map(e => e.to))
  for (const [id, children] of out) {
    const forward = children.filter(c => !back.has(c.id))
    if (hasParent.has(id) || forward.length === 0) continue
    layer.set(id, Math.min(...forward.map(c => layer.get(c.to) ?? 1)) - 1)
  }
  return { layer, back }
}

/** Places every box top to bottom and routes every edge between them. */
export function layout(spec: DiagramSpec): Layout {
  const { layer, back } = layersOf(spec)
  const order = new Map(spec.nodes.map((n, i) => [n.id, i]))
  const depth = Math.max(...layer.values()) + 1

  const sizeOf = (n: DiagramSpec['nodes'][number]) => {
    const text = Math.max(n.label.length, ...(n.detail ?? []).map(d => d.length), (n.status?.length ?? -2) + 2)
    return {
      w: Math.min(MAX_BOX, Math.max(MIN_BOX, text + 4)),
      h: 3 + (n.detail?.length ?? 0) + (n.status ? 1 : 0),
    }
  }

  // Rows of ids per layer, each layer after the first sorted under its parents.
  const rows: string[][] = Array.from({ length: depth }, () => [])
  for (const n of spec.nodes) rows[layer.get(n.id) ?? 0]!.push(n.id)
  const parents = new Map<string, string[]>()
  for (const e of spec.edges ?? []) if (!back.has(edgeIdOf(e))) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from])
  const slot = new Map<string, number>()
  rows.forEach((row, i) => {
    if (i > 0) {
      const center = (id: string) => {
        const ps = (parents.get(id) ?? []).map(p => slot.get(p) ?? 0)
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity
      }
      row.sort((a, b) => center(a) - center(b) || (order.get(a) ?? 0) - (order.get(b) ?? 0))
    }
    row.forEach((id, j) => slot.set(id, j))
  })

  const sizes = new Map(spec.nodes.map(n => [n.id, sizeOf(n)]))
  const rowWidth = (row: string[]) => row.reduce((sum, id) => sum + sizes.get(id)!.w, 0) + COL_GAP * (row.length - 1)
  const header = spec.subtitle ? 3 : 2
  // Boxes are laid out over their own widest row; the whole block is centered in the canvas at the end.
  const content = Math.max(...rows.map(rowWidth))

  const boxes = new Map<string, Placed>()
  let y = header
  rows.forEach((row, i) => {
    let x = Math.floor((content - rowWidth(row)) / 2)
    for (const id of row) {
      const { w, h } = sizes.get(id)!
      boxes.set(id, { id, layer: i, x, y, w, h })
      x += w + COL_GAP
    }
    y += Math.max(...row.map(id => sizes.get(id)!.h)) + ROW_GAP
  })
  const bottom = y - ROW_GAP

  const routes = new Map<string, Route>()
  const wanted = new Map<string, { text: string; spots: { x: number; y: number }[] }>()
  let backCount = 0
  for (const e of spec.edges ?? []) {
    const id = edgeIdOf(e)
    const s = boxes.get(e.from)!
    const t = boxes.get(e.to)!
    const cells: [number, number][] = []
    const push = (x: number, y: number) => {
      const last = cells[cells.length - 1]
      if (!last || last[0] !== x || last[1] !== y) cells.push([x, y])
    }
    const line = (x0: number, y0: number, x1: number, y1: number) => {
      const dx = Math.sign(x1 - x0)
      const dy = Math.sign(y1 - y0)
      for (let x = x0, y = y0; ; x += dx, y += dy) {
        push(x, y)
        if (x === x1 && y === y1) break
      }
    }

    if (!back.has(id) && t.layer > s.layer) {
      const sx = s.x + Math.floor(s.w / 2)
      const tx = t.x + Math.floor(t.w / 2)
      const sy = s.y + s.h
      const mid = sy + 1
      const ty = t.y - 1
      line(sx, sy, sx, mid)
      line(sx, mid, tx, mid)
      line(tx, mid, tx, ty)
      if (e.label) {
        const left = tx - 1 - e.label.length
        wanted.set(id, {
          text: e.label,
          spots: [{ x: tx + 2, y: mid + 1 }, { x: left, y: mid + 1 }, { x: sx + 2, y: sy }, { x: sx - 1 - e.label.length, y: sy }],
        })
      }
      routes.set(id, { id, cells, dashed: e.dashed !== false, arrow: '▼' })
    } else {
      // Back edges run up the right margin, one lane each.
      const lane = content + 2 + 2 * backCount++
      const sy = s.y + 1
      const ty = t.y + 1
      line(s.x + s.w, sy, lane, sy)
      line(lane, sy, lane, ty)
      line(lane, ty, t.x + t.w, ty)
      if (e.label) wanted.set(id, { text: e.label, spots: [{ x: lane + 2, y: Math.floor((sy + ty) / 2) }] })
      routes.set(id, { id, cells, dashed: e.dashed !== false, arrow: '◀' })
    }
  }

  // Labels go where no edge, box or earlier label is; the first spot when all are taken.
  const taken = new Set<string>()
  for (const r of routes.values()) for (const [x, y] of r.cells) taken.add(`${x},${y}`)
  for (const b of boxes.values()) {
    for (let x = b.x; x < b.x + b.w; x++) for (let y = b.y; y < b.y + b.h; y++) taken.add(`${x},${y}`)
  }
  const isFree = ({ x, y }: { x: number; y: number }, text: string) =>
    x >= 0 && [...Array(text.length + 1).keys()].every(i => !taken.has(`${x + i},${y}`))
  for (const [id, { text, spots }] of wanted) {
    const at = spots.find(spot => isFree(spot, text)) ?? spots[0]!
    for (let i = 0; i < text.length; i++) taken.add(`${at.x + i},${at.y}`)
    routes.get(id)!.label = { ...at, text }
  }

  const labelRight = Math.max(0, ...[...routes.values()].map(r => (r.label ? r.label.x + r.label.text.length : 0)))
  const blockRight = Math.max(content + (backCount ? 2 + 2 * backCount : 0), labelRight)
  const textRight = Math.max(spec.title.length, spec.subtitle?.length ?? 0, ...(spec.log ?? []).map(line => line.length + 2))
  const width = Math.min(512, Math.max(blockRight, textRight) + 1)

  // Center the block (boxes, lanes, labels) under the title, subtitle and log, which stay left.
  const shift = Math.max(0, Math.floor((width - 1 - blockRight) / 2))
  for (const b of boxes.values()) b.x += shift
  for (const r of routes.values()) {
    r.cells = r.cells.map(([x, y]) => [x + shift, y])
    if (r.label) r.label.x += shift
  }
  const logLines = spec.log?.length ?? 0
  const logTop = bottom + 1
  const height = Math.min(256, logTop + logLines)
  return { width, height, boxes, routes, logTop }
}
