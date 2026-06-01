import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import type { CodeRefOperations } from '../../../core/domain/interfaces/code-ref-operations.interface'
import type { TouchesRelation } from '../../../core/domain/code-ref-types'

const RELATION_ENUM = ['modifies', 'reference'] as const

// TASK-988 (ADR-NNN unified knowledge graph) — code_ref identity rows + TOUCHES
// edges. Distinct from knowledge_* tools: a code_ref note (.md) lives in
// knowledge_index for human reading; THESE tools manage the queryable identity
// row (project_id, path, symbol) and the task→code_ref TOUCHES edges.
export const register = (server: InstrumentedServer, svc: CodeRefOperations): void => {
  server.registerTool(
    'code_ref_upsert',
    {
      description:
        'Create or re-pin a code_ref identity row. Identity is (projectId, path, symbol) — symbol is NULL for file-level refs (.tsx/.md/migrations). A write matching an existing identity UPDATEs commit_sha / line_hint on the original slug instead of inserting a duplicate (ADR Pillar 2c). Returns the stored row.',
      inputSchema: {
        slug: z.string().describe('Slug for a NEW row (ignored when the identity already exists)'),
        projectId: z.string().describe('Project ID'),
        workspaceId: z.string().optional().describe('Workspace (app) the anchor lives in'),
        path: z.string().describe('Repo-relative file path'),
        symbol: z
          .string()
          .optional()
          .describe('Full dotted symbol (Namespace.Class.Method). Omit for file-level refs.'),
        lineHint: z.number().int().optional().describe('Optional line hint — not trustworthy over time'),
        commitSha: z.string().optional().describe('Commit SHA captured at write time')
      }
    },
    async ({ slug, projectId, workspaceId, path, symbol, lineHint, commitSha }) =>
      textResponse(
        await svc.upsertCodeRef({ slug, projectId, workspaceId, path, symbol, lineHint, commitSha })
      )
  )

  server.registerTool(
    'code_ref_prefix',
    {
      description:
        'Query code_ref rows by dotted-symbol prefix (e.g. all Domain-layer anchors via symbolPrefix="Ichiba.Pim.TradingCatalog.Domain."), by exact path ("who anchors this file"), or list a whole project. Returns identity rows, not the .md notes.',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        symbolPrefix: z.string().optional().describe('Match symbols starting with this prefix'),
        path: z.string().optional().describe('Exact repo-relative path filter')
      }
    },
    async ({ projectId, symbolPrefix, path }) =>
      textResponse(await svc.listCodeRefsByPrefix({ projectId, symbolPrefix, path }))
  )

  server.registerTool(
    'code_ref_delete',
    {
      description:
        'Delete a code_ref identity row by slug. Also removes its TOUCHES edges. The matching .md note (if any) is managed separately via knowledge_delete.',
      inputSchema: {
        slug: z.string().describe('Slug of the code_ref row to delete')
      }
    },
    async ({ slug }) => {
      await svc.deleteCodeRef(slug)
      return textResponse({ slug, deleted: true })
    }
  )

  server.registerTool(
    'touches_add',
    {
      description:
        'Add (or update) a TOUCHES edge: task → code_ref with a required relation. "modifies" = the task edits the anchor; "reference" = the task reads it as a pattern. Re-adding the same (task, code_ref) pair overwrites the relation.',
      inputSchema: {
        taskId: z.string().describe('Task ID'),
        codeRefSlug: z.string().describe('Slug of an existing code_ref row'),
        relation: z.enum(RELATION_ENUM).describe('modifies | reference')
      }
    },
    async ({ taskId, codeRefSlug, relation }) => {
      await svc.addTouches(taskId, codeRefSlug, relation as TouchesRelation)
      return textResponse({ taskId, codeRefSlug, relation })
    }
  )

  server.registerTool(
    'touches_remove',
    {
      description: 'Remove a TOUCHES edge between a task and a code_ref.',
      inputSchema: {
        taskId: z.string().describe('Task ID'),
        codeRefSlug: z.string().describe('Slug of the code_ref row')
      }
    },
    async ({ taskId, codeRefSlug }) => {
      await svc.removeTouches(taskId, codeRefSlug)
      return textResponse({ taskId, codeRefSlug, removed: true })
    }
  )

  server.registerTool(
    'task_touches',
    {
      description:
        'List the TOUCHES edges for a task — every code_ref it modifies or references, with the relation. Use before starting a task to see which code anchors it will edit vs. read.',
      inputSchema: {
        taskId: z.string().describe('Task ID')
      }
    },
    async ({ taskId }) => textResponse(await svc.getTouchesForTask(taskId))
  )
}
