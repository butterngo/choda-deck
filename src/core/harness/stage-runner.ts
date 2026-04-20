import { spawn, type ChildProcess } from 'node:child_process'
import { buildCommandLine } from './spawn-utils'
import { HarnessError } from './errors'

export interface ClaudeResultJson {
  type?: string
  subtype?: string
  result?: string
  is_error?: boolean
  total_cost_usd?: number
  duration_ms?: number
  usage?: unknown
  [key: string]: unknown
}

export interface StageRunOptions {
  workspacePath: string
  prompt: string
  model: string
  tools: readonly string[]
  allowedTools?: readonly string[]
  maxBudgetUsd: number
  timeoutMs: number
  claudeCmd?: string
  spawnFn?: typeof spawn
}

export interface StageRunResult {
  parsed: ClaudeResultJson
  stdout: string
  stderr: string
  durationMs: number
  totalCostUsd: number
  exitCode: number
}

const SIGKILL_GRACE_MS = 10_000

export class StageTimeoutError extends HarnessError {
  constructor(
    public readonly timeoutMs: number,
    public readonly stderr: string
  ) {
    super('STAGE_TIMEOUT', `Stage timed out after ${timeoutMs}ms`)
    this.name = 'StageTimeoutError'
  }
}

export class StageBudgetExceededError extends HarnessError {
  constructor(
    public readonly cap: number,
    public readonly actual: number
  ) {
    super('STAGE_BUDGET_EXCEEDED', `Budget $${actual} exceeded cap $${cap}`)
    this.name = 'StageBudgetExceededError'
  }
}

export class StageNonZeroExitError extends HarnessError {
  constructor(
    public readonly exitCode: number,
    public readonly stderr: string
  ) {
    super('STAGE_NON_ZERO_EXIT', `Claude exited with code ${exitCode}: ${stderr.slice(0, 300)}`)
    this.name = 'StageNonZeroExitError'
  }
}

export class StageInvalidOutputError extends HarnessError {
  constructor(public readonly raw: string) {
    super('STAGE_INVALID_OUTPUT', `Claude stdout was not valid JSON: ${raw.slice(0, 300)}`)
    this.name = 'StageInvalidOutputError'
  }
}

function defaultClaudeCmd(): string {
  return process.env.CLAUDE_CLI_PATH ?? (process.platform === 'win32' ? 'claude.cmd' : 'claude')
}

function buildClaudeArgs(opts: StageRunOptions): string[] {
  const args: string[] = [
    '-p',
    '--model',
    opts.model,
    '--output-format',
    'json',
    '--no-session-persistence',
    '--setting-sources',
    'user',
    '--tools',
    opts.tools.join(','),
    '--max-budget-usd',
    String(opts.maxBudgetUsd)
  ]
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push('--allowed-tools', opts.allowedTools.join(' '))
  }
  return args
}

function killProcessTree(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch {
    /* already exited */
  }
  setTimeout(() => {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* noop */
      }
    }
  }, SIGKILL_GRACE_MS).unref()
}

export async function runClaudeStage(opts: StageRunOptions): Promise<StageRunResult> {
  const claudeCmd = opts.claudeCmd ?? defaultClaudeCmd()
  const spawnImpl = opts.spawnFn ?? spawn
  const args = buildClaudeArgs(opts)
  const isWin = process.platform === 'win32'
  const startedAt = Date.now()

  const child = isWin
    ? spawnImpl(buildCommandLine(claudeCmd, args), {
        cwd: opts.workspacePath,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    : spawnImpl(claudeCmd, args, {
        cwd: opts.workspacePath,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      })

  if (child.stdin) {
    child.stdin.write(opts.prompt)
    child.stdin.end()
  }

  let stdout = ''
  let stderr = ''
  let timedOut = false

  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString()
  })
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString()
  })

  const timer = setTimeout(() => {
    timedOut = true
    killProcessTree(child)
  }, opts.timeoutMs)

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(-1)
    })
  })

  const durationMs = Date.now() - startedAt

  if (timedOut) throw new StageTimeoutError(opts.timeoutMs, stderr)

  let parsed: ClaudeResultJson
  try {
    parsed = JSON.parse(stdout) as ClaudeResultJson
  } catch {
    throw new StageInvalidOutputError(stdout)
  }

  const totalCostUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0
  if (totalCostUsd > opts.maxBudgetUsd * 2.5) {
    throw new StageBudgetExceededError(opts.maxBudgetUsd, totalCostUsd)
  }

  if (exitCode !== 0 || parsed.is_error === true) {
    if (parsed.subtype === 'error_max_turns' || /budget/i.test(parsed.result ?? '')) {
      throw new StageBudgetExceededError(opts.maxBudgetUsd, totalCostUsd)
    }
    throw new StageNonZeroExitError(exitCode, stderr || (parsed.result ?? ''))
  }

  return {
    parsed,
    stdout,
    stderr,
    durationMs,
    totalCostUsd,
    exitCode
  }
}
