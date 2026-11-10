import { CodeMode, Tool } from '@opencode/codemode'
import { parse, type AnyNode, type CallExpression, type Pattern, type Program } from 'acorn'
import { ancestor, simple } from 'acorn-walk'
import { Effect } from 'effect'
import { parse as parseShell, quote } from 'shell-quote'

export { quote as shellQuote }

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type HostTool = { readonly name: string; readonly description: string }
export type HostResult = { readonly text: string; readonly isError: boolean; readonly result: unknown }
export type HostCall = (name: string, input: unknown) => Promise<HostResult>
// The host's word on one call the program will reach: start it now, let later calls start early, or stop there.
export type Speculate = (name: string, input: Json | undefined) => Promise<'start' | 'pass' | 'stop'>
export type Notebook = Readonly<Record<string, Json>>

const SAVE = '__cc_save'
const VALUE_BYTES = 100_000
const NOTEBOOK_BYTES = 1_000_000
// A call under one of these may never run, so it can't start early.
const CONDITIONAL = new Set([
  'IfStatement',
  'ConditionalExpression',
  'LogicalExpression',
  'ChainExpression',
  'SwitchStatement',
  'TryStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'FunctionDeclaration',
])

const output = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'What the direct tool call would have shown' },
    isError: { type: 'boolean' },
    result: { description: "The tool's structured output" },
  },
  required: ['text', 'isError', 'result'],
} as const

const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, sorted(item)]),
        )
      : value

export const callKey = (name: string, input: unknown) => `${name} ${JSON.stringify(sorted(input))}`

// The simple commands of a shell line joined by `&&`, `||`, `;` and `|`, with `$HOME` filled in and stderr sent to
// stdout or /dev/null dropped. Undefined for anything else: another variable, a substitution, a redirect, a subshell.
export const shellSegments = (command: string, home: string) => {
  let otherVariable = false
  const tokens = parseShell(command, key => {
    if (key === 'HOME') return home
    otherVariable = true
    return ''
  })
  if (otherVariable) return undefined
  const segments: string[][] = [[]]
  let skip = false
  for (const [i, token] of tokens.entries()) {
    const words = segments.at(-1) ?? []
    if (skip) skip = false
    else if (typeof token === 'string') words.push(token)
    else if ('comment' in token) break
    else if ('pattern' in token) words.push(token.pattern)
    else if (['&&', '||', ';', '|'].includes(token.op)) segments.push([])
    else if (
      (token.op === '>&' || token.op === '>') &&
      ['1', '2'].includes(words.at(-1) ?? '') &&
      ['1', '/dev/null'].includes(String(tokens[i + 1]))
    ) {
      words.pop()
      skip = true
    } else return undefined
  }
  return segments.filter(words => words.length > 0).map(words => ({ words, text: quote(words) }))
}

// The value of an argument written as plain data, or undefined when it reads anything at run time.
const literal = (node: AnyNode | null): { value: Json } | undefined => {
  switch (node?.type) {
    case 'Literal':
      return typeof node.value === 'string' ||
        typeof node.value === 'number' ||
        typeof node.value === 'boolean' ||
        node.value === null
        ? { value: node.value }
        : undefined
    case 'TemplateLiteral': {
      const cooked = node.expressions.length === 0 ? node.quasis[0]?.value.cooked : undefined
      return typeof cooked === 'string' ? { value: cooked } : undefined
    }
    case 'UnaryExpression': {
      const inner = node.operator === '-' ? literal(node.argument) : undefined
      return typeof inner?.value === 'number' ? { value: -inner.value } : undefined
    }
    case 'ArrayExpression': {
      const items = node.elements.map(literal)
      return items.every(item => item !== undefined) ? { value: items.map(item => item.value) } : undefined
    }
    case 'ObjectExpression': {
      const entries = node.properties.map(property => {
        if (property.type !== 'Property' || property.kind !== 'init' || property.computed || property.method) return
        const key =
          property.key.type === 'Identifier'
            ? property.key.name
            : property.key.type === 'Literal' && typeof property.key.value === 'string'
              ? property.key.value
              : undefined
        const value = literal(property.value)
        return key === undefined || value === undefined ? undefined : ([key, value.value] as const)
      })
      return entries.every(entry => entry !== undefined) ? { value: Object.fromEntries(entries) } : undefined
    }
    default:
      return undefined
  }
}

const toolName = ({ callee }: CallExpression) => {
  if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier' || callee.object.name !== 'tools')
    return
  if (!callee.computed && callee.property.type === 'Identifier') return { name: callee.property.name }
  return {
    name:
      callee.property.type === 'Literal' && typeof callee.property.value === 'string'
        ? callee.property.value
        : undefined,
  }
}

// The tool calls of the top-level statements in source order, up to the first statement that calls something the
// analysis can't name. A call under a branch, loop or function, or with a computed argument, has no input.
const plan = (program: Program) => {
  const planned: Array<{ name: string; input: Json | undefined }> = []
  for (const statement of program.body) {
    let opaque = false
    const calls: Array<{ name: string; input: Json | undefined; at: number }> = []
    ancestor(statement, {
      CallExpression(node, _, ancestors) {
        const tool = toolName(node)
        if (tool === undefined) {
          if (node.callee.type === 'Identifier' && node.callee.name !== 'search') opaque = true
          return
        }
        if (tool.name === undefined) {
          opaque = true
          return
        }
        const always = !ancestors.slice(0, -1).some(node => CONDITIONAL.has(node.type))
        const argument = always && node.arguments.length === 1 ? literal(node.arguments[0] ?? null) : undefined
        calls.push({ name: tool.name, input: argument?.value, at: node.start })
      },
    })
    if (opaque) break
    planned.push(...calls.sort((a, b) => a.at - b.at))
  }
  return planned
}

const patternNames = (pattern: Pattern): string[] => {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name]
    case 'ObjectPattern':
      return pattern.properties.flatMap(p => patternNames(p.type === 'RestElement' ? p.argument : p.value))
    case 'ArrayPattern':
      return pattern.elements.flatMap(element => (element === null ? [] : patternNames(element)))
    case 'RestElement':
      return patternNames(pattern.argument)
    case 'AssignmentPattern':
      return patternNames(pattern.left)
    default:
      return []
  }
}

// Hands the program the notebook values it names, and saves its top-level declarations as it finishes.
const withNotebook = (code: string, program: Program, notebook: Notebook) => {
  const declared = program.body.flatMap(statement =>
    statement.type === 'VariableDeclaration'
      ? statement.declarations.flatMap(d => patternNames(d.id)).map(name => ({ name, end: statement.end }))
      : [],
  )
  const used = new Set<string>()
  simple(program, { Identifier: node => void used.add(node.name) })
  const own = new Set(declared.map(d => d.name))
  const given = Object.keys(notebook).filter(name => used.has(name) && !own.has(name))
  const prefix = given.map(name => `const ${name} = JSON.parse(${JSON.stringify(JSON.stringify(notebook[name]))});`)
  if (declared.length === 0) return prefix.join(' ') + (prefix.length ? ' ' : '') + code

  const save = (at: number) =>
    `await tools.${SAVE}({ ${declared
      .filter(d => d.end <= at)
      .map(d => `${JSON.stringify(d.name)}: ${d.name}`)
      .join(', ')} });`
  const edits: Array<{ start: number; end: number; text: string }> = []
  ancestor(program, {
    ReturnStatement(node, _, ancestors) {
      if (ancestors.some(a => a.type.includes('Function'))) return
      const value = node.argument ? code.slice(node.argument.start, node.argument.end) : 'undefined'
      edits.push({
        start: node.start,
        end: node.end,
        text: `{ const __ccValue = (${value}); ${save(node.start)} return __ccValue }`,
      })
    },
  })
  const last = program.body.at(-1)
  if (last?.type === 'ExpressionStatement') {
    const value = code.slice(last.expression.start, last.expression.end)
    edits.push({
      start: last.start,
      end: last.end,
      text: `{ const __ccValue = (${value}); ${save(last.start)} return __ccValue }`,
    })
  } else if (last?.type !== 'ReturnStatement') {
    edits.push({ start: code.length, end: code.length, text: `\n{ ${save(code.length)} return }` })
  }
  const body = edits
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), code)
  return prefix.join(' ') + (prefix.length ? ' ' : '') + body
}

// Keeps what fits: each value under VALUE_BYTES, the newest first until NOTEBOOK_BYTES.
const nextNotebook = (notebook: Notebook, saved: Record<string, unknown>) => {
  const fresh = Object.entries(saved).flatMap(([name, value]) => {
    const json = JSON.stringify(value)
    return json === undefined ? [] : [{ name, json }]
  })
  const tooBig = fresh.filter(entry => entry.json.length > VALUE_BYTES).map(entry => entry.name)
  const kept = fresh.filter(entry => entry.json.length <= VALUE_BYTES)
  const names = new Set(kept.map(entry => entry.name))
  const older = Object.entries(notebook)
    .filter(([name]) => !names.has(name))
    .map(([name, value]) => ({ name, json: JSON.stringify(value) }))
  let bytes = 0
  const next: Record<string, Json> = {}
  for (const entry of [...kept].reverse().concat([...older].reverse())) {
    bytes += entry.json.length
    if (bytes > NOTEBOOK_BYTES) break
    next[entry.name] = JSON.parse(entry.json)
  }
  return { notebook: next, saved: kept.map(entry => entry.name), tooBig }
}

const parseProgram = (code: string) => {
  try {
    return parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    })
  } catch {
    return undefined
  }
}

export const execute = async (
  code: string,
  tools: ReadonlyArray<HostTool>,
  call: HostCall,
  options: { readonly signal: AbortSignal; readonly notebook: Notebook; readonly speculate: Speculate },
) => {
  const program = parseProgram(code)
  const planned = program ? plan(program) : []
  const verdicts = await Promise.all(planned.map(p => options.speculate(p.name, p.input)))
  const stop = verdicts.indexOf('stop')
  const early = new Map<string, Array<Promise<HostResult>>>()
  let started = 0
  planned.slice(0, stop === -1 ? undefined : stop).forEach(({ name, input }, i) => {
    if (verdicts[i] !== 'start') return
    const run = call(name, input)
    // Nobody may wait on it if the program fails first.
    run.catch(() => {})
    early.set(callKey(name, input), [...(early.get(callKey(name, input)) ?? []), run])
    started += 1
  })

  let used = 0
  let saved: Record<string, unknown> = {}
  const host = (name: string, input: unknown) => {
    const run = early.get(callKey(name, input))?.shift()
    if (run === undefined) return call(name, input)
    used += 1
    return run
  }
  const result = await Effect.runPromise(
    CodeMode.execute({
      code: program ? withNotebook(code, program, options.notebook) : code,
      tools: {
        ...Object.fromEntries(
          tools.map(tool => [
            tool.name,
            Tool.make({
              description: tool.description,
              input: { type: 'object' },
              output,
              execute: input => Effect.tryPromise(() => host(tool.name, input)),
            }),
          ]),
        ),
        [SAVE]: Tool.make({
          description: 'Internal to CodeMode, never call it.',
          input: { type: 'object' },
          output: { type: 'object' },
          execute: input =>
            Effect.sync(() => {
              saved = typeof input === 'object' && input !== null ? { ...input } : {}
              return {}
            }),
        }),
      },
      limits: { maxToolCalls: 200, maxOutputBytes: 100_000 },
    }),
    { signal: options.signal },
  )
  const next = result.ok ? nextNotebook(options.notebook, saved) : undefined
  return {
    ...result,
    toolCalls: result.toolCalls.filter(c => c.name !== SAVE),
    early: used,
    unused: started - used,
    notebook: next?.notebook,
    saved: next?.saved ?? [],
    tooBig: next?.tooBig ?? [],
  }
}
