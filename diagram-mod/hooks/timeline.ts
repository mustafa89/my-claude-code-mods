import type { DiagramLogEntry, DiagramSpec, DiagramStep, Tone } from './spec'

/** What a node shows at one moment; `isFresh` while a step's change to it is new. */
export type NodeState = { status?: string; tone?: Tone; meters: number[]; highlight?: number; isFresh: boolean }

/** A log row that has appeared, and how many characters of its text are typed so far. */
export type LogRow = { at: number; entry: DiagramLogEntry; typed: number }

export type Frame = {
  /** Time into the current loop, and when the current step began. */
  ms: number
  stepStart: number
  step: number
  active: Set<string>
  nodes: Map<string, NodeState>
  log: LogRow[]
  counters: [string, number][]
  isStill: boolean
}

const LOG_GAP_MS = 450
const LOG_PAUSE_MS = 250
const TYPE_PER_MS = 0.06 // 60 characters a second
const EASE_MS = 700
const FRESH_MS = 900
const END_HOLD_MS = 1500

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** When each of a step's log rows starts: after the row before it has typed, squeezed into the step. */
function logOffsets(step: DiagramStep): number[] {
  const offsets: number[] = []
  let at = 0
  for (const entry of step.log) {
    offsets.push(at)
    at += entry.text.length / TYPE_PER_MS + LOG_PAUSE_MS
  }
  const room = step.duration * 0.85
  const last = offsets[offsets.length - 1] ?? 0
  return last > room ? offsets.map(o => (o * room) / last) : offsets
}

/** How long one loop of the story lasts, the hold on its last frame included. */
export function loopMs(spec: DiagramSpec): number {
  return (spec.steps ?? []).reduce((sum, s) => sum + s.duration, 0) + END_HOLD_MS
}

function typedRow(entry: DiagramLogEntry, at: number, now: number, isStill: boolean): LogRow {
  const typed = isStill ? entry.text.length : Math.min(entry.text.length, Math.floor((now - at) * TYPE_PER_MS))
  return { at, entry, typed }
}

/**
 * The story at `ms`. Without steps the picture is fixed and the log types out
 * once; with steps it loops. `isStill` gives the finished picture, nothing moving.
 */
export function frameAt(spec: DiagramSpec, ms: number, isStill = false): Frame {
  const base = new Map(
    spec.nodes.map(n => [n.id, { status: n.status, tone: n.tone, meters: (n.meters ?? []).map(m => m.value), isFresh: false } as NodeState]),
  )
  const startCounters = Object.entries(spec.counters ?? {})

  if (!spec.steps?.length) {
    // The log types out row after row, then stays.
    let at = 0
    const log: LogRow[] = []
    for (const entry of spec.log ?? []) {
      if (!isStill && at > ms) break
      log.push(typedRow(entry, at, ms, isStill))
      at += entry.text.length / TYPE_PER_MS + LOG_GAP_MS
    }
    const active = new Set(isStill ? [] : (spec.packets ?? []).map(p => p.edge))
    return { ms, stepStart: 0, step: -1, active, nodes: base, log, counters: startCounters, isStill }
  }

  const steps = spec.steps
  const total = loopMs(spec)
  const t = isStill ? total - 1 : ((ms % total) + total) % total

  // Which step is running, and when each began.
  const starts: number[] = []
  let sum = 0
  for (const s of steps) {
    starts.push(sum)
    sum += s.duration
  }
  let step = steps.length - 1
  for (let i = 0; i < steps.length; i++) if (t < starts[i]! + steps[i]!.duration) {
    step = i
    break
  }
  const stepStart = starts[step]!
  const into = t - stepStart

  // Node state: every earlier step's updates applied, then this step's eased in.
  const nodes = new Map([...base].map(([id, s]) => [id, { ...s, meters: [...s.meters] }]))
  const before = new Map<string, number[]>()
  for (let i = 0; i <= step; i++) {
    for (const [id, u] of Object.entries(steps[i]!.nodes)) {
      const n = nodes.get(id)
      if (!n) continue
      if (i === step) before.set(id, [...n.meters])
      if (u.status !== undefined) n.status = u.status
      if (u.tone !== undefined) n.tone = u.tone
      u.meters?.forEach((v, k) => {
        if (k < n.meters.length) n.meters[k] = v
      })
    }
  }
  const ease = isStill ? 1 : smooth(into / EASE_MS)
  for (const [id, update] of Object.entries(steps[step]!.nodes)) {
    const n = nodes.get(id)
    if (!n) continue
    const from = before.get(id) ?? n.meters
    n.meters = n.meters.map((v, k) => lerp(from[k] ?? v, v, ease))
    n.highlight = update.highlight
    n.isFresh = !isStill && into < FRESH_MS
  }

  // Log: the preamble at the start, then each step's rows a beat apart.
  const log: LogRow[] = []
  ;(spec.log ?? []).forEach((entry, j) => {
    const at = j * LOG_GAP_MS
    if (isStill || at <= t) log.push(typedRow(entry, at, t, isStill))
  })
  for (let i = 0; i <= step; i++) {
    logOffsets(steps[i]!).forEach((offset, j) => {
      const at = starts[i]! + offset
      if (isStill || at <= t) log.push(typedRow(steps[i]!.log[j]!, at, t, isStill))
    })
  }

  // Counters count up across each step towards the value the step names.
  const names = [...new Set([...startCounters.map(([k]) => k), ...steps.flatMap(s => Object.keys(s.counters))])]
  const valueAfter = (name: string, last: number) => {
    let v = spec.counters?.[name] ?? 0
    for (let i = 0; i <= last; i++) v = steps[i]!.counters[name] ?? v
    return v
  }
  const progress = isStill ? 1 : Math.min(1, into / steps[step]!.duration)
  const counters = names.map(name => [name, lerp(valueAfter(name, step - 1), valueAfter(name, step), progress)] as [string, number])

  const isHold = t >= sum
  const active = new Set(isStill || isHold ? [] : steps[step]!.active)
  return { ms: t, stepStart, step, active, nodes, log, counters, isStill }
}
