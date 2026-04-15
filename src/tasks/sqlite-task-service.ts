import Database from 'better-sqlite3'
import type { TaskService } from './task-service.interface'
import type {
  Task,
  Phase,
  Feature,
  Document,
  Relationship,
  TaskDependency,
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
