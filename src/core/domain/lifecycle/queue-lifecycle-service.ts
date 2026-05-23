import * as path from 'node:path'
import { splitLines } from '../../utils/lines'
import type { ConversationRepository } from '../repositories/conversation-repository'
import type { TaskRepository } from '../repositories/task-repository'
import type { WorkspaceRepository, WorkspaceRow } from '../repositories/workspace-repository'
import type { Task } from '../task-types'
import { AUTO_SAFE_LABEL, validateAutoSafeTask } from '../auto-safe-validator'
import { parseAcCommands } from './ac-parser'
import { QueueDirtyTreeError, TaskNotFoundError, WorkspaceResolutionError } from './errors'
import type { SessionLifecycleService } from './session-lifecycle-service'
import { computeToolSchemaTokens } from '../../executor/queue-claude-spawn'
import {
  validateQueueStartPreflight,
  type PreflightGitFns,
  type PreflightResult
} from './queue-start-preflight'

const DEFAULT_MAX_COST_PER_TASK = 1.5
const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_AC_TIMEOUT_MS = 10 * 60 * 1000
const AUTO_FAILED_LABEL = 'auto-failed'
const TOKENS_PER_CHAR = 3.5

function estimateMcpTokens(content: string): number {
  return Math.ceil(content.length / TOKENS_PER_CHAR)
}

/**
 * Narrow set of transient-error patterns per ADR-019 v2 line 202-204.
 * Logic fails (AC exit non-zero, claude returning is_error with non-transient text,
 * cost-cap-exceeded) are NOT retried — only infrastructure flakes that the same
 * prompt has a real chance of clearing on a second attempt.
 */
const TRANSIENT_PATTERNS = [
  /rate.?limit/i,
  /overloaded/i,
  /service unavailable/i,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bECONNREFUSED\b/,
  /out of memory/i,
  /\bOOM\b/,
  /timed out/i
]

function isTransientMessage(msg: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(msg))
}

export interface SpawnClaudeInput {
  taskBody: string
  cwd: string
  model: string
  maxBudgetUsd: number
  queueMcpEmptyPath: string
  claudeBin: string
  prewarm?: boolean
  account?: string
}

export interface SpawnClaudeOutput {
  isError: boolean
  totalCostUsd: number
  numTurns: number
  resultText: string
  rawJson: string
  totalInputTokens?: number | null
  cacheReadInputTokens?: number | null
}

export type SpawnClaudeFn = (input: SpawnClaudeInput) => Promise<SpawnClaudeOutput>

export type ExecShellResult = { exitCode: number; stdout: string; stderr: string }

export type ExecShellFn = (
  cmd: string,
  opts: { cwd: string; timeoutMs: number }
) => Promise<ExecShellResult>

export interface GitWorktreeAddOpts {
  /** The main checkout cwd — `git worktree add` runs from here. */
  repoCwd: string
  /** Target worktree path — e.g. `<repo>.worktrees/<taskId>`. */
  worktreePath: string
  /** New branch to create — e.g. `auto/<taskId>`. */
  branch: string
  /** Base SHA the new branch starts from. Captured once during pre-flight. */
  baseSha: string
}

/**
 * Externally-injected runtime: spawn, shell, git, fs and pre-resolved paths.
 * Letting the caller supply these keeps the service pure for unit tests and
 * lets the CLI wire production wrappers (`runProcess` from `coder.ts`, `fs/promises`).
 *
 * Extends `PreflightGitFns` so `runQueueStart` can pass `this.runtime` directly
 * into `validateQueueStartPreflight` — single runtime covers both queue methods.
 */
export interface QueueRuntime extends PreflightGitFns {
  spawnClaude: SpawnClaudeFn
  execShell: ExecShellFn
  gitStatusPorcelain(cwd: string): Promise<string>
  gitDiff(cwd: string): Promise<string>
  gitUntrackedFiles(cwd: string): Promise<string[]>
  gitCurrentBranch(cwd: string): Promise<string>
  gitHeadSha(cwd: string): Promise<string>
  /** `git worktree add -b <branch> <worktreePath> <baseSha>` from `repoCwd`. */
  gitWorktreeAdd(opts: GitWorktreeAddOpts): Promise<void>
  /** `git worktree remove --force <worktreePath>` + `git branch -d <branch>` from `repoCwd`. */
  gitWorktreeRemove(opts: { repoCwd: string; worktreePath: string; branch: string }): Promise<void>
  mkdir(dir: string): Promise<void>
  writeFile(file: string, content: string): Promise<void>
  /** Append-only writer for the per-event `queue.jsonl` stream (ADR-019, TASK-741). */
  appendFile(file: string, content: string): Promise<void>
  readFile(file: string): Promise<string>
  artifactsDir: string
  queueMcpEmptyPath: string
  mcpProfile: string
}

/**
 * ADR-019 `queue.jsonl` event schema. Backward-compatible with the Phase 1 ntfy
 * notifier consumer (`choda-deck-companion/packages/notifier/src/notifier.ts`).
 * Consumer accepts unknown extras via index signature, so we only emit the
 * fields the spec actually requires.
 */
export type QueueJsonlEvent =
  | { event: 'task.started'; queueRunId: string; taskId: string; taskIndex: number }
  | {
      event: 'task.finished'
      queueRunId: string
      taskId: string
      taskIndex: number
      outcome: 'DONE' | 'FAILED'
      costUsd: number
      durationMs: number
    }
  | {
      event: 'run.finished'
      queueRunId: string
      taskCount: number
      totalCostUsd: number
      durationMs: number
    }
  | {
      event: 'run.failed'
      queueRunId: string
      taskCount: number
      totalCostUsd: number
      durationMs: number
      failedTaskIndex: number
    }

export interface QueueRunOptions {
  workspaceId: string
  /** Per-task post-hoc cost cap. Default 0.50 USD. Per-spawn `--max-budget-usd` = half this. */
  maxCostPerTask?: number
  /** Cumulative-cost cap for the whole queue. If `cumulative + perTaskCap > this`, halt admission. */
  maxQueueCost?: number
  /** Stop after at most N tasks. */
  maxTasks?: number
  /** Validate gates and list tasks, no spawn. */
  dryRun?: boolean
  model?: string
  claudeBin?: string
  account?: string
  /** AC command exec timeout. Default 10 min. */
  acTimeoutMs?: number
}

/**
 * Typed halt classification. Drives exit-code mapping in run-queue CLI without
 * regex-matching the free-form `haltReason` string. Add a new variant whenever a
 * new halt site is introduced in `runQueue`.
 */
export type HaltCode =
  | 'queue-cost-cap'
  | 'cost-cap'
  | 'spawn-error'
  | 'claude-error'
  | 'ac-failed'

export interface QueueRunResult {
  done: Task[]
  failed: Task[]
  /** Tasks that were eligible but never executed because the queue halted. */
  skipped: Task[]
  totalCostUsd: number
  halted: boolean
  haltReason: string | null
  /** Typed halt classification — null when not halted. Drives CLI exit codes. */
  haltCode: HaltCode | null
  queueRunId: string
  artifactDir: string
}

export interface QueueStartOptions {
  workspaceId: string
  /** Git ref the per-task worktrees fork from. Captured once to `baseSha`. */
  baseRef: string
  /** Parent dir for per-task worktrees — e.g. `<repo>.worktrees`. */
  worktreesParentDir: string
  /** Branch prefix per task — final branch is `${branchPrefix}${task.id}`. Default `auto/`. */
  branchPrefix?: string
  /** Skip tasks that pre-flight fails for, run the rest. Default abort-all. */
  forceContinue?: boolean
  maxCostPerTask?: number
  maxTasks?: number
  /** Validate workspace + run preflight, do not spawn. */
  dryRun?: boolean
  model?: string
  claudeBin?: string
  account?: string
  acTimeoutMs?: number
}

export interface QueueStartTaskOutcome {
  taskId: string
  /** null when the task was skipped by per-task preflight (worktree never added). */
  worktreePath: string | null
  branch: string | null
  /** HEAD SHA inside the worktree post-spawn. null if worktree wasn't created. */
  headSha: string | null
  outcome: 'DONE' | 'FAILED' | 'SKIPPED_PREFLIGHT'
  account?: string | null
  costUsd?: number
  numTurns?: number
  reason?: string
}

export interface QueueStartResult {
  workspaceId: string
  queueRunId: string
  artifactDir: string
  baseRef: string
  /** null only when pre-flight aborted at the global-error stage (no baseSha resolved). */
  baseSha: string | null
  taskOutcomes: QueueStartTaskOutcome[]
  totalCostUsd: number
  /** True when default abort-all policy tripped and zero tasks executed. */
  preflightAborted: boolean
  preflightAbortReason: string | null
  doneCount: number
  failedCount: number
  preflightSkippedCount: number
}

type TaskOutcomeEntry =
  | { id: string; outcome: 'DONE'; costUsd: number; numTurns: number; account: string | null }
  | { id: string; outcome: 'FAILED'; costUsd?: number; reason: string; account: string | null }
  | { id: string; outcome: 'SKIPPED' }

type PreflightEffect =
  | { kind: 'worktree'; repoCwd: string; worktreePath: string; branch: string }
  | { kind: 'session'; id: string; taskId: string }

export class QueueLifecycleService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly conversations: ConversationRepository,
    private readonly sessions: SessionLifecycleService,
    private readonly runtime: QueueRuntime
  ) {}

  private async emitQueueEvent(artifactDir: string, event: QueueJsonlEvent): Promise<void> {
    await this.runtime.appendFile(
      path.join(artifactDir, 'queue.jsonl'),
      JSON.stringify(event) + '\n'
    )
  }

  async runQueue(opts: QueueRunOptions): Promise<QueueRunResult> {
    const ws = this.workspaces.get(opts.workspaceId)
    if (!ws) {
      throw new WorkspaceResolutionError(`workspace ${opts.workspaceId} not found`)
    }

    const porcelain = await this.runtime.gitStatusPorcelain(ws.cwd)
    if (porcelain.trim()) throw new QueueDirtyTreeError(ws.cwd, porcelain)

    const startedAt = new Date().toISOString()
    const branch = await this.runtime.gitCurrentBranch(ws.cwd)
    const commitSha = await this.runtime.gitHeadSha(ws.cwd)

    const eligible = this.collectEligibleTasks(ws)
    const taskCap = opts.maxTasks ?? eligible.length
    const tasks = eligible.slice(0, taskCap)

    const queueRunId = `${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`
    const artifactDir = path.join(this.runtime.artifactsDir, `queue-${queueRunId}`)

    if (opts.dryRun) {
      return {
        done: [],
        failed: [],
        skipped: tasks,
        totalCostUsd: 0,
        halted: false,
        haltReason: null,
        haltCode: null,
        queueRunId,
        artifactDir
      }
    }

    await this.runtime.mkdir(artifactDir)

    const maxCostPerTask = opts.maxCostPerTask ?? DEFAULT_MAX_COST_PER_TASK
    const maxBudgetUsd = round2(maxCostPerTask * 0.95)
    const model = opts.model ?? DEFAULT_MODEL
    const claudeBin = opts.claudeBin ?? 'claude'
    const acTimeoutMs = opts.acTimeoutMs ?? DEFAULT_AC_TIMEOUT_MS

    let mcpTokensPerSpawn = 0
    try {
      const mcpConfig = await this.runtime.readFile(this.runtime.queueMcpEmptyPath)
      mcpTokensPerSpawn = estimateMcpTokens(mcpConfig)
    } catch {
      // If we can't read the file, fall back to 0 (shouldn't happen in practice)
      mcpTokensPerSpawn = 0
    }

    const taskOutcomes: TaskOutcomeEntry[] = []
    const done: Task[] = []
    const failed: Task[] = []
    let totalCostUsd = 0
    let halted = false
    let haltReason: string | null = null
    let haltCode: HaltCode | null = null
    let skipped: Task[] = []
    let failedTaskIndex: number | null = null
    const runStartedMs = Date.parse(startedAt)

    const profile = this.runtime.mcpProfile
    let queueCacheReadTokens = 0
    let queueTotalInputTokens = 0
    let hasTokenData = false
    let queueFilesTouched = 0
    let queueNewFilesCreated = 0
    const profileOutcomes: Record<string, { success: number; failed: number }> = {}
    const bumpProfile = (outcome: 'success' | 'failed'): void => {
      if (!profileOutcomes[profile]) profileOutcomes[profile] = { success: 0, failed: 0 }
      profileOutcomes[profile][outcome] += 1
    }

    try {
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i]

        // Per-queue admission gate — halt before spawning if next-task could exceed cap.
        if (
          opts.maxQueueCost !== undefined &&
          totalCostUsd + maxCostPerTask > opts.maxQueueCost
        ) {
          halted = true
          haltCode = 'queue-cost-cap'
          haltReason = `queue-cost-cap-exceeded: cumulative ${totalCostUsd.toFixed(
            2
          )} + per-task ${maxCostPerTask.toFixed(2)} > ${opts.maxQueueCost.toFixed(2)}`
          failedTaskIndex = i + 1
          break
        }

        const taskDir = path.join(artifactDir, 'tasks', task.id)
        await this.runtime.mkdir(taskDir)
        const promptText = task.body ?? ''
        await this.runtime.writeFile(path.join(taskDir, 'prompt.md'), promptText)

        const taskIndex = i + 1
        const taskStartedMs = Date.now()
        await this.emitQueueEvent(artifactDir, {
          event: 'task.started',
          queueRunId,
          taskId: task.id,
          taskIndex
        })

        const startResult = await this.sessions.startSession({
          projectId: ws.projectId,
          workspaceId: ws.id,
          taskId: task.id
        })
        const sessionId = startResult.session.id

        const taskModel = resolveModelForTask(task, model)
        const spawnAttempt = await this.spawnWithRetry({
          taskBody: promptText,
          cwd: ws.cwd,
          model: taskModel,
          maxBudgetUsd,
          queueMcpEmptyPath: this.runtime.queueMcpEmptyPath,
          claudeBin,
          account: opts.account
        })
        if (spawnAttempt.error) {
          const reason = `spawn-error: ${spawnAttempt.error.message}`
          const errStats = await this.writeDiffArtifact(taskDir, ws.cwd)
          queueFilesTouched += errStats.filesTouched
          queueNewFilesCreated += errStats.newFiles
          await this.failTask(task, sessionId, reason, taskDir)
          bumpProfile('failed')
          taskOutcomes.push({ id: task.id, outcome: 'FAILED', reason, account: opts.account ?? null })
          failed.push(task)
          await this.emitQueueEvent(artifactDir, {
            event: 'task.finished',
            queueRunId,
            taskId: task.id,
            taskIndex,
            outcome: 'FAILED',
            costUsd: 0,
            durationMs: Date.now() - taskStartedMs
          })
          halted = true
          haltCode = 'spawn-error'
          haltReason = reason
          failedTaskIndex = taskIndex
          break
        }
        const spawn = spawnAttempt.output

        const cacheRead = spawn.cacheReadInputTokens ?? null
        const inputTokens = spawn.totalInputTokens ?? null
        if (cacheRead !== null) queueCacheReadTokens += cacheRead
        if (inputTokens !== null) {
          queueTotalInputTokens += inputTokens
          hasTokenData = true
        }

        await this.runtime.writeFile(path.join(taskDir, 'claude.json'), spawn.rawJson)
        const diffStats = await this.writeDiffArtifact(taskDir, ws.cwd)
        queueFilesTouched += diffStats.filesTouched
        queueNewFilesCreated += diffStats.newFiles
        totalCostUsd = round4(totalCostUsd + spawn.totalCostUsd)

        if (spawn.isError) {
          const reason = `claude-error: ${spawn.resultText.slice(0, 500)}`
          await this.failTask(task, sessionId, reason, taskDir)
          bumpProfile('failed')
          taskOutcomes.push({ id: task.id, outcome: 'FAILED', costUsd: spawn.totalCostUsd, reason, account: opts.account ?? null })
          failed.push(task)
          await this.emitQueueEvent(artifactDir, {
            event: 'task.finished',
            queueRunId,
            taskId: task.id,
            taskIndex,
            outcome: 'FAILED',
            costUsd: spawn.totalCostUsd,
            durationMs: Date.now() - taskStartedMs
          })
          halted = true
          haltCode = 'claude-error'
          haltReason = reason
          failedTaskIndex = taskIndex
          break
        }

        const acReason = await this.runAcCommands(promptText, ws.cwd, taskDir, acTimeoutMs)
        if (acReason) {
          await this.failTask(task, sessionId, acReason, taskDir)
          bumpProfile('failed')
          taskOutcomes.push({ id: task.id, outcome: 'FAILED', costUsd: spawn.totalCostUsd, reason: acReason, account: opts.account ?? null })
          failed.push(task)
          await this.emitQueueEvent(artifactDir, {
            event: 'task.finished',
            queueRunId,
            taskId: task.id,
            taskIndex,
            outcome: 'FAILED',
            costUsd: spawn.totalCostUsd,
            durationMs: Date.now() - taskStartedMs
          })
          halted = true
          haltCode = 'ac-failed'
          haltReason = acReason
          failedTaskIndex = taskIndex
          break
        }

        if (spawn.totalCostUsd > maxCostPerTask) {
          const reason = `cost-cap-exceeded: ${spawn.totalCostUsd.toFixed(
            2
          )} > ${maxCostPerTask.toFixed(2)}`
          await this.failTask(task, sessionId, reason, taskDir)
          bumpProfile('failed')
          taskOutcomes.push({ id: task.id, outcome: 'FAILED', costUsd: spawn.totalCostUsd, reason, account: opts.account ?? null })
          failed.push(task)
          await this.emitQueueEvent(artifactDir, {
            event: 'task.finished',
            queueRunId,
            taskId: task.id,
            taskIndex,
            outcome: 'FAILED',
            costUsd: spawn.totalCostUsd,
            durationMs: Date.now() - taskStartedMs
          })
          halted = true
          haltCode = 'cost-cap'
          haltReason = reason
          failedTaskIndex = taskIndex
          break
        }

        this.tasks.update(task.id, { status: 'REVIEW' })
        await this.sessions.checkpointSession(sessionId, {
          checkpoint: {
            outcome: 'pass',
            diffPath: path.join(taskDir, 'diff.patch'),
            claudeJsonPath: path.join(taskDir, 'claude.json'),
            acLogPath: path.join(taskDir, 'ac-0.log'),
            costUsd: spawn.totalCostUsd,
            numTurns: spawn.numTurns,
            awaitingReview: true
          }
        })
        bumpProfile('success')
        taskOutcomes.push({ id: task.id, outcome: 'DONE', costUsd: spawn.totalCostUsd, numTurns: spawn.numTurns, account: opts.account ?? null })
        done.push(task)
        await this.emitQueueEvent(artifactDir, {
          event: 'task.finished',
          queueRunId,
          taskId: task.id,
          taskIndex,
          outcome: 'DONE',
          costUsd: spawn.totalCostUsd,
          durationMs: Date.now() - taskStartedMs
        })
      }
    } finally {
      skipped = tasks.slice(done.length + failed.length)
      for (const t of skipped) {
        taskOutcomes.push({ id: t.id, outcome: 'SKIPPED' })
      }
      const cacheHitEstimate = hasTokenData
        ? Math.min(1, Math.max(0, queueCacheReadTokens / Math.max(queueTotalInputTokens, 1)))
        : null
      const runMeta = {
        queueRunId,
        workspaceId: opts.workspaceId,
        branch,
        commitSha,
        model,
        claudeBin,
        startedAt,
        endedAt: new Date().toISOString(),
        maxCostPerTask,
        maxQueueCost: opts.maxQueueCost ?? null,
        maxTasks: opts.maxTasks ?? null,
        totalCostUsd,
        halted,
        haltReason,
        haltCode,
        mcp_tokens_per_spawn: mcpTokensPerSpawn,
        tool_schema_tokens_total: computeToolSchemaTokens(),
        mcp_profile_used: profile,
        cache_read_input_tokens: queueCacheReadTokens,
        cache_hit_estimate: cacheHitEstimate,
        spawn_mode: profile === 'empty' ? 'zero-mcp' : 'selective',
        task_outcome_per_mcp_profile: profileOutcomes,
        files_touched_count: queueFilesTouched,
        new_files_created_count: queueNewFilesCreated,
        tasks: taskOutcomes
      }
      await this.runtime.writeFile(path.join(artifactDir, 'queue-run.json'), JSON.stringify(runMeta, null, 2))
      const runDurationMs = Date.now() - runStartedMs
      if (halted) {
        await this.emitQueueEvent(artifactDir, {
          event: 'run.failed',
          queueRunId,
          taskCount: tasks.length,
          totalCostUsd,
          durationMs: runDurationMs,
          failedTaskIndex: failedTaskIndex ?? done.length + failed.length
        })
      } else {
        await this.emitQueueEvent(artifactDir, {
          event: 'run.finished',
          queueRunId,
          taskCount: tasks.length,
          totalCostUsd,
          durationMs: runDurationMs
        })
      }
    }

    return {
      done,
      failed,
      skipped,
      totalCostUsd,
      halted,
      haltReason,
      haltCode,
      queueRunId,
      artifactDir
    }
  }

  /**
   * `choda-deck queue start` orchestration per ADR-019 Phase 3 / TASK-728.
   *
   * Differs from `runQueue` on three axes:
   *  - Pre-flight halt-all (`validateQueueStartPreflight`) before any spawn — global error
   *    aborts the whole batch; per-task failure aborts unless `forceContinue` is set.
   *  - Each task spawns in its own `git worktree add -b auto/<taskId> <baseSha>` cwd so
   *    diffs and branches don't collide. Worktrees are left intact regardless of outcome —
   *    cleanup is the orphan-cleaner's job (TASK-687).
   *  - Mid-run policy is CONTINUE: a failure writes artifacts + marks AUTO_FAILED + moves
   *    on. There is no `haltCode`; the runner only stops at end-of-list.
   */
  async runQueueStart(opts: QueueStartOptions): Promise<QueueStartResult> {
    const ws = this.workspaces.get(opts.workspaceId)
    if (!ws) {
      throw new WorkspaceResolutionError(`workspace ${opts.workspaceId} not found`)
    }

    const branchPrefix = opts.branchPrefix ?? 'auto/'
    const startedAt = new Date().toISOString()

    const eligible = this.collectEligibleTasks(ws)
    const taskCap = opts.maxTasks ?? eligible.length
    const allTasks = eligible.slice(0, taskCap)

    const queueRunId = `${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`
    const artifactDir = path.join(this.runtime.artifactsDir, `queue-start-${queueRunId}`)

    const preflight = await validateQueueStartPreflight({
      tasks: allTasks,
      repoCwd: ws.cwd,
      baseRef: opts.baseRef,
      worktreesParentDir: opts.worktreesParentDir,
      branchPrefix,
      fns: this.runtime
    })

    if (opts.dryRun) {
      return this.emptyQueueStartResult({
        workspaceId: opts.workspaceId,
        queueRunId,
        artifactDir,
        baseRef: opts.baseRef,
        baseSha: preflight.baseSha,
        preflightAborted: !preflight.ok && !opts.forceContinue,
        preflightAbortReason: preflightAbortMessage(preflight),
        taskOutcomes: allTasks.map((t) => ({
          taskId: t.id,
          worktreePath: null,
          branch: null,
          headSha: null,
          outcome: 'SKIPPED_PREFLIGHT',
          account: opts.account ?? null
        }))
      })
    }

    if (preflight.globalErrors.length > 0 || (!preflight.ok && !opts.forceContinue)) {
      await this.runtime.mkdir(artifactDir)
      const taskOutcomes: QueueStartTaskOutcome[] = allTasks.map((task) => {
        const fail = preflight.failures.find((f) => f.taskId === task.id)
        return {
          taskId: task.id,
          worktreePath: null,
          branch: null,
          headSha: null,
          outcome: 'SKIPPED_PREFLIGHT',
          reason: fail ? `preflight: ${fail.reasons.join('; ')}` : 'preflight: aborted by global error',
          account: opts.account ?? null
        }
      })
      await this.writeQueueStartMeta(artifactDir, {
        queueRunId,
        workspaceId: opts.workspaceId,
        baseRef: opts.baseRef,
        baseSha: preflight.baseSha,
        midRunPolicy: 'continue',
        startedAt,
        endedAt: new Date().toISOString(),
        model: opts.model ?? DEFAULT_MODEL,
        claudeBin: opts.claudeBin ?? 'claude',
        totalCostUsd: 0,
        preflightAborted: true,
        preflightAbortReason: preflightAbortMessage(preflight),
        taskOutcomes
      })
      return {
        workspaceId: opts.workspaceId,
        queueRunId,
        artifactDir,
        baseRef: opts.baseRef,
        baseSha: preflight.baseSha,
        taskOutcomes,
        totalCostUsd: 0,
        preflightAborted: true,
        preflightAbortReason: preflightAbortMessage(preflight),
        doneCount: 0,
        failedCount: 0,
        preflightSkippedCount: taskOutcomes.length
      }
    }

    // From here we have a valid baseSha — either preflight ok, or forceContinue was set
    // and only globalErrors are absent (per-task failures will be filtered below).
    const baseSha = preflight.baseSha!
    await this.runtime.mkdir(artifactDir)
    const runStartedMs = Date.parse(startedAt)

    const failedTaskIds = new Set(preflight.failures.map((f) => f.taskId))
    const maxCostPerTask = opts.maxCostPerTask ?? DEFAULT_MAX_COST_PER_TASK
    const maxBudgetUsd = round2(maxCostPerTask * 0.95)
    const model = opts.model ?? DEFAULT_MODEL
    const claudeBin = opts.claudeBin ?? 'claude'
    const acTimeoutMs = opts.acTimeoutMs ?? DEFAULT_AC_TIMEOUT_MS

    const taskOutcomes: QueueStartTaskOutcome[] = []
    let totalCostUsd = 0
    let executedCount = 0

    for (const task of allTasks) {
      if (failedTaskIds.has(task.id)) {
        const fail = preflight.failures.find((f) => f.taskId === task.id)!
        taskOutcomes.push({
          taskId: task.id,
          worktreePath: null,
          branch: null,
          headSha: null,
          outcome: 'SKIPPED_PREFLIGHT',
          reason: `preflight: ${fail.reasons.join('; ')}`,
          account: opts.account ?? null
        })
        continue
      }

      const worktreePath = path.join(opts.worktreesParentDir, task.id)
      const branch = `${branchPrefix}${task.id}`
      const taskDir = path.join(artifactDir, 'tasks', task.id)
      await this.runtime.mkdir(taskDir)
      const promptText = task.body ?? ''
      await this.runtime.writeFile(path.join(taskDir, 'prompt.md'), promptText)

      executedCount += 1
      const taskIndex = executedCount
      const taskStartedMs = Date.now()
      await this.emitQueueEvent(artifactDir, {
        event: 'task.started',
        queueRunId,
        taskId: task.id,
        taskIndex
      })

      // Track per-task side-effects so any setup failure can be rolled back in reverse.
      const effects: PreflightEffect[] = []
      let setupFailReason: string | null = null
      let sessionId = ''
      try {
        await this.runtime.gitWorktreeAdd({
          repoCwd: ws.cwd,
          worktreePath,
          branch,
          baseSha
        })
        effects.push({ kind: 'worktree', repoCwd: ws.cwd, worktreePath, branch })

        const startResult = await this.sessions.startSession({
          projectId: ws.projectId,
          workspaceId: ws.id,
          taskId: task.id
        })
        sessionId = startResult.session.id
        effects.push({ kind: 'session', id: sessionId, taskId: task.id })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const step = effects.length === 0 ? 'worktree-add' : 'session-start'
        setupFailReason = `${step}-failed: ${errMsg}`
      }

      if (setupFailReason !== null) {
        await this.rollbackPreflightEffects(effects, setupFailReason)
        this.markTaskFailed(task, setupFailReason, taskDir)
        taskOutcomes.push({
          taskId: task.id,
          worktreePath: effects.length > 0 ? worktreePath : null,
          branch: effects.length > 0 ? branch : null,
          headSha: null,
          outcome: 'FAILED',
          reason: setupFailReason,
          account: opts.account ?? null
        })
        await this.emitQueueEvent(artifactDir, {
          event: 'task.finished',
          queueRunId,
          taskId: task.id,
          taskIndex,
          outcome: 'FAILED',
          costUsd: 0,
          durationMs: Date.now() - taskStartedMs
        })
        continue
      }

      const taskModel = resolveModelForTask(task, model)
      const spawnAttempt = await this.spawnWithRetry({
        taskBody: promptText,
        cwd: worktreePath,
        model: taskModel,
        maxBudgetUsd,
        queueMcpEmptyPath: this.runtime.queueMcpEmptyPath,
        claudeBin,
        account: opts.account
      })

      if (spawnAttempt.error) {
        const reason = `spawn-error: ${spawnAttempt.error.message}`
        await this.writeDiffArtifact(taskDir, worktreePath)
        await this.failTask(task, sessionId, reason, taskDir)
        const headSha = await this.safeHeadSha(worktreePath)
        taskOutcomes.push({
          taskId: task.id,
          worktreePath,
          branch,
          headSha,
          outcome: 'FAILED',
          reason,
          account: opts.account ?? null
        })
        await this.emitQueueEvent(artifactDir, {
          event: 'task.finished',
          queueRunId,
          taskId: task.id,
          taskIndex,
          outcome: 'FAILED',
          costUsd: 0,
          durationMs: Date.now() - taskStartedMs
        })
        continue
      }
      const spawn = spawnAttempt.output

      await this.runtime.writeFile(path.join(taskDir, 'claude.json'), spawn.rawJson)
      await this.writeDiffArtifact(taskDir, worktreePath)
      totalCostUsd = round4(totalCostUsd + spawn.totalCostUsd)

      if (spawn.isError) {
        const reason = `claude-error: ${spawn.resultText.slice(0, 500)}`
        await this.failTask(task, sessionId, reason, taskDir)
        const headSha = await this.safeHeadSha(worktreePath)
        taskOutcomes.push({
          taskId: task.id,
          worktreePath,
          branch,
          headSha,
          outcome: 'FAILED',
          costUsd: spawn.totalCostUsd,
          reason,
          account: opts.account ?? null
        })
        await this.emitQueueEvent(artifactDir, {
          event: 'task.finished',
          queueRunId,
          taskId: task.id,
          taskIndex,
          outcome: 'FAILED',
          costUsd: spawn.totalCostUsd,
          durationMs: Date.now() - taskStartedMs
        })
        continue
      }

      const acReason = await this.runAcCommands(promptText, worktreePath, taskDir, acTimeoutMs)
      if (acReason) {
        await this.failTask(task, sessionId, acReason, taskDir)
        const headSha = await this.safeHeadSha(worktreePath)
        taskOutcomes.push({
          taskId: task.id,
          worktreePath,
          branch,
          headSha,
          outcome: 'FAILED',
          costUsd: spawn.totalCostUsd,
          reason: acReason,
          account: opts.account ?? null
        })
        await this.emitQueueEvent(artifactDir, {
          event: 'task.finished',
          queueRunId,
          taskId: task.id,
          taskIndex,
          outcome: 'FAILED',
          costUsd: spawn.totalCostUsd,
          durationMs: Date.now() - taskStartedMs
        })
        continue
      }

      if (spawn.totalCostUsd > maxCostPerTask) {
        const reason = `cost-cap-exceeded: ${spawn.totalCostUsd.toFixed(
          2
        )} > ${maxCostPerTask.toFixed(2)}`
        await this.failTask(task, sessionId, reason, taskDir)
        const headSha = await this.safeHeadSha(worktreePath)
        taskOutcomes.push({
          taskId: task.id,
          worktreePath,
          branch,
          headSha,
          outcome: 'FAILED',
          costUsd: spawn.totalCostUsd,
          reason,
          account: opts.account ?? null
        })
        await this.emitQueueEvent(artifactDir, {
          event: 'task.finished',
          queueRunId,
          taskId: task.id,
          taskIndex,
          outcome: 'FAILED',
          costUsd: spawn.totalCostUsd,
          durationMs: Date.now() - taskStartedMs
        })
        continue
      }

      this.tasks.update(task.id, { status: 'REVIEW' })
      await this.sessions.checkpointSession(sessionId, {
        checkpoint: {
          outcome: 'pass',
          diffPath: path.join(taskDir, 'diff.patch'),
          claudeJsonPath: path.join(taskDir, 'claude.json'),
          acLogPath: path.join(taskDir, 'ac-0.log'),
          costUsd: spawn.totalCostUsd,
          numTurns: spawn.numTurns,
          awaitingReview: true
        }
      })
      const headSha = await this.safeHeadSha(worktreePath)
      taskOutcomes.push({
        taskId: task.id,
        worktreePath,
        branch,
        headSha,
        outcome: 'DONE',
        costUsd: spawn.totalCostUsd,
        numTurns: spawn.numTurns,
        account: opts.account ?? null
      })
      await this.emitQueueEvent(artifactDir, {
        event: 'task.finished',
        queueRunId,
        taskId: task.id,
        taskIndex,
        outcome: 'DONE',
        costUsd: spawn.totalCostUsd,
        durationMs: Date.now() - taskStartedMs
      })
    }

    const doneCount = taskOutcomes.filter((o) => o.outcome === 'DONE').length
    const failedCount = taskOutcomes.filter((o) => o.outcome === 'FAILED').length
    const preflightSkippedCount = taskOutcomes.filter((o) => o.outcome === 'SKIPPED_PREFLIGHT').length

    await this.writeQueueStartMeta(artifactDir, {
      queueRunId,
      workspaceId: opts.workspaceId,
      baseRef: opts.baseRef,
      baseSha,
      midRunPolicy: 'continue',
      startedAt,
      endedAt: new Date().toISOString(),
      model,
      claudeBin,
      totalCostUsd,
      preflightAborted: false,
      preflightAbortReason: null,
      taskOutcomes
    })

    // runQueueStart is continue-on-fail (no halt), so the run always reaches a
    // clean end-of-list — emit `run.finished` regardless of per-task failures.
    // Phase 1 notifier maps this to a "Done · N tasks" push. Per-task failures
    // are visible via `queue-run.json` + per-task artifacts; preflight aborts
    // emit no `queue.jsonl` (return-early path above) and signal via CLI exit.
    await this.emitQueueEvent(artifactDir, {
      event: 'run.finished',
      queueRunId,
      taskCount: executedCount,
      totalCostUsd,
      durationMs: Date.now() - runStartedMs
    })

    return {
      workspaceId: opts.workspaceId,
      queueRunId,
      artifactDir,
      baseRef: opts.baseRef,
      baseSha,
      taskOutcomes,
      totalCostUsd,
      preflightAborted: false,
      preflightAbortReason: null,
      doneCount,
      failedCount,
      preflightSkippedCount
    }
  }

  /**
   * `gitHeadSha` may throw if the worktree disappeared between spawn and query; swallow
   * that into a `null` outcome rather than failing the whole loop.
   */
  private async safeHeadSha(cwd: string): Promise<string | null> {
    try {
      return await this.runtime.gitHeadSha(cwd)
    } catch {
      return null
    }
  }

  private async writeQueueStartMeta(
    artifactDir: string,
    meta: {
      queueRunId: string
      workspaceId: string
      baseRef: string
      baseSha: string | null
      midRunPolicy: 'continue'
      startedAt: string
      endedAt: string
      model: string
      claudeBin: string
      totalCostUsd: number
      preflightAborted: boolean
      preflightAbortReason: string | null
      taskOutcomes: QueueStartTaskOutcome[]
    }
  ): Promise<void> {
    await this.runtime.writeFile(
      path.join(artifactDir, 'queue-run.json'),
      JSON.stringify(meta, null, 2)
    )
  }

  private emptyQueueStartResult(seed: {
    workspaceId: string
    queueRunId: string
    artifactDir: string
    baseRef: string
    baseSha: string | null
    preflightAborted: boolean
    preflightAbortReason: string | null
    taskOutcomes: QueueStartTaskOutcome[]
  }): QueueStartResult {
    return {
      ...seed,
      totalCostUsd: 0,
      doneCount: 0,
      failedCount: 0,
      preflightSkippedCount: seed.taskOutcomes.length
    }
  }

  /**
   * Spawn with at most one retry for transient errors. The same prompt is sent on retry —
   * Claude is stateless across `-p` invocations so this is safe. Final attempt's output
   * (success or last failure) is what flows into per-task artifact writing and post-hoc
   * cost accounting; no double-counting because we only act on the final result.
   */
  private async spawnWithRetry(
    input: SpawnClaudeInput
  ): Promise<{ output: SpawnClaudeOutput; error: null } | { output: null; error: Error }> {
    let lastOutput: SpawnClaudeOutput | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const output = await this.runtime.spawnClaude(input)
        lastOutput = output
        if (output.isError && attempt === 0 && isTransientMessage(output.resultText)) {
          continue
        }
        return { output, error: null }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        if (attempt === 0 && isTransientMessage(e.message)) continue
        return { output: null, error: e }
      }
    }
    // Exhausted retries with a transient is_error — return the last output so the caller
    // surfaces it as a normal claude-error failure (no retry escape hatch).
    if (lastOutput) return { output: lastOutput, error: null }
    return { output: null, error: new Error('spawn retry loop produced no result') }
  }

  private collectEligibleTasks(ws: WorkspaceRow): Task[] {
    const candidates = this.tasks.find({ projectId: ws.projectId, status: 'READY' })
    return candidates
      .filter(
        (t) =>
          t.labels.includes(AUTO_SAFE_LABEL) &&
          !t.labels.includes(AUTO_FAILED_LABEL) &&
          validateAutoSafeTask(t).valid
      )
      .sort((x, y) => x.id.localeCompare(y.id))
  }

  private async runAcCommands(
    body: string,
    cwd: string,
    taskDir: string,
    timeoutMs: number
  ): Promise<string | null> {
    const cmds = parseAcCommands(body)
    for (let i = 0; i < cmds.length; i++) {
      const { cmd, expectedExit } = cmds[i]
      const r = await this.runtime.execShell(cmd, { cwd, timeoutMs })
      const log = `$ ${cmd}\nexit ${r.exitCode} (expected ${expectedExit})\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`
      await this.runtime.writeFile(path.join(taskDir, `ac-${i}.log`), log)
      if (r.exitCode !== expectedExit) {
        return `ac-failed: \`${cmd}\` exit ${r.exitCode} (expected ${expectedExit})`
      }
    }
    return null
  }

  private async writeDiffArtifact(
    taskDir: string,
    cwd: string
  ): Promise<{ filesTouched: number; newFiles: number }> {
    const diff = await this.runtime.gitDiff(cwd)
    await this.runtime.writeFile(path.join(taskDir, 'diff.patch'), diff)
    const stats = parseDiffStats(diff)
    const untracked = await this.runtime.gitUntrackedFiles(cwd)
    return { filesTouched: stats.filesTouched, newFiles: stats.newFiles + untracked.length }
  }

  private async rollbackPreflightEffects(
    effects: PreflightEffect[],
    reason: string
  ): Promise<void> {
    for (let i = effects.length - 1; i >= 0; i--) {
      const effect = effects[i]
      try {
        if (effect.kind === 'worktree') {
          await this.runtime.gitWorktreeRemove({
            repoCwd: effect.repoCwd,
            worktreePath: effect.worktreePath,
            branch: effect.branch
          })
        } else {
          await this.sessions.checkpointSession(effect.id, {
            checkpoint: { outcome: 'fail', reason: `preflight-rollback: ${reason}` }
          })
          this.tasks.update(effect.taskId, { status: 'REVIEW' })
        }
      } catch (rollbackErr) {
        process.stderr.write(
          `[queue] preflight rollback failed for ${effect.kind}: ` +
            `${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}\n`
        )
      }
    }
  }

  private markTaskFailed(task: Task, reason: string, taskDir: string): void {
    const refreshed = this.tasks.get(task.id)
    if (!refreshed) throw new TaskNotFoundError(task.id)
    const nextLabels = refreshed.labels.includes(AUTO_FAILED_LABEL)
      ? refreshed.labels
      : [...refreshed.labels, AUTO_FAILED_LABEL]
    this.tasks.update(task.id, { labels: nextLabels, status: 'REVIEW' })

    const linkedConvs = this.conversations.findByLink('task', task.id)
    for (const conv of linkedConvs) {
      if (conv.status === 'closed') continue
      this.conversations.addMessage({
        conversationId: conv.id,
        authorName: 'queue-runner',
        content: `Auto-failed: ${reason}\nDiff: ${path.join(taskDir, 'diff.patch')}`,
        messageType: 'comment'
      })
    }
  }

  private async failTask(
    task: Task,
    sessionId: string,
    reason: string,
    taskDir: string
  ): Promise<void> {
    this.markTaskFailed(task, reason, taskDir)
    await this.sessions.checkpointSession(sessionId, {
      checkpoint: {
        outcome: 'fail',
        reason,
        diffPath: path.join(taskDir, 'diff.patch'),
        claudeJsonPath: path.join(taskDir, 'claude.json')
      }
    })
  }
}

export function resolveModelForTask(task: Task, defaultModel: string): string {
  for (const label of task.labels) {
    const m = label.match(/^model:(.+)$/)
    if (m) {
      const value = m[1]
      if (!value.startsWith('claude-')) {
        process.stderr.write(`[queue] warning: model label "${label}" value does not start with "claude-"\n`)
      }
      return value
    }
  }
  return defaultModel
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

function preflightAbortMessage(preflight: PreflightResult): string | null {
  if (preflight.ok) return null
  const parts: string[] = []
  if (preflight.globalErrors.length > 0) {
    parts.push(`global: ${preflight.globalErrors.join('; ')}`)
  }
  if (preflight.failures.length > 0) {
    parts.push(
      `tasks: ${preflight.failures.map((f) => `${f.taskId} (${f.reasons.join(', ')})`).join('; ')}`
    )
  }
  return parts.join(' | ')
}

function parseDiffStats(diff: string): { filesTouched: number; newFiles: number } {
  let totalFiles = 0
  let newFiles = 0
  for (const line of splitLines(diff)) {
    if (line.startsWith('diff --git ')) totalFiles += 1
    else if (line.startsWith('new file mode')) newFiles += 1
  }
  return { filesTouched: totalFiles - newFiles, newFiles }
}
