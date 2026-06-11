// ADR-030 — single construction point for the storage backend.
//
// Standing rule (2026-05-28, ADR-026 §Per-tool scoping): Postgres is only
// usable behind the HTTP transport. The narrow PG facade implements
// RemoteOperations (subset of BackendTaskService) — calls to deleted methods
// (sessions, knowledge, memory, etc.) would throw at runtime. The
// REMOTE_TOOL_ALLOWLIST registered in server-bootstrap ensures no remote tool
// ever invokes those methods; the `requireBackendForTransport` guard
// short-circuits any attempt to pair PG with stdio at boot time.

import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from './sqlite-task-service'
import { PostgresTaskService } from './postgres-task-service'
import { PgConnection } from './repositories/postgres/connection'
import type { BackendTaskService } from './backend-task-service.interface'
import type { BackendConfig } from '../backend-config'
import { HttpWriteClient } from '../sync/http-write-client'
import { wrapWithSyncWriteThrough } from '../sync/sync-write-through'

export function createTaskService(config: BackendConfig): BackendTaskService {
  switch (config.kind) {
    case 'sqlite':
      fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
      return new SqliteTaskService(config.dbPath)
    case 'sync': {
      // Local SQLite + write-through to the remote. The drain/pull loop is
      // started separately by server-bootstrap (a timer doesn't belong in the
      // shared factory, which the CLI also uses). Write-through itself is
      // synchronous per tool call and lives in the returned wrapper.
      fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
      const svc = new SqliteTaskService(config.dbPath)
      const client = new HttpWriteClient({ remoteUrl: config.remoteUrl, token: config.remoteToken })
      return wrapWithSyncWriteThrough(svc, client)
    }
    case 'postgres': {
      const poolSize = Number(process.env.CHODA_PG_POOL_SIZE ?? '10')
      const conn = new PgConnection({
        connectionString: config.connectionString,
        max: Number.isFinite(poolSize) && poolSize > 0 ? poolSize : 10
      })
      // Narrow facade — implements only RemoteOperations. The cast is safe
      // because the only call sites with `BackendTaskService`-shaped access
      // are stdio tool handlers, and `requireBackendForTransport` rejects
      // postgres+stdio at boot. HTTP handlers reach the facade only through
      // the 6-tool allowlist, all of which stay within RemoteOperations.
      return new PostgresTaskService(conn) as unknown as BackendTaskService
    }
    default: {
      const exhaustive: never = config
      throw new Error(`Unknown backend kind: ${JSON.stringify(exhaustive)}`)
    }
  }
}

// Boot-time guard — fail fast if someone configures PG with stdio.
// Called by server-bootstrap before service construction.
export function requireBackendForTransport(
  backend: BackendConfig,
  transport: 'stdio' | 'http'
): void {
  if (backend.kind === 'postgres' && transport === 'stdio') {
    process.stderr.write(
      '[choda-deck] CHODA_BACKEND=postgres is not allowed with MCP_TRANSPORT=stdio — ' +
        'the PG adapter implements only RemoteOperations (subset of BackendTaskService) ' +
        'per ADR-026 §Per-tool scoping. Use sqlite for stdio, postgres for http.\n'
    )
    process.exit(2)
  }
  // ADR-030 Phase 3-6: sync is the laptop driving a remote — it is a stdio
  // client by definition. Serving HTTP from a sync backend would mean a node
  // both accepts pushes and pushes elsewhere; not a supported topology.
  if (backend.kind === 'sync' && transport === 'http') {
    process.stderr.write(
      '[choda-deck] CHODA_BACKEND=sync is not allowed with MCP_TRANSPORT=http — ' +
        'sync is the laptop (stdio) write-through client. Use postgres for the http server.\n'
    )
    process.exit(2)
  }
}
