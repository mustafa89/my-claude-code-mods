import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { VaultEntry } from '../types'
import { maskContent, maskText, unmaskDeep, withheld, type Vault } from './mask'

// In:  every row bound for the model (prompts, tool results, reminders, subagent
//      rows) is masked at session.append before it is stored or sent.
// Out: every tool call gets the real values back at tool.call, so commands and
//      edits work on the real secret while the model only ever sees placeholders.
// The map lives in $.state: host memory for this session, never on disk.

const VAULT = { plugin: 'secret-mask', key: 'vault' } as const
const vaultAtom = atom(VAULT, {})
const reveal = atom({ plugin: 'secret-mask', key: 'reveal' } as const, false)
const PANE = 'secret-mask'

// What the pane shows of a value: its ends and length, or all of it when revealed.
const preview = (value: string, full: boolean) =>
  full ? value : value.length <= 10 ? `${'•'.repeat(value.length)} (${value.length} chars)` : `${value.slice(0, 4)}…${value.slice(-3)} (${value.length} chars)`

// The doors a person's mod sees. A Skill call's tool-message is held too, so loading a
// skill can still show one skip notice; other tools' messages can carry secrets.
const MASKED_DOORS = ['prompt', 'command', 'response', 'tool-result', 'tool-message', 'delivery', 'note', 'notice', 'queue'] as const

// The map held by this module; reloaded from $.state after a hot reload.
let vault: Vault | undefined

async function load($: EngineInterface): Promise<Vault> {
  if (vault) return vault
  const { value } = await $.state.get(VAULT)
  vault = new Map(Object.entries((value ?? {}) as Record<string, VaultEntry>))
  return vault
}

// Writes the map through to $.state (survives a hot reload) and shows how many values are held.
async function save($: EngineInterface, v: Vault): Promise<void> {
  await $.state.set(VAULT, Object.fromEntries(v))
  $.ui.status(`${v.size} masked · /secret-mask to see them`)
}

export const register: Register = on => {
  // /secret-mask opens a pane of what was masked. A pane is drawn on screen only:
  // nothing in it is added to the conversation, so the values never reach the model.
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'secret-mask', description: 'Show the secrets masked in this session' })
    return next(e)
  })

  on('command.run', { command: 'secret-mask' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Masked secrets' })
    return { text: 'Opened the masked-secrets pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const entries = Object.entries(await read($, vaultAtom)).reverse() // newest first
    const full = await read($, reveal)
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 4) / 2))
    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>{entries.length} masked this session, held in memory only </Text>
          <Button key="reveal" label={full ? 'Hide values' : 'Show values'} onPress={() => update($, reveal, r => !r)} />
        </Box>
        {entries.length === 0 && <Text dimColor>Nothing masked yet.</Text>}
        {entries.slice(0, room).map(([ph, held]) => (
          <Box flexDirection="column">
            <Text bold>{held.kind}</Text>
            <Text>  {preview(held.value, full)}  <Text dimColor>{ph}</Text></Text>
          </Box>
        ))}
        {entries.length > room && <Text dimColor>…and {entries.length - room} more</Text>}
      </Box>
    )
  })

  // Every row a personal mod may rewrite, before it is stored or sent. Claude Code's
  // built-in security plugin sends attachment, hook-context and compaction rows (CLAUDE.md,
  // memory, reminders) past personal mods; hooking them only adds a skip notice at startup.
  on('session.append', { door: MASKED_DOORS }, async ($, e, next) => {
    const v = await load($)
    const { content, count } = maskContent(e.message.content, v)
    if (count === 0) return next(e)
    await save($, v)
    return next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) =>
    // Fail closed: a row masking could not handle goes out without its text.
    next.called ? next(e) : next({ ...e, message: { ...e.message, content: withheld(e.message.content) } }),
  )

  // The typed prompt, so the prompt history holds the placeholder too.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e) // the engine applies no rewrite to these
    const v = await load($)
    const { text, count } = maskText(e.text, v)
    if (count === 0) return next(e)
    await save($, v)
    return next({ ...e, text })
  })

  // Real values back into every tool's input before it runs.
  on('tool.call', async ($, e, next) => {
    const v = await load($)
    const unknown = new Set<string>()
    const input = unmaskDeep(e, v, unknown)
    if (unknown.size > 0) {
      return {
        deny:
          `secret-mask: ${[...unknown].join(', ')} has no value in this session ` +
          '(the map is lost when Claude Code restarts). Ask the user for the value instead of using the placeholder.',
      }
    }
    return next(input)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'secret-mask: putting secrets back into this call failed, so it was not run.' },
  )
}
