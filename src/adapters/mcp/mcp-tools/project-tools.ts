import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import { buildProjectContext, type ProjectContextDeps } from './project-context-builder'
import type { ProjectOperations } from '../../../core/domain/interfaces/project-repository.interface'
import type { WorkspaceOperations } from '../../../core/domain/interfaces/workspace-repository.interface'

export type ProjectToolsDeps = ProjectOperations & WorkspaceOperations & ProjectContextDeps

export const register = (server: InstrumentedServer, svc: ProjectToolsDeps): void => {
  server.registerTool(
    'project_add',
    {
      description:
        'Add a new project (or update existing). A project owns tasks, conversations, sessions. On an existing project only `org` is updated; name and cwd stay as first registered.',
      inputSchema: {
        id: z.string().describe('Project ID (kebab-case, e.g. automation-rule)'),
        name: z.string().describe('Display name'),
        cwd: z.string().describe('Default working directory'),
        org: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe(
            'Organisation the project belongs to (e.g. ichiba, mantu, personal). Omit to leave it unchanged; null clears it.'
          )
      }
    },
    async ({ id, name, cwd, org }) => {
      await svc.ensureProject(id, name, cwd, org)
      return textResponse(await svc.getProject(id))
    }
  )

  server.registerTool(
    'project_list',
    {
      description: 'List all projects with their workspaces. Pass org to list one organisation only.',
      inputSchema: {
        org: z.string().min(1).optional().describe('Only projects of this organisation')
      }
    },
    async ({ org }) => {
      const projects = await svc.listProjects(org)
      const result = await Promise.all(
        projects.map(async (p) => ({
          ...p,
          workspaces: await svc.findWorkspaces(p.id)
        }))
      )
      return textResponse(result)
    }
  )

  // TASK-2200 — stdio-only (absent from REMOTE_TOOL_ALLOWLIST). Removes a project
  // nothing uses; refuses, deleting nothing, while it still owns any row.
  server.registerTool(
    'project_remove',
    {
      description:
        'Remove a project and its workspaces. Refused, with nothing deleted, while the project still has tasks, sessions, conversations, inbox items, knowledge, documents, context sources or code refs.',
      inputSchema: {
        id: z.string().describe('Project ID')
      }
    },
    async ({ id }) => {
      const result = await svc.removeProject(id)
      if (result.removed) return textResponse({ id, ...result })
      if (result.reason === 'not-found') return textResponse(`Project ${id} not found`)
      const detail = Object.entries(result.blockers)
        .map(([table, n]) => `${table}: ${n}`)
        .join(', ')
      return textResponse(`Project ${id} is in use and was not removed (${detail})`)
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
      const bundle = await buildProjectContext(svc, projectId, depth ?? 'full')
      if (!bundle) return textResponse(`Project ${projectId} not found`)
      return textResponse(bundle)
    }
  )
}
