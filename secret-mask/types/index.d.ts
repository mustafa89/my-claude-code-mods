// The placeholder map, held by the host for this session only (never written to disk).
export type VaultEntry = { kind: string; value: string }

declare module 'claude-code' {
  interface PluginState {
    'secret-mask': { vault: Record<string, VaultEntry> }
  }
}
