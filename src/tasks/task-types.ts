// Task management types — pure types, zero runtime dependencies

export type TaskStatus = 'TODO' | 'READY' | 'IN-PROGRESS' | 'DONE'
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low'
export type PhaseStatus = 'open' | 'closed'
export type DerivedStatus = 'planned' | 'active' | 'completed'
export type RelationType = 'DEPENDS_ON' | 'IMPLEMENTS' | 'USES_TECH' | 'DECIDED_BY'
export type DocumentType = 'adr' | 'guide' | 'spec' | 'note' | 'research'

export const TASK_STATUSES: TaskStatus[] = ['TODO', 'READY', 'IN-PROGRESS', 'DONE']

export interface Project {
  id: string
  name: string
  cwd: string
}

export interface Phase {
  id: string
  projectId: string
  title: string
  status: PhaseStatus
  position: number
  startDate: string | null
  completedDate: string | null
  createdAt: string
  updatedAt: string
}

export interface Document {
  id: string
  projectId: string
  type: DocumentType
  title: string
  filePath: string | null
  createdAt: string
  updatedAt: string
}

export interface Tag {
  itemId: string
  tag: string
}

export interface Relationship {
  fromId: string
  toId: string
  type: RelationType
}

export interface Task {
  id: string
  projectId: string
  phaseId: string | null
  parentTaskId: string | null
  title: string
  status: TaskStatus
  priority: TaskPriority | null
  labels: string[]
  dueDate: string | null
  pinned: boolean
  filePath: string | null
  body: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskDependency {
  sourceId: string
  targetId: string
}

export interface CreateTaskInput {
  id?: string
  projectId: string
  phaseId?: string
  parentTaskId?: string
  title: string
  status?: TaskStatus
  priority?: TaskPriority
  labels?: string[]
  dueDate?: string
  filePath?: string
  body?: string
}

export interface UpdateTaskInput {
  title?: string
  status?: TaskStatus
  priority?: TaskPriority | null
  phaseId?: string | null
  parentTaskId?: string | null
  labels?: string[]
  dueDate?: string | null
  pinned?: boolean
  filePath?: string | null
  body?: string | null
}

export interface TaskFilter {
  projectId?: string
  status?: TaskStatus
  priority?: TaskPriority
  phaseId?: string
  parentTaskId?: string
  pinned?: boolean
  dueBefore?: string
  query?: string
  limit?: number
}

export interface CreatePhaseInput {
  id?: string
  projectId: string
  title: string
  status?: PhaseStatus
  position?: number
  startDate?: string
}

export interface UpdatePhaseInput {
  title?: string
  status?: PhaseStatus
  position?: number
  startDate?: string | null
  completedDate?: string | null
}

export interface CreateDocumentInput {
  id?: string
  projectId: string
  type: DocumentType
  title: string
  filePath?: string
}

export interface UpdateDocumentInput {
  title?: string
  type?: DocumentType
  filePath?: string | null
}

export interface DerivedProgress {
  total: number
  done: number
  inProgress: number
  status: DerivedStatus
  percent: number
}

// ── Sessions (L3 — Session Lifecycle) ────────────────────────────────────────

export type SessionStatus = 'active' | 'completed' | 'abandoned'

export interface SessionHandoff {
  commits?: string[]
  decisions?: string[]
  resumePoint?: string
  looseEnds?: string[]
  tasksUpdated?: string[]
}

export interface Session {
  id: string
  projectId: string
  workspaceId: string | null
  taskId: string | null
  startedAt: string
  endedAt: string | null
  status: SessionStatus
  handoff: SessionHandoff | null
  createdAt: string
}

export interface CreateSessionInput {
  id?: string
  projectId: string
  workspaceId?: string
  taskId?: string
  startedAt?: string
  status?: SessionStatus
  handoff?: SessionHandoff
}

export interface UpdateSessionInput {
  endedAt?: string | null
  status?: SessionStatus
  taskId?: string | null
  handoff?: SessionHandoff | null
}

// ── Context sources (L1 — Context Engine) ───────────────────────────────────

export type ContextSourceType = 'file' | 'sqlite_query' | 'mcp_tool'
export type ContextCategory = 'who' | 'what' | 'how' | 'state' | 'decisions'

export interface ContextSource {
  id: string
  projectId: string
  sourceType: ContextSourceType
  sourcePath: string
  label: string
  category: ContextCategory
  priority: number
  isActive: boolean
}

export interface CreateContextSourceInput {
  id?: string
  projectId: string
  sourceType: ContextSourceType
  sourcePath: string
  label: string
  category: ContextCategory
  priority?: number
  isActive?: boolean
}

export interface UpdateContextSourceInput {
  sourceType?: ContextSourceType
  sourcePath?: string
  label?: string
  category?: ContextCategory
  priority?: number
  isActive?: boolean
}

// ── Conversations (L2 — Conversation Protocol) ──────────────────────────────

export type ConversationStatus = 'open' | 'discussing' | 'decided' | 'closed' | 'stale'
export type ConversationMessageType =
  | 'question'
  | 'answer'
  | 'proposal'
  | 'review'
  | 'decision'
  | 'action'
  | 'comment'
export type ConversationLinkType = 'task' | 'adr' | 'commit' | 'inbox'
export type ConversationParticipantType = 'human' | 'agent' | 'role'
export type ConversationActionStatus = 'pending' | 'done'

export interface Conversation {
  id: string
  projectId: string
  title: string
  status: ConversationStatus
  createdBy: string
  decisionSummary: string | null
  createdAt: string
  decidedAt: string | null
  closedAt: string | null
}

export interface ConversationParticipant {
  conversationId: string
  name: string
  type: ConversationParticipantType
  role: string | null
}

export interface ConversationMessageMetadata {
  codeChanges?: string[]
  options?: Array<{ id: string; description: string; tradeoff: string }>
  selectedOption?: string
}

export interface ConversationMessage {
  id: string
  conversationId: string
  authorName: string
  content: string
  messageType: ConversationMessageType
  metadata: ConversationMessageMetadata | null
  createdAt: string
}

export interface ConversationLink {
  conversationId: string
  linkedType: ConversationLinkType
  linkedId: string
}

export interface ConversationAction {
  id: string
  conversationId: string
  assignee: string
  description: string
  status: ConversationActionStatus
  linkedTaskId: string | null
  createdAt: string
}

export interface CreateConversationInput {
  id?: string
  projectId: string
  title: string
  createdBy: string
  status?: ConversationStatus
  participants?: Array<{ name: string; type: ConversationParticipantType; role?: string }>
}

export interface UpdateConversationInput {
  title?: string
  status?: ConversationStatus
  decisionSummary?: string | null
  decidedAt?: string | null
  closedAt?: string | null
}

export interface CreateConversationMessageInput {
  id?: string
  conversationId: string
  authorName: string
  content: string
  messageType?: ConversationMessageType
  metadata?: ConversationMessageMetadata
}

export interface CreateConversationActionInput {
  id?: string
  conversationId: string
  assignee: string
  description: string
  status?: ConversationActionStatus
  linkedTaskId?: string
}

export interface UpdateConversationActionInput {
  status?: ConversationActionStatus
  linkedTaskId?: string | null
}

// ── Inbox ────────────────────────────────────────────────────────────────────

export type InboxStatus = 'raw' | 'researching' | 'ready' | 'converted' | 'archived'

export const INBOX_STATUSES: InboxStatus[] = [
  'raw',
  'researching',
  'ready',
  'converted',
  'archived'
]

export interface InboxItem {
  id: string
  projectId: string | null
  content: string
  status: InboxStatus
  linkedTaskId: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateInboxInput {
  projectId: string
  content: string
}

export interface UpdateInboxInput {
  content?: string
  status?: InboxStatus
  linkedTaskId?: string | null
}

export interface InboxFilter {
  projectId?: string | null
  status?: InboxStatus
}
