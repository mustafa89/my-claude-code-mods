// Pure masking logic: no engine calls, so tests import it directly.
//
// Detection rules: gitleaks' default rule set (217 rules), generated into
// ./gitleaks-rules.ts from
//   https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml
// gitleaks, Copyright (c) 2019 Zachary Rice, MIT License (LICENSE-gitleaks).
// They are applied as gitleaks applies them: keyword prefilter, the secret is the
// rule's secretGroup or else its first non-empty capture group, entropy must be
// above the rule's threshold, and the global and rule allowlists are honoured.
//
// A secret becomes {{SECRET_<KIND>_<id>}}. The id comes from the value itself,
// so the same value always gets the same placeholder: earlier turns stay
// byte-identical and the prompt cache keeps working.

import { GITLEAKS_ALLOW, GITLEAKS_RULES, type GitleaksAllow, type GitleaksRe } from './gitleaks-rules'

export type Vault = Map<string, { kind: string; value: string }>

type Allow = { condition: 'OR' | 'AND'; target: 'secret' | 'match' | 'line'; regexes: RegExp[]; stopwords: string[] }
type Rule = { kind: string; re: RegExp; secretGroup?: number; entropy?: number; keywords: string[]; allowlists: Allow[] }

const compile = (r: GitleaksRe) => new RegExp(r.source, r.flags.includes('d') ? r.flags : r.flags + 'd')
const compileAllow = (a: GitleaksAllow): Allow => ({
  condition: a.condition,
  target: a.target,
  regexes: a.regexes.map(r => new RegExp(r.source, r.flags.replace('g', ''))),
  stopwords: a.stopwords,
})

// Rules gitleaks does not have, applied after its own.
const LOCAL: Rule[] = [
  // The password in scheme://user:password@host; only when it looks random.
  {
    kind: 'URL_PASSWORD',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:([^\s@/'"$<{]{6,})@/dgi,
    entropy: 2.5,
    keywords: ['://'],
    allowlists: [],
  },
]

export const RULES: Rule[] = [
  ...GITLEAKS_RULES.map(r => ({
    kind: r.kind,
    re: compile(r.re),
    secretGroup: r.secretGroup,
    entropy: r.entropy,
    keywords: r.keywords,
    allowlists: (r.allowlists ?? []).map(compileAllow),
  })),
  ...LOCAL,
]
const GLOBAL_ALLOW: Allow[] = GITLEAKS_ALLOW ? [compileAllow(GITLEAKS_ALLOW)] : []

export const PLACEHOLDER = /\{\{SECRET_[A-Z0-9_]+_[0-9a-z]{8,}\}\}/g

// Shannon entropy in bits per character, as gitleaks computes it.
function entropy(s: string): number {
  const counts = new Map<string, number>()
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

// gitleaks' checkFindingAllowed: OR = a regex or a stopword holds; AND = every
// check the allowlist defines holds. Stopwords are read against the secret.
function allowed(lists: Allow[], secret: string, match: string, line: string): boolean {
  const lower = secret.toLowerCase()
  return lists.some(a => {
    const target = a.target === 'match' ? match : a.target === 'line' ? line : secret
    const byRegex = a.regexes.some(re => re.test(target))
    const byWord = a.stopwords.some(w => lower.includes(w))
    if (a.condition === 'AND') {
      const checks = [...(a.regexes.length ? [byRegex] : []), ...(a.stopwords.length ? [byWord] : [])]
      return checks.length > 0 && checks.every(Boolean)
    }
    return byRegex || byWord
  })
}

// FNV-1a, two seeds: a stable id without crypto (the engine has no Node).
function fnv(s: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function idFor(value: string, salt = 0): string {
  const a = fnv(value, 0x811c9dc5 ^ salt).toString(36).padStart(7, '0')
  const b = fnv(value, 0x01000193 ^ salt).toString(36).padStart(7, '0')
  return (a + b).slice(0, 12)
}

function placeholderFor(kind: string, value: string, vault: Vault): string {
  for (let salt = 0; ; salt++) {
    const ph = `{{SECRET_${kind}_${idFor(value, salt)}}}`
    const held = vault.get(ph)
    if (!held) {
      vault.set(ph, { kind, value })
      return ph
    }
    if (held.value === value) return ph
  }
}

type Edit = { start: number; end: number; text: string }

// One rule over the text: the edits for every finding it keeps.
function findings(rule: Rule, text: string, vault: Vault): Edit[] {
  const taken = [...text.matchAll(PLACEHOLDER)].map(m => [m.index, m.index + m[0].length] as const)
  const edits: Edit[] = []
  rule.re.lastIndex = 0
  for (const m of text.matchAll(rule.re)) {
    // The secret: secretGroup, else the first non-empty capture group, else the match.
    let gi = 0
    if (rule.secretGroup && m[rule.secretGroup]) gi = rule.secretGroup
    else if (!rule.secretGroup) gi = m.findIndex((g, i) => i > 0 && !!g)
    if (gi < 0) gi = 0
    const secret = m[gi] ?? ''
    if (!secret) continue
    const span = m.indices?.[gi]
    const start = span ? span[0] : m.index + m[0].indexOf(secret)
    const end = start + secret.length
    if (taken.some(([a, b]) => start < b && end > a)) continue // inside a placeholder already
    if (rule.entropy !== undefined && entropy(secret) <= rule.entropy) continue
    const lineStart = text.lastIndexOf('\n', start) + 1
    const lineEnd = text.indexOf('\n', end)
    const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
    if (allowed(GLOBAL_ALLOW, secret, m[0], line) || allowed(rule.allowlists, secret, m[0], line)) continue
    edits.push({ start, end, text: placeholderFor(rule.kind, secret, vault) })
  }
  return edits
}

// Masks every secret in text. Returns the text and how many values it replaced.
export function maskText(text: string, vault: Vault): { text: string; count: number } {
  let out = text
  let count = 0
  const lower = text.toLowerCase()
  for (const rule of RULES) {
    if (rule.keywords.length && !rule.keywords.some(k => lower.includes(k))) continue
    const edits = findings(rule, out, vault)
    for (const e of edits.reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end)
    count += edits.length
  }
  return { text: out, count }
}

// Puts real values back in every string of a tool's input. Unknown
// placeholders (the map was lost on a restart) are collected, not guessed.
export function unmaskDeep<T>(value: T, vault: Vault, unknown: Set<string>): T {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, ph => {
      const held = vault.get(ph)
      if (!held) unknown.add(ph)
      return held ? held.value : ph
    }) as T
  }
  if (Array.isArray(value)) return value.map(v => unmaskDeep(v, vault, unknown)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = unmaskDeep(v, vault, unknown)
    return out as T
  }
  return value
}

type Block = { type: string; text?: string; content?: unknown; [k: string]: unknown }

// Masks the text blocks and tool results of one conversation row. Other
// blocks (thinking, tool_use, images) are left alone: the engine pins them.
export function maskContent<C>(content: C, vault: Vault): { content: C; count: number } {
  let count = 0
  const text = (t: string) => {
    const r = maskText(t, vault)
    count += r.count
    return r.text
  }
  const blocks = (list: Block[]): Block[] =>
    list.map(b => {
      if (b.type === 'text' && typeof b.text === 'string') return { ...b, text: text(b.text) }
      if (b.type === 'tool_result') {
        if (typeof b.content === 'string') return { ...b, content: text(b.content) }
        if (Array.isArray(b.content)) return { ...b, content: blocks(b.content as Block[]) }
      }
      return b
    })
  if (typeof content === 'string') return { content: text(content) as C, count }
  if (Array.isArray(content)) return { content: blocks(content as Block[]) as C, count }
  return { content, count }
}

// What a row becomes when masking itself failed: nothing of its text is sent.
export function withheld<C>(content: C): C {
  const note = '[secret-mask withheld this text: masking failed]'
  const blocks = (list: Block[]): Block[] =>
    list.map(b =>
      b.type === 'text' ? { ...b, text: note } : b.type === 'tool_result' ? { ...b, content: note } : b,
    )
  if (typeof content === 'string') return note as C
  if (Array.isArray(content)) return blocks(content as Block[]) as C
  return content
}
