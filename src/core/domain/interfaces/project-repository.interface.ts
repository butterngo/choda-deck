import type { ProjectRow } from '../repositories/project-repository'

export interface ProjectOperations {
  ensureProject(id: string, name: string, cwd: string): void
  getProject(id: string): ProjectRow | null
  listProjects(): ProjectRow[]
}
