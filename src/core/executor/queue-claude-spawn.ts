import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type {
  ExecShellFn,
  ExecShellResult,
  QueueRuntime,
  SpawnClaudeFn,
  SpawnClaudeInput,
  SpawnClaudeOutput
} from '../domain/lifecycle/queue-lifecycle-service'
import { runProcess, runShell } from './coder'
import { composePrewarmPrefix, PrewarmPointerResolveError } from './prewarm-compose'
import { splitLines } from '../utils/lines'
import { loadAccountsConfig } from './accounts-config'

const QUEUE_SPAWN_TOOLS = 'Read,Edit,Write,Bash,Grep,Glob'
const QUEUE_SPAWN_ALLOWED_TOOLS = 'Bash(pnpm *) Bash(node *) Bash(git diff*) Bash(git status*)'
const TOKENS_PER_CHAR = 3.5

/**
 * Trailing role nudge appended to every queue spawn stdin. Forces a final-state AC
 * re-verification before declaring done. Origin: TASK-726 retro — Claude ran AC mid-edit
 * (pass), declared done, post-spawn check caught a regression at FINAL filesystem state,
 * wasted $1+ spawn. ADR-023 Fix 1.
 */
export const QUEUE_AC_FINAL_VERIFY_NUDGE =
  'After all file edits, re-run every command in ## Acceptance ONCE MORE before declaring done. If any AC command exits non-zero, fix and re-run, until all pass at the FINAL filesystem state.'

export function computeToolSchemaTokens(): number {
  const totalChars = QUEUE_SPAWN_TOOLS.length + QUEUE_SPAWN_ALLOWED_TOOLS.length
  return Math.ceil(totalChars / TOKENS_PER_CHAR)
}

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
  dataDir?: string
} = {}): SpawnClaudeFn {
  const spawnTimeoutMs = opts.spawnTimeoutMs ?? 30 * 60 * 1000
  const accountsConfig = opts.dataDir ? loadAccountsConfig(opts.dataDir) : null
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
      QUEUE_SPAWN_TOOLS,
      '--allowed-tools',
      QUEUE_SPAWN_ALLOWED_TOOLS,
      '--permission-mode',
      'bypassPermissions',
      '--max-budget-usd',
      input.maxBudgetUsd.toFixed(2)
    ]

    const prewarm = input.prewarm !== false
    let prefix: string
    if (prewarm) {
      try {
        prefix = await composePrewarmPrefix(input.taskBody, input.cwd)
      } catch (e) {
        if (e instanceof PrewarmPointerResolveError) {
          return {
            isError: true,
            totalCostUsd: 0,
            numTurns: 0,
            resultText: `prewarm-rejected: ${e.errors.join('; ')}`,
            rawJson: ''
          }
        }
        throw e
      }
    } else {
      prefix = ''
    }
    const body = prefix ? `${prefix}\n\n${input.taskBody}` : input.taskBody
    const stdin = `${body}\n\n${QUEUE_AC_FINAL_VERIFY_NUDGE}`

    let env: NodeJS.ProcessEnv | undefined
    if (input.account) {
      const resolved = accountsConfig ? accountsConfig.resolve(input.account) : null
      if (!resolved) {
        return {
          isError: true,
          totalCostUsd: 0,
          numTurns: 0,
          resultText: `account "${input.account}" not found in accounts.json`,
          rawJson: ''
        }
      }
      env = { CLAUDE_CONFIG_DIR: resolved }
    }

    const result = await runProcess(input.claudeBin, args, {
      cwd: input.cwd,
      timeoutMs: spawnTimeoutMs,
      stdin,
      env
    })

    const rawJson = result.stdout
    if (result.exitCode !== 0) {
      // claude -p emits a full result envelope to stdout (cost, turns, errors[]) even when
      // it exits non-zero — e.g. budget cap, max turns, prompt error. Parse it so the queue
      // record preserves real cost + cause instead of $0 + empty stderr (TASK-791).
      const envelope = tryParseClaudeEnvelope(rawJson)
      if (envelope) {
        const parsed = envelopeToOutput(envelope, rawJson)
        return {
          ...parsed,
          isError: true,
          resultText: `claude -p exited ${result.exitCode}: ${parsed.resultText}`
        }
      }
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
 * Production execShell — `sh -c` on POSIX, `cmd /c` on Windows. Captures stdout/stderr and exit
 * code. Shell operators (`&&`, `||`, pipes) work because the command is passed to the system shell.
 */
export const productionExecShell: ExecShellFn = async (cmd, opts) => {
  const r = await runShell(cmd, { cwd: opts.cwd, timeoutMs: opts.timeoutMs })
  return r as ExecShellResult
}

/**
 * Build a production `QueueRuntime` from real fs / git / spawn primitives.
 */
export function createQueueRuntime(opts: {
  artifactsDir: string
  queueMcpEmptyPath: string
  spawnTimeoutMs?: number
  dataDir?: string
}): QueueRuntime {
  return {
    spawnClaude: createQueueClaudeSpawner({ spawnTimeoutMs: opts.spawnTimeoutMs, dataDir: opts.dataDir }),
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
    gitUntrackedFiles: async (cwd) => {
      const r = await runProcess('git', ['ls-files', '--others', '--exclude-standard'], { cwd, timeoutMs: 30_000 })
      if (r.exitCode !== 0) {
        throw new Error(`git ls-files failed (${r.exitCode}): ${r.stderr.slice(0, 500)}`)
      }
      return splitLines(r.stdout).map((s) => s.trim()).filter(Boolean)
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
    gitWorktreeAdd: async ({ repoCwd, worktreePath, branch, baseSha }) => {
      const r = await runProcess(
        'git',
        ['worktree', 'add', '-b', branch, worktreePath, baseSha],
        { cwd: repoCwd, timeoutMs: 60_000 }
      )
      if (r.exitCode !== 0) {
        throw new Error(`git worktree add failed (${r.exitCode}): ${r.stderr.slice(0, 500)}`)
      }
    },
    pathExists: async (p) => {
      try {
        await fsp.access(p)
        return true
      } catch {
        return false
      }
    },
    isWritable: async (dirPath) => {
      // Cross-platform writability probe: touch a temp file. `fs.access(W_OK)` lies on
      // Windows for read-only dirs, so we do a real write attempt and clean up.
      const probe = path.join(dirPath, `.choda-write-probe-${process.pid}-${Date.now()}`)
      try {
        await fsp.writeFile(probe, '')
        await fsp.unlink(probe)
        return true
      } catch {
        return false
      }
    },
    resolveRef: async (repoCwd, ref) => {
      // `git log -1 --format=%H <ref>` returns the commit SHA, peeling annotated
      // tags. Equivalent to `rev-parse --verify <ref>^{commit}` but without the
      // `^` caret, which cmd.exe strips when child_process spawns with shell:true
      // on Windows (turning `main^{commit}` into `main{commit}` → unresolvable).
      const r = await runProcess('git', ['log', '-1', '--format=%H', ref], {
        cwd: repoCwd,
        timeoutMs: 30_000
      })
      if (r.exitCode !== 0) return null
      const sha = r.stdout.trim()
      return sha.length > 0 ? sha : null
    },
    branchExists: async (repoCwd, branch) => {
      const r = await runProcess('git', ['show-ref', '--verify', `refs/heads/${branch}`], {
        cwd: repoCwd,
        timeoutMs: 30_000
      })
      return r.exitCode === 0
    },
    ghAuthStatus: async () => {
      const r = await runProcess('gh', ['auth', 'status'], { cwd: os.tmpdir(), timeoutMs: 30_000 })
      return r.exitCode === 0
    },
    fileExistsAtSha: async (repoCwd, sha, relPath) => {
      const normalized = relPath.split(path.sep).join('/')
      const r = await runProcess('git', ['cat-file', '-e', `${sha}:${normalized}`], {
        cwd: repoCwd,
        timeoutMs: 30_000
      })
      return r.exitCode === 0
    },
    mkdir: async (dir) => {
      await fsp.mkdir(dir, { recursive: true })
    },
    writeFile: async (file, content) => {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, content, 'utf8')
    },
    appendFile: async (file, content) => {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.appendFile(file, content, 'utf8')
    },
    readFile: async (file) => {
      return await fsp.readFile(file, 'utf8')
    },
    artifactsDir: opts.artifactsDir,
    queueMcpEmptyPath: opts.queueMcpEmptyPath,
    mcpProfile: 'empty'
  }
}

interface ClaudeJsonShape {
  is_error?: unknown
  total_cost_usd?: unknown
  num_turns?: unknown
  result?: unknown
  errors?: unknown
  total_input_tokens?: unknown
  cache_read_input_tokens?: unknown
}

function tryParseClaudeEnvelope(rawJson: string): ClaudeJsonShape | null {
  if (!rawJson || rawJson.trim().length === 0) return null
  try {
    const parsed = JSON.parse(rawJson)
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed as ClaudeJsonShape
  } catch {
    return null
  }
}

function extractEnvelopeText(envelope: ClaudeJsonShape): string {
  if (typeof envelope.result === 'string' && envelope.result.length > 0) return envelope.result
  if (Array.isArray(envelope.errors)) {
    const errs = envelope.errors.filter((e): e is string => typeof e === 'string')
    if (errs.length > 0) return errs.join('; ')
  }
  return ''
}

function envelopeToOutput(envelope: ClaudeJsonShape, rawJson: string): SpawnClaudeOutput {
  return {
    isError: envelope.is_error === true,
    totalCostUsd: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : 0,
    numTurns: typeof envelope.num_turns === 'number' ? envelope.num_turns : 0,
    resultText: extractEnvelopeText(envelope),
    rawJson,
    totalInputTokens: typeof envelope.total_input_tokens === 'number' ? envelope.total_input_tokens : null,
    cacheReadInputTokens: typeof envelope.cache_read_input_tokens === 'number' ? envelope.cache_read_input_tokens : null
  }
}

function parseClaudeJson(rawJson: string): SpawnClaudeOutput {
  const envelope = tryParseClaudeEnvelope(rawJson)
  if (!envelope) {
    return {
      isError: true,
      totalCostUsd: 0,
      numTurns: 0,
      resultText: `claude -p stdout is not valid JSON (first 500 chars): ${rawJson.slice(0, 500)}`,
      rawJson,
      totalInputTokens: null,
      cacheReadInputTokens: null
    }
  }
  return envelopeToOutput(envelope, rawJson)
}
