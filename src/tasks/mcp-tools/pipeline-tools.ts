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
import type { GeneratorStageDeps } from '../../core/harness/generator-stage'
import { runGeneratorStage } from '../../core/harness/generator-stage'
import type { ArtifactsConfig } from '../../core/harness/artifacts'

export interface PipelineToolsDeps {
  getHarnessRunner(): HarnessRunner
  getPlannerStageDeps(cfg: ArtifactsConfig): PlannerStageDeps
  getGeneratorStageDeps(cfg: ArtifactsConfig): GeneratorStageDeps
}

interface RegisterOptions {
  artifactsConfig: ArtifactsConfig
  runPlanner?: typeof runPlannerStage
  runGenerator?: typeof runGeneratorStage
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

interface StageRunners {
  planner: typeof runPlannerStage
  generator: typeof runGeneratorStage
}

// Fire the runner matching `state.stage`. No-op for terminal or evaluator
// stages (evaluator lands in Phase 3, terminal stages have no runner).
function fireStageAsync(
  deps: PipelineToolsDeps,
  artifactsConfig: ArtifactsConfig,
  state: PipelineState,
  runners: StageRunners,
  feedback?: string
): void {
  if (state.stage === 'plan') {
    const plannerDeps = deps.getPlannerStageDeps(artifactsConfig)
    void runners.planner(plannerDeps, state.sessionId).catch((err) => {
      // runPlannerStage already calls harness.failStage() and records a reject
      // approval row. Surface to stderr so operators see it in the MCP log.
      console.error(`[pipeline] planner stage failed for ${state.sessionId}:`, err)
    })
    return
  }
  if (state.stage === 'generate') {
    const generatorDeps = deps.getGeneratorStageDeps(artifactsConfig)
    void runners
      .generator(generatorDeps, state.sessionId, {
        rejectionFeedback: feedback ?? null
      })
      .catch((err) => {
        console.error(`[pipeline] generator stage failed for ${state.sessionId}:`, err)
      })
  }
}

export const register = (
  server: McpServer,
  deps: PipelineToolsDeps,
  opts: RegisterOptions
): void => {
  const runners: StageRunners = {
    planner: opts.runPlanner ?? runPlannerStage,
    generator: opts.runGenerator ?? runGeneratorStage
  }

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
        fireStageAsync(deps, opts.artifactsConfig, state, runners)
        return stateToOutput(state)
      })
  )

  server.registerTool(
    'pipeline_approve',
    {
      description:
        'Approve the current "ready" stage of a pipeline. Advances to next stage (or marks pipeline done). Only valid when stage_status="ready". Returns the new pipeline state. When the new stage has a runner (plan, generate), it is fired asynchronously — the response already reflects stage_status="running" for that next stage.',
      inputSchema: {
        sessionId: z.string().describe('Pipeline session ID (from pipeline_start)')
      }
    },
    async ({ sessionId }) =>
      tryHarness(() => {
        const state = deps.getHarnessRunner().approveStage(sessionId)
        fireStageAsync(deps, opts.artifactsConfig, state, runners)
        return stateToOutput(state)
      })
  )

  server.registerTool(
    'pipeline_reject',
    {
      description:
        'Reject the current "ready" stage with feedback. Re-runs the same stage with the feedback appended to the prompt. Stage re-spawn happens asynchronously — returns immediately with stage_status="rejected" then flips to "running".',
      inputSchema: {
        sessionId: z.string().describe('Pipeline session ID'),
        feedback: z.string().min(1).describe('Reason for rejection — fed into the next spawn')
      }
    },
    async ({ sessionId, feedback }) =>
      tryHarness(() => {
        const state = deps.getHarnessRunner().rejectStage(sessionId, feedback)
        fireStageAsync(deps, opts.artifactsConfig, state, runners, feedback)
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
