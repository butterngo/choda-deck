import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import type { SessionEventOperations } from '../../../core/domain/interfaces/session-event-operations.interface'

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
    'session_event_add',
    {
      description:
        'Record an event within an active session. Returns the persisted event id. Set memoryCandidate=true to flag the event for later memory_write promotion.',
      inputSchema: {
        sessionId: z.string().describe('Active session ID'),
        eventType: z.enum(EVENT_TYPE_ENUM).describe('Type of event'),
        payload: z
          .record(z.unknown())
          .optional()
          .describe('Arbitrary JSON payload (serialised as JSON string)'),
        memoryCandidate: z
          .boolean()
          .optional()
          .describe('Flag this event for memory promotion (default false)')
      }
    },
    async ({ sessionId, eventType, payload, memoryCandidate }) => {
      const event = svc.createSessionEvent({
        sessionId,
        eventType,
        payloadJson: payload ? JSON.stringify(payload) : undefined,
        memoryCandidate: memoryCandidate ?? false
      })
      return textResponse({ id: event.id, createdAt: event.createdAt })
    }
  )
}
