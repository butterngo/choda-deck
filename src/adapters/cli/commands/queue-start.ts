import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { renderQueueReport } from '../../../core/executor/queue-report'
import type {
  QueueRuntime,
  QueueStartOptions,
  QueueStartResult,
  QueueStartTaskOutcome
} from '../../../core/domain/lifecycle/queue-lifecycle-service'
import { WorkspaceResolutionError } from '../../../core/domain/lifecycle/errors'
import { createQueueRuntime } from '../../../core/executor/queue-claude-spawn'
import type { CliServices } from '../service-factory'
import { createCliServices } from '../service-factory'

export const queueStartCommandHelp = `Usage: choda-deck queue start --workspace <id> [options]

Batch trigger for READY auto-safe tasks. Each task runs in its own git worktree
forked from --base-ref so diffs and branches don't collide. Pre-flight verifies
every task before any spawn — a single bad task aborts the whole batch by default.

Required:
  --workspace <id>             Workspace label (e.g. choda-deck)

Options:
  --base-ref <ref>             Git ref to fork worktrees from (default: main)
  --worktrees-dir <path>       Parent dir for per-task worktrees
                               (default: <workspace.cwd>.worktrees)
  --branch-prefix <prefix>     Per-task branch prefix (default: auto/)
  --force-continue             Skip per-task preflight failures, run the rest
  --max-cost-per-task <n>      Per-task post-hoc cost cap, USD (default: 1.50)
  --max-tasks <n>              Stop after at most N tasks
  --dry-run                    Run preflight only, do not spawn
  --json                       Emit JSON summary to stdout
  --claude-bin <path>          claude executable (default: claude)
  --model <id>                 Claude model (default: claude-sonnet-4-6)
  --help                       Show this help

Exit codes:
  0    all DONE (or dry-run preflight ok)
  1    one or more tasks FAILED mid-run
  2    bad args
  3    workspace not found
  4    pre-flight aborted (default policy) or global pre-flight error
  130  interrupted (SIGINT)
`

export interface QueueStartResultPayload {
  exitCode: number
  workspaceId: string
  queueRunId: string | null
  artifactDir: string | null
  baseRef: string
  baseSha: string | null
  done: string[]
  failed: { taskId: string; reason: string | null }[]
  skippedPreflight: { taskId: string; reason: string | null }[]
  totalCostUsd: number
  preflightAborted: boolean
  preflightAbortReason: string | null
  notes: string[]
}

export async function runQueueStartCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      workspace: { type: 'string' },
      'base-ref': { type: 'string' },
      'worktrees-dir': { type: 'string' },
      'branch-prefix': { type: 'string' },
      'force-continue': { type: 'boolean', default: false },
      'max-cost-per-task': { type: 'string' },
      'max-tasks': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'claude-bin': { type: 'string' },
      model: { type: 'string' },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: false,
    strict: true
  })

  if (parsed.values.help) {
    process.stdout.write(queueStartCommandHelp)
    return 0
  }

  const workspaceId = parsed.values.workspace
  if (!workspaceId) {
    process.stderr.write(`error: --workspace is required\n\n${queueStartCommandHelp}`)
    return 2
  }

  const maxCostPerTask = parseOptionalNumber(parsed.values['max-cost-per-task'])
  if (parsed.values['max-cost-per-task'] !== undefined && maxCostPerTask === null) {
    process.stderr.write(`error: --max-cost-per-task must be a number\n`)
    return 2
  }
  const maxTasks = parseOptionalNumber(parsed.values['max-tasks'])
  if (parsed.values['max-tasks'] !== undefined && (maxTasks === null || maxTasks < 1)) {
    process.stderr.write(`error: --max-tasks must be a positive integer\n`)
    return 2
  }

  const json = parsed.values.json === true
  const result = await execute({
    workspaceId,
    baseRef: parsed.values['base-ref'] ?? 'main',
    worktreesDir: parsed.values['worktrees-dir'],
    branchPrefix: parsed.values['branch-prefix'],
    forceContinue: parsed.values['force-continue'] === true,
    maxCostPerTask: maxCostPerTask ?? undefined,
    maxTasks: maxTasks ?? undefined,
    dryRun: parsed.values['dry-run'] === true,
    claudeBin: parsed.values['claude-bin'],
    model: parsed.values.model
  })

  if (result.artifactDir) {
    try {
      const markdown = await renderQueueReport(result.artifactDir)
      fs.writeFileSync(path.join(result.artifactDir, 'report.md'), markdown, 'utf8')
    } catch (err) {
      process.stderr.write(
        `queue start: warning — failed to write report.md: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(formatPlain(result))
  }
  return result.exitCode
}

interface ExecuteInput {
  workspaceId: string
  baseRef: string
  worktreesDir: string | undefined
  branchPrefix: string | undefined
  forceContinue: boolean
  maxCostPerTask: number | undefined
  maxTasks: number | undefined
  dryRun: boolean
  claudeBin: string | undefined
  model: string | undefined
}

export async function execute(input: ExecuteInput): Promise<QueueStartResultPayload> {
  const services = await createCliServices()
  const queueMcpEmptyPath = ensureQueueMcpEmpty(services.dataDir)
  const runtime = createQueueRuntime({
    artifactsDir: services.artifactsDir,
    queueMcpEmptyPath
  })
  return executeWithServices(input, services, runtime)
}

export async function executeWithServices(
  input: ExecuteInput,
  services: CliServices,
  runtime: QueueRuntime
): Promise<QueueStartResultPayload> {
  const notes: string[] = []
  const ws = services.svc.getWorkspace(input.workspaceId)
  if (!ws) {
    return {
      exitCode: 3,
      workspaceId: input.workspaceId,
      queueRunId: null,
      artifactDir: null,
      baseRef: input.baseRef,
      baseSha: null,
      done: [],
      failed: [],
      skippedPreflight: [],
      totalCostUsd: 0,
      preflightAborted: false,
      preflightAbortReason: null,
      notes: [`workspace "${input.workspaceId}" not registered`]
    }
  }

  const queue = services.svc.createQueueLifecycle(runtime)
  installSigintHandler()

  const worktreesParentDir = input.worktreesDir ?? `${ws.cwd}.worktrees`

  const opts: QueueStartOptions = {
    workspaceId: input.workspaceId,
    baseRef: input.baseRef,
    worktreesParentDir,
    branchPrefix: input.branchPrefix,
    forceContinue: input.forceContinue,
    maxCostPerTask: input.maxCostPerTask,
    maxTasks: input.maxTasks,
    dryRun: input.dryRun,
    claudeBin: input.claudeBin,
    model: input.model
  }

  let runResult: QueueStartResult
  try {
    runResult = await queue.runQueueStart(opts)
  } catch (err) {
    if (err instanceof WorkspaceResolutionError) {
      return {
        exitCode: 3,
        workspaceId: input.workspaceId,
        queueRunId: null,
        artifactDir: null,
        baseRef: input.baseRef,
        baseSha: null,
        done: [],
        failed: [],
        skippedPreflight: [],
        totalCostUsd: 0,
        preflightAborted: false,
        preflightAbortReason: null,
        notes: [err.message]
      }
    }
    throw err
  }

  if (input.dryRun) {
    notes.push(
      `dry-run — preflight ${runResult.preflightAborted ? 'WOULD ABORT' : 'OK'}, ${runResult.taskOutcomes.length} eligible task(s)`
    )
  }

  const done = runResult.taskOutcomes
    .filter((o) => o.outcome === 'DONE')
    .map((o) => o.taskId)
  const failed = runResult.taskOutcomes
    .filter((o) => o.outcome === 'FAILED')
    .map<{ taskId: string; reason: string | null }>((o) => ({
      taskId: o.taskId,
      reason: o.reason ?? null
    }))
  const skippedPreflight = runResult.taskOutcomes
    .filter((o) => o.outcome === 'SKIPPED_PREFLIGHT')
    .map<{ taskId: string; reason: string | null }>((o) => ({
      taskId: o.taskId,
      reason: o.reason ?? null
    }))

  return {
    exitCode: computeExitCode(runResult),
    workspaceId: input.workspaceId,
    queueRunId: runResult.queueRunId,
    artifactDir: runResult.artifactDir,
    baseRef: runResult.baseRef,
    baseSha: runResult.baseSha,
    done,
    failed,
    skippedPreflight,
    totalCostUsd: runResult.totalCostUsd,
    preflightAborted: runResult.preflightAborted,
    preflightAbortReason: runResult.preflightAbortReason,
    notes
  }
}

export function computeExitCode(r: QueueStartResult): number {
  if (r.preflightAborted) return 4
  if (r.failedCount > 0) return 1
  return 0
}

function parseOptionalNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function ensureQueueMcpEmpty(dataDir: string): string {
  const target = path.join(dataDir, 'queue-mcp-empty.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, '{"mcpServers":{}}\n', 'utf8')
  }
  return target
}

let sigintArmed = false

function installSigintHandler(): void {
  if (sigintArmed) return
  sigintArmed = true
  let firstSeen = false
  process.on('SIGINT', () => {
    if (!firstSeen) {
      firstSeen = true
      process.stderr.write(
        'queue start: SIGINT received — finishing current task. Press Ctrl+C again to force-quit.\n'
      )
      return
    }
    process.stderr.write('queue start: second SIGINT — exiting now (130)\n')
    process.exit(130)
  })
}

function formatPlain(r: QueueStartResultPayload): string {
  const lines: string[] = []
  lines.push(`queue start ${r.workspaceId} — exit ${r.exitCode}`)
  lines.push(`  base ref: ${r.baseRef}${r.baseSha ? ` (${r.baseSha.slice(0, 7)})` : ''}`)
  if (r.preflightAborted) {
    lines.push('  PRE-FLIGHT ABORTED — no tasks executed')
    if (r.preflightAbortReason) lines.push(`    reason: ${r.preflightAbortReason}`)
  }
  const total = r.done.length + r.failed.length + r.skippedPreflight.length
  if (total === 0) {
    lines.push('  (no eligible auto-safe tasks)')
  } else {
    let i = 0
    for (const id of r.done) {
      i++
      lines.push(`  [${i}/${total}] ${id} DONE`)
    }
    for (const f of r.failed) {
      i++
      lines.push(`  [${i}/${total}] ${f.taskId} FAILED — ${f.reason ?? 'unknown'}`)
    }
    for (const s of r.skippedPreflight) {
      i++
      lines.push(`  [${i}/${total}] ${s.taskId} SKIPPED_PREFLIGHT — ${s.reason ?? 'unknown'}`)
    }
  }
  lines.push(`  total cost: $${r.totalCostUsd.toFixed(4)}`)
  if (r.artifactDir) lines.push(`  artifacts: ${r.artifactDir}`)
  for (const n of r.notes) lines.push(`  - ${n}`)
  return lines.join('\n') + '\n'
}

// referenced via `import('./queue-start').QueueStartTaskOutcome` in places that need the
// per-task shape directly; keep this export to avoid a downstream import detour.
export type { QueueStartTaskOutcome }
