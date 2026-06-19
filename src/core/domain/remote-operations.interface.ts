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
import type { TableDelta } from '../sync/sync-pull'
import type { ApplyResult } from '../sync/sync-apply'
import type {
  Task,
  TaskFilter,
  TaskDependency,
  Relationship,
  InboxItem,
  InboxFilter,
  CreateInboxInput,
  Conversation,
  ConversationLink,
  ConversationLinkType,
  ConversationMessage,
  ConversationAction,
  ConversationParticipant,
  ConversationStatus,
  CreateConversationMessageInput
} from './task-types'
import type { OpenConversationInput } from './interfaces/conversation-lifecycle.interface'

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

  // Conversation append-only surface (TASK-1136 AC-4) — the remote allowlist's
  // conversation_open / conversation_add / conversation_read / conversation_list.
  // open + add are the only writes; decide/signoff stay stdio-only.
  openConversation(input: OpenConversationInput): Promise<Conversation>
  addConversationMessage(input: CreateConversationMessageInput): Promise<ConversationMessage>
  getConversation(id: string): Promise<Conversation | null>
  findConversations(projectId: string, status?: ConversationStatus): Promise<Conversation[]>
  getConversationParticipants(conversationId: string): Promise<ConversationParticipant[]>
  getConversationLinks(conversationId: string): Promise<ConversationLink[]>
  markConversationMessageRead(messageId: string, participantName: string): Promise<void>

  // ADR-030 Phase 2 — read-only pull source. Backs GET /sync/since on the HTTP
  // transport; the signature matches the PullSource port (sync-pull.ts) so a
  // service is directly usable as a pull source. Not a REMOTE_TOOL_ALLOWLIST
  // tool — a transport endpoint — but it expands the PG surface, so the standing
  // rule still applies: implemented on PostgresTaskService in the same change.
  fetchSince(since: number): Promise<TableDelta[]>

  // ADR-030 Phase 3 (979a) — the write counterpart to fetchSince. Backs
  // POST /sync/apply: the laptop pushes its locally stamped deltas, the canonical
  // store applies them under server-side LWW (canonical wins ties) and returns a
  // per-row verdict. Like fetchSince this is a transport endpoint, not an MCP
  // tool, so the read+capture allowlist is unchanged. Scope: tasks + inbox only
  // (APPLY_TABLES) — conversation_* stays out until 979e's append-merge ships.
  applyDelta(deltas: TableDelta[], origin: string): Promise<ApplyResult>
}
