import type { Session, SessionStatus, CreateSessionInput, UpdateSessionInput } from '../task-types'

export interface SessionOperations {
  createSession(input: CreateSessionInput): Promise<Session>
  updateSession(id: string, input: UpdateSessionInput): Promise<Session>
  getSession(id: string): Promise<Session | null>
  findSessions(projectId: string, status?: SessionStatus): Promise<Session[]>
  getActiveSession(projectId: string, workspaceId?: string): Promise<Session | null>
  deleteSession(id: string): Promise<void>
}
