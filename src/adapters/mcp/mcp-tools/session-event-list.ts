import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import type { SessionEventOperations } from '../../../core/domain/interfaces/session-event-operations.interface'
import type { SessionEventType } from '../../../core/domain/task-types'

const EVENT_TYPE_ENUM = [
  'tool_call',
  'decision',
  'observation',
  'task_update',
  'memory_write',
  'memory_recall'
] as const

export const register = (server: InstrumentedServer, svc: SessionEventOperations): void => {
  server.registerTool(
    'session_event_list',
    {
      description:
        'List events recorded in a session, ordered oldest-first. Filter by eventType and cap with limit.',
      inputSchema: {
        sessionId: z.string().describe('Session ID to query'),
        eventType: z
          .enum(EVENT_TYPE_ENUM)
          .optional()
          .describe('Filter to a specific event type'),
        limit: z.number().int().positive().optional().describe('Max events to return')
      }
    },
    async ({ sessionId, eventType, limit }) => {
      const events = svc.listSessionEvents(sessionId, eventType as SessionEventType | undefined, limit)
      return textResponse(events)
    }
  )
}
