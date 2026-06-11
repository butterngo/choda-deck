// ADR-030 — port that every storage backend (SQLite today, Postgres next)
// must satisfy. Aggregates every Operations interface that `SqliteTaskService`
// already implements, plus the four async methods that were previously
// class-only (initializeAsync, backup, and the tool-invocation surface).
//
// Keeping these declarations here means the factory return type is a single
// stable contract and consumers can program against the port instead of the
// concrete SqliteTaskService class.

import type { TaskService } from './task-service.interface'
import type { ProjectOperations } from './interfaces/project-repository.interface'
import type { WorkspaceOperations } from './interfaces/workspace-repository.interface'
import type { SessionOperations } from './interfaces/session-repository.interface'
import type { ContextSourceOperations } from './interfaces/context-source-repository.interface'
import type { ConversationOperations } from './interfaces/conversation-repository.interface'
import type { InboxOperations } from './interfaces/inbox-repository.interface'
import type { InboxLifecycleOperations } from './interfaces/inbox-lifecycle.interface'
import type { ConversationLifecycleOperations } from './interfaces/conversation-lifecycle.interface'
import type { SessionLifecycleOperations } from './interfaces/session-lifecycle.interface'
import type { KnowledgeOperations } from './interfaces/knowledge-operations.interface'
import type { CodeRefOperations } from './interfaces/code-ref-operations.interface'
import type { SessionEventOperations } from './interfaces/session-event-operations.interface'
import type { AgentMemoryOperations } from './interfaces/agent-memory-operations.interface'
import type { InvestigationOperations } from './interfaces/investigation.interface'
import type {
  ToolInvocation,
  ToolInvocationAggregate,
  ToolInvocationWindow
} from './interfaces/tool-invocations-repository.interface'
import type { CheckAcItemInput, CheckAcItemResult } from './lifecycle/ac-check'
import type { TableDelta } from '../sync/sync-pull'
import type { ApplyResult } from '../sync/sync-apply'

export interface BackendTaskService
  extends TaskService,
    ProjectOperations,
    WorkspaceOperations,
    SessionOperations,
    ContextSourceOperations,
    ConversationOperations,
    InboxOperations,
    InboxLifecycleOperations,
    ConversationLifecycleOperations,
    SessionLifecycleOperations,
    KnowledgeOperations,
    CodeRefOperations,
    SessionEventOperations,
    AgentMemoryOperations,
    InvestigationOperations {
  initializeAsync(): Promise<void>
  backup(absolutePath: string): Promise<void>
  recordToolInvocation(invocation: ToolInvocation): Promise<void>
  countToolInvocations(): Promise<number>
  queryToolInvocations(window: ToolInvocationWindow): Promise<ToolInvocationAggregate[]>
  checkAcItem(input: CheckAcItemInput): Promise<CheckAcItemResult>
  // ADR-030 Phase 2 — read-only pull source (also on RemoteOperations).
  fetchSince(since: number): Promise<TableDelta[]>
  // ADR-030 Phase 3 (979a) — write-apply sink (also on RemoteOperations).
  applyDelta(deltas: TableDelta[], origin: string): Promise<ApplyResult>
}
