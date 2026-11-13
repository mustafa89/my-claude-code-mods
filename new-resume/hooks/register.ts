import type { EngineInterface, Register } from 'claude-code'

type Api = EngineInterface

// /new-resume [notes]: condense this session's transcript on disk and open a fresh
// Claude Code that reads it. Runs locally: no model request in this session, so a
// cold cache is never re-read.

type Condensed = { out: string; transcript: string; chars: number; tokens: number; turns: number }

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// Claude Code can start with a PATH that lacks ~/.local/bin or Homebrew, so look for
// the binaries by absolute path first and use the bare name only as a last resort.
async function findBin($: Api, name: string, candidates: (string | undefined)[]) {
  for (const path of candidates) {
    if (path && (await $.fs.exists(path).catch(() => false))) return path
  }
  return name
}

// $.process.run rejects when the binary cannot start; turn that into a failed result.
async function tryRun($: Api, argv: string[], timeoutMs = 30_000) {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
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
  const python = await findBin($, 'python3', ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'])
  const run = await tryRun($, [python, '-I', `${$.plugin.root}/bin/condense.py`, id, out], 120_000)
  if (run.exitCode !== 0) return { text: `new-resume: condense failed: ${(run.stderr || run.stdout).trim()}` }
  const c = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}') as Condensed
  const prompt = handoffPrompt(id, c, notes.trim())
  const summary = `Handoff written: ${c.out} (${c.turns} user turns, ~${Math.round(c.tokens / 1000)}k tokens).`

  if (rexSession) {
    const rexBin = await findBin($, 'rex', [rexBinDir && `${rexBinDir}/rex`, `${home}/.local/bin/rex`, '/opt/homebrew/bin/rex'])
    const rex = await tryRun($, [
      rexBin, 'run', '-s', rexSession, '-c', cwd, '--interactive', '--label', 'claude (resumed)',
      '--', 'claude', prompt,
    ])
    if (rex.exitCode === 0) return { text: `${summary}\nNew Claude Code opened in a Rex tab. Close this one when the new one has caught up.` }
    $.ui.toast(`new-resume: rex run failed (${rex.stderr.trim()}); command copied instead`)
  }

  const line = `cd ${shellQuote(cwd)} && claude ${shellQuote(prompt)}`
  const { isCopied } = await $.ui.copy({ text: line })
  return { text: `${summary}\n${isCopied ? 'Start command copied. Paste it in a new terminal:' : 'Run this in a new terminal:'}\n${line}` }
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
