import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import type { AgentMemoryOperations } from '../../../core/domain/interfaces/agent-memory-operations.interface'
import type { KnowledgeOperations } from '../../../core/domain/interfaces/knowledge-operations.interface'

export type MemoryPromoteDeps = AgentMemoryOperations & KnowledgeOperations

export const register = (server: InstrumentedServer, svc: MemoryPromoteDeps): void => {
  server.registerTool(
    'memory_promote_to_knowledge',
    {
      description:
        'Promote a memory to a knowledge entry (drafts an ADR with status "proposed"). Writes the file to <projectCwd>/docs/knowledge/<slug>.md and tags the source memory with "promoted:<slug>".',
      inputSchema: {
        memoryId: z.string().describe('ID of the memory to promote'),
        projectId: z.string().describe('Project ID for the knowledge entry'),
        workspaceId: z.string().optional().describe('Workspace ID (writes to workspace docs/knowledge/ instead)'),
        title: z.string().describe('Human-readable ADR title'),
        body: z.string().describe('Markdown body of the ADR (no frontmatter)'),
        slug: z.string().optional().describe('Override auto-derived slug'),
        refs: z
          .array(
            z.object({
              path: z.string(),
              commitSha: z.string().optional()
            })
          )
          .optional()
          .describe('Code references for staleness tracking')
      }
    },
    async ({ memoryId, projectId, workspaceId, title, body, slug, refs }) => {
      const entry = svc.createKnowledge({
        projectId,
        workspaceId,
        type: 'decision',
        scope: 'project',
        title,
        body,
        refs: refs ?? [],
        slug
      })
      svc.markMemoryPromoted(memoryId, entry.slug)
      return textResponse({ slug: entry.slug, filePath: entry.filePath })
    }
  )
}
