import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Health } from '../types'

const TTL_MS: Record<string, number> = { '1h': 3_600_000, '5m': 300_000 }

const health = atom({ plugin: 'cache-warm', key: 'health' } as const, {
  ttlMs: TTL_MS['1h']!,
  marginMs: 120_000,
  maxPings: 4,
  lastAt: 0,
  isWarm: false,
  isEnabled: true,
  lastRatio: null,
  hits: 0,
  misses: 0,
  pings: 0,
  pingsTotal: 0,
  note: '',
} satisfies Health)

const TICK_MS = 15_000
// Below this share of the input served from cache, a request counts as a miss.
const HIT_RATIO = 0.5
// Requests this small carry no prefix worth caching.
const MIN_TOKENS = 4_000
// No pings while the 5h rate-limit window is this full.
const RATE_LIMIT_PCT = 80
const PING = 'Keepalive ping, not a task. Reply with the single character: .'

type $ = EngineInterface

function ratio(u: ModelUsage) {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return total >= MIN_TOKENS ? u.cache_read_input_tokens / total : null
}

// Module variables reset on a reload, which only happens between turns.
let isBusy = false
let isPinging = false

async function ping($: $) {
  isPinging = true
  try {
    // The TTL counts from the start of the request that reads the entry.
    const sentAt = await $.clock.now()
    const r = await $.model.fork({ prompt: PING })
    if (!r.isAnswered && r.reason === 'nothing-to-fork') {
      await update($, health, h => ({ ...h, isWarm: false, note: 'nothing to keep warm' }))
      return
    }
    if (!r.isAnswered) {
      // The cache was not touched: leave lastAt alone so the next tick retries inside the margin.
      await update($, health, h => ({ ...h, note: `ping failed: ${r.reason}` }))
      return
    }
    const share = ratio(r.usage)
    if (share !== null && share < HIT_RATIO) {
      // The entry had lapsed: this ping paid a full write. Stop until a real turn.
      await update($, health, h => ({ ...h, isWarm: false, misses: h.misses + 1, note: 'ping missed' }))
      return
    }
    await update($, health, h => ({
      ...h,
      lastAt: sentAt,
      pings: h.pings + 1,
      pingsTotal: h.pingsTotal + 1,
      note: 'pinged',
    }))
  } finally {
    isPinging = false
  }
}

async function tick($: $) {
  if (isBusy || isPinging) return
  const h = await read($, health)
  if (!h.isEnabled || !h.isWarm || h.lastAt === 0) return
  const idle = (await $.clock.now()) - h.lastAt
  // A late timer (sleep, suspend) never pings a cold cache: that would pay a full write.
  if (idle >= h.ttlMs) {
    await update($, health, x => ({ ...x, isWarm: false, note: 'expired' }))
    return
  }
  if (idle < h.ttlMs - h.marginMs) return
  if (h.pings >= h.maxPings) {
    if (h.note !== 'ping cap reached') await update($, health, x => ({ ...x, note: 'ping cap reached' }))
    return
  }
  const fiveHour = (await $.session.usage()).rateLimits.find(l => l.kind === 'five_hour')
  if (fiveHour !== undefined && fiveHour.percentUsed >= RATE_LIMIT_PCT) {
    if (h.note !== 'rate limit high') await update($, health, x => ({ ...x, note: 'rate limit high' }))
    return
  }
  await ping($)
}

export const register: Register = (on, options) => {
  const ttlMs = TTL_MS[String(options.ttl)] ?? TTL_MS['1h']!
  // 30s on a 5m cache, 2m on a 1h one: a fork of a large prefix needs the slack.
  const marginMs = Math.min(120_000, ttlMs / 10)
  const maxPings = typeof options.maxPings === 'number' ? options.maxPings : 4

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await update($, health, h => ({ ...h, ttlMs, marginMs, maxPings }))
    await $.command.register({
      name: 'cache-warm',
      description: 'Prompt cache keepalive: /cache-warm on | off | status',
    })
    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    return result
  })

  on('command.run', { command: 'cache-warm' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'on' || arg === 'off') await update($, health, h => ({ ...h, isEnabled: arg === 'on' }))
    const h = await read($, health)
    const idle = h.lastAt > 0 ? Math.round(((await $.clock.now()) - h.lastAt) / 1000) : null
    const parts = [
      `keepalive ${h.isEnabled ? 'on' : 'off'}`,
      `ttl ${h.ttlMs / 60_000}m`,
      h.isWarm ? 'warm' : 'cold',
      idle !== null ? `idle ${idle}s` : 'no request yet',
      `hits ${h.hits} · misses ${h.misses}`,
      `pings ${h.pings}/${h.maxPings} (session ${h.pingsTotal})`,
      h.note,
    ]
    return { text: parts.filter(Boolean).join(' · ') }
  })

  on('prompt.submit', async ($, e, next) => {
    isBusy = true
    await update($, health, h => ({ ...h, pings: 0 }))
    return next(e)
  })

  // Every main-thread request refreshes the entry; the first of a turn says whether it survived the gap.
  on('turn.step', async function* ($, e, next) {
    // Turns start without a typed prompt too (task notices, queued commands).
    if (e.agentId === undefined && !isPinging) isBusy = true
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    if (e.agentId !== undefined || isPinging || result.usage === null) return result
    const share = ratio(result.usage)
    await update($, health, h => {
      // The session's first request has nothing to hit.
      const counts = e.index === 0 && share !== null && h.lastAt > 0
      return {
        ...h,
        lastAt: sentAt,
        isWarm: true,
        lastRatio: share ?? h.lastRatio,
        hits: h.hits + (counts && share >= HIT_RATIO ? 1 : 0),
        misses: h.misses + (counts && share < HIT_RATIO ? 1 : 0),
        note: '',
      }
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) isBusy = false
    return result
  })

  // A compacted transcript is a new prefix: the next request writes it afresh.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await update($, health, h => ({ ...h, isWarm: false, note: 'compacted' }))
    return result
  })
}
