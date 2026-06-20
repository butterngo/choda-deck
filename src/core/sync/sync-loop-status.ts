// TASK-1158 — cross-process heartbeat for the drain/pull loop.
//
// The companion REST adapter (src/adapters/companion) runs in a SEPARATE process
// from the stdio MCP server that hosts the sync loop (startSyncLoop). They share
// only the SQLite file, so the adapter cannot read the loop's in-memory health.
// The loop therefore stamps a wall-clock heartbeat into the singleton `_sync_state`
// row each cycle; the adapter reads it back and derives liveness from its age.
//
// Wall-clock (not the Lamport counter) is deliberate: `lastPullAgeSec` is a
// human-facing "how long since the loop last ran" number, which a logical counter
// can't express. Columns are added additively to `_sync_state` (already a pinned
// id=0 singleton) so no new table or migration is needed.

import type Database from 'better-sqlite3'

// Auth posture the loop is running under, surfaced as `jwtState`. Mirrors the
// startSyncLoop auth branch: a Keycloak refresh provider (survives token expiry),
// a static bearer (dies at ~300s), or no auth configured.
export type LoopJwtState = 'refresh' | 'static' | 'none'

export interface LoopStatus {
  // ISO wall-clock of the last completed loop cycle, or null if never run.
  lastRunAt: string | null
  // ISO wall-clock of the last cycle that actually pulled (remote reachable), or null.
  lastPullAt: string | null
  // Whether the last cycle reached the remote.
  reachable: boolean
  jwtState: LoopJwtState
}

const COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'loop_last_run_at', type: 'TEXT' },
  { name: 'loop_last_pull_at', type: 'TEXT' },
  { name: 'loop_reachable', type: 'INTEGER' },
  { name: 'loop_jwt_state', type: 'TEXT' }
]

// Additive ALTERs guarded against existing DBs — `_sync_state` predates these
// columns. Safe to call on every init; a present column makes the ALTER throw,
// which we swallow per-column rather than pre-checking table_info.
export function ensureLoopStatusColumns(db: Database.Database): void {
  const existing = new Set(
    (db.pragma('table_info(_sync_state)') as Array<{ name: string }>).map((c) => c.name)
  )
  for (const col of COLUMNS) {
    if (!existing.has(col.name)) {
      db.exec(`ALTER TABLE _sync_state ADD COLUMN ${col.name} ${col.type}`)
    }
  }
}

export interface HeartbeatInput {
  at: string // ISO wall-clock — caller passes now() so this stays testable
  pulled: boolean // did this cycle pull (remote was reachable)?
  reachable: boolean
  jwtState: LoopJwtState
}

// Stamp one cycle's heartbeat. `loop_last_pull_at` only advances on a cycle that
// actually pulled, so a long offline stretch keeps the stale pull age visible.
export function writeLoopHeartbeat(db: Database.Database, input: HeartbeatInput): void {
  ensureLoopStatusColumns(db)
  if (input.pulled) {
    db.prepare(
      `UPDATE _sync_state
       SET loop_last_run_at = ?, loop_last_pull_at = ?, loop_reachable = ?, loop_jwt_state = ?
       WHERE id = 0`
    ).run(input.at, input.at, input.reachable ? 1 : 0, input.jwtState)
  } else {
    db.prepare(
      `UPDATE _sync_state
       SET loop_last_run_at = ?, loop_reachable = ?, loop_jwt_state = ?
       WHERE id = 0`
    ).run(input.at, input.reachable ? 1 : 0, input.jwtState)
  }
}

// Read the heartbeat. Returns null when the loop has never stamped one (columns
// absent on an old DB, or no cycle has run) — the caller treats that as loop-down.
export function readLoopStatus(db: Database.Database): LoopStatus | null {
  const present = new Set(
    (db.pragma('table_info(_sync_state)') as Array<{ name: string }>).map((c) => c.name)
  )
  if (!present.has('loop_last_run_at')) return null
  const row = db
    .prepare(
      `SELECT loop_last_run_at, loop_last_pull_at, loop_reachable, loop_jwt_state
       FROM _sync_state WHERE id = 0`
    )
    .get() as
    | {
        loop_last_run_at: string | null
        loop_last_pull_at: string | null
        loop_reachable: number | null
        loop_jwt_state: string | null
      }
    | undefined
  if (!row || row.loop_last_run_at === null) return null
  return {
    lastRunAt: row.loop_last_run_at,
    lastPullAt: row.loop_last_pull_at,
    reachable: row.loop_reachable === 1,
    jwtState: (row.loop_jwt_state as LoopJwtState | null) ?? 'none'
  }
}
