import { isPlainLog, LOG_TEXT_AT, METER_BAR, meterWidth, rowsOf, type Layout, type Placed, type Route } from './layout'
import type { DiagramNode, DiagramSpec, Tone } from './spec'
import { frameAt, type Frame, type NodeState } from './timeline'

const DEFAULT_BG = 0x01000000
const PALETTE: Record<string, number> = {
  blue: 0x89b4fa, green: 0xa6e3a1, yellow: 0xf9e2af, red: 0xf38ba8, magenta: 0xcba6f7,
  cyan: 0x94e2d5, orange: 0xfab387, gray: 0x9399b2, white: 0xcdd6f4,
}
const INK = {
  title: 0xcdd6f4, subtitle: 0x7f849c, detail: 0xa6adc8, dim: 0x45475a, edge: 0x585b70, edgeLabel: 0x9399b2,
  log: 0xbac2de, muted: 0x6c7086, shade: 0x1e1e2e,
}
const TONE_INK: Record<Tone, number | undefined> = { ok: 0xa6e3a1, warn: 0xf9e2af, err: 0xf38ba8, dim: 0x7f849c, run: undefined, info: undefined }
const TONE_MARK: Record<Tone, string> = { ok: '✓', warn: '!', err: '✗', dim: '·', run: '', info: '•' }
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const WAVE = '▁▂▃▄▅▆▇█'
const EIGHTHS = ' ▏▎▍▌▋▊▉'

/** Packet speed at speed 1, in cells a second. */
export const CELLS_PER_SECOND = 15
/** A packet is a comet of braille dots: this many samples, a quarter cell apart. */
const COMET = 7
export const BRAILLE = 0x2800

export function colorOf(name: string | undefined, fallback: number): number {
  if (!name) return fallback
  const hex = /^#?([0-9a-f]{6})$/i.exec(name)
  return hex ? parseInt(hex[1]!, 16) : (PALETTE[name.toLowerCase()] ?? fallback)
}

export function blend(fg: number, bg: number, share: number): number {
  const ch = (shift: number) => Math.round(((fg >> shift) & 0xff) * share + ((bg >> shift) & 0xff) * (1 - share))
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** A grid of [codePoint, fg, bg] triplets, row-major, as a Raster packs it. */
export type Grid = { columns: number; rows: number; words: Uint32Array }

type Put = (x: number, y: number, ch: string | number, fg: number, bg?: number) => void
type Write = (x: number, y: number, s: string, fg: number, bg?: number) => void

function writer(words: Uint32Array, columns: number, rows: number): { put: Put; text: Write } {
  const put: Put = (x, y, ch, fg, bg = DEFAULT_BG) => {
    if (x < 0 || y < 0 || x >= columns || y >= rows) return
    const i = (y * columns + x) * 3
    words[i] = typeof ch === 'number' ? ch : (ch.codePointAt(0) ?? 32)
    words[i + 1] = fg
    words[i + 2] = bg
  }
  const text: Write = (x, y, s, fg, bg = DEFAULT_BG) => [...s].forEach((ch, i) => put(x + i, y, ch, fg, bg))
  return { put, text }
}

const DIRS = { n: 1, s: 2, e: 4, w: 8 }
const JOINS: Record<number, [string, string]> = {
  [DIRS.n | DIRS.s]: ['┆', '│'], [DIRS.e | DIRS.w]: ['┄', '─'],
  [DIRS.n]: ['┆', '│'], [DIRS.s]: ['┆', '│'], [DIRS.e]: ['┄', '─'], [DIRS.w]: ['┄', '─'],
  [DIRS.s | DIRS.e]: ['╭', '╭'], [DIRS.s | DIRS.w]: ['╮', '╮'], [DIRS.n | DIRS.e]: ['╰', '╰'], [DIRS.n | DIRS.w]: ['╯', '╯'],
  [DIRS.n | DIRS.s | DIRS.e]: ['├', '├'], [DIRS.n | DIRS.s | DIRS.w]: ['┤', '┤'],
  [DIRS.e | DIRS.w | DIRS.s]: ['┬', '┬'], [DIRS.e | DIRS.w | DIRS.n]: ['┴', '┴'],
  [DIRS.n | DIRS.s | DIRS.e | DIRS.w]: ['┼', '┼'],
}

type EdgeCell = { x: number; y: number; glyph: string; routes: string[] }
type Still = { words: Uint32Array; edgeCells: EdgeCell[]; inBox: Set<number>; nodeColor: Map<string, number> }

// What never changes (text, edge glyphs) is worked out once per layout; frames copy it.
const stills = new WeakMap<Layout, Still>()

function stillOf(spec: DiagramSpec, layout: Layout): Still {
  const cached = stills.get(layout)
  if (cached) return cached
  const { width: columns, height: rows } = layout
  const words = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) words.set([32, DEFAULT_BG, DEFAULT_BG], i * 3)
  const { put, text } = writer(words, columns, rows)

  text(0, 0, spec.title, INK.title)
  if (spec.subtitle) text(0, 1, spec.subtitle, INK.subtitle)
  if (layout.legendRow !== undefined) {
    let x = 0
    for (const l of spec.legend ?? []) {
      put(x, layout.legendRow, '■', colorOf(l.color, INK.detail))
      text(x + 2, layout.legendRow, l.label, INK.muted)
      x += l.label.length + 5
    }
  }
  if (layout.captionRow !== undefined && spec.caption) {
    text(Math.max(0, Math.floor((columns - spec.caption.length) / 2)), layout.captionRow, spec.caption, INK.title)
  }

  // Edge glyphs: join directions per cell so merges and splits draw as junctions.
  const joins = new Map<string, { bits: number; dashed: boolean; routes: string[] }>()
  const mark = ([x, y]: [number, number], bit: number, r: Route) => {
    const k = `${x},${y}`
    const j = joins.get(k)
    joins.set(k, { bits: (j?.bits ?? 0) | bit, dashed: (j?.dashed ?? false) || r.dashed, routes: [...(j?.routes ?? []), r.id] })
  }
  for (const r of layout.routes.values()) {
    r.cells.forEach((c, i) => {
      const next = r.cells[i + 1]
      if (!next) return
      const bit = next[0] > c[0] ? DIRS.e : next[0] < c[0] ? DIRS.w : next[1] > c[1] ? DIRS.s : DIRS.n
      const back = bit === DIRS.e ? DIRS.w : bit === DIRS.w ? DIRS.e : bit === DIRS.s ? DIRS.n : DIRS.s
      mark(c, bit, r)
      mark(next, back, r)
    })
  }
  // Cells inside a box or panel: an edge crossing one must not paint over its text.
  const inBox = new Set<number>()
  for (const b of [...layout.boxes.values(), ...layout.panels.values()]) {
    for (let x = b.x; x < b.x + b.w; x++) for (let y = b.y; y < b.y + b.h; y++) inBox.add(y * columns + x)
  }
  const edgeCells: EdgeCell[] = [...joins]
    .map(([k, { bits, dashed, routes }]) => {
      const [x, y] = k.split(',').map(Number) as [number, number]
      return { x, y, glyph: JOINS[bits]?.[dashed ? 0 : 1] ?? '┼', routes: [...new Set(routes)] }
    })
    .filter(c => !inBox.has(c.y * columns + c.x))
  for (const r of layout.routes.values()) if (r.label) text(r.label.x, r.label.y, r.label.text, INK.edgeLabel)

  // Box text that never changes: label and details.
  for (const n of spec.nodes) {
    const b = layout.boxes.get(n.id) ?? layout.panels.get(n.id)
    if (!b) continue
    const color = colorOf(n.color, PALETTE.cyan!)
    const inner = b.w - 4
    const at = n.side ? 2 : 2 + Math.floor((inner - Math.min(n.label.length, inner)) / 2)
    text(b.x + at, b.y + 1, n.label.slice(0, inner), color)
    n.detail?.forEach((d, i) => text(b.x + 2, b.y + 2 + i, d.slice(0, inner), n.side ? INK.muted : INK.detail))
  }

  const nodeColor = new Map(spec.nodes.map(n => [n.id, colorOf(n.color, PALETTE.cyan!)]))
  const still = { words, edgeCells, inBox, nodeColor }
  stills.set(layout, still)
  return still
}

function border(put: Put, b: Placed, ink: number) {
  const right = b.x + b.w - 1
  const bottom = b.y + b.h - 1
  for (let x = b.x + 1; x < right; x++) {
    put(x, b.y, '┄', ink)
    put(x, bottom, '┄', ink)
  }
  for (let y = b.y + 1; y < bottom; y++) {
    put(b.x, y, '┆', ink)
    put(right, y, '┆', ink)
  }
  put(b.x, b.y, '╭', ink)
  put(right, b.y, '╮', ink)
  put(b.x, bottom, '╰', ink)
  put(right, bottom, '╯', ink)
}

const toneInk = (tone: Tone | undefined, node: number): number => (tone && TONE_INK[tone]) ?? node

/** `ms` undefined for a still picture: a running status shows a fixed mark, not a frozen spinner. */
function statusText(status: string, tone: Tone | undefined, ms: number | undefined): string {
  const spin = ms === undefined ? '◌' : SPINNER[Math.floor(ms / 80) % SPINNER.length]!
  const mark = tone === 'run' ? spin : TONE_MARK[tone ?? 'info']
  return mark ? `${mark} ${status}` : status
}

/** A bar `width` cells long filled to `value`, in eighths of a cell. */
function bar(value: number, width: number): [string, string] {
  const eighths = Math.round(Math.min(1, Math.max(0, value)) * width * 8)
  const filled = '█'.repeat(Math.floor(eighths / 8)) + (eighths % 8 ? EIGHTHS[eighths % 8] : '')
  return [filled, '░'.repeat(Math.max(0, width - [...filled].length))]
}

const BRAILLE_ROWS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

/** Braille dots for a comet sample `frac` of the way through a cell, moving (dx, dy). */
function dotsAt(frac: number, dx: number, dy: number): number {
  if (dy !== 0) {
    const row = Math.min(3, Math.floor(frac * 4))
    const r = BRAILLE_ROWS[dy > 0 ? row : 3 - row]!
    return r[0]! | r[1]!
  }
  const col = frac < 0.5 ? 0 : 1
  const c = dx > 0 ? col : 1 - col
  return BRAILLE_ROWS[1]![c]! | BRAILLE_ROWS[2]![c]!
}

/** Where a packet's head is along its route (in cells, before the arrowhead) at `ms`. */
export function packetAt(route: Route, ms: number, speed = 1, offset = 0): number {
  const length = Math.max(1, route.cells.length - 1)
  return ((ms / 1000) * CELLS_PER_SECOND * speed + offset) % length
}

function comet(put: Put, route: Route, head: number, color: number, inBox: Set<number>, columns: number) {
  const cells = new Map<number, { bits: number; share: number }>()
  for (let k = 0; k < COMET; k++) {
    const d = head - k * 0.25
    if (d < 0) break
    const i = Math.floor(d)
    const here = route.cells[i]
    const next = route.cells[i + 1]
    if (!here || !next) continue
    const prev = cells.get(i)
    cells.set(i, {
      bits: (prev?.bits ?? 0) | dotsAt(d - i, next[0] - here[0], next[1] - here[1]),
      share: Math.max(prev?.share ?? 0, 1 - (k / COMET) * 0.85),
    })
  }
  for (const [i, { bits, share }] of cells) {
    const [x, y] = route.cells[i]!
    if (!inBox.has(y * columns + x)) put(x, y, BRAILLE | bits, blend(color, INK.shade, share))
  }
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Paints the story at `ms`: still text, edges lit by activity, boxes and panels
 * with their current state, comets on active edges, the log table and the
 * footer. `animate: false` paints the finished picture with nothing moving.
 */
export function paint(spec: DiagramSpec, layout: Layout, ms: number, animate = true): Grid {
  const { width: columns, height: rows } = layout
  const still = stillOf(spec, layout)
  const words = still.words.slice()
  const { put, text } = writer(words, columns, rows)
  const frame = frameAt(spec, ms, !animate)
  const { nodeColor } = still
  const packetOf = new Map((spec.packets ?? []).map(p => [p.edge, p]))
  const edgeInk = (r: Route) => colorOf(packetOf.get(r.id)?.color, nodeColor.get(r.from) ?? INK.edge)

  // Edges: the ones carrying traffic in their packet's color, the rest dim.
  const busy = new Set<string>()
  for (const id of frame.active) {
    const r = layout.routes.get(id)
    if (r) busy.add(r.from).add(r.to)
  }
  const restInk = frame.isStill || frame.active.size === 0 ? INK.edge : INK.dim
  for (const c of still.edgeCells) {
    const lit = c.routes.find(id => frame.active.has(id))
    put(c.x, c.y, c.glyph, lit ? blend(edgeInk(layout.routes.get(lit)!), INK.shade, 0.75) : restInk)
  }
  for (const r of layout.routes.values()) {
    const [x, y] = r.cells[r.cells.length - 1]!
    if (!still.inBox.has(y * columns + x)) put(x, y, r.arrow, frame.active.has(r.id) ? edgeInk(r) : restInk)
  }

  for (const n of spec.nodes) {
    const b = layout.boxes.get(n.id) ?? layout.panels.get(n.id)
    if (!b) continue
    const color = nodeColor.get(n.id)!
    const state = frame.nodes.get(n.id)
    const isLit = busy.has(n.id) || state?.isFresh
    border(put, b, blend(color, INK.shade, isLit ? 0.95 : frame.isStill ? 0.6 : 0.4))
    if (n.side) paintPanel(text, put, n, b, color, state, frame.isStill ? undefined : frame.ms)
    else paintBox(spec, text, put, n, b, color, state, frame)
  }

  // Comets on the edges that carry traffic.
  if (animate) {
    const since = spec.steps?.length ? frame.ms - frame.stepStart : frame.ms
    const launch = (edge: string, speed: number, nth: number, of: number) => {
      const r = layout.routes.get(edge)
      if (!r || r.cells.length < 2) return
      comet(put, r, packetAt(r, since, speed, (nth * (r.cells.length - 1)) / of), edgeInk(r), still.inBox, columns)
    }
    if (spec.steps?.length) {
      for (const edge of frame.active) launch(edge, packetOf.get(edge)?.speed ?? 1, 0, 1)
    } else {
      const onEdge = new Map<string, number>()
      for (const p of spec.packets ?? []) onEdge.set(p.edge, (onEdge.get(p.edge) ?? 0) + 1)
      const sent = new Map<string, number>()
      for (const p of spec.packets ?? []) {
        const nth = sent.get(p.edge) ?? 0
        sent.set(p.edge, nth + 1)
        launch(p.edge, p.speed ?? 1, nth, onEdge.get(p.edge) ?? 1)
      }
    }
  }

  // Log: the newest rows that fit; the row still typing carries a cursor.
  const shown = frame.log.slice(-layout.logRows)
  const plain = isPlainLog(spec)
  shown.forEach((row, i) => {
    const y = layout.logTop + i
    const isNewest = i === shown.length - 1
    const { entry } = row
    const typed = entry.text.slice(0, row.typed)
    const isTyping = row.typed < entry.text.length
    put(0, y, '›', isNewest ? INK.title : INK.muted)
    if (plain) {
      text(2, y, typed, PALETTE.green!)
    } else {
      text(2, y, clock(row.at), INK.muted)
      if (entry.actor) text(9, y, entry.actor.slice(0, 11), nodeColor.get(entry.actor) ?? INK.edgeLabel)
      text(LOG_TEXT_AT, y, typed, isNewest ? INK.title : INK.log)
      if (entry.status && !isTyping) text(columns - 1 - entry.status.length, y, entry.status, toneInk(entry.tone, INK.detail))
    }
    if (isTyping && !frame.isStill) put((plain ? 2 : LOG_TEXT_AT) + typed.length, y, '▌', INK.title)
  })

  // Footer: counters, and where the story is.
  if (layout.footerRow !== undefined) {
    let x = 0
    for (const [name, value] of frame.counters) {
      text(x, layout.footerRow, `${name}:`, INK.muted)
      x += name.length + 2
      const shownValue = `[${Math.round(value).toLocaleString('en-US')}]`
      text(x, layout.footerRow, shownValue, INK.title)
      x += shownValue.length + 3
    }
    if (spec.steps?.length && !frame.isStill) {
      const where = `[step ${frame.step + 1}/${spec.steps.length}]`
      text(columns - 1 - where.length, layout.footerRow, where, INK.muted)
    }
  }

  return { columns, rows, words }
}

function paintBox(spec: DiagramSpec, text: Write, put: Put, n: DiagramNode, b: Placed, color: number, state: NodeState | undefined, frame: Frame) {
  const r = rowsOf(spec, n)
  const inner = b.w - 4
  let y = b.y + 2 + r.detail

  // Meters: label, a bar filled in eighths of a cell, the value, an optional note.
  const labelW = Math.max(0, ...(n.meters ?? []).map(m => m.label.length))
  const barAt = b.x + 2 + Math.max(0, Math.floor((inner - meterWidth(n)) / 2)) + labelW + 1
  n.meters?.forEach((m, i) => {
    const value = state?.meters[i] ?? m.value
    const ink = toneInk(m.tone, color)
    text(barAt - labelW - 1, y, m.label, INK.detail)
    const [filled, rest] = bar(value, METER_BAR)
    text(barAt, y, filled, ink)
    text(barAt + [...filled].length, y, rest, blend(ink, INK.shade, 0.35))
    text(barAt + METER_BAR + 1, y, value.toFixed(2), ink)
    if (m.text) text(barAt + METER_BAR + 6, y, m.text, ink)
    y++
  })

  // Spark: a wave that drifts left, brighter at its peaks.
  if (n.spark) {
    const t = frame.isStill ? 0 : frame.ms / 1000
    for (let i = 0; i < inner; i++) {
      const v = 0.5 + 0.3 * Math.sin(i * 0.55 - t * 5) + 0.2 * Math.sin(i * 0.23 + t * 2.3)
      const level = Math.max(0, Math.min(7, Math.round(v * 7)))
      put(b.x + 2 + i, y, WAVE[level]!, blend(color, INK.shade, 0.35 + 0.65 * (level / 7)))
    }
    y++
  }

  if (r.status && state?.status) {
    const ink = toneInk(state.tone, color)
    text(b.x + 2, y, statusText(state.status, state.tone, frame.isStill ? undefined : frame.ms).slice(0, inner), state.isFresh ? blend(ink, 0xffffff, 0.75) : ink)
  }
}

function paintPanel(text: Write, put: Put, n: DiagramNode, b: Placed, color: number, state: NodeState | undefined, ms: number | undefined) {
  const inner = b.w - 4
  let y = b.y + 2 + (n.detail?.length ?? 0) + (n.items?.length ? 1 : 0)
  n.items?.forEach((item, i) => {
    if (i === state?.highlight) {
      const shade = blend(color, INK.shade, 0.3)
      for (let x = b.x + 1; x < b.x + b.w - 1; x++) put(x, y, ' ', INK.title, shade)
      text(b.x + 2, y, `◆ ${item}`.slice(0, inner), INK.title, shade)
    } else {
      text(b.x + 2, y, `○ ${item}`.slice(0, inner), INK.muted)
    }
    y++
  })
  if (state?.status) text(b.x + 2, b.y + b.h - 2, statusText(state.status, state.tone, ms).slice(0, inner), toneInk(state.tone, color))
}

/** Standard padded base64 of the grid's little-endian u32s, as Raster `cells` wants. */
export function encode(grid: Grid): string {
  const bytes = new Uint8Array(grid.words.buffer, grid.words.byteOffset, grid.words.byteLength)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** The finished picture as plain text, for a narrow terminal or a surface with no Raster. */
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
