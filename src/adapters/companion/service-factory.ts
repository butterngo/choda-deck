// TASK-1158 — wiring for the companion REST adapter. Mirrors cli/service-factory:
// resolve data paths → backend → core task service. Adds a second, read-only
// SQLite connection used for the raw column scans the ledger + health need
// (sync_origin / sync_updated_at / _sync_state) — data the typed service surface
// doesn't expose. WAL mode lets this reader run alongside the MCP server's writer.

import Database from 'better-sqlite3'
import { createTaskService } from '../../core/domain/task-service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { resolveBackendConfig, resolveDataPaths } from '../../core/paths'

export interface CompanionServices {
  svc: BackendTaskService
  // Read-only handle for ledger/health raw SQL. Never used to mutate.
  db: Database.Database
  dbPath: string
  intervalMs: number
  close: () => void
}

export async function createCompanionServices(): Promise<CompanionServices> {
  const dataPaths = resolveDataPaths()
  const backend = resolveBackendConfig(dataPaths)
  // The companion serves the laptop's local SQLite working copy. A postgres
  // backend has no local file to scan — and the laptop is the source of truth, so
  // pointing the adapter at a remote PG would defeat its purpose. Reject early.
  if (backend.kind === 'postgres') {
    throw new Error(
      '[companion] CHODA_BACKEND=postgres is unsupported — the companion adapter reads the ' +
        'local SQLite source of truth. Run with sqlite (default) or sync.'
    )
  }
  const svc = createTaskService(backend)
  await svc.initializeAsync()
  // initializeAsync has created + migrated the file (incl. the loop-status
  // columns), so a read-only open now always succeeds.
  const db = new Database(dataPaths.dbPath, { readonly: true })
  const intervalMs = Number.parseInt(process.env.CHODA_SYNC_INTERVAL_MS ?? '30000', 10) || 30000
  return {
    svc,
    db,
    dbPath: dataPaths.dbPath,
    intervalMs,
    close: () => {
      db.close()
    }
  }
}
