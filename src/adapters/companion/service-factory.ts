// TASK-1158 — wiring for the companion REST adapter. Mirrors cli/service-factory:
// resolve data paths → backend → core task service. Adds a second, read-only
// SQLite connection used for the raw column scans the ledger + health need
// (sync_origin / sync_updated_at / _sync_state) — data the typed service surface
// doesn't expose. WAL mode lets this reader run alongside the MCP server's writer.

import Database from 'better-sqlite3'
import { createTaskService } from '../../core/domain/task-service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { resolveBackendConfig, resolveDataPaths } from '../../core/paths'
import { warnIfSilentlyEmpty } from '../../core/warn-empty-data-dir'
import {
  resolveRemoteConfig,
  runPull,
  runPush,
  type PullSummary,
  type PushSummary
} from './sync-actions'
import { resolveBridgeToken } from './bridge-token'
import type { CaptureDispatcher } from './capture-contract'
import { CompanionCaptureDispatcher } from './capture-dispatcher'

export interface CompanionServices {
  svc: BackendTaskService
  // Read-only handle for ledger/health raw SQL. Never used to mutate.
  db: Database.Database
  dbPath: string
  intervalMs: number
  // TASK-1330 — per-profile token gating POST /capture. The web extension pairs
  // by pasting it (read from <dataDir>/bridge-token.txt).
  bridgeToken: string
  // TASK-1331 — routes a validated capture onto inbox/task/conversation/knowledge.
  // Absent in the skeleton → POST /capture 501s.
  dispatch?: CaptureDispatcher
  // TASK-1566 — root for GET /artifacts/*, so the web app can read back what a
  // capture wrote. Optional for the same reason as `dispatch`: absent → 501.
  artifactsDir?: string
  // TASK-1576 — vault root for GET /vault/*. The vault lives outside the data
  // dir entirely (it is plain markdown the user also edits by hand), so it is
  // configured explicitly rather than derived: absent → 501, and the vault stays
  // unreachable on any laptop that has not opted in. Only 30-Knowledge beneath
  // this root is ever served — see vault.ts.
  vaultDir?: string
  // TASK-1175 — mutating sync actions (own writable connection per call). Injected
  // so http-server stays decoupled and tests can pass fakes. Throw
  // SyncNotConfiguredError when the laptop has no remote configured.
  pull: () => Promise<PullSummary>
  push: () => Promise<PushSummary>
  close: () => void
}

export async function createCompanionServices(): Promise<CompanionServices> {
  const dataPaths = resolveDataPaths()
  // TASK-1510 — this is the process the packaged Electron app spawns, so it is the one
  // that matters most: on a fresh install its dataDir is an empty %APPDATA% profile.
  warnIfSilentlyEmpty(dataPaths.dataDir)
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
  const bridgeToken = resolveBridgeToken(dataPaths.dataDir)
  return {
    svc,
    db,
    dbPath: dataPaths.dbPath,
    intervalMs,
    bridgeToken,
    dispatch: new CompanionCaptureDispatcher(svc, dataPaths.artifactsDir),
    artifactsDir: dataPaths.artifactsDir,
    // Opt-in: unset means the vault routes 501 rather than serving anything.
    vaultDir: process.env.CHODA_VAULT_DIR?.trim() || undefined,
    pull: () => runPull(dataPaths.dbPath, resolveRemoteConfig()),
    push: () => runPush(dataPaths.dbPath, resolveRemoteConfig()),
    close: () => {
      db.close()
    }
  }
}
