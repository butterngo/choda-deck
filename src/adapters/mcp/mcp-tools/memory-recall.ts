import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import type { AgentMemoryOperations } from '../../../core/domain/interfaces/agent-memory-operations.interface'

export const register = (server: InstrumentedServer, svc: AgentMemoryOperations): void => {
  server.registerTool(
    'memory_recall',
    {
      description:
        'Recall memories across scopes (task → workspace → project → user), merged and ranked by importance. At least one scope ID must be provided. Updates recall stats for returned memories.',
      inputSchema: {
        taskId: z.string().optional().describe('Recall task-scoped memories'),
        workspaceId: z.string().optional().describe('Recall workspace-scoped memories'),
        projectId: z.string().optional().describe('Recall project-scoped memories'),
        userId: z.string().optional().describe('Recall user-scoped memories'),
        tags: z.array(z.string()).optional().describe('Filter by tags (any match)'),
        limit: z.number().int().positive().optional().describe('Max memories to return')
      }
    },
    async ({ taskId, workspaceId, projectId, userId, tags, limit }) => {
      if (!taskId && !workspaceId && !projectId && !userId) {
        return textResponse({ error: 'At least one scope ID (taskId, workspaceId, projectId, userId) is required' })
      }
      const memories = svc.recallMemories({ taskId, workspaceId, projectId, userId, tags, limit })
      return textResponse(memories)
    }
  )
}
