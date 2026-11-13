import type { EngineInterface, Register } from 'claude-code'

type Api = EngineInterface

// /new-resume [notes]: condense this session's transcript on disk and open a fresh
// Claude Code that reads it. Runs locally: no model request in this session, so a
// cold cache is never re-read.

type Condensed = { out: string; transcript: string; chars: number; tokens: number; turns: number }

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

type RunResult = { exitCode: number | null; stdout: string; stderr: string; isMissing?: boolean }

// $.process.run rejects when the binary cannot start; turn that into a failed result.
async function tryRun($: Api, argv: string[], timeoutMs: number): Promise<RunResult> {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return { exitCode: -1, stdout: '', stderr, isMissing: /ENOENT|not found|failed to start/i.test(stderr) }
  }
}

// Claude Code can start with a PATH that lacks ~/.local/bin or Homebrew, so try each
// candidate binary in turn and move on only when it cannot start.
async function runFirst($: Api, bins: (string | undefined)[], args: string[], timeoutMs = 30_000) {
  let last: RunResult = { exitCode: -1, stdout: '', stderr: 'no candidate binary', isMissing: true }
  for (const bin of bins) {
    if (!bin) continue
    last = await tryRun($, [bin, ...args], timeoutMs)
    if (!last.isMissing) return last
  }
  return last
}

function handoffPrompt(id: string, c: Condensed, notes: string) {
  return [
    `Continue the work from Claude Code session ${id}, which ran out of context.`,
    `Read the handoff file ${c.out} in full (about ${Math.round(c.tokens / 1000)}k tokens).`,
    'It holds the user prompts, your earlier replies, and one line per tool call. Tool results and thinking are left out.',
    'When you need a tool result or a detail it does not have, grep the raw transcript named in its header. Do not read that file whole.',
    'Then reply with a short summary: the goal, what is done, what is open, and the next step. Wait for the user before you act.',
    ...(notes ? [`Notes from the user: ${notes}`] : []),
  ].join(' ')
}

async function newResume($: Api, notes: string) {
  const [id, cwd, home, rexSession, rexBinDir] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.env.get('HOME'),
    $.env.get('REX_SESSION'),
    $.env.get('REX_BIN_DIR'),
  ])
  const out = `${home}/.claude/handoffs/${id}.md`
  const run = await runFirst(
    $,
    ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'],
    ['-I', `${$.plugin.root}/bin/condense.py`, id, out],
    120_000,
  )
  if (run.exitCode !== 0) return { text: `new-resume: condense failed: ${(run.stderr || run.stdout).trim()}` }
  const c = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as Condensed
  const prompt = handoffPrompt(id, c, notes.trim())
  const summary = `Handoff written: ${c.out} (${c.turns} user turns, ~${Math.round(c.tokens / 1000)}k tokens).`
  let rexError = ''

  if (rexSession) {
    // ~/.local/bin/rex is the CLI the shell uses; $REX_BIN_DIR can hold an older copy
    // without --interactive, so drop that flag when a copy refuses it.
    const bins = [`${home}/.local/bin/rex`, '/opt/homebrew/bin/rex', rexBinDir && `${rexBinDir}/rex`, 'rex']
    const args = (interactive: boolean) => [
      'run', '-s', rexSession, '-c', cwd, ...(interactive ? ['--interactive'] : []),
      '--label', 'claude (resumed)', '--', 'claude', prompt,
    ]
    let rex = await runFirst($, bins, args(true))
    if (/unknown flag: --interactive/.test(rex.stderr)) rex = await runFirst($, bins, args(false))
    if (rex.exitCode === 0) return { text: `${summary}\nNew Claude Code opened in a Rex tab. Close this one when the new one has caught up.` }
    rexError = `rex run failed (exit ${rex.exitCode}): ${(rex.stderr || rex.stdout).trim().split('\n')[0]}`
  }

  const line = `cd ${shellQuote(cwd)} && claude ${shellQuote(prompt)}`
  const { isCopied } = await $.ui.copy({ text: line })
  const how = isCopied ? 'Start command copied. Paste it in a new terminal:' : 'Run this in a new terminal:'
  return { text: [summary, ...(rexError ? [rexError] : []), how, line].join('\n') }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'new-resume',
      description: 'Open a fresh Claude Code that reads a condensed copy of this session (no model call here)',
    })
    return next(e)
  })

  // Always answer: a hook that throws is skipped, and the engine then prints a generic error.
  on('command.run', { command: 'new-resume' }, async ($, e) => {
    try {
      return await newResume($, e.args)
    } catch (err) {
      return { text: `new-resume failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
}
