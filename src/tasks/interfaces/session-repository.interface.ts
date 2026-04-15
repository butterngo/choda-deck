import type { Session, SessionStatus, CreateSessionInput, UpdateSessionInput } from '../task-types'

export interface SessionOperations {
  createSession(input: CreateSessionInput): Session
  updateSession(id: string, input: UpdateSessionInput): Session
  getSession(id: string): Session | null
  findSessions(projectId: string, status?: SessionStatus): Session[]
  getActiveSession(projectId: string): Session | null
  deleteSession(id: string): void
}
