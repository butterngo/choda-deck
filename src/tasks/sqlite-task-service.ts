import Database from 'better-sqlite3'
import type { TaskService } from './task-service.interface'
import type {
  Task,
  Phase,
  Feature,
  Document,
  Relationship,
  TaskDependency,
  Session,
  SessionHandoff,
  SessionStatus,
  CreateSessionInput,
  UpdateSessionInput,
  ContextSource,
  ContextSourceType,
  ContextCategory,
  CreateContextSourceInput,
  UpdateContextSourceInput,
  Conversation,
  ConversationStatus,
  ConversationMessage,
  ConversationMessageType,
  ConversationMessageMetadata,
  ConversationLink,
  ConversationLinkType,
  ConversationParticipant,
  ConversationParticipantType,
  ConversationAction,
  ConversationActionStatus,
  CreateConversationInput,
  UpdateConversationInput,
  CreateConversationMessageInput,
  CreateConversationActionInput,
  UpdateConversationActionInput,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilter,
  CreatePhaseInput,
  UpdatePhaseInput,
  CreateFeatureInput,
  UpdateFeatureInput,
  CreateDocumentInput,
  UpdateDocumentInput,
  TaskStatus,
  PhaseStatus,
  RelationType,
  DocumentType,
  DerivedProgress
} from './task-types'

function now(): string {
  return new Date().toISOString()
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    featureId: (row.feature_id as string) || null,
    parentTaskId: (row.parent_task_id as string) || null,
    title: row.title as string,
    status: row.status as TaskStatus,
    priority: (row.priority as Task['priority']) || null,
    labels: row.labels ? JSON.parse(row.labels as string) : [],
    dueDate: (row.due_date as string) || null,
    pinned: row.pinned === 1,
    filePath: (row.file_path as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

function rowToPhase(row: Record<string, unknown>): Phase {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    status: row.status as PhaseStatus,
    position: (row.position as number) || 0,
    startDate: (row.start_date as string) || null,
    completedDate: (row.completed_date as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

function rowToFeature(row: Record<string, unknown>): Feature {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    phaseId: (row.phase_id as string) || null,
    title: row.title as string,
    priority: (row.priority as Feature['priority']) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

function rowToDocument(row: Record<string, unknown>): Document {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    type: row.type as DocumentType,
    title: row.title as string,
    filePath: (row.file_path as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

function derivedProgress(total: number, done: number, inProgress: number): DerivedProgress {
  const status = total === 0 ? 'planned'
    : done === total ? 'completed'
    : (done > 0 || inProgress > 0) ? 'active'
    : 'planned'
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return { total, done, inProgress, status, percent }
}

type Param = string | number | null | undefined | boolean

export class SqliteTaskService implements TaskService {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.createTables()
  }

  async initializeAsync(): Promise<void> { /* no-op */ }
  initialize(): void { /* no-op */ }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS phases (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        position INTEGER DEFAULT 0,
        target_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS features (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        phase_id TEXT,
        title TEXT NOT NULL,
        priority TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        feature_id TEXT,
        parent_task_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'TODO',
        priority TEXT,
        labels TEXT,
        due_date TEXT,
        pinned INTEGER DEFAULT 0,
        file_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        item_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (item_id, tag)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relationships (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, type)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        file_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)

    // Migrate: add startDate + completedDate to phases
    try { this.db.exec('ALTER TABLE phases ADD COLUMN start_date TEXT') } catch { /* exists */ }
    try { this.db.exec('ALTER TABLE phases ADD COLUMN completed_date TEXT') } catch { /* exists */ }

    // Migrate: add feature_id to tasks if missing (was epic_id)
    try {
      this.db.exec('ALTER TABLE tasks ADD COLUMN feature_id TEXT')
    } catch { /* column already exists */ }

    // Migrate: copy epic_id → feature_id via epics table if epics exist
    try {
      this.db.exec(`
        UPDATE tasks SET feature_id = (
          SELECT e.feature_id FROM epics e WHERE e.id = tasks.epic_id
        ) WHERE epic_id IS NOT NULL AND feature_id IS NULL
      `)
    } catch { /* epics table may not exist */ }

    // Drop legacy tables
    this.db.exec('DROP TABLE IF EXISTS epics')
    this.db.exec('DROP TABLE IF EXISTS task_dependencies')

    // Drop legacy column index (epic_id) — column stays but unused
    try { this.db.exec('DROP INDEX IF EXISTS idx_tasks_epic') } catch { /* ok */ }

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_phases_project ON phases(project_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_features_phase ON features(phase_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_id, status)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_feature ON tasks(feature_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tags_item ON tags(item_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id)')

    // ── M1: sessions, context_sources, conversations ────────────────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        handoff_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_sources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_path TEXT NOT NULL,
        label TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        is_active INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_by TEXT NOT NULL,
        decision_summary TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at TEXT,
        closed_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_participants (
        conversation_id TEXT NOT NULL,
        participant_name TEXT NOT NULL,
        participant_type TEXT NOT NULL,
        participant_role TEXT,
        PRIMARY KEY (conversation_id, participant_name),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'comment',
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_links (
        conversation_id TEXT NOT NULL,
        linked_type TEXT NOT NULL,
        linked_id TEXT NOT NULL,
        PRIMARY KEY (conversation_id, linked_type, linked_id),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_actions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        assignee TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        linked_task_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `)

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(project_id, status)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_context_sources_project ON context_sources(project_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_conv_messages_conv ON conversation_messages(conversation_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_conv_links_conv ON conversation_links(conversation_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_conv_participants_conv ON conversation_participants(conversation_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_conv_actions_conv ON conversation_actions(conversation_id)')
  }

  // ── Row mappers (M1) ───────────────────────────────────────────────────────

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      startedAt: row.started_at as string,
      endedAt: (row.ended_at as string) || null,
      status: row.status as SessionStatus,
      handoff: row.handoff_json ? JSON.parse(row.handoff_json as string) as SessionHandoff : null,
      createdAt: row.created_at as string
    }
  }

  private rowToContextSource(row: Record<string, unknown>): ContextSource {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      sourceType: row.source_type as ContextSourceType,
      sourcePath: row.source_path as string,
      label: row.label as string,
      category: row.category as ContextCategory,
      priority: row.priority as number,
      isActive: row.is_active === 1
    }
  }

  private rowToConversation(row: Record<string, unknown>): Conversation {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      title: row.title as string,
      status: row.status as ConversationStatus,
      createdBy: row.created_by as string,
      decisionSummary: (row.decision_summary as string) || null,
      createdAt: row.created_at as string,
      decidedAt: (row.decided_at as string) || null,
      closedAt: (row.closed_at as string) || null
    }
  }

  private rowToConversationParticipant(row: Record<string, unknown>): ConversationParticipant {
    return {
      conversationId: row.conversation_id as string,
      name: row.participant_name as string,
      type: row.participant_type as ConversationParticipantType,
      role: (row.participant_role as string) || null
    }
  }

  private rowToConversationAction(row: Record<string, unknown>): ConversationAction {
    return {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      assignee: row.assignee as string,
      description: row.description as string,
      status: row.status as ConversationActionStatus,
      linkedTaskId: (row.linked_task_id as string) || null,
      createdAt: row.created_at as string
    }
  }

  private rowToConversationMessage(row: Record<string, unknown>): ConversationMessage {
    return {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      authorName: row.author_name as string,
      content: row.content as string,
      messageType: row.message_type as ConversationMessageType,
      metadata: row.metadata_json
        ? JSON.parse(row.metadata_json as string) as ConversationMessageMetadata
        : null,
      createdAt: row.created_at as string
    }
  }

  // ── Session CRUD ───────────────────────────────────────────────────────────

  createSession(input: CreateSessionInput): Session {
    const ts = now()
    const id = input.id || `SESSION-${Date.now()}`
    const startedAt = input.startedAt || ts
    this.db.prepare(
      `INSERT INTO sessions (id, project_id, started_at, status, handoff_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, input.projectId, startedAt, input.status || 'active',
      input.handoff ? JSON.stringify(input.handoff) : null, ts)
    return this.getSession(id)!
  }

  updateSession(id: string, input: UpdateSessionInput): Session {
    const sets: string[] = []
    const params: Param[] = []

    if (input.endedAt !== undefined) { sets.push('ended_at = ?'); params.push(input.endedAt) }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status) }
    if (input.handoff !== undefined) {
      sets.push('handoff_json = ?')
      params.push(input.handoff === null ? null : JSON.stringify(input.handoff))
    }

    if (sets.length === 0) {
      const s = this.getSession(id)
      if (!s) throw new Error(`Session not found: ${id}`)
      return s
    }

    params.push(id)
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params as (string | number | null)[])
    const s = this.getSession(id)
    if (!s) throw new Error(`Session not found: ${id}`)
    return s
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.rowToSession(row) : null
  }

  findSessions(projectId: string, status?: SessionStatus): Session[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM sessions WHERE project_id = ? AND status = ? ORDER BY started_at DESC').all(projectId, status) as Array<Record<string, unknown>>
      : this.db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC').all(projectId) as Array<Record<string, unknown>>
    return rows.map(r => this.rowToSession(r))
  }

  getActiveSession(projectId: string): Session | null {
    const row = this.db.prepare(
      "SELECT * FROM sessions WHERE project_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"
    ).get(projectId) as Record<string, unknown> | undefined
    return row ? this.rowToSession(row) : null
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  // ── ContextSource CRUD ─────────────────────────────────────────────────────

  createContextSource(input: CreateContextSourceInput): ContextSource {
    const id = input.id || `CTXSRC-${Date.now()}`
    this.db.prepare(
      `INSERT INTO context_sources (id, project_id, source_type, source_path, label, category, priority, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.projectId, input.sourceType, input.sourcePath, input.label, input.category,
      input.priority ?? 100, input.isActive === false ? 0 : 1)
    return this.getContextSource(id)!
  }

  updateContextSource(id: string, input: UpdateContextSourceInput): ContextSource {
    const sets: string[] = []
    const params: Param[] = []

    if (input.sourceType !== undefined) { sets.push('source_type = ?'); params.push(input.sourceType) }
    if (input.sourcePath !== undefined) { sets.push('source_path = ?'); params.push(input.sourcePath) }
    if (input.label !== undefined) { sets.push('label = ?'); params.push(input.label) }
    if (input.category !== undefined) { sets.push('category = ?'); params.push(input.category) }
    if (input.priority !== undefined) { sets.push('priority = ?'); params.push(input.priority) }
    if (input.isActive !== undefined) { sets.push('is_active = ?'); params.push(input.isActive ? 1 : 0) }

    if (sets.length === 0) {
      const s = this.getContextSource(id)
      if (!s) throw new Error(`ContextSource not found: ${id}`)
      return s
    }

    params.push(id)
    this.db.prepare(`UPDATE context_sources SET ${sets.join(', ')} WHERE id = ?`).run(...params as (string | number | null)[])
    const s = this.getContextSource(id)
    if (!s) throw new Error(`ContextSource not found: ${id}`)
    return s
  }

  getContextSource(id: string): ContextSource | null {
    const row = this.db.prepare('SELECT * FROM context_sources WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.rowToContextSource(row) : null
  }

  findContextSources(projectId: string, activeOnly = false): ContextSource[] {
    const sql = activeOnly
      ? 'SELECT * FROM context_sources WHERE project_id = ? AND is_active = 1 ORDER BY priority, label'
      : 'SELECT * FROM context_sources WHERE project_id = ? ORDER BY priority, label'
    const rows = this.db.prepare(sql).all(projectId) as Array<Record<string, unknown>>
    return rows.map(r => this.rowToContextSource(r))
  }

  deleteContextSource(id: string): void {
    this.db.prepare('DELETE FROM context_sources WHERE id = ?').run(id)
  }

  // ── Conversation CRUD ──────────────────────────────────────────────────────

  createConversation(input: CreateConversationInput): Conversation {
    const id = input.id || `CONV-${Date.now()}`
    this.db.prepare(
      `INSERT INTO conversations (id, project_id, title, status, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, input.projectId, input.title, input.status || 'open', input.createdBy)

    if (input.participants) {
      for (const p of input.participants) {
        this.addConversationParticipant(id, p.name, p.type, p.role)
      }
    }

    return this.getConversation(id)!
  }

  updateConversation(id: string, input: UpdateConversationInput): Conversation {
    const sets: string[] = []
    const params: Param[] = []

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status) }
    if (input.decisionSummary !== undefined) { sets.push('decision_summary = ?'); params.push(input.decisionSummary) }
    if (input.decidedAt !== undefined) { sets.push('decided_at = ?'); params.push(input.decidedAt) }
    if (input.closedAt !== undefined) { sets.push('closed_at = ?'); params.push(input.closedAt) }

    if (sets.length === 0) {
      const c = this.getConversation(id)
      if (!c) throw new Error(`Conversation not found: ${id}`)
      return c
    }

    params.push(id)
    this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...params as (string | number | null)[])
    const c = this.getConversation(id)
    if (!c) throw new Error(`Conversation not found: ${id}`)
    return c
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.rowToConversation(row) : null
  }

  findConversations(projectId: string, status?: ConversationStatus): Conversation[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM conversations WHERE project_id = ? AND status = ? ORDER BY created_at DESC').all(projectId, status) as Array<Record<string, unknown>>
      : this.db.prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Array<Record<string, unknown>>
    return rows.map(r => this.rowToConversation(r))
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversation_actions WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversation_links WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  // ── Conversation participants ──────────────────────────────────────────────

  addConversationParticipant(
    conversationId: string,
    name: string,
    type: ConversationParticipantType,
    role?: string | null
  ): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO conversation_participants
       (conversation_id, participant_name, participant_type, participant_role)
       VALUES (?, ?, ?, ?)`
    ).run(conversationId, name, type, role ?? null)
  }

  removeConversationParticipant(conversationId: string, name: string): void {
    this.db.prepare(
      'DELETE FROM conversation_participants WHERE conversation_id = ? AND participant_name = ?'
    ).run(conversationId, name)
  }

  getConversationParticipants(conversationId: string): ConversationParticipant[] {
    const rows = this.db.prepare(
      'SELECT * FROM conversation_participants WHERE conversation_id = ? ORDER BY participant_name'
    ).all(conversationId) as Array<Record<string, unknown>>
    return rows.map(r => this.rowToConversationParticipant(r))
  }

  // ── Conversation messages ──────────────────────────────────────────────────

  addConversationMessage(input: CreateConversationMessageInput): ConversationMessage {
    const id = input.id || `MSG-${Date.now()}`
    this.db.prepare(
      `INSERT INTO conversation_messages
       (id, conversation_id, author_name, content, message_type, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.conversationId,
      input.authorName,
      input.content,
      input.messageType || 'comment',
      input.metadata ? JSON.stringify(input.metadata) : null
    )
    const row = this.db.prepare('SELECT * FROM conversation_messages WHERE id = ?').get(id) as Record<string, unknown>
    return this.rowToConversationMessage(row)
  }

  getConversationMessages(conversationId: string): ConversationMessage[] {
    const rows = this.db.prepare(
      'SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, id'
    ).all(conversationId) as Array<Record<string, unknown>>
    return rows.map(r => this.rowToConversationMessage(r))
  }

  // ── Conversation actions ───────────────────────────────────────────────────

  addConversationAction(input: CreateConversationActionInput): ConversationAction {
    const id = input.id || `ACT-${Date.now()}`
    this.db.prepare(
      `INSERT INTO conversation_actions
       (id, conversation_id, assignee, description, status, linked_task_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.conversationId,
      input.assignee,
      input.description,
      input.status || 'pending',
      input.linkedTaskId || null
    )
    const row = this.db.prepare('SELECT * FROM conversation_actions WHERE id = ?').get(id) as Record<string, unknown>
    return this.rowToConversationAction(row)
  }

  updateConversationAction(id: string, input: UpdateConversationActionInput): ConversationAction {
    const sets: string[] = []
    const params: Param[] = []

    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status) }
    if (input.linkedTaskId !== undefined) { sets.push('linked_task_id = ?'); params.push(input.linkedTaskId) }

    if (sets.length > 0) {
      params.push(id)
      this.db.prepare(`UPDATE conversation_actions SET ${sets.join(', ')} WHERE id = ?`)
        .run(...params as (string | number | null)[])
    }

    const row = this.db.prepare('SELECT * FROM conversation_actions WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) throw new Error(`ConversationAction not found: ${id}`)
    return this.rowToConversationAction(row)
  }

  getConversationActions(conversationId: string): ConversationAction[] {
    const rows = this.db.prepare(
      'SELECT * FROM conversation_actions WHERE conversation_id = ? ORDER BY created_at, id'
    ).all(conversationId) as Array<Record<string, unknown>>
    return rows.map(r => this.rowToConversationAction(r))
  }

  // ── Conversation links ─────────────────────────────────────────────────────

  linkConversation(conversationId: string, linkedType: ConversationLinkType, linkedId: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO conversation_links (conversation_id, linked_type, linked_id) VALUES (?, ?, ?)'
    ).run(conversationId, linkedType, linkedId)
  }

  unlinkConversation(conversationId: string, linkedType: ConversationLinkType, linkedId: string): void {
    this.db.prepare(
      'DELETE FROM conversation_links WHERE conversation_id = ? AND linked_type = ? AND linked_id = ?'
    ).run(conversationId, linkedType, linkedId)
  }

  getConversationLinks(conversationId: string): ConversationLink[] {
    const rows = this.db.prepare(
      'SELECT * FROM conversation_links WHERE conversation_id = ?'
    ).all(conversationId) as Array<{ conversation_id: string; linked_type: string; linked_id: string }>
    return rows.map(r => ({
      conversationId: r.conversation_id,
      linkedType: r.linked_type as ConversationLinkType,
      linkedId: r.linked_id
    }))
  }

  findConversationsByLink(linkedType: ConversationLinkType, linkedId: string): Conversation[] {
    const rows = this.db.prepare(
      `SELECT c.* FROM conversations c
       JOIN conversation_links l ON l.conversation_id = c.id
       WHERE l.linked_type = ? AND l.linked_id = ?
       ORDER BY c.created_at DESC`
    ).all(linkedType, linkedId) as Array<Record<string, unknown>>
    return rows.map(r => this.rowToConversation(r))
  }

  close(): void {
    this.db.close()
  }

  // ── Task CRUD ──────────────────────────────────────────────────────────────

  createTask(input: CreateTaskInput): Task {
    const ts = now()
    const id = input.id || `TASK-${Date.now()}`
    this.db.prepare(
      `INSERT INTO tasks (id, project_id, feature_id, parent_task_id, title, status, priority, labels, due_date, file_path, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(id, input.projectId, input.featureId || null, input.parentTaskId || null, input.title,
      input.status || 'TODO', input.priority || null,
      input.labels ? JSON.stringify(input.labels) : null,
      input.dueDate || null, input.filePath || null, ts, ts)
    return this.getTask(id)!
  }

  updateTask(id: string, input: UpdateTaskInput): Task {
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status) }
    if (input.priority !== undefined) { sets.push('priority = ?'); params.push(input.priority) }
    if (input.featureId !== undefined) { sets.push('feature_id = ?'); params.push(input.featureId) }
    if (input.parentTaskId !== undefined) { sets.push('parent_task_id = ?'); params.push(input.parentTaskId) }
    if (input.labels !== undefined) { sets.push('labels = ?'); params.push(JSON.stringify(input.labels)) }
    if (input.dueDate !== undefined) { sets.push('due_date = ?'); params.push(input.dueDate) }
    if (input.pinned !== undefined) { sets.push('pinned = ?'); params.push(input.pinned ? 1 : 0) }
    if (input.filePath !== undefined) { sets.push('file_path = ?'); params.push(input.filePath) }

    params.push(id)
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params as (string | number | null)[])
    const task = this.getTask(id)
    if (!task) throw new Error(`Task not found: ${id}`)
    return task
  }

  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM relationships WHERE from_id = ? OR to_id = ?').run(id, id)
    this.db.prepare('DELETE FROM tags WHERE item_id = ?').run(id)
    this.db.prepare('UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?').run(id)
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToTask(row) : null
  }

  findTasks(filter: TaskFilter): Task[] {
    const wheres: string[] = []
    const params: Param[] = []

    if (filter.projectId) { wheres.push('project_id = ?'); params.push(filter.projectId) }
    if (filter.status) { wheres.push('status = ?'); params.push(filter.status) }
    if (filter.priority) { wheres.push('priority = ?'); params.push(filter.priority) }
    if (filter.featureId) { wheres.push('feature_id = ?'); params.push(filter.featureId) }
    if (filter.parentTaskId) { wheres.push('parent_task_id = ?'); params.push(filter.parentTaskId) }
    if (filter.pinned) { wheres.push('pinned = 1') }
    if (filter.dueBefore) { wheres.push('due_date <= ?'); params.push(filter.dueBefore) }
    if (filter.query) { wheres.push('title LIKE ?'); params.push(`%${filter.query}%`) }

    const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
    const limit = filter.limit ? `LIMIT ${filter.limit}` : ''

    const rows = this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC ${limit}`).all(...params as (string | number | null)[]) as Array<Record<string, unknown>>
    return rows.map(rowToTask)
  }

  getSubtasks(parentId: string): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at').all(parentId) as Array<Record<string, unknown>>
    return rows.map(rowToTask)
  }

  // ── Dependencies (backed by relationships table) ────────────────────────

  addDependency(sourceId: string, targetId: string): void {
    this.addRelationship(sourceId, targetId, 'DEPENDS_ON')
  }

  removeDependency(sourceId: string, targetId: string): void {
    this.removeRelationship(sourceId, targetId, 'DEPENDS_ON')
  }

  getDependencies(taskId: string): TaskDependency[] {
    const rows = this.db.prepare(
      "SELECT from_id, to_id FROM relationships WHERE (from_id = ? OR to_id = ?) AND type = 'DEPENDS_ON'"
    ).all(taskId, taskId) as Array<{ from_id: string; to_id: string }>
    return rows.map(row => ({
      sourceId: row.from_id,
      targetId: row.to_id
    }))
  }

  // ── Daily focus ────────────────────────────────────────────────────────────

  getPinnedTasks(): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE pinned = 1 ORDER BY project_id, created_at').all() as Array<Record<string, unknown>>
    return rows.map(rowToTask)
  }

  getDueTasks(date: string): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE due_date <= ? AND status != 'DONE' ORDER BY due_date").all(date) as Array<Record<string, unknown>>
    return rows.map(rowToTask)
  }

  // ── Phase CRUD ─────────────────────────────────────────────────────────────

  createPhase(input: CreatePhaseInput): Phase {
    const ts = now()
    const id = input.id || `PHASE-${Date.now()}`
    this.db.prepare(
      'INSERT INTO phases (id, project_id, title, status, position, start_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.projectId, input.title, input.status || 'open', input.position || 0, input.startDate || null, ts, ts)
    return this.getPhase(id)!
  }

  updatePhase(id: string, input: UpdatePhaseInput): Phase {
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status) }
    if (input.position !== undefined) { sets.push('position = ?'); params.push(input.position) }
    if (input.startDate !== undefined) { sets.push('start_date = ?'); params.push(input.startDate) }
    if (input.completedDate !== undefined) { sets.push('completed_date = ?'); params.push(input.completedDate) }

    params.push(id)
    this.db.prepare(`UPDATE phases SET ${sets.join(', ')} WHERE id = ?`).run(...params as (string | number | null)[])
    const phase = this.getPhase(id)
    if (!phase) throw new Error(`Phase not found: ${id}`)
    return phase
  }

  deletePhase(id: string): void {
    this.db.prepare('UPDATE features SET phase_id = NULL WHERE phase_id = ?').run(id)
    this.db.prepare('DELETE FROM phases WHERE id = ?').run(id)
  }

  getPhase(id: string): Phase | null {
    const row = this.db.prepare('SELECT * FROM phases WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToPhase(row) : null
  }

  findPhases(projectId: string): Phase[] {
    const rows = this.db.prepare('SELECT * FROM phases WHERE project_id = ? ORDER BY position').all(projectId) as Array<Record<string, unknown>>
    return rows.map(rowToPhase)
  }

  getPhaseProgress(phaseId: string): DerivedProgress {
    const phase = this.getPhase(phaseId)
    const row = this.db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN t.status = 'DONE' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN t.status = 'IN-PROGRESS' THEN 1 ELSE 0 END) as ip
       FROM tasks t
       JOIN features f ON t.feature_id = f.id
       WHERE f.phase_id = ?`
    ).get(phaseId) as Record<string, number> | undefined
    const total = row?.total || 0
    const done = row?.done || 0
    const inProgress = row?.ip || 0
    const percent = total === 0 ? 0 : Math.round((done / total) * 100)

    // Status logic: startDate + tasks
    let status: 'planned' | 'active' | 'completed'
    if (total > 0 && done === total) {
      status = 'completed'
      // Auto-set completedDate if not set
      if (phase && !phase.completedDate) {
        this.updatePhase(phaseId, { completedDate: now().split('T')[0] })
      }
    } else if (phase?.startDate) {
      status = 'active'
      // Clear completedDate if was set but now not all done
      if (phase.completedDate) {
        this.updatePhase(phaseId, { completedDate: null })
      }
    } else {
      status = 'planned'
    }

    return { total, done, inProgress, status, percent }
  }

  // ── Feature CRUD ──────────────────────────────────────────────────────────

  createFeature(input: CreateFeatureInput): Feature {
    const ts = now()
    const id = input.id || `FEAT-${Date.now()}`
    this.db.prepare(
      'INSERT INTO features (id, project_id, phase_id, title, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.projectId, input.phaseId || null, input.title, input.priority || null, ts, ts)
    return this.getFeature(id)!
  }

  updateFeature(id: string, input: UpdateFeatureInput): Feature {
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
    if (input.phaseId !== undefined) { sets.push('phase_id = ?'); params.push(input.phaseId) }
    if (input.priority !== undefined) { sets.push('priority = ?'); params.push(input.priority) }

    params.push(id)
    this.db.prepare(`UPDATE features SET ${sets.join(', ')} WHERE id = ?`).run(...params as (string | number | null)[])
    const feature = this.getFeature(id)
    if (!feature) throw new Error(`Feature not found: ${id}`)
    return feature
  }

  deleteFeature(id: string): void {
    this.db.prepare('UPDATE tasks SET feature_id = NULL WHERE feature_id = ?').run(id)
    this.db.prepare('DELETE FROM features WHERE id = ?').run(id)
  }

  getFeature(id: string): Feature | null {
    const row = this.db.prepare('SELECT * FROM features WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToFeature(row) : null
  }

  findFeatures(projectId: string): Feature[] {
    const rows = this.db.prepare('SELECT * FROM features WHERE project_id = ? ORDER BY created_at').all(projectId) as Array<Record<string, unknown>>
    return rows.map(rowToFeature)
  }

  findFeaturesByPhase(phaseId: string): Feature[] {
    const rows = this.db.prepare('SELECT * FROM features WHERE phase_id = ? ORDER BY created_at').all(phaseId) as Array<Record<string, unknown>>
    return rows.map(rowToFeature)
  }

  getFeatureProgress(featureId: string): DerivedProgress {
    const row = this.db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN status = 'IN-PROGRESS' THEN 1 ELSE 0 END) as ip
       FROM tasks WHERE feature_id = ?`
    ).get(featureId) as Record<string, number> | undefined
    if (!row) return derivedProgress(0, 0, 0)
    return derivedProgress(row.total || 0, row.done || 0, row.ip || 0)
  }

  // ── Document CRUD ─────────────────────────────────────────────────────────

  createDocument(input: CreateDocumentInput): Document {
    const ts = now()
    const id = input.id || `DOC-${Date.now()}`
    this.db.prepare(
      'INSERT INTO documents (id, project_id, type, title, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.projectId, input.type, input.title, input.filePath || null, ts, ts)
    return this.getDocument(id)!
  }

  updateDocument(id: string, input: UpdateDocumentInput): Document {
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
    if (input.type !== undefined) { sets.push('type = ?'); params.push(input.type) }
    if (input.filePath !== undefined) { sets.push('file_path = ?'); params.push(input.filePath) }

    params.push(id)
    this.db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`).run(...params as (string | number | null)[])
    const doc = this.getDocument(id)
    if (!doc) throw new Error(`Document not found: ${id}`)
    return doc
  }

  deleteDocument(id: string): void {
    this.db.prepare('DELETE FROM tags WHERE item_id = ?').run(id)
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  }

  getDocument(id: string): Document | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToDocument(row) : null
  }

  findDocuments(projectId: string, type?: DocumentType): Document[] {
    if (type) {
      const rows = this.db.prepare('SELECT * FROM documents WHERE project_id = ? AND type = ? ORDER BY created_at').all(projectId, type) as Array<Record<string, unknown>>
      return rows.map(rowToDocument)
    }
    const rows = this.db.prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY type, created_at').all(projectId) as Array<Record<string, unknown>>
    return rows.map(rowToDocument)
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  addTag(itemId: string, tag: string): void {
    this.db.prepare('INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?, ?)').run(itemId, tag)
  }

  removeTag(itemId: string, tag: string): void {
    this.db.prepare('DELETE FROM tags WHERE item_id = ? AND tag = ?').run(itemId, tag)
  }

  getTags(itemId: string): string[] {
    const rows = this.db.prepare('SELECT tag FROM tags WHERE item_id = ? ORDER BY tag').all(itemId) as Array<{ tag: string }>
    return rows.map(row => row.tag)
  }

  findByTag(tag: string): string[] {
    const rows = this.db.prepare('SELECT item_id FROM tags WHERE tag = ? ORDER BY item_id').all(tag) as Array<{ item_id: string }>
    return rows.map(row => row.item_id)
  }

  // ── Relationships ─────────────────────────────────────────────────────────

  addRelationship(fromId: string, toId: string, type: RelationType): void {
    this.db.prepare('INSERT OR IGNORE INTO relationships (from_id, to_id, type) VALUES (?, ?, ?)').run(fromId, toId, type)
  }

  removeRelationship(fromId: string, toId: string, type: RelationType): void {
    this.db.prepare('DELETE FROM relationships WHERE from_id = ? AND to_id = ? AND type = ?').run(fromId, toId, type)
  }

  getRelationships(itemId: string): Relationship[] {
    const rows = this.db.prepare(
      'SELECT * FROM relationships WHERE from_id = ? OR to_id = ?'
    ).all(itemId, itemId) as Array<{ from_id: string; to_id: string; type: string }>
    return rows.map(row => ({
      fromId: row.from_id,
      toId: row.to_id,
      type: row.type as RelationType
    }))
  }

  getRelationshipsFrom(itemId: string, type?: RelationType): Relationship[] {
    if (type) {
      const rows = this.db.prepare(
        'SELECT * FROM relationships WHERE from_id = ? AND type = ?'
      ).all(itemId, type) as Array<{ from_id: string; to_id: string; type: string }>
      return rows.map(row => ({ fromId: row.from_id, toId: row.to_id, type: row.type as RelationType }))
    }
    const rows = this.db.prepare('SELECT * FROM relationships WHERE from_id = ?').all(itemId) as Array<{ from_id: string; to_id: string; type: string }>
    return rows.map(row => ({ fromId: row.from_id, toId: row.to_id, type: row.type as RelationType }))
  }

  // ── Project helpers ────────────────────────────────────────────────────────

  ensureProject(id: string, name: string, cwd: string): void {
    this.db.prepare('INSERT OR IGNORE INTO projects (id, name, cwd) VALUES (?, ?, ?)').run(id, name, cwd)
  }
}
