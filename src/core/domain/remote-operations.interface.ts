// Narrow port for HTTP/remote-mode storage. Strict subset of the methods
// reachable from REMOTE_TOOL_ALLOWLIST's call graph in server-bootstrap.ts.
//
// Standing rule (ADR-026 §Per-tool scoping): PG adapter surface = this port.
// When the allowlist grows, audit the new tool's service calls, add them
// here, and implement on PostgresTaskService in the same PR. Adding a tool
// to the allowlist without updating this port → registration-time type error
// in buildRemoteMcpServer (server-bootstrap.ts).
//
// SQLite implements BackendTaskService (which is a superset of this). Postgres
// implements only this. The split-factory pattern in task-service-factory.ts
// enforces "PG cannot back stdio" — stdio always gets the full SQLite surface.

import type { ProjectRow } from './repositories/project-repository'
import type { WorkspaceRow } from './repositories/workspace-repository'
import type {
  Task,
  TaskFilter,
  TaskDependency,
  Relationship,
  InboxItem,
  InboxFilter,
  CreateInboxInput,
  Conversation,
  ConversationLinkType,
  ConversationMessage,
  ConversationAction
} from './task-types'

export interface RemoteOperations {
  initializeAsync(): Promise<void>
  close(): Promise<void>

  // Project — project_list (listProjects). getProject is retained for PG/stdio
  // parity + the PG service test; no remote-allowlisted tool hits it since
  // ADR-033 removed task_context's graphify block (candidate to re-narrow).
  getProject(id: string): Promise<ProjectRow | null>
  listProjects(): Promise<ProjectRow[]>

  // Workspace (read-only) — project_list (project-tools.ts attaches workspaces[])
  findWorkspaces(projectId: string, includeArchived?: boolean): Promise<WorkspaceRow[]>

  // Task — task_list + task_context
  getTask(id: string): Promise<Task | null>
  findTasks(filter: TaskFilter): Promise<Task[]>
  getSubtasks(parentId: string): Promise<Task[]>
  getDependencies(taskId: string): Promise<TaskDependency[]>

  // Tag (read-only) — task_context
  getTags(itemId: string): Promise<string[]>

  // Relationship (read-only) — task_context
  getRelationships(itemId: string): Promise<Relationship[]>

  // Inbox — inbox_list + inbox_get + inbox_add
  findInbox(filter: InboxFilter): Promise<InboxItem[]>
  getInbox(id: string): Promise<InboxItem | null>
  createInbox(input: CreateInboxInput): Promise<InboxItem>

  // Conversation (read-only) — inbox_get + task_context display
  findConversationsByLink(
    linkedType: ConversationLinkType,
    linkedId: string
  ): Promise<Conversation[]>
  getConversationMessages(conversationId: string): Promise<ConversationMessage[]>
  getConversationActions(conversationId: string): Promise<ConversationAction[]>
}
