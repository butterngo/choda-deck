import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import type { AgentMemoryOperations } from '../../../core/domain/interfaces/agent-memory-operations.interface'
import type { MemoryScopeType, MemoryType } from '../../../core/domain/task-types'

const SCOPE_TYPE_ENUM = ['user', 'project', 'workspace', 'task'] as const
const MEMORY_TYPE_ENUM = ['episodic', 'procedural'] as const

export const register = (server: InstrumentedServer, svc: AgentMemoryOperations): void => {
  server.registerTool(
    'memory_write',
    {
      description:
        'Persist a memory at a given scope (task/workspace/project/user). Returns the memory id. Use episodic for what-happened facts and procedural for how-to patterns.',
      inputSchema: {
        scopeType: z.enum(SCOPE_TYPE_ENUM).describe('Scope level of the memory'),
        scopeId: z.string().describe('ID of the scope entity (taskId, workspaceId, projectId, or userId)'),
        memoryType: z.enum(MEMORY_TYPE_ENUM).describe('episodic = what happened, procedural = how-to'),
        content: z.string().min(1).describe('Memory content in plain text'),
        tags: z.array(z.string()).optional().describe('Searchable tags'),
        importance: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe('Importance 0–100 (default 50)'),
        sourceSessionId: z.string().optional().describe('Session that produced this memory'),
        sourceEventIds: z
          .array(z.string())
          .optional()
          .describe('Event IDs that support this memory')
      }
    },
    async ({ scopeType, scopeId, memoryType, content, tags, importance, sourceSessionId, sourceEventIds }) => {
      const memory = svc.writeMemory({
        scopeType: scopeType as MemoryScopeType,
        scopeId,
        memoryType: memoryType as MemoryType,
        content,
        tags,
        importance,
        sourceSessionId,
        sourceEventIds
      })
      return textResponse({ id: memory.id, createdAt: memory.createdAt })
    }
  )
}
