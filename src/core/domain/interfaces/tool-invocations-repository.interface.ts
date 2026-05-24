export interface ToolInvocation {
  toolName: string
  ts: string
  durationMs: number
  ok: boolean
  errorKind: string | null
}

// Per-tool aggregate over a window. errorRate computed as errors / calls.
// Tools with no rows in the window are NOT returned by the repo — caller
// must left-join the canonical registry to surface dead-in-window tools.
export interface ToolInvocationAggregate {
  tool: string
  calls: number
  errors: number
  avgDurationMs: number
  lastUsedAt: string
}

export interface ToolInvocationWindow {
  since: string | null
  until: string | null
}

export interface ToolInvocationOperations {
  recordToolInvocation(invocation: ToolInvocation): Promise<void>
  countToolInvocations(): Promise<number>
  queryToolInvocations(window: ToolInvocationWindow): Promise<ToolInvocationAggregate[]>
}
