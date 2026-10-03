import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Git, Usage } from '../types'

const git = atom({ plugin: 'slick-bar', key: 'git' } as const, null)
const usage = atom({ plugin: 'slick-bar', key: 'usage' } as const, null)
const model = atom({ plugin: 'slick-bar', key: 'model' } as const, '')
const effort = atom({ plugin: 'slick-bar', key: 'effort' } as const, '')

const C = {
  accent: '#D97757',
  ink: '#1A1B1F',
  surface: '#2A2E37',
  text: '#D7DCE4',
  muted: '#7F8796',
  track: '#3B414D',
  green: '#7EE787',
  amber: '#F2CC60',
  red: '#FF7B72',
  blue: '#79C0FF',
}

// Nerd Font glyphs: rounded pill caps, folder, branch.
const CAP_L = ''
const CAP_R = ''
const ICON_DIR = ''
const ICON_BRANCH = ''

const GIT_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit'])
const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 24 * 3_600_000 }
const MAX_BRANCH = 24
// The footer line starts with the engine's own mode label (`⏵⏵ auto mode on · `); keep room for it.
const MODE_COLS = 22
const CYCLE_HINT = '(shift+tab to cycle)'

type $ = EngineInterface

async function refreshGit($: $) {
  const cwd = await $.session.cwd()
  const run = (argv: string[]) => $.process.run(['git', ...argv], { cwd, timeoutMs: 5000 })
  const top = await run(['rev-parse', '--show-toplevel'])

  if (top.exitCode !== 0) {
    const home = await $.env.get('HOME')
    const dir = home !== undefined && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
    await update($, git, () => ({ dir, branch: null, isDirty: false, ahead: 0, behind: 0 }))
    return
  }

  const root = top.stdout.trim()
  const sub = cwd.slice(root.length).replace(/^\//, '')
  const repo = root.split('/').pop() ?? root
  const status = await run(['status', '--porcelain=v2', '--branch'])
  const next: Git = { dir: sub ? `${repo}/${sub}` : repo, branch: null, isDirty: false, ahead: 0, behind: 0 }

  for (const line of status.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      next.branch = line.slice(14)
    } else if (line.startsWith('# branch.oid ') && next.branch === '(detached)') {
      next.branch = line.slice(13, 20)
    } else if (line.startsWith('# branch.ab ')) {
      const [a = '+0', b = '-0'] = line.slice(12).split(' ')
      next.ahead = Number(a.slice(1))
      next.behind = Number(b.slice(1))
    } else if (line !== '' && !line.startsWith('#')) {
      next.isDirty = true
    }
  }

  await update($, git, () => next)
}

async function refreshUsage($: $) {
  const [u, m] = await Promise.all([$.session.usage(), $.session.model()])
  const next: Usage = {
    pct: u.context.percent ?? null,
    tokens: u.context.tokens ?? null,
    window: u.context.window,
    limits: u.rateLimits.map(l => ({
      kind: l.kind,
      pct: l.percentUsed,
      resetsAt: l.resetsAt !== undefined ? Date.parse(l.resetsAt) : null,
    })),
  }
  await update($, usage, () => next)
  await update($, model, () => m)
}

const refreshAll = ($: $) => Promise.all([refreshGit($), refreshUsage($)])

// claude-opus-5-5[1m] -> Opus 5.5 · 1M
function prettyModel(id: string) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  const name = m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
  return /\[1m\]/i.test(id) && m ? `${name} 1M` : name
}

function compact(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function level(pct: number) {
  return pct < 50 ? C.green : pct < 80 ? C.amber : C.red
}

function hex(c: string) {
  return parseInt(c.slice(1), 16)
}

function lerp(a: number, b: number, t: number) {
  const ch = (s: number) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

// Heat gradient by position along the track: green -> amber -> red.
function heat(t: number) {
  return t < 0.5 ? lerp(hex(C.green), hex(C.amber), t * 2) : lerp(hex(C.amber), hex(C.red), (t - 0.5) * 2)
}

// 3h12m, 42m, 2d4h
function countdown(ms: number) {
  const mins = Math.ceil(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h${mins % 60 ? `${mins % 60}m` : ''}`
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ''}`
}

// Slim gauge cells: '━' filled, '╸' half step, '━' in track colour for the rest;
// `marker` (0..1) draws a '┃' tick where an even pace through the window would be.
function gaugeCells(pct: number, columns: number, marker: number | null = null) {
  // Anything above 0% shows at least a half step.
  const exact = (Math.min(Math.max(pct, 0), 100) / 100) * columns * 2
  const halves = pct > 0 ? Math.max(1, Math.round(exact)) : 0
  const words = new Uint32Array(columns * 3)
  for (let i = 0; i < columns; i++) {
    const t = columns === 1 ? 0 : i / (columns - 1)
    const isFull = i * 2 + 2 <= halves
    const isHalf = !isFull && i * 2 + 1 === halves
    words[i * 3] = isHalf ? 0x2578 : 0x2501
    words[i * 3 + 1] = isFull || isHalf ? heat(t) : hex(C.track)
    words[i * 3 + 2] = 0x01000000
  }
  if (marker !== null) {
    const i = Math.min(columns - 1, Math.floor(marker * columns))
    words[i * 3] = 0x2503
    words[i * 3 + 1] = hex(C.text)
  }
  let bin = ''
  for (const b of new Uint8Array(words.buffer)) bin += String.fromCharCode(b)
  return btoa(bin)
}

function textGauge(pct: number, columns: number) {
  const filled = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * columns)
  return { on: '━'.repeat(filled), off: '━'.repeat(columns - filled) }
}

const width = (s: string) => [...s].length

function clip(s: string, max: number) {
  return width(s) <= max ? s : `${[...s].slice(0, max - 1).join('')}…`
}

type Seg = { key: string; rank: number; w: number; node: RenderElement }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refreshAll($)
    $.clock.every(5000, () => void refreshAll($).catch(() => undefined))
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    void refreshUsage($).catch(() => undefined)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.effort !== undefined) {
      await update($, effort, () => String(e.effort))
    }
    const result = yield* next(e)
    if (e.agentId === undefined) await refreshUsage($)
    return result
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (GIT_TOOLS.has(String(e.tool))) await refreshGit($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refreshAll($)
    return result
  })

  // The bar is the footer line under the prompt, after the engine's mode label.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const [g, u, m, eff] = await Promise.all([read($, git), read($, usage), read($, model), read($, effort)])
    if (u === null && m === '') return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined
    const cols = (e.viewport?.columns ?? 120) - MODE_COLS

    const pill = (key: string, bg: string, fg: string, body: string, bold = false): Seg => ({
      key,
      rank: 0,
      w: width(body) + 4,
      node: (
        <Box key={key}>
          <Text color={bg}>{CAP_L}</Text>
          <Text backgroundColor={bg} color={fg} bold={bold}>
            {` ${body} `}
          </Text>
          <Text color={bg}>{CAP_R}</Text>
        </Box>
      ),
    })

    const gauge = (
      key: string,
      label: string,
      pct: number,
      gcols: number,
      extra = '',
      marker: number | null = null,
      tone = level(pct),
    ): Seg => {
      const bar =
        Raster !== undefined ? (
          <Raster key={`${key}-r`} columns={gcols} rows={1} cells={gaugeCells(pct, gcols, marker)} />
        ) : (
          <Text>
            <Text color={level(pct)}>{textGauge(pct, gcols).on}</Text>
            <Text color={C.track}>{textGauge(pct, gcols).off}</Text>
          </Text>
        )
      const pctText = `${Math.round(pct)}%`
      return {
        key,
        rank: 0,
        w: width(label) + 1 + gcols + 1 + width(pctText) + (extra ? 1 + width(extra) : 0),
        node: (
          <Box key={key} gap={1}>
            <Text color={C.muted}>{label}</Text>
            {bar}
            <Text color={tone} bold>
              {pctText}
            </Text>
            {extra ? <Text color={C.muted}>{extra}</Text> : null}
          </Box>
        ),
      }
    }

    const left: Seg[] = []
    const right: Seg[] = []

    const dot = e.props.isWorking ? '◉' : '✻'
    left.push(pill('model', C.accent, C.ink, `${dot} ${prettyModel(m)}${eff ? ` · ${eff}` : ''}`, true))

    if (g !== null) {
      left.push({ ...pill('dir', C.surface, C.blue, `${ICON_DIR} ${g.dir}`), rank: 2 })
      if (g.branch !== null) {
        const sync = `${g.ahead ? ` ↑${g.ahead}` : ''}${g.behind ? ` ↓${g.behind}` : ''}`
        const body = `${ICON_BRANCH} ${clip(g.branch, MAX_BRANCH)}${g.isDirty ? ' ±' : ''}${sync}`
        left.push({ ...pill('branch', C.surface, g.isDirty ? C.amber : C.green, body), rank: 3 })
      }
    }

    if (u !== null) {
      if (u.pct !== null) {
        const tok = u.tokens !== null ? `${compact(u.tokens)}/${compact(u.window)}` : ''
        right.push(gauge('ctx', 'ctx', u.pct, 6))
        if (tok) right.push({ key: 'tok', rank: 5, w: width(tok), node: <Text key="tok" color={C.muted}>{tok}</Text> })
      }
      const now = await $.clock.now()
      for (const l of u.limits) {
        const label = LIMIT_LABEL[l.kind] ?? l.kind
        const span = WINDOW_MS[l.kind]
        const remain = l.resetsAt !== null ? l.resetsAt - now : null
        // Share of the window gone; usage ahead of it projects past the limit before reset.
        const elapsed = span !== undefined && remain !== null ? Math.min(Math.max(1 - remain / span, 0), 1) : null
        const projected = elapsed !== null && elapsed > 0.05 ? l.pct / elapsed : l.pct
        const tone = l.pct >= 80 ? C.red : projected >= 100 ? C.amber : C.green
        const reset = remain !== null && remain > 0 ? `↻ ${countdown(remain)}` : ''
        right.push({
          ...gauge(`rl-${l.kind}`, label, l.pct, 6, reset, elapsed, tone),
          rank: l.kind === 'five_hour' ? 1 : 6,
        })
      }
    }

    // The engine's hint (`esc to interrupt`, `← 1 agent`) goes last, first to drop.
    const hint = e.props.hint
      .split(' · ')
      .filter(part => part !== '' && !part.includes(CYCLE_HINT))
      .join(' · ')
    if (hint) right.push({ key: 'hint', rank: 7, w: width(hint), node: <Text key="hint" color={C.muted}>{hint}</Text> })

    // Drop the lowest-priority segments until the row fits on one line.
    const all = [...left, ...right]
    // Exact width: gap 1 between left pills, 2 between right gauges, at least 1 between the groups.
    const row = (xs: Seg[], gap: number) => {
      const kept = xs.filter(x => all.includes(x))
      return kept.reduce((s, x) => s + x.w, 0) + Math.max(kept.length - 1, 0) * gap
    }
    const total = () => row(left, 1) + 1 + row(right, 2)
    while (total() > cols) {
      const victim = all.filter(x => x.rank > 0).sort((a, b) => b.rank - a.rank)[0]
      if (victim === undefined) break
      all.splice(all.indexOf(victim), 1)
    }
    const keep = (xs: Seg[]) => xs.filter(x => all.includes(x)).map(x => x.node)

    return (
      <Box flexDirection="row" justifyContent="space-between" width={cols}>
        <Box gap={1}>{keep(left)}</Box>
        <Box gap={2}>{keep(right)}</Box>
      </Box>
    )
  })
}
