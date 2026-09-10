import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import { LifecycleError } from '../../../core/domain/lifecycle/errors'
import type { WorkspaceOperations } from '../../../core/domain/interfaces/workspace-repository.interface'
import type { TaskOperations } from '../../../core/domain/interfaces/task-repository.interface'
import type { CheckAcItemInput, CheckAcItemResult } from '../../../core/domain/lifecycle/ac-check'
import { resolveWorkspaceId } from './workspace-resolver'

// ADR-029 channel 2 — narrow body-lock bypass for ticking a single AC checkbox.
// Stdio-only: must NOT appear in `REMOTE_TOOL_ALLOWLIST` (server-bootstrap.ts).
// The tool resolves cwd → workspace → active session (refusing when several are
// active and none was named — TASK-1577), computes the new body via
// `flipAcCheckbox` (which asserts the post-edit diff is one char), then writes
// the body update + a `kind='ac_check'` observation event in a single
// SQLite transaction (atomic — both land or neither).

export interface AcCheckDeps extends TaskOperations, WorkspaceOperations {
  checkAcItem(input: CheckAcItemInput): Promise<CheckAcItemResult>
}

export const register = (server: InstrumentedServer, svc: AcCheckDeps): void => {
  server.registerTool(
    'ac_check',
    {
      description:
        'Verify a single Acceptance Criteria item on a task. Flips one `- [ ]` → `- [x]` in the task body and emits a session_events observation row with payload.kind="ac_check". ' +
        'Narrow body-lock bypass — only the single checkbox character may change; any wider diff is rejected with BODY_LOCK_VIOLATION (ADR-029 channel 2). ' +
        'Requires an active session for the resolved workspace; pass `cwd` so the server can match it to a registered workspace. A workspace may hold SEVERAL active sessions (session_start allows it) — when it does, pass `sessionId` to say which one this tick belongs to; the server refuses with AMBIGUOUS_SESSION rather than choosing (TASK-1577).',
      inputSchema: {
        taskId: z.string().describe('Task whose AC item to verify'),
        acIndex: z
          .number()
          .int()
          .nonnegative()
          .describe('0-based index of the AC item in `## Acceptance` (first `- [ ]` line = 0)'),
        evidence: z
          .string()
          .min(1)
          .describe(
            'Short proof string — e.g. "pnpm vitest run X exits 0", "manual smoke @ 10k rows", "commit abc123"'
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            'Current working directory — used to resolve the workspace, and through it the active session'
          ),
        sessionId: z
          .string()
          .optional()
          .describe(
            'The session this tick belongs to. Optional while the workspace has exactly one active session; required once it has more. ' +
              'A named session must exist, be active, and be in the resolved workspace — a mismatch is SESSION_MISMATCH, never a silent substitution.'
          )
      }
    },
    async ({ taskId, acIndex, evidence, cwd, sessionId }) => {
      try {
        const task = await svc.getTask(taskId)
        if (!task) {
          return textResponse({
            error: 'TASK_NOT_FOUND',
            message: `Task ${taskId} not found`
          })
        }
        const workspaces = await svc.findWorkspaces(task.projectId)
        const workspaceId =
          resolveWorkspaceId({ cwd, workspaces }) ?? undefined
        const result = await svc.checkAcItem({ taskId, acIndex, evidence, workspaceId, sessionId })
        return textResponse(result)
      } catch (e) {
        if (e instanceof LifecycleError) return textResponse({ error: e.code, message: e.message })
        throw e
      }
    }
  )
}
