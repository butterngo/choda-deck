import * as os from 'os'
import * as path from 'path'
import type { BackendConfig } from './backend-config'

export interface DataPaths {
  dataDir: string
  dbPath: string
  artifactsDir: string
  backupsDir: string
}

/**
 * Resolve all runtime data paths from env vars.
 *
 * Priority:
 * 1. CHODA_DB_PATH (legacy) — overrides dbPath only; dataDir derived from its dirname
 * 2. CHODA_DATA_DIR — single root, all paths derived
 * 3. fallback — <cwd>/data
 *
 * Layout under dataDir:
 *   database/choda-deck.db
 *   artifacts/
 *   backups/
 */
export function resolveDataPaths(electronDataDir?: string): DataPaths {
  const legacyDbPath = process.env.CHODA_DB_PATH
  const envDataDir = process.env.CHODA_DATA_DIR

  let dataDir: string
  let dbPath: string

  if (legacyDbPath) {
    if (envDataDir) {
      console.warn('[paths] Both CHODA_DB_PATH and CHODA_DATA_DIR set — CHODA_DB_PATH wins for dbPath')
    }
    dbPath = path.resolve(legacyDbPath)
    dataDir = electronDataDir ?? envDataDir ?? path.dirname(dbPath)
  } else if (envDataDir) {
    dataDir = path.resolve(envDataDir)
    dbPath = path.join(dataDir, 'database', 'choda-deck.db')
  } else if (electronDataDir) {
    dataDir = electronDataDir
    dbPath = path.join(dataDir, 'database', 'choda-deck.db')
  } else {
    dataDir = path.join(process.cwd(), 'data')
    dbPath = path.join(dataDir, 'database', 'choda-deck.db')
  }

  return {
    dataDir,
    dbPath,
    artifactsDir: path.join(dataDir, 'artifacts'),
    backupsDir: path.join(dataDir, 'backups')
  }
}

/**
 * Resolve which storage backend to use at startup (ADR-030).
 *
 * Env contract:
 *   CHODA_BACKEND  — 'sqlite' (default) | 'postgres'
 *   CHODA_PG_URL   — required when CHODA_BACKEND=postgres
 *
 * SQLite reuses the dbPath from `resolveDataPaths`. Postgres is wired but
 * not yet implemented — the factory throws BackendNotImplementedError until
 * TASK-934 lands the adapter.
 */
export function resolveBackendConfig(dataPaths: DataPaths): BackendConfig {
  const kind = (process.env.CHODA_BACKEND ?? 'sqlite').toLowerCase()
  if (kind === 'postgres') {
    const connectionString = process.env.CHODA_PG_URL ?? ''
    if (connectionString.length === 0) {
      throw new Error(
        '[paths] CHODA_BACKEND=postgres requires CHODA_PG_URL (postgres connection string)'
      )
    }
    return { kind: 'postgres', connectionString }
  }
  if (kind !== 'sqlite') {
    throw new Error(`[paths] unknown CHODA_BACKEND="${kind}" — expected sqlite|postgres`)
  }
  return { kind: 'sqlite', dbPath: dataPaths.dbPath }
}

/**
 * Resolve the directory where conversation event JSONL files are written.
 *
 * Priority:
 * 1. CHODA_EVENT_DIR env var (absolute or relative, resolved to absolute)
 * 2. fallback — <os.tmpdir()>/choda-events
 *
 * Each project gets one file: <eventDir>/<projectId>.jsonl
 */
export function resolveEventDir(): string {
  const envDir = process.env.CHODA_EVENT_DIR
  if (envDir) return path.resolve(envDir)
  return path.join(os.tmpdir(), 'choda-events')
}
