import type { SessionEvent, SessionEventType, CreateSessionEventInput } from '../task-types'

export interface SessionEventOperations {
  createSessionEvent(input: CreateSessionEventInput): Promise<SessionEvent>
  listSessionEvents(sessionId: string, eventType?: SessionEventType, limit?: number): Promise<SessionEvent[]>
}
