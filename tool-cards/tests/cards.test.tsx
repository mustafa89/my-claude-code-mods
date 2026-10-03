import { expect, test } from 'claude-code/testing'

const OUTPUT = ['a.tf:1: x', 'a.tf:2: x', 'a.tf:3: x', 'a.tf:4: x', 'a.tf:5: x', 'a.tf:6: x', 'a.tf:7: x'].join('\n')

function bashRow(isRunning: boolean) {
  return {
    tool_use_id: 'toolu_1',
    tool: 'Bash',
    input: { command: "rg -n 'TODO' src | head -160", description: 'Find TODO markers', timeout: 10000 },
    isRunning,
    isErrored: false,
    isInterrupted: false,
    output: isRunning ? undefined : { stdout: OUTPUT, stderr: '', interrupted: false },
  }
}

test('draws a finished Bash call as a card with a preview and footer', async $ => {
  const card = await $.ui.mount({
    plugin: 'tool-cards',
    surface: 'terminal',
    component: 'ToolUse',
    props: bashRow(false),
    viewport: { columns: 120, rows: 40 },
  })
  expect(await card.find({ text: '→ Bash' })).toBeDefined()
  expect(await card.find({ text: '✓' })).toBeDefined()
  expect(await card.find({ type: 'Text', text: 'rg' })).toBeDefined()
  expect(await card.find({ text: 'a.tf:5: x' })).toBeDefined()
  expect(await card.find({ text: 'a.tf:6: x' })).toBeUndefined()
  expect(await card.find({ text: '… 2 more lines' })).toBeDefined()
  expect(await card.find({ text: '■ timeout 10s' })).toBeDefined()
})

test('a running Bash call shows the command but no output yet', async $ => {
  const card = await $.ui.mount({
    plugin: 'tool-cards',
    surface: 'terminal',
    component: 'ToolUse',
    props: bashRow(true),
    viewport: { columns: 120, rows: 40 },
  })
  expect(await card.find({ text: '◌' })).toBeDefined()
  expect(await card.find({ text: 'a.tf:1: x' })).toBeUndefined()
})

test('hides the separate Bash result block', async ($, on) => {
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine result</Text>
  })
  const block = await $.ui.mount({
    plugin: 'tool-cards',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'toolu_1', tool: 'Bash', output: { stdout: OUTPUT, stderr: '', interrupted: false }, isErrored: false },
  })
  expect(await block.find({ text: 'engine result' })).toBeUndefined()
})

test('summarises a Read call by its path, relative to the session', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  const card = await $.ui.mount({
    plugin: 'tool-cards',
    surface: 'terminal',
    component: 'ToolUse',
    props: {
      tool_use_id: 'toolu_2',
      tool: 'Read',
      input: { file_path: '/repo/main.tf', offset: 10, limit: 20 },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
    viewport: { columns: 100, rows: 40 },
  })
  expect(await card.find({ text: 'main.tf:10-30' })).toBeDefined()
})

test('unfolds a folded run of calls', async ($, on) => {
  let seen: boolean | undefined
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    seen = e.props.isExpanded
    const { Text } = $.ui.resolve(e)
    return <Text>group</Text>
  })
  await $.ui.mount({
    plugin: 'tool-cards',
    surface: 'terminal',
    component: 'ToolGroup',
    props: { calls: [], isActive: false, isExpanded: false },
  })
  expect(seen).toBe(true)
})

test('the expand button shows the whole output and collapses it again', async $ => {
  const card = await $.ui.mount({
    plugin: 'tool-cards',
    surface: 'terminal',
    component: 'ToolUse',
    props: bashRow(false),
    viewport: { columns: 120, rows: 40 },
  })
  await card.press({ key: 'toggle-toolu_1' })
  expect(await card.find({ text: 'a.tf:7: x' })).toBeDefined()
  expect(await card.find({ text: '▴ collapse' })).toBeDefined()
  await card.press({ key: 'toggle-toolu_1' })
  expect(await card.find({ text: 'a.tf:7: x' })).toBeUndefined()
})

test('/cards full expands every card', async $ => {
  const result = await $.command.run({ command: 'cards', args: 'full', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(result.text).toContain('full output')
  const card = await $.ui.mount({
    plugin: 'tool-cards',
    surface: 'terminal',
    component: 'ToolUse',
    props: bashRow(false),
    viewport: { columns: 120, rows: 40 },
  })
  expect(await card.find({ text: 'a.tf:7: x' })).toBeDefined()
})
