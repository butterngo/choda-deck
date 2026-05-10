import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import type {
  QueueRuntime,
  QueueRunOptions,
  QueueRunResult
} from '../../../core/domain/lifecycle/queue-lifecycle-service'
import { QueueDirtyTreeError, WorkspaceResolutionError } from '../../../core/domain/lifecycle/errors'
import { createQueueRuntime } from '../../../core/executor/queue-claude-spawn'
import type { CliServices } from '../service-factory'
import { createCliServices } from '../service-factory'

export const runQueueCommandHelp = `Usage: choda-deck run-queue --workspace <id> [options]

Required:
  --workspace <id>          Workspace label (e.g. choda-deck)

Options:
  --max-cost-per-task <n>   Per-task post-hoc cost cap, USD (default: 0.50)
  --max-tasks <n>           Stop after at most N tasks
  --dry-run                 Validate workspace + clean tree + list eligible tasks; do not spawn
  --json                    Emit JSON summary to stdout
  --claude-bin <path>       claude executable (default: claude)
  --pnpm-bin <path>         pnpm executable (passthrough — currently unused, reserved for AC exec)
  --model <id>              Claude model (default: claude-sonnet-4-6)
  --help                    Show this help

Sonnet 4.6 is the default model. Override with --model for cost-sensitive runs
(e.g. --model claude-haiku-4-5-20251001 with a smaller --max-cost-per-task).

Exit codes:
  0    all DONE
  1    one or more tasks auto-failed (queue halted on first fail)
  2    bad args
  3    workspace not found
  4    pre-flight clean-tree check failed
  5    cost cap exceeded (per-task or per-queue)
  130  interrupted (SIGINT)
`

export interface RunQueueResultPayload {
  exitCode: number
  workspaceId: string
  done: string[]
  failed: { taskId: string; reason: string | null }[]
  skipped: string[]
  totalCostUsd: number
  halted: boolean
  haltReason: string | null
  artifactDir: string | null
  notes: string[]
}

export async function runRunQueueCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      workspace: { type: 'string' },
      'max-cost-per-task': { type: 'string' },
      'max-tasks': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'claude-bin': { type: 'string' },
      'pnpm-bin': { type: 'string' },
      model: { type: 'string' },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: false,
    strict: true
  })

  if (parsed.values.help) {
    process.stdout.write(runQueueCommandHelp)
    return 0
  }

  const workspaceId = parsed.values.workspace
  if (!workspaceId) {
    process.stderr.write(`error: --workspace is required\n\n${runQueueCommandHelp}`)
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
    maxCostPerTask: maxCostPerTask ?? undefined,
    maxTasks: maxTasks ?? undefined,
    dryRun: parsed.values['dry-run'] === true,
    claudeBin: parsed.values['claude-bin'],
    model: parsed.values.model
  })

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(formatPlain(result))
  }
  return result.exitCode
}

interface ExecuteInput {
  workspaceId: string
  maxCostPerTask: number | undefined
  maxTasks: number | undefined
  dryRun: boolean
  claudeBin: string | undefined
  model: string | undefined
}

export async function execute(input: ExecuteInput): Promise<RunQueueResultPayload> {
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
): Promise<RunQueueResultPayload> {
  const notes: string[] = []
  const ws = services.svc.getWorkspace(input.workspaceId)
  if (!ws) {
    return {
      exitCode: 3,
      workspaceId: input.workspaceId,
      done: [],
      failed: [],
      skipped: [],
      totalCostUsd: 0,
      halted: false,
      haltReason: null,
      artifactDir: null,
      notes: [`workspace "${input.workspaceId}" not registered`]
    }
  }

  const queue = services.svc.createQueueLifecycle(runtime)

  installSigintHandler()

  const opts: QueueRunOptions = {
    workspaceId: input.workspaceId,
    maxCostPerTask: input.maxCostPerTask,
    maxTasks: input.maxTasks,
    dryRun: input.dryRun,
    claudeBin: input.claudeBin,
    model: input.model
  }

  let runResult: QueueRunResult
  try {
    runResult = await queue.runQueue(opts)
  } catch (err) {
    if (err instanceof QueueDirtyTreeError) {
      return {
        exitCode: 4,
        workspaceId: input.workspaceId,
        done: [],
        failed: [],
        skipped: [],
        totalCostUsd: 0,
        halted: true,
        haltReason: err.message,
        artifactDir: null,
        notes: [err.message]
      }
    }
    if (err instanceof WorkspaceResolutionError) {
      return {
        exitCode: 3,
        workspaceId: input.workspaceId,
        done: [],
        failed: [],
        skipped: [],
        totalCostUsd: 0,
        halted: false,
        haltReason: null,
        artifactDir: null,
        notes: [err.message]
      }
    }
    throw err
  }

  const exitCode = computeExitCode(runResult)
  if (input.dryRun) {
    notes.push(
      `dry-run — ${runResult.skipped.length} eligible task(s), tree clean, would spawn`
    )
  }

  return {
    exitCode,
    workspaceId: input.workspaceId,
    done: runResult.done.map((t) => t.id),
    failed: runResult.failed.map((t) => ({ taskId: t.id, reason: runResult.haltReason })),
    skipped: runResult.skipped.map((t) => t.id),
    totalCostUsd: runResult.totalCostUsd,
    halted: runResult.halted,
    haltReason: runResult.haltReason,
    artifactDir: runResult.artifactDir,
    notes
  }
}

function computeExitCode(r: QueueRunResult): number {
  if (r.failed.length === 0) return 0
  if (r.haltReason && /cost-cap-exceeded/i.test(r.haltReason)) return 5
  return 1
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
        'run-queue: SIGINT received — finishing current task. Press Ctrl+C again to force-quit.\n'
      )
      return
    }
    process.stderr.write('run-queue: second SIGINT — exiting now (130)\n')
    process.exit(130)
  })
}

function formatPlain(r: RunQueueResultPayload): string {
  const lines: string[] = []
  lines.push(`run-queue ${r.workspaceId} — exit ${r.exitCode}`)
  const total = r.done.length + r.failed.length + r.skipped.length
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
    for (const id of r.skipped) {
      i++
      lines.push(`  [${i}/${total}] ${id} SKIPPED`)
    }
  }
  lines.push(`  total cost: $${r.totalCostUsd.toFixed(4)}`)
  if (r.halted && r.haltReason) lines.push(`  halted: ${r.haltReason}`)
  if (r.artifactDir) lines.push(`  artifacts: ${r.artifactDir}`)
  for (const n of r.notes) lines.push(`  - ${n}`)
  return lines.join('\n') + '\n'
}
