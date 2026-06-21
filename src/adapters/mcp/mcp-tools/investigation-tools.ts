import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import { LifecycleError } from '../../../core/domain/lifecycle/errors'
import type { InvestigationOperations } from '../../../core/domain/interfaces/investigation.interface'

export type InvestigationToolsDeps = InvestigationOperations

async function tryLifecycle<T>(
  fn: () => T | Promise<T>
): Promise<ReturnType<typeof textResponse>> {
  try {
    return textResponse(await fn())
  } catch (e) {
    if (e instanceof LifecycleError) return textResponse(e.message)
    throw e
  }
}

// ADR-035: Investigation domain object — stdio-only debugging container. NOT added
// to REMOTE_TOOL_ALLOWLIST (server-bootstrap.ts) — local debug surface only.
export const register = (server: InstrumentedServer, svc: InvestigationToolsDeps): void => {
  server.registerTool(
    'investigation_start',
    {
      description:
        'Start a debugging investigation (ADR-035). Creates a container for nonlinear trace state (hypotheses + evidence), status=exploring. Optionally bind to a task/session.',
      inputSchema: {
        symptom: z.string().describe('The observed symptom, e.g. "Test button does not work"'),
        taskId: z.string().optional().describe('Optional task to bind to (standalone allowed)'),
        sessionId: z.string().optional().describe('Optional session to bind to')
      }
    },
    async ({ symptom, taskId, sessionId }) =>
      tryLifecycle(() => svc.startInvestigation({ symptom, taskId, sessionId }))
  )

  server.registerTool(
    'investigation_add_hypothesis',
    {
      description:
        'Add a hypothesis to an investigation (status=testing). Blocked once the investigation is resolved.',
      inputSchema: {
        investigationId: z.string().describe('Investigation ID (e.g. INV-001)'),
        description: z.string().describe('What you think might be the cause')
      }
    },
    async ({ investigationId, description }) =>
      tryLifecycle(() => svc.addHypothesis(investigationId, description))
  )

  server.registerTool(
    'investigation_set_hypothesis_status',
    {
      description:
        'Transition a hypothesis: testing → ruled_out | confirmed. Ruled-out hypotheses persist (dead ends are kept). A terminal hypothesis cannot transition again.',
      inputSchema: {
        hypothesisId: z.string().describe('Hypothesis ID (e.g. HYP-001)'),
        status: z.enum(['ruled_out', 'confirmed']).describe('New status')
      }
    },
    async ({ hypothesisId, status }) =>
      tryLifecycle(() => svc.setHypothesisStatus(hypothesisId, status))
  )

  server.registerTool(
    'investigation_add_evidence',
    {
      description:
        'Attach typed evidence to an investigation, or to a specific hypothesis within it. `ref` is a by-reference locator; `snapshot` captures the observed value by-value (runtime output is ephemeral — ADR-035 evidence-by-value).',
      inputSchema: {
        investigationId: z.string().describe('Investigation ID'),
        type: z
          .enum(['screenshot', 'log', 'network', 'code_snippet'])
          .describe('Evidence type'),
        ref: z.string().describe('Path / URL / locator for the evidence'),
        snapshot: z
          .string()
          .optional()
          .describe('Captured value by-value — the observed runtime output itself (e.g. a log excerpt, a query result), preserved even when the source is ephemeral'),
        hypothesisId: z
          .string()
          .optional()
          .describe('Attach to this hypothesis instead of the investigation as a whole'),
        note: z.string().optional().describe('Optional note about the evidence')
      }
    },
    async ({ investigationId, type, ref, snapshot, hypothesisId, note }) =>
      tryLifecycle(() =>
        svc.addEvidence({ investigationId, type, ref, snapshot, hypothesisId, note })
      )
  )

  server.registerTool(
    'investigation_resolve',
    {
      description:
        'Resolve an investigation (status=resolved). Returns a human-gated knowledge_create(gotcha) draft built from pattern_tag + root_cause + fix — NOT auto-written. Errors if already resolved.',
      inputSchema: {
        id: z.string().describe('Investigation ID'),
        rootCause: z.string().describe('The confirmed root cause'),
        fixSummary: z.string().describe('How it was fixed'),
        patternTag: z
          .string()
          .optional()
          .describe('Reusable pattern tag, e.g. "expression-no-upstream-data"')
      }
    },
    async ({ id, rootCause, fixSummary, patternTag }) =>
      tryLifecycle(() => svc.resolveInvestigation(id, { rootCause, fixSummary, patternTag }))
  )

  server.registerTool(
    'investigation_get',
    {
      description:
        'Get full investigation state — symptom, status, all hypotheses (incl. ruled_out), all evidence, root_cause/fix. Reconstructs a trace without prior context.',
      inputSchema: { id: z.string().describe('Investigation ID') }
    },
    async ({ id }) => {
      const inv = await svc.getInvestigation(id)
      return textResponse(inv ?? `Investigation ${id} not found`)
    }
  )
}
