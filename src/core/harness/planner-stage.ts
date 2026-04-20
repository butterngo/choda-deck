import type { Task } from '../../tasks/task-types'
import type { TaskRepository } from '../../tasks/repositories/task-repository'
import type { ProjectRepository } from '../../tasks/repositories/project-repository'
import type { HarnessRunner } from './harness-runner'
import { buildPlannerPrompt, TOOL_ALLOWLIST } from './prompts'
import {
  runClaudeStage,
  StageBudgetExceededError,
  StageInvalidOutputError,
  StageNonZeroExitError,
  StageTimeoutError,
  type StageRunResult
} from './stage-runner'
import { writePlanArtifact, type ArtifactsConfig } from './artifacts'
import { HarnessError } from './errors'

export const PLANNER_DEFAULTS = {
  model: 'claude-opus-4-7',
  maxBudgetUsd: 0.25,
  timeoutMs: 300_000
} as const

export interface PlannerStageDeps {
  tasks: TaskRepository
  projects: ProjectRepository
  harness: HarnessRunner
  artifactsConfig: ArtifactsConfig
  runStage?: typeof runClaudeStage
}

export interface PlannerStageOpts {
  model?: string
  maxBudgetUsd?: number
  timeoutMs?: number
}

export interface PlannerStageResult {
  artifactPath: string
  plan: unknown
  totalCostUsd: number
  durationMs: number
}

const AC_HEADING = /^#{1,6}\s*(?:\d+\.\s*)?Acceptance(?:\s+Criteria)?\b/im

export function extractAcceptanceCriteria(body: string | null): string[] {
  if (!body) return []
  const match = AC_HEADING.exec(body)
  if (!match) return []
  const afterHeading = body.slice(match.index + match[0].length)
  const nextHeading = /\n#{1,6}\s+\S/m.exec(afterHeading)
  const block = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading
  const items: string[] = []
  for (const line of block.split(/\r?\n/)) {
    const itemMatch = /^\s*[-*]\s*(?:\[[ xX]\]\s*)?(.+?)\s*$/.exec(line)
    if (itemMatch && itemMatch[1].trim().length > 0) items.push(itemMatch[1].trim())
  }
  return items
}

export class PlannerSessionMissingError extends HarnessError {
  constructor(public readonly sessionId: string) {
    super('PLANNER_SESSION_MISSING', `No active planner state for session ${sessionId}`)
    this.name = 'PlannerSessionMissingError'
  }
}

export class PlannerTaskMissingError extends HarnessError {
  constructor(public readonly taskId: string) {
    super('PLANNER_TASK_MISSING', `Task ${taskId} not found for planner stage`)
    this.name = 'PlannerTaskMissingError'
  }
}

export class PlannerProjectMissingError extends HarnessError {
  constructor(public readonly projectId: string) {
    super('PLANNER_PROJECT_MISSING', `Project ${projectId} not found for planner stage`)
    this.name = 'PlannerProjectMissingError'
  }
}

export class PlannerInvalidStageError extends HarnessError {
  constructor(public readonly sessionId: string, public readonly stage: string) {
    super(
      'PLANNER_INVALID_STAGE',
      `Session ${sessionId} is at stage '${stage}', not 'plan'`
    )
    this.name = 'PlannerInvalidStageError'
  }
}

function parsePlanFromClaudeResult(result: StageRunResult): unknown {
  const text = result.parsed.result ?? ''
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const payload = fenced ? fenced[1] : trimmed
  try {
    return JSON.parse(payload)
  } catch {
    throw new StageInvalidOutputError(text)
  }
}

function summariseFailure(err: unknown): string {
  if (err instanceof StageTimeoutError) return `[planner timeout after ${err.timeoutMs}ms]`
  if (err instanceof StageBudgetExceededError)
    return `[planner budget exceeded: $${err.actual} > cap $${err.cap}]`
  if (err instanceof StageNonZeroExitError)
    return `[planner non-zero exit ${err.exitCode}: ${err.stderr.slice(0, 200)}]`
  if (err instanceof StageInvalidOutputError)
    return `[planner output was not valid JSON: ${err.raw.slice(0, 200)}]`
  if (err instanceof Error) return `[planner failed: ${err.message}]`
  return '[planner failed: unknown error]'
}

export async function runPlannerStage(
  deps: PlannerStageDeps,
  sessionId: string,
  opts: PlannerStageOpts = {}
): Promise<PlannerStageResult> {
  const state = deps.harness.getState(sessionId)
  if (!state) throw new PlannerSessionMissingError(sessionId)
  if (state.stage !== 'plan') throw new PlannerInvalidStageError(sessionId, state.stage)
  if (state.stageStatus === 'rejected') deps.harness.reviseStage(sessionId)

  const task: Task | null = deps.tasks.get(state.taskId)
  if (!task) throw new PlannerTaskMissingError(state.taskId)

  const project = deps.projects.get(state.projectId)
  if (!project) throw new PlannerProjectMissingError(state.projectId)

  const acceptanceCriteria = extractAcceptanceCriteria(task.body)
  const prompt = buildPlannerPrompt({
    task: { id: task.id, title: task.title, body: task.body },
    acceptanceCriteria
  })

  const runStage = deps.runStage ?? runClaudeStage

  try {
    const result = await runStage({
      workspacePath: project.cwd,
      prompt,
      model: opts.model ?? PLANNER_DEFAULTS.model,
      tools: TOOL_ALLOWLIST.plan,
      maxBudgetUsd: opts.maxBudgetUsd ?? PLANNER_DEFAULTS.maxBudgetUsd,
      timeoutMs: opts.timeoutMs ?? PLANNER_DEFAULTS.timeoutMs
    })

    const plan = parsePlanFromClaudeResult(result)
    const artifactPath = writePlanArtifact(deps.artifactsConfig, sessionId, plan)
    deps.harness.markStageReady(sessionId)

    return {
      artifactPath,
      plan,
      totalCostUsd: result.totalCostUsd,
      durationMs: result.durationMs
    }
  } catch (err) {
    const reason = summariseFailure(err)
    deps.harness.failStage(sessionId, reason)
    throw err
  }
}
