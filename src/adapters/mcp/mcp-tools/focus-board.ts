import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import { focusBoard, resolveFocus, type FocusDeps } from '../../../core/domain/daily/focus'

// TASK-2686 — every project's /choda-task-focus result, from the one definition
// in core/domain/daily/focus.ts. Stdio-only: deliberately absent from
// REMOTE_TOOL_ALLOWLIST (PostgresTaskService has no session/workspace reads).

export const register = (server: InstrumentedServer, svc: FocusDeps): void => {
  server.registerTool(
    'focus_board',
    {
      description:
        "Each project's focus by the /choda-task-focus tiers — session > in-progress > pinned > overdue > ready > due-soon > cold. " +
        'Omit projectId for one entry per registered project (cold ones included). ' +
        'Entry: { projectId, tier, focus, also, awaitingClose, resume, workspace }. Error: UNKNOWN_PROJECT.',
      inputSchema: {
        projectId: z.string().min(1).optional().describe('One project; omit for all')
      }
    },
    async ({ projectId }) => {
      if (projectId === undefined) return textResponse(await focusBoard(svc))
      const known = (await svc.listProjects()).some((p) => p.id === projectId)
      if (!known)
        return textResponse({ error: 'UNKNOWN_PROJECT', message: `Project ${projectId} not found` })
      return textResponse([await resolveFocus(svc, projectId)])
    }
  )
}
