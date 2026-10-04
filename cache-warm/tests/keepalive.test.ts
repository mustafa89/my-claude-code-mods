import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Health } from '../types'

const HOUR = 3_600_000
const START = 10 * HOUR

const WARM: Health = {
  ttlMs: HOUR,
  marginMs: 120_000,
  maxPings: 4,
  lastAt: START,
  isWarm: true,
  isEnabled: true,
  lastRatio: 0.98,
  hits: 3,
  misses: 0,
  pings: 0,
  pingsTotal: 0,
  note: '',
}

const usage = (read: number, write: number) => ({
  input_tokens: 10,
  output_tokens: 2,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})

// The plugin's state, held by the test beneath it, starting warm at START.
function world(on: On, opts: { isMiss?: boolean; isError?: boolean; fivePct?: number; health?: Partial<Health> } = {}) {
  const clock = mock.clock(on, { now: START })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const box = { health: { ...WARM, ...opts.health }, version: 1, forks: 0 }
  on('state.get', { plugin: 'cache-warm' }, () => ({ value: { value: box.health, version: box.version } }))
  on('state.set', { plugin: 'cache-warm' }, ($, e) => {
    box.health = e.value as Health
    box.version += 1
    return { value: { isSet: true, version: box.version } }
  })
  on('model.fork', () => {
    box.forks += 1
    if (opts.isError) {
      return { value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: usage(0, 0) } }
    }
    // A miss still sends the whole prefix: it lands as a cache write, not a read.
    return { value: { isAnswered: true as const, text: '.', usage: opts.isMiss ? usage(0, 200_000) : usage(200_000, 0) } }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 200_000, window: 1_000_000, percent: 20 },
      rateLimits: [{ kind: 'five_hour', percentUsed: opts.fivePct ?? 10 }],
    },
  }))
  return { clock, box }
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

test('pings once just before the TTL runs out, not earlier', async ($, on) => {
  const { clock, box } = world(on)
  await start($)
  await clock.advance(HOUR - 180_000)
  expect(box.forks).toBe(0)
  await clock.advance(75_000)
  expect(box.forks).toBe(1)
  expect(box.health.pings).toBe(1)
  expect(box.health.lastAt).toBeGreaterThan(START)
})

test('stops at the ping cap and lets the cache expire', { options: { maxPings: 2 } }, async ($, on) => {
  const { clock, box } = world(on)
  await start($)
  await clock.advance(4 * HOUR)
  expect(box.forks).toBe(2)
  expect(box.health.isWarm).toBe(false)
  expect(box.health.note).toBe('expired')
})

test('a ping that missed the cache stops pinging', async ($, on) => {
  const { clock, box } = world(on, { isMiss: true })
  await start($)
  await clock.advance(2 * HOUR)
  expect(box.forks).toBe(1)
  expect(box.health.isWarm).toBe(false)
  expect(box.health.misses).toBe(1)
})

test('never pings a cache whose TTL already passed', async ($, on) => {
  const { clock, box } = world(on, { health: { lastAt: START - 2 * HOUR } })
  await start($)
  await clock.advance(60_000)
  expect(box.forks).toBe(0)
  expect(box.health.isWarm).toBe(false)
})

test('holds off while the 5h rate limit is high', async ($, on) => {
  const { clock, box } = world(on, { fivePct: 85 })
  await start($)
  await clock.advance(HOUR - 60_000)
  expect(box.forks).toBe(0)
  expect(box.health.note).toBe('rate limit high')
})

test('/cache-warm off stops pinging', async ($, on) => {
  const { clock, box } = world(on)
  await start($)
  const r = await $.command.run({
    command: 'cache-warm',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(r.text).toContain('keepalive off')
  await clock.advance(HOUR)
  expect(box.forks).toBe(0)
})

test('a failed ping leaves the cache time alone and retries', async ($, on) => {
  const { clock, box } = world(on, { isError: true })
  await start($)
  await clock.advance(HOUR - 90_000)
  expect(box.forks).toBeGreaterThan(1)
  expect(box.health.lastAt).toBe(START)
  expect(box.health.pings).toBe(0)
  expect(box.health.note).toContain('ping failed')
})
