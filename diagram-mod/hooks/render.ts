import type { Layout, Route } from './layout'
import type { DiagramSpec } from './spec'

const DEFAULT_BG = 0x01000000
const PALETTE: Record<string, number> = {
  blue: 0x89b4fa, green: 0xa6e3a1, yellow: 0xf9e2af, red: 0xf38ba8, magenta: 0xcba6f7,
  cyan: 0x94e2d5, orange: 0xfab387, gray: 0x9399b2, white: 0xcdd6f4,
}
const INK = { title: 0xcdd6f4, subtitle: 0x7f849c, border: 0x6c7086, detail: 0xa6adc8, edge: 0x585b70, edgeLabel: 0x9399b2, log: 0xa6e3a1, prompt: 0x6c7086 }
export const PACKET = '●'
const TRAIL: [string, number][] = [['•', 0.55], ['·', 0.25]] // glyph, share of the packet's color
/** Packet cells per frame at speed 1: half a cell at 30 fps, 15 cells a second. */
export const CELLS_PER_FRAME = 0.5
const LOG_CHARS_PER_FRAME = 1

export function colorOf(name: string | undefined, fallback: number): number {
  if (!name) return fallback
  const hex = /^#?([0-9a-f]{6})$/i.exec(name)
  return hex ? parseInt(hex[1]!, 16) : (PALETTE[name.toLowerCase()] ?? fallback)
}

/** How far along its route (in whole cells, before wrapping) a packet is at `tick`. */
const stepOf = (tick: number, speed: number, offset: number) => Math.floor(tick * speed * CELLS_PER_FRAME) + offset

/** A packet's cell on its route at `tick`: CELLS_PER_FRAME cells per frame at speed 1. */
export function packetCell(route: Route, tick: number, speed = 1, offset = 0): [number, number] {
  return route.cells[stepOf(tick, speed, offset) % route.cells.length]!
}

function blend(fg: number, bg: number, share: number): number {
  const ch = (shift: number) => Math.round(((fg >> shift) & 0xff) * share + ((bg >> shift) & 0xff) * (1 - share))
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

function writer(words: Uint32Array, columns: number, rows: number) {
  const put = (x: number, y: number, ch: string, fg: number) => {
    if (x < 0 || y < 0 || x >= columns || y >= rows) return
    const i = (y * columns + x) * 3
    words[i] = ch.codePointAt(0) ?? 32
    words[i + 1] = fg
    words[i + 2] = DEFAULT_BG
  }
  const text = (x: number, y: number, s: string, fg: number) => [...s].forEach((ch, i) => put(x + i, y, ch, fg))
  return { put, text }
}

/** A grid of [codePoint, fg, bg] triplets, row-major, as a Raster packs it. */
export type Grid = { columns: number; rows: number; words: Uint32Array }

const DIRS = { n: 1, s: 2, e: 4, w: 8 }
const JOINS: Record<number, [string, string]> = {
  [DIRS.n | DIRS.s]: ['┆', '│'], [DIRS.e | DIRS.w]: ['┄', '─'],
  [DIRS.n]: ['┆', '│'], [DIRS.s]: ['┆', '│'], [DIRS.e]: ['┄', '─'], [DIRS.w]: ['┄', '─'],
  [DIRS.s | DIRS.e]: ['╭', '╭'], [DIRS.s | DIRS.w]: ['╮', '╮'], [DIRS.n | DIRS.e]: ['╰', '╰'], [DIRS.n | DIRS.w]: ['╯', '╯'],
  [DIRS.n | DIRS.s | DIRS.e]: ['├', '├'], [DIRS.n | DIRS.s | DIRS.w]: ['┤', '┤'],
  [DIRS.e | DIRS.w | DIRS.s]: ['┬', '┬'], [DIRS.e | DIRS.w | DIRS.n]: ['┴', '┴'],
  [DIRS.n | DIRS.s | DIRS.e | DIRS.w]: ['┼', '┼'],
}

// The still parts (title, edges, boxes) are painted once per layout; frames copy them.
const bases = new WeakMap<Layout, Uint32Array>()

function paintBase(spec: DiagramSpec, layout: Layout): Uint32Array {
  const { width: columns, height: rows } = layout
  const words = new Uint32Array(columns * rows * 3)
  const { put, text } = writer(words, columns, rows)
  for (let i = 0; i < columns * rows; i++) words.set([32, DEFAULT_BG, DEFAULT_BG], i * 3)

  text(0, 0, spec.title, INK.title)
  if (spec.subtitle) text(0, 1, spec.subtitle, INK.subtitle)

  // Edges: join directions per cell so merges and splits draw as junctions.
  const joins = new Map<string, { bits: number; dashed: boolean }>()
  const mark = ([x, y]: [number, number], bit: number, dashed: boolean) => {
    const k = `${x},${y}`
    const j = joins.get(k)
    joins.set(k, { bits: (j?.bits ?? 0) | bit, dashed: j ? j.dashed || dashed : dashed })
  }
  for (const r of layout.routes.values()) {
    r.cells.forEach((c, i) => {
      const next = r.cells[i + 1]
      if (!next) return
      const bit = next[0] > c[0] ? DIRS.e : next[0] < c[0] ? DIRS.w : next[1] > c[1] ? DIRS.s : DIRS.n
      const back = bit === DIRS.e ? DIRS.w : bit === DIRS.w ? DIRS.e : bit === DIRS.s ? DIRS.n : DIRS.s
      mark(c, bit, r.dashed)
      mark(next, back, r.dashed)
    })
  }
  for (const [k, { bits, dashed }] of joins) {
    const [x, y] = k.split(',').map(Number) as [number, number]
    put(x, y, JOINS[bits]?.[dashed ? 0 : 1] ?? '┼', INK.edge)
  }
  for (const r of layout.routes.values()) {
    const [x, y] = r.cells[r.cells.length - 1]!
    put(x, y, r.arrow, INK.edge)
    if (r.label) text(r.label.x, r.label.y, r.label.text, INK.edgeLabel)
  }

  // Boxes, dashed border, label in the node's color.
  for (const n of spec.nodes) {
    const b = layout.boxes.get(n.id)!
    const color = colorOf(n.color, PALETTE.cyan!)
    const right = b.x + b.w - 1
    const bottom = b.y + b.h - 1
    for (let x = b.x; x <= right; x++) {
      for (let y = b.y; y <= bottom; y++) put(x, y, ' ', INK.border)
      put(x, b.y, '┄', INK.border)
      put(x, bottom, '┄', INK.border)
    }
    for (let y = b.y; y <= bottom; y++) {
      put(b.x, y, '┆', INK.border)
      put(right, y, '┆', INK.border)
    }
    put(b.x, b.y, '╭', INK.border)
    put(right, b.y, '╮', INK.border)
    put(b.x, bottom, '╰', INK.border)
    put(right, bottom, '╯', INK.border)
    const inner = b.w - 4
    const centered = (s: string) => Math.floor((inner - Math.min(s.length, inner)) / 2)
    text(b.x + 2 + centered(n.label), b.y + 1, n.label.slice(0, inner), color)
    n.detail?.forEach((d, i) => text(b.x + 2, b.y + 2 + i, d.slice(0, inner), INK.detail))
    if (n.status) {
      const y = b.y + 2 + (n.detail?.length ?? 0)
      put(b.x + 2, y, '•', color)
      text(b.x + 4, y, n.status.slice(0, inner - 2), color)
    }
  }
  return words
}

/**
 * Paints one frame: the still parts, packets with a fading trail at `tick`, and
 * the log typed out to `tick`. `animate: false` paints the still picture
 * (no packets, full log).
 */
export function paint(spec: DiagramSpec, layout: Layout, tick: number, animate = true): Grid {
  const { width: columns, height: rows } = layout
  let base = bases.get(layout)
  if (!base) bases.set(layout, (base = paintBase(spec, layout)))
  const words = base.slice()
  const { put, text } = writer(words, columns, rows)

  if (animate) {
    const onEdge = new Map<string, number>()
    for (const p of spec.packets ?? []) onEdge.set(p.edge, (onEdge.get(p.edge) ?? 0) + 1)
    const seen = new Map<string, number>()
    const heads: [number, number, number][] = []
    for (const p of spec.packets ?? []) {
      const route = layout.routes.get(p.edge)
      if (!route) continue
      const nth = seen.get(p.edge) ?? 0
      seen.set(p.edge, nth + 1)
      const offset = Math.floor((nth * route.cells.length) / (onEdge.get(p.edge) ?? 1))
      const color = colorOf(p.color, PALETTE.yellow!)
      const at = stepOf(tick, p.speed ?? 1, offset) % route.cells.length
      // The trail stays on this lap: no tail drawn back over the arrowhead.
      TRAIL.forEach(([glyph, share], k) => {
        const cell = route.cells[at - k - 1]
        if (cell) put(cell[0], cell[1], glyph, blend(color, INK.edge, share))
      })
      heads.push([...route.cells[at]!, color])
    }
    for (const [x, y, color] of heads) put(x, y, PACKET, color)
  }

  // Log: each line types out after the one before it.
  let budget = animate ? tick * LOG_CHARS_PER_FRAME : Infinity
  spec.log?.forEach((line, i) => {
    const y = layout.logTop + i
    if (budget <= 0) return
    put(0, y, '›', INK.prompt)
    const shown = line.slice(0, Math.min(line.length, budget))
    text(2, y, shown, INK.log)
    if (shown.length < line.length) put(2 + shown.length, y, '▌', INK.log)
    budget -= line.length + 1
  })

  return { columns, rows, words }
}

/** Standard padded base64 of the grid's little-endian u32s, as Raster `cells` wants. */
export function encode(grid: Grid): string {
  const bytes = new Uint8Array(grid.words.buffer, grid.words.byteOffset, grid.words.byteLength)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** The still picture as plain text, for a narrow terminal or a surface with no Raster. */
export function toText(spec: DiagramSpec, layout: Layout): string {
  const { columns, rows, words } = paint(spec, layout, 0, false)
  const lines: string[] = []
  for (let y = 0; y < rows; y++) {
    let line = ''
    for (let x = 0; x < columns; x++) line += String.fromCodePoint(words[(y * columns + x) * 3]!)
    lines.push(line.trimEnd())
  }
  return lines.join('\n')
}
