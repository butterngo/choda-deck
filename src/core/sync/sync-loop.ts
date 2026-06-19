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
import { pull } from './sync-pull'

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

  const runOnce = async (): Promise<void> => {
    const drain = await drainPendingOps(opts.db, client, {
      origin,
      isReachable: () => isRemoteReachable(opts.remoteUrl, fetchImpl),
      onConflict: (c) => surfaceConflict(opts.db, c)
    })
    // Only pull when the drain confirmed the remote is reachable — avoids a
    // guaranteed-failing GET right after an offline drain cycle.
    if (drain.reachable) {
      try {
        await pull(opts.db, pullSource)
      } catch {
        // Transient pull failure — next cycle retries from the same cursor.
      }
    }
  }

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
