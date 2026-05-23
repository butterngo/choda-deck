// ADR-030 — single construction point for the storage backend. Every
// consumer (CLI, MCP server, tests) routes through this factory so adding
// a new backend kind only touches one file.

import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from './sqlite-task-service'
import type { BackendTaskService } from './backend-task-service.interface'
import { BackendNotImplementedError, type BackendConfig } from '../backend-config'

export function createTaskService(config: BackendConfig): BackendTaskService {
  switch (config.kind) {
    case 'sqlite':
      fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
      return new SqliteTaskService(config.dbPath)
    case 'postgres':
      throw new BackendNotImplementedError(config.kind)
    default: {
      const exhaustive: never = config
      throw new Error(`Unknown backend kind: ${JSON.stringify(exhaustive)}`)
    }
  }
}
