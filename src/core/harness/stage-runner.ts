import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
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

// Everything the planner-stage catch handler needs to root-cause a failure
// without rerunning the pipeline. Carried on every StageError so callers have
// one canonical shape to persist (DB blob + JSON artifact).
export interface StageDiagnostics {
  exitCode: number
  stdout: string
  stderr: string
  parsed: ClaudeResultJson | null // null when JSON.parse on stdout failed
  cmd: string // reconstructed command line (executable + args, already quoted)
  env: Record<string, string> // whitelisted env snapshot — see snapshotEnv
  workspacePath: string
  durationMs: number
  timedOut: boolean
}

// Env keys that are safe to log. Anything outside this set is dropped entirely
// so credentials / tokens never leak into DB blobs or failure artifacts.
const ENV_WHITELIST: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'CLAUDE_CLI_PATH',
  'NODE_ENV',
  'CHODA_DB_PATH',
  'CHODA_CONTENT_ROOT'
]
const SECRET_PATTERN = /token|key|secret|password/i

export function snapshotEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ENV_WHITELIST) {
    if (SECRET_PATTERN.test(key)) continue
    const v = env[key]
    if (typeof v === 'string') out[key] = v
  }
  if (typeof env.PATH === 'string') {
    out.PATH_fingerprint_sha256_8 = createHash('sha256')
      .update(env.PATH)
      .digest('hex')
      .slice(0, 8)
  }
  return out
}

const SIGKILL_GRACE_MS = 10_000

export class StageTimeoutError extends HarnessError {
  constructor(
    public readonly timeoutMs: number,
    public readonly diagnostics: StageDiagnostics
  ) {
    super('STAGE_TIMEOUT', `Stage timed out after ${timeoutMs}ms`)
    this.name = 'StageTimeoutError'
  }
}

export class StageBudgetExceededError extends HarnessError {
  constructor(
    public readonly cap: number,
    public readonly actual: number,
    public readonly diagnostics: StageDiagnostics
  ) {
    super('STAGE_BUDGET_EXCEEDED', `Budget $${actual} exceeded cap $${cap}`)
    this.name = 'StageBudgetExceededError'
  }
}

export class StageNonZeroExitError extends HarnessError {
  constructor(
    public readonly exitCode: number,
    public readonly diagnostics: StageDiagnostics
  ) {
    super(
      'STAGE_NON_ZERO_EXIT',
      `Claude exited with code ${exitCode}: ${diagnostics.stderr.slice(0, 300)}`
    )
    this.name = 'StageNonZeroExitError'
  }
}

export class StageInvalidOutputError extends HarnessError {
  constructor(public readonly diagnostics: StageDiagnostics) {
    super(
      'STAGE_INVALID_OUTPUT',
      `Claude stdout was not valid JSON: ${diagnostics.stdout.slice(0, 300)}`
    )
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
  const cmdLine = buildCommandLine(claudeCmd, args)
  const envSnapshot = snapshotEnv(process.env)
  const startedAt = Date.now()

  const child = isWin
    ? spawnImpl(cmdLine, {
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

  const mkDiag = (parsed: ClaudeResultJson | null): StageDiagnostics => ({
    exitCode,
    stdout,
    stderr,
    parsed,
    cmd: cmdLine,
    env: envSnapshot,
    workspacePath: opts.workspacePath,
    durationMs,
    timedOut
  })

  if (timedOut) throw new StageTimeoutError(opts.timeoutMs, mkDiag(null))

  let parsed: ClaudeResultJson
  try {
    parsed = JSON.parse(stdout) as ClaudeResultJson
  } catch {
    throw new StageInvalidOutputError(mkDiag(null))
  }

  const totalCostUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0
  if (totalCostUsd > opts.maxBudgetUsd * 2.5) {
    throw new StageBudgetExceededError(opts.maxBudgetUsd, totalCostUsd, mkDiag(parsed))
  }

  if (exitCode !== 0 || parsed.is_error === true) {
    if (parsed.subtype === 'error_max_turns' || /budget/i.test(parsed.result ?? '')) {
      throw new StageBudgetExceededError(opts.maxBudgetUsd, totalCostUsd, mkDiag(parsed))
    }
    throw new StageNonZeroExitError(exitCode, mkDiag(parsed))
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
