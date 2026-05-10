import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type {
  ExecShellFn,
  ExecShellResult,
  QueueRuntime,
  SpawnClaudeFn,
  SpawnClaudeInput,
  SpawnClaudeOutput
} from '../domain/lifecycle/queue-lifecycle-service'
import { runProcess } from './coder'

/**
 * Production spawner for `QueueLifecycleService` — wraps `runProcess` (also used by
 * `ClaudePCoderDriver`) with the canonical queue spawn signature locked in ADR-019 v2:
 *
 *   claude -p
 *     --model <id>
 *     --output-format json
 *     --no-session-persistence
 *     --setting-sources user
 *     --strict-mcp-config --mcp-config <queueMcpEmptyPath>
 *     --tools "Read,Edit,Write,Bash,Grep,Glob"
 *     --allowed-tools "Bash(pnpm *) Bash(node *) Bash(git diff*) Bash(git status*)"
 *     --permission-mode bypassPermissions
 *     --max-budget-usd <n>
 *
 * Justification for `bypassPermissions`: queue runs only execute under the safety envelope
 * of clean-IN tree + post-hoc cost cap + auto-safe scope ≤3h (see ADR-019 v2). The Bash
 * allowlist scopes side effects to pnpm/node/git read-ops; outbound network and destructive
 * git commands are not whitelisted.
 */
export function createQueueClaudeSpawner(opts: {
  spawnTimeoutMs?: number
} = {}): SpawnClaudeFn {
  const spawnTimeoutMs = opts.spawnTimeoutMs ?? 30 * 60 * 1000
  return async (input: SpawnClaudeInput): Promise<SpawnClaudeOutput> => {
    const args = [
      '-p',
      '--model',
      input.model,
      '--output-format',
      'json',
      '--no-session-persistence',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--mcp-config',
      input.queueMcpEmptyPath,
      '--tools',
      'Read,Edit,Write,Bash,Grep,Glob',
      '--allowed-tools',
      'Bash(pnpm *) Bash(node *) Bash(git diff*) Bash(git status*)',
      '--permission-mode',
      'bypassPermissions',
      '--max-budget-usd',
      input.maxBudgetUsd.toFixed(2)
    ]

    const result = await runProcess(input.claudeBin, args, {
      cwd: input.cwd,
      timeoutMs: spawnTimeoutMs,
      stdin: input.taskBody
    })

    const rawJson = result.stdout
    if (result.exitCode !== 0) {
      return {
        isError: true,
        totalCostUsd: 0,
        numTurns: 0,
        resultText: `claude -p exited ${result.exitCode}: ${result.stderr.slice(0, 1000)}`,
        rawJson
      }
    }

    return parseClaudeJson(rawJson)
  }
}

/**
 * Production execShell — bash on POSIX, `cmd /c` on Windows. Captures stdout/stderr and exit code.
 */
export const productionExecShell: ExecShellFn = async (cmd, opts) => {
  // Pass through the raw command string with shell:true so users can write `pnpm test x && pnpm lint`
  // and have shell operators work. Quoting/escaping is the AC author's responsibility.
  const r = await runProcess(cmd, [], { cwd: opts.cwd, timeoutMs: opts.timeoutMs })
  return r as ExecShellResult
}

/**
 * Build a production `QueueRuntime` from real fs / git / spawn primitives.
 */
export function createQueueRuntime(opts: {
  artifactsDir: string
  queueMcpEmptyPath: string
  spawnTimeoutMs?: number
}): QueueRuntime {
  return {
    spawnClaude: createQueueClaudeSpawner({ spawnTimeoutMs: opts.spawnTimeoutMs }),
    execShell: productionExecShell,
    gitStatusPorcelain: async (cwd) => {
      const r = await runProcess('git', ['status', '--porcelain'], { cwd, timeoutMs: 30_000 })
      if (r.exitCode !== 0) {
        throw new Error(`git status --porcelain failed (${r.exitCode}): ${r.stderr.slice(0, 500)}`)
      }
      return r.stdout
    },
    gitDiff: async (cwd) => {
      const r = await runProcess('git', ['diff'], { cwd, timeoutMs: 60_000 })
      if (r.exitCode !== 0) {
        throw new Error(`git diff failed (${r.exitCode}): ${r.stderr.slice(0, 500)}`)
      }
      return r.stdout
    },
    gitCurrentBranch: async (cwd) => {
      const r = await runProcess('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 30_000 })
      if (r.exitCode !== 0) {
        throw new Error(`git rev-parse --abbrev-ref HEAD failed (${r.exitCode}): ${r.stderr.slice(0, 500)}`)
      }
      return r.stdout.trim()
    },
    gitHeadSha: async (cwd) => {
      const r = await runProcess('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs: 30_000 })
      if (r.exitCode !== 0) {
        throw new Error(`git rev-parse HEAD failed (${r.exitCode}): ${r.stderr.slice(0, 500)}`)
      }
      return r.stdout.trim()
    },
    mkdir: async (dir) => {
      await fsp.mkdir(dir, { recursive: true })
    },
    writeFile: async (file, content) => {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, content, 'utf8')
    },
    artifactsDir: opts.artifactsDir,
    queueMcpEmptyPath: opts.queueMcpEmptyPath
  }
}

interface ClaudeJsonShape {
  is_error?: unknown
  total_cost_usd?: unknown
  num_turns?: unknown
  result?: unknown
}

function parseClaudeJson(rawJson: string): SpawnClaudeOutput {
  let parsed: ClaudeJsonShape
  try {
    parsed = JSON.parse(rawJson) as ClaudeJsonShape
  } catch {
    return {
      isError: true,
      totalCostUsd: 0,
      numTurns: 0,
      resultText: `claude -p stdout is not valid JSON (first 500 chars): ${rawJson.slice(0, 500)}`,
      rawJson
    }
  }
  return {
    isError: parsed.is_error === true,
    totalCostUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
    numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : 0,
    resultText: typeof parsed.result === 'string' ? parsed.result : '',
    rawJson
  }
}
