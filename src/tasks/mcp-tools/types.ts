import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SqliteTaskService } from '../sqlite-task-service'

export type Register = (server: McpServer, svc: SqliteTaskService) => void

export function textResponse(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return { content: [{ type: 'text' as const, text }] }
}
