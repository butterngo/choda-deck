import type { SessionEvent, SessionEventType, CreateSessionEventInput } from '../task-types'

export interface SessionEventOperations {
  createSessionEvent(input: CreateSessionEventInput): SessionEvent
  listSessionEvents(sessionId: string, eventType?: SessionEventType, limit?: number): SessionEvent[]
}
