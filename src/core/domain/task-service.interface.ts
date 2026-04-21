import type { TaskOperations } from './interfaces/task-repository.interface'
import type { PhaseOperations } from './interfaces/phase-repository.interface'
import type { DocumentOperations } from './interfaces/document-repository.interface'
import type { TagOperations } from './interfaces/tag-repository.interface'
import type { RelationshipOperations } from './interfaces/relationship-repository.interface'
import type { Lifecycle } from './interfaces/lifecycle.interface'

export type {
  TaskOperations,
  PhaseOperations,
  DocumentOperations,
  TagOperations,
  RelationshipOperations,
  Lifecycle
}
export type { SessionOperations } from './interfaces/session-repository.interface'
export type { ContextSourceOperations } from './interfaces/context-source-repository.interface'
export type { ConversationOperations } from './interfaces/conversation-repository.interface'

export interface TaskService
  extends
    TaskOperations,
    PhaseOperations,
    DocumentOperations,
    TagOperations,
    RelationshipOperations,
    Lifecycle {}
