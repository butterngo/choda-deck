import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Task } from '../../tasks/task-types'
import type { TaskRepository } from '../../tasks/repositories/task-repository'
import type { ProjectRepository } from '../../tasks/repositories/project-repository'
import type { HarnessRunner } from './harness-runner'
import { buildGeneratorPrompt, TOOL_ALLOWLIST, PREAPPROVED_TOOLS } from './prompts'
import {
  runClaudeStage,
  StageBudgetExceededError,
  StageInvalidOutputError,
  StageNonZeroExitError,
  StageTimeoutError,
  type StageDiagnostics
} from './stage-runner'
import {
  getSessionArtifactsDir,
  writeDiffArtifact,
  writeGeneratorArtifact,
  writeGeneratorFailureArtifact,
  type ArtifactsConfig
} from './artifacts'
import type { PlannerPlan } from './plan-types'
import type { GeneratorArtifact } from './generated-types'
import {
  GeneratorOutputParseError,
  parseGeneratorResult,
  splitArtifact
} from './generator-output'
import { HarnessError } from './errors'

export const GENERATOR_DEFAULTS = {
  model: 'claude-sonnet-4-6',
  maxBudgetUsd: 1.0,
  // Generator runs longer than Planner (Edit/Write + Bash). ADR-014 Q5: 10 min.
  timeoutMs: 600_000
} as const

export interface GeneratorStageDeps {
  tasks: TaskRepository
  projects: ProjectRepository
  harness: HarnessRunner
  artifactsConfig: ArtifactsConfig
  runStage?: typeof runClaudeStage
}

export interface GeneratorStageOpts {
  model?: string
  maxBudgetUsd?: number
  timeoutMs?: number
  // Optional rejection-feedback text to append to the prompt on re-run.
  rejectionFeedback?: string | null
}

export interface GeneratorStageResult {
  generatedPath: string
  diffPath: string | null
  generated: GeneratorArtifact
  totalCostUsd: number
  durationMs: number
}

export class GeneratorSessionMissingError extends HarnessError {
  constructor(public readonly sessionId: string) {
    super('GENERATOR_SESSION_MISSING', `No active generator state for session ${sessionId}`)
    this.name = 'GeneratorSessionMissingError'
  }
}

export class GeneratorTaskMissingError extends HarnessError {
  constructor(public readonly taskId: string) {
    super('GENERATOR_TASK_MISSING', `Task ${taskId} not found for generator stage`)
    this.name = 'GeneratorTaskMissingError'
  }
}

export class GeneratorProjectMissingError extends HarnessError {
  constructor(public readonly projectId: string) {
    super('GENERATOR_PROJECT_MISSING', `Project ${projectId} not found for generator stage`)
    this.name = 'GeneratorProjectMissingError'
  }
}

export class GeneratorInvalidStageError extends HarnessError {
  constructor(public readonly sessionId: string, public readonly stage: string) {
    super(
      'GENERATOR_INVALID_STAGE',
      `Session ${sessionId} is at stage '${stage}', not 'generate'`
    )
    this.name = 'GeneratorInvalidStageError'
  }
}

export class GeneratorPlanMissingError extends HarnessError {
  constructor(public readonly sessionId: string, public readonly planPath: string) {
    super(
      'GENERATOR_PLAN_MISSING',
      `Approved plan.json not found at ${planPath} for session ${sessionId}`
    )
    this.name = 'GeneratorPlanMissingError'
  }
}

// Raised when Generator deliberately stops (strict mode — plan ambiguous).
// Carries the stopReason for the UI + approvals row.
export class GeneratorStoppedError extends HarnessError {
  constructor(public readonly stopReason: string) {
    super('GENERATOR_STOPPED', `Generator stopped: ${stopReason}`)
    this.name = 'GeneratorStoppedError'
  }
}

function loadApprovedPlan(cfg: ArtifactsConfig, sessionId: string): PlannerPlan {
  const filePath = join(getSessionArtifactsDir(cfg, sessionId), 'plan.json')
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    throw new GeneratorPlanMissingError(sessionId, filePath)
  }
  return JSON.parse(raw) as PlannerPlan
}

function summariseFailure(err: unknown): string {
  if (err instanceof StageTimeoutError) return `[generator timeout after ${err.timeoutMs}ms]`
  if (err instanceof StageBudgetExceededError)
    return `[generator budget exceeded: $${err.actual} > cap $${err.cap}]`
  if (err instanceof StageNonZeroExitError)
    return `[generator non-zero exit ${err.exitCode}: ${err.diagnostics.stderr.slice(0, 200)}]`
  if (err instanceof StageInvalidOutputError)
    return `[generator output was not valid JSON: ${err.diagnostics.stdout.slice(0, 200)}]`
  if (err instanceof GeneratorOutputParseError)
    return `[generator result text was not valid output JSON: ${err.reason}]`
  if (err instanceof GeneratorStoppedError) return `[generator stopped: ${err.stopReason}]`
  if (err instanceof GeneratorPlanMissingError) return `[generator plan missing: ${err.message}]`
  if (err instanceof Error) return `[generator failed: ${err.message}]`
  return '[generator failed: unknown error]'
}

function extractDiagnostics(err: unknown): StageDiagnostics | null {
  if (
    err instanceof StageTimeoutError ||
    err instanceof StageBudgetExceededError ||
    err instanceof StageNonZeroExitError ||
    err instanceof StageInvalidOutputError
  ) {
    return err.diagnostics
  }
  return null
}

function errorCodeOf(err: unknown): string {
  if (err instanceof HarnessError) return err.code
  if (err instanceof Error) return err.name
  return 'UNKNOWN'
}

export async function runGeneratorStage(
  deps: GeneratorStageDeps,
  sessionId: string,
  opts: GeneratorStageOpts = {}
): Promise<GeneratorStageResult> {
  const state = deps.harness.getState(sessionId)
  if (!state) throw new GeneratorSessionMissingError(sessionId)
  if (state.stage !== 'generate') throw new GeneratorInvalidStageError(sessionId, state.stage)
  if (state.stageStatus === 'rejected') deps.harness.reviseStage(sessionId)

  const task: Task | null = deps.tasks.get(state.taskId)
  if (!task) throw new GeneratorTaskMissingError(state.taskId)

  const project = deps.projects.get(state.projectId)
  if (!project) throw new GeneratorProjectMissingError(state.projectId)

  const plan = loadApprovedPlan(deps.artifactsConfig, sessionId)
  const prompt = buildGeneratorPrompt({
    task: { id: task.id, title: task.title, body: task.body },
    plan,
    rejectionFeedback: opts.rejectionFeedback ?? null
  })

  const runStage = deps.runStage ?? runClaudeStage

  try {
    const result = await runStage({
      workspacePath: project.cwd,
      prompt,
      model: opts.model ?? GENERATOR_DEFAULTS.model,
      tools: TOOL_ALLOWLIST.generate,
      allowedTools: PREAPPROVED_TOOLS.generate,
      maxBudgetUsd: opts.maxBudgetUsd ?? GENERATOR_DEFAULTS.maxBudgetUsd,
      timeoutMs: opts.timeoutMs ?? GENERATOR_DEFAULTS.timeoutMs
    })

    const output = parseGeneratorResult(result)
    const { artifact, diff } = splitArtifact(output)
    const generatedPath = writeGeneratorArtifact(
      deps.artifactsConfig,
      sessionId,
      artifact
    )
    const diffPath = diff.trim()
      ? writeDiffArtifact(deps.artifactsConfig, sessionId, diff)
      : null

    if (artifact.status === 'stopped') {
      const reason = artifact.stopReason ?? 'unspecified'
      throw new GeneratorStoppedError(reason)
    }

    deps.harness.markStageReady(sessionId)

    return {
      generatedPath,
      diffPath,
      generated: artifact,
      totalCostUsd: result.totalCostUsd,
      durationMs: result.durationMs
    }
  } catch (err) {
    const reason = summariseFailure(err)
    const diagnostics = extractDiagnostics(err)
    if (diagnostics) {
      try {
        writeGeneratorFailureArtifact(deps.artifactsConfig, sessionId, {
          errorCode: errorCodeOf(err),
          errorMessage: err instanceof Error ? err.message : String(err),
          sessionId,
          stage: 'generate',
          iteration: state.currentIteration,
          createdAt: new Date().toISOString(),
          diagnostics
        })
      } catch {
        // Artifact write failures must not mask the original generator error.
      }
    }
    deps.harness.failStage(
      sessionId,
      reason,
      diagnostics ? JSON.stringify(diagnostics) : undefined
    )
    throw err
  }
}
