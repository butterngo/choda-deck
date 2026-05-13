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

function createReadyAutoSafeTask(label: string): { id: string; tag: string } {
  // Embed `label` in the body so per-task spawn mock can match by it without
  // depending on the auto-generated task id format.
  const tag = `MARKER-${label}`
  const t = svc.createTask({
    projectId: 'proj-q',
    title: `auto-safe ${label}`,
    labels: ['auto-safe'],
    body: `${VALID_BODY}\n${tag}\n`
  })
  svc.updateTask(t.id, { status: 'READY' })
  return { id: t.id, tag }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('proj-q', 'Queue Project', '/tmp/q')
  svc.addWorkspace('proj-q', 'ws-q', 'Q', 'C:/repo')
})

afterEach(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('runQueueStart — happy path', () => {
  it('runs N tasks each in its own worktree, captures baseSha, writes per-task artifacts', async () => {
    const a = createReadyAutoSafeTask('A')
    const b = createReadyAutoSafeTask('B')
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
    const a = createReadyAutoSafeTask('A')
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
    const a = createReadyAutoSafeTask('A')
    const b = createReadyAutoSafeTask('B')
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
    createReadyAutoSafeTask('A')
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
    createReadyAutoSafeTask('A')
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
    const a = createReadyAutoSafeTask('A')
    const b = createReadyAutoSafeTask('B')
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
    createReadyAutoSafeTask('A')
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
    const a = createReadyAutoSafeTask('A')
    const b = createReadyAutoSafeTask('B')
    const c = createReadyAutoSafeTask('C')
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
    const a = createReadyAutoSafeTask('A')
    const b = createReadyAutoSafeTask('B')
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
    const a = createReadyAutoSafeTask('A')
    createReadyAutoSafeTask('B')
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
    createReadyAutoSafeTask('A')
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
