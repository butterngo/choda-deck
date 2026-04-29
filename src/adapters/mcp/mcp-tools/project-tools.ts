import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { textResponse } from './types'
import { buildProjectContext, type ProjectContextDeps } from './project-context-builder'
import type { ProjectOperations } from '../../../core/domain/interfaces/project-repository.interface'
import type { WorkspaceOperations } from '../../../core/domain/interfaces/workspace-repository.interface'

export type ProjectToolsDeps = ProjectOperations & WorkspaceOperations & ProjectContextDeps

export const register = (server: McpServer, svc: ProjectToolsDeps): void => {
  server.registerTool(
    'project_add',
    {
      description:
        'Add a new project (or update existing). A project owns tasks, conversations, sessions.',
      inputSchema: {
        id: z.string().describe('Project ID (kebab-case, e.g. automation-rule)'),
        name: z.string().describe('Display name'),
        cwd: z.string().describe('Default working directory')
      }
    },
    async ({ id, name, cwd }) => {
      svc.ensureProject(id, name, cwd)
      return textResponse({ id, name, cwd })
    }
  )

  server.registerTool(
    'project_list',
    {
      description: 'List all projects with their workspaces',
      inputSchema: {}
    },
    async () => {
      const projects = svc.listProjects()
      const result = projects.map((p) => ({
        ...p,
        workspaces: svc.findWorkspaces(p.id)
      }))
      return textResponse(result)
    }
  )

  server.registerTool(
    'project_context',
    {
      description:
        'Compile full project context: identity, current state (active tasks + last session + open conversations), architecture, conventions, recent decisions, and the list of context sources used',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        depth: z
          .enum(['summary', 'full'])
          .optional()
          .describe('full (default) or summary (truncated)')
      }
    },
    async ({ projectId, depth }) => {
      const bundle = buildProjectContext(svc, projectId, depth ?? 'full')
      if (!bundle) return textResponse(`Project ${projectId} not found`)
      return textResponse(bundle)
    }
  )
}
