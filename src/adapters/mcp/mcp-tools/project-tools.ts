import * as fs from 'node:fs'
import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import { buildProjectContext, type ProjectContextDeps } from './project-context-builder'
import type { ProjectOperations } from '../../../core/domain/interfaces/project-repository.interface'
import {
  PROJECT_PURPOSES,
  isProjectPurpose
} from '../../../core/domain/repositories/project-repository'
import type { WorkspaceOperations } from '../../../core/domain/interfaces/workspace-repository.interface'

export type ProjectToolsDeps = ProjectOperations & WorkspaceOperations & ProjectContextDeps

function purposeError(got: unknown): string {
  const allowed = PROJECT_PURPOSES.join(' | ')
  return got === undefined
    ? `purpose is required for a new project — one of ${allowed}`
    : `purpose must be one of ${allowed} (got "${String(got)}")`
}

export const register = (server: InstrumentedServer, svc: ProjectToolsDeps): void => {
  server.registerTool(
    'project_add',
    {
      description:
        'Add a new project (or update existing). A project owns tasks, conversations, sessions. On an existing project only `org` is updated; name and cwd stay as first registered — use project_update to change them.',
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
          ),
        purpose: z
          .enum(PROJECT_PURPOSES)
          .optional()
          .describe(
            'What the project gives you: income | reputation | fun. Required for a new project; omit on an existing one to leave it unchanged.'
          )
      }
    },
    async ({ id, name, cwd, org, purpose }) => {
      // TASK-3128 — rule 4 of personal-operating-rules: a new project must say what it gives.
      if (purpose !== undefined && !isProjectPurpose(purpose)) {
        return textResponse({ ok: false, error: purposeError(purpose) })
      }
      if (purpose === undefined && !(await svc.getProject(id))) {
        return textResponse({ ok: false, error: purposeError(undefined) })
      }
      await svc.ensureProject(id, name, cwd, org, purpose)
      return textResponse(await svc.getProject(id))
    }
  )

  server.registerTool(
    'project_update',
    {
      description:
        'Change an existing project\'s cwd, name and/or purpose in place — e.g. after the repo folder was moved. project_add never touches cwd or name on an existing project. Warns when the new cwd does not exist on disk.',
      inputSchema: {
        id: z.string().describe('Project ID'),
        cwd: z.string().min(1).optional().describe('New default working directory'),
        name: z.string().min(1).optional().describe('New display name'),
        purpose: z
          .enum(PROJECT_PURPOSES)
          .optional()
          .describe('What the project gives you: income | reputation | fun')
      }
    },
    async ({ id, cwd, name, purpose }) => {
      if (cwd === undefined && name === undefined && purpose === undefined) {
        return textResponse({ ok: false, error: 'Pass cwd, name and/or purpose' })
      }
      if (purpose !== undefined && !isProjectPurpose(purpose)) {
        return textResponse({ ok: false, error: purposeError(purpose) })
      }
      const updated = await svc.updateProject(id, { cwd, name, purpose })
      if (!updated) return textResponse({ ok: false, error: `Project ${id} not found` })
      const cwdExists = cwd === undefined || fs.existsSync(cwd)
      return textResponse({
        project: updated,
        warning: cwdExists ? null : `cwd ${cwd} not found on disk`
      })
    }
  )

  server.registerTool(
    'project_list',
    {
      description:
        'List all projects with their workspaces. Pass org to list one organisation only; missingPurpose=true lists only projects with no purpose yet.',
      inputSchema: {
        org: z.string().min(1).optional().describe('Only projects of this organisation'),
        missingPurpose: z
          .boolean()
          .optional()
          .describe('Only projects whose purpose is not set (rule 4 of personal-operating-rules)')
      }
    },
    async ({ org, missingPurpose }) => {
      const all = await svc.listProjects(org)
      const projects = missingPurpose ? all.filter((p) => p.purpose === null) : all
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
