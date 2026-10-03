export type Git = {
  dir: string
  branch: string | null
  isDirty: boolean
  ahead: number
  behind: number
}

export type Limit = { kind: string; pct: number; resetsAt: number | null }

export type Usage = {
  pct: number | null
  tokens: number | null
  window: number
  limits: Limit[]
}

declare module 'claude-code' {
  interface PluginState {
    'slick-bar': {
      git: Git | null
      usage: Usage | null
      model: string
      effort: string
    }
  }
}
