import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import type { KnowledgeOperations } from '../../../core/domain/interfaces/knowledge-operations.interface'
import type { RelationshipOperations } from '../../../core/domain/interfaces/relationship-repository.interface'
import type { TaskOperations } from '../../../core/domain/interfaces/task-repository.interface'

// TASK-2589 — tie a goal task to the one feature it realizes.
//
// A REALIZES edge (task → feature) used to be created only when a FEATURE was
// created (knowledge-service.ts syncEdgesOnCreate), so a goal planned after its
// feature could never be linked: no goal created after 2026-09-27 had one. This
// tool writes the edge alone. It deliberately writes no file: feature files live
// in the workspace repos, and rewriting their frontmatter would dirty a repo the
// autopilot then refuses to run in. The projection already reads realized tasks
// from the edges (feature-projection-builder.ts), so the edge is enough.
//
// One feature per task (Butter, 2026-10-21). A second link without `replace`
// is refused rather than silently moving the task, because the old feature's
// regression scope would change under it.

export type FeatureLinkDeps = KnowledgeOperations &
  RelationshipOperations &
  Pick<TaskOperations, 'getTask'>

export type FeatureLinkErrorCode =
  | 'UNKNOWN_TASK'
  | 'UNKNOWN_FEATURE'
  | 'NOT_A_FEATURE'
  | 'ALREADY_LINKED'

export class FeatureLinkError extends Error {
  constructor(
    readonly code: FeatureLinkErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'FeatureLinkError'
  }
}

export interface FeatureLinkResult {
  taskId: string
  featureSlug: string
  /** The feature the task realized before, when `replace` moved it; else null. */
  replaced: string | null
}

export async function linkFeature(
  svc: FeatureLinkDeps,
  input: { taskId: string; featureSlug: string; replace?: boolean }
): Promise<FeatureLinkResult> {
  const { taskId, featureSlug } = input
  if (!(await svc.getTask(taskId))) {
    throw new FeatureLinkError('UNKNOWN_TASK', `unknown task: ${taskId}`)
  }
  const entry = await svc.getKnowledge(featureSlug)
  if (!entry) {
    throw new FeatureLinkError('UNKNOWN_FEATURE', `unknown feature: ${featureSlug}`)
  }
  if (entry.frontmatter.type !== 'feature') {
    throw new FeatureLinkError(
      'NOT_A_FEATURE',
      `${featureSlug} is a ${entry.frontmatter.type}, not a feature`
    )
  }

  const others = (await svc.getRelationshipsFrom(taskId, 'REALIZES'))
    .map((r) => r.toId)
    .filter((slug) => slug !== featureSlug)
  if (others.length > 0 && input.replace !== true) {
    throw new FeatureLinkError(
      'ALREADY_LINKED',
      `${taskId} already realizes ${others.join(', ')} — pass replace: true to move it`
    )
  }
  for (const slug of others) await svc.removeRelationship(taskId, slug, 'REALIZES')
  // addRelationship is INSERT OR IGNORE, so linking the same pair twice leaves one edge.
  await svc.addRelationship(taskId, featureSlug, 'REALIZES')
  return { taskId, featureSlug, replaced: others[0] ?? null }
}

export const register = (server: InstrumentedServer, svc: FeatureLinkDeps): void => {
  server.registerTool(
    'feature_link',
    {
      description:
        'Tie a task (usually a goal / parent task) to the one feature it realizes: writes the task → feature REALIZES edge, nothing else (no file is touched). A task realizes one feature; linking it to another answers ALREADY_LINKED unless replace is true, which moves it. Errors: UNKNOWN_TASK, UNKNOWN_FEATURE, NOT_A_FEATURE, ALREADY_LINKED.',
      inputSchema: {
        taskId: z.string().describe('Task to link (e.g. TASK-2585)'),
        featureSlug: z.string().describe('Slug of a knowledge entry of type feature'),
        replace: z
          .boolean()
          .optional()
          .describe('Move the task off the feature it realizes today. Default false.')
      }
    },
    async ({ taskId, featureSlug, replace }) => {
      try {
        return textResponse(await linkFeature(svc, { taskId, featureSlug, replace }))
      } catch (e) {
        if (e instanceof FeatureLinkError) return textResponse({ error: e.code, message: e.message })
        throw e
      }
    }
  )
}
