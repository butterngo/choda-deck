import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import {
  buildFeatureProjection,
  FeatureNotFoundError,
  type FeatureProjectionDeps
} from './feature-projection-builder'

// ADR-NNN Pillar 5 (TASK-994) — read-time role projection. Given a feature node
// + an asker role, returns a role-shaped bundle (CEO/PO business view or dev
// code view) with a deterministic honesty section and recalled gotchas. Role is
// an explicit param: conversation.participants[].type does not exist yet
// (follow-up). Stdio-only — not in REMOTE_TOOL_ALLOWLIST (graph/knowledge layer
// is local-trust, matching graph_edges / code_ref_*).
export const register = (server: InstrumentedServer, svc: FeatureProjectionDeps): void => {
  server.registerTool(
    'feature_projection',
    {
      description:
        'Project a feature knowledge node to a role-appropriate answer. role="ceo-po" → business description + apps + effort BAND (never number-of-days) + blockers; role="dev" → module + code_ref pointers with modifies/reference relation + gotchas recalled before the first question. Each bundle includes an honesty section (what the projection used vs. lacked). featureId is the feature slug (e.g. feature-crawler-list-ui-enhancements).',
      inputSchema: {
        featureId: z.string().describe('Feature knowledge slug'),
        role: z.enum(['ceo-po', 'dev']).describe('Asker role: ceo-po | dev')
      }
    },
    async ({ featureId, role }) => {
      try {
        return textResponse(await buildFeatureProjection(svc, featureId, role))
      } catch (err) {
        if (err instanceof FeatureNotFoundError) return textResponse(err.message)
        throw err
      }
    }
  )
}
