import initSqlJs, { Database as SqlJsDatabase } from 'sql.js'
import * as fs from 'fs'
import type { TaskService } from './task-service.interface'
import type {
  Task,
  Epic,
  TaskDependency,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilter,
  CreateEpicInput,
  UpdateEpicInput,
  TaskStatus
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
    title: row.title as string,
    status: row.status as TaskStatus,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

function queryAll(db: SqlJsDatabase, sql: string, params: unknown[] = []): { columns: string[]; rows: unknown[][] } {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const columns: string[] = stmt.getColumnNames()
  const rows: unknown[][] = []
  while (stmt.step()) {
    rows.push(stmt.get())
  }
  stmt.free()
  return { columns, rows }
}

function queryOne(db: SqlJsDatabase, sql: string, params: unknown[] = []): { columns: string[]; row: unknown[] } | null {
  const result = queryAll(db, sql, params)
  if (result.rows.length === 0) return null
  return { columns: result.columns, row: result.rows[0] }
}

function run(db: SqlJsDatabase, sql: string, params: unknown[] = []): void {
  db.run(sql, params)
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
      CREATE TABLE IF NOT EXISTS epics (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'TODO',
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
      CREATE TABLE IF NOT EXISTS task_dependencies (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id)
      )
    `)
    db.run('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_id, status)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tasks_epic ON tasks(epic_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)')
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
    const params: unknown[] = [now()]

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
    run(db, 'DELETE FROM task_dependencies WHERE source_id = ? OR target_id = ?', [id, id])
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
    const params: unknown[] = []

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
      'INSERT INTO epics (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, input.projectId, input.title, input.status || 'TODO', ts, ts]
    )
    this.save()
    return this.getEpic(id)!
  }

  updateEpic(id: string, input: UpdateEpicInput): Epic {
    const db = this.getDb()
    const sets: string[] = ['updated_at = ?']
    const params: unknown[] = [now()]

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status) }

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

  getEpicProgress(epicId: string): { total: number; done: number } {
    const result = queryOne(this.getDb(),
      `SELECT COUNT(*) as total, SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done FROM tasks WHERE epic_id = ?`,
      [epicId]
    )
    if (!result) return { total: 0, done: 0 }
    return { total: (result.row[0] as number) || 0, done: (result.row[1] as number) || 0 }
  }

  // ── Dependencies ───────────────────────────────────────────────────────────

  addDependency(sourceId: string, targetId: string): void {
    run(this.getDb(), 'INSERT OR IGNORE INTO task_dependencies (source_id, target_id) VALUES (?, ?)', [sourceId, targetId])
    this.save()
  }

  removeDependency(sourceId: string, targetId: string): void {
    run(this.getDb(), 'DELETE FROM task_dependencies WHERE source_id = ? AND target_id = ?', [sourceId, targetId])
    this.save()
  }

  getDependencies(taskId: string): TaskDependency[] {
    const result = queryAll(this.getDb(),
      'SELECT * FROM task_dependencies WHERE source_id = ? OR target_id = ?',
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

  // ── Project helpers ────────────────────────────────────────────────────────

  ensureProject(id: string, name: string, cwd: string): void {
    run(this.getDb(), 'INSERT OR IGNORE INTO projects (id, name, cwd) VALUES (?, ?, ?)', [id, name, cwd])
    this.save()
  }
}
