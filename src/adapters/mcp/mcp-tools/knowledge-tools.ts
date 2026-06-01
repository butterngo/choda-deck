import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import type { KnowledgeOperations } from '../../../core/domain/interfaces/knowledge-operations.interface'
import type { KnowledgeScope, KnowledgeType } from '../../../core/domain/knowledge-types'

const TYPE_ENUM = [
  'spike',
  'decision',
  'postmortem',
  'learning',
  'evaluation',
  'feature',
  'code_ref',
  'gotcha'
] as const
const SCOPE_ENUM = ['project', 'cross'] as const
const EFFORT_BAND_ENUM = ['S', 'M', 'L', 'XL'] as const
const FEATURE_STATUS_ENUM = ['planned', 'in-progress', 'shipped', 'blocked'] as const

export const register = (server: InstrumentedServer, svc: KnowledgeOperations): void => {
  server.registerTool(
    'knowledge_create',
    {
      description:
        'Create a knowledge entry. Original types (spike/decision/postmortem/learning/evaluation) capture findings/ADRs. First-class graph types (TASK-988): feature (a user-perceivable outcome — set structured.anchorTaskId/realizesTasks/inWorkspaces/effortBand/status), code_ref (a code anchor note — pair with the code_ref_upsert tool for the queryable identity row), gotcha (a concern — set structured.affectedFeatureId pointing at an existing feature slug). Project-scope writes to <projectCwd>/docs/knowledge/<slug>.md and tracks staleness against refs[]. When workspaceId is provided, the file is written to <workspaceCwd>/docs/knowledge/<slug>.md instead (workspace must belong to projectId). Cross-scope writes to vault/30-Knowledge/<slug>.md (no staleness).',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        workspaceId: z
          .string()
          .optional()
          .describe(
            'Workspace ID — when set, file is written to <workspaceCwd>/docs/knowledge/. Workspace must belong to projectId.'
          ),
        type: z.enum(TYPE_ENUM).describe('Entry kind'),
        scope: z.enum(SCOPE_ENUM).describe('project = code-coupled, cross = abstract concept'),
        title: z.string().describe('Human-readable title'),
        body: z.string().describe('Markdown body (no frontmatter — service adds it)'),
        refs: z
          .array(
            z.object({
              path: z.string().describe('Repo-relative file path'),
              commitSha: z
                .string()
                .optional()
                .describe('Pin SHA. Omit to auto-capture current HEAD.')
            })
          )
          .optional()
          .describe('Code references for staleness tracking. Empty/omitted = no tracking.'),
        slug: z.string().optional().describe('Override auto-derived slug'),
        structured: z
          .object({
            anchorTaskId: z.string().optional().describe('feature: epic-shape task it was promoted from'),
            realizesTasks: z
              .array(z.string())
              .optional()
              .describe('feature: task ids that implement/modify it'),
            inWorkspaces: z.array(z.string()).optional().describe('feature: workspaces it touches'),
            effortBand: z
              .enum(EFFORT_BAND_ENUM)
              .optional()
              .describe('feature: S|M|L|XL band (NOT a day count)'),
            status: z
              .enum(FEATURE_STATUS_ENUM)
              .optional()
              .describe('feature: planned|in-progress|shipped|blocked'),
            affectedFeatureId: z
              .string()
              .optional()
              .describe('gotcha: slug of the feature this concern is about (must exist)')
          })
          .optional()
          .describe('Structured fields for feature / gotcha first-class types (TASK-988).')
      }
    },
    async ({ projectId, workspaceId, type, scope, title, body, refs, slug, structured }) =>
      textResponse(
        svc.createKnowledge({
          projectId,
          workspaceId,
          type: type as KnowledgeType,
          scope: scope as KnowledgeScope,
          title,
          body,
          refs: refs ?? [],
          slug,
          structured
        })
      )
  )

  server.registerTool(
    'knowledge_register_existing',
    {
      description:
        'Register a pre-existing knowledge MD file into the index (does NOT create or modify the file). The file must already have valid frontmatter — type, title, projectId, scope, createdAt, lastVerifiedAt. Use this to ingest ADRs that live in a repo before choda-deck started indexing it (e.g. backfilling workflow-engine ADRs into an automation-rule workspace). Upserts on slug — re-running with the same file is a no-op.',
      inputSchema: {
        filePath: z.string().describe('Absolute path to the existing .md file'),
        projectId: z
          .string()
          .describe('Project ID — must match the frontmatter projectId on the file'),
        workspaceId: z
          .string()
          .optional()
          .describe(
            'Workspace ID — required when the file lives under a workspace cwd rather than the project cwd. Workspace must belong to projectId.'
          )
      }
    },
    async ({ filePath, projectId, workspaceId }) =>
      textResponse(svc.registerExistingKnowledge({ filePath, projectId, workspaceId }))
  )

  server.registerTool(
    'knowledge_get',
    {
      description:
        'Read a knowledge entry by slug. Returns frontmatter + body + per-ref staleness (commits since pinned SHA). isStale=true if any ref has drifted.',
      inputSchema: {
        slug: z.string().describe('Slug of the entry')
      }
    },
    async ({ slug }) => {
      const entry = svc.getKnowledge(slug)
      if (!entry) return textResponse(`Knowledge ${slug} not found`)
      return textResponse(entry)
    }
  )

  server.registerTool(
    'knowledge_list',
    {
      description:
        'List knowledge entries from the index. Body not loaded — use knowledge_get for content. workspaceId="" filters to project-level entries only (workspace_id IS NULL).',
      inputSchema: {
        projectId: z.string().optional().describe('Filter by project'),
        workspaceId: z
          .string()
          .optional()
          .describe(
            'Filter by workspace. Pass empty string to match project-level only (workspace_id IS NULL); omit to return rows across all workspaces.'
          ),
        scope: z.enum(SCOPE_ENUM).optional().describe('Filter by scope'),
        type: z.enum(TYPE_ENUM).optional().describe('Filter by type')
      }
    },
    async ({ projectId, workspaceId, scope, type }) =>
      textResponse(
        svc.listKnowledge({
          projectId,
          workspaceId: workspaceId === '' ? null : workspaceId,
          scope: scope as KnowledgeScope | undefined,
          type: type as KnowledgeType | undefined
        })
      )
  )

  server.registerTool(
    'knowledge_update',
    {
      description:
        'Edit a knowledge entry — replace body and/or refs. Auto-bumps lastVerifiedAt to today and re-pins refs to current HEAD (no separate knowledge_verify call needed). At least one of body/refs must be provided. Frontmatter fields (title, type, scope) are immutable — delete + re-create to change them.',
      inputSchema: {
        slug: z.string().describe('Slug of the entry to update'),
        body: z.string().optional().describe('New markdown body (no frontmatter). Omit to keep existing.'),
        refs: z
          .array(
            z.object({
              path: z.string().describe('Repo-relative file path'),
              commitSha: z
                .string()
                .optional()
                .describe('Pin SHA. Omit to auto-capture current HEAD.')
            })
          )
          .optional()
          .describe('Replace refs[]. Omit to re-pin existing refs to HEAD.')
      }
    },
    async ({ slug, body, refs }) =>
      textResponse(svc.updateKnowledge({ slug, body, refs }))
  )

  server.registerTool(
    'knowledge_verify',
    {
      description:
        'Mark a knowledge entry as verified. Re-pins each ref to current HEAD SHA, updates lastVerifiedAt, regenerates INDEX.md. Use after manually re-reading the note against current code.',
      inputSchema: {
        slug: z.string().describe('Slug of the entry')
      }
    },
    async ({ slug }) => textResponse(svc.verifyKnowledge(slug))
  )

  server.registerTool(
    'knowledge_delete',
    {
      description:
        'Delete a knowledge entry — removes the MD file, the index row, and regenerates INDEX.md. Throws if slug not found.',
      inputSchema: {
        slug: z.string().describe('Slug of the entry to delete')
      }
    },
    async ({ slug }) => textResponse(svc.deleteKnowledge(slug))
  )

  server.registerTool(
    'knowledge_search',
    {
      description:
        'Semantic search over knowledge entries. Embeds the query with the active provider and ranks rows by vector distance. Returns enabled=false (with reason) when sqlite-vec or embedding deps are not installed; entries created since the last embed pass may be missing from results.',
      inputSchema: {
        query: z.string().describe('Natural-language query'),
        topK: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max results (default 5, max 50)')
      }
    },
    async ({ query, topK }) => textResponse(await svc.searchKnowledge(query, topK ?? 5))
  )
}
