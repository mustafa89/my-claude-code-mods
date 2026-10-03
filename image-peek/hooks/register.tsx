import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Preview } from '../types'

const draft = atom({ plugin: 'image-peek', key: 'draft' } as const, [])
const previews = atom({ plugin: 'image-peek', key: 'pictures' } as const, {})

// Long side of the PNG sent to the terminal: sharp at preview size, well under the 2 MiB Image limit.
const MAX_PIXELS = 1000
const MAX_COLUMNS = 100
const MAX_ROWS = 18
const IMAGE_REF = /\[Image #(\d+)\]/g
// A paste can reach the box before its file is written: retry a few times.
const ATTEMPTS = 4
const RETRY_MS = 400

type $ = EngineInterface

function imageRefs(text: string) {
  return [...new Set([...text.matchAll(IMAGE_REF)].map(m => Number(m[1])))]
}

const sameList = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i])

// Pasted images live in /private/tmp/claude-<uid>/<project>/<session id>/images/<n>.<ext>.
async function findImage($: $, n: number) {
  const id = await $.session.id()
  if (!/^[0-9a-f-]+$/i.test(id)) return null
  const { stdout } = await $.process.run([
    '/bin/sh',
    '-c',
    `ls /private/tmp/claude-*/*/${id}/images/${n}.* 2>/dev/null | head -1`,
  ])
  return stdout.trim() || null
}

async function render($: $, src: string): Promise<Preview | null> {
  const dims = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', src])
  const width = Number(/pixelWidth: (\d+)/.exec(dims.stdout)?.[1])
  const height = Number(/pixelHeight: (\d+)/.exec(dims.stdout)?.[1])
  if (!width || !height) return null

  const out = `${src}.peek.png`
  const conv = await $.process.run(['sips', '-s', 'format', 'png', '-Z', String(MAX_PIXELS), src, '--out', out])
  if (conv.exitCode !== 0) return null
  const { base64 } = await $.fs.read(out, { as: 'bytes' })
  await $.process.run(['rm', '-f', out])
  return { width, height, png: base64 }
}

// Cells for a picture: at most `maxColumns` x `maxRows`, aspect kept (a cell is about twice as tall as wide).
function box(p: Preview, maxColumns: number, maxRows: number) {
  const columns = Math.max(1, Math.min(maxColumns, Math.round((maxRows * 2 * p.width) / p.height)))
  const rows = Math.max(1, Math.min(maxRows, Math.round((columns * p.height) / (2 * p.width))))
  return { columns, rows }
}

async function ensure($: $, ns: readonly number[]) {
  for (const n of ns) {
    if ((await read($, previews))[n] !== undefined) continue
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const src = await findImage($, n)
      const preview = src !== null ? await render($, src) : null
      if (preview !== null) {
        await update($, previews, map => ({ ...map, [n]: preview }))
        break
      }
      await $.clock.sleep(RETRY_MS)
    }
  }
}

export const register: Register = on => {
  // Earlier images of this session (a resume, a reload) get previews too.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const id = await $.session.id()
    if (/^[0-9a-f-]+$/i.test(id)) {
      const { stdout } = await $.process.run(['/bin/sh', '-c', `ls /private/tmp/claude-*/*/${id}/images/ 2>/dev/null`])
      const ns = [...stdout.matchAll(/^(\d+)\.(png|jpe?g|gif|webp)$/gm)].map(m => Number(m[1]))
      $.clock.after(0, () => void ensure($, ns).catch(() => undefined))
    }
    return result
  })

  // Track which pasted images the draft holds.
  on('prompt.edit', async ($, e, next) => {
    const ns = imageRefs(e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end))
    if (!sameList(ns, await read($, draft))) {
      await update($, draft, () => ns)
      if (ns.length > 0) $.clock.after(0, () => void ensure($, ns).catch(() => undefined))
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const ns = imageRefs(e.text)
    if (ns.length > 0) $.clock.after(0, () => void ensure($, ns).catch(() => undefined))
    await update($, draft, () => [])
    return next(e)
  })

  // While drafting: the pasted images above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    const [ns, map] = await Promise.all([read($, draft), read($, previews)])
    const shown = ns.filter(n => map[n] !== undefined)
    if (shown.length === 0) return next(e)

    const { Box, Text, Image } = $.ui.resolve(e)
    const maxColumns = Math.min(MAX_COLUMNS, Math.floor(e.props.bodyColumns / shown.length) - 2)
    // The band scrolls past `maxRows`: keep the picture and its caption inside it.
    const maxRows = Math.max(1, Math.min(MAX_ROWS, e.props.maxRows - 1))
    return (
      <Box flexDirection="row" gap={2}>
        {shown.map(n => {
          const p = map[n]!
          const label = `Image #${n} · ${p.width}×${p.height}`
          return (
            <Box key={`draft-${n}`} flexDirection="column">
              <Image key={`draft-img-${n}`} source={{ png: p.png }} {...box(p, maxColumns, maxRows)} alt={label} />
              <Text dimColor>{label}</Text>
            </Box>
          )
        })}
      </Box>
    )
  })

  // In the transcript: the images under the message that sent them.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const ns = imageRefs(e.props.text)
    if (ns.length === 0) return next(e)
    const map = await read($, previews)
    const shown = ns.filter(n => map[n] !== undefined)
    if (shown.length === 0) return next(e)

    const base = await next(e)
    const { Box, Image } = $.ui.resolve(e)
    const width = (e.viewport?.columns ?? 120) - 4
    const maxColumns = Math.min(MAX_COLUMNS, Math.floor(width / shown.length) - 2)
    return (
      <Box flexDirection="column">
        {base}
        <Box flexDirection="row" gap={2} marginLeft={2} marginTop={1}>
          {shown.map(n => {
            const p = map[n]!
            return (
              <Image
                key={`msg-img-${n}`}
                source={{ png: p.png }}
                {...box(p, maxColumns, MAX_ROWS)}
                alt={`Image #${n} · ${p.width}×${p.height}`}
              />
            )
          })}
        </Box>
      </Box>
    )
  })
}
