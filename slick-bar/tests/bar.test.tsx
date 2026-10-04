import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const STATUS = [
  '# branch.oid 26d960ac7aaaaaaa',
  '# branch.head feature/checkout-flow-redesign',
  '# branch.ab +2 -0',
  '? .scratch_note.txt',
].join('\n')

const SURFACES = ['terminal', 'desktop'] as const

function stub(on: On) {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.cwd', () => ({ value: '/home/dev/code/demo-shop' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
    context: { tokens: 412_000, window: 1_000_000, percent: 41 },
    rateLimits: [
      // Clock starts at 0: 5h resets in 3h (40% of the window gone), 7d in 2d4h.
      { kind: 'five_hour', percentUsed: 23, resetsAt: new Date(3 * 3_600_000).toISOString() },
      { kind: 'seven_day', percentUsed: 61, resetsAt: new Date(52 * 3_600_000).toISOString() },
    ],
    cost: { usd: 3.27 },
    },
  }))
  on('process.run', ($, e) => {
    const out = e.argv.includes('rev-parse') ? '/home/dev/code/demo-shop\n' : STATUS
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return clock
}

async function mount($: Engine, surface: (typeof SURFACES)[number], columns: number) {
  await $.session.start({ cwd: '/home/dev/code/demo-shop', surface, isInteractive: true })
  return $.ui.mount({
    plugin: 'slick-bar',
    surface,
    component: 'PromptHint',
    props: { isDraft: false, isWorking: true, hint: '(shift+tab to cycle) · esc to interrupt' },
    viewport: { columns, rows: 40 },
  })
}

for (const surface of SURFACES) {
  test(`draws every segment on one row (${surface})`, async ($, on) => {
    stub(on)
    const bar = await mount($, surface, 240)
    for (const text of ['Opus 5.5 1M', 'demo-shop', 'feature/checkout-flow-r… ± ↑2', '41%', '412k/1M', '23%', '61%', 'esc to interrupt']) {
      expect(await bar.find({ text })).toBeDefined()
    }
  })

  test(`drops low-priority segments when narrow (${surface})`, async ($, on) => {
    stub(on)
    const bar = await mount($, surface, 130)
    expect(await bar.find({ text: 'Opus 5.5 1M' })).toBeDefined()
    expect(await bar.find({ text: '41%' })).toBeDefined()
    expect(await bar.find({ text: '61%' })).toBeUndefined()
    expect(await bar.find({ text: 'demo-shop' })).toBeDefined()
    expect(await bar.find({ text: '$' })).toBeUndefined()
  })
}


for (const surface of SURFACES) {
  test(`drops the cycle hint from the footer (${surface})`, async ($, on) => {
    stub(on)
    const bar = await mount($, surface, 240)
    expect(await bar.find({ text: 'shift+tab' })).toBeUndefined()
  })
}

for (const surface of SURFACES) {
  test(`shows reset countdowns and pace (${surface})`, async ($, on) => {
    stub(on)
    const bar = await mount($, surface, 260)
    expect(await bar.find({ text: '↻ 3h' })).toBeDefined()
    expect(await bar.find({ text: '↻ 2d4h' })).toBeDefined()
    // 23% with 40% of the 5h window gone is on pace; 61% with 69% of 7d gone is too.
    expect((await bar.find({ type: 'Text', text: '23%' }))?.props.color).toBe('#7EE787')
    expect((await bar.find({ type: 'Text', text: '61%' }))?.props.color).toBe('#7EE787')
  })
}

for (const surface of SURFACES) {
  test(`fits ctx, 5h, folder and branch at 139 columns (${surface})`, async ($, on) => {
    stub(on)
    const bar = await mount($, surface, 139)
    for (const text of ['41%', '23%', '↻ 3h', 'demo-shop', 'feature/checkout']) {
      expect(await bar.find({ text })).toBeDefined()
    }
  })
}

const CACHE = {
  ttlMs: 3_600_000,
  marginMs: 120_000,
  maxPings: 4,
  lastAt: 1,
  isWarm: true,
  isEnabled: true,
  lastRatio: 0.97,
  hits: 5,
  misses: 2,
  pings: 1,
  pingsTotal: 3,
  note: '',
}

for (const surface of SURFACES) {
  test(`shows prompt cache health from cache-warm (${surface})`, async ($, on) => {
    stub(on)
    on('state.get', { plugin: 'cache-warm' }, () => ({ value: { value: CACHE, version: 1 } }))
    const bar = await mount($, surface, 260)
    for (const text of ['cache', '97%', '1h', '✗2', '⟳1']) {
      expect(await bar.find({ text })).toBeDefined()
    }
  })

  test(`marks an expired cache cold (${surface})`, async ($, on) => {
    stub(on)
    on('state.get', { plugin: 'cache-warm' }, () => ({ value: { value: { ...CACHE, isWarm: false }, version: 1 } }))
    const bar = await mount($, surface, 260)
    expect(await bar.find({ text: 'cold' })).toBeDefined()
  })
}
