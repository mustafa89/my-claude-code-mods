import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/home/dev/.claude/projects'
const SHOP = `${ROOT}/-home-dev-code-shop`
const INFRA = `${ROOT}/-home-dev-code-infra`
const HOUR = 3_600_000

const TITLES = [
  `${SHOP}/aaaa1111.jsonl:"aiTitle":"Old checkout title"`,
  `${SHOP}/aaaa1111.jsonl:"aiTitle":"Fix checkout totals"`,
  `${SHOP}/bbbb2222.jsonl:"aiTitle":"Generated name"`,
  `${SHOP}/bbbb2222.jsonl:"customTitle":"cart-refactor"`,
  `${INFRA}/cccc3333.jsonl:"aiTitle":"Alert thresholds review"`,
].join('\n')
const CWDS = [
  `${SHOP}/aaaa1111.jsonl:"cwd":"/home/dev/code/shop"`,
  `${SHOP}/bbbb2222.jsonl:"cwd":"/home/dev/code/shop"`,
  `${INFRA}/cccc3333.jsonl:"cwd":"/home/dev/code/infra"`,
].join('\n')

function stub(on: On) {
  const ran: { command: string; args: string }[] = []
  const copied: string[] = []
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'aaaa1111' }))
  on('session.cwd', () => ({ value: '/home/dev/code/shop' }))
  on('env.get', () => ({ value: '/home/dev' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('fs.list', ($, e) => {
    const file = (name: string, hoursAgo: number) => ({ name, kind: 'file' as const, size: 10, mtimeMs: 100 * HOUR - hoursAgo * HOUR, isLink: false })
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    if (e.path === ROOT) return { value: [dir('-home-dev-code-shop'), dir('-home-dev-code-infra')] }
    if (e.path === SHOP) return { value: [file('aaaa1111.jsonl', 1), file('bbbb2222.jsonl', 30), dir('aaaa1111')] }
    return { value: [file('cccc3333.jsonl', 3)] }
  })
  on('process.run', ($, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('-m1') ? CWDS : TITLES, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('command.run', { command: 'resume' }, ($, e) => {
    ran.push({ command: e.command, args: e.args })
    return { text: '' }
  })
  return { ran, copied, clock }
}

async function openSidebar($: Engine, surface: 'terminal' | 'desktop') {
  await $.session.start({ cwd: '/home/dev/code/shop', surface, isInteractive: true })
  await $.command.run({ command: 'sessions', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  return $.ui.mount({
    plugin: 'session-browser',
    surface,
    component: 'Pane',
    requestId: 'sessions',
    props: { title: 'Sessions', isFocused: true, bodyColumns: 52, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    viewport: { columns: 160, rows: 40 },
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: folders start folded, newest folder first, and open on a press`, async ($, on) => {
    const { clock } = stub(on)
    await clock.set(100 * HOUR)
    const pane = await openSidebar($, surface)
    expect(await pane.find({ text: '3 · 2 folders' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'shop' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'infra' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '  ~/code' })).toBeDefined()
    expect(await pane.find({ text: '▾ ' })).toBeUndefined()
    expect(await pane.find({ text: /Fix checkout totals/ })).toBeUndefined()
    await pane.press({ key: 'folder:/home/dev/code/shop' })
    expect(await pane.find({ text: '▾ ' })).toBeDefined()
    // The current session is marked; /rename beats the AI title; the last AI title wins.
    expect(await pane.find({ type: 'Text', text: '● ' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Fix checkout totals' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'cart-refactor' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '  └─ ' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: / 30h$/ })).toBeDefined()
  })

  test(`${surface}: search filters across folders and opens the matches`, async ($, on) => {
    stub(on)
    const pane = await openSidebar($, surface)
    await pane.input({ key: 'query', text: 'alert', kind: 'change' })
    expect(await pane.find({ text: '1 · 1 folders' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Alert thresholds review' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'shop' })).toBeUndefined()
  })

  test(`${surface}: a session in this folder resumes; one elsewhere copies its command`, async ($, on) => {
    const { ran, copied } = stub(on)
    const pane = await openSidebar($, surface)
    await pane.press({ key: 'folder:/home/dev/code/shop' })
    await pane.press({ key: 'session:bbbb2222' })
    expect(ran).toEqual([{ command: 'resume', args: 'bbbb2222' }])
    await pane.press({ key: 'folder:/home/dev/code/infra' })
    await pane.press({ key: 'session:cccc3333' })
    expect(copied).toEqual([`cd '/home/dev/code/infra' && claude --resume cccc3333`])
  })
}
