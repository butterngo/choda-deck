import type Database from 'better-sqlite3'
import type {
  Task,
  TaskStatus,
  TaskDependency,
  TaskBlocker,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilter
} from '../task-types'
import { TaskBlockedError } from '../task-types'
import { now, type Param } from './shared'
import type { RelationshipRepository } from './relationship-repository'
import type { CounterRepository } from './counter-repository'

function rowToTask(row: Record<string, unknown>, blockedBy: string[] = []): Task {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    parentTaskId: (row.parent_task_id as string) || null,
    title: row.title as string,
    status: row.status as TaskStatus,
    priority: (row.priority as Task['priority']) || null,
    labels: row.labels ? JSON.parse(row.labels as string) : [],
    dueDate: (row.due_date as string) || null,
    pinned: row.pinned === 1,
    filePath: (row.file_path as string) || null,
    body: (row.body as string) || null,
    blockedBy,
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
    const status = input.status || 'TODO'

    if (input.blockedBy && input.blockedBy.length > 0) {
      this.validateBlockedBy(id, input.blockedBy)
    }

    if (status === 'DONE') {
      const blockers = this.findBlockers(id, input.parentTaskId || null, input.blockedBy || [])
      if (blockers.length > 0) throw new TaskBlockedError(id, blockers)
    }

    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, parent_task_id, title, status, priority, labels, due_date, file_path, body, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.parentTaskId || null,
        input.title,
        status,
        input.priority || null,
        input.labels ? JSON.stringify(input.labels) : null,
        input.dueDate || null,
        input.filePath || null,
        input.body || null,
        ts,
        ts
      )

    if (input.blockedBy && input.blockedBy.length > 0) {
      this.replaceBlockedBy(id, input.blockedBy)
    }

    return this.get(id)!
  }

  update(id: string, input: UpdateTaskInput): Task {
    const existing = this.get(id)
    if (!existing) throw new Error(`Task not found: ${id}`)

    if (input.blockedBy !== undefined) {
      this.validateBlockedBy(id, input.blockedBy)
    }

    if (input.status === 'DONE' && existing.status !== 'DONE') {
      const parentTaskId =
        input.parentTaskId !== undefined ? input.parentTaskId : existing.parentTaskId
      const blockedBy = input.blockedBy !== undefined ? input.blockedBy : existing.blockedBy
      const blockers = this.findBlockers(id, parentTaskId, blockedBy)
      if (blockers.length > 0) throw new TaskBlockedError(id, blockers)
    }

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

    if (input.blockedBy !== undefined) {
      this.replaceBlockedBy(id, input.blockedBy)
    }

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
    return row ? rowToTask(row, this.getBlockedBy(id)) : null
  }

  find(filter: TaskFilter): Task[] {
    const { sql, params } = buildTaskQuery(filter)
    const rows = this.db.prepare(sql).all(...(params as (string | number | null)[])) as Array<
      Record<string, unknown>
    >
    let tasks = rows.map((r) => rowToTask(r, this.getBlockedBy(r.id as string)))
    if (filter.status === 'READY') {
      tasks = tasks.filter((t) => this.findBlockers(t.id, t.parentTaskId, t.blockedBy).length === 0)
    }
    return tasks
  }

  getSubtasks(parentId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at')
      .all(parentId) as Array<Record<string, unknown>>
    return rows.map((r) => rowToTask(r, this.getBlockedBy(r.id as string)))
  }

  getPinned(): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE pinned = 1 ORDER BY project_id, created_at')
      .all() as Array<Record<string, unknown>>
    return rows.map((r) => rowToTask(r, this.getBlockedBy(r.id as string)))
  }

  getDue(date: string): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE due_date <= ? AND status NOT IN ('DONE', 'CANCELLED') ORDER BY due_date"
      )
      .all(date) as Array<Record<string, unknown>>
    return rows.map((r) => rowToTask(r, this.getBlockedBy(r.id as string)))
  }

  // ── blockedBy helpers ────────────────────────────────────────────────────
  private getBlockedBy(taskId: string): string[] {
    const rows = this.db
      .prepare("SELECT to_id FROM relationships WHERE from_id = ? AND type = 'DEPENDS_ON'")
      .all(taskId) as Array<{ to_id: string }>
    return rows.map((r) => r.to_id)
  }

  private replaceBlockedBy(taskId: string, blockerIds: string[]): void {
    this.db
      .prepare("DELETE FROM relationships WHERE from_id = ? AND type = 'DEPENDS_ON'")
      .run(taskId)
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO relationships (from_id, to_id, type) VALUES (?, ?, 'DEPENDS_ON')"
    )
    for (const blockerId of blockerIds) insert.run(taskId, blockerId)
  }

  private validateBlockedBy(taskId: string, blockerIds: string[]): void {
    for (const blockerId of blockerIds) {
      if (blockerId === taskId) {
        throw new Error(`Task ${taskId} cannot be blocked by itself`)
      }
      const blocker = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(blockerId) as
        | { id: string }
        | undefined
      if (!blocker) throw new Error(`blockedBy references unknown task: ${blockerId}`)

      // Direct cycle: blocker already depends on this task
      const cycle = this.db
        .prepare(
          "SELECT 1 FROM relationships WHERE from_id = ? AND to_id = ? AND type = 'DEPENDS_ON'"
        )
        .get(blockerId, taskId)
      if (cycle) {
        throw new Error(
          `Cycle detected: ${blockerId} already depends on ${taskId} — cannot add reverse dependency`
        )
      }
    }
  }

  private findBlockers(
    taskId: string,
    _parentTaskId: string | null,
    blockedBy: string[]
  ): TaskBlocker[] {
    const blockers: TaskBlocker[] = []

    const subtaskRows = this.db
      .prepare(
        `SELECT id, status, title FROM tasks WHERE parent_task_id = ? AND status NOT IN ('DONE', 'CANCELLED')`
      )
      .all(taskId) as Array<{ id: string; status: TaskStatus; title: string }>
    for (const row of subtaskRows) {
      blockers.push({ id: row.id, type: 'subtask', status: row.status, title: row.title })
    }

    if (blockedBy.length > 0) {
      const placeholders = blockedBy.map(() => '?').join(',')
      const depRows = this.db
        .prepare(
          `SELECT id, status, title FROM tasks WHERE id IN (${placeholders}) AND status NOT IN ('DONE', 'CANCELLED')`
        )
        .all(...blockedBy) as Array<{ id: string; status: TaskStatus; title: string }>
      for (const row of depRows) {
        blockers.push({ id: row.id, type: 'dependency', status: row.status, title: row.title })
      }
    }

    return blockers
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
