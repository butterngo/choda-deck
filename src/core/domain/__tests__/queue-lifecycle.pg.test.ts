// Smoke sibling of lifecycle/queue-lifecycle-service.test.ts (~40 tests against
// SqliteTaskService) — drives the queue lifecycle through PostgresTaskService.
//
// Scope: verify the PG facade wiring works end-to-end for the four DB-touching
// paths the queue service uses (workspaces.get / tasks.find / tasks.update /
// conversations.findByLink+addMessage), plus the session-gateway adapter
// (startSession / checkpointSession). The full behavioral matrix (cost caps,
// halt codes, retries, preflight matrix, AUTO_FAILED label transitions, etc.)
// is exercised by the sqlite suite — porting all 40 would just re-run the same
// JS code against a slower DB.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as path from 'node:path'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../test/postgres-harness'
import { PostgresTaskService } from '../postgres-task-service'
import {
  QueueDirtyTreeError,
  WorkspaceResolutionError
} from '../lifecycle/errors'
import type {
  ExecShellResult,
  QueueRuntime,
  SpawnClaudeInput,
  SpawnClaudeOutput
} from '../lifecycle/queue-lifecycle-service'

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
}

function buildRuntime(
  overrides: {
    spawn?: (input: SpawnClaudeInput) => Promise<SpawnClaudeOutput>
    exec?: (cmd: string) => Promise<ExecShellResult>
    porcelain?: string
  } = {}
): { runtime: QueueRuntime; state: FakeRuntimeState } {
  const state: FakeRuntimeState = {
    spawnCalls: [],
    execCalls: [],
    files: new Map()
  }
  const runtime: QueueRuntime = {
    spawnClaude: async (input) => {
      state.spawnCalls.push(input)
      if (overrides.spawn) return overrides.spawn(input)
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
      if (overrides.exec) return overrides.exec(cmd)
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    gitStatusPorcelain: async () => overrides.porcelain ?? '',
    gitDiff: async () => 'diff --git a/x b/x\n+ change\n',
    gitUntrackedFiles: async () => [],
    gitCurrentBranch: async () => 'main',
    gitHeadSha: async () => 'abc123',
    gitWorktreeAdd: async () => {},
    gitWorktreeRemove: async () => {},
    // Preflight asks `pathExists` twice with different intent: the parent
    // worktrees dir must exist (true), but each per-task worktree path must
    // NOT exist yet (false). Discriminate on path depth — the parent is the
    // shorter of the two.
    pathExists: async (p: string) => p === '/tmp/q.worktrees',
    isWritable: async () => true,
    resolveRef: async () => 'abc123',
    branchExists: async () => false,
    ghAuthStatus: async () => true,
    fileExistsAtSha: async () => true,
    mkdir: async () => {},
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

describeIfDocker('PostgresTaskService queue lifecycle (smoke)', () => {
  let env: PgTestEnv
  let svc: PostgresTaskService

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    svc = new PostgresTaskService(env.conn)
    await svc.initializeAsync()
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    await env.conn.query('DELETE FROM session_events')
    await env.conn.query('DELETE FROM conversation_actions')
    await env.conn.query('DELETE FROM conversation_messages')
    await env.conn.query('DELETE FROM conversation_links')
    await env.conn.query('DELETE FROM conversation_participants')
    await env.conn.query('DELETE FROM conversations')
    await env.conn.query('DELETE FROM context_sources')
    await env.conn.query('DELETE FROM relationships')
    await env.conn.query('DELETE FROM tags')
    await env.conn.query('DELETE FROM tasks')
    await env.conn.query('DELETE FROM sessions')
    await env.conn.query('DELETE FROM workspaces')
    await env.conn.query('DELETE FROM projects')
    await env.conn.query(
      "UPDATE global_counters SET last_number = 0 WHERE entity_type IN ('task','session','conv','act','evt','mem')"
    )
    await svc.ensureProject('proj-q', 'Queue Project', '/tmp/q')
    await svc.addWorkspace('proj-q', 'ws-q', 'Q', '/tmp/q')
  })

  async function createReadyAutoSafeTask(title = 'Auto-safe'): Promise<string> {
    const t = await svc.createTask({
      projectId: 'proj-q',
      title,
      labels: ['auto-safe'],
      body: VALID_BODY
    })
    await svc.updateTask(t.id, { status: 'READY' })
    return t.id
  }

  describe('createQueueLifecycle wiring', () => {
    it('returns a QueueLifecycleService instance (no throw)', () => {
      const { runtime } = buildRuntime()
      const queue = svc.createQueueLifecycle(runtime)
      expect(queue).toBeDefined()
      expect(typeof queue.runQueue).toBe('function')
      expect(typeof queue.runQueueStart).toBe('function')
    })
  })

  describe('runQueue — pre-flight (workspace + tasks PG reads)', () => {
    it('throws WorkspaceResolutionError when workspace not found', async () => {
      const { runtime } = buildRuntime()
      const queue = svc.createQueueLifecycle(runtime)
      await expect(queue.runQueue({ workspaceId: 'ws-missing' })).rejects.toBeInstanceOf(
        WorkspaceResolutionError
      )
    })

    it('throws QueueDirtyTreeError when working tree is dirty', async () => {
      await createReadyAutoSafeTask()
      const { runtime } = buildRuntime({ porcelain: ' M src/foo.ts\n' })
      const queue = svc.createQueueLifecycle(runtime)
      await expect(queue.runQueue({ workspaceId: 'ws-q' })).rejects.toBeInstanceOf(
        QueueDirtyTreeError
      )
    })

    it('dryRun: collects eligible auto-safe READY tasks, no spawn', async () => {
      const taskId = await createReadyAutoSafeTask()
      const { runtime, state } = buildRuntime()
      const queue = svc.createQueueLifecycle(runtime)
      const r = await queue.runQueue({ workspaceId: 'ws-q', dryRun: true })

      expect(state.spawnCalls).toHaveLength(0)
      expect(r.done).toEqual([])
      expect(r.skipped.map((x) => x.id)).toEqual([taskId])
    })
  })

  describe('runQueue — happy path (tasks.update + sessionGateway round-trip)', () => {
    it('flips task to REVIEW, drives sessionGateway start + checkpoint', async () => {
      const taskId = await createReadyAutoSafeTask()
      const { runtime } = buildRuntime()
      const queue = svc.createQueueLifecycle(runtime)
      const r = await queue.runQueue({ workspaceId: 'ws-q' })

      expect(r.halted).toBe(false)
      expect(r.done.map((t) => t.id)).toEqual([taskId])
      const after = await svc.getTask(taskId)
      expect(after?.status).toBe('REVIEW')

      // sessionGateway.startSession created a session and bound it to the task,
      // then checkpoint closed the cycle. After the checkpoint the session row
      // is still active (queue doesn't end sessions — that's a reviewer move).
      const sessions = await svc.findSessions('proj-q')
      expect(sessions).toHaveLength(1)
      expect(sessions[0].taskId).toBe(taskId)
      expect(sessions[0].status).toBe('active')
    })
  })

  describe('runQueueStart — markTaskFailed path (conversations PG writes)', () => {
    it('on AC fail: adds AUTO_FAILED label + posts auto-fail comment on linked conv', async () => {
      const taskId = await createReadyAutoSafeTask('AC-fail task')

      // Pre-create a conversation linked to the task so markTaskFailed has
      // somewhere to post (exercises conversations.findByLink + addMessage).
      const conv = await svc.createConversation({
        projectId: 'proj-q',
        title: 'Pre-existing review thread',
        createdBy: 'tester'
      })
      await svc.linkConversation(conv.id, 'task', taskId)

      const { runtime } = buildRuntime({
        exec: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' })
      })
      const queue = svc.createQueueLifecycle(runtime)
      const r = await queue.runQueueStart({
        workspaceId: 'ws-q',
        baseRef: 'main',
        worktreesParentDir: '/tmp/q.worktrees'
      })

      expect(r.failedCount).toBe(1)
      expect(r.taskOutcomes[0].outcome).toBe('FAILED')
      expect(r.taskOutcomes[0].reason).toMatch(/ac-failed/)

      const after = await svc.getTask(taskId)
      expect(after?.labels).toContain('auto-failed')
      expect(after?.status).toBe('REVIEW')

      const messages = await svc.getConversationMessages(conv.id)
      const autoFailMsg = messages.find((m) => m.content.startsWith('Auto-failed:'))
      expect(autoFailMsg).toBeDefined()
      expect(autoFailMsg?.authorName).toBe('queue-runner')
      expect(autoFailMsg?.content).toContain(path.join('/artifacts', 'queue-start-'))
    })
  })
})
