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

function editRow() {
  return {
    tool_use_id: 'toolu_3',
    tool: 'Edit',
    input: { file_path: '/repo/README.md', old_string: 'x', new_string: 'y' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    output: {
      filePath: '/repo/README.md',
      structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' # Title', '-old line', '+new line', '+extra line', ' tail'] }],
    },
  }
}

test('draws an Edit as a split diff with counts', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  const card = await $.ui.mount({ plugin: 'tool-cards', surface: 'terminal', component: 'ToolUse', props: editRow(), viewport: { columns: 140, rows: 40 } })
  expect(await card.find({ text: '+2' })).toBeDefined()
  expect(await card.find({ text: '-1' })).toBeDefined()
  expect(await card.find({ text: 'split' })).toBeDefined()
  expect(await card.find({ text: 'old line' })).toBeDefined()
  expect(await card.find({ text: 'extra line' })).toBeDefined()
})

test('stacks the diff on a narrow terminal', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  const card = await $.ui.mount({ plugin: 'tool-cards', surface: 'terminal', component: 'ToolUse', props: editRow(), viewport: { columns: 70, rows: 40 } })
  expect(await card.find({ text: 'stacked' })).toBeDefined()
  expect(await card.find({ text: 'new line' })).toBeDefined()
})

test('hides the engine diff for an Edit and the result block for MCP calls', async ($, on) => {
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine result</Text>
  })
  for (const [tool, output] of [['Edit', editRow().output], ['mcp__gw__chat', [{ type: 'text', text: 'hi' }]]] as const) {
    const block = await $.ui.mount({ plugin: 'tool-cards', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: 'toolu_x', tool, output, isErrored: false } })
    expect(await block.find({ text: 'engine result' })).toBeUndefined()
  }
})

test('an MCP card folds its output behind a button', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  const card = await $.ui.mount({
    plugin: 'tool-cards',
    surface: 'terminal',
    component: 'ToolUse',
    props: {
      tool_use_id: 'toolu_4',
      tool: 'mcp__gw__chat',
      input: { execution_id: 'abc' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: [{ type: 'text', text: '{"status":"done","answer":"42"}' }],
    },
    viewport: { columns: 120, rows: 40 },
  })
  expect(await card.find({ text: 'execution_id=abc' })).toBeDefined()
  expect(await card.find({ text: '▾ output · 4 lines' })).toBeDefined()
  expect(await card.find({ text: '  "answer": "42"' })).toBeUndefined()
  await card.press({ key: 'toggle-toolu_4' })
  expect(await card.find({ text: '  "answer": "42"' })).toBeDefined()
})

test('highlights the changed words of a replaced line', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  const row = editRow()
  row.output.structuredPatch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-## Build Process here', '+## Build process here'] }]
  const card = await $.ui.mount({ plugin: 'tool-cards', surface: 'terminal', component: 'ToolUse', props: row, viewport: { columns: 140, rows: 40 } })
  expect(await card.find({ type: 'Text', text: 'Process' })).toBeDefined()
  expect(await card.find({ type: 'Text', text: 'process' })).toBeDefined()
  expect(await card.find({ type: 'Text', text: '## Build ' })).toBeDefined()
})

test('wraps a long command and a long argument line instead of cutting them', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  const tail = 'services/ai-gateway/very/long/path/that/ends/here'
  const long = `grep -rn ${'x'.repeat(80)} ${tail}`
  const bash = await $.ui.mount({
    plugin: 'tool-cards',
    surface: 'terminal',
    component: 'ToolUse',
    props: { ...bashRow(true), input: { command: long } },
    viewport: { columns: 60, rows: 40 },
  })
  expect(await bash.find({ type: 'Text', text: tail })).toBeDefined()
  const mcp = await $.ui.mount({
    plugin: 'tool-cards',
    surface: 'terminal',
    component: 'ToolUse',
    props: { tool_use_id: 'toolu_5', tool: 'mcp__gw__query', input: { query: long }, isRunning: true, isErrored: false, isInterrupted: false },
    viewport: { columns: 60, rows: 40 },
  })
  expect(await mcp.find({ text: `query=${long}` })).toBeDefined()
})

test('an MCP card header names the bare tool and its server like a Bash description', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  const header = async (tool: string) =>
    $.ui.mount({
      plugin: 'tool-cards',
      surface: 'terminal',
      component: 'ToolUse',
      props: { tool_use_id: 'toolu_6', tool, input: {}, isRunning: true, isErrored: false, isInterrupted: false },
      viewport: { columns: 120, rows: 40 },
    })
  const gw = await header('mcp__employee-central-engineering__coralogix-mcp___query_dataprime')
  expect(await gw.find({ text: '→ query_dataprime' })).toBeDefined()
  expect(await gw.find({ text: 'coralogix-mcp · employee-central-engineering' })).toBeDefined()
  const plain = await header('mcp__infra-copilot-prod__aws_read')
  expect(await plain.find({ text: '→ aws_read' })).toBeDefined()
  expect(await plain.find({ text: 'infra-copilot-prod' })).toBeDefined()
})

test('a built-in tool puts its summary in the header note; Bash and MCP keep theirs', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  const mount = (props: Record<string, unknown>) =>
    $.ui.mount({ plugin: 'tool-cards', surface: 'terminal', component: 'ToolUse', props, viewport: { columns: 140, rows: 40 } })
  const edit = await mount(editRow())
  expect(await edit.find({ text: 'README.md' })).toBeDefined()
  expect(await edit.find({ text: '│' })).toBeDefined()
  expect(await edit.find({ text: 'split' })).toBeDefined()
  const grep = await mount({ tool_use_id: 'toolu_7', tool: 'Grep', input: { pattern: 'TODO', path: '/repo/src' }, isRunning: false, isErrored: false, isInterrupted: false })
  expect(await grep.find({ text: 'TODO  in src' })).toBeDefined()
  const bash = await mount(bashRow(false))
  expect(await bash.find({ text: 'Find TODO markers' })).toBeDefined()
  const mcp = await mount({ tool_use_id: 'toolu_8', tool: 'mcp__gw__chat', input: { execution_id: 'abc' }, isRunning: true, isErrored: false, isInterrupted: false })
  expect(await mcp.find({ text: 'gw' })).toBeDefined()
  expect(await mcp.find({ text: 'execution_id=abc' })).toBeDefined()
})
