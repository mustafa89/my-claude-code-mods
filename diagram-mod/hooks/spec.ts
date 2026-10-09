/** One box of the diagram. */
export type DiagramNode = {
  id: string
  label: string
  detail?: string[]
  color?: string
  status?: string
}

/** One arrow; dashed unless `dashed` is false. Its id is `id` or `from->to`. */
export type DiagramEdge = {
  id?: string
  from: string
  to: string
  label?: string
  dashed?: boolean
}

/** A dot looping along an edge; `speed` 0 to 1, where 1 is 15 cells a second. */
export type DiagramPacket = {
  edge: string
  color?: string
  speed?: number
}

export type DiagramSpec = {
  title: string
  subtitle?: string
  nodes: DiagramNode[]
  edges?: DiagramEdge[]
  packets?: DiagramPacket[]
  log?: string[]
}

export const LIMITS = { nodes: 24, label: 28, detail: 4, log: 12, line: 120 }

export const INPUT_SCHEMA = {
  type: 'object',
  required: ['title', 'nodes'],
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'label'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string', description: 'Short, 1-3 words' },
          detail: { type: 'array', items: { type: 'string' }, description: 'Up to 4 short lines' },
          color: { type: 'string', description: 'blue, green, yellow, red, magenta, cyan, orange, gray or #rrggbb' },
          status: { type: 'string' },
        },
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          id: { type: 'string', description: 'Defaults to "from->to"' },
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string' },
          dashed: { type: 'boolean', description: 'Default true' },
        },
      },
    },
    packets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['edge'],
        properties: {
          edge: { type: 'string', description: 'An edge id ("from->to" unless the edge set one)' },
          color: { type: 'string' },
          speed: { type: 'number', description: 'Relative speed, 0-1 (default 1 = 15 cells a second)' },
        },
      },
    },
    log: { type: 'array', items: { type: 'string' }, description: 'Lines typed out one by one under the diagram' },
  },
} as const

export const edgeIdOf = (edge: DiagramEdge): string => edge.id ?? `${edge.from}->${edge.to}`

/** Keeps characters a Raster cell can hold (printable, one column wide). */
export function clean(text: unknown, max = LIMITS.line): string {
  const out = [...String(text ?? '')].map(ch => (isNarrow(ch.codePointAt(0) ?? 0) ? ch : '?'))
  return out.slice(0, max).join('')
}

function isNarrow(cp: number): boolean {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp > 0xffff) return false
  if (cp >= 0x300 && cp < 0x370) return false
  if (cp >= 0xd800 && cp < 0xe000) return false
  const wide: [number, number][] = [
    [0x1100, 0x115f], [0x231a, 0x231b], [0x2614, 0x2615], [0x26a1, 0x26a1],
    [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f],
    [0xff00, 0xff60], [0xffe0, 0xffe6],
  ]
  return !wide.some(([lo, hi]) => cp >= lo && cp <= hi)
}

/** Checks and trims the model's input; returns the spec or what is wrong. */
export function parseSpec(input: unknown): { spec: DiagramSpec } | { error: string } {
  const raw = (input ?? {}) as Record<string, unknown>
  if (typeof raw.title !== 'string' || raw.title.trim() === '') return { error: 'title is required' }
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) return { error: 'nodes must be a non-empty array' }
  if (raw.nodes.length > LIMITS.nodes) return { error: `at most ${LIMITS.nodes} nodes; split the idea into several diagrams` }

  const nodes: DiagramNode[] = []
  const ids = new Set<string>()
  for (const n of raw.nodes as Record<string, unknown>[]) {
    const id = String(n?.id ?? '')
    if (id === '' || ids.has(id)) return { error: `node id "${id}" is empty or repeated` }
    ids.add(id)
    nodes.push({
      id,
      label: clean(n.label ?? id, LIMITS.label),
      detail: Array.isArray(n.detail) ? n.detail.slice(0, LIMITS.detail).map(d => clean(d, LIMITS.label + 8)) : undefined,
      color: typeof n.color === 'string' ? n.color : undefined,
      status: typeof n.status === 'string' ? clean(n.status, LIMITS.label) : undefined,
    })
  }

  const edges: DiagramEdge[] = []
  const edgeIds = new Set<string>()
  for (const e of (Array.isArray(raw.edges) ? raw.edges : []) as Record<string, unknown>[]) {
    const edge: DiagramEdge = {
      id: typeof e?.id === 'string' ? e.id : undefined,
      from: String(e?.from ?? ''),
      to: String(e?.to ?? ''),
      label: typeof e?.label === 'string' ? clean(e.label, 24) : undefined,
      dashed: e?.dashed !== false,
    }
    if (!ids.has(edge.from) || !ids.has(edge.to)) return { error: `edge ${edge.from} -> ${edge.to} names an unknown node` }
    if (edge.from === edge.to) return { error: `edge on ${edge.from} loops to itself` }
    if (edgeIds.has(edgeIdOf(edge))) return { error: `edge id "${edgeIdOf(edge)}" is repeated; give one an id` }
    edgeIds.add(edgeIdOf(edge))
    edges.push(edge)
  }

  const packets: DiagramPacket[] = []
  for (const p of (Array.isArray(raw.packets) ? raw.packets : []) as Record<string, unknown>[]) {
    const edge = String(p?.edge ?? '')
    if (!edgeIds.has(edge)) return { error: `packet names unknown edge "${edge}"; edge ids are ${[...edgeIds].join(', ')}` }
    const speed = typeof p.speed === 'number' && p.speed > 0 ? Math.min(p.speed, 1) : 1
    packets.push({ edge, color: typeof p.color === 'string' ? p.color : undefined, speed })
  }

  const log = Array.isArray(raw.log) ? raw.log.slice(0, LIMITS.log).map(l => clean(l)) : undefined
  const subtitle = typeof raw.subtitle === 'string' ? clean(raw.subtitle) : undefined

  return { spec: { title: clean(raw.title), subtitle, nodes, edges, packets, log } }
}
