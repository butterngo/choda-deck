import type { ProjectRow, RemoveProjectResult } from '../repositories/project-repository'

export interface ProjectOperations {
  ensureProject(id: string, name: string, cwd: string, org?: string | null): Promise<void>
  getProject(id: string): Promise<ProjectRow | null>
  listProjects(org?: string): Promise<ProjectRow[]>
  removeProject(id: string): Promise<RemoveProjectResult>
}
