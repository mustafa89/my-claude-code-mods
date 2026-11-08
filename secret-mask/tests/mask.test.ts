import { expect, mock, test } from 'claude-code/testing'
import { maskContent, maskText, unmaskDeep, type Vault } from '../hooks/mask'

// Fake values built at run time, so this file never holds a matchable token.
const AWS = 'AKIA' + 'Q3EXAMPLE7KEY2ZZ'
const GITLAB = 'glpat-' + 'aB3dE5fG7hJ9kL1mN2pQ'
// A tool result row as the engine raises it after a Bash call.
const toolRow = (uuid: string, text: string) => ({
  door: 'tool-result' as const,
  origin: { kind: 'tool' as const, tool: 'Bash' },
  uuid,
  message: { type: 'user' as const, role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: text }] },
})
const PEM = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEpAIBAAKCAQEA1b2c3d4', '-----END RSA PRIVATE KEY-----'].join('\n')

test('known formats are masked, the same value gets the same placeholder', async () => {
  const v: Vault = new Map()
  const a = maskText(`key ${AWS} and ${GITLAB}\n${PEM}`, v)
  expect(a.count).toBe(3)
  expect(a.text).not.toContain(AWS)
  expect(a.text).not.toContain(GITLAB)
  expect(a.text).not.toContain('MIIEpAIBAAKCAQEA1b2c3d4')
  expect(maskText(`again ${AWS}`, v).text).toBe(`again ${a.text.match(/\{\{SECRET_AWS_KEY_ID_[0-9a-z]+\}\}/)![0]}`)
})

test('generic assignments mask only random-looking values', async () => {
  const v: Vault = new Map()
  expect(maskText('password = "changeme"', v).count).toBe(0)
  const r = maskText('password = "x9Lq2ZpR7tVw"', v)
  expect(r.count).toBe(1)
  expect(r.text).toMatch(/^password = "\{\{SECRET_SECRET_[0-9a-z]+\}\}"$/)
  expect(maskText('postgres://app:Zq8rT2vXw9@db:5432/x', v).text).toMatch(/app:\{\{SECRET_URL_PASSWORD_/)
})

test('plain code and existing placeholders are left alone', async () => {
  const v: Vault = new Map()
  const code = 'resource "aws_iam_role" "builder" {\n  name = "ci-builder"\n}\ntoken = var.gitlab_token'
  expect(maskText(code, v)).toEqual({ text: code, count: 0 })
  const once = maskText(`k=${AWS}`, v).text
  expect(maskText(once, v)).toEqual({ text: once, count: 0 })
})

test('unmasking restores values and reports unknown placeholders', async () => {
  const v: Vault = new Map()
  const masked = maskText(`echo ${AWS}`, v).text
  const unknown = new Set<string>()
  expect(unmaskDeep({ command: masked, n: 1 }, v, unknown)).toEqual({ command: `echo ${AWS}`, n: 1 })
  unmaskDeep({ command: '{{SECRET_AWS_KEY_ID_zzzzzzzzzzzz}}' }, v, unknown)
  expect([...unknown]).toEqual(['{{SECRET_AWS_KEY_ID_zzzzzzzzzzzz}}'])
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

test('a tool result row is stored masked', async ($, on) => {
  const session = mock.session(on)
  await $.session.append(toolRow('r1', `use ${AWS}`))
  const stored = JSON.stringify(session.appended())
  expect(stored).not.toContain(AWS)
  expect(stored).toContain('{{SECRET_AWS_KEY_ID_')
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
  const ph = JSON.stringify(session.appended()).match(/\{\{SECRET_AWS_KEY_ID_[0-9a-z]+\}\}/)![0]

  await $.tool.call({ tool: 'Bash', command: `aws configure set key ${ph}` })
  expect(ran).toBe(`aws configure set key ${AWS}`)

  const refused = await $.tool.call({ tool: 'Bash', command: 'echo {{SECRET_JWT_zzzzzzzzzzzz}}' })
  expect(refused.deny).toContain('has no value in this session')
})
