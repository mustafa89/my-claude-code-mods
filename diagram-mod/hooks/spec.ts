/** How a status, meter or log row reads: ok green, warn amber, err red, run spins, dim grey, info the node's color. */
export type Tone = 'ok' | 'warn' | 'err' | 'run' | 'dim' | 'info'
const TONES: readonly Tone[] = ['ok', 'warn', 'err', 'run', 'dim', 'info']

/** A labelled bar inside a box; `value` 0 to 1. */
export type DiagramMeter = { label: string; value: number; text?: string; tone?: Tone }

/**
 * One box of the diagram. `side` makes it a tall panel beside the tree, whose
 * `items` a step can highlight.
 */
export type DiagramNode = {
  id: string
  label: string
  detail?: string[]
  color?: string
  status?: string
  tone?: Tone
  meters?: DiagramMeter[]
  spark?: boolean
  side?: 'left' | 'right'
  items?: string[]
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

/** A log row: plain text, or an actor (a node id colors it), the message and a toned status. */
export type DiagramLogEntry = { actor?: string; text: string; status?: string; tone?: Tone }

/** What changes on a node when a step starts; `highlight` picks a side panel item. */
export type DiagramNodeUpdate = { status?: string; tone?: Tone; meters?: number[]; highlight?: number }

/** One beat of the story: which edges carry traffic, what changes, what is logged. */
export type DiagramStep = {
  duration: number
  active: string[]
  nodes: Record<string, DiagramNodeUpdate>
  log: DiagramLogEntry[]
  counters: Record<string, number>
}

export type DiagramSpec = {
  title: string
  subtitle?: string
  caption?: string
  legend?: { label: string; color: string }[]
  nodes: DiagramNode[]
  edges?: DiagramEdge[]
  packets?: DiagramPacket[]
  log?: DiagramLogEntry[]
  steps?: DiagramStep[]
  counters?: Record<string, number>
}

export const LIMITS = { nodes: 24, label: 28, detail: 6, meters: 4, items: 8, log: 40, steps: 16, line: 120 }
export const STEP_MS = { min: 600, default: 2500, max: 10000 }

const TONE_SCHEMA = { type: 'string', enum: TONES, description: 'ok, warn, err, run (spinner), dim or info' }
const LOG_SCHEMA = {
  type: 'array',
  items: {
    anyOf: [
      { type: 'string' },
      {
        type: 'object',
        required: ['text'],
        properties: {
          actor: { type: 'string', description: 'A node id colors it' },
          text: { type: 'string' },
          status: { type: 'string', description: 'Right-aligned, e.g. "[ok]" or "exit 1"' },
          tone: TONE_SCHEMA,
        },
      },
    ],
  },
}

export const INPUT_SCHEMA = {
  type: 'object',
  required: ['title', 'nodes'],
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    caption: { type: 'string', description: 'One line under the diagram: the takeaway' },
    legend: {
      type: 'array',
      items: { type: 'object', required: ['label', 'color'], properties: { label: { type: 'string' }, color: { type: 'string' } } },
    },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'label'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string', description: 'Short, 1-3 words' },
          detail: { type: 'array', items: { type: 'string' }, description: 'Up to 6 short lines' },
          color: { type: 'string', description: 'blue, green, yellow, red, magenta, cyan, orange, gray or #rrggbb' },
          status: { type: 'string' },
          tone: TONE_SCHEMA,
          meters: {
            type: 'array',
            description: 'Up to 4 bars: label, value 0-1, optional text after the value',
            items: {
              type: 'object',
              required: ['label', 'value'],
              properties: { label: { type: 'string' }, value: { type: 'number' }, text: { type: 'string' }, tone: TONE_SCHEMA },
            },
          },
          spark: { type: 'boolean', description: 'Adds a moving activity wave row' },
          side: { type: 'string', enum: ['left', 'right'], description: 'A tall panel beside the tree' },
          items: { type: 'array', items: { type: 'string' }, description: 'Panel rows a step can highlight' },
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
      description: 'Without steps: packets loop on these edges. With steps: sets the color and speed per edge',
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
    log: { ...LOG_SCHEMA, description: 'Without steps: rows typed out one by one under the diagram' },
    steps: {
      type: 'array',
      description: 'A story played in a loop. Each step lights its active edges, applies node updates, adds log rows and moves counters',
      items: {
        type: 'object',
        properties: {
          duration: { type: 'number', description: 'Milliseconds, default 2500' },
          active: { type: 'array', items: { type: 'string' }, description: 'Edge ids carrying traffic in this step' },
          nodes: {
            type: 'object',
            description: 'Node id -> { status, tone, meters (values 0-1, in meter order), highlight (panel item index) }',
            additionalProperties: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                tone: TONE_SCHEMA,
                meters: { type: 'array', items: { type: 'number' } },
                highlight: { type: 'number' },
              },
            },
          },
          log: LOG_SCHEMA,
          counters: { type: 'object', additionalProperties: { type: 'number' }, description: 'Counter name -> value to count up to' },
        },
      },
    },
    counters: { type: 'object', additionalProperties: { type: 'number' }, description: 'Footer counters and their start values' },
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

const toneOf = (v: unknown): Tone | undefined => (TONES.includes(v as Tone) ? (v as Tone) : undefined)
const unit = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function logOf(raw: unknown): DiagramLogEntry[] {
  return (Array.isArray(raw) ? raw : []).slice(0, LIMITS.log).map(entry =>
    isRecord(entry)
      ? {
          actor: typeof entry.actor === 'string' ? clean(entry.actor, 14) : undefined,
          text: clean(entry.text),
          status: typeof entry.status === 'string' ? clean(entry.status, 24) : undefined,
          tone: toneOf(entry.tone),
        }
      : { text: clean(entry) },
  )
}

function countersOf(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
      .slice(0, 6)
      .map(([k, v]) => [clean(k, 16), v as number]),
  )
}

/** Checks and trims the model's input; returns the spec or what is wrong. */
export function parseSpec(input: unknown): { spec: DiagramSpec } | { error: string } {
  const raw = { ...((input ?? {}) as Record<string, unknown>) }
  // A caller with an older schema may send lists and objects as JSON text.
  for (const key of ['nodes', 'edges', 'packets', 'log', 'steps', 'legend', 'counters']) {
    if (typeof raw[key] !== 'string') continue
    try {
      raw[key] = JSON.parse(raw[key] as string)
    } catch {
      return { error: `${key} is not valid JSON` }
    }
  }
  if (typeof raw.title !== 'string' || raw.title.trim() === '') return { error: 'title is required' }
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) return { error: 'nodes must be a non-empty array' }
  if (raw.nodes.length > LIMITS.nodes) return { error: `at most ${LIMITS.nodes} nodes; split the idea into several diagrams` }

  const nodes: DiagramNode[] = []
  const ids = new Set<string>()
  for (const n of raw.nodes as Record<string, unknown>[]) {
    const id = String(n?.id ?? '')
    if (id === '' || ids.has(id)) return { error: `node id "${id}" is empty or repeated` }
    ids.add(id)
    const meters = Array.isArray(n.meters)
      ? (n.meters as Record<string, unknown>[]).slice(0, LIMITS.meters).map(m => ({
          label: clean(m?.label, 10),
          value: unit(m?.value),
          text: typeof m?.text === 'string' ? clean(m.text, 8) : undefined,
          tone: toneOf(m?.tone),
        }))
      : undefined
    nodes.push({
      id,
      label: clean(n.label ?? id, LIMITS.label),
      detail: Array.isArray(n.detail) ? n.detail.slice(0, LIMITS.detail).map(d => clean(d, LIMITS.label + 8)) : undefined,
      color: typeof n.color === 'string' ? n.color : undefined,
      status: typeof n.status === 'string' ? clean(n.status, LIMITS.label) : undefined,
      tone: toneOf(n.tone),
      meters,
      spark: n.spark === true || undefined,
      side: n.side === 'left' || n.side === 'right' ? n.side : undefined,
      items: Array.isArray(n.items) ? n.items.slice(0, LIMITS.items).map(i => clean(i, LIMITS.label)) : undefined,
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
    const sideOf = (id: string) => nodes.find(n => n.id === id)?.side
    if (sideOf(edge.from) && sideOf(edge.to)) return { error: `edge ${edge.from} -> ${edge.to} joins two side panels; connect a panel to a box` }
    if (edgeIds.has(edgeIdOf(edge))) return { error: `edge id "${edgeIdOf(edge)}" is repeated; give one an id` }
    edgeIds.add(edgeIdOf(edge))
    edges.push(edge)
  }
  const knownEdge = (id: string) => edgeIds.has(id) || `packet or step names unknown edge "${id}"; edge ids are ${[...edgeIds].join(', ')}`

  const packets: DiagramPacket[] = []
  for (const p of (Array.isArray(raw.packets) ? raw.packets : []) as Record<string, unknown>[]) {
    const edge = String(p?.edge ?? '')
    const known = knownEdge(edge)
    if (known !== true) return { error: known }
    const speed = typeof p.speed === 'number' && p.speed > 0 ? Math.min(p.speed, 1) : 1
    packets.push({ edge, color: typeof p.color === 'string' ? p.color : undefined, speed })
  }

  let steps: DiagramStep[] | undefined
  if (Array.isArray(raw.steps) && raw.steps.length > 0) {
    steps = []
    for (const s of (raw.steps as Record<string, unknown>[]).slice(0, LIMITS.steps)) {
      const active = (Array.isArray(s?.active) ? s.active : []).map(String)
      for (const id of active) {
        const known = knownEdge(id)
        if (known !== true) return { error: known }
      }
      const updates: Record<string, DiagramNodeUpdate> = {}
      for (const [id, u] of Object.entries(isRecord(s?.nodes) ? s.nodes : {})) {
        if (!ids.has(id)) return { error: `a step updates unknown node "${id}"` }
        if (!isRecord(u)) continue
        updates[id] = {
          status: typeof u.status === 'string' ? clean(u.status, LIMITS.label) : undefined,
          tone: toneOf(u.tone),
          meters: Array.isArray(u.meters) ? u.meters.map(unit) : undefined,
          highlight: typeof u.highlight === 'number' ? Math.floor(u.highlight) : undefined,
        }
      }
      const duration = typeof s?.duration === 'number' ? Math.min(STEP_MS.max, Math.max(STEP_MS.min, s.duration)) : STEP_MS.default
      steps.push({ duration, active, nodes: updates, log: logOf(s?.log), counters: countersOf(s?.counters) })
    }
  }

  const legend = Array.isArray(raw.legend)
    ? (raw.legend as Record<string, unknown>[])
        .filter(l => typeof l?.label === 'string' && typeof l?.color === 'string')
        .slice(0, 6)
        .map(l => ({ label: clean(l.label, 24), color: String(l.color) }))
    : undefined

  return {
    spec: {
      title: clean(raw.title),
      subtitle: typeof raw.subtitle === 'string' ? clean(raw.subtitle) : undefined,
      caption: typeof raw.caption === 'string' ? clean(raw.caption) : undefined,
      legend: legend?.length ? legend : undefined,
      nodes,
      edges,
      packets,
      log: raw.log === undefined ? undefined : logOf(raw.log),
      steps,
      counters: raw.counters === undefined ? undefined : countersOf(raw.counters),
    },
  }
}
