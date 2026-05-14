import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import {
  QueueLifecycleService,
  resolveModelForTask,
  type ExecShellResult,
  type QueueRuntime,
  type SpawnClaudeInput,
  type SpawnClaudeOutput
} from './queue-lifecycle-service'
import { QueueDirtyTreeError, WorkspaceResolutionError } from './errors'
import { computeToolSchemaTokens } from '../../executor/queue-claude-spawn'

const TEST_DB = path.join(__dirname, '__test-queue-lifecycle__.db')
let svc: SqliteTaskService

const VALID_BODY = `## Goal
Do work.

## Acceptance
- [ ] Smoke: \`pnpm run lint\`

## File Pointers
- src/foo.ts

## Scope
~1h
`

interface FakeRuntimeState {
  spawnCalls: SpawnClaudeInput[]
  execCalls: { cmd: string; cwd: string }[]
  files: Map<string, string>
  fileReads: Map<string, string>
  dirs: Set<string>
  porcelain: string
  diff: string
  untracked: string[]
}

function buildRuntime(
  overrides: {
    spawn?: (input: SpawnClaudeInput, state: FakeRuntimeState) => Promise<SpawnClaudeOutput>
    exec?: (cmd: string, state: FakeRuntimeState) => Promise<ExecShellResult>
    porcelain?: string
    diff?: string
    untracked?: string[]
    branch?: string
    commitSha?: string
    mcpProfile?: string
    mcpConfigContent?: string
  } = {}
): { runtime: QueueRuntime; state: FakeRuntimeState } {
  const state: FakeRuntimeState = {
    spawnCalls: [],
    execCalls: [],
    files: new Map(),
    fileReads: new Map([
      ['/templates/queue-mcp-empty.json', overrides.mcpConfigContent ?? '{"mcpServers":{}}\n']
    ]),
    dirs: new Set(),
    porcelain: overrides.porcelain ?? '',
    diff: overrides.diff ?? 'diff --git a/x b/x\n+ change\n',
    untracked: overrides.untracked ?? []
  }
  const runtime: QueueRuntime = {
    spawnClaude: async (input) => {
      state.spawnCalls.push(input)
      if (overrides.spawn) return overrides.spawn(input, state)
      return {
        isError: false,
        totalCostUsd: 0.05,
        numTurns: 1,
        resultText: 'ok',
        rawJson: '{"is_error":false,"total_cost_usd":0.05,"num_turns":1,"result":"ok"}'
      }
    },
    execShell: async (cmd, opts) => {
      state.execCalls.push({ cmd, cwd: opts.cwd })
      if (overrides.exec) return overrides.exec(cmd, state)
      return { exitCode: 0, stdout: 'ok', stderr: '' }
    },
    gitStatusPorcelain: async () => state.porcelain,
    gitDiff: async () => state.diff,
    gitUntrackedFiles: async () => state.untracked,
    gitCurrentBranch: async () => overrides.branch ?? 'main',
    gitHeadSha: async () => overrides.commitSha ?? 'abc1234567890def1234567890abcdef12345678',
    gitWorktreeAdd: async () => {
      // runQueue doesn't call this; runQueueStart tests build their own fixture below.
    },
    pathExists: async () => true,
    isWritable: async () => true,
    resolveRef: async () => overrides.commitSha ?? 'abc1234567890def1234567890abcdef12345678',
    branchExists: async () => false,
    ghAuthStatus: async () => true,
    fileExistsAtSha: async () => true,
    mkdir: async (dir) => {
      state.dirs.add(dir)
    },
    writeFile: async (file, content) => {
      state.files.set(file, content)
    },
    appendFile: async (file, content) => {
      state.files.set(file, (state.files.get(file) ?? '') + content)
    },
    readFile: async (file) => {
      const content = state.fileReads.get(file)
      if (!content) throw new Error(`File not found: ${file}`)
      return content
    },
    artifactsDir: '/artifacts',
    queueMcpEmptyPath: '/templates/queue-mcp-empty.json',
    mcpProfile: overrides.mcpProfile ?? 'empty'
  }
  return { runtime, state }
}

function buildService(runtime: QueueRuntime): QueueLifecycleService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = svc as unknown as any
  return new QueueLifecycleService(
    internals.tasks,
    internals.workspaces,
    internals.conversations,
    internals.sessionLifecycle,
    runtime
  )
}

function createReadyAutoSafeTask(opts: { id?: string; title?: string; body?: string } = {}): {
  id: string
  title: string
} {
  const t = svc.createTask({
    projectId: 'proj-q',
    title: opts.title ?? 'Auto-safe task',
    labels: ['auto-safe'],
    body: opts.body ?? VALID_BODY
  })
  if (opts.id) {
    // No id override path — use generated id and update status. (Tests filter on status only.)
  }
  svc.updateTask(t.id, { status: 'READY' })
  return { id: t.id, title: t.title }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('proj-q', 'Queue Project', '/tmp/q')
  svc.addWorkspace('proj-q', 'ws-q', 'Q', '/tmp/q')
})

afterEach(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('runQueue — pre-flight', () => {
  it('throws WorkspaceResolutionError when workspace not found', async () => {
    const { runtime } = buildRuntime()
    const queue = buildService(runtime)
    await expect(queue.runQueue({ workspaceId: 'ws-missing' })).rejects.toBeInstanceOf(
      WorkspaceResolutionError
    )
  })

  it('throws QueueDirtyTreeError when working tree is dirty', async () => {
    createReadyAutoSafeTask()
    const { runtime } = buildRuntime({ porcelain: ' M src/foo.ts\n' })
    const queue = buildService(runtime)
    await expect(queue.runQueue({ workspaceId: 'ws-q' })).rejects.toBeInstanceOf(
      QueueDirtyTreeError
    )
  })

  it('does not spawn anything on dryRun, returns eligible list as skipped', async () => {
    const t = createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q', dryRun: true })

    expect(state.spawnCalls).toHaveLength(0)
    expect(r.done).toEqual([])
    expect(r.skipped.map((x) => x.id)).toEqual([t.id])
  })
})

describe('runQueue — task filtering', () => {
  it('skips tasks without auto-safe label', async () => {
    const safe = createReadyAutoSafeTask({ title: 'safe' })
    const unsafe = svc.createTask({ projectId: 'proj-q', title: 'unsafe', body: VALID_BODY })
    svc.updateTask(unsafe.id, { status: 'READY' })

    const { runtime } = buildRuntime()
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })
    expect(r.done.map((x) => x.id)).toEqual([safe.id])
  })

  it('skips tasks where validateAutoSafeTask is invalid (missing AC)', async () => {
    const goodId = createReadyAutoSafeTask({ title: 'good' }).id
    const bad = svc.createTask({
      projectId: 'proj-q',
      title: 'bad',
      labels: ['auto-safe'],
      body: '## Goal\nNo AC here\n## File Pointers\n- src/x.ts\n## Scope\n~1h'
    })
    svc.updateTask(bad.id, { status: 'READY' })

    const { runtime } = buildRuntime()
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })
    expect(r.done.map((x) => x.id)).toEqual([goodId])
  })

  it('filters by projectId — excludes tasks from other projects', async () => {
    svc.ensureProject('proj-other', 'Other', '/tmp/o')
    const good = createReadyAutoSafeTask({ title: 'good' })
    const other = svc.createTask({
      projectId: 'proj-other',
      title: 'other',
      labels: ['auto-safe'],
      body: VALID_BODY
    })
    svc.updateTask(other.id, { status: 'READY' })

    const { runtime } = buildRuntime()
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })
    expect(r.done.map((x) => x.id)).toEqual([good.id])
  })

  it('respects maxTasks cap', async () => {
    const a = createReadyAutoSafeTask({ title: 'A' })
    const b = createReadyAutoSafeTask({ title: 'B' })
    const c = createReadyAutoSafeTask({ title: 'C' })

    const { runtime } = buildRuntime()
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q', maxTasks: 2 })
    expect(r.done).toHaveLength(2)
    // Service sorts eligible tasks by id ascending → [a, b, c]; cap 2 → [a, b]
    expect(r.done.map((x) => x.id)).toEqual([a.id, b.id])
    // Newest (c) remained eligible but never admitted; runQueue ignores it (not in `tasks` slice).
    expect(svc.getTask(c.id)?.status).toBe('READY')
  })

  it('skips tasks with auto-failed label even when status=READY (TASK-711 Quirk 3)', async () => {
    const good = createReadyAutoSafeTask({ title: 'good' })
    const failedAgain = createReadyAutoSafeTask({ title: 'failedAgain' })
    svc.updateTask(failedAgain.id, {
      labels: ['auto-safe', 'auto-failed']
    })

    const { runtime } = buildRuntime()
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })
    expect(r.done.map((x) => x.id)).toEqual([good.id])
  })

  it('re-admits task after auto-failed label is removed', async () => {
    const t = createReadyAutoSafeTask()
    svc.updateTask(t.id, { labels: ['auto-safe', 'auto-failed'] })
    const { runtime } = buildRuntime()
    const queue = buildService(runtime)
    const first = await queue.runQueue({ workspaceId: 'ws-q' })
    expect(first.done).toHaveLength(0)

    svc.updateTask(t.id, { labels: ['auto-safe'] })
    const second = await queue.runQueue({ workspaceId: 'ws-q' })
    expect(second.done.map((x) => x.id)).toEqual([t.id])
  })
})

describe('runQueue — happy path SUCCESS', () => {
  it('spawns claude, runs AC, ends session, marks task DONE', async () => {
    const t = createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    expect(r.done.map((x) => x.id)).toEqual([t.id])
    expect(r.failed).toEqual([])
    expect(r.halted).toBe(false)
    expect(state.spawnCalls).toHaveLength(1)
    expect(state.execCalls.map((c) => c.cmd)).toEqual(['pnpm run lint'])
    expect(svc.getTask(t.id)?.status).toBe('DONE')
    // No active session left bound to the task
    const sessions = svc.findSessions('proj-q')
    expect(sessions.every((s) => s.status === 'completed')).toBe(true)
  })

  it('passes maxBudgetUsd = maxCostPerTask * 0.95 to the spawn (TASK-705 F1 recalibrate)', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    await queue.runQueue({ workspaceId: 'ws-q', maxCostPerTask: 1.0 })
    expect(state.spawnCalls[0].maxBudgetUsd).toBeCloseTo(0.95, 5)
  })

  it('uses default maxCostPerTask = 1.5 (TASK-705 F3 cold-cache safety)', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    await queue.runQueue({ workspaceId: 'ws-q' })
    // default 1.5 × 0.95 = 1.425 → round2 = 1.42 (float-precision banker rounding)
    expect(state.spawnCalls[0].maxBudgetUsd).toBeCloseTo(1.42, 5)
  })

  it('uses default model claude-sonnet-4-6 when not overridden', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    await queue.runQueue({ workspaceId: 'ws-q' })
    expect(state.spawnCalls[0].model).toBe('claude-sonnet-4-6')
  })

  it('writes prompt.md, claude.json, ac-0.log, diff.patch per task', async () => {
    const t = createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const taskDir = path.join(r.artifactDir, 'tasks', t.id)
    expect(state.files.has(path.join(taskDir, 'prompt.md'))).toBe(true)
    expect(state.files.has(path.join(taskDir, 'claude.json'))).toBe(true)
    expect(state.files.has(path.join(taskDir, 'ac-0.log'))).toBe(true)
    expect(state.files.has(path.join(taskDir, 'diff.patch'))).toBe(true)
    expect(state.files.get(path.join(taskDir, 'prompt.md'))).toBe(VALID_BODY)
  })

  it('accumulates totalCostUsd across multiple successful tasks', async () => {
    createReadyAutoSafeTask({ title: 'A' })
    createReadyAutoSafeTask({ title: 'B' })
    const { runtime } = buildRuntime({
      spawn: async () => ({
        isError: false,
        totalCostUsd: 0.07,
        numTurns: 1,
        resultText: 'ok',
        rawJson: '{}'
      })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })
    expect(r.done).toHaveLength(2)
    expect(r.totalCostUsd).toBeCloseTo(0.14, 5)
  })
})

describe('runQueue — FAILURE flow (halt-on-fail)', () => {
  it('halts on claude is_error: labels task auto-failed, abandons session, resets status to READY (TASK-711 Quirk 3)', async () => {
    const t = createReadyAutoSafeTask()
    const { runtime } = buildRuntime({
      // 'tool-use logic error' is non-transient — must not trigger retry, halts immediately.
      spawn: async () => ({
        isError: true,
        totalCostUsd: 0.04,
        numTurns: 1,
        resultText: 'tool-use logic error',
        rawJson: '{"is_error":true}'
      })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    expect(r.halted).toBe(true)
    expect(r.haltReason).toContain('claude-error')
    expect(r.haltCode).toBe('claude-error')
    expect(r.failed.map((x) => x.id)).toEqual([t.id])
    const after = svc.getTask(t.id)
    expect(after?.status).toBe('READY')
    expect(after?.labels).toContain('auto-failed')
    expect(after?.labels).toContain('auto-safe')
    // Session bound to the task is now completed (abandoned)
    const sessions = svc.findSessions('proj-q')
    expect(sessions[0]?.status).toBe('completed')
    expect(sessions[0]?.handoff?.failureReason).toContain('claude-error')
  })

  it('halts on AC command exit non-zero', async () => {
    const t = createReadyAutoSafeTask()
    const { runtime } = buildRuntime({
      exec: async () => ({ exitCode: 1, stdout: 'x', stderr: 'lint failed' })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    expect(r.halted).toBe(true)
    expect(r.haltReason).toContain('ac-failed')
    expect(r.haltReason).toContain('pnpm run lint')
    expect(r.haltCode).toBe('ac-failed')
    expect(r.failed.map((x) => x.id)).toEqual([t.id])
    expect(svc.getTask(t.id)?.status).toBe('READY')
    expect(svc.getTask(t.id)?.labels).toContain('auto-failed')
  })

  it('passes when AC command exits with the expected non-zero code (TASK-740)', async () => {
    const t = createReadyAutoSafeTask({
      body: [
        '## Goal',
        'Negative-path smoke',
        '',
        '## Acceptance',
        '- [ ] `node scripts/exiter.mjs` exit 3 (workspace-not-found path)',
        '',
        '## File Pointers',
        '- src/foo.ts',
        '',
        '## Scope',
        '~1h'
      ].join('\n')
    })
    const { runtime, state } = buildRuntime({
      exec: async () => ({ exitCode: 3, stdout: '', stderr: 'not found' })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    expect(r.halted).toBe(false)
    expect(r.failed).toEqual([])
    expect(r.done.map((x) => x.id)).toEqual([t.id])
    expect(svc.getTask(t.id)?.status).toBe('DONE')
    // Verifier still actually ran the command (not skipped)
    expect(state.execCalls.map((c) => c.cmd)).toEqual(['node scripts/exiter.mjs'])
  })

  it('halts when AC neg-exit hint does not match actual exit (TASK-740)', async () => {
    const t = createReadyAutoSafeTask({
      body: [
        '## Goal',
        'Negative-path smoke',
        '',
        '## Acceptance',
        '- [ ] `node scripts/exiter.mjs` exit 3 (should-be-3)',
        '',
        '## File Pointers',
        '- src/foo.ts',
        '',
        '## Scope',
        '~1h'
      ].join('\n')
    })
    const { runtime } = buildRuntime({
      // Returns exit 0 — does NOT match expected 3 → should ac-fail
      exec: async () => ({ exitCode: 0, stdout: 'oops succeeded', stderr: '' })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    expect(r.halted).toBe(true)
    expect(r.haltCode).toBe('ac-failed')
    expect(r.haltReason).toContain('expected 3')
    expect(r.haltReason).toContain('exit 0')
    expect(r.failed.map((x) => x.id)).toEqual([t.id])
  })

  it('halts on cost-cap-exceeded (post-hoc)', async () => {
    const t = createReadyAutoSafeTask()
    const { runtime } = buildRuntime({
      spawn: async () => ({
        isError: false,
        totalCostUsd: 0.75,
        numTurns: 5,
        resultText: 'ok but expensive',
        rawJson: '{}'
      })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q', maxCostPerTask: 0.5 })

    expect(r.halted).toBe(true)
    expect(r.haltReason).toContain('cost-cap-exceeded')
    expect(r.haltCode).toBe('cost-cap')
    expect(r.failed.map((x) => x.id)).toEqual([t.id])
    expect(svc.getTask(t.id)?.status).toBe('READY')
    expect(svc.getTask(t.id)?.labels).toContain('auto-failed')
  })

  it('halts on spawn throw — captures spawn-error reason', async () => {
    const t = createReadyAutoSafeTask()
    const { runtime } = buildRuntime({
      spawn: async () => {
        throw new Error('claude binary missing')
      }
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    expect(r.halted).toBe(true)
    expect(r.haltReason).toContain('spawn-error')
    expect(r.haltReason).toContain('claude binary missing')
    expect(r.haltCode).toBe('spawn-error')
    expect(r.failed.map((x) => x.id)).toEqual([t.id])
    expect(svc.getTask(t.id)?.labels).toContain('auto-failed')
  })

  it('preserves later eligible tasks as skipped when queue halts mid-run', async () => {
    const a = createReadyAutoSafeTask({ title: 'A' })
    const b = createReadyAutoSafeTask({ title: 'B' })
    const c = createReadyAutoSafeTask({ title: 'C' })

    let n = 0
    const { runtime } = buildRuntime({
      spawn: async () => {
        n += 1
        return {
          isError: n === 2,
          totalCostUsd: 0.03,
          numTurns: 1,
          resultText: n === 2 ? 'boom' : 'ok',
          rawJson: '{}'
        }
      }
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    // Run order [a, b, c] (id-sorted asc): a succeeds (n=1), b fails (n=2), c never admitted.
    expect(r.done.map((x) => x.id)).toEqual([a.id])
    expect(r.failed.map((x) => x.id)).toEqual([b.id])
    expect(r.skipped.map((x) => x.id)).toEqual([c.id])
    expect(svc.getTask(c.id)?.status).toBe('READY')
  })

  it('halts before next-task admission when cumulative cost would exceed queue cap', async () => {
    const a = createReadyAutoSafeTask({ title: 'A' })
    const b = createReadyAutoSafeTask({ title: 'B' })
    const { runtime } = buildRuntime({
      spawn: async () => ({
        isError: false,
        totalCostUsd: 0.4,
        numTurns: 1,
        resultText: 'ok',
        rawJson: '{}'
      })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({
      workspaceId: 'ws-q',
      maxCostPerTask: 0.5,
      maxQueueCost: 0.6
    })

    // Order [a, b]: a succeeds at $0.40; admission for b checks 0.40 + 0.50 > 0.60 → halt.
    expect(r.done.map((x) => x.id)).toEqual([a.id])
    expect(r.failed).toEqual([])
    expect(r.skipped.map((x) => x.id)).toEqual([b.id])
    expect(r.halted).toBe(true)
    expect(r.haltReason).toContain('queue-cost-cap-exceeded')
    expect(r.haltCode).toBe('queue-cost-cap')
    expect(svc.getTask(b.id)?.status).toBe('READY')
  })

  it('writes diff.patch even when task fails (always-write contract)', async () => {
    const t = createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime({
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'fail' })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })
    const taskDir = path.join(r.artifactDir, 'tasks', t.id)
    expect(state.files.has(path.join(taskDir, 'diff.patch'))).toBe(true)
  })

  it('appends comment to task-linked open conversation on failure', async () => {
    const t = createReadyAutoSafeTask()
    const conv = svc.openConversation({
      projectId: 'proj-q',
      title: 'Discussing the task',
      createdBy: 'Butter',
      initialMessage: { content: 'plan?', type: 'question' }
    })
    // Link to the task
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = svc as unknown as any
    internals.conversations.link(conv.id, 'task', t.id)

    const { runtime } = buildRuntime({
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'fail' })
    })
    const queue = buildService(runtime)
    await queue.runQueue({ workspaceId: 'ws-q' })

    const messages = svc.getConversationMessages(conv.id)
    const fromQueue = messages.find((m) => m.authorName === 'queue-runner')
    expect(fromQueue).toBeDefined()
    expect(fromQueue?.content).toContain('Auto-failed')
    expect(fromQueue?.content).toContain('diff.patch')
  })
})

describe('runQueue — retry-1x for transient errors', () => {
  it('retries once when first spawn throws a transient error and succeeds on retry', async () => {
    const t = createReadyAutoSafeTask()
    let attempts = 0
    const { runtime, state } = buildRuntime({
      spawn: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('connection ECONNRESET while streaming')
        return {
          isError: false,
          totalCostUsd: 0.05,
          numTurns: 1,
          resultText: 'ok after retry',
          rawJson: '{}'
        }
      }
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    expect(state.spawnCalls).toHaveLength(2)
    expect(r.done.map((x) => x.id)).toEqual([t.id])
    expect(r.failed).toEqual([])
    expect(svc.getTask(t.id)?.status).toBe('DONE')
  })

  it('retries once when first spawn returns is_error with transient text and succeeds on retry', async () => {
    const t = createReadyAutoSafeTask()
    let attempts = 0
    const { runtime, state } = buildRuntime({
      spawn: async () => {
        attempts += 1
        if (attempts === 1) {
          return {
            isError: true,
            totalCostUsd: 0.0,
            numTurns: 0,
            resultText: 'API error: rate limit exceeded — try again',
            rawJson: '{}'
          }
        }
        return {
          isError: false,
          totalCostUsd: 0.05,
          numTurns: 1,
          resultText: 'ok',
          rawJson: '{}'
        }
      }
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    expect(state.spawnCalls).toHaveLength(2)
    expect(r.done.map((x) => x.id)).toEqual([t.id])
    expect(svc.getTask(t.id)?.status).toBe('DONE')
  })

  it('does NOT retry on non-transient throws (logic / config errors)', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime({
      spawn: async () => {
        throw new Error('claude binary not found at /opt/bin/claude')
      }
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    expect(state.spawnCalls).toHaveLength(1)
    expect(r.halted).toBe(true)
    expect(r.haltReason).toContain('binary not found')
    expect(r.haltCode).toBe('spawn-error')
  })

  it('halts after 2 failed attempts when both are transient', async () => {
    const t = createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime({
      spawn: async () => {
        throw new Error('upstream overloaded — retry later')
      }
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    expect(state.spawnCalls).toHaveLength(2)
    expect(r.halted).toBe(true)
    expect(r.haltReason).toContain('overloaded')
    expect(r.haltCode).toBe('spawn-error')
    expect(r.failed.map((x) => x.id)).toEqual([t.id])
    expect(svc.getTask(t.id)?.labels).toContain('auto-failed')
  })

  it('does NOT retry on AC command failure (logic fail per ADR-019)', async () => {
    const t = createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime({
      exec: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'rate limit (in stderr — should NOT trigger retry)'
      })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    expect(state.spawnCalls).toHaveLength(1)
    expect(state.execCalls).toHaveLength(1)
    expect(r.halted).toBe(true)
    expect(r.haltReason).toContain('ac-failed')
    expect(r.haltCode).toBe('ac-failed')
    expect(svc.getTask(t.id)?.labels).toContain('auto-failed')
  })
})

describe('runQueue — ADR-019 Phase-2 metrics (7 fields in queue-run.json)', () => {
  it('writes all 7 metrics fields with correct shape', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime({
      spawn: async () => ({
        isError: false,
        totalCostUsd: 0.05,
        numTurns: 2,
        resultText: 'ok',
        rawJson: '{}',
        totalInputTokens: 1000,
        cacheReadInputTokens: 400
      })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(typeof payload.mcp_tokens_per_spawn).toBe('number')
    expect(typeof payload.tool_schema_tokens_total).toBe('number')
    expect(typeof payload.mcp_profile_used).toBe('string')
    expect(typeof payload.cache_read_input_tokens).toBe('number')
    expect(typeof payload.spawn_mode).toBe('string')
    expect(typeof payload.task_outcome_per_mcp_profile).toBe('object')
    // cache_hit_estimate must be number ∈ [0,1] when token data is present
    expect(typeof payload.cache_hit_estimate).toBe('number')
    expect(payload.cache_hit_estimate).toBeGreaterThanOrEqual(0)
    expect(payload.cache_hit_estimate).toBeLessThanOrEqual(1)
  })

  it('aggregates cache tokens across all spawns and computes cache_hit_estimate', async () => {
    createReadyAutoSafeTask({ title: 'A' })
    createReadyAutoSafeTask({ title: 'B' })
    const { runtime, state } = buildRuntime({
      spawn: async () => ({
        isError: false,
        totalCostUsd: 0.05,
        numTurns: 1,
        resultText: 'ok',
        rawJson: '{}',
        totalInputTokens: 1000,
        cacheReadInputTokens: 600
      })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    // 2 spawns × 1000 input, 2 × 600 cache_read
    expect(payload.cache_read_input_tokens).toBe(1200)
    // 1200 / 2000 = 0.6
    expect(payload.cache_hit_estimate).toBeCloseTo(0.6, 5)
  })

  it('cache_hit_estimate is null when spawn JSON has no total_input_tokens', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.cache_hit_estimate).toBeNull()
  })

  it('task_outcome_per_mcp_profile aggregates success+failed per profile', async () => {
    createReadyAutoSafeTask({ title: 'A' })
    createReadyAutoSafeTask({ title: 'B' })
    let n = 0
    const { runtime, state } = buildRuntime({
      spawn: async () => {
        n += 1
        return {
          isError: n === 2,
          totalCostUsd: 0.05,
          numTurns: 1,
          resultText: n === 2 ? 'boom' : 'ok',
          rawJson: '{}'
        }
      }
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.task_outcome_per_mcp_profile).toEqual({ empty: { success: 1, failed: 1 } })
  })

  it('mcp_profile_used=empty and spawn_mode=zero-mcp for canonical empty profile', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.mcp_profile_used).toBe('empty')
    expect(payload.spawn_mode).toBe('zero-mcp')
  })

  it('mcp_profile_used and spawn_mode=selective when mcpProfile is not "empty"', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime({ mcpProfile: 'playwright' })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.mcp_profile_used).toBe('playwright')
    expect(payload.spawn_mode).toBe('selective')
    expect(payload.task_outcome_per_mcp_profile).toEqual({ playwright: { success: 1, failed: 0 } })
  })

  it('spawn-error counts as failed in task_outcome_per_mcp_profile', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime({
      spawn: async () => {
        throw new Error('claude binary missing')
      }
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.task_outcome_per_mcp_profile).toEqual({ empty: { success: 0, failed: 1 } })
  })

  it('mcp_tokens_per_spawn measured from empty profile config file', async () => {
    createReadyAutoSafeTask()
    // Empty profile: {"mcpServers":{}}\n = 18 chars → ceil(18/3.5) = 6 tokens
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.mcp_tokens_per_spawn).toBe(6)
  })

  it('mcp_tokens_per_spawn scales with MCP config file size', async () => {
    createReadyAutoSafeTask({ title: 'small' })
    createReadyAutoSafeTask({ title: 'large' })

    // Test 1: small config (5 chars → 2 tokens)
    const { runtime: runtime1, state: state1 } = buildRuntime({ mcpConfigContent: '12345' })
    const queue1 = buildService(runtime1)
    const r1 = await queue1.runQueue({ workspaceId: 'ws-q', maxTasks: 1 })
    const payload1 = JSON.parse(state1.files.get(path.join(r1.artifactDir, 'queue-run.json'))!)
    expect(payload1.mcp_tokens_per_spawn).toBe(2)

    // Test 2: large config (70 chars → 20 tokens)
    const largeConfig = 'x'.repeat(70)
    const { runtime: runtime2, state: state2 } = buildRuntime({ mcpConfigContent: largeConfig })
    const queue2 = buildService(runtime2)
    const r2 = await queue2.runQueue({ workspaceId: 'ws-q', maxTasks: 2 })
    const payload2 = JSON.parse(state2.files.get(path.join(r2.artifactDir, 'queue-run.json'))!)
    expect(payload2.mcp_tokens_per_spawn).toBe(20)
  })
})

describe('runQueue — TASK-707 diff metrics (files_touched + new_files)', () => {
  const TWO_MOD_ONE_NEW_DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/src/b.ts b/src/b.ts',
    'index 3333333..4444444 100644',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/src/c.ts b/src/c.ts',
    'new file mode 100644',
    'index 0000000..5555555',
    '--- /dev/null',
    '+++ b/src/c.ts',
    '@@ -0,0 +1 @@',
    '+content',
    ''
  ].join('\n')

  it('writes files_touched_count + new_files_created_count parsed from diff.patch', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime({ diff: TWO_MOD_ONE_NEW_DIFF })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.files_touched_count).toBe(2)
    expect(payload.new_files_created_count).toBe(1)
  })

  it('aggregates counts across multiple spawns', async () => {
    createReadyAutoSafeTask({ title: 'A' })
    createReadyAutoSafeTask({ title: 'B' })
    const { runtime, state } = buildRuntime({ diff: TWO_MOD_ONE_NEW_DIFF })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    // 2 spawns × (2 modified + 1 new) = 4 touched, 2 new
    expect(payload.files_touched_count).toBe(4)
    expect(payload.new_files_created_count).toBe(2)
  })

  it('empty diff → both counts = 0', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime({ diff: '' })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.files_touched_count).toBe(0)
    expect(payload.new_files_created_count).toBe(0)
  })

  it('counts diff even when spawn fails (spawn-error path still writes diff.patch)', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime({
      diff: TWO_MOD_ONE_NEW_DIFF,
      spawn: async () => {
        throw new Error('claude binary missing')
      }
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.files_touched_count).toBe(2)
    expect(payload.new_files_created_count).toBe(1)
  })

  it('untracked-only: gitDiff empty, gitUntrackedFiles returns 2 → newFiles=2, filesTouched=0', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime({
      diff: '',
      untracked: ['src/a.ts', 'src/b.ts']
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.new_files_created_count).toBe(2)
    expect(payload.files_touched_count).toBe(0)
  })

  it('mixed: 1 modified + 1 staged-new in diff, 1 untracked → newFiles=2, filesTouched=1', async () => {
    createReadyAutoSafeTask()
    const ONE_MOD_ONE_STAGED_NEW = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/c.ts b/src/c.ts',
      'new file mode 100644',
      'index 0000000..5555555',
      '--- /dev/null',
      '+++ b/src/c.ts',
      '@@ -0,0 +1 @@',
      '+content',
      ''
    ].join('\n')
    const { runtime, state } = buildRuntime({
      diff: ONE_MOD_ONE_STAGED_NEW,
      untracked: ['src/extra.ts']
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.new_files_created_count).toBe(2)
    expect(payload.files_touched_count).toBe(1)
  })
})

describe('resolveModelForTask — unit', () => {
  const base = { id: 't1', projectId: 'p1', title: 'T', status: 'READY' as const, priority: 'medium' as const, body: null, createdAt: '', updatedAt: '' }

  it('returns defaultModel when no model: label present', () => {
    expect(resolveModelForTask({ ...base, labels: ['auto-safe'] }, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  it('returns overridden model when model: label present', () => {
    expect(resolveModelForTask({ ...base, labels: ['auto-safe', 'model:claude-haiku-4-5-20251001'] }, 'claude-sonnet-4-6')).toBe('claude-haiku-4-5-20251001')
  })

  it('first model: label wins when multiple present', () => {
    expect(resolveModelForTask({ ...base, labels: ['model:claude-haiku-4-5-20251001', 'model:claude-opus-4-7'] }, 'claude-sonnet-4-6')).toBe('claude-haiku-4-5-20251001')
  })

  it('ignores labels that do not match model: prefix (e.g. "models:x", "xmodel:y")', () => {
    expect(resolveModelForTask({ ...base, labels: ['models:haiku', 'xmodel:sonnet'] }, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })
})

describe('runQueue — per-task model label override', () => {
  it('passes model:haiku label value to spawnClaude instead of default', async () => {
    const t = svc.createTask({
      projectId: 'proj-q',
      title: 'Haiku task',
      labels: ['auto-safe', 'model:claude-haiku-4-5-20251001'],
      body: VALID_BODY
    })
    svc.updateTask(t.id, { status: 'READY' })

    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    await queue.runQueue({ workspaceId: 'ws-q' })

    expect(state.spawnCalls[0].model).toBe('claude-haiku-4-5-20251001')
  })

  it('uses runOptions.model (or default) for tasks without model: label', async () => {
    const a = svc.createTask({ projectId: 'proj-q', title: 'A', labels: ['auto-safe'], body: VALID_BODY })
    svc.updateTask(a.id, { status: 'READY' })
    const b = svc.createTask({ projectId: 'proj-q', title: 'B', labels: ['auto-safe', 'model:claude-haiku-4-5-20251001'], body: VALID_BODY })
    svc.updateTask(b.id, { status: 'READY' })

    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    await queue.runQueue({ workspaceId: 'ws-q' })

    const calls = state.spawnCalls
    expect(calls).toHaveLength(2)
    const models = calls.map((c) => c.model).sort()
    expect(models).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'])
  })

  it('unknown model value passes through as-is (no whitelist)', async () => {
    const t = svc.createTask({
      projectId: 'proj-q',
      title: 'Unknown model',
      labels: ['auto-safe', 'model:some-future-model'],
      body: VALID_BODY
    })
    svc.updateTask(t.id, { status: 'READY' })

    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    await queue.runQueue({ workspaceId: 'ws-q' })

    expect(state.spawnCalls[0].model).toBe('some-future-model')
  })
})

describe('runQueue — admission order is deterministic', () => {
  it('advances totalCostUsd across all successful tasks before halting', async () => {
    const a = createReadyAutoSafeTask({ title: 'A' })
    const b = createReadyAutoSafeTask({ title: 'B' })
    const c = createReadyAutoSafeTask({ title: 'C' })

    let n = 0
    const { runtime } = buildRuntime({
      spawn: async () => {
        n += 1
        return {
          isError: n === 3,
          totalCostUsd: 0.05,
          numTurns: 1,
          resultText: n === 3 ? 'boom' : 'ok',
          rawJson: '{}'
        }
      }
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    // Order [a, b, c]; a + b succeed, c fails on n=3.
    expect(r.done.map((x) => x.id)).toEqual([a.id, b.id])
    expect(r.failed.map((x) => x.id)).toEqual([c.id])
    // 3 spawns × $0.05 = $0.15 (post-hoc cost is recorded for the failing task too)
    expect(r.totalCostUsd).toBeCloseTo(0.15, 5)
  })
})

describe('runQueue — queue-run.json artifact', () => {
  it('all-DONE: 2 tasks → halted: false and 2 DONE entries with cost + numTurns', async () => {
    const a = createReadyAutoSafeTask({ title: 'A' })
    const b = createReadyAutoSafeTask({ title: 'B' })
    const { runtime, state } = buildRuntime({
      spawn: async () => ({
        isError: false,
        totalCostUsd: 0.12,
        numTurns: 5,
        resultText: 'ok',
        rawJson: '{}'
      })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const raw = state.files.get(path.join(r.artifactDir, 'queue-run.json'))
    expect(raw).toBeDefined()
    const payload = JSON.parse(raw!)
    expect(payload.halted).toBe(false)
    expect(payload.haltReason).toBeNull()
    expect(payload.haltCode).toBeNull()
    expect(payload.tasks).toHaveLength(2)
    expect(payload.tasks[0]).toMatchObject({ id: a.id, outcome: 'DONE', costUsd: 0.12, numTurns: 5 })
    expect(payload.tasks[1]).toMatchObject({ id: b.id, outcome: 'DONE', costUsd: 0.12, numTurns: 5 })
  })

  it('first-fail halt: task 1 FAILED (ac-failed), task 2 SKIPPED', async () => {
    const a = createReadyAutoSafeTask({ title: 'A' })
    const b = createReadyAutoSafeTask({ title: 'B' })
    const { runtime, state } = buildRuntime({
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'lint failed' })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.halted).toBe(true)
    expect(payload.haltReason).toContain('ac-failed')
    expect(payload.haltCode).toBe('ac-failed')
    expect(payload.tasks).toHaveLength(2)
    expect(payload.tasks[0]).toMatchObject({ id: a.id, outcome: 'FAILED', reason: expect.stringContaining('ac-failed') })
    expect(payload.tasks[1]).toMatchObject({ id: b.id, outcome: 'SKIPPED' })
  })

  it('cost-cap halt: expensive task → FAILED with cost-cap-exceeded reason', async () => {
    const t = createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime({
      spawn: async () => ({
        isError: false,
        totalCostUsd: 0.75,
        numTurns: 5,
        resultText: 'ok',
        rawJson: '{}'
      })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q', maxCostPerTask: 0.5 })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.tasks).toHaveLength(1)
    expect(payload.tasks[0]).toMatchObject({
      id: t.id,
      outcome: 'FAILED',
      costUsd: 0.75,
      reason: expect.stringContaining('cost-cap-exceeded')
    })
  })

  it('spawn-error halt: 1 FAILED (spawn-error) + remaining SKIPPED', async () => {
    const a = createReadyAutoSafeTask({ title: 'A' })
    const b = createReadyAutoSafeTask({ title: 'B' })
    const { runtime, state } = buildRuntime({
      spawn: async () => {
        throw new Error('claude binary missing')
      }
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.tasks).toHaveLength(2)
    expect(payload.tasks[0]).toMatchObject({ id: a.id, outcome: 'FAILED', reason: expect.stringContaining('spawn-error') })
    expect(payload.tasks[1]).toMatchObject({ id: b.id, outcome: 'SKIPPED' })
  })

  it('dry-run: does not write queue-run.json', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    await queue.runQueue({ workspaceId: 'ws-q', dryRun: true })

    const hasQueueRunJson = [...state.files.keys()].some((k) => k.includes('queue-run.json'))
    expect(hasQueueRunJson).toBe(false)
  })

  it('branch capture: gitCurrentBranch result appears in queue-run.json', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime({ branch: 'feature/x' })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.branch).toBe('feature/x')
  })

  it('commit-sha capture: gitHeadSha result appears in queue-run.json', async () => {
    createReadyAutoSafeTask()
    const sha = 'deadbeef1234567890abcdef1234567890abcdef'
    const { runtime, state } = buildRuntime({ commitSha: sha })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const payload = JSON.parse(state.files.get(path.join(r.artifactDir, 'queue-run.json'))!)
    expect(payload.commitSha).toBe(sha)
  })
})

describe('runQueue — queue.jsonl event stream (TASK-741, ADR-019)', () => {
  function readJsonlEvents(state: FakeRuntimeState, artifactDir: string): Record<string, unknown>[] {
    const raw = state.files.get(path.join(artifactDir, 'queue.jsonl'))
    if (!raw) return []
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  it('all-DONE: N tasks → N × task.started + N × task.finished(DONE) + 1 × run.finished', async () => {
    const a = createReadyAutoSafeTask({ title: 'A' })
    const b = createReadyAutoSafeTask({ title: 'B' })
    const { runtime, state } = buildRuntime({
      spawn: async () => ({
        isError: false,
        totalCostUsd: 0.07,
        numTurns: 2,
        resultText: 'ok',
        rawJson: '{}'
      })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const events = readJsonlEvents(state, r.artifactDir)
    const eventTypes = events.map((e) => e.event)
    expect(eventTypes).toEqual([
      'task.started',
      'task.finished',
      'task.started',
      'task.finished',
      'run.finished'
    ])

    expect(events[0]).toMatchObject({
      event: 'task.started',
      queueRunId: r.queueRunId,
      taskId: a.id,
      taskIndex: 1
    })
    expect(events[1]).toMatchObject({
      event: 'task.finished',
      queueRunId: r.queueRunId,
      taskId: a.id,
      taskIndex: 1,
      outcome: 'DONE',
      costUsd: 0.07
    })
    expect(events[1].durationMs).toBeTypeOf('number')
    expect(events[2]).toMatchObject({ event: 'task.started', taskId: b.id, taskIndex: 2 })
    expect(events[3]).toMatchObject({ event: 'task.finished', taskId: b.id, taskIndex: 2, outcome: 'DONE' })
    expect(events[4]).toMatchObject({
      event: 'run.finished',
      queueRunId: r.queueRunId,
      taskCount: 2,
      totalCostUsd: r.totalCostUsd
    })
    expect(events[4].durationMs).toBeTypeOf('number')
  })

  it('ac-failed halt: task 1 fails → task.started + task.finished(FAILED) + run.failed with failedTaskIndex=1, no events for skipped task', async () => {
    const a = createReadyAutoSafeTask({ title: 'A' })
    createReadyAutoSafeTask({ title: 'B' })
    const { runtime, state } = buildRuntime({
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'lint failed' })
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const events = readJsonlEvents(state, r.artifactDir)
    expect(events.map((e) => e.event)).toEqual(['task.started', 'task.finished', 'run.failed'])
    expect(events[0]).toMatchObject({ event: 'task.started', taskId: a.id, taskIndex: 1 })
    expect(events[1]).toMatchObject({
      event: 'task.finished',
      taskId: a.id,
      taskIndex: 1,
      outcome: 'FAILED'
    })
    expect(events[2]).toMatchObject({
      event: 'run.failed',
      queueRunId: r.queueRunId,
      taskCount: 2,
      failedTaskIndex: 1
    })
    expect(events[2].durationMs).toBeTypeOf('number')
  })

  it('cost-cap halt: failedTaskIndex matches halting task position (1-based)', async () => {
    const a = createReadyAutoSafeTask({ title: 'A' })
    createReadyAutoSafeTask({ title: 'B' })
    let n = 0
    const { runtime, state } = buildRuntime({
      spawn: async () => {
        n += 1
        return {
          isError: false,
          totalCostUsd: n === 1 ? 0.05 : 5.0,
          numTurns: 1,
          resultText: 'ok',
          rawJson: '{}'
        }
      }
    })
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q', maxCostPerTask: 1.0 })

    const events = readJsonlEvents(state, r.artifactDir)
    // task A succeeds, task B trips cost-cap → 4 events: started/finished×2 + run.failed
    expect(events.map((e) => e.event)).toEqual([
      'task.started',
      'task.finished',
      'task.started',
      'task.finished',
      'run.failed'
    ])
    expect(events[1]).toMatchObject({ taskId: a.id, outcome: 'DONE' })
    expect(events[3]).toMatchObject({ outcome: 'FAILED', taskIndex: 2 })
    expect(events[4]).toMatchObject({ event: 'run.failed', failedTaskIndex: 2 })
  })

  it('each line of queue.jsonl is independently JSON-parseable (no pretty-print, newline-delimited)', async () => {
    createReadyAutoSafeTask({ title: 'A' })
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q' })

    const raw = state.files.get(path.join(r.artifactDir, 'queue.jsonl'))!
    expect(raw.endsWith('\n')).toBe(true)
    const lines = raw.split('\n').filter((l) => l.length > 0)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
      expect(line).not.toContain('\n')
    }
  })

  it('dry-run: does not write queue.jsonl', async () => {
    createReadyAutoSafeTask()
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)
    const r = await queue.runQueue({ workspaceId: 'ws-q', dryRun: true })

    expect(state.files.get(path.join(r.artifactDir, 'queue.jsonl'))).toBeUndefined()
  })
})

describe('computeToolSchemaTokens', () => {
  it('measures canonical spawn tool strings > 0 tokens', () => {
    const tokens = computeToolSchemaTokens()
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(50)
  })
})
