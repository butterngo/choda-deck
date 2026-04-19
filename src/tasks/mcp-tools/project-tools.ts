import { z } from 'zod'
import { textResponse, type Register } from './types'
import { buildProjectContext } from './project-context-builder'

export const register: Register = (server, svc) => {
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
    'workspace_add',
    {
      description: 'Add a workspace to a project. A workspace = a terminal/cwd (e.g. BE, FE).',
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
      const ws = svc.addWorkspace(projectId, id, label, cwd)
      return textResponse(ws)
    }
  )

  server.registerTool(
    'project_context',
    {
      description:
        'Compile full project context: identity, current state (active phase + tasks + last session + open conversations), architecture, conventions, recent decisions, and the list of context sources used',
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
