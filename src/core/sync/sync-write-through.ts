// ADR-030 Phase 3 (TASK-1064 / 979b) — write-through wrapper. In sync mode every
// mutating tool call writes local SQLite (the inner service), then the wrapper
// stamps the row with a Lamport tick + origin and POSTs it to the remote. On a
// remote failure the op is enqueued to pending_ops and the call still returns
// success (consistency-then-enqueue, ADR-030 §Write semantics).
//
// Implemented as a Proxy over the full BackendTaskService so the ~200-method
// surface delegates untouched and only the six task/inbox mutators are
// intercepted — hand-writing a full decorator for that interface would be all
// boilerplate. ALL sync stamping lives here, not in the repositories: a plain
// stdio server (sync off) never wraps, so its writes stay unstamped exactly as
// before (ADR-030 Phase 1 note — local stamping IS write-through's job).
//
// Scope = tasks + inbox (the APPLY_TABLES set). conversation_* mutators are NOT
// wrapped — that is the gated 979e slice with its append-preserving merge.

import type Database from 'better-sqlite3'
import type { SqliteTaskService } from '../domain/sqlite-task-service'
import type { BackendTaskService } from '../domain/backend-task-service.interface'
import { tick } from './lamport-clock'
import { enqueueOp } from './pending-ops'
import type { ApplySink } from './sync-apply'
import type { PulledRow } from './sync-pull'

interface MutatorSpec {
  table: 'tasks' | 'inbox_items'
  op: 'upsert' | 'delete'
}

// Method name → which table it writes and whether it is a delete. createInbox is
// remote-writable today; update/delete inbox round out the inbox surface.
const MUTATORS: Record<string, MutatorSpec> = {
  createTask: { table: 'tasks', op: 'upsert' },
  updateTask: { table: 'tasks', op: 'upsert' },
  deleteTask: { table: 'tasks', op: 'delete' },
  createInbox: { table: 'inbox_items', op: 'upsert' },
  updateInbox: { table: 'inbox_items', op: 'upsert' },
  deleteInbox: { table: 'inbox_items', op: 'delete' }
}

export interface SyncWriteThroughOptions {
  origin?: string // device tag stamped on locally-written rows; default 'laptop'
}

export function wrapWithSyncWriteThrough(
  inner: SqliteTaskService,
  sink: ApplySink,
  opts: SyncWriteThroughOptions = {}
): BackendTaskService {
  const db = inner.syncDatabase
  const origin = opts.origin ?? 'laptop'

  const handler: ProxyHandler<SqliteTaskService> = {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver)
      if (typeof orig !== 'function') return orig
      const spec = MUTATORS[prop as string]
      if (!spec) return (orig as (...a: unknown[]) => unknown).bind(target)

      return async (...args: unknown[]): Promise<unknown> => {
        if (spec.op === 'delete') {
          const id = args[0] as string
          const before = readRow(db, spec.table, id)
          const result = await (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args)
          if (before) {
            const lamport = tick(db)
            const tombstone: PulledRow = {
              ...before,
              sync_updated_at: lamport,
              sync_deleted_at: lamport,
              sync_origin: origin
            }
            await push(db, sink, origin, spec.table, id, 'delete', tombstone, lamport)
          }
          return result
        }

        const result = await (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args)
        const id = (result as { id?: string } | null)?.id ?? (args[0] as string)
        const lamport = tick(db)
        db.prepare(`UPDATE ${spec.table} SET sync_updated_at = ?, sync_origin = ? WHERE id = ?`).run(
          lamport,
          origin,
          id
        )
        const row = readRow(db, spec.table, id)
        if (row) await push(db, sink, origin, spec.table, id, 'upsert', row, lamport)
        return result
      }
    }
  }

  return new Proxy(inner, handler) as unknown as BackendTaskService
}

// Push one row to the remote; on any failure (offline / 5xx / timeout) enqueue it
// for the drain loop and swallow the error so the tool call still succeeds.
async function push(
  db: Database.Database,
  sink: ApplySink,
  origin: string,
  table: string,
  rowId: string,
  op: 'upsert' | 'delete',
  row: PulledRow,
  lamport: number
): Promise<void> {
  try {
    await sink.applyDelta([{ table, rows: [row] }], origin)
  } catch {
    enqueueOp(db, { tableName: table, rowId, op, row, lamport, enqueuedAt: Date.now() })
  }
}

function readRow(db: Database.Database, table: string, id: string): PulledRow | undefined {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as PulledRow | undefined
}
