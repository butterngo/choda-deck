import Database from 'better-sqlite3'
import { initSchema } from '../../core/domain/repositories/schema'
import { resolveDataPaths } from '../../core/paths'
import { backfillUnstamped, type BackfillReport } from '../../core/sync/sync-backfill'
import type { ApplySink } from '../../core/sync/sync-apply'
import { HttpWriteClient } from '../../core/sync/http-write-client'
import { resolveRemoteConfig, SyncNotConfiguredError } from '../companion/sync-actions'

// TASK-3343 — `choda-deck sync backfill`. Stamps and pushes project/workspace
// rows a non-sync server wrote (sync_updated_at NULL). Auth resolves exactly as
// the companion Push does: Keycloak ROPC refresh when its creds resolve, else the
// static CHODA_PULL_REMOTE_TOKEN / MCP_HTTP_TOKEN.
//
// Exit codes: 0 done — rows the remote refused or that fell back to pending_ops
// are reported, not failures (the drain loop replays the queue) · 2 not configured.

export const SYNC_BACKFILL_HELP = `Usage: choda-deck sync backfill

Stamp + push projects and workspaces whose sync_updated_at is NULL (written by a
server running without CHODA_BACKEND=sync). Idempotent: a second run finds nothing.
If the remote is unreachable the rows are queued to pending_ops for the sync loop.

env: CHODA_PULL_REMOTE_URL (required), CHODA_SYNC_OIDC_* or CHODA_PULL_REMOTE_TOKEN
`

export interface SyncBackfillIo {
  out: (s: string) => void
  err: (s: string) => void
}

export interface SyncBackfillDeps {
  dbPath?: string
  sink?: ApplySink
}

export function formatSyncBackfillReport(r: BackfillReport): string {
  const lines = r.counts.map(
    (c) =>
      `${c.table}: stamped ${c.stamped} · pushed ${c.pushed} · conflicts ${c.conflicts} · queued ${c.queued}`
  )
  if (r.error) lines.push(`push failed, rows queued to pending_ops: ${r.error}`)
  return lines.join('\n') + '\n'
}

const STDIO: SyncBackfillIo = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s)
}

export async function syncBackfillCommand(
  args: string[],
  io: SyncBackfillIo = STDIO,
  deps: SyncBackfillDeps = {}
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.out(SYNC_BACKFILL_HELP)
    return 0
  }
  let sink = deps.sink
  if (!sink) {
    try {
      const cfg = resolveRemoteConfig()
      sink = new HttpWriteClient({
        remoteUrl: cfg.remoteUrl,
        token: cfg.token,
        getToken: cfg.getToken
      })
    } catch (err) {
      if (!(err instanceof SyncNotConfiguredError)) throw err
      io.err(`error: sync backfill requires CHODA_PULL_REMOTE_URL\n`)
      return 2
    }
  }
  const db = new Database(deps.dbPath ?? resolveDataPaths().dbPath)
  try {
    db.pragma('busy_timeout = 5000')
    initSchema(db) // idempotent — guarantees the sync columns, clock and pending_ops
    io.out(formatSyncBackfillReport(await backfillUnstamped(db, sink)))
    return 0
  } finally {
    db.close()
  }
}
