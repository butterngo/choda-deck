export interface ToolInvocation {
  toolName: string
  ts: string
  durationMs: number
  ok: boolean
  errorKind: string | null
}

export interface ToolInvocationOperations {
  recordToolInvocation(invocation: ToolInvocation): void
  countToolInvocations(): number
}
