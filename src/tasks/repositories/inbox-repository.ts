import type Database from 'better-sqlite3'
import type {
  CreateInboxInput,
  InboxFilter,
  InboxItem,
  InboxStatus,
  UpdateInboxInput
} from '../task-types'
import { now, type Param } from './shared'

const COUNTER_KEY = '__all__'

function rowToInbox(row: Record<string, unknown>): InboxItem {
  return {
    id: row.id as string,
    projectId: (row.project_id as string) || null,
    content: row.content as string,
    status: row.status as InboxStatus,
    linkedTaskId: (row.linked_task_id as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export class InboxRepository {
  constructor(private readonly db: Database.Database) {}

  private nextInboxId(): string {
    const row = this.db
      .prepare(
        `INSERT INTO project_inbox_counters (project_id, last_number) VALUES (?, 1)
         ON CONFLICT(project_id) DO UPDATE SET last_number = last_number + 1
         RETURNING last_number`
      )
      .get(COUNTER_KEY) as { last_number: number }
    return `INBOX-${String(row.last_number).padStart(3, '0')}`
  }

  create(input: CreateInboxInput): InboxItem {
    const ts = now()
    const projectId = input.projectId ?? null
    const id = this.nextInboxId()
    this.db
      .prepare(
        `INSERT INTO inbox_items (id, project_id, content, status, created_at, updated_at)
         VALUES (?, ?, ?, 'raw', ?, ?)`
      )
      .run(id, projectId, input.content, ts, ts)
    return this.get(id)!
  }

  update(id: string, input: UpdateInboxInput): InboxItem {
    const sets: string[] = ['updated_at = ?']
    const params: Param[] = [now()]

    if (input.content !== undefined) {
      sets.push('content = ?')
      params.push(input.content)
    }
    if (input.status !== undefined) {
      sets.push('status = ?')
      params.push(input.status)
    }
    if (input.linkedTaskId !== undefined) {
      sets.push('linked_task_id = ?')
      params.push(input.linkedTaskId)
    }

    params.push(id)
    this.db
      .prepare(`UPDATE inbox_items SET ${sets.join(', ')} WHERE id = ?`)
      .run(...(params as (string | number | null)[]))
    const item = this.get(id)
    if (!item) throw new Error(`Inbox item not found: ${id}`)
    return item
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM inbox_items WHERE id = ?').run(id)
  }

  get(id: string): InboxItem | null {
    const row = this.db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToInbox(row) : null
  }

  find(filter: InboxFilter): InboxItem[] {
    const wheres: string[] = []
    const params: Param[] = []

    if (filter.projectId !== undefined) {
      if (filter.projectId === null) {
        wheres.push('project_id IS NULL')
      } else {
        wheres.push('project_id = ?')
        params.push(filter.projectId)
      }
    }
    if (filter.status) {
      wheres.push('status = ?')
      params.push(filter.status)
    }

    const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM inbox_items ${where} ORDER BY created_at DESC`)
      .all(...(params as (string | number | null)[])) as Array<Record<string, unknown>>
    return rows.map(rowToInbox)
  }
}
