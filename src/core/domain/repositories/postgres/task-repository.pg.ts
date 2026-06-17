// ADR-030 / 2026-05-28 narrowing — Postgres task repo, read-only.
//
// Kept: get, find, getSubtasks, getDependencies (the four reads exercised by
// task_list + task_context). Constructor no longer needs the relationships or
// counters dependencies — they were only used by create()/update()/dependency
// writes, all of which are gone. The blockedBy → relationships JOIN logic is
// inlined as raw SQL in getBlockedBy() since it's the only consumer left.
//
// READY filter still post-filters on findBlockers to hide blocked tasks from
// the remote `task_list status=READY` query — same semantics as SQLite.

import type { Queryable, SqlValue } from './connection'
import type {
  Task,
  TaskBlocker,
  TaskDependency,
  TaskFilter,
  TaskPriority,
  TaskStatus
} from '../../task-types'

interface TaskDbRow {
  id: string
  project_id: string
  parent_task_id: string | null
  title: string
  status: string
  priority: string | null
  labels: string[] | null
  due_date: string | null
  pinned: boolean
  file_path: string | null
  body: string | null
  created_at: Date
  updated_at: Date
}

function mapRow(row: TaskDbRow, blockedBy: string[]): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    status: row.status as TaskStatus,
    priority: (row.priority as TaskPriority | null) ?? null,
    labels: row.labels ?? [],
    dueDate: row.due_date,
    pinned: row.pinned,
    filePath: row.file_path,
    body: row.body,
    blockedBy,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  }
}

const SELECT_COLS =
  'id, project_id, parent_task_id, title, status, priority, labels, due_date, pinned, file_path, body, created_at, updated_at'

export class PostgresTaskRepository {
  constructor(private readonly conn: Queryable) {}

  async get(id: string): Promise<Task | null> {
    const result = await this.conn.query<TaskDbRow>(
      `SELECT ${SELECT_COLS} FROM tasks WHERE id = $1`,
      [id]
    )
    const row = result.rows[0]
    if (!row) return null
    return mapRow(row, await this.getBlockedBy(id))
  }

  async find(filter: TaskFilter): Promise<Task[]> {
    const { sql, params } = buildTaskQuery(filter)
    const result = await this.conn.query<TaskDbRow>(sql, params)
    let tasks: Task[] = []
    for (const row of result.rows) {
      const blockedBy = await this.getBlockedBy(row.id)
      tasks.push(mapRow(row, blockedBy))
    }
    if (filter.status === 'READY') {
      const filtered: Task[] = []
      for (const t of tasks) {
        const blockers = await this.findBlockers(t.id, t.blockedBy)
        if (blockers.length === 0) filtered.push(t)
      }
      tasks = filtered
    }
    return tasks
  }

  async getSubtasks(parentId: string): Promise<Task[]> {
    const result = await this.conn.query<TaskDbRow>(
      `SELECT ${SELECT_COLS} FROM tasks WHERE parent_task_id = $1 ORDER BY created_at ASC, id ASC`,
      [parentId]
    )
    const tasks: Task[] = []
    for (const row of result.rows) {
      tasks.push(mapRow(row, await this.getBlockedBy(row.id)))
    }
    return tasks
  }

  async getDependencies(taskId: string): Promise<TaskDependency[]> {
    const result = await this.conn.query<{ from_id: string; to_id: string }>(
      `SELECT from_id, to_id FROM relationships
       WHERE (from_id = $1 OR to_id = $1) AND type = 'DEPENDS_ON'`,
      [taskId]
    )
    return result.rows.map((r) => ({ sourceId: r.from_id, targetId: r.to_id }))
  }

  private async getBlockedBy(taskId: string): Promise<string[]> {
    const result = await this.conn.query<{ to_id: string }>(
      "SELECT to_id FROM relationships WHERE from_id = $1 AND type = 'DEPENDS_ON'",
      [taskId]
    )
    return result.rows.map((r) => r.to_id)
  }

  // READY filter helper — counts subtasks + blockedBy entries still in
  // non-terminal status. Mirrors the SQLite-side `findBlockers` minus the
  // parent guard (no remote tool reads task hierarchy that way).
  private async findBlockers(taskId: string, blockedBy: string[]): Promise<TaskBlocker[]> {
    const blockers: TaskBlocker[] = []

    const subtasks = await this.conn.query<{ id: string; status: string; title: string }>(
      `SELECT id, status, title FROM tasks
       WHERE parent_task_id = $1 AND status NOT IN ('IMPLEMENTED', 'DONE', 'CANCELLED')`,
      [taskId]
    )
    for (const row of subtasks.rows) {
      blockers.push({
        id: row.id,
        type: 'subtask',
        status: row.status as TaskStatus,
        title: row.title
      })
    }

    if (blockedBy.length > 0) {
      const deps = await this.conn.query<{ id: string; status: string; title: string }>(
        `SELECT id, status, title FROM tasks
         WHERE id = ANY($1::text[]) AND status NOT IN ('IMPLEMENTED', 'DONE', 'CANCELLED')`,
        [blockedBy as unknown as SqlValue]
      )
      for (const row of deps.rows) {
        blockers.push({
          id: row.id,
          type: 'dependency',
          status: row.status as TaskStatus,
          title: row.title
        })
      }
    }

    return blockers
  }
}

function buildTaskQuery(filter: TaskFilter): { sql: string; params: SqlValue[] } {
  const wheres: string[] = []
  const params: SqlValue[] = []
  let n = 1

  if (filter.projectId) {
    wheres.push(`project_id = $${n++}`)
    params.push(filter.projectId)
  }
  if (filter.status) {
    wheres.push(`status = $${n++}`)
    params.push(filter.status)
  }
  if (filter.priority) {
    wheres.push(`priority = $${n++}`)
    params.push(filter.priority)
  }
  if (filter.parentTaskId) {
    wheres.push(`parent_task_id = $${n++}`)
    params.push(filter.parentTaskId)
  }
  if (filter.pinned) {
    wheres.push('pinned = TRUE')
  }
  if (filter.dueBefore) {
    wheres.push(`due_date <= $${n++}`)
    params.push(filter.dueBefore)
  }
  if (filter.query) {
    wheres.push(`title LIKE $${n++}`)
    params.push(`%${filter.query}%`)
  }
  if (filter.labels && filter.labels.length > 0) {
    // jsonb ?| text[] — true if any array element appears in the jsonb string-array.
    wheres.push(`labels ?| $${n++}::text[]`)
    params.push(filter.labels as unknown as SqlValue)
  }

  const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
  const limit = filter.limit ? `LIMIT ${filter.limit}` : ''
  return {
    sql: `SELECT ${SELECT_COLS} FROM tasks ${where} ORDER BY created_at DESC, id DESC ${limit}`,
    params
  }
}
