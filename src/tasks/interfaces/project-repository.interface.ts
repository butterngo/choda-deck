import type { ProjectRow, WorkspaceRow } from '../repositories/project-repository'

export interface ProjectOperations {
  ensureProject(id: string, name: string, cwd: string): void
  getProject(id: string): ProjectRow | null
  listProjects(): ProjectRow[]
}

export interface WorkspaceOperations {
  addWorkspace(projectId: string, id: string, label: string, cwd: string): WorkspaceRow
  getWorkspace(id: string): WorkspaceRow | null
  findWorkspaces(projectId: string): WorkspaceRow[]
}
