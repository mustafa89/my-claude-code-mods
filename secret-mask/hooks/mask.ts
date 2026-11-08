// Pure masking logic: no engine calls, so tests import it directly.
//
// A secret becomes {{SECRET_<KIND>_<id>}}. The id comes from the value itself,
// so the same value always gets the same placeholder: earlier turns stay
// byte-identical and the prompt cache keeps working.

export type Vault = Map<string, { kind: string; value: string }>

type Rule = {
  kind: string
  re: RegExp
  // Generic rules mask only the named group `s`, and only when it looks random.
  minEntropy?: number
}

// Specific formats first (after gitleaks' rules), generic assignments last.
const RULES: Rule[] = [
  { kind: 'PRIVATE_KEY', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { kind: 'AWS_KEY_ID', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { kind: 'AWS_SECRET', re: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?(?<s>[A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi },
  { kind: 'GITLAB_TOKEN', re: /\b(?:glpat|gldt|glrt|glsoat|glcbt|glimt|glagent|glffct)-[0-9A-Za-z_-]{20,}|\bglptt-[0-9a-f]{40}\b|\bGR1348941[0-9A-Za-z_-]{20,}/g },
  { kind: 'GITHUB_TOKEN', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b|\bgithub_pat_[0-9A-Za-z_]{80,}/g },
  { kind: 'SLACK_TOKEN', re: /\bxox[abposr]-[0-9A-Za-z-]{10,}/g },
  { kind: 'SLACK_WEBHOOK', re: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/_-]{20,}/g },
  { kind: 'ANTHROPIC_KEY', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'OPENAI_KEY', re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g },
  { kind: 'GOOGLE_API_KEY', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'STRIPE_KEY', re: /\b[rs]k_live_[0-9A-Za-z]{20,}\b/g },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'URL_PASSWORD', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:(?<s>[^\s@/'"$<{]{6,})@/gi, minEntropy: 2.5 },
  {
    kind: 'SECRET',
    re: /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["'](?<s>[^"'\s$<{]{8,})["']/gi,
    minEntropy: 3.0,
  },
]

export const PLACEHOLDER = /\{\{SECRET_[A-Z_]+_[0-9a-z]{8,}\}\}/g

// Shannon entropy in bits per character: rejects words like "changeme" in generic rules.
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

// FNV-1a, two seeds: a stable 64-bit id without crypto (the engine has no Node).
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

// Masks every secret in text. Returns the text and how many values it replaced.
export function maskText(text: string, vault: Vault): { text: string; count: number } {
  let count = 0
  let out = text
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    out = out.replace(rule.re, (match: string, ...rest: unknown[]) => {
      const groups = rest[rest.length - 1] as Record<string, string> | undefined
      const s = typeof groups === 'object' && groups ? groups.s : undefined
      const secret = s ?? match
      if (rule.minEntropy !== undefined && entropy(secret) < rule.minEntropy) return match
      count++
      const ph = placeholderFor(rule.kind, secret, vault)
      return s === undefined ? ph : match.replace(s, ph)
    })
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
