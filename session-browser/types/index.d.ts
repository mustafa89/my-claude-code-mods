export type Session = {
  id: string
  cwd: string
  title: string
  mtimeMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-browser': {
      sessions: Session[]
      open: Record<string, boolean>
      query: string
      isLoading: boolean
    }
  }
}
