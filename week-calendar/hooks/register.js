// week-calendar mod
// /week          build this week's calendar, write the 3-line report, open the HTML
// /week last     same for last week (also accepts -1, -2, ...)

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function parseOffset(args) {
  const a = (args || '').trim()
  if (a === 'last') return -1
  const n = parseInt(a, 10)
  return Number.isFinite(n) && n <= 0 ? n : 0
}

async function shippedLine($, s) {
  const lines = Object.entries(s.commitSubjects).map(([p, subj]) => `${p}:\n- ${subj.join('\n- ')}`).join('\n\n')
  if (!lines) return 'No commits this week'
  const r = await $.model.complete({
    model: 'sonnet',
    system: 'You write one line for a weekly engineering report. Read the commit subjects grouped by project and name the 1 to 3 main things that were finished, as short noun phrases joined by commas. No preamble, no project names unless needed, under 15 words.',
    prompt: lines,
    maxTokens: 80,
    timeoutMs: 20000,
  })
  return r.isAnswered && r.text.trim() ? r.text.trim().split('\n')[0] : Object.keys(s.commitSubjects).join(', ')
}

async function openFile($, file) {
  for (const cmd of ['open', 'xdg-open']) {
    try {
      const r = await $.process.run([cmd, file])
      if (r.exitCode === 0) return true
    } catch {}
  }
  return false
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'week',
        description: 'Weekly session calendar and 3-line report',
        argumentHint: '[last|-N]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('could not register /week: ' + err.message)
    }
    return next(e)
  })

  on('command.run', { command: 'week' }, async ($, e) => {
    const root = typeof $.plugin.root === 'function' ? await $.plugin.root() : $.plugin.root
    let r
    try {
      r = await $.process.run(['node', root + '/bin/build.mjs', '--offset', String(parseOffset(e.args)), '--json'])
    } catch (err) {
      return { text: 'week-calendar: build did not run: ' + err.message }
    }
    if (r.exitCode !== 0) return { text: 'week-calendar: build failed:\n' + r.stderr.slice(0, 1500) }

    const s = JSON.parse(r.stdout)
    const shipped = await shippedLine($, s)
    const raw = await $.fs.read(s.htmlPath)
    const html = typeof raw === 'string' ? raw : raw.text
    await $.fs.write(s.htmlPath, html.replace(/<!--S-->[\s\S]*?<!--\/S-->/, '<!--S-->' + esc(shipped) + '<!--/S-->'))

    const opened = await openFile($, s.htmlPath)
    $.ui.status(`${s.range}: ${s.total}, ${s.noCommit.length} without commit`)

    const report = [
      'Shipped: ' + shipped,
      'Most time: ' + (s.top || 'none'),
      'Next: ' + (s.noCommit.slice(0, 2).join(', ') || 'nothing left open'),
    ].join('\n')
    return { text: report + '\n\n' + (opened ? 'Opened ' : 'Calendar: ') + s.htmlPath }
  })
}
