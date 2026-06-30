// ADR-030 Phase 5+6 (TASK-1066 / 979d) — the laptop's bidirectional sync loop.
// One cycle = drain the pending_ops queue to the remote (979c), then pull remote
// deltas back into local SQLite (979b read path, TASK-978). Runs once on startup
// then on a fixed interval; the connectivity gate inside the drain makes an
// offline cycle a cheap no-op.
//
// Conflicts dropped by the drain are surfaced as raw inbox_items written DIRECTLY
// to the DB here — not through the wrapped service, which would try to push the
// inbox row back to the remote and recurse.

import type Database from 'better-sqlite3'
import { now } from '../domain/repositories/shared'
import { HttpWriteClient, isRemoteReachable } from './http-write-client'
import { HttpPullSource } from './http-pull-source'
import { drainPendingOps, type ConflictRecord } from './sync-drain'
import type { ApplySink } from './sync-apply'
import { pull, type PullSource } from './sync-pull'
import { appendSyncEvent, sumPullCounts } from './sync-events'
import { writeLoopHeartbeat, type LoopJwtState } from './sync-loop-status'

export interface SyncLoopOptions {
  db: Database.Database
  remoteUrl: string
  // Static bearer (MCP_HTTP_TOKEN). Mutually exclusive with getToken.
  token?: string
  // Per-request token provider (Keycloak refresh flow, TASK-1108). Wins over
  // token — lets the loop outlive the ~300s access-token TTL against an OAuth
  // remote. Both HTTP clients call it per request.
  getToken?: () => Promise<string>
  origin?: string
  intervalMs?: number
  fetchImpl?: typeof fetch
}

export interface SyncLoopHandle {
  runOnce: () => Promise<void>
  stop: () => void
}

export function startSyncLoop(opts: SyncLoopOptions): SyncLoopHandle {
  const origin = opts.origin ?? 'laptop'
  const fetchImpl = opts.fetchImpl ?? fetch
  const auth = { getToken: opts.getToken, token: opts.token }
  const client = new HttpWriteClient({ remoteUrl: opts.remoteUrl, ...auth, fetchImpl })
  const pullSource = new HttpPullSource({ remoteUrl: opts.remoteUrl, ...auth, fetchImpl })
  // jwtState surfaced to the companion adapter's /sync/health: a refresh provider
  // outlives token expiry, a static bearer dies at ~300s, none = unauthenticated.
  const jwtState: LoopJwtState = opts.getToken ? 'refresh' : opts.token ? 'static' : 'none'

  const runOnce = (): Promise<void> =>
    runSyncCycle({
      db: opts.db,
      client,
      pullSource,
      origin,
      isReachable: () => isRemoteReachable(opts.remoteUrl, fetchImpl),
      jwtState
    })

  let timer: ReturnType<typeof setInterval> | null = null
  // Kick off an immediate cycle, then schedule. Errors are swallowed — the loop
  // must survive a bad cycle.
  void runOnce().catch(() => undefined)
  timer = setInterval(() => {
    void runOnce().catch(() => undefined)
  }, opts.intervalMs ?? 30000)
  // Don't keep the process alive solely for the sync timer.
  if (typeof timer.unref === 'function') timer.unref()

  return {
    runOnce,
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}

export interface SyncCycleDeps {
  db: Database.Database
  client: ApplySink
  pullSource: PullSource
  origin: string
  // Connectivity gate, forwarded to the drain.
  isReachable: () => Promise<boolean>
  jwtState: LoopJwtState
  // Wall-clock (epoch ms) for sync_events.at — injectable for deterministic tests.
  nowMs?: () => number
  // ISO wall-clock for the heartbeat — injectable for tests.
  nowIso?: () => string
}

// One sync cycle: drain the queue, pull deltas, stamp the heartbeat, and record a
// durable sync_events row for each piece of real data movement (TASK-1214):
// - one `drain` event when ops were accepted by the remote (pushed count),
// - one `conflict` event per dropped op (alongside the existing sync_conflicts row
//   + raw inbox surface — no double-loss, no silent drop),
// - one `pull` event when the pull upserted/tombstoned anything.
// A pure no-op cycle (nothing drained, nothing pulled) appends NO sync_events row:
// the loop heartbeat already records that a cycle ran, and the activity feed is
// reserved for actual data movement — keeping it appended-on-change bounds growth.
export async function runSyncCycle(deps: SyncCycleDeps): Promise<void> {
  const nowMs = deps.nowMs ?? Date.now
  const nowIso = deps.nowIso ?? now

  const drain = await drainPendingOps(deps.db, deps.client, {
    origin: deps.origin,
    isReachable: deps.isReachable,
    onConflict: (c) => {
      surfaceConflict(deps.db, c)
      appendSyncEvent(deps.db, {
        at: nowMs(),
        kind: 'conflict',
        conflicts: 1,
        note: `${c.op} ${c.tableName} ${c.rowId} dropped by LWW (lamport ${c.lamport} ≤ canonical ${c.canonicalLamport})`
      })
    }
  })
  if (drain.drained > 0) {
    appendSyncEvent(deps.db, { at: nowMs(), kind: 'drain', pushed: drain.drained })
  }

  // Only pull when the drain confirmed the remote is reachable — avoids a
  // guaranteed-failing GET right after an offline drain cycle.
  let pulled = false
  if (drain.reachable) {
    try {
      const result = await pull(deps.db, deps.pullSource)
      pulled = true
      const upserted = sumPullCounts(result.counts, 'upserted')
      const tombstoned = sumPullCounts(result.counts, 'tombstoned')
      if (upserted > 0 || tombstoned > 0) {
        appendSyncEvent(deps.db, { at: nowMs(), kind: 'pull', upserted, tombstoned })
      }
    } catch {
      // Transient pull failure — next cycle retries from the same cursor.
    }
  }

  // TASK-1158 — stamp the cross-process heartbeat so the companion adapter can
  // report loop liveness + pull age from the shared DB.
  writeLoopHeartbeat(deps.db, { at: nowIso(), pulled, reachable: drain.reachable, jwtState: deps.jwtState })
}

// Write a raw inbox item recording a dropped op, directly (not via the wrapped
// service). Mints an INBOX-NNN id from the shared counter, matching the inbox repo.
function surfaceConflict(db: Database.Database, c: ConflictRecord): void {
  const row = db
    .prepare(
      `INSERT INTO global_counters (entity_type, last_number) VALUES ('inbox', 1)
       ON CONFLICT(entity_type) DO UPDATE SET last_number = last_number + 1
       RETURNING last_number`
    )
    .get() as { last_number: number }
  const id = `INBOX-${String(row.last_number).padStart(3, '0')}`
  const ts = now()
  const content =
    `[sync conflict] ${c.op} on ${c.tableName} ${c.rowId} dropped by last-writer-wins ` +
    `(local lamport ${c.lamport} ≤ canonical ${c.canonicalLamport}). The remote copy won; ` +
    `your local change was not applied. Review and re-apply if needed.`
  db.prepare(
    `INSERT INTO inbox_items (id, project_id, content, status, created_at, updated_at)
     VALUES (?, NULL, ?, 'raw', ?, ?)`
  ).run(id, content, ts, ts)
}
