#!/usr/bin/env node
// Builds ~/.calendar/week-YYYY-MM-DD.html from local Claude Code and Codex session logs.
// Usage: node build.mjs [--offset N] [--json]
//   --offset 0 = this week (default), -1 = last week
//   --json     print a summary for the mod on stdout
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const HOME = os.homedir()
const OUT_DIR = path.join(HOME, '.calendar')
const CONFIG_PATH = path.join(OUT_DIR, 'config.json')
const DEFAULTS = {
  theme: 'dark',              // dark | light
  accent: '#b9a6ff',          // used for today's marker and the selected block
  weekStart: 'mon',           // mon | sun
  dayStartHour: 6,            // work before this hour counts toward the previous day
  gapMinutes: 30,             // a gap longer than this starts a new block
  minNoCommitMinutes: 15,     // shorter blocks without commits are not flagged
  palette: ['#c4b5fd', '#93c5fd', '#fcd38d', '#86e3b0', '#7fded6', '#f9a8d4', '#fdba74', '#a5b4fc'],
  sources: {
    claude: path.join(HOME, '.claude', 'projects'),
    codex: path.join(HOME, '.codex', 'sessions'),
  },
}

// ---------- args, config ----------
const argv = process.argv.slice(2)
const offset = Number(argv[argv.indexOf('--offset') + 1]) || 0
const wantJson = argv.includes('--json')

fs.mkdirSync(OUT_DIR, { recursive: true })
if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2))
const cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }
cfg.sources = { ...DEFAULTS.sources, ...cfg.sources }

// ---------- week bounds (local time) ----------
const DSH = cfg.dayStartHour
const logicalNow = new Date(Date.now() - DSH * 3600e3)
const back = cfg.weekStart === 'sun' ? logicalNow.getDay() : (logicalNow.getDay() + 6) % 7
const d0 = new Date(logicalNow.getFullYear(), logicalNow.getMonth(), logicalNow.getDate() - back + offset * 7)
const dayStarts = Array.from({ length: 8 }, (_, i) => new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + i, DSH).getTime())
const WS = dayStarts[0], WE = dayStarts[7]
const todayIdx = offset === 0 ? dayStarts.findLastIndex((t) => t <= Date.now()) : -1

const dayOf = (t) => dayStarts.findLastIndex((s) => s <= t)

// ---------- file discovery ----------
function walk(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'subagents') walk(p, out) }
    else if (e.name.endsWith('.jsonl')) {
      try { if (fs.statSync(p).mtimeMs >= WS) out.push(p) } catch {}
    }
  }
  return out
}

function lines(file) {
  const out = []
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue
    try { out.push(JSON.parse(l)) } catch {}
  }
  return out
}

// ---------- parsers: each returns { tool, title, events: [{ t, cwd, model, text }] } ----------
function typedText(content) {
  let s = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : ''
  s = (s || '').trim()
  if (!s || s.startsWith('<') || s.startsWith('[Request interrupted') || s.startsWith('Caveat:')) return null
  return s
}

function parseClaude(file) {
  let title = null, cwd = null
  const events = []
  for (const o of lines(file)) {
    if (o.type === 'summary' && o.summary) title = o.summary
    if (/title/i.test(o.type || '')) title = o.customTitle || o.aiTitle || o.title || title
    if (o.isSidechain || !o.timestamp) continue
    if (o.type !== 'user' && o.type !== 'assistant') continue
    cwd = o.cwd || cwd
    const m = o.message?.model
    events.push({
      t: Date.parse(o.timestamp),
      cwd,
      model: m && m !== '<synthetic>' ? m : null,
      text: o.type === 'user' && !o.isMeta ? typedText(o.message?.content) : null,
    })
  }
  return { tool: 'Claude Code', title, events }
}

function parseCodex(file) {
  let cwd = null, model = null
  const events = []
  for (const o of lines(file)) {
    const p = o.payload || {}
    if (o.type === 'session_meta' || o.type === 'turn_context') { cwd = p.cwd || cwd; model = p.model || model }
    if (!o.timestamp) continue
    const text = o.type === 'event_msg' && p.type === 'user_message' ? typedText(p.message) : null
    events.push({ t: Date.parse(o.timestamp), cwd, model, text })
  }
  return { tool: 'Codex', title: null, events }
}

// ---------- sessions -> blocks ----------
function shortTitle(msg) {
  const line = (msg.split('\n')[0] || '').trim()
  if (!line) return '(no message)'
  const cut = line.length <= 48 ? line : line.slice(0, 48).replace(/\s+\S*$/, '') + '…'
  return cut[0].toUpperCase() + cut.slice(1)
}
const files = [
  ...walk(cfg.sources.claude).map((f) => parseClaude(f)),
  ...walk(cfg.sources.codex).map((f) => parseCodex(f)),
]

const blocks = []
let sessionSeq = 0
for (const s of files) {
  const ev = s.events.filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t)
  if (!ev.length) continue
  const firstTyped = ev.find((e) => e.text)?.text || ''
  const title = s.title || shortTitle(firstTyped)
  const sid = sessionSeq++
  const mine = []
  let cur = null
  for (const e of ev) {
    if (!cur || e.t - cur.end > cfg.gapMinutes * 60e3) {
      cur = { sid, tool: s.tool, title, start: e.t, end: e.t, cwd: null, model: null, firstMsg: null }
      blocks.push(cur); mine.push(cur)
    }
    cur.end = e.t
    cur.cwd ||= e.cwd
    cur.model = e.model || cur.model
    cur.firstMsg ||= e.text
  }
  for (const b of mine) b.firstMsg ||= firstTyped
}

const week = blocks
  .filter((b) => b.end >= WS && b.start < WE && b.cwd)
  .map((b) => ({ ...b, start: Math.max(b.start, WS), end: Math.min(b.end, WE - 1) }))

// ---------- git ----------
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).trim()
const repoCache = new Map()
function repo(cwd) {
  if (repoCache.has(cwd)) return repoCache.get(cwd)
  let r = null
  try {
    const root = git(cwd, ['rev-parse', '--show-toplevel'])
    if (repoCache.has('root:' + root)) r = repoCache.get('root:' + root)
    else {
      let email = ''
      try { email = git(root, ['config', 'user.email']) } catch {}
      const raw = git(root, ['log', '--all', '--no-merges', '--since=' + new Date(WS).toISOString().slice(0, 19) + 'Z',
        ...(email ? ['--author=' + email] : []), '--format=%x1e%at%x09%h%x09%s', '--name-only'])
      const commits = raw.split('\x1e').filter(Boolean).map((rec) => {
        const [head, ...rest] = rec.split('\n')
        const [at, h, ...subj] = head.split('\t')
        return { t: Number(at) * 1000, h, s: subj.join('\t'), files: rest.filter(Boolean) }
      })
      r = { root, name: path.basename(root), commits }
      repoCache.set('root:' + root, r)
    }
  } catch {}
  repoCache.set(cwd, r)
  return r
}

for (const b of week) {
  const r = repo(b.cwd)
  b.isGit = !!r
  b.project = r ? r.name : path.basename(b.cwd)
  const cs = r ? r.commits.filter((c) => c.t >= b.start && c.t <= b.end).sort((x, y) => x.t - y.t) : []
  b.commits = cs.map(({ h, s }) => ({ h, s }))
  b.files = new Set(cs.flatMap((c) => c.files)).size
  b.noCommit = b.isGit && !cs.length && b.end - b.start >= cfg.minNoCommitMinutes * 60e3
}

// ---------- totals (parallel sessions counted once) ----------
function unionMin(iv) {
  const s = [...iv].sort((a, b) => a[0] - b[0])
  let tot = 0, cs = -1, ce = -1
  for (const [a, b] of s) {
    if (a > ce) { tot += ce - cs; cs = a; ce = b } else ce = Math.max(ce, b)
  }
  tot += ce - cs
  return Math.round(tot / 60e3)
}
const byProject = new Map()
for (const b of week) (byProject.get(b.project) || byProject.set(b.project, []).get(b.project)).push([b.start, b.end])
const projects = [...byProject].map(([name, iv]) => ({ name, min: unionMin(iv) })).sort((a, b) => b.min - a.min)
projects.forEach((p, i) => (p.color = cfg.palette[i % cfg.palette.length]))
const colorOf = Object.fromEntries(projects.map((p) => [p.name, p.color]))
const totalMin = unionMin(week.map((b) => [b.start, b.end]))
const sessionMin = Math.round(week.reduce((a, b) => a + (b.end - b.start), 0) / 60e3)
const perDay = Array.from({ length: 7 }, (_, d) => unionMin(week.filter((b) => dayOf(b.start) === d).map((b) => [b.start, b.end])))

// ---------- layout: minutes from day start, lanes for overlaps ----------
const MIN_H = 40
const laid = week.map((b, id) => {
  const day = dayOf(b.start)
  const s = (b.start - dayStarts[day]) / 60e3
  const e = Math.min((b.end - dayStarts[day]) / 60e3, 24 * 60)
  return { id, day, s, e: Math.max(e, s + MIN_H), b }
})
for (let d = 0; d < 7; d++) {
  const items = laid.filter((x) => x.day === d).sort((a, b) => a.s - b.s)
  let cluster = [], clusterEnd = -1
  const flush = () => { const n = Math.max(...cluster.map((x) => x.lane)) + 1; cluster.forEach((x) => (x.lanes = n)) }
  for (const x of items) {
    if (x.s >= clusterEnd && cluster.length) { flush(); cluster = [] }
    const used = new Set(cluster.filter((y) => y.e > x.s).map((y) => y.lane))
    x.lane = 0; while (used.has(x.lane)) x.lane++
    cluster.push(x); clusterEnd = Math.max(clusterEnd, x.e)
  }
  if (cluster.length) flush()
}

// ---------- formatting ----------
const fmtDur = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
const fmtTime = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }).replace(/^0/, '')
const fmtDay = (t, o) => new Date(t).toLocaleDateString(o.month ? 'en-US' : 'en-GB', o)
const prettyModel = (m) => {
  if (!m) return ''
  const x = m.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/)
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? '.' + x[3] : ''}` : m
}
const rangeLabel = `${fmtDay(WS, { month: 'short', day: 'numeric' })} – ${fmtDay(WE - 864e5, { month: 'short', day: 'numeric' })}`
const tools = [...new Set(week.map((b) => b.tool))].join(' + ') || 'No sessions'

const blocksOut = laid.map(({ id, day, s, e, lane, lanes, b }) => ({
  id, day, s, e, lane, lanes,
  project: b.project, color: colorOf[b.project], title: b.title, tool: b.tool, model: prettyModel(b.model),
  when: `${fmtDay(b.start, { weekday: 'short', month: 'short', day: 'numeric' })}, ${fmtTime(b.start)} – ${fmtTime(b.end)}`,
  range: `${fmtTime(b.start)}–${fmtTime(b.end)}`, dur: fmtDur(Math.round((b.end - b.start) / 60e3)),
  firstMsg: b.firstMsg || '', commits: b.commits, files: b.files, noCommit: b.noCommit, isGit: b.isGit,
}))
const noCommit = blocksOut.filter((b) => b.noCommit)
  .map((b) => ({ id: b.id, title: b.title, color: b.color, when: `${fmtDay(week[b.id].start, { weekday: 'short' })} ${b.range}`, min: Math.round((week[b.id].end - week[b.id].start) / 60e3) }))

const visible = laid.length ? laid : [{ s: 3 * 60, e: 12 * 60 }]
const axis = { from: Math.floor(Math.min(...visible.map((x) => x.s)) / 60) * 60, to: Math.ceil(Math.max(...visible.map((x) => x.e)) / 60) * 60 }

const DATA = {
  range: rangeLabel, tools, theme: cfg.theme, accent: cfg.accent, dayStartHour: DSH,
  sessions: new Set(week.map((b) => b.sid)).size, blocks: blocksOut,
  commits: blocksOut.reduce((a, b) => a + b.commits.length, 0),
  days: dayStarts.slice(0, 7).map((t, i) => ({ label: fmtDay(t, { weekday: 'short', day: 'numeric' }), short: fmtDay(t, { weekday: 'narrow' }), today: i === todayIdx })),
  axis, projects: projects.map((p) => ({ ...p, label: fmtDur(p.min) })),
  total: fmtDur(totalMin), sessionTotal: fmtDur(sessionMin), perDay,
  noCommit, top: projects[0] ? `${projects[0].name}, ${fmtDur(projects[0].min)}` : '',
}

// ---------- write ----------
const tpl = fs.readFileSync(new URL('./calendar.html', import.meta.url), 'utf8')
const html = tpl.replace('/*DATA*/null', JSON.stringify(DATA).replace(/</g, '\\u003c'))
const outPath = path.join(OUT_DIR, `week-${new Date(WS).toLocaleDateString('sv')}.html`)
fs.writeFileSync(outPath, html)

if (wantJson) {
  const subjects = {}
  for (const b of blocksOut) for (const c of b.commits) (subjects[b.project] ||= new Set()).add(c.s)
  process.stdout.write(JSON.stringify({
    htmlPath: outPath, range: rangeLabel, total: DATA.total, top: DATA.top,
    noCommit: noCommit.sort((a, b) => b.min - a.min).map((x) => x.title),
    commitSubjects: Object.fromEntries(Object.entries(subjects).map(([k, v]) => [k, [...v].slice(0, 60)])),
  }))
} else {
  console.log(outPath)
}
