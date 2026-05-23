// ADR-030 — Postgres sibling of TaskRepository. Largest of the slice-3 repos
// because tasks own the blockedBy/dependency graph (via the relationships
// table) and the DONE-blocker guard logic.
//
// Schema differences vs SQLite:
//   - `labels` is JSONB (node-pg returns it pre-parsed; SQLite stored as TEXT)
//   - `pinned` is BOOLEAN
//   - `created_at` / `updated_at` are TIMESTAMPTZ — mapped to ISO string at
//     the repo boundary for shape parity
//   - `due_date` stays TEXT (caller-supplied strings round-trip unchanged)
//
// IN-list filters use `= ANY($n::text[])` instead of `IN (?, ?, ...)`-with-spread
// because pg parameter arrays are cleaner than dynamic placeholder generation.

import type { PgConnection, SqlValue, TxClient } from './connection'
import type {
  CreateTaskInput,
  Task,
  TaskBlocker,
  TaskDependency,
  TaskFilter,
  TaskPriority,
  TaskStatus,
  UpdateTaskInput
} from '../../task-types'
import { TaskBlockedError } from '../../task-types'
import type { PostgresCounterRepository } from './counter-repository.pg'
import type { PostgresRelationshipRepository } from './relationship-repository.pg'

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
  constructor(
    private readonly conn: PgConnection,
    private readonly relationships: PostgresRelationshipRepository,
    private readonly counters: PostgresCounterRepository
  ) {}

  private async nextTaskId(): Promise<string> {
    const n = await this.counters.nextNumber('task')
    return `TASK-${String(n).padStart(3, '0')}`
  }

  async create(input: CreateTaskInput): Promise<Task> {
    const now = new Date()
    const id = input.id || (await this.nextTaskId())
    const status = input.status || 'TODO'

    if (input.blockedBy && input.blockedBy.length > 0) {
      await this.validateBlockedBy(id, input.blockedBy)
    }

    if (status === 'DONE') {
      const blockers = await this.findBlockers(id, input.parentTaskId || null, input.blockedBy || [])
      if (blockers.length > 0) throw new TaskBlockedError(id, blockers)
    }

    await this.conn.query(
      `INSERT INTO tasks
         (id, project_id, parent_task_id, title, status, priority, labels, due_date, file_path, body, pinned, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, FALSE, $11, $11)`,
      [
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
        now
      ]
    )

    if (input.blockedBy && input.blockedBy.length > 0) {
      await this.replaceBlockedBy(id, input.blockedBy)
    }

    const created = await this.get(id)
    if (!created) throw new Error(`Task disappeared immediately after insert: ${id}`)
    return created
  }

  async update(id: string, input: UpdateTaskInput): Promise<Task> {
    const existing = await this.get(id)
    if (!existing) throw new Error(`Task not found: ${id}`)

    if (input.blockedBy !== undefined) {
      await this.validateBlockedBy(id, input.blockedBy)
    }

    if (input.status === 'DONE' && existing.status !== 'DONE') {
      const parentTaskId =
        input.parentTaskId !== undefined ? input.parentTaskId : existing.parentTaskId
      const blockedBy = input.blockedBy !== undefined ? input.blockedBy : existing.blockedBy
      const blockers = await this.findBlockers(id, parentTaskId, blockedBy)
      if (blockers.length > 0) throw new TaskBlockedError(id, blockers)
    }

    const sets: string[] = ['updated_at = $1']
    const params: SqlValue[] = [new Date()]
    let n = 2

    if (input.title !== undefined) {
      sets.push(`title = $${n++}`)
      params.push(input.title)
    }
    if (input.status !== undefined) {
      sets.push(`status = $${n++}`)
      params.push(input.status)
    }
    if (input.priority !== undefined) {
      sets.push(`priority = $${n++}`)
      params.push(input.priority)
    }
    if (input.parentTaskId !== undefined) {
      sets.push(`parent_task_id = $${n++}`)
      params.push(input.parentTaskId)
    }
    if (input.labels !== undefined) {
      sets.push(`labels = $${n++}::jsonb`)
      params.push(JSON.stringify(input.labels))
    }
    if (input.dueDate !== undefined) {
      sets.push(`due_date = $${n++}`)
      params.push(input.dueDate)
    }
    if (input.pinned !== undefined) {
      sets.push(`pinned = $${n++}`)
      params.push(input.pinned)
    }
    if (input.filePath !== undefined) {
      sets.push(`file_path = $${n++}`)
      params.push(input.filePath)
    }
    if (input.body !== undefined) {
      sets.push(`body = $${n++}`)
      params.push(input.body)
    }

    params.push(id)
    await this.conn.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${n}`, params)

    if (input.blockedBy !== undefined) {
      await this.replaceBlockedBy(id, input.blockedBy)
    }

    const updated = await this.get(id)
    if (!updated) throw new Error(`Task not found: ${id}`)
    return updated
  }

  async delete(id: string): Promise<void> {
    await this.conn.transaction(async (tx) => {
      await tx.query('DELETE FROM relationships WHERE from_id = $1 OR to_id = $1', [id])
      await tx.query('DELETE FROM tags WHERE item_id = $1', [id])
      await tx.query('UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = $1', [id])
      await tx.query('DELETE FROM tasks WHERE id = $1', [id])
    })
  }

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
        const blockers = await this.findBlockers(t.id, t.parentTaskId, t.blockedBy)
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

  async getPinned(): Promise<Task[]> {
    const result = await this.conn.query<TaskDbRow>(
      `SELECT ${SELECT_COLS} FROM tasks WHERE pinned = TRUE ORDER BY project_id, created_at`
    )
    const tasks: Task[] = []
    for (const row of result.rows) {
      tasks.push(mapRow(row, await this.getBlockedBy(row.id)))
    }
    return tasks
  }

  async getDue(date: string): Promise<Task[]> {
    const result = await this.conn.query<TaskDbRow>(
      `SELECT ${SELECT_COLS} FROM tasks
       WHERE due_date <= $1 AND status NOT IN ('DONE', 'CANCELLED')
       ORDER BY due_date`,
      [date]
    )
    const tasks: Task[] = []
    for (const row of result.rows) {
      tasks.push(mapRow(row, await this.getBlockedBy(row.id)))
    }
    return tasks
  }

  // ── blockedBy helpers ─────────────────────────────────────────────────────
  private async getBlockedBy(taskId: string): Promise<string[]> {
    const result = await this.conn.query<{ to_id: string }>(
      "SELECT to_id FROM relationships WHERE from_id = $1 AND type = 'DEPENDS_ON'",
      [taskId]
    )
    return result.rows.map((r) => r.to_id)
  }

  private async replaceBlockedBy(taskId: string, blockerIds: string[]): Promise<void> {
    await this.conn.transaction(async (tx: TxClient) => {
      await tx.query(
        "DELETE FROM relationships WHERE from_id = $1 AND type = 'DEPENDS_ON'",
        [taskId]
      )
      for (const blockerId of blockerIds) {
        await tx.query(
          `INSERT INTO relationships (from_id, to_id, type) VALUES ($1, $2, 'DEPENDS_ON')
           ON CONFLICT (from_id, to_id, type) DO NOTHING`,
          [taskId, blockerId]
        )
      }
    })
  }

  private async validateBlockedBy(taskId: string, blockerIds: string[]): Promise<void> {
    for (const blockerId of blockerIds) {
      if (blockerId === taskId) {
        throw new Error(`Task ${taskId} cannot be blocked by itself`)
      }
      const exists = await this.conn.query<{ id: string }>(
        'SELECT id FROM tasks WHERE id = $1',
        [blockerId]
      )
      if (exists.rows.length === 0) {
        throw new Error(`blockedBy references unknown task: ${blockerId}`)
      }

      const cycle = await this.conn.query(
        "SELECT 1 FROM relationships WHERE from_id = $1 AND to_id = $2 AND type = 'DEPENDS_ON'",
        [blockerId, taskId]
      )
      if (cycle.rows.length > 0) {
        throw new Error(
          `Cycle detected: ${blockerId} already depends on ${taskId} — cannot add reverse dependency`
        )
      }
    }
  }

  private async findBlockers(
    taskId: string,
    _parentTaskId: string | null,
    blockedBy: string[]
  ): Promise<TaskBlocker[]> {
    const blockers: TaskBlocker[] = []

    const subtasks = await this.conn.query<{ id: string; status: string; title: string }>(
      `SELECT id, status, title FROM tasks
       WHERE parent_task_id = $1 AND status NOT IN ('DONE', 'CANCELLED')`,
      [taskId]
    )
    for (const row of subtasks.rows) {
      blockers.push({ id: row.id, type: 'subtask', status: row.status as TaskStatus, title: row.title })
    }

    if (blockedBy.length > 0) {
      const deps = await this.conn.query<{ id: string; status: string; title: string }>(
        `SELECT id, status, title FROM tasks
         WHERE id = ANY($1::text[]) AND status NOT IN ('DONE', 'CANCELLED')`,
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

  // ── dependencies (relationships-backed) ───────────────────────────────────
  async addDependency(sourceId: string, targetId: string): Promise<void> {
    await this.relationships.add(sourceId, targetId, 'DEPENDS_ON')
  }

  async removeDependency(sourceId: string, targetId: string): Promise<void> {
    await this.relationships.remove(sourceId, targetId, 'DEPENDS_ON')
  }

  async getDependencies(taskId: string): Promise<TaskDependency[]> {
    const result = await this.conn.query<{ from_id: string; to_id: string }>(
      `SELECT from_id, to_id FROM relationships
       WHERE (from_id = $1 OR to_id = $1) AND type = 'DEPENDS_ON'`,
      [taskId]
    )
    return result.rows.map((r) => ({ sourceId: r.from_id, targetId: r.to_id }))
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
    // jsonb ?| text[] — true if any of the array's elements appears in the jsonb
    // string-array. Matches the OR-semantics of the SQLite `labels LIKE ?` chain.
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
