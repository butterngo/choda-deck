import type { WorkspaceRow } from '../repositories/workspace-repository'

export interface WorkspaceOperations {
  addWorkspace(projectId: string, id: string, label: string, cwd: string): WorkspaceRow
  getWorkspace(id: string): WorkspaceRow | null
  findWorkspaces(projectId: string): WorkspaceRow[]
}
