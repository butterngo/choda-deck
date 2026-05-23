import { createTaskService } from '../../core/domain/task-service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { resolveBackendConfig, resolveDataPaths } from '../../core/paths'

export interface CliServices {
  svc: BackendTaskService
  dbPath: string
  dataDir: string
  artifactsDir: string
}

export async function createCliServices(): Promise<CliServices> {
  const dataPaths = resolveDataPaths()
  const backend = resolveBackendConfig(dataPaths)
  const svc = createTaskService(backend)
  await svc.initializeAsync()
  return {
    svc,
    dbPath: dataPaths.dbPath,
    dataDir: dataPaths.dataDir,
    artifactsDir: dataPaths.artifactsDir
  }
}
