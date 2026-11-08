import { expect, mock, test } from 'claude-code/testing'
import { GITLEAKS_RULES } from '../hooks/gitleaks-rules'
import { maskContent, maskText, RULES, unmaskDeep, type Vault } from '../hooks/mask'

// Fake values built at run time, so this file never holds a matchable token.
const AWS = 'AKIA' + 'Q3EXAMPLE7KEY2ZZ'
const GITLAB = 'glpat-' + 'aB3dE5fG7hJ9kL1mN2pQ'
const PEM_BODY = 'MIIEpAIBAAKCAQEA1b2c3d4e5f6g7h8i9j0kLmNoPqRsTuVwXyZ0123456789abcdefABCDEF'
const PEM = ['-----BEGIN RSA PRIVATE KEY-----', PEM_BODY, '-----END RSA PRIVATE KEY-----'].join('\n')
const O = '{'.repeat(2)
const C = '}'.repeat(2)
const ph = (kind: string, text: string) => text.match(new RegExp(`\\{\\{SECRET_${kind}_[0-9a-z]+\\}\\}`))?.[0]

// A tool result row as the engine raises it after a Bash call.
const toolRow = (uuid: string, text: string) => ({
  door: 'tool-result' as const,
  origin: { kind: 'tool' as const, tool: 'Bash' },
  uuid,
  message: { type: 'user' as const, role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: text }] },
})

test('every gitleaks rule compiles in the mod runtime', async () => {
  expect(GITLEAKS_RULES.length).toBeGreaterThan(200)
  expect(RULES.length).toBe(GITLEAKS_RULES.length + 1) // plus URL_PASSWORD
  for (const r of GITLEAKS_RULES) expect(() => new RegExp(r.re.source, r.re.flags + 'd')).not.toThrow()
})

test('known formats are masked, the same value gets the same placeholder', async () => {
  const v: Vault = new Map()
  const a = maskText(`key ${AWS} and ${GITLAB}\n${PEM}`, v)
  expect(a.count).toBe(3)
  expect(a.text).not.toContain(AWS)
  expect(a.text).not.toContain(GITLAB)
  expect(a.text).not.toContain(PEM_BODY)
  const aws = ph('AWS_ACCESS_TOKEN', a.text)
  expect(aws).toBeDefined()
  expect(maskText(`again ${AWS}`, v).text).toBe(`again ${aws}`)
})

test('generic assignments mask only random-looking values', async () => {
  const v: Vault = new Map()
  expect(maskText('password = "changeme"', v).count).toBe(0)
  const r = maskText('password = "x9Lq2ZpR7tVw"', v)
  expect(r.count).toBe(1)
  expect(r.text).not.toContain('x9Lq2ZpR7tVw')
  const url = maskText('postgres://app:Zq8rT2vXw9@db:5432/x', v)
  expect(url.text).not.toContain('Zq8rT2vXw9')
  expect(url.text).toContain('postgres://app:')
})

test('plain code and existing placeholders are left alone', async () => {
  const v: Vault = new Map()
  const code = 'resource "aws_iam_role" "builder" {\n  name = "ci-builder"\n}\ntoken = var.gitlab_token'
  expect(maskText(code, v)).toEqual({ text: code, count: 0 })
  const once = maskText(`k=${AWS}`, v).text
  expect(maskText(once, v)).toEqual({ text: once, count: 0 })
})

test('unmasking restores values, kinds with digits included, and reports unknown placeholders', async () => {
  const v: Vault = new Map()
  const masked = maskText(`echo ${AWS}`, v).text
  const digitKind = `${O}SECRET_1PASSWORD_SECRET_KEY_abcdefgh1234${C}`
  v.set(digitKind, { kind: '1PASSWORD_SECRET_KEY', value: 'A3-XYZ' })
  const unknown = new Set<string>()
  expect(unmaskDeep({ command: masked, other: digitKind, n: 1 }, v, unknown)).toEqual({
    command: `echo ${AWS}`,
    other: 'A3-XYZ',
    n: 1,
  })
  const missing = `${O}SECRET_AWS_ACCESS_TOKEN_zzzzzzzzzzzz${C}`
  unmaskDeep({ command: missing }, v, unknown)
  expect([...unknown]).toEqual([missing])
})

test('tool results inside a row are masked, other blocks untouched', async () => {
  const v: Vault = new Map()
  const row = [
    { type: 'tool_result', tool_use_id: 't1', content: `out ${GITLAB}` },
    { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: AWS }] },
    { type: 'thinking', thinking: AWS, signature: 'sig' },
  ]
  const { content, count } = maskContent(row, v)
  expect(count).toBe(2)
  expect(JSON.stringify(content.slice(0, 2))).not.toContain(GITLAB)
  expect(JSON.stringify(content.slice(0, 2))).not.toContain(AWS)
  expect(content[2]).toEqual(row[2])
})

test('a 200 KB tool output masks well within a hook budget', async () => {
  const line = 'const api_key_name = config.get("auth.token") // access credentials key secret password\n'
  const big = line.repeat(Math.ceil(200_000 / line.length)) + `final ${AWS}\n`
  const t0 = Date.now()
  const r = maskText(big, new Map())
  const ms = Date.now() - t0
  expect(r.text).not.toContain(AWS)
  expect(ms).toBeLessThan(1500)
})

test('a tool result row is stored masked', async ($, on) => {
  const session = mock.session(on)
  await $.session.append(toolRow('r1', `use ${AWS}`))
  const stored = JSON.stringify(session.appended())
  expect(stored).not.toContain(AWS)
  expect(stored).toContain('SECRET_AWS_ACCESS_TOKEN_')
})

test('a tool call gets the real value back, an unknown placeholder is refused', async ($, on) => {
  let ran = ''
  on('tool.call', (_, e) => {
    ran = (e as { command: string }).command
    return { result: {} }
  })
  // The model only ever saw the placeholder the mod made from a tool result.
  const session = mock.session(on)
  await $.session.append(toolRow('r2', AWS))
  const placeholder = ph('AWS_ACCESS_TOKEN', JSON.stringify(session.appended()))!

  await $.tool.call({ tool: 'Bash', command: `aws configure set key ${placeholder}` })
  expect(ran).toBe(`aws configure set key ${AWS}`)

  const refused = await $.tool.call({ tool: 'Bash', command: `echo ${O}SECRET_JWT_zzzzzzzzzzzz${C}` })
  expect(refused.deny).toContain('has no value in this session')
})

const PANE = {
  plugin: 'secret-mask',
  component: 'Pane',
  requestId: 'secret-mask',
  props: { title: 'Masked secrets', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the pane lists what was masked, ends only until Show values is pressed', async ($, on) => {
  mock.session(on)
  await $.session.append(toolRow('r3', `use ${AWS}`))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /AWS_ACCESS_TOKEN/ }))?.text).toBe('AWS_ACCESS_TOKEN')
    const all = JSON.stringify(await ui.findAll({ type: 'Text' }))
    expect(all).toContain('AKIA…2ZZ (20 chars)')
    expect(all).not.toContain(AWS)
    await ui.press({ key: 'reveal' })
    expect(JSON.stringify(await ui.findAll({ type: 'Text' }))).toContain(AWS)
    await ui.press({ key: 'reveal' }) // back to hidden for the next surface
    await ui.unmount()
  }
})
