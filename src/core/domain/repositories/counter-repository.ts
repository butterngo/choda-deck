import type Database from 'better-sqlite3'

export class CounterRepository {
  constructor(private readonly db: Database.Database) {}

  nextNumber(entityType: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO global_counters (entity_type, last_number) VALUES (?, 1)
         ON CONFLICT(entity_type) DO UPDATE SET last_number = last_number + 1
         RETURNING last_number`
      )
      .get(entityType) as { last_number: number }
    return row.last_number
  }
}

// TASK-1148 — the only tables whose ids come from the sequential global_counters
// allocator (TASK-NNN / INBOX-NNN). conversations/messages use timestamp ids and
// projects/workspaces use supplied ids, so none of those can collide on import.
const COUNTER_BACKED_TABLES: ReadonlyArray<{ table: string; entityType: string; prefix: string }> = [
  { table: 'tasks', entityType: 'task', prefix: 'TASK-' },
  { table: 'inbox_items', entityType: 'inbox', prefix: 'INBOX-' }
]

// Raise a counter to at least `n` (never lowers it) — MAX(), so it's monotonic and
// a no-op when the local counter is already ahead (AC-4 / AC-6).
function raiseCounter(db: Database.Database, entityType: string, n: number): void {
  db.prepare(
    `INSERT INTO global_counters (entity_type, last_number) VALUES (?, ?)
     ON CONFLICT(entity_type) DO UPDATE SET last_number = MAX(last_number, excluded.last_number)`
  ).run(entityType, n)
}

// TASK-1148 — after a sync import (pull or apply-to-sqlite) advance the per-table
// id allocator past every imported id, so a freshly-synced node never re-mints an
// id that already exists. Counts live + tombstoned rows (a tombstone's id stays
// taken). Explicit non-numeric ids (e.g. TASK-PUSHSMOKE-1) are skipped — they
// don't come from the counter. Idempotent; safe to call on every import.
export function advanceCountersFromImport(
  db: Database.Database,
  rowsByTable: Map<string, Array<{ id?: unknown }>>
): void {
  for (const { table, entityType, prefix } of COUNTER_BACKED_TABLES) {
    const rows = rowsByTable.get(table)
    if (!rows || rows.length === 0) continue
    let max = 0
    for (const row of rows) {
      const id = row.id
      if (typeof id !== 'string' || !id.startsWith(prefix)) continue
      const suffix = id.slice(prefix.length)
      if (!/^\d+$/.test(suffix)) continue // explicit non-counter id — skip
      const n = Number.parseInt(suffix, 10)
      if (n > max) max = n
    }
    if (max > 0) raiseCounter(db, entityType, max)
  }
}
