import type Database from 'better-sqlite3'
import type {
  Task,
  TaskStatus,
  TaskDependency,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilter
} from '../task-types'
import { now, type Param } from './shared'
import type { RelationshipRepository } from './relationship-repository'
import type { CounterRepository } from './counter-repository'

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    phaseId: (row.phase_id as string) || null,
    parentTaskId: (row.parent_task_id as string) || null,
    title: row.title as string,
    status: row.status as TaskStatus,
    priority: (row.priority as Task['priority']) || null,
    labels: row.labels ? JSON.parse(row.labels as string) : [],
    dueDate: (row.due_date as string) || null,
    pinned: row.pinned === 1,
    filePath: (row.file_path as string) || null,
    body: (row.body as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export class TaskRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly relationships: RelationshipRepository,
    private readonly counters: CounterRepository
  ) {}

  private nextTaskId(): string {
    return `TASK-${String(this.counters.nextNumber('task')).padStart(3, '0')}`
  }

  create(input: CreateTaskInput): Task {
    const ts = now()
    const id = input.id || this.nextTaskId()
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, phase_id, parent_task_id, title, status, priority, labels, due_date, file_path, body, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.phaseId || null,
        input.parentTaskId || null,
        input.title,
        input.status || 'TODO',
        input.priority || null,
        input.labels ? JSON.stringify(input.labels) : null,
        input.dueDate || null,
        input.filePath || null,
        input.body || null,
        ts,
        ts
      )
    return this.get(id)!
  }

  update(id: string, input: UpdateTaskInput): Task {
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.title !== undefined) {
      sets.push('title = ?')
      params.push(input.title)
    }
    if (input.status !== undefined) {
      sets.push('status = ?')
      params.push(input.status)
    }
    if (input.priority !== undefined) {
      sets.push('priority = ?')
      params.push(input.priority)
    }
    if (input.phaseId !== undefined) {
      sets.push('phase_id = ?')
      params.push(input.phaseId)
    }
    if (input.parentTaskId !== undefined) {
      sets.push('parent_task_id = ?')
      params.push(input.parentTaskId)
    }
    if (input.labels !== undefined) {
      sets.push('labels = ?')
      params.push(JSON.stringify(input.labels))
    }
    if (input.dueDate !== undefined) {
      sets.push('due_date = ?')
      params.push(input.dueDate)
    }
    if (input.pinned !== undefined) {
      sets.push('pinned = ?')
      params.push(input.pinned ? 1 : 0)
    }
    if (input.filePath !== undefined) {
      sets.push('file_path = ?')
      params.push(input.filePath)
    }
    if (input.body !== undefined) {
      sets.push('body = ?')
      params.push(input.body)
    }

    params.push(id)
    this.db
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
      .run(...(params as (string | number | null)[]))
    const task = this.get(id)
    if (!task) throw new Error(`Task not found: ${id}`)
    return task
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM relationships WHERE from_id = ? OR to_id = ?').run(id, id)
    this.db.prepare('DELETE FROM tags WHERE item_id = ?').run(id)
    this.db.prepare('UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?').run(id)
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  get(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToTask(row) : null
  }

  find(filter: TaskFilter): Task[] {
    const { sql, params } = buildTaskQuery(filter)
    const rows = this.db.prepare(sql).all(...(params as (string | number | null)[])) as Array<
      Record<string, unknown>
    >
    return rows.map(rowToTask)
  }

  getSubtasks(parentId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at')
      .all(parentId) as Array<Record<string, unknown>>
    return rows.map(rowToTask)
  }

  getPinned(): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE pinned = 1 ORDER BY project_id, created_at')
      .all() as Array<Record<string, unknown>>
    return rows.map(rowToTask)
  }

  getDue(date: string): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE due_date <= ? AND status NOT IN ('DONE', 'CANCELLED') ORDER BY due_date"
      )
      .all(date) as Array<Record<string, unknown>>
    return rows.map(rowToTask)
  }

  // Dependencies backed by the relationships table
  addDependency(sourceId: string, targetId: string): void {
    this.relationships.add(sourceId, targetId, 'DEPENDS_ON')
  }

  removeDependency(sourceId: string, targetId: string): void {
    this.relationships.remove(sourceId, targetId, 'DEPENDS_ON')
  }

  getDependencies(taskId: string): TaskDependency[] {
    const rows = this.db
      .prepare(
        "SELECT from_id, to_id FROM relationships WHERE (from_id = ? OR to_id = ?) AND type = 'DEPENDS_ON'"
      )
      .all(taskId, taskId) as Array<{ from_id: string; to_id: string }>
    return rows.map((row) => ({ sourceId: row.from_id, targetId: row.to_id }))
  }
}

function buildTaskQuery(filter: TaskFilter): { sql: string; params: Param[] } {
  const wheres: string[] = []
  const params: Param[] = []

  if (filter.projectId) {
    wheres.push('project_id = ?')
    params.push(filter.projectId)
  }
  if (filter.status) {
    wheres.push('status = ?')
    params.push(filter.status)
  }
  if (filter.priority) {
    wheres.push('priority = ?')
    params.push(filter.priority)
  }
  if (filter.phaseId) {
    wheres.push('phase_id = ?')
    params.push(filter.phaseId)
  }
  if (filter.parentTaskId) {
    wheres.push('parent_task_id = ?')
    params.push(filter.parentTaskId)
  }
  if (filter.pinned) {
    wheres.push('pinned = 1')
  }
  if (filter.dueBefore) {
    wheres.push('due_date <= ?')
    params.push(filter.dueBefore)
  }
  if (filter.query) {
    wheres.push('title LIKE ?')
    params.push(`%${filter.query}%`)
  }
  if (filter.labels && filter.labels.length > 0) {
    const ors = filter.labels.map(() => 'labels LIKE ?').join(' OR ')
    wheres.push(`(${ors})`)
    for (const label of filter.labels) {
      params.push(`%${JSON.stringify(label)}%`)
    }
  }

  const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
  const limit = filter.limit ? `LIMIT ${filter.limit}` : ''
  return { sql: `SELECT * FROM tasks ${where} ORDER BY created_at DESC ${limit}`, params }
}
