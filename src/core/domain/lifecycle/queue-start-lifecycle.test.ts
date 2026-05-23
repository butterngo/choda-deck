import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import {
  QueueLifecycleService,
  type ExecShellResult,
  type GitWorktreeAddOpts,
  type QueueRuntime,
  type QueueStartResult,
  type SpawnClaudeInput,
  type SpawnClaudeOutput
} from './queue-lifecycle-service'
import { WorkspaceResolutionError } from './errors'

const TEST_DB = path.join(__dirname, '__test-queue-start-lifecycle__.db')
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

const BASE_SHA = 'abc1234567890def1234567890abcdef12345678'

const DEFAULT_PARENT_DIR = 'C:/repo.worktrees'

interface FakeState {
  spawnCalls: SpawnClaudeInput[]
  execCalls: { cmd: string; cwd: string }[]
  worktreeCalls: GitWorktreeAddOpts[]
  worktreeRemoveCalls: { repoCwd: string; worktreePath: string; branch: string }[]
  worktreeShouldFail: Map<string, string>
  branches: Set<string>
  /** Paths that exist on the fake fs — parent dir is added on setup, worktree paths get
   * added on gitWorktreeAdd or via the `preExistingWorktrees` option. */
  existingPaths: Set<string>
  files: Map<string, string>
  dirs: Set<string>
  spawnFailures: Map<string, SpawnClaudeOutput>
}

function buildRuntime(
  overrides: {
    spawn?: (input: SpawnClaudeInput, state: FakeState) => Promise<SpawnClaudeOutput>
    exec?: (cmd: string, cwd: string, state: FakeState) => Promise<ExecShellResult>
    preExistingBranches?: string[]
    preExistingWorktrees?: string[]
    worktreeShouldFail?: Map<string, string>
    spawnFailures?: Map<string, SpawnClaudeOutput>
    resolveRefReturns?: string | null
    fileExistsAtSha?: boolean
    ghAuthOk?: boolean
    parentDirExists?: boolean
    parentDirWritable?: boolean
    parentDir?: string
  } = {}
): { runtime: QueueRuntime; state: FakeState } {
  const parentDir = overrides.parentDir ?? DEFAULT_PARENT_DIR
  const existingPaths = new Set<string>()
  if (overrides.parentDirExists !== false) existingPaths.add(parentDir)
  for (const p of overrides.preExistingWorktrees ?? []) existingPaths.add(p)
  const state: FakeState = {
    spawnCalls: [],
    execCalls: [],
    worktreeCalls: [],
    worktreeRemoveCalls: [],
    worktreeShouldFail: overrides.worktreeShouldFail ?? new Map(),
    branches: new Set(overrides.preExistingBranches ?? []),
    existingPaths,
    files: new Map(),
    dirs: new Set(),
    spawnFailures: overrides.spawnFailures ?? new Map()
  }
  const runtime: QueueRuntime = {
    spawnClaude: async (input) => {
      state.spawnCalls.push(input)
      if (overrides.spawn) return overrides.spawn(input, state)
      for (const [tag, failure] of state.spawnFailures) {
        if (input.taskBody.includes(tag)) return failure
      }
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
      if (overrides.exec) return overrides.exec(cmd, opts.cwd, state)
      return { exitCode: 0, stdout: 'ok', stderr: '' }
    },
    gitStatusPorcelain: async () => '',
    gitDiff: async () => 'diff --git a/x b/x\n+ change\n',
    gitUntrackedFiles: async () => [],
    gitCurrentBranch: async () => 'main',
    gitHeadSha: async () => BASE_SHA,
    gitWorktreeAdd: async (opts) => {
      state.worktreeCalls.push(opts)
      const reason = state.worktreeShouldFail.get(opts.branch)
      if (reason) throw new Error(reason)
      state.existingPaths.add(opts.worktreePath)
      state.branches.add(opts.branch)
    },
    gitWorktreeRemove: async (opts) => {
      state.worktreeRemoveCalls.push(opts)
      state.existingPaths.delete(opts.worktreePath)
      state.branches.delete(opts.branch)
    },
    pathExists: async (p) => state.existingPaths.has(p),
    isWritable: async () => overrides.parentDirWritable !== false,
    resolveRef: async () =>
      overrides.resolveRefReturns !== undefined ? overrides.resolveRefReturns : BASE_SHA,
    branchExists: async (_repo, branch) => state.branches.has(branch),
    ghAuthStatus: async () => overrides.ghAuthOk !== false,
    fileExistsAtSha: async () => overrides.fileExistsAtSha !== false,
    mkdir: async (dir) => {
      state.dirs.add(dir)
    },
    writeFile: async (file, content) => {
      state.files.set(file, content)
    },
    appendFile: async (file, content) => {
      state.files.set(file, (state.files.get(file) ?? '') + content)
    },
    readFile: async () => '{"mcpServers":{}}\n',
    artifactsDir: '/artifacts',
    queueMcpEmptyPath: '/templates/queue-mcp-empty.json',
    mcpProfile: 'empty'
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

async function createReadyAutoSafeTask(label: string): Promise<{ id: string; tag: string }> {
  // Embed `label` in the body so per-task spawn mock can match by it without
  // depending on the auto-generated task id format.
  const tag = `MARKER-${label}`
  const t = await svc.createTask({
    projectId: 'proj-q',
    title: `auto-safe ${label}`,
    labels: ['auto-safe'],
    body: `${VALID_BODY}\n${tag}\n`
  })
  await svc.updateTask(t.id, { status: 'READY' })
  return { id: t.id, tag }
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  await svc.ensureProject('proj-q', 'Queue Project', '/tmp/q')
  await svc.addWorkspace('proj-q', 'ws-q', 'Q', 'C:/repo')
})

afterEach(async () => {
  await svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('runQueueStart — happy path', () => {
  it('runs N tasks each in its own worktree, captures baseSha, writes per-task artifacts', async () => {
    const a = await createReadyAutoSafeTask('A')
    const b = await createReadyAutoSafeTask('B')
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)

    const result: QueueStartResult = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees'
    })

    expect(result.preflightAborted).toBe(false)
    expect(result.baseSha).toBe(BASE_SHA)
    expect(result.doneCount).toBe(2)
    expect(result.failedCount).toBe(0)
    expect(result.preflightSkippedCount).toBe(0)
    expect(state.worktreeCalls).toHaveLength(2)

    // Each spawn runs in its own worktree cwd, not the main checkout
    const ids = [a.id, b.id].sort()
    expect(state.spawnCalls.map((s) => s.cwd).sort()).toEqual(
      ids.map((id) => path.join('C:/repo.worktrees', id)).sort()
    )

    // Per-task outcome row carries worktree/branch/headSha
    const outcomeA = result.taskOutcomes.find((o) => o.taskId === a.id)!
    expect(outcomeA.outcome).toBe('DONE')
    expect(outcomeA.worktreePath).toBe(path.join('C:/repo.worktrees', a.id))
    expect(outcomeA.branch).toBe(`auto/${a.id}`)
    expect(outcomeA.headSha).toBe(BASE_SHA)

    // queue-run.json has queue-start shape
    const metaPath = Array.from(state.files.keys()).find((k) => k.endsWith('queue-run.json'))!
    const meta = JSON.parse(state.files.get(metaPath)!)
    expect(meta.baseRef).toBe('main')
    expect(meta.baseSha).toBe(BASE_SHA)
    expect(meta.midRunPolicy).toBe('continue')
    expect(meta.preflightAborted).toBe(false)
    expect(Array.isArray(meta.taskOutcomes)).toBe(true)
  })

  it('respects custom branchPrefix', async () => {
    const a = await createReadyAutoSafeTask('A')
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees',
      branchPrefix: 'queue/'
    })

    expect(state.worktreeCalls[0].branch).toBe(`queue/${a.id}`)
    expect(result.taskOutcomes[0].branch).toBe(`queue/${a.id}`)
  })
})

describe('runQueueStart — pre-flight abort (default)', () => {
  it('aborts the whole batch when one task has a pre-existing branch', async () => {
    const a = await createReadyAutoSafeTask('A')
    const b = await createReadyAutoSafeTask('B')
    const { runtime, state } = buildRuntime({
      preExistingBranches: [`auto/${a.id}`]
    })
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees'
    })

    expect(result.preflightAborted).toBe(true)
    expect(result.preflightAbortReason).toMatch(new RegExp(`branch already exists: auto/${a.id}`))
    expect(result.doneCount).toBe(0)
    expect(result.failedCount).toBe(0)
    expect(result.preflightSkippedCount).toBe(2)
    expect(state.spawnCalls).toHaveLength(0)
    expect(state.worktreeCalls).toHaveLength(0)

    const outcomeA = result.taskOutcomes.find((o) => o.taskId === a.id)!
    expect(outcomeA.outcome).toBe('SKIPPED_PREFLIGHT')
    expect(outcomeA.reason).toMatch(/branch already exists/)
    const outcomeB = result.taskOutcomes.find((o) => o.taskId === b.id)!
    expect(outcomeB.outcome).toBe('SKIPPED_PREFLIGHT')
  })

  it('aborts when baseRef is unresolvable (global error)', async () => {
    await createReadyAutoSafeTask('A')
    const { runtime, state } = buildRuntime({ resolveRefReturns: null })
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'does-not-exist',
      worktreesParentDir: 'C:/repo.worktrees'
    })

    expect(result.preflightAborted).toBe(true)
    expect(result.preflightAbortReason).toMatch(/baseRef "does-not-exist" is unresolvable/)
    expect(result.baseSha).toBe(null)
    expect(state.worktreeCalls).toHaveLength(0)
  })

  it('aborts when gh auth is not valid', async () => {
    await createReadyAutoSafeTask('A')
    const { runtime } = buildRuntime({ ghAuthOk: false })
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees'
    })

    expect(result.preflightAborted).toBe(true)
    expect(result.preflightAbortReason).toMatch(/gh auth status failed/)
  })
})

describe('runQueueStart — --force-continue', () => {
  it('skips per-task preflight failures and runs the rest', async () => {
    const a = await createReadyAutoSafeTask('A')
    const b = await createReadyAutoSafeTask('B')
    const { runtime, state } = buildRuntime({
      preExistingBranches: [`auto/${a.id}`]
    })
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees',
      forceContinue: true
    })

    expect(result.preflightAborted).toBe(false)
    expect(result.preflightSkippedCount).toBe(1)
    expect(result.doneCount).toBe(1)
    expect(state.worktreeCalls).toHaveLength(1)
    expect(state.worktreeCalls[0].branch).toBe(`auto/${b.id}`)

    const outcomeA = result.taskOutcomes.find((o) => o.taskId === a.id)!
    expect(outcomeA.outcome).toBe('SKIPPED_PREFLIGHT')
    const outcomeB = result.taskOutcomes.find((o) => o.taskId === b.id)!
    expect(outcomeB.outcome).toBe('DONE')
  })

  it('still aborts on global preflight errors regardless of forceContinue', async () => {
    await createReadyAutoSafeTask('A')
    const { runtime } = buildRuntime({ resolveRefReturns: null })
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'bogus',
      worktreesParentDir: 'C:/repo.worktrees',
      forceContinue: true
    })

    expect(result.preflightAborted).toBe(true)
  })
})

describe('runQueueStart — mid-run continue (KEY divergence from runQueue)', () => {
  it('continues to next task when one task fails mid-run', async () => {
    const a = await createReadyAutoSafeTask('A')
    const b = await createReadyAutoSafeTask('B')
    const c = await createReadyAutoSafeTask('C')
    const failures = new Map<string, SpawnClaudeOutput>([
      [
        b.tag,
        {
          isError: true,
          totalCostUsd: 0.02,
          numTurns: 0,
          resultText: 'something broke',
          rawJson: '{"is_error":true,"total_cost_usd":0.02,"num_turns":0,"result":"something broke"}'
        }
      ]
    ])
    const { runtime, state } = buildRuntime({ spawnFailures: failures })
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees'
    })

    expect(result.preflightAborted).toBe(false)
    expect(result.doneCount).toBe(2)
    expect(result.failedCount).toBe(1)
    expect(state.worktreeCalls).toHaveLength(3)
    expect(state.spawnCalls).toHaveLength(3)

    const outcomes = Object.fromEntries(result.taskOutcomes.map((o) => [o.taskId, o.outcome]))
    expect(outcomes[a.id]).toBe('DONE')
    expect(outcomes[b.id]).toBe('FAILED')
    expect(outcomes[c.id]).toBe('DONE')

    const outcomeB = result.taskOutcomes.find((o) => o.taskId === b.id)!
    expect(outcomeB.reason).toMatch(/claude-error/)
  })

  it('continues when gitWorktreeAdd itself fails for one task', async () => {
    const a = await createReadyAutoSafeTask('A')
    const b = await createReadyAutoSafeTask('B')
    const { runtime, state } = buildRuntime({
      worktreeShouldFail: new Map([[`auto/${a.id}`, 'git worktree add failed: simulated']])
    })
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees'
    })

    expect(result.failedCount).toBe(1)
    expect(result.doneCount).toBe(1)
    const outcomeA = result.taskOutcomes.find((o) => o.taskId === a.id)!
    expect(outcomeA.outcome).toBe('FAILED')
    expect(outcomeA.reason).toMatch(/worktree-add-failed/)
    expect(outcomeA.headSha).toBe(null)
    expect(state.spawnCalls).toHaveLength(1)
    expect(state.spawnCalls[0].taskBody).toContain(b.tag)
  })

  it('continues when an AC command fails for one task', async () => {
    const a = await createReadyAutoSafeTask('A')
    await createReadyAutoSafeTask('B')
    const { runtime, state } = buildRuntime({
      exec: async (_cmd, cwd) => {
        if (cwd.endsWith(a.id)) return { exitCode: 1, stdout: '', stderr: 'boom' }
        return { exitCode: 0, stdout: 'ok', stderr: '' }
      }
    })
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees'
    })

    expect(result.failedCount).toBe(1)
    expect(result.doneCount).toBe(1)
    expect(state.worktreeCalls).toHaveLength(2)
  })
})

describe('runQueueStart — dry-run', () => {
  it('runs preflight and reports without spawning', async () => {
    await createReadyAutoSafeTask('A')
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees',
      dryRun: true
    })

    expect(state.spawnCalls).toHaveLength(0)
    expect(state.worktreeCalls).toHaveLength(0)
    expect(result.baseSha).toBe(BASE_SHA)
    expect(result.taskOutcomes[0].outcome).toBe('SKIPPED_PREFLIGHT')
  })
})

describe('runQueueStart — workspace not found', () => {
  it('throws WorkspaceResolutionError', async () => {
    const { runtime } = buildRuntime()
    const queue = buildService(runtime)
    await expect(
      queue.runQueueStart({
        workspaceId: 'ws-nope',
        baseRef: 'main',
        worktreesParentDir: 'C:/repo.worktrees'
      })
    ).rejects.toBeInstanceOf(WorkspaceResolutionError)
  })
})

describe('runQueueStart — queue.jsonl event stream (TASK-741, ADR-019)', () => {
  function readJsonlEvents(state: FakeState, artifactDir: string): Record<string, unknown>[] {
    const raw = state.files.get(path.join(artifactDir, 'queue.jsonl'))
    if (!raw) return []
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  it('all-DONE: 2 tasks → 2 × task.started + 2 × task.finished(DONE) + 1 × run.finished', async () => {
    const a = await createReadyAutoSafeTask('A')
    const b = await createReadyAutoSafeTask('B')
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees'
    })

    const events = readJsonlEvents(state, result.artifactDir)
    expect(events.map((e) => e.event)).toEqual([
      'task.started',
      'task.finished',
      'task.started',
      'task.finished',
      'run.finished'
    ])
    expect(events[0]).toMatchObject({
      event: 'task.started',
      queueRunId: result.queueRunId,
      taskId: a.id,
      taskIndex: 1
    })
    expect(events[1]).toMatchObject({ event: 'task.finished', taskId: a.id, outcome: 'DONE' })
    expect(events[2]).toMatchObject({ event: 'task.started', taskId: b.id, taskIndex: 2 })
    expect(events[3]).toMatchObject({ event: 'task.finished', taskId: b.id, outcome: 'DONE' })
    expect(events[4]).toMatchObject({
      event: 'run.finished',
      queueRunId: result.queueRunId,
      taskCount: 2
    })
  })

  it('continue-on-fail: failing task emits task.finished(FAILED), next task still runs, run.finished (NOT run.failed) at end', async () => {
    const a = await createReadyAutoSafeTask('A')
    const b = await createReadyAutoSafeTask('B')
    const failures = new Map<string, SpawnClaudeOutput>([
      [
        a.tag,
        {
          isError: true,
          totalCostUsd: 0.02,
          numTurns: 0,
          resultText: 'boom',
          rawJson: '{"is_error":true,"total_cost_usd":0.02,"num_turns":0,"result":"boom"}'
        }
      ]
    ])
    const { runtime, state } = buildRuntime({ spawnFailures: failures })
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees'
    })

    const events = readJsonlEvents(state, result.artifactDir)
    expect(events.map((e) => e.event)).toEqual([
      'task.started',
      'task.finished',
      'task.started',
      'task.finished',
      'run.finished'
    ])
    expect(events[1]).toMatchObject({ taskId: a.id, outcome: 'FAILED', costUsd: 0.02 })
    expect(events[3]).toMatchObject({ taskId: b.id, outcome: 'DONE' })
    expect(events.find((e) => e.event === 'run.failed')).toBeUndefined()
  })

  it('preflight-skipped tasks emit no events (only executed tasks appear in stream)', async () => {
    const a = await createReadyAutoSafeTask('A')
    const b = await createReadyAutoSafeTask('B')
    const { runtime, state } = buildRuntime({
      preExistingBranches: [`auto/${a.id}`]
    })
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees',
      forceContinue: true
    })

    const events = readJsonlEvents(state, result.artifactDir)
    // Task a is preflight-skipped, only b emits events
    expect(events.map((e) => e.event)).toEqual(['task.started', 'task.finished', 'run.finished'])
    expect(events[0]).toMatchObject({ taskId: b.id, taskIndex: 1 })
    expect(events[2]).toMatchObject({ event: 'run.finished', taskCount: 1 })
  })

  it('preflight abort (default policy, no forceContinue): emits no queue.jsonl', async () => {
    const a = await createReadyAutoSafeTask('A')
    await createReadyAutoSafeTask('B')
    const { runtime, state } = buildRuntime({
      preExistingBranches: [`auto/${a.id}`]
    })
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees'
    })

    expect(result.preflightAborted).toBe(true)
    expect(state.files.get(path.join(result.artifactDir, 'queue.jsonl'))).toBeUndefined()
  })

  it('dry-run: emits no queue.jsonl', async () => {
    await createReadyAutoSafeTask('A')
    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees',
      dryRun: true
    })

    expect(state.files.get(path.join(result.artifactDir, 'queue.jsonl'))).toBeUndefined()
  })
})

describe('runQueueStart — preflight rollback (TASK-755)', () => {
  it('rolls back worktree when session-start fails after worktree was added', async () => {
    const a = await createReadyAutoSafeTask('A')
    const b = await createReadyAutoSafeTask('B')

    // Pre-create an orphan active session for task A (simulates a crashed previous run).
    // Then revert task to READY so collectEligibleTasks still picks it up —
    // but startSession will throw TaskLockedBySessionError when the runner tries.
    const internals = svc as unknown as { sessionLifecycle: { startSession: (i: unknown) => unknown } }
    await internals.sessionLifecycle.startSession({
      projectId: 'proj-q',
      workspaceId: 'ws-q',
      taskId: a.id
    })
    await svc.updateTask(a.id, { status: 'READY' })

    const { runtime, state } = buildRuntime()
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees'
    })

    // Worktree was added then rolled back
    expect(state.worktreeCalls).toHaveLength(2) // a attempted, b succeeds
    expect(state.worktreeRemoveCalls).toHaveLength(1)
    expect(state.worktreeRemoveCalls[0].worktreePath).toBe(path.join('C:/repo.worktrees', a.id))
    expect(state.worktreeRemoveCalls[0].branch).toBe(`auto/${a.id}`)

    // Task A has no orphan worktree on fake-fs, task A status intact
    expect(state.existingPaths.has(path.join('C:/repo.worktrees', a.id))).toBe(false)

    // Task A outcome is FAILED (setup could not complete)
    const outcomeA = result.taskOutcomes.find((o) => o.taskId === a.id)!
    expect(outcomeA.outcome).toBe('FAILED')
    expect(outcomeA.reason).toMatch(/session-start-failed/)

    // Task B was unaffected — still ran successfully
    const outcomeB = result.taskOutcomes.find((o) => o.taskId === b.id)!
    expect(outcomeB.outcome).toBe('DONE')
    expect(result.doneCount).toBe(1)
    expect(result.failedCount).toBe(1)
  })

  it('no rollback when worktree-add itself fails (nothing was created)', async () => {
    const a = await createReadyAutoSafeTask('A')
    const { runtime, state } = buildRuntime({
      worktreeShouldFail: new Map([[`auto/${a.id}`, 'disk full']])
    })
    const queue = buildService(runtime)

    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees'
    })

    // No rollback needed — gitWorktreeRemove was never called
    expect(state.worktreeRemoveCalls).toHaveLength(0)
    const outcomeA = result.taskOutcomes.find((o) => o.taskId === a.id)!
    expect(outcomeA.outcome).toBe('FAILED')
    expect(outcomeA.reason).toMatch(/worktree-add-failed/)
    // Task gets auto-failed label from markTaskFailed
    expect((await svc.getTask(a.id))?.labels).toContain('auto-failed')
  })

  it('rollback failure is logged but does not mask the original setup error', async () => {
    const a = await createReadyAutoSafeTask('A')

    // Pre-create orphan session so startSession throws
    const internals = svc as unknown as { sessionLifecycle: { startSession: (i: unknown) => unknown } }
    await internals.sessionLifecycle.startSession({
      projectId: 'proj-q',
      workspaceId: 'ws-q',
      taskId: a.id
    })
    await svc.updateTask(a.id, { status: 'READY' })

    // Simulate gitWorktreeRemove throwing during rollback
    const { runtime, state } = buildRuntime()
    runtime.gitWorktreeRemove = async () => {
      // Track the call but throw to simulate rollback failure
      state.worktreeRemoveCalls.push({ repoCwd: '', worktreePath: 'fail', branch: 'fail' })
      throw new Error('rollback: worktree remove failed')
    }
    const queue = buildService(runtime)

    // Should not throw — rollback failure is logged, original setup error drives outcome
    const result = await queue.runQueueStart({
      workspaceId: 'ws-q',
      baseRef: 'main',
      worktreesParentDir: 'C:/repo.worktrees'
    })

    const outcomeA = result.taskOutcomes.find((o) => o.taskId === a.id)!
    expect(outcomeA.outcome).toBe('FAILED')
    expect(outcomeA.reason).toMatch(/session-start-failed/)
    // rollbackPreflightEffects was still called (worktreeRemoveCalls has 1 entry)
    expect(state.worktreeRemoveCalls).toHaveLength(1)
  })
})
