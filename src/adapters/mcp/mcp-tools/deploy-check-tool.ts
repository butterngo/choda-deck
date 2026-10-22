import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import type { TaskOperations } from '../../../core/domain/interfaces/task-repository.interface'
import type { DeployCheckOperations } from '../../../core/domain/interfaces/deploy-check-operations.interface'
import { DEPLOY_ENVS, type DeployEnv } from '../../../core/domain/repositories/deploy-check-repository'

// TASK-2606 — /ichiba-deploy runs in Claude Code, not in the companion, so it
// ticks a goal's deploy checklist through MCP. Same table and rows as the
// companion's POST /runs/<goal>/deploy-checks (TASK-2605); the tick is signed
// `claude`, and `note` carries the deploy record path. `env` is checked here,
// not by the schema, so a bad value answers BAD_ENV in the body.

export type DeployCheckToolDeps = Pick<TaskOperations, 'getTask'> & DeployCheckOperations

const NOTE_MAX = 500

export const register = (server: InstrumentedServer, svc: DeployCheckToolDeps): void => {
  server.registerTool(
    'deploy_check',
    {
      description:
        "Tick or untick one item of a goal's deploy checklist on one environment (qc | prod). " +
        'itemKey is the key from docs/reports/<goal>-deploy-checklist.md (e.g. "migration:20261019101204_ApprovalResults"). ' +
        'Signed doneBy="claude"; pass the deploy record path as note. Errors: UNKNOWN_GOAL, BAD_ENV.',
      inputSchema: {
        goalTaskId: z.string().min(1).describe('The goal (parent task) whose checklist this is'),
        env: z.string().describe('qc or prod'),
        itemKey: z.string().min(1).describe('The checklist item key'),
        done: z.boolean().describe('true ticks, false unticks'),
        note: z.string().max(NOTE_MAX).optional().describe('e.g. the deploy record path')
      }
    },
    async ({ goalTaskId, env, itemKey, done, note }) => {
      if (!(await svc.getTask(goalTaskId))) {
        return textResponse({ error: 'UNKNOWN_GOAL', message: `Goal ${goalTaskId} not found` })
      }
      if (!DEPLOY_ENVS.includes(env as DeployEnv)) {
        return textResponse({ error: 'BAD_ENV', message: `env must be one of ${DEPLOY_ENVS.join(', ')} (got "${env}")` })
      }
      const row = await svc.setDeployCheck({ goalTaskId, env: env as DeployEnv, itemKey, done, doneBy: 'claude', note: note ?? null })
      return textResponse({ goalTaskId, env, itemKey, done, doneBy: 'claude', doneAt: row.doneAt })
    }
  )

  server.registerTool(
    'deploy_checks_list',
    {
      description:
        "A goal's deploy checklist ticks per environment: { qc: { [itemKey]: { doneBy, doneAt, note } }, prod: {…} } — " +
        'the same shape as the companion GET /runs/<goal>/deploy-checks. Error: UNKNOWN_GOAL.',
      inputSchema: {
        goalTaskId: z.string().min(1).describe('The goal (parent task)')
      }
    },
    async ({ goalTaskId }) => {
      if (!(await svc.getTask(goalTaskId))) {
        return textResponse({ error: 'UNKNOWN_GOAL', message: `Goal ${goalTaskId} not found` })
      }
      return textResponse(await svc.listDeployChecks(goalTaskId))
    }
  )
}
