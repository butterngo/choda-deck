import * as fs from 'node:fs'
import { z } from 'zod'
import type { InstrumentedServer } from '../instrumented-server'
import { textResponse } from './types'
import { isLikelyWorktreePath } from '../../../core/worktree-path'
import type { ProjectOperations } from '../../../core/domain/interfaces/project-repository.interface'
import type { WorkspaceOperations } from '../../../core/domain/interfaces/workspace-repository.interface'
import type { KnowledgeOperations } from '../../../core/domain/interfaces/knowledge-operations.interface'

export type CleanupToolsDeps = ProjectOperations & WorkspaceOperations & KnowledgeOperations

const KNOWLEDGE_ACTION_ENUM = ['delete', 'leave'] as const
type KnowledgeAction = (typeof KNOWLEDGE_ACTION_ENUM)[number]

interface OrphanWorkspace {
  id: string
  label: string
  cwd: string
}

interface OrphanKnowledge {
  slug: string
  filePath: string
  workspaceId: string | null
}

interface CleanupResult {
  dryRun: boolean
  knowledgeAction: KnowledgeAction
  archivedWorkspaces: OrphanWorkspace[]
  deletedKnowledge: OrphanKnowledge[]
  leftKnowledge: OrphanKnowledge[]
  candidates: {
    workspaces: OrphanWorkspace[]
    knowledge: OrphanKnowledge[]
  }
}

export const register = (server: InstrumentedServer, svc: CleanupToolsDeps): void => {
  server.registerTool(
    'cleanup_worktree_orphans',
    {
      description:
        'Detect and clean orphan workspaces + knowledge entries left by deleted git worktrees. ' +
        'Detection: cwd / filePath matches `.worktrees` segment AND the path no longer exists on disk. ' +
        'Default dry-run — pass dryRun=false to mutate. Workspaces are archived (idempotent); ' +
        'knowledge action is configurable: `delete` removes the row + INDEX entry, `leave` (default) ' +
        'reports them for manual recovery without mutating.',
      inputSchema: {
        projectId: z.string().describe('Project ID to scan'),
        dryRun: z
          .boolean()
          .optional()
          .describe('Default true — list candidates without mutating. Pass false to apply.'),
        knowledgeAction: z
          .enum(KNOWLEDGE_ACTION_ENUM)
          .optional()
          .describe('How to handle orphan knowledge when not dry-run. Default `leave`.')
      }
    },
    async ({ projectId, dryRun, knowledgeAction }) => {
      const project = await svc.getProject(projectId)
      if (!project) return textResponse(`Project ${projectId} not found`)

      const isDryRun = dryRun ?? true
      const action: KnowledgeAction = knowledgeAction ?? 'leave'

      const allWorkspaces = await svc.findWorkspaces(projectId, false)
      const orphanWorkspaces: OrphanWorkspace[] = allWorkspaces
        .filter((ws) => isLikelyWorktreePath(ws.cwd) && !fs.existsSync(ws.cwd))
        .map((ws) => ({ id: ws.id, label: ws.label, cwd: ws.cwd }))

      const allKnowledge = await svc.listKnowledge({ projectId })
      const orphanKnowledge: OrphanKnowledge[] = allKnowledge
        .filter((k) => isLikelyWorktreePath(k.filePath) && !fs.existsSync(k.filePath))
        .map((k) => ({ slug: k.slug, filePath: k.filePath, workspaceId: k.workspaceId }))

      const candidates = { workspaces: orphanWorkspaces, knowledge: orphanKnowledge }

      if (isDryRun) {
        const result: CleanupResult = {
          dryRun: true,
          knowledgeAction: action,
          archivedWorkspaces: [],
          deletedKnowledge: [],
          leftKnowledge: [],
          candidates
        }
        return textResponse(result)
      }

      const archivedWorkspaces: OrphanWorkspace[] = []
      for (const ws of orphanWorkspaces) {
        const archived = await svc.archiveWorkspace(ws.id)
        if (archived) archivedWorkspaces.push(ws)
      }

      const deletedKnowledge: OrphanKnowledge[] = []
      const leftKnowledge: OrphanKnowledge[] = []
      if (action === 'delete') {
        for (const k of orphanKnowledge) {
          await svc.deleteKnowledge(k.slug)
          deletedKnowledge.push(k)
        }
      } else {
        for (const k of orphanKnowledge) leftKnowledge.push(k)
      }

      const result: CleanupResult = {
        dryRun: false,
        knowledgeAction: action,
        archivedWorkspaces,
        deletedKnowledge,
        leftKnowledge,
        candidates
      }
      return textResponse(result)
    }
  )
}
