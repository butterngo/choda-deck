import initSqlJs, { Database as SqlJsDatabase } from 'sql.js'
import * as fs from 'fs'
import type { TaskService } from './task-service.interface'
import type {
  Task,
  Epic,
  Phase,
  Feature,
  Document,
  Relationship,
  TaskDependency,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilter,
  CreateEpicInput,
  UpdateEpicInput,
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

function rowToTask(columns: string[], values: unknown[]): Task {
  const row: Record<string, unknown> = {}
  columns.forEach((col, i) => { row[col] = values[i] })
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    epicId: (row.epic_id as string) || null,
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

function rowToEpic(columns: string[], values: unknown[]): Epic {
  const row: Record<string, unknown> = {}
  columns.forEach((col, i) => { row[col] = values[i] })
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    featureId: (row.feature_id as string) || null,
    title: row.title as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

function rowToPhase(columns: string[], values: unknown[]): Phase {
  const row: Record<string, unknown> = {}
  columns.forEach((col, i) => { row[col] = values[i] })
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    status: row.status as PhaseStatus,
    position: (row.position as number) || 0,
    targetDate: (row.target_date as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

function rowToFeature(columns: string[], values: unknown[]): Feature {
  const row: Record<string, unknown> = {}
  columns.forEach((col, i) => { row[col] = values[i] })
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

function rowToDocument(columns: string[], values: unknown[]): Document {
  const row: Record<string, unknown> = {}
  columns.forEach((col, i) => { row[col] = values[i] })
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
    : 'active'
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return { total, done, inProgress, status, percent }
}

type Param = string | number | null | undefined | boolean

function queryAll(db: SqlJsDatabase, sql: string, params: Param[] = []): { columns: string[]; rows: unknown[][] } {
  const stmt = db.prepare(sql)
  stmt.bind(params as (string | number | null | Uint8Array)[])
  const columns: string[] = stmt.getColumnNames()
  const rows: unknown[][] = []
  while (stmt.step()) {
    rows.push(stmt.get())
  }
  stmt.free()
  return { columns, rows }
}

function queryOne(db: SqlJsDatabase, sql: string, params: Param[] = []): { columns: string[]; row: unknown[] } | null {
  const result = queryAll(db, sql, params)
  if (result.rows.length === 0) return null
  return { columns: result.columns, row: result.rows[0] }
}

function run(db: SqlJsDatabase, sql: string, params: Param[] = []): void {
  db.run(sql, params as (string | number | null | Uint8Array)[])
}

export class SqliteTaskService implements TaskService {
  private db: SqlJsDatabase | null = null
  private dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  async initializeAsync(): Promise<void> {
    const SQL = await initSqlJs()
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath)
      this.db = new SQL.Database(buffer)
    } else {
      this.db = new SQL.Database()
    }
    this.createTables()
  }

  initialize(): void {
    // Sync fallback — caller must ensure initializeAsync was called first
    if (!this.db) throw new Error('Call initializeAsync() first')
  }

  private createTables(): void {
    const db = this.getDb()
    db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL
      )
    `)
    db.run(`
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
    db.run(`
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
    db.run(`
      CREATE TABLE IF NOT EXISTS epics (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        feature_id TEXT,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        epic_id TEXT,
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
    db.run(`
      CREATE TABLE IF NOT EXISTS tags (
        item_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (item_id, tag)
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS relationships (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, type)
      )
    `)
    db.run(`
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

    // Migrate: add feature_id to epics if missing
    try {
      db.run('ALTER TABLE epics ADD COLUMN feature_id TEXT')
    } catch { /* column already exists */ }

    // Migrate: move task_dependencies into relationships table
    try {
      const stmt = db.prepare('SELECT source_id, target_id FROM task_dependencies')
      while (stmt.step()) {
        const row = stmt.get()
        run(db, 'INSERT OR IGNORE INTO relationships (from_id, to_id, type) VALUES (?, ?, ?)',
          [row[0] as string, row[1] as string, 'DEPENDS_ON'])
      }
      stmt.free()
      db.run('DROP TABLE IF EXISTS task_dependencies')
    } catch { /* table may not exist */ }

    db.run('CREATE INDEX IF NOT EXISTS idx_phases_project ON phases(project_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_features_phase ON features(phase_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_epics_feature ON epics(feature_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_id, status)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tasks_epic ON tasks(epic_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tags_item ON tags(item_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id)')
  }

  private getDb(): SqlJsDatabase {
    if (!this.db) throw new Error('Database not initialized')
    return this.db
  }

  private save(): void {
    const data = this.getDb().export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(this.dbPath, buffer)
  }

  close(): void {
    if (this.db) {
      this.save()
      this.db.close()
      this.db = null
    }
  }

  // ── Task CRUD ──────────────────────────────────────────────────────────────

  createTask(input: CreateTaskInput): Task {
    const db = this.getDb()
    const ts = now()
    const id = input.id || `TASK-${Date.now()}`
    run(db,
      `INSERT INTO tasks (id, project_id, epic_id, parent_task_id, title, status, priority, labels, due_date, file_path, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [id, input.projectId, input.epicId || null, input.parentTaskId || null, input.title,
       input.status || 'TODO', input.priority || null,
       input.labels ? JSON.stringify(input.labels) : null,
       input.dueDate || null, input.filePath || null, ts, ts]
    )
    this.save()
    return this.getTask(id)!
  }

  updateTask(id: string, input: UpdateTaskInput): Task {
    const db = this.getDb()
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status) }
    if (input.priority !== undefined) { sets.push('priority = ?'); params.push(input.priority) }
    if (input.epicId !== undefined) { sets.push('epic_id = ?'); params.push(input.epicId) }
    if (input.parentTaskId !== undefined) { sets.push('parent_task_id = ?'); params.push(input.parentTaskId) }
    if (input.labels !== undefined) { sets.push('labels = ?'); params.push(JSON.stringify(input.labels)) }
    if (input.dueDate !== undefined) { sets.push('due_date = ?'); params.push(input.dueDate) }
    if (input.pinned !== undefined) { sets.push('pinned = ?'); params.push(input.pinned ? 1 : 0) }

    params.push(id)
    run(db, `UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params)
    this.save()
    const task = this.getTask(id)
    if (!task) throw new Error(`Task not found: ${id}`)
    return task
  }

  deleteTask(id: string): void {
    const db = this.getDb()
    run(db, 'DELETE FROM relationships WHERE from_id = ? OR to_id = ?', [id, id])
    run(db, 'DELETE FROM tags WHERE item_id = ?', [id])
    run(db, 'UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?', [id])
    run(db, 'DELETE FROM tasks WHERE id = ?', [id])
    this.save()
  }

  getTask(id: string): Task | null {
    const result = queryOne(this.getDb(), 'SELECT * FROM tasks WHERE id = ?', [id])
    return result ? rowToTask(result.columns, result.row) : null
  }

  findTasks(filter: TaskFilter): Task[] {
    const wheres: string[] = []
    const params: Param[] = []

    if (filter.projectId) { wheres.push('project_id = ?'); params.push(filter.projectId) }
    if (filter.status) { wheres.push('status = ?'); params.push(filter.status) }
    if (filter.priority) { wheres.push('priority = ?'); params.push(filter.priority) }
    if (filter.epicId) { wheres.push('epic_id = ?'); params.push(filter.epicId) }
    if (filter.parentTaskId) { wheres.push('parent_task_id = ?'); params.push(filter.parentTaskId) }
    if (filter.pinned) { wheres.push('pinned = 1') }
    if (filter.dueBefore) { wheres.push('due_date <= ?'); params.push(filter.dueBefore) }
    if (filter.query) { wheres.push('title LIKE ?'); params.push(`%${filter.query}%`) }

    const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
    const limit = filter.limit ? `LIMIT ${filter.limit}` : ''

    const result = queryAll(this.getDb(), `SELECT * FROM tasks ${where} ORDER BY created_at DESC ${limit}`, params)
    return result.rows.map(row => rowToTask(result.columns, row))
  }

  getSubtasks(parentId: string): Task[] {
    const result = queryAll(this.getDb(), 'SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at', [parentId])
    return result.rows.map(row => rowToTask(result.columns, row))
  }

  // ── Epic CRUD ──────────────────────────────────────────────────────────────

  createEpic(input: CreateEpicInput): Epic {
    const db = this.getDb()
    const ts = now()
    const id = input.id || `EPIC-${Date.now()}`
    run(db,
      'INSERT INTO epics (id, project_id, feature_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, input.projectId, input.featureId || null, input.title, ts, ts]
    )
    this.save()
    return this.getEpic(id)!
  }

  updateEpic(id: string, input: UpdateEpicInput): Epic {
    const db = this.getDb()
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
    if (input.featureId !== undefined) { sets.push('feature_id = ?'); params.push(input.featureId) }

    params.push(id)
    run(db, `UPDATE epics SET ${sets.join(', ')} WHERE id = ?`, params)
    this.save()
    const epic = this.getEpic(id)
    if (!epic) throw new Error(`Epic not found: ${id}`)
    return epic
  }

  deleteEpic(id: string): void {
    const db = this.getDb()
    run(db, 'UPDATE tasks SET epic_id = NULL WHERE epic_id = ?', [id])
    run(db, 'DELETE FROM epics WHERE id = ?', [id])
    this.save()
  }

  getEpic(id: string): Epic | null {
    const result = queryOne(this.getDb(), 'SELECT * FROM epics WHERE id = ?', [id])
    return result ? rowToEpic(result.columns, result.row) : null
  }

  findEpics(projectId: string): Epic[] {
    const result = queryAll(this.getDb(), 'SELECT * FROM epics WHERE project_id = ? ORDER BY created_at', [projectId])
    return result.rows.map(row => rowToEpic(result.columns, row))
  }

  getEpicProgress(epicId: string): DerivedProgress {
    const result = queryOne(this.getDb(),
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN status = 'IN-PROGRESS' THEN 1 ELSE 0 END) as ip
       FROM tasks WHERE epic_id = ?`,
      [epicId]
    )
    if (!result) return derivedProgress(0, 0, 0)
    return derivedProgress(
      (result.row[0] as number) || 0,
      (result.row[1] as number) || 0,
      (result.row[2] as number) || 0
    )
  }

  // ── Dependencies (legacy compat — backed by relationships table) ────────

  addDependency(sourceId: string, targetId: string): void {
    this.addRelationship(sourceId, targetId, 'DEPENDS_ON')
  }

  removeDependency(sourceId: string, targetId: string): void {
    this.removeRelationship(sourceId, targetId, 'DEPENDS_ON')
  }

  getDependencies(taskId: string): TaskDependency[] {
    const result = queryAll(this.getDb(),
      "SELECT from_id, to_id FROM relationships WHERE (from_id = ? OR to_id = ?) AND type = 'DEPENDS_ON'",
      [taskId, taskId]
    )
    return result.rows.map(row => ({
      sourceId: row[0] as string,
      targetId: row[1] as string
    }))
  }

  // ── Daily focus ────────────────────────────────────────────────────────────

  getPinnedTasks(): Task[] {
    const result = queryAll(this.getDb(), 'SELECT * FROM tasks WHERE pinned = 1 ORDER BY project_id, created_at')
    return result.rows.map(row => rowToTask(result.columns, row))
  }

  getDueTasks(date: string): Task[] {
    const result = queryAll(this.getDb(), "SELECT * FROM tasks WHERE due_date <= ? AND status != 'DONE' ORDER BY due_date", [date])
    return result.rows.map(row => rowToTask(result.columns, row))
  }

  // ── Phase CRUD ─────────────────────────────────────────────────────────────

  createPhase(input: CreatePhaseInput): Phase {
    const db = this.getDb()
    const ts = now()
    const id = input.id || `PHASE-${Date.now()}`
    run(db,
      'INSERT INTO phases (id, project_id, title, status, position, target_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, input.projectId, input.title, input.status || 'open', input.position || 0, input.targetDate || null, ts, ts]
    )
    this.save()
    return this.getPhase(id)!
  }

  updatePhase(id: string, input: UpdatePhaseInput): Phase {
    const db = this.getDb()
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status) }
    if (input.position !== undefined) { sets.push('position = ?'); params.push(input.position) }
    if (input.targetDate !== undefined) { sets.push('target_date = ?'); params.push(input.targetDate) }

    params.push(id)
    run(db, `UPDATE phases SET ${sets.join(', ')} WHERE id = ?`, params)
    this.save()
    const phase = this.getPhase(id)
    if (!phase) throw new Error(`Phase not found: ${id}`)
    return phase
  }

  deletePhase(id: string): void {
    const db = this.getDb()
    run(db, 'UPDATE features SET phase_id = NULL WHERE phase_id = ?', [id])
    run(db, 'DELETE FROM phases WHERE id = ?', [id])
    this.save()
  }

  getPhase(id: string): Phase | null {
    const result = queryOne(this.getDb(), 'SELECT * FROM phases WHERE id = ?', [id])
    return result ? rowToPhase(result.columns, result.row) : null
  }

  findPhases(projectId: string): Phase[] {
    const result = queryAll(this.getDb(), 'SELECT * FROM phases WHERE project_id = ? ORDER BY position', [projectId])
    return result.rows.map(row => rowToPhase(result.columns, row))
  }

  getPhaseProgress(phaseId: string): DerivedProgress {
    const result = queryOne(this.getDb(),
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN t.status = 'DONE' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN t.status = 'IN-PROGRESS' THEN 1 ELSE 0 END) as ip
       FROM tasks t
       JOIN epics e ON t.epic_id = e.id
       JOIN features f ON e.feature_id = f.id
       WHERE f.phase_id = ?`,
      [phaseId]
    )
    if (!result) return derivedProgress(0, 0, 0)
    return derivedProgress(
      (result.row[0] as number) || 0,
      (result.row[1] as number) || 0,
      (result.row[2] as number) || 0
    )
  }

  // ── Feature CRUD ──────────────────────────────────────────────────────────

  createFeature(input: CreateFeatureInput): Feature {
    const db = this.getDb()
    const ts = now()
    const id = input.id || `FEAT-${Date.now()}`
    run(db,
      'INSERT INTO features (id, project_id, phase_id, title, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, input.projectId, input.phaseId || null, input.title, input.priority || null, ts, ts]
    )
    this.save()
    return this.getFeature(id)!
  }

  updateFeature(id: string, input: UpdateFeatureInput): Feature {
    const db = this.getDb()
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
    if (input.phaseId !== undefined) { sets.push('phase_id = ?'); params.push(input.phaseId) }
    if (input.priority !== undefined) { sets.push('priority = ?'); params.push(input.priority) }

    params.push(id)
    run(db, `UPDATE features SET ${sets.join(', ')} WHERE id = ?`, params)
    this.save()
    const feature = this.getFeature(id)
    if (!feature) throw new Error(`Feature not found: ${id}`)
    return feature
  }

  deleteFeature(id: string): void {
    const db = this.getDb()
    run(db, 'UPDATE epics SET feature_id = NULL WHERE feature_id = ?', [id])
    run(db, 'DELETE FROM features WHERE id = ?', [id])
    this.save()
  }

  getFeature(id: string): Feature | null {
    const result = queryOne(this.getDb(), 'SELECT * FROM features WHERE id = ?', [id])
    return result ? rowToFeature(result.columns, result.row) : null
  }

  findFeatures(projectId: string): Feature[] {
    const result = queryAll(this.getDb(), 'SELECT * FROM features WHERE project_id = ? ORDER BY created_at', [projectId])
    return result.rows.map(row => rowToFeature(result.columns, row))
  }

  findFeaturesByPhase(phaseId: string): Feature[] {
    const result = queryAll(this.getDb(), 'SELECT * FROM features WHERE phase_id = ? ORDER BY created_at', [phaseId])
    return result.rows.map(row => rowToFeature(result.columns, row))
  }

  getFeatureProgress(featureId: string): DerivedProgress {
    const result = queryOne(this.getDb(),
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN t.status = 'DONE' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN t.status = 'IN-PROGRESS' THEN 1 ELSE 0 END) as ip
       FROM tasks t
       JOIN epics e ON t.epic_id = e.id
       WHERE e.feature_id = ?`,
      [featureId]
    )
    if (!result) return derivedProgress(0, 0, 0)
    return derivedProgress(
      (result.row[0] as number) || 0,
      (result.row[1] as number) || 0,
      (result.row[2] as number) || 0
    )
  }

  // ── Document CRUD ─────────────────────────────────────────────────────────

  createDocument(input: CreateDocumentInput): Document {
    const db = this.getDb()
    const ts = now()
    const id = input.id || `DOC-${Date.now()}`
    run(db,
      'INSERT INTO documents (id, project_id, type, title, file_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, input.projectId, input.type, input.title, input.filePath || null, ts, ts]
    )
    this.save()
    return this.getDocument(id)!
  }

  updateDocument(id: string, input: UpdateDocumentInput): Document {
    const db = this.getDb()
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
    if (input.type !== undefined) { sets.push('type = ?'); params.push(input.type) }
    if (input.filePath !== undefined) { sets.push('file_path = ?'); params.push(input.filePath) }

    params.push(id)
    run(db, `UPDATE documents SET ${sets.join(', ')} WHERE id = ?`, params)
    this.save()
    const doc = this.getDocument(id)
    if (!doc) throw new Error(`Document not found: ${id}`)
    return doc
  }

  deleteDocument(id: string): void {
    const db = this.getDb()
    run(db, 'DELETE FROM tags WHERE item_id = ?', [id])
    run(db, 'DELETE FROM documents WHERE id = ?', [id])
    this.save()
  }

  getDocument(id: string): Document | null {
    const result = queryOne(this.getDb(), 'SELECT * FROM documents WHERE id = ?', [id])
    return result ? rowToDocument(result.columns, result.row) : null
  }

  findDocuments(projectId: string, type?: DocumentType): Document[] {
    if (type) {
      const result = queryAll(this.getDb(), 'SELECT * FROM documents WHERE project_id = ? AND type = ? ORDER BY created_at', [projectId, type])
      return result.rows.map(row => rowToDocument(result.columns, row))
    }
    const result = queryAll(this.getDb(), 'SELECT * FROM documents WHERE project_id = ? ORDER BY type, created_at', [projectId])
    return result.rows.map(row => rowToDocument(result.columns, row))
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  addTag(itemId: string, tag: string): void {
    run(this.getDb(), 'INSERT OR IGNORE INTO tags (item_id, tag) VALUES (?, ?)', [itemId, tag])
    this.save()
  }

  removeTag(itemId: string, tag: string): void {
    run(this.getDb(), 'DELETE FROM tags WHERE item_id = ? AND tag = ?', [itemId, tag])
    this.save()
  }

  getTags(itemId: string): string[] {
    const result = queryAll(this.getDb(), 'SELECT tag FROM tags WHERE item_id = ? ORDER BY tag', [itemId])
    return result.rows.map(row => row[0] as string)
  }

  findByTag(tag: string): string[] {
    const result = queryAll(this.getDb(), 'SELECT item_id FROM tags WHERE tag = ? ORDER BY item_id', [tag])
    return result.rows.map(row => row[0] as string)
  }

  // ── Relationships ─────────────────────────────────────────────────────────

  addRelationship(fromId: string, toId: string, type: RelationType): void {
    run(this.getDb(), 'INSERT OR IGNORE INTO relationships (from_id, to_id, type) VALUES (?, ?, ?)', [fromId, toId, type])
    this.save()
  }

  removeRelationship(fromId: string, toId: string, type: RelationType): void {
    run(this.getDb(), 'DELETE FROM relationships WHERE from_id = ? AND to_id = ? AND type = ?', [fromId, toId, type])
    this.save()
  }

  getRelationships(itemId: string): Relationship[] {
    const result = queryAll(this.getDb(),
      'SELECT * FROM relationships WHERE from_id = ? OR to_id = ?',
      [itemId, itemId]
    )
    return result.rows.map(row => ({
      fromId: row[0] as string,
      toId: row[1] as string,
      type: row[2] as RelationType
    }))
  }

  getRelationshipsFrom(itemId: string, type?: RelationType): Relationship[] {
    if (type) {
      const result = queryAll(this.getDb(),
        'SELECT * FROM relationships WHERE from_id = ? AND type = ?', [itemId, type])
      return result.rows.map(row => ({ fromId: row[0] as string, toId: row[1] as string, type: row[2] as RelationType }))
    }
    const result = queryAll(this.getDb(), 'SELECT * FROM relationships WHERE from_id = ?', [itemId])
    return result.rows.map(row => ({ fromId: row[0] as string, toId: row[1] as string, type: row[2] as RelationType }))
  }

  // ── Project helpers ────────────────────────────────────────────────────────

  ensureProject(id: string, name: string, cwd: string): void {
    run(this.getDb(), 'INSERT OR IGNORE INTO projects (id, name, cwd) VALUES (?, ?, ?)', [id, name, cwd])
    this.save()
  }
}
