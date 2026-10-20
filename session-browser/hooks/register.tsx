import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Session } from '../types'

const PANE = 'sessions'
const sessions = atom({ plugin: 'session-browser', key: 'sessions' } as const, [])
const open = atom({ plugin: 'session-browser', key: 'open' } as const, {})
const query = atom({ plugin: 'session-browser', key: 'query' } as const, '')
const isLoading = atom({ plugin: 'session-browser', key: 'isLoading' } as const, false)

// The tool-cards palette, so the sidebar reads as the same family.
const C = {
  accent: '#E8A15A',
  folder: '#E8A15A',
  title: '#D7DCE4',
  here: '#7EE787',
  fresh: '#9FCB78',
  muted: '#7F8796',
  frame: '#3B414D',
}

// The dock asks for this many columns; the person can drag it wider.
const DOCK_COLUMNS = 52
const TITLE = /"(customTitle|aiTitle)":"(?:[^"\\]|\\.)*"/.source
const CWD = /"cwd":"[^"]*"/.source

type Api = EngineInterface

function age(ms: number, now: number) {
  const m = Math.max(0, Math.round((now - ms) / 60_000))
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  if (m < 48 * 60) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}

const cut = (text: string, room: number) => (text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`)
// Spaces that push the right-hand text to the row's end; a Button holds only text, so no flex box can.
const gap = (used: number, right: string, room: number) => ' '.repeat(Math.max(1, room - used - right.length))
// Within the hour green, within the day plain, older dim.
const ageColor = (ms: number, now: number) => (now - ms < 3_600_000 ? C.fresh : now - ms < 86_400_000 ? C.title : C.muted)

// grep -H prints `<file>:<match>`; a transcript path ends in .jsonl, so that splits it.
function byFile(stdout: string) {
  const out: [string, Record<string, string>][] = []
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('.jsonl:')
    if (at < 0) continue
    try {
      out.push([line.slice(0, at + 6), JSON.parse(`{${line.slice(at + 7)}}`) as Record<string, string>])
    } catch {}
  }
  return out
}

// Every main-thread transcript under ~/.claude/projects, titled by /rename, else by its AI title.
// Transcripts run past $.fs.read's 4 MiB, so grep pulls the two fields out of all of them in one pass.
async function scan($: Api): Promise<Session[]> {
  const root = `${await $.env.get('HOME')}/.claude/projects`
  const dirs = (await $.fs.list(root)).filter(d => d.kind === 'dir')
  const listed = await Promise.all(dirs.map(async d => ({ d, entries: await $.fs.list(`${root}/${d.name}`) })))
  const files = new Map<string, number>()
  for (const { d, entries } of listed)
    for (const f of entries) if (f.kind === 'file' && f.name.endsWith('.jsonl')) files.set(`${root}/${d.name}/${f.name}`, f.mtimeMs)
  if (files.size === 0) return []

  const paths = [...files.keys()]
  const [titles, cwds] = await Promise.all([
    $.process.run(['grep', '-H', '-o', '-E', TITLE, ...paths]),
    $.process.run(['grep', '-H', '-m1', '-o', '-E', CWD, ...paths]),
  ])
  const custom = new Map<string, string>()
  const ai = new Map<string, string>()
  for (const [file, rec] of byFile(titles.stdout)) {
    if (rec.customTitle) custom.set(file, rec.customTitle)
    if (rec.aiTitle) ai.set(file, rec.aiTitle)
  }
  const cwd = new Map(byFile(cwds.stdout).map(([file, rec]) => [file, rec.cwd ?? '']))

  return paths
    .filter(p => cwd.get(p))
    .map(p => {
      const id = p.slice(p.lastIndexOf('/') + 1, -'.jsonl'.length)
      return { id, cwd: cwd.get(p)!, title: custom.get(p) ?? ai.get(p) ?? `untitled ${id.slice(0, 8)}`, mtimeMs: files.get(p)! }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

async function refresh($: Api) {
  await update($, isLoading, () => true)
  try {
    const found = await scan($)
    await update($, sessions, () => found)
  } catch (err) {
    $.ui.toast(`Sessions: could not read ~/.claude/projects (${err instanceof Error ? err.message : String(err)})`)
  } finally {
    await update($, isLoading, () => false)
  }
}

async function openPane($: Api) {
  await $.ui.open({ id: PANE, title: 'Sessions', focus: true, closeOnEscape: true, columns: DOCK_COLUMNS })
  await refresh($)
}

// The same folder resumes in place; another folder needs its own cwd, so the command goes to the clipboard.
async function resume($: Api, s: Session, surface?: Parameters<Api['ui']['copy']>[0]['surface']) {
  const [here, cwd] = await Promise.all([$.session.id(), $.session.cwd()])
  if (s.id === here) {
    $.ui.toast('That is this session.')
    return
  }
  if (s.cwd === cwd) {
    await $.ui.close({ id: PANE })
    await $.command.run({ command: 'resume', args: s.id })
    return
  }
  const line = `cd '${s.cwd.replace(/'/g, `'\\''`)}' && claude --resume ${s.id}`
  const { isCopied } = await $.ui.copy({ text: line, ...(surface ? { surface } : {}) })
  $.ui.toast(isCopied ? `Copied: ${line}` : `Run in a new tab: ${line}`)
}

const tilde = (path: string, home: string) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sessions', description: 'Browse and resume Claude Code sessions from every workspace' })
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await openPane($)
    return { text: 'Sessions sidebar opened.' }
  })

  // The button sits at the right of the band above the prompt, beside whatever another mod draws there.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const below = await next(e)
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Box flexGrow={1}>{below ?? null}</Box>
        <Button key="open-sessions" plain dimColor label="☰ sessions" onPress={() => void openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // Mobile draws no text field; there the list shows without search.
    const Input = 'Input' in els ? els.Input : undefined
    const [all, folded, q, loading, here, home, now] = await Promise.all([
      read($, sessions),
      read($, open),
      read($, query),
      read($, isLoading),
      $.session.id(),
      $.env.get('HOME'),
      $.clock.now(),
    ])
    const room = Math.max(20, e.props.bodyColumns)
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const shown = words.length === 0 ? all : all.filter(s => words.every(w => `${s.title} ${s.cwd}`.toLowerCase().includes(w)))

    // Folders in order of their newest session, as `shown` is sorted newest first.
    const groups = new Map<string, Session[]>()
    for (const s of shown) groups.set(s.cwd, [...(groups.get(s.cwd) ?? []), s])

    const rule = (key: string) => (
      <Text key={key} color={C.frame}>
        {'─'.repeat(room)}
      </Text>
    )

    return (
      <Box flexDirection="column">
        <Box key="head" gap={1}>
          <Box flexGrow={1}>
            <Text color={C.accent} bold>
              ◆ Sessions
            </Text>
          </Box>
          <Text color={C.muted}>{loading ? 'reading…' : `${shown.length} · ${groups.size} folders`}</Text>
          <Button key="refresh" plain dimColor label="↻" onPress={() => void refresh($)} />
        </Box>
        {rule('rule-head')}
        {Input ? (
          <Input
            key="query"
            label="⌕"
            placeholder="search titles and folders"
            value={q}
            autoFocus
            onInput={(v: string) => void update($, query, () => v)}
            onSubmit={(v: string) => void update($, query, () => v)}
          />
        ) : null}
        {Input ? rule('rule-search') : null}
        {[...groups].map(([cwd, list]) => {
          // A search opens every folder it matched in.
          const isOpen = words.length > 0 || folded[cwd] === true
          // The folder's own name leads; where it sits follows, dim.
          const path = tilde(cwd, home ?? '')
          const slash = path.lastIndexOf('/')
          const count = String(list.length)
          const name = cut(path.slice(slash + 1) || path, room - count.length - 4)
          const parent = cut(slash > 0 ? path.slice(0, slash) : '', Math.max(0, room - name.length - count.length - 6))
          const used = 2 + name.length + (parent ? parent.length + 2 : 0)
          return (
            <Box key={`g:${cwd}`} flexDirection="column">
              <Button key={`folder:${cwd}`} plain onPress={() => void update($, open, m => ({ ...m, [cwd]: !isOpen }))}>
                <Text color={C.muted}>{isOpen ? '▾ ' : '▸ '}</Text>
                <Text color={C.folder} bold>
                  {name}
                </Text>
                <Text color={C.muted}>{parent ? `  ${parent}` : ''}</Text>
                <Text color={C.muted}>{`${gap(used, count, room)}${count}`}</Text>
              </Button>
              {isOpen
                ? list.map((s, i) => {
                    const when = age(s.mtimeMs, now)
                    const isHere = s.id === here
                    const guide = i === list.length - 1 ? '  └─ ' : '  ├─ '
                    const mark = isHere ? '● ' : ''
                    const title = cut(s.title, room - guide.length - mark.length - when.length - 1)
                    return (
                      <Button key={`session:${s.id}`} plain onPress={() => void resume($, s, e.surface)}>
                        <Text color={C.frame}>{guide}</Text>
                        <Text color={C.here}>{mark}</Text>
                        <Text color={isHere ? C.here : C.title} bold={isHere}>
                          {title}
                        </Text>
                        <Text color={ageColor(s.mtimeMs, now)}>{`${gap(guide.length + mark.length + title.length, when, room)}${when}`}</Text>
                      </Button>
                    )
                  })
                : null}
              {isOpen ? <Text key={`space:${cwd}`}> </Text> : null}
            </Box>
          )
        })}
        {!loading && shown.length === 0 ? (
          <Text color={C.muted}>{words.length > 0 ? `  No session matches “${q.trim()}”.` : '  No sessions found.'}</Text>
        ) : null}
      </Box>
    )
  })
}
