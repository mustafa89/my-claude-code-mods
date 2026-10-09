import { edgeIdOf, type DiagramNode, type DiagramSpec } from './spec'

export type Placed = { id: string; layer: number; x: number; y: number; w: number; h: number }

/** An edge's cells from source to arrowhead, in travel order. */
export type Route = {
  id: string
  from: string
  to: string
  cells: [number, number][]
  dashed: boolean
  arrow: '▼' | '◀' | '▶'
  label?: { x: number; y: number; text: string }
}

export type Layout = {
  width: number
  height: number
  boxes: Map<string, Placed>
  /** Side panels, keyed by node id; drawn as tall boxes beside the tree. */
  panels: Map<string, Placed>
  routes: Map<string, Route>
  legendRow?: number
  captionRow?: number
  /** First log row and how many rows the log shows (the newest ones). */
  logTop: number
  logRows: number
  footerRow?: number
}

const ROW_GAP = 4
const COL_GAP = 3
const SIDE_GAP = 6
const MIN_BOX = 10
const MAX_BOX = 44
const MAX_PANEL = 34
export const METER_BAR = 12
export const LOG_ROWS = 6
/** Columns before a log row's text: `00:04  actor         `. */
export const LOG_TEXT_AT = 21

/** True when no row of the log names an actor or a status: rows print as plain lines. */
export const isPlainLog = (spec: DiagramSpec) =>
  !spec.steps?.length && (spec.log ?? []).every(l => l.actor === undefined && l.status === undefined)

/** Layer per node by longest path from the roots; back edges (cycles) are skipped. */
export function layersOf(spec: DiagramSpec): { layer: Map<string, number>; back: Set<string> } {
  const tree = spec.nodes.filter(n => !n.side)
  const inTree = new Set(tree.map(n => n.id))
  const treeEdges = (spec.edges ?? []).filter(e => inTree.has(e.from) && inTree.has(e.to))
  const out = new Map(tree.map(n => [n.id, [] as { to: string; id: string }[]]))
  for (const e of treeEdges) out.get(e.from)?.push({ to: e.to, id: edgeIdOf(e) })

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
  for (const n of tree) if (!state.has(n.id)) visit(n.id)

  const layer = new Map(tree.map(n => [n.id, 0]))
  for (const id of post.reverse()) {
    for (const { to, id: edgeId } of out.get(id) ?? []) {
      if (!back.has(edgeId)) layer.set(to, Math.max(layer.get(to) ?? 0, (layer.get(id) ?? 0) + 1))
    }
  }
  // A source sits just above its nearest child, not in the top row with long edges down.
  const hasParent = new Set(treeEdges.filter(e => !back.has(edgeIdOf(e))).map(e => e.to))
  for (const [id, children] of out) {
    const forward = children.filter(c => !back.has(c.id))
    if (hasParent.has(id) || forward.length === 0) continue
    layer.set(id, Math.min(...forward.map(c => layer.get(c.to) ?? 1)) - 1)
  }
  return { layer, back }
}

/** Every status a node shows over the story, so its box is wide enough for all of them. */
function statusesOf(spec: DiagramSpec, id: string): string[] {
  const base = spec.nodes.find(n => n.id === id)?.status
  const later = (spec.steps ?? []).map(s => s.nodes[id]?.status).filter((s): s is string => s !== undefined)
  return [...(base ? [base] : []), ...later]
}

export function meterWidth(n: DiagramNode): number {
  const label = Math.max(0, ...(n.meters ?? []).map(m => m.label.length))
  const text = Math.max(0, ...(n.meters ?? []).map(m => (m.text ? m.text.length + 1 : 0)))
  return n.meters?.length ? label + 1 + METER_BAR + 5 + text : 0
}

/** Rows inside a box after its label: details, meters, the wave, the status. */
export function rowsOf(spec: DiagramSpec, n: DiagramNode) {
  const hasStatus = statusesOf(spec, n.id).length > 0
  return { detail: n.detail?.length ?? 0, meters: n.meters?.length ?? 0, spark: n.spark ? 1 : 0, status: hasStatus ? 1 : 0 }
}

/** Places every box top to bottom, side panels beside them, and routes every edge. */
export function layout(spec: DiagramSpec): Layout {
  const { layer, back } = layersOf(spec)
  const tree = spec.nodes.filter(n => !n.side)
  const order = new Map(spec.nodes.map((n, i) => [n.id, i]))
  const depth = tree.length ? Math.max(...layer.values()) + 1 : 0

  const sizeOf = (n: DiagramNode) => {
    const statusW = Math.max(-2, ...statusesOf(spec, n.id).map(s => s.length)) + 2
    const text = Math.max(n.label.length, ...(n.detail ?? []).map(d => d.length), statusW, meterWidth(n), n.spark ? 16 : 0)
    const r = rowsOf(spec, n)
    return { w: Math.min(MAX_BOX, Math.max(MIN_BOX, text + 4)), h: 3 + r.detail + r.meters + r.spark + r.status }
  }

  // Rows of ids per layer, each layer after the first sorted under its parents.
  const rows: string[][] = Array.from({ length: depth }, () => [])
  for (const n of tree) rows[layer.get(n.id) ?? 0]!.push(n.id)
  const parents = new Map<string, string[]>()
  for (const e of spec.edges ?? []) {
    if (layer.has(e.from) && layer.has(e.to) && !back.has(edgeIdOf(e))) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from])
  }
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
  const legendRow = spec.legend ? (spec.subtitle ? 2 : 1) : undefined
  const header = 1 + (spec.subtitle ? 1 : 0) + (spec.legend ? 1 : 0) + 1
  // Boxes are laid out over their own widest row; the whole block is centered in the canvas at the end.
  const content = Math.max(0, ...rows.map(rowWidth))

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
  let bottom = rows.length ? y - ROW_GAP : header

  const routes = new Map<string, Route>()
  const wanted = new Map<string, { text: string; spots: { x: number; y: number }[] }>()
  let backCount = 0
  const laneLabels: { id: string; text: string; y: number }[] = []
  const lineOf = (cells: [number, number][]) => {
    const push = (x: number, y: number) => {
      const last = cells[cells.length - 1]
      if (!last || last[0] !== x || last[1] !== y) cells.push([x, y])
    }
    return (x0: number, y0: number, x1: number, y1: number) => {
      const dx = Math.sign(x1 - x0)
      const dy = Math.sign(y1 - y0)
      for (let x = x0, y = y0; ; x += dx, y += dy) {
        push(x, y)
        if (x === x1 && y === y1) break
      }
    }
  }

  for (const e of spec.edges ?? []) {
    const id = edgeIdOf(e)
    const s = boxes.get(e.from)
    const t = boxes.get(e.to)
    if (!s || !t) continue // a side panel's edge, routed once the panels are placed
    const cells: [number, number][] = []
    const line = lineOf(cells)
    const base = { id, from: e.from, to: e.to, cells, dashed: e.dashed !== false }
    if (!back.has(id) && t.layer === s.layer + 1) {
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
      routes.set(id, { ...base, arrow: '▼' })
    } else {
      // Back edges and edges skipping a layer run along the right margin, one lane each,
      // so they never cut through the boxes between.
      const lane = content + 2 + 2 * backCount++
      const sy = s.y + 1
      const ty = t.y + 1
      line(s.x + s.w, sy, lane, sy)
      line(lane, sy, lane, ty)
      line(lane, ty, t.x + t.w, ty)
      if (e.label) laneLabels.push({ id, text: e.label, y: Math.floor((sy + ty) / 2) })
      routes.set(id, { ...base, arrow: '◀' })
    }
  }

  for (const l of laneLabels) wanted.set(l.id, { text: l.text, spots: [{ x: content + 2 + 2 * backCount, y: l.y }] })

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

  // Side panels: as tall as the tree, or their own content if taller.
  const panelOf = (n: DiagramNode) => {
    const items = n.items ?? []
    const w = Math.min(MAX_PANEL, Math.max(MIN_BOX, n.label.length + 4, ...(n.detail ?? []).map(d => d.length + 4), ...items.map(i => i.length + 6)))
    const h = 3 + (n.detail?.length ?? 0) + (items.length ? items.length + 1 : 0) + (statusesOf(spec, n.id).length ? 2 : 0)
    return { w, h }
  }
  const leftPanels = spec.nodes.filter(n => n.side === 'left')
  const rightPanels = spec.nodes.filter(n => n.side === 'right')
  const panelColumn = (list: DiagramNode[]) => ({
    w: Math.max(0, ...list.map(n => panelOf(n).w)),
    h: list.reduce((sum, n) => sum + panelOf(n).h + 1, -1),
  })
  const left = panelColumn(leftPanels)
  const right = panelColumn(rightPanels)
  bottom = Math.max(bottom, header + left.h, header + right.h)

  const labelRight = Math.max(0, ...[...routes.values()].map(r => (r.label ? r.label.x + r.label.text.length : 0)))
  const treeRight = Math.max(content + (backCount ? 2 + 2 * backCount : 0), labelRight)
  const treeAt = leftPanels.length ? left.w + SIDE_GAP : 0
  const rightAt = treeAt + treeRight + SIDE_GAP
  const blockRight = rightPanels.length ? rightAt + right.w : treeAt + treeRight

  // Rows under the diagram: caption, the log table, the footer.
  let below = bottom + 1
  const captionRow = spec.caption ? below : undefined
  if (spec.caption) below += 2
  const logCount = (spec.log?.length ?? 0) + (spec.steps ?? []).reduce((sum, s) => sum + s.log.length, 0)
  const logRows = Math.min(LOG_ROWS, logCount)
  const logTop = below
  below += logRows
  const footerRow = spec.counters || spec.steps?.some(s => Object.keys(s.counters).length) ? below + (logRows ? 1 : 0) : undefined
  const height = Math.min(256, footerRow !== undefined ? footerRow + 1 : below)

  const allLog = [...(spec.log ?? []), ...(spec.steps ?? []).flatMap(s => s.log)]
  const textAt = isPlainLog(spec) ? 2 : LOG_TEXT_AT
  const logRight = Math.max(0, ...allLog.map(l => textAt + l.text.length + (l.status ? l.status.length + 3 : 0)))
  const counterNames = [...new Set([...Object.keys(spec.counters ?? {}), ...(spec.steps ?? []).flatMap(st => Object.keys(st.counters))])]
  const counterMax = (name: string) =>
    Math.max(spec.counters?.[name] ?? 0, ...(spec.steps ?? []).map(st => st.counters[name] ?? 0))
  const footerRight =
    counterNames.reduce((sum, name) => sum + name.length + 2 + Math.round(counterMax(name)).toLocaleString('en-US').length + 5, 0) +
    (spec.steps?.length ? 16 : 0)
  const textRight = Math.max(
    footerRight,
    spec.title.length,
    spec.subtitle?.length ?? 0,
    spec.caption?.length ?? 0,
    (spec.legend ?? []).reduce((sum, l) => sum + l.label.length + 5, 0),
    logRight,
  )
  const width = Math.min(512, Math.max(blockRight, textRight) + 1)

  // Center the block (panels, boxes, lanes, labels) under the text rows, which stay left.
  const shift = Math.max(0, Math.floor((width - 1 - blockRight) / 2))
  const dx = shift + treeAt
  for (const b of boxes.values()) b.x += dx
  for (const r of routes.values()) {
    r.cells = r.cells.map(([x, y]) => [x + dx, y])
    if (r.label) r.label.x += dx
  }

  const panels = new Map<string, Placed>()
  const stack = (list: DiagramNode[], x: number, w: number) => {
    let py = header
    list.forEach((n, i) => {
      const own = panelOf(n).h
      // The last panel in a column stretches to the bottom of the diagram.
      const h = i === list.length - 1 ? Math.max(own, bottom - py) : own
      panels.set(n.id, { id: n.id, layer: -1, x, y: py, w, h })
      py += h + 1
    })
  }
  stack(leftPanels, shift, left.w)
  stack(rightPanels, shift + rightAt, right.w)

  // Edges between a panel and a box run straight across at the box's middle row.
  const placed = new Set<string>()
  for (const b of [...boxes.values(), ...panels.values()]) {
    for (let x = b.x; x < b.x + b.w; x++) for (let y = b.y; y < b.y + b.h; y++) placed.add(`${x},${y}`)
  }
  for (const r of routes.values()) {
    for (const [x, y] of r.cells) placed.add(`${x},${y}`)
    if (r.label) for (let i = 0; i < r.label.text.length; i++) placed.add(`${r.label.x + i},${r.label.y}`)
  }
  const isOpen = ({ x, y }: { x: number; y: number }, text: string) =>
    [...Array(text.length + 1).keys()].every(i => !placed.has(`${x + i},${y}`))
  for (const e of spec.edges ?? []) {
    const id = edgeIdOf(e)
    if (routes.has(id)) continue
    const p = panels.get(e.from) ?? panels.get(e.to)
    const b = boxes.get(e.from) ?? boxes.get(e.to)
    if (!p || !b) continue
    const boxRow = b.y + Math.floor(b.h / 2)
    const row = Math.min(Math.max(boxRow, p.y + 1), p.y + p.h - 2)
    const isLeft = p.x < b.x
    const panelSide = isLeft ? p.x + p.w : p.x - 1
    const boxSide = isLeft ? b.x - 1 : b.x + b.w
    const cells: [number, number][] = []
    const line = lineOf(cells)
    const fromPanel = panels.has(e.from)
    const bend = isLeft ? panelSide + 2 : panelSide - 2
    const path: [number, number][] =
      row === boxRow ? [[panelSide, row], [boxSide, row]] : [[panelSide, row], [bend, row], [bend, boxRow], [boxSide, boxRow]]
    const ordered = fromPanel ? path : [...path].reverse()
    ordered.slice(1).forEach(([x, y], i) => line(ordered[i]![0], ordered[i]![1], x, y))
    const goesRight = cells.length > 1 && cells[cells.length - 1]![0] > cells[0]![0]
    const startX = Math.min(...cells.map(c => c[0]))
    const label = e.label ? [{ x: startX + 2, y: row - 1 }, { x: startX + 2, y: row + 1 }].find(spot => isOpen(spot, e.label!)) : undefined
    for (const [x, y] of cells) placed.add(`${x},${y}`)
    if (label && e.label) for (let i = 0; i < e.label.length; i++) placed.add(`${label.x + i},${label.y}`)
    routes.set(id, {
      id, from: e.from, to: e.to, cells, dashed: e.dashed !== false, arrow: goesRight ? '▶' : '◀',
      label: label && e.label ? { ...label, text: e.label } : undefined,
    })
  }

  return { width, height, boxes, panels, routes, legendRow, captionRow, logTop, logRows, footerRow }
}
