import Database from 'better-sqlite3'
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

function rowToTask(row: Record<string, unknown>): Task {
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

function rowToEpic(row: Record<string, unknown>): Epic {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    status: row.status as TaskStatus,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export class SqliteTaskService implements TaskService {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS epics (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'TODO',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        epic_id TEXT REFERENCES epics(id),
        parent_task_id TEXT REFERENCES tasks(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'TODO',
        priority TEXT,
        labels TEXT,
        due_date TEXT,
        pinned INTEGER DEFAULT 0,
        file_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_dependencies (
        source_id TEXT NOT NULL REFERENCES tasks(id),
        target_id TEXT NOT NULL REFERENCES tasks(id),
        PRIMARY KEY (source_id, target_id)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_epic ON tasks(epic_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
    `)
  }

  close(): void {
    this.db.close()
  }

  // ── Task CRUD ──────────────────────────────────────────────────────────────

  createTask(input: CreateTaskInput): Task {
    const ts = now()
    const id = input.id || `TASK-${Date.now()}`
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, project_id, epic_id, parent_task_id, title, status, priority, labels, due_date, file_path, pinned, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `)
    stmt.run(
      id,
      input.projectId,
      input.epicId || null,
      input.parentTaskId || null,
      input.title,
      input.status || 'TODO',
      input.priority || null,
      input.labels ? JSON.stringify(input.labels) : null,
      input.dueDate || null,
      input.filePath || null,
      ts,
      ts
    )
    return this.getTask(id)!
  }

  updateTask(id: string, input: UpdateTaskInput): Task {
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
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    const task = this.getTask(id)
    if (!task) throw new Error(`Task not found: ${id}`)
    return task
  }

  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM task_dependencies WHERE source_id = ? OR target_id = ?').run(id, id)
    this.db.prepare('UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?').run(id)
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToTask(row) : null
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
    const limit = filter.limit ? `LIMIT ?` : ''
    if (filter.limit) params.push(filter.limit)

    const rows = this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC ${limit}`).all(...params) as Record<string, unknown>[]
    return rows.map(rowToTask)
  }

  getSubtasks(parentId: string): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at').all(parentId) as Record<string, unknown>[]
    return rows.map(rowToTask)
  }

  // ── Epic CRUD ──────────────────────────────────────────────────────────────

  createEpic(input: CreateEpicInput): Epic {
    const ts = now()
    const id = input.id || `EPIC-${Date.now()}`
    this.db.prepare(`
      INSERT INTO epics (id, project_id, title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.projectId, input.title, input.status || 'TODO', ts, ts)
    return this.getEpic(id)!
  }

  updateEpic(id: string, input: UpdateEpicInput): Epic {
    const sets: string[] = ['updated_at = ?']
    const params: unknown[] = [now()]

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title) }
    if (input.status !== undefined) { sets.push('status = ?'); params.push(input.status) }

    params.push(id)
    this.db.prepare(`UPDATE epics SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    const epic = this.getEpic(id)
    if (!epic) throw new Error(`Epic not found: ${id}`)
    return epic
  }

  deleteEpic(id: string): void {
    this.db.prepare('UPDATE tasks SET epic_id = NULL WHERE epic_id = ?').run(id)
    this.db.prepare('DELETE FROM epics WHERE id = ?').run(id)
  }

  getEpic(id: string): Epic | null {
    const row = this.db.prepare('SELECT * FROM epics WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToEpic(row) : null
  }

  findEpics(projectId: string): Epic[] {
    const rows = this.db.prepare('SELECT * FROM epics WHERE project_id = ? ORDER BY created_at').all(projectId) as Record<string, unknown>[]
    return rows.map(rowToEpic)
  }

  getEpicProgress(epicId: string): { total: number; done: number } {
    const row = this.db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) as done
      FROM tasks WHERE epic_id = ?
    `).get(epicId) as { total: number; done: number }
    return { total: row.total, done: row.done || 0 }
  }

  // ── Dependencies ───────────────────────────────────────────────────────────

  addDependency(sourceId: string, targetId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO task_dependencies (source_id, target_id) VALUES (?, ?)').run(sourceId, targetId)
  }

  removeDependency(sourceId: string, targetId: string): void {
    this.db.prepare('DELETE FROM task_dependencies WHERE source_id = ? AND target_id = ?').run(sourceId, targetId)
  }

  getDependencies(taskId: string): TaskDependency[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_dependencies WHERE source_id = ? OR target_id = ?'
    ).all(taskId, taskId) as Record<string, unknown>[]
    return rows.map(r => ({ sourceId: r.source_id as string, targetId: r.target_id as string }))
  }

  // ── Daily focus ────────────────────────────────────────────────────────────

  getPinnedTasks(): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE pinned = 1 ORDER BY project_id, created_at').all() as Record<string, unknown>[]
    return rows.map(rowToTask)
  }

  getDueTasks(date: string): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE due_date <= ? AND status != ? ORDER BY due_date').all(date, 'DONE') as Record<string, unknown>[]
    return rows.map(rowToTask)
  }

  // ── Project helpers ────────────────────────────────────────────────────────

  ensureProject(id: string, name: string, cwd: string): void {
    this.db.prepare('INSERT OR IGNORE INTO projects (id, name, cwd) VALUES (?, ?, ?)').run(id, name, cwd)
  }
}
