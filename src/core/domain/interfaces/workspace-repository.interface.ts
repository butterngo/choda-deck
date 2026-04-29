import type { WorkspaceReferenceCounts, WorkspaceRow } from '../repositories/workspace-repository'

export interface WorkspaceOperations {
  addWorkspace(projectId: string, id: string, label: string, cwd: string): WorkspaceRow
  getWorkspace(id: string): WorkspaceRow | null
  findWorkspaces(projectId: string, includeArchived?: boolean): WorkspaceRow[]
  archiveWorkspace(id: string): WorkspaceRow | null
  unarchiveWorkspace(id: string): WorkspaceRow | null
  deleteWorkspace(id: string): void
  countWorkspaceReferences(id: string): WorkspaceReferenceCounts
}
