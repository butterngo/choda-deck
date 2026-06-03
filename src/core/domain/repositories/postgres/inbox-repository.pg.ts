// ADR-030 / 2026-05-28 narrowing — Postgres inbox repo. Read + create only.
//
// Kept: find (inbox_list), get (inbox_get), create (inbox_add). Drops
// update/delete — remote callers cannot mutate or delete inbox items, only
// add raw captures. ID mint still goes through the shared counter repo so
// INBOX-NNN sequencing matches the stdio path.

import type { Queryable, SqlValue } from './connection'
import type {
  CreateInboxInput,
  InboxFilter,
  InboxItem,
  InboxStatus
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
    private readonly conn: Queryable,
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
      `INSERT INTO inbox_items (id, project_id, content, status, linked_task_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'raw', $4, $5, $5)`,
      [id, input.projectId ?? null, input.content, input.linkedTaskId ?? null, ts]
    )
    const got = await this.get(id)
    if (!got) throw new Error(`Inbox item disappeared after insert: ${id}`)
    return got
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
