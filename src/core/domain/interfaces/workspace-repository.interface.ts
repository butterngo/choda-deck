import type { WorkspacePatch, WorkspaceRow } from '../repositories/workspace-repository'

export interface WorkspaceOperations {
  addWorkspace(projectId: string, id: string, label: string, cwd: string): Promise<WorkspaceRow>
  getWorkspace(id: string): Promise<WorkspaceRow | null>
  findWorkspaces(projectId: string, includeArchived?: boolean): Promise<WorkspaceRow[]>
  updateWorkspace(id: string, patch: WorkspacePatch): Promise<WorkspaceRow | null>
  archiveWorkspace(id: string): Promise<WorkspaceRow | null>
  unarchiveWorkspace(id: string): Promise<WorkspaceRow | null>
}
