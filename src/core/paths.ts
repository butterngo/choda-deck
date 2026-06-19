import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { BackendConfig, SyncOAuthConfig } from './backend-config'

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
 *   CHODA_BACKEND  — 'sqlite' (default) | 'postgres' | 'sync'
 *   CHODA_PG_URL   — required when CHODA_BACKEND=postgres
 *   CHODA_PULL_REMOTE_URL / CHODA_PULL_REMOTE_TOKEN — required when =sync
 *   CHODA_SYNC_INTERVAL_MS — optional drain/pull cadence (default 30000)
 *
 * SQLite reuses the dbPath from `resolveDataPaths`. Postgres uses
 * `CHODA_PG_URL` (validated here) plus optional `CHODA_PG_POOL_SIZE`
 * (consumed in the task-service factory; defaults to 10). Sync wraps the same
 * SQLite dbPath with write-through to the remote, reusing the read-pull envs.
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
  if (kind === 'sync') {
    const remoteUrl = process.env.CHODA_PULL_REMOTE_URL ?? ''
    const remoteToken = process.env.CHODA_PULL_REMOTE_TOKEN ?? process.env.MCP_HTTP_TOKEN ?? ''
    const oauth = resolveSyncOAuth()
    // OAuth refresh mode mints its own tokens, so a static bearer is optional then;
    // without OAuth the loop has no other credential and the bearer is required.
    if (remoteUrl.length === 0 || (remoteToken.length === 0 && !oauth)) {
      throw new Error(
        '[paths] CHODA_BACKEND=sync requires CHODA_PULL_REMOTE_URL and either ' +
          'CHODA_PULL_REMOTE_TOKEN (or MCP_HTTP_TOKEN) or the CHODA_SYNC_OIDC_* refresh creds'
      )
    }
    const intervalMs = Number.parseInt(process.env.CHODA_SYNC_INTERVAL_MS ?? '30000', 10)
    return {
      kind: 'sync',
      dbPath: dataPaths.dbPath,
      remoteUrl,
      remoteToken,
      intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30000,
      oauth
    }
  }
  if (kind !== 'sqlite') {
    throw new Error(`[paths] unknown CHODA_BACKEND="${kind}" — expected sqlite|postgres|sync`)
  }
  return { kind: 'sqlite', dbPath: dataPaths.dbPath }
}

// Read a value directly from `<NAME>`, or from a file pointed at by `<NAME>_FILE`
// (gitignored sensitive_information/ per the secret-handling rule). Returns ''
// when neither is set or the file is unreadable.
function envOrFile(name: string): string {
  const direct = process.env[name]
  if (direct !== undefined && direct.length > 0) return direct
  const file = process.env[`${name}_FILE`]
  if (file !== undefined && file.length > 0) {
    try {
      return fs.readFileSync(file, 'utf8').trim()
    } catch {
      return ''
    }
  }
  return ''
}

// TASK-1108 — resolve ROPC credentials for the sync client's Keycloak refresh
// flow. Falls back to the server-side MCP_OIDC_* names for issuer/client so a
// laptop pointed at its own remote can reuse them. OAuth mode engages only when
// issuer + clientId + username + password all resolve; otherwise undefined →
// the loop uses the static bearer (unchanged behavior).
export function resolveSyncOAuth(): SyncOAuthConfig | undefined {
  const issuer = envOrFile('CHODA_SYNC_OIDC_ISSUER') || (process.env.MCP_OIDC_ISSUER ?? '')
  const clientId = envOrFile('CHODA_SYNC_OIDC_CLIENT_ID') || (process.env.MCP_OIDC_CLIENT_ID ?? '')
  const username = envOrFile('CHODA_SYNC_OIDC_USERNAME')
  const password = envOrFile('CHODA_SYNC_OIDC_PASSWORD')
  if (!issuer || !clientId || !username || !password) return undefined
  // Confidential-client secret: sync-specific name, else the server-side
  // MCP_OIDC_CLIENT_SECRET[_FILE]. Empty → public client (omitted).
  const clientSecret =
    envOrFile('CHODA_SYNC_OIDC_CLIENT_SECRET') || envOrFile('MCP_OIDC_CLIENT_SECRET')
  return { issuer, clientId, username, password, clientSecret: clientSecret || undefined }
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
