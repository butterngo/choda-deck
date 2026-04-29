import * as fs from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { textResponse } from './types'
import type { ProjectOperations } from '../../../core/domain/interfaces/project-repository.interface'
import type { WorkspaceOperations } from '../../../core/domain/interfaces/workspace-repository.interface'

export type WorkspaceToolsDeps = ProjectOperations & WorkspaceOperations

export const register = (server: McpServer, svc: WorkspaceToolsDeps): void => {
  server.registerTool(
    'workspace_list',
    {
      description:
        'List workspaces for a project. Defaults to active only — pass includeArchived to show all.',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        includeArchived: z
          .boolean()
          .optional()
          .describe('Include archived workspaces (default false)')
      }
    },
    async ({ projectId, includeArchived }) => {
      const project = svc.getProject(projectId)
      if (!project) return textResponse(`Project ${projectId} not found`)
      return textResponse(svc.findWorkspaces(projectId, includeArchived ?? false))
    }
  )

  server.registerTool(
    'workspace_add',
    {
      description:
        'Add a workspace to a project. A workspace = a terminal/cwd (e.g. BE, FE, worktree). Rejects duplicate id. Warns when cwd does not exist on disk.',
      inputSchema: {
        projectId: z.string().describe('Parent project ID'),
        id: z.string().describe('Workspace ID (e.g. workflow-engine)'),
        label: z.string().describe('Short label (e.g. BE, FE, Main)'),
        cwd: z.string().describe('Working directory path')
      }
    },
    async ({ projectId, id, label, cwd }) => {
      const project = svc.getProject(projectId)
      if (!project) return textResponse(`Project ${projectId} not found`)
      const existing = svc.getWorkspace(id)
      if (existing) {
        return textResponse(
          `Workspace ${id} already exists (project ${existing.projectId}) — use workspace_archive or pick a different id`
        )
      }
      const ws = svc.addWorkspace(projectId, id, label, cwd)
      const cwdExists = fs.existsSync(cwd)
      return textResponse({ workspace: ws, warning: cwdExists ? null : `cwd ${cwd} not found on disk` })
    }
  )

  server.registerTool(
    'workspace_archive',
    {
      description:
        'Soft-delete a workspace: hides it from default listings while preserving session/conversation history. Idempotent — re-archiving a workspace returns its existing archivedAt.',
      inputSchema: {
        projectId: z.string().describe('Parent project ID'),
        workspaceId: z.string().describe('Workspace ID to archive')
      }
    },
    async ({ projectId, workspaceId }) => {
      const result = archiveOrError(svc, projectId, workspaceId)
      return textResponse(result)
    }
  )

  server.registerTool(
    'workspace_remove',
    {
      description:
        'Remove a workspace. Default soft (archive). Pass hard=true for permanent DELETE — rejected if any sessions still reference the workspace.',
      inputSchema: {
        projectId: z.string().describe('Parent project ID'),
        workspaceId: z.string().describe('Workspace ID to remove'),
        hard: z
          .boolean()
          .optional()
          .describe('true = permanent DELETE (rejected if referenced); default false = soft archive')
      }
    },
    async ({ projectId, workspaceId, hard }) => {
      if (!hard) {
        return textResponse(archiveOrError(svc, projectId, workspaceId))
      }
      const ws = svc.getWorkspace(workspaceId)
      if (!ws) return textResponse(`Workspace ${workspaceId} not found`)
      if (ws.projectId !== projectId) {
        return textResponse(
          `Workspace ${workspaceId} belongs to project ${ws.projectId}, not ${projectId}`
        )
      }
      const refs = svc.countWorkspaceReferences(workspaceId)
      if (refs.sessions > 0) {
        return textResponse(
          `Cannot hard-delete workspace ${workspaceId} — ${refs.sessions} session(s) still reference it. Use workspace_archive instead.`
        )
      }
      svc.deleteWorkspace(workspaceId)
      return textResponse({ ok: true, hard: true })
    }
  )
}

function archiveOrError(
  svc: WorkspaceToolsDeps,
  projectId: string,
  workspaceId: string
): { ok: true; archivedAt: string } | { ok: false; error: string } {
  const ws = svc.getWorkspace(workspaceId)
  if (!ws) return { ok: false, error: `Workspace ${workspaceId} not found` }
  if (ws.projectId !== projectId) {
    return {
      ok: false,
      error: `Workspace ${workspaceId} belongs to project ${ws.projectId}, not ${projectId}`
    }
  }
  const archived = svc.archiveWorkspace(workspaceId)
  if (!archived || !archived.archivedAt) {
    return { ok: false, error: `Failed to archive workspace ${workspaceId}` }
  }
  return { ok: true, archivedAt: archived.archivedAt }
}
