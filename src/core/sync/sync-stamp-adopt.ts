// TASK-3202 — the client half of the re-stamp contract. The canonical store may
// write a pushed row with a Lamport ABOVE the one the laptop stamped (sync-sink:
// at least one past everything canonical already held), and reports it back as
// `stamped` on the row verdict. Adopting it here keeps local and canonical equal
// for that row, so the laptop's next pull does not re-fetch its own write, and
// merges the clock so every later local write outranks it.
//
// Shared by the direct push (sync-write-through) and the replay (sync-drain):
// both see the same verdict shape, and only one of them must ever learn the rule.

import type Database from 'better-sqlite3'
import { mergeClock } from './lamport-clock'
import type { ApplyResult } from './sync-apply'
import type { TableDelta } from './sync-pull'

export function adoptStampedVerdicts(
  db: Database.Database,
  deltas: TableDelta[],
  result: ApplyResult
): void {
  for (const delta of deltas) {
    for (const row of delta.rows) {
      const verdict = result.verdicts.find((v) => v.table === delta.table && v.id === row.id)
      if (!verdict || verdict.verdict === 'conflict') continue
      // An older server sends no `stamped`; a value equal to ours means nothing moved.
      if (typeof verdict.stamped !== 'number' || verdict.stamped === row.sync_updated_at) continue
      // Guarded on the pushed value: a local edit that landed meanwhile already
      // carries a newer stamp and must not be dragged back onto this one. A
      // tombstoned row is usually gone locally (hard delete) — zero rows is fine.
      db.prepare(
        `UPDATE ${delta.table}
            SET sync_updated_at = ?,
                sync_deleted_at = CASE WHEN sync_deleted_at IS NULL THEN NULL ELSE ? END
          WHERE id = ? AND sync_updated_at = ?`
      ).run(verdict.stamped, verdict.stamped, row.id, row.sync_updated_at)
      mergeClock(db, verdict.stamped)
    }
  }
}
