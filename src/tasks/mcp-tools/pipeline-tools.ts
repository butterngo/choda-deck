import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { textResponse } from './types'
import type { HarnessRunner } from '../../core/harness/harness-runner'
import {
  HarnessError,
  InteractiveConversationBlockingError
} from '../../core/harness/errors'
import type { PipelineState, EvaluatorMode } from '../../core/harness/pipeline-state'
import type { PlannerStageDeps } from '../../core/harness/planner-stage'
import { runPlannerStage } from '../../core/harness/planner-stage'
import type { ArtifactsConfig } from '../../core/harness/artifacts'

export interface PipelineToolsDeps {
  getHarnessRunner(): HarnessRunner
  getPlannerStageDeps(cfg: ArtifactsConfig): PlannerStageDeps
}

interface RegisterOptions {
  artifactsConfig: ArtifactsConfig
  runPlanner?: typeof runPlannerStage
}

type ToolOutput = ReturnType<typeof textResponse>

function stateToOutput(state: PipelineState): Record<string, unknown> {
  return {
    sessionId: state.sessionId,
    stage: state.stage,
    stage_status: state.stageStatus,
    iteration: state.currentIteration,
    needs_evaluator: state.needsEvaluator
  }
}

function tryHarness(fn: () => unknown): ToolOutput {
  try {
    return textResponse(fn())
  } catch (e) {
    if (e instanceof InteractiveConversationBlockingError) {
      return textResponse({
        error: {
          code: e.code,
          message_vi:
            'Đang có hội thoại tương tác trong project này. Kết thúc trước khi start pipeline.',
          payload: e.payload
        }
      })
    }
    if (e instanceof HarnessError) {
      return textResponse({ error: { code: e.code, message: e.message } })
    }
    throw e
  }
}

function firePlannerAsync(
  deps: PipelineToolsDeps,
  artifactsConfig: ArtifactsConfig,
  sessionId: string,
  runner: typeof runPlannerStage
): void {
  const plannerDeps = deps.getPlannerStageDeps(artifactsConfig)
  void runner(plannerDeps, sessionId).catch((err) => {
    // runPlannerStage already calls harness.failStage() and records a reject
    // approval row. Surface to stderr so operators see it in the MCP log.
    console.error(`[pipeline] planner stage failed for ${sessionId}:`, err)
  })
}

export const register = (
  server: McpServer,
  deps: PipelineToolsDeps,
  opts: RegisterOptions
): void => {
  const runner = opts.runPlanner ?? runPlannerStage

  server.registerTool(
    'pipeline_start',
    {
      description:
        'Start an AI pipeline (Planner → Impl → Evaluator) for a task. Creates session + fires Planner stage asynchronously — returns immediately with stage_status="running". Poll via task_context or wait for UI notification when plan.json is ready. Collides with an open interactive conversation in the same project; in that case the response is { error: { code: "INTERACTIVE_CONV_BLOCKING", message_vi, payload: { owner_type, owner_session_id, owner_task_id } } } — kết thúc hội thoại cũ trước.',
      inputSchema: {
        taskId: z.string().describe('Task ID to run through the pipeline'),
        evaluator: z
          .enum(['on', 'off', 'auto'])
          .describe('Evaluator mode — "auto" triggers on keywords (security/auth/migration/…)')
      }
    },
    async ({ taskId, evaluator }) =>
      tryHarness(() => {
        const state = deps.getHarnessRunner().startPipeline(taskId, {
          evaluator: evaluator as EvaluatorMode
        })
        firePlannerAsync(deps, opts.artifactsConfig, state.sessionId, runner)
        return stateToOutput(state)
      })
  )

  server.registerTool(
    'pipeline_approve',
    {
      description:
        'Approve the current "ready" stage of a pipeline. Advances to next stage (or marks pipeline done). Only valid when stage_status="ready". Returns the new pipeline state.',
      inputSchema: {
        sessionId: z.string().describe('Pipeline session ID (from pipeline_start)')
      }
    },
    async ({ sessionId }) =>
      tryHarness(() => {
        const state = deps.getHarnessRunner().approveStage(sessionId)
        return stateToOutput(state)
      })
  )

  server.registerTool(
    'pipeline_reject',
    {
      description:
        'Reject the current "ready" stage with feedback. Re-runs the same stage with the feedback appended to the prompt. Planner re-spawn happens asynchronously — returns immediately with stage_status="rejected" then flips to "running".',
      inputSchema: {
        sessionId: z.string().describe('Pipeline session ID'),
        feedback: z.string().min(1).describe('Reason for rejection — fed into the next spawn')
      }
    },
    async ({ sessionId, feedback }) =>
      tryHarness(() => {
        const state = deps.getHarnessRunner().rejectStage(sessionId, feedback)
        firePlannerAsync(deps, opts.artifactsConfig, sessionId, runner)
        return stateToOutput(state)
      })
  )

  server.registerTool(
    'pipeline_abort',
    {
      description:
        'Abort an in-flight pipeline. Ends the session, frees the concurrency slot. Irreversible — no resume.',
      inputSchema: {
        sessionId: z.string().describe('Pipeline session ID')
      }
    },
    async ({ sessionId }) =>
      tryHarness(() => {
        const state = deps.getHarnessRunner().abort(sessionId)
        return stateToOutput(state)
      })
  )
}
