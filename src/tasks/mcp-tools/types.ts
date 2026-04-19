export function textResponse(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return { content: [{ type: 'text' as const, text }] }
}
