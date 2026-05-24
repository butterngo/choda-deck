// ADR-030 — single construction point for the storage backend. Every
// consumer (CLI, MCP server, tests) routes through this factory so adding
// a new backend kind only touches one file.

import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from './sqlite-task-service'
import { PostgresTaskService } from './postgres-task-service'
import { PgConnection } from './repositories/postgres/connection'
import type { BackendTaskService } from './backend-task-service.interface'
import type { BackendConfig } from '../backend-config'

export function createTaskService(config: BackendConfig): BackendTaskService {
  switch (config.kind) {
    case 'sqlite':
      fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
      return new SqliteTaskService(config.dbPath)
    case 'postgres': {
      const poolSize = Number(process.env.CHODA_PG_POOL_SIZE ?? '10')
      const conn = new PgConnection({
        connectionString: config.connectionString,
        max: Number.isFinite(poolSize) && poolSize > 0 ? poolSize : 10
      })
      return new PostgresTaskService(conn)
    }
    default: {
      const exhaustive: never = config
      throw new Error(`Unknown backend kind: ${JSON.stringify(exhaustive)}`)
    }
  }
}
