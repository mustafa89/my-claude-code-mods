import type { EngineInterface, Register } from 'claude-code'
import type { VaultEntry } from '../types'
import { maskContent, maskText, unmaskDeep, withheld, type Vault } from './mask'

// In:  every row bound for the model (prompts, tool results, reminders, subagent
//      rows) is masked at session.append before it is stored or sent.
// Out: every tool call gets the real values back at tool.call, so commands and
//      edits work on the real secret while the model only ever sees placeholders.
// The map lives in $.state: host memory for this session, never on disk.

const VAULT = { plugin: 'secret-mask', key: 'vault' } as const

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
  $.ui.status(`secret-mask: ${v.size} masked`)
}

export const register: Register = on => {
  // Every row of every conversation, before it is stored or sent.
  on('session.append', async ($, e, next) => {
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
