import type { ProjectRow } from '../repositories/project-repository'

export interface ProjectOperations {
  ensureProject(id: string, name: string, cwd: string): Promise<void>
  getProject(id: string): Promise<ProjectRow | null>
  listProjects(): Promise<ProjectRow[]>
}
