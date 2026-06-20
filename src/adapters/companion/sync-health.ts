// TASK-1158 AC-3 — sync loop health, read from the cross-process heartbeat the
// drain loop stamps into `_sync_state` (see core/sync/sync-loop-status.ts).
//
// Honesty rule (AC-3): when the loop is down — no heartbeat, or a heartbeat older
// than the staleness window — `loopAlive` is false. The adapter never reports a
// stale-but-ok payload, because a dead loop and a slow loop are the difference
// between "your sync is broken" and "your sync is fine".

import type Database from 'better-sqlite3'
import { readLoopStatus, type LoopJwtState } from '../../core/sync/sync-loop-status'

export interface SyncHealth {
  loopAlive: boolean
  lastPullAgeSec: number | null
  jwtState: LoopJwtState | 'unknown'
  reachable: boolean
}

// The loop is considered alive if its last heartbeat is younger than this
// multiple of its cadence — one missed cycle is tolerated (a slow tick), two is
// treated as dead.
const ALIVE_WINDOW_MULTIPLIER = 2

export interface HealthOptions {
  // Loop cadence in ms (CHODA_SYNC_INTERVAL_MS, default 30000) — sets the
  // staleness window. The adapter doesn't run the loop, so it's passed in.
  intervalMs: number
  // Injectable clock (ms epoch) — keeps the staleness math testable.
  nowMs: number
}

export function computeHealth(db: Database.Database, opts: HealthOptions): SyncHealth {
  const status = readLoopStatus(db)
  if (!status || status.lastRunAt === null) {
    return { loopAlive: false, lastPullAgeSec: null, jwtState: 'unknown', reachable: false }
  }
  const lastRunMs = Date.parse(status.lastRunAt)
  const ageMs = opts.nowMs - lastRunMs
  const loopAlive = Number.isFinite(lastRunMs) && ageMs <= opts.intervalMs * ALIVE_WINDOW_MULTIPLIER
  const lastPullAgeSec =
    status.lastPullAt !== null && Number.isFinite(Date.parse(status.lastPullAt))
      ? Math.max(0, Math.round((opts.nowMs - Date.parse(status.lastPullAt)) / 1000))
      : null
  return {
    loopAlive,
    lastPullAgeSec,
    jwtState: status.jwtState,
    reachable: status.reachable
  }
}
