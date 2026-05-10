import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import { resolveDataPaths } from '../../core/paths'

export interface CliServices {
  svc: SqliteTaskService
  dbPath: string
  dataDir: string
  artifactsDir: string
}

export async function createCliServices(): Promise<CliServices> {
  const { dbPath, dataDir, artifactsDir } = resolveDataPaths()
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const svc = new SqliteTaskService(dbPath)
  await svc.initializeAsync()
  return { svc, dbPath, dataDir, artifactsDir }
}
