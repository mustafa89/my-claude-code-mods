// Types for runtime.js, the bundle of build/runtime.ts.
import type { Json } from '../types/index.js'

export type { Json }
export type HostTool = { readonly name: string; readonly description: string }
export type HostResult = { readonly text: string; readonly isError: boolean; readonly result: unknown }
export type HostCall = (name: string, input: unknown) => Promise<HostResult>
export type Speculate = (name: string, input: Json | undefined) => Promise<'start' | 'pass' | 'stop'>
export type Notebook = Readonly<Record<string, Json>>
export type Diagnostic = { readonly kind: string; readonly message: string }
type Run = {
  readonly logs?: ReadonlyArray<string>
  readonly truncated?: boolean
  readonly toolCalls: ReadonlyArray<{ readonly name: string }>
  /** Calls served from a run that started before the program reached it. */
  readonly early: number
  /** Calls started early that the program never reached. */
  readonly unused: number
  /** The notebook after a successful run; undefined when nothing may be saved. */
  readonly notebook: Record<string, Json> | undefined
  readonly saved: ReadonlyArray<string>
  readonly tooBig: ReadonlyArray<string>
}
export type Result =
  | (Run & { readonly ok: true; readonly value: unknown; readonly warnings?: ReadonlyArray<Diagnostic> })
  | (Run & { readonly ok: false; readonly error: Diagnostic })
export declare const callKey: (name: string, input: unknown) => string
export declare const shellSegments: (
  command: string,
  home: string,
) => ReadonlyArray<{ readonly words: ReadonlyArray<string>; readonly text: string }> | undefined
export declare const shellQuote: (words: ReadonlyArray<string>) => string
export declare const execute: (
  code: string,
  tools: ReadonlyArray<HostTool>,
  call: HostCall,
  options: { readonly signal: AbortSignal; readonly notebook: Notebook; readonly speculate: Speculate },
) => Promise<Result>
