// TASK-1175 — the companion adapter's two MUTATING sync endpoints: Pull (drain
// remote deltas → local SQLite) and Push (drain local pending_ops → remote).
// Unlike the read-only ledger/health (TASK-1158), these open their own WRITABLE
// connection and reuse the existing sync engine (sync-pull / sync-drain) — no
// reimplementation. Still localhost-only, still zero MCP edits.
//
// Mirrors the `choda-deck sync pull` CLI wiring and the startSyncLoop drain.

import Database from 'better-sqlite3'
import { initSchema } from '../../core/domain/repositories/schema'
import { pull, type PullSource } from '../../core/sync/sync-pull'
import { HttpPullSource } from '../../core/sync/http-pull-source'
import { HttpWriteClient, isRemoteReachable } from '../../core/sync/http-write-client'
import { drainPendingOps, createSyncConflictsTable } from '../../core/sync/sync-drain'
import type { ApplySink } from '../../core/sync/sync-apply'

// Thrown when the laptop isn't sync-capable (no remote configured). The HTTP
// layer maps this to a 4xx the UI surfaces — never a silent no-op (AC-3).
export class SyncNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncNotConfiguredError'
  }
}

export interface RemoteConfig {
  remoteUrl: string
  token: string
}

// Resolve the remote from env exactly as the CLI `sync pull` does. Missing
// CHODA_PULL_REMOTE_URL = not sync-capable.
export function resolveRemoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig {
  const remoteUrl = env.CHODA_PULL_REMOTE_URL
  if (!remoteUrl) {
    throw new SyncNotConfiguredError(
      'sync is not configured — set CHODA_PULL_REMOTE_URL (run the laptop with CHODA_BACKEND=sync) to enable Pull/Push'
    )
  }
  const token = env.CHODA_PULL_REMOTE_TOKEN ?? env.MCP_HTTP_TOKEN ?? ''
  return { remoteUrl, token }
}

export interface PullSummary {
  upserted: number
  tombstoned: number
  cursor: number
}

export interface PushSummary {
  drained: number
  conflicts: number
  remaining: number
  reachable: boolean
}

// Deps are injectable so the integration test can drive a fake remote without a
// network. Production passes nothing → real HTTP source/sink.
export interface PullDeps {
  source?: PullSource
}
export interface PushDeps {
  sink?: ApplySink
  isReachable?: () => Promise<boolean>
}

// POST /sync/pull — drain remote deltas into local SQLite via the existing pull
// path. Opens its own writable connection (busy_timeout lets it coexist with the
// MCP server's writer), same as the CLI.
export async function runPull(
  dbPath: string,
  cfg: RemoteConfig,
  deps: PullDeps = {}
): Promise<PullSummary> {
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  try {
    initSchema(db) // idempotent — guarantees sync columns + _sync_clock exist
    const source = deps.source ?? new HttpPullSource({ remoteUrl: cfg.remoteUrl, token: cfg.token })
    const result = await pull(db, source)
    return {
      upserted: result.counts.reduce((n, c) => n + c.upserted, 0),
      tombstoned: result.counts.reduce((n, c) => n + c.tombstoned, 0),
      cursor: result.newCursor
    }
  } finally {
    db.close()
  }
}

// POST /sync/push — drain the local pending_ops queue to the remote, reusing the
// sync-loop drain (LWW conflicts recorded to sync_conflicts as usual).
export async function runPush(
  dbPath: string,
  cfg: RemoteConfig,
  deps: PushDeps = {}
): Promise<PushSummary> {
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  try {
    initSchema(db)
    createSyncConflictsTable(db) // drain records LWW-dropped ops here
    const sink = deps.sink ?? new HttpWriteClient({ remoteUrl: cfg.remoteUrl, token: cfg.token })
    const isReachable = deps.isReachable ?? (() => isRemoteReachable(cfg.remoteUrl))
    const result = await drainPendingOps(db, sink, { origin: 'laptop', isReachable })
    return {
      drained: result.drained,
      conflicts: result.conflicts,
      remaining: result.remaining,
      reachable: result.reachable
    }
  } finally {
    db.close()
  }
}
