// ADR-030 — Postgres sibling of InboxRepository. Status stays TEXT (no CHECK;
// matches SQLite — typed at TS boundary). project_id is nullable for unscoped
// scratch items. id-mint uses the shared counter (slice-1 PG counter repo).

import type { PgConnection, SqlValue } from './connection'
import type {
  CreateInboxInput,
  InboxFilter,
  InboxItem,
  InboxStatus,
  UpdateInboxInput
} from '../../task-types'
import { now } from '../shared'
import type { PostgresCounterRepository } from './counter-repository.pg'

interface InboxDbRow {
  id: string
  project_id: string | null
  content: string
  status: string
  linked_task_id: string | null
  created_at: string
  updated_at: string
}

function mapRow(row: InboxDbRow): InboxItem {
  return {
    id: row.id,
    projectId: row.project_id,
    content: row.content,
    status: row.status as InboxStatus,
    linkedTaskId: row.linked_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

const SELECT_COLS =
  'id, project_id, content, status, linked_task_id, created_at, updated_at'

export class PostgresInboxRepository {
  constructor(
    private readonly conn: PgConnection,
    private readonly counters: PostgresCounterRepository
  ) {}

  private async nextInboxId(): Promise<string> {
    const n = await this.counters.nextNumber('inbox')
    return `INBOX-${String(n).padStart(3, '0')}`
  }

  async create(input: CreateInboxInput): Promise<InboxItem> {
    const ts = now()
    const id = await this.nextInboxId()
    await this.conn.query(
      `INSERT INTO inbox_items (id, project_id, content, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'raw', $4, $4)`,
      [id, input.projectId ?? null, input.content, ts]
    )
    const got = await this.get(id)
    if (!got) throw new Error(`Inbox item disappeared after insert: ${id}`)
    return got
  }

  async update(id: string, input: UpdateInboxInput): Promise<InboxItem> {
    const sets: string[] = ['updated_at = $1']
    const params: SqlValue[] = [now()]
    let n = 2

    if (input.content !== undefined) {
      sets.push(`content = $${n++}`)
      params.push(input.content)
    }
    if (input.status !== undefined) {
      sets.push(`status = $${n++}`)
      params.push(input.status)
    }
    if (input.linkedTaskId !== undefined) {
      sets.push(`linked_task_id = $${n++}`)
      params.push(input.linkedTaskId)
    }

    params.push(id)
    await this.conn.query(
      `UPDATE inbox_items SET ${sets.join(', ')} WHERE id = $${n}`,
      params
    )
    const item = await this.get(id)
    if (!item) throw new Error(`Inbox item not found: ${id}`)
    return item
  }

  async delete(id: string): Promise<void> {
    await this.conn.query('DELETE FROM inbox_items WHERE id = $1', [id])
  }

  async get(id: string): Promise<InboxItem | null> {
    const result = await this.conn.query<InboxDbRow>(
      `SELECT ${SELECT_COLS} FROM inbox_items WHERE id = $1`,
      [id]
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  }

  async find(filter: InboxFilter): Promise<InboxItem[]> {
    const wheres: string[] = []
    const params: SqlValue[] = []
    let n = 1

    if (filter.projectId !== undefined) {
      if (filter.projectId === null) {
        wheres.push('project_id IS NULL')
      } else {
        wheres.push(`project_id = $${n++}`)
        params.push(filter.projectId)
      }
    }
    if (filter.status) {
      wheres.push(`status = $${n++}`)
      params.push(filter.status)
    }

    const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
    const result = await this.conn.query<InboxDbRow>(
      `SELECT ${SELECT_COLS} FROM inbox_items ${where}
       ORDER BY created_at DESC, id DESC`,
      params
    )
    return result.rows.map(mapRow)
  }
}
