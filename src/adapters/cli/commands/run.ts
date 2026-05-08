import { parseArgs } from 'node:util'
import * as path from 'node:path'
import type { Task } from '../../../core/domain/task-types'
import type { SqliteTaskService } from '../../../core/domain/sqlite-task-service'
import { createCliServices } from '../service-factory'
import {
  AUTO_SAFE_LABEL,
  validateAutoSafeTask
} from '../../../core/domain/auto-safe-validator'
import {
  ClaudePCoderDriver,
  CODER_SYSTEM_PROMPT,
  runProcess,
  verifySpecSyntax
} from '../../../core/executor/coder'
import { runTester } from '../../../core/executor/tester'
import { reportHasFailure } from '../../../core/executor/ac-report'

export const runCommandHelp = `Usage: choda-deck run <taskId> --workspace <workspaceId> [options]

Required:
  --workspace <id>          Workspace label (e.g. remote-workflow)

Options:
  --worktree <path>         Worktree cwd to run inside (default: workspace.cwd from DB)
  --artifact-root <path>    Override CHODA_PLAYWRIGHT_ARTIFACT_ROOT (default: env or C:\\temp\\playwright)
  --pnpm-bin <bin>          pnpm executable (default: pnpm)
  --claude-bin <bin>        claude executable (default: claude)
  --max-budget-usd <n>      Per-coder budget ceiling (default: 0.30)
  --skip-coder              Skip Coder stage — assume spec already exists at <spec-path>
  --spec-path <path>        Required when --skip-coder is set (repo-relative .spec.ts)
  --dry-run                 Validate gates + resolve paths only — do not spawn Coder/Tester
  --json                    Emit JSON summary to stdout

Exit codes:
  0  all ACs pass + no diff drift + static scan ok
  1  AC failure / static scan fail / diff drift / Coder verify fail
  2  bad args
  3  task not found
  4  label gate failed (missing fe-playwright-test or fails auto-safe validator)
`

const FE_LABEL = 'fe-playwright-test'

export interface RunCommandResult {
  exitCode: number
  taskId: string
  workspaceId: string
  worktreeCwd: string
  branch: string | null
  specRelPath: string | null
  reportPath: string | null
  artifactDir: string | null
  notes: string[]
}

export async function runRunCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      workspace: { type: 'string' },
      worktree: { type: 'string' },
      'artifact-root': { type: 'string' },
      'pnpm-bin': { type: 'string' },
      'claude-bin': { type: 'string' },
      'max-budget-usd': { type: 'string' },
      'skip-coder': { type: 'boolean', default: false },
      'spec-path': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: true,
    strict: true
  })

  if (parsed.values.help) {
    process.stdout.write(runCommandHelp)
    return 0
  }

  const taskId = parsed.positionals[0]
  if (!taskId) {
    process.stderr.write(`error: task id is required\n\n${runCommandHelp}`)
    return 2
  }
  const workspaceId = parsed.values.workspace
  if (!workspaceId) {
    process.stderr.write(`error: --workspace is required\n\n${runCommandHelp}`)
    return 2
  }
  if (parsed.values['skip-coder'] && !parsed.values['spec-path']) {
    process.stderr.write(`error: --skip-coder requires --spec-path\n`)
    return 2
  }

  const json = parsed.values.json === true
  const result = await execute({
    taskId,
    workspaceId,
    worktreeOverride: parsed.values.worktree,
    artifactRootOverride: parsed.values['artifact-root'],
    pnpmBin: parsed.values['pnpm-bin'] ?? 'pnpm',
    claudeBin: parsed.values['claude-bin'] ?? 'claude',
    maxBudgetUsd: parseFloat(parsed.values['max-budget-usd'] ?? '0.30'),
    skipCoder: parsed.values['skip-coder'] === true,
    specPathOverride: parsed.values['spec-path'],
    dryRun: parsed.values['dry-run'] === true
  })

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(formatPlain(result))
  }
  return result.exitCode
}

interface ExecuteInput {
  taskId: string
  workspaceId: string
  worktreeOverride: string | undefined
  artifactRootOverride: string | undefined
  pnpmBin: string
  claudeBin: string
  maxBudgetUsd: number
  skipCoder: boolean
  specPathOverride: string | undefined
  dryRun: boolean
}

async function execute(input: ExecuteInput): Promise<RunCommandResult> {
  const notes: string[] = []
  const { svc } = await createCliServices()

  const task = svc.getTask(input.taskId)
  if (!task) {
    return baseResult(input, {
      exitCode: 3,
      worktreeCwd: '',
      branch: null,
      specRelPath: null,
      reportPath: null,
      artifactDir: null,
      notes: [`task ${input.taskId} not found`]
    })
  }

  const labelGate = validateLabelGate(task)
  if (!labelGate.ok) {
    return baseResult(input, {
      exitCode: 4,
      worktreeCwd: '',
      branch: null,
      specRelPath: null,
      reportPath: null,
      artifactDir: null,
      notes: labelGate.errors
    })
  }

  const worktreeCwd = await resolveWorktreeCwd({
    svc,
    workspaceId: input.workspaceId,
    override: input.worktreeOverride
  })
  if (!worktreeCwd) {
    return baseResult(input, {
      exitCode: 4,
      worktreeCwd: '',
      branch: null,
      specRelPath: null,
      reportPath: null,
      artifactDir: null,
      notes: [`workspace "${input.workspaceId}" not registered and no --worktree override`]
    })
  }

  const branch = await readBranch(worktreeCwd)
  const artifactRoot =
    input.artifactRootOverride ??
    process.env.CHODA_PLAYWRIGHT_ARTIFACT_ROOT ??
    'C:\\temp\\playwright'

  if (input.dryRun) {
    notes.push('dry-run — gates ok, would spawn Coder + Tester')
    return baseResult(input, {
      exitCode: 0,
      worktreeCwd,
      branch,
      specRelPath: input.specPathOverride ?? null,
      reportPath: null,
      artifactDir: null,
      notes
    })
  }

  const session = await ensureActiveSession({
    svc,
    projectId: task.projectId,
    taskId: task.id,
    workspaceId: input.workspaceId
  })

  let specRelPath: string | null = null

  if (input.skipCoder) {
    specRelPath = input.specPathOverride!
    notes.push(`skip-coder — using existing spec ${specRelPath}`)
  } else {
    svc.checkpointSession(session.id, {
      checkpoint: {
        resumePoint: 'coder-start',
        notes: `Coder spawning for ${task.id} in ${worktreeCwd}`
      }
    })
    const driver = new ClaudePCoderDriver({
      claudeBin: input.claudeBin,
      model: 'claude-haiku-4-5-20251001'
    })
    let coderOut
    try {
      coderOut = await driver.spawnCoder({
        task,
        worktreeCwd,
        workspaceLabel: input.workspaceId,
        systemPrompt: CODER_SYSTEM_PROMPT,
        maxBudgetUsd: input.maxBudgetUsd
      })
    } catch (err) {
      notes.push(`coder failed: ${err instanceof Error ? err.message : String(err)}`)
      return baseResult(input, {
        exitCode: 1,
        worktreeCwd,
        branch,
        specRelPath: null,
        reportPath: null,
        artifactDir: null,
        notes
      })
    }

    specRelPath = coderOut.filePath
    if (typeof coderOut.costUsd === 'number' && coderOut.costUsd > input.maxBudgetUsd) {
      notes.push(
        `cost-warn: coder used $${coderOut.costUsd.toFixed(4)} > budget $${input.maxBudgetUsd.toFixed(2)}`
      )
    }
    svc.checkpointSession(session.id, {
      checkpoint: {
        resumePoint: 'coder-commit',
        notes: `Coder committed ${specRelPath}`,
        lastCommit: coderOut.commitSha
      }
    })

    const verify = await verifySpecSyntax(worktreeCwd, specRelPath, input.pnpmBin)
    if (!verify.ok) {
      notes.push(`coder syntax verify failed:\n${verify.output.slice(0, 4000)}`)
      return baseResult(input, {
        exitCode: 1,
        worktreeCwd,
        branch,
        specRelPath,
        reportPath: null,
        artifactDir: null,
        notes
      })
    }
  }

  svc.checkpointSession(session.id, {
    checkpoint: {
      resumePoint: 'tester-start',
      notes: `Tester running ${specRelPath}`
    }
  })

  const tester = await runTester({
    task,
    worktreeCwd,
    workspaceLabel: input.workspaceId,
    branch: branch ?? '<unknown>',
    specRelPath: specRelPath!,
    artifactRoot,
    pnpmBin: input.pnpmBin
  })

  svc.checkpointSession(session.id, {
    checkpoint: {
      resumePoint: 'tester-complete',
      notes: `Tester complete — report: ${tester.reportPath}`
    }
  })

  const exitCode = reportHasFailure(tester.report) ? 1 : 0
  if (!tester.report.diffGuard.clean) {
    notes.push('git-diff guard failed — Tester run mutated worktree')
  }
  if (!tester.report.staticScan.ok) {
    notes.push(`static scan rejected spec:\n${tester.report.staticScan.violations.join('\n')}`)
  }

  return baseResult(input, {
    exitCode,
    worktreeCwd,
    branch,
    specRelPath,
    reportPath: tester.reportPath,
    artifactDir: tester.artifactDir,
    notes
  })
}

export function validateLabelGate(task: Task): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  if (!task.labels.includes(FE_LABEL)) {
    errors.push(`task is missing required label "${FE_LABEL}" (has: ${task.labels.join(', ') || '<none>'})`)
  }
  if (!task.labels.includes(AUTO_SAFE_LABEL)) {
    errors.push(
      `task is missing "${AUTO_SAFE_LABEL}" label — gate requires both "${FE_LABEL}" and "${AUTO_SAFE_LABEL}"`
    )
  }
  const validation = validateAutoSafeTask(task)
  if (!validation.valid) {
    for (const e of validation.errors) errors.push(`auto-safe: ${e}`)
  }
  return { ok: errors.length === 0, errors }
}

async function resolveWorktreeCwd(args: {
  svc: SqliteTaskService
  workspaceId: string
  override: string | undefined
}): Promise<string | null> {
  if (args.override) return path.resolve(args.override)
  const ws = args.svc.getWorkspace(args.workspaceId)
  return ws ? ws.cwd : null
}

async function readBranch(cwd: string): Promise<string | null> {
  try {
    const r = await runProcess('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeoutMs: 30_000
    })
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

async function ensureActiveSession(args: {
  svc: SqliteTaskService
  projectId: string
  taskId: string
  workspaceId: string
}): Promise<{ id: string }> {
  const active = args.svc.findSessions(args.projectId, 'active')
  const existing = active.find((s) => s.taskId === args.taskId)
  if (existing) return { id: existing.id }
  const start = args.svc.startSession({
    projectId: args.projectId,
    workspaceId: args.workspaceId,
    taskId: args.taskId
  })
  return { id: start.session.id }
}

function baseResult(
  input: ExecuteInput,
  partial: Omit<RunCommandResult, 'taskId' | 'workspaceId'>
): RunCommandResult {
  return {
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    ...partial
  }
}

function formatPlain(r: RunCommandResult): string {
  const lines: string[] = []
  lines.push(`run ${r.taskId} (${r.workspaceId}) — exit ${r.exitCode}`)
  if (r.branch) lines.push(`  branch: ${r.branch}`)
  if (r.worktreeCwd) lines.push(`  worktree: ${r.worktreeCwd}`)
  if (r.specRelPath) lines.push(`  spec: ${r.specRelPath}`)
  if (r.reportPath) lines.push(`  report: ${r.reportPath}`)
  if (r.artifactDir) lines.push(`  artifacts: ${r.artifactDir}`)
  for (const n of r.notes) lines.push(`  - ${n}`)
  return lines.join('\n') + '\n'
}
