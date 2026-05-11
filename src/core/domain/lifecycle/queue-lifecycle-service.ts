import * as path from 'node:path'
import type { ConversationRepository } from '../repositories/conversation-repository'
import type { TaskRepository } from '../repositories/task-repository'
import type { WorkspaceRepository, WorkspaceRow } from '../repositories/workspace-repository'
import type { Task } from '../task-types'
import { AUTO_SAFE_LABEL, validateAutoSafeTask } from '../auto-safe-validator'
import { parseAcCommands } from './ac-parser'
import { QueueDirtyTreeError, TaskNotFoundError, WorkspaceResolutionError } from './errors'
import type { SessionLifecycleService } from './session-lifecycle-service'
import { computeToolSchemaTokens } from '../../executor/queue-claude-spawn'

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

/**
 * Externally-injected runtime: spawn, shell, git, fs and pre-resolved paths.
 * Letting the caller supply these keeps the service pure for unit tests and
 * lets the CLI wire production wrappers (`runProcess` from `coder.ts`, `fs/promises`).
 */
export interface QueueRuntime {
  spawnClaude: SpawnClaudeFn
  execShell: ExecShellFn
  gitStatusPorcelain(cwd: string): Promise<string>
  gitDiff(cwd: string): Promise<string>
  gitCurrentBranch(cwd: string): Promise<string>
  gitHeadSha(cwd: string): Promise<string>
  mkdir(dir: string): Promise<void>
  writeFile(file: string, content: string): Promise<void>
  readFile(file: string): Promise<string>
  artifactsDir: string
  queueMcpEmptyPath: string
  mcpProfile: string
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
  /** AC command exec timeout. Default 10 min. */
  acTimeoutMs?: number
}

export interface QueueRunResult {
  done: Task[]
  failed: Task[]
  /** Tasks that were eligible but never executed because the queue halted. */
  skipped: Task[]
  totalCostUsd: number
  halted: boolean
  haltReason: string | null
  queueRunId: string
  artifactDir: string
}

type TaskOutcomeEntry =
  | { id: string; outcome: 'DONE'; costUsd: number; numTurns: number }
  | { id: string; outcome: 'FAILED'; costUsd?: number; reason: string }
  | { id: string; outcome: 'SKIPPED' }

export class QueueLifecycleService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly workspaces: WorkspaceRepository,
    private readonly conversations: ConversationRepository,
    private readonly sessions: SessionLifecycleService,
    private readonly runtime: QueueRuntime
  ) {}

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
    let skipped: Task[] = []

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
          haltReason = `queue-cost-cap-exceeded: cumulative ${totalCostUsd.toFixed(
            2
          )} + per-task ${maxCostPerTask.toFixed(2)} > ${opts.maxQueueCost.toFixed(2)}`
          break
        }

        const taskDir = path.join(artifactDir, 'tasks', task.id)
        await this.runtime.mkdir(taskDir)
        const promptText = task.body ?? ''
        await this.runtime.writeFile(path.join(taskDir, 'prompt.md'), promptText)

        const startResult = this.sessions.startSession({
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
          claudeBin
        })
        if (spawnAttempt.error) {
          const reason = `spawn-error: ${spawnAttempt.error.message}`
          const errStats = await this.writeDiffArtifact(taskDir, ws.cwd)
          queueFilesTouched += errStats.filesTouched
          queueNewFilesCreated += errStats.newFiles
          await this.failTask(task, sessionId, reason, taskDir)
          bumpProfile('failed')
          taskOutcomes.push({ id: task.id, outcome: 'FAILED', reason })
          failed.push(task)
          halted = true
          haltReason = reason
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
          taskOutcomes.push({ id: task.id, outcome: 'FAILED', costUsd: spawn.totalCostUsd, reason })
          failed.push(task)
          halted = true
          haltReason = reason
          break
        }

        const acReason = await this.runAcCommands(promptText, ws.cwd, taskDir, acTimeoutMs)
        if (acReason) {
          await this.failTask(task, sessionId, acReason, taskDir)
          bumpProfile('failed')
          taskOutcomes.push({ id: task.id, outcome: 'FAILED', costUsd: spawn.totalCostUsd, reason: acReason })
          failed.push(task)
          halted = true
          haltReason = acReason
          break
        }

        if (spawn.totalCostUsd > maxCostPerTask) {
          const reason = `cost-cap-exceeded: ${spawn.totalCostUsd.toFixed(
            2
          )} > ${maxCostPerTask.toFixed(2)}`
          await this.failTask(task, sessionId, reason, taskDir)
          bumpProfile('failed')
          taskOutcomes.push({ id: task.id, outcome: 'FAILED', costUsd: spawn.totalCostUsd, reason })
          failed.push(task)
          halted = true
          haltReason = reason
          break
        }

        this.sessions.endSession(sessionId, {
          handoff: {
            resumePoint: `auto-completed by queue runner (queue ${queueRunId})`,
            decisions: [`Queue ${queueRunId} marked ${task.id} DONE — diff at ${taskDir}/diff.patch`]
          }
        })
        bumpProfile('success')
        taskOutcomes.push({ id: task.id, outcome: 'DONE', costUsd: spawn.totalCostUsd, numTurns: spawn.numTurns })
        done.push(task)
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
    }

    return { done, failed, skipped, totalCostUsd, halted, haltReason, queueRunId, artifactDir }
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
      const cmd = cmds[i]
      const r = await this.runtime.execShell(cmd, { cwd, timeoutMs })
      const log = `$ ${cmd}\nexit ${r.exitCode}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`
      await this.runtime.writeFile(path.join(taskDir, `ac-${i}.log`), log)
      if (r.exitCode !== 0) {
        return `ac-failed: \`${cmd}\` exit ${r.exitCode}`
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
    return parseDiffStats(diff)
  }

  private async failTask(
    task: Task,
    sessionId: string,
    reason: string,
    taskDir: string
  ): Promise<void> {
    const refreshed = this.tasks.get(task.id)
    if (!refreshed) throw new TaskNotFoundError(task.id)
    const nextLabels = refreshed.labels.includes(AUTO_FAILED_LABEL)
      ? refreshed.labels
      : [...refreshed.labels, AUTO_FAILED_LABEL]
    this.tasks.update(task.id, { labels: nextLabels, status: 'READY' })

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

    this.sessions.abandonSession(sessionId, reason)
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

function parseDiffStats(diff: string): { filesTouched: number; newFiles: number } {
  let totalFiles = 0
  let newFiles = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) totalFiles += 1
    else if (line.startsWith('new file mode')) newFiles += 1
  }
  return { filesTouched: totalFiles - newFiles, newFiles }
}
