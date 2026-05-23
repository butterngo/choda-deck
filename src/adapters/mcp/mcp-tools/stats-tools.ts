import { z } from 'zod'
import type { InstrumentedServer } from '../instrumented-server'
import { textResponse } from './types'
import { computeStatsReport } from '../../../core/domain/stats-service'
import type {
  ToolInvocationAggregate,
  ToolInvocationWindow
} from '../../../core/domain/interfaces/tool-invocations-repository.interface'

export interface StatsToolsSvc {
  queryToolInvocations(window: ToolInvocationWindow): Promise<ToolInvocationAggregate[]>
}

export const register = (server: InstrumentedServer, svc: StatsToolsSvc): void => {
  server.registerTool(
    'stats_report',
    {
      description:
        'Report MCP tool usage stats over an optional ISO time window — returns per-tool calls / errorRate / avgDurationMs / lastUsedAt + classification (mvp / broken / dead-in-window / emerging) plus deadInWindow + brokenTools name lists. No projectId/session breakdown V0. Self-records (this call appears in the next stats_report).',
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe('Inclusive lower bound (ISO 8601). Omit for all-time.'),
        until: z
          .string()
          .optional()
          .describe('Inclusive upper bound (ISO 8601). Omit for now.')
      }
    },
    async ({ since, until }) => {
      const period = { since: since ?? null, until: until ?? null }
      const rows = await svc.queryToolInvocations(period)
      const report = computeStatsReport({
        rows,
        canonical: server.registeredToolNames,
        period
      })
      return textResponse(report)
    }
  )
}
