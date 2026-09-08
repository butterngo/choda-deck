import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import { gradeAcceptance } from '../../companion/ac-grader'
import type { TaskOperations } from '../../../core/domain/interfaces/task-repository.interface'

// TASK-1914 — the AC grader, callable from a session.
//
// The five tests /choda-plan writes down have been applied by a human
// remembering to, and by nothing else: before this tool, `ac_review` appeared in
// zero skill files. The grader itself has existed since TASK-1860 — this adds a
// caller, not a second implementation. The grading lives in
// companion/ac-grader.ts and the HTTP route uses the same function, because a
// second copy of the prompt would be a second standard.
//
// Governed by `adr-when-this-project-may-call-a-model`:
//   * one explicit request naming its subject — one `taskId`, never a list;
//   * no fan-out inside the tool, so one call is one charge;
//   * no automatic retry — `rate_limit` and `budget` are handed to the caller;
//   * stdio-only. Deliberately ABSENT from REMOTE_TOOL_ALLOWLIST
//     (server-bootstrap.ts), so a remote connector cannot spend money.
//
// The answers below are sentences, not statuses. Every one of them is a
// DIFFERENT answer from "no criterion was flagged" — a caller that cannot tell
// "nothing is wrong" from "nothing was graded" is the failure TASK-1913 fixed
// one layer down, and it would be pointless to reintroduce it here.

/** Only `getTask` is needed: the grader takes a body, not a repository. */
export type AcReviewDeps = TaskOperations

export const register = (
  server: InstrumentedServer,
  svc: AcReviewDeps,
  dataDir: string | undefined,
  fetchImpl?: typeof fetch
): void => {
  server.registerTool(
    'ac_review',
    {
      description:
        "Grade one task's acceptance criteria against the five-test standard (falsifiable, " +
        'observable with the surface named, one verdict each, classified machine/human/decision, ' +
        'tickable checkbox form). Returns a verdict per criterion, indexed the way `ac_check` ' +
        'counts them, with a concern naming the failing test and a suggested rewrite to READ — ' +
        'nothing is ever written back to the task. ' +
        'Verdicts are `ok`, `weak`, or `unanswered` when the model returned no row for that ' +
        'criterion; `unanswered` is NOT approval. ' +
        'Costs a model call, so it runs only when asked, for one taskId at a time — never sweep a ' +
        'backlog with it (ADR: when this project may call a model).',
      inputSchema: {
        taskId: z.string().describe('The task whose `## Acceptance` criteria to grade'),
        model: z
          .string()
          .optional()
          .describe('Deployment to grade with. Omit to use the configured default.')
      }
    },
    async ({ taskId, model }) => {
      const task = await svc.getTask(taskId)
      if (!task) {
        return textResponse({ error: 'TASK_NOT_FOUND', message: `Task ${taskId} not found` })
      }

      const result = await gradeAcceptance({
        body: task.body ?? '',
        dataDir,
        model,
        fetchImpl
      })

      switch (result.kind) {
        case 'no-criteria':
          // Not an empty verdict list: an empty list reads as "nothing flagged",
          // which is a claim about criteria this task does not have.
          return textResponse({
            error: 'NO_ACCEPTANCE_CRITERIA',
            message: `${taskId} has no ## Acceptance criteria to grade. Nothing was sent to a model.`
          })
        case 'no-provider':
          return textResponse({
            error: 'NO_MODEL_CONFIGURED',
            message:
              'No model is configured on this machine (ai-provider.json / ai-key.txt), so nothing was graded.'
          })
        case 'failed':
          // The kind, never the provider's own text: a reflected request can
          // echo the key back, and forwarding it is how a secret reaches a log.
          return textResponse({
            error: 'PROVIDER_FAILED',
            kind: result.errorKind,
            ...(result.retryAfter === null ? {} : { retryAfter: result.retryAfter }),
            message: `The grader could not answer (${result.errorKind}). Nothing was graded.`
          })
        case 'graded':
          return textResponse({ taskId, criteria: result.criteria })
      }
    }
  )
}
