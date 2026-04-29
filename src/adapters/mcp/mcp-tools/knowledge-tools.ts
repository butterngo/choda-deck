import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { textResponse } from './types'
import type { KnowledgeOperations } from '../../../core/domain/interfaces/knowledge-operations.interface'
import type { KnowledgeScope, KnowledgeType } from '../../../core/domain/knowledge-types'

const TYPE_ENUM = ['spike', 'decision', 'postmortem', 'learning', 'evaluation'] as const
const SCOPE_ENUM = ['project', 'cross'] as const

export const register = (server: McpServer, svc: KnowledgeOperations): void => {
  server.registerTool(
    'knowledge_create',
    {
      description:
        'Create a knowledge entry (ADR, spike finding, postmortem, learning, evaluation). Project-scope writes to <projectCwd>/docs/knowledge/<slug>.md and tracks staleness against refs[]. Cross-scope writes to vault/30-Knowledge/<slug>.md (no staleness).',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
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
        slug: z.string().optional().describe('Override auto-derived slug')
      }
    },
    async ({ projectId, type, scope, title, body, refs, slug }) =>
      textResponse(
        svc.createKnowledge({
          projectId,
          type: type as KnowledgeType,
          scope: scope as KnowledgeScope,
          title,
          body,
          refs: refs ?? [],
          slug
        })
      )
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
      description: 'List knowledge entries from the index. Body not loaded — use knowledge_get for content.',
      inputSchema: {
        projectId: z.string().optional().describe('Filter by project'),
        scope: z.enum(SCOPE_ENUM).optional().describe('Filter by scope'),
        type: z.enum(TYPE_ENUM).optional().describe('Filter by type')
      }
    },
    async ({ projectId, scope, type }) =>
      textResponse(
        svc.listKnowledge({
          projectId,
          scope: scope as KnowledgeScope | undefined,
          type: type as KnowledgeType | undefined
        })
      )
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
}
