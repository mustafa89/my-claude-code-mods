/** How long each tool call took, in ms, by tool_use_id (most recent calls only). */
export type ToolTimes = Record<string, number>

/** Cards the person expanded, by tool_use_id. */
export type ToolExpanded = Record<string, boolean>

declare module 'claude-code' {
  interface PluginState {
    'tool-cards': {
      times: ToolTimes
      expanded: ToolExpanded
      /** `/cards full`: every card shows its whole output. */
      showAll: boolean
    }
  }
}
