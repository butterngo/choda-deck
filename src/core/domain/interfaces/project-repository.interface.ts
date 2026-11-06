import type {
  ProjectPatch,
  ProjectPurpose,
  ProjectRow,
  RemoveProjectResult
} from '../repositories/project-repository'

export interface ProjectOperations {
  ensureProject(
    id: string,
    name: string,
    cwd: string,
    org?: string | null,
    purpose?: ProjectPurpose
  ): Promise<void>
  updateProject(id: string, patch: ProjectPatch): Promise<ProjectRow | null>
  getProject(id: string): Promise<ProjectRow | null>
  listProjects(org?: string): Promise<ProjectRow[]>
  removeProject(id: string): Promise<RemoveProjectResult>
}
