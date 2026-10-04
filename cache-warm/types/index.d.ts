export type Health = {
  /** Cache lifetime and how long before expiry a ping goes out, in ms. */
  ttlMs: number
  marginMs: number
  /** Pings per idle stretch before the cache is left to expire. */
  maxPings: number
  /** When the last request that read or wrote the cache finished; 0 before the first. */
  lastAt: number
  isWarm: boolean
  isEnabled: boolean
  /** Share of the last main-thread request's input the cache served, 0..1. */
  lastRatio: number | null
  hits: number
  misses: number
  /** Pings in the current idle stretch, and over the session. */
  pings: number
  pingsTotal: number
  /** Why pinging stopped or what the last ping did. */
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'cache-warm': {
      health: Health
    }
  }
}
