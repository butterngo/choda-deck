import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import {
  QueueLifecycleService,
  type ExecShellResult,
  type QueueRuntime,
  type SpawnClaudeInput,
  type SpawnClaudeOutput
} from './queue-lifecycle-service'
import { QueueDirtyTreeError, WorkspaceResolutionError } from './errors'

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
  dirs: Set<string>
  porcelain: string
  diff: string
}

function buildRuntime(
  overrides: {
    spawn?: (input: SpawnClaudeInput, state: FakeRuntimeState) => Promise<SpawnClaudeOutput>
    exec?: (cmd: string, state: FakeRuntimeState) => Promise<ExecShellResult>
    porcelain?: string
    diff?: string
    branch?: string
    commitSha?: string
    mcpProfile?: string
  } = {}
): { runtime: QueueRuntime; state: FakeRuntimeState } {
  const state: FakeRuntimeState = {
    spawnCalls: [],
    execCalls: [],
    files: new Map(),
    dirs: new Set(),
    porcelain: overrides.porcelain ?? '',
    diff: overrides.diff ?? 'diff --git a/x b/x\n+ change\n'
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
    gitCurrentBranch: async () => overrides.branch ?? 'main',
    gitHeadSha: async () => overrides.commitSha ?? 'abc1234567890def1234567890abcdef12345678',
    mkdir: async (dir) => {
      state.dirs.add(dir)
    },
    writeFile: async (file, content) => {
      state.files.set(file, content)
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
    expect(r.failed.map((x) => x.id)).toEqual([t.id])
    expect(svc.getTask(t.id)?.status).toBe('READY')
    expect(svc.getTask(t.id)?.labels).toContain('auto-failed')
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
