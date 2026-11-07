import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { SqliteTaskService } from '../../../../core/domain/sqlite-task-service'
import { register, type SessionToolsDeps } from '../session-tools'
import type { GitOps } from '../../../../core/domain/knowledge-git'

interface RegisteredTool {
  name: string
  handler: (args?: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>
  }>
}

function makeServerStub(): {
  tools: RegisteredTool[]
  registerTool: (name: string, _meta: unknown, handler: RegisteredTool['handler']) => void
} {
  const tools: RegisteredTool[] = []
  return {
    tools,
    registerTool: (name, _meta, handler) => {
      tools.push({ name, handler })
    }
  }
}

const TEST_DB = path.join(__dirname, '__test-session-start-workspace__.db')

const noopGit: GitOps = {
  getHeadSha: () => '',
  countCommitsSince: () => 0,
  isAncestor: () => false,
  filesInCommit: () => [],
  commitsInWindow: () => []
}

// TASK-3142 — session_start refuses a workspace that is not registered.
describe('session_start — explicit workspaceId must be registered', () => {
  let svc: SqliteTaskService
  let server: ReturnType<typeof makeServerStub>

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
    svc = new SqliteTaskService(TEST_DB)
    await svc.ensureProject('proj-w', 'Workspace Project', '/tmp/w')
    await svc.addWorkspace('proj-w', 'choda-deck-companion', 'Companion', '/tmp/w-companion')
    await svc.createTask({
      id: 'TASK-W1',
      projectId: 'proj-w',
      title: 'Workspace task',
      priority: 'medium',
      status: 'READY'
    })
    server = makeServerStub()
    register(
      server as unknown as Parameters<typeof register>[0],
      svc as unknown as SessionToolsDeps,
      noopGit
    )
  })

  afterEach(async () => {
    await svc.close()
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  })

  async function callRaw(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = server.tools.find((t) => t.name === name)
    if (!tool) throw new Error(`Tool ${name} not registered`)
    return (await tool.handler(args)).content[0].text
  }

  function sessionRowsFor(taskId: string): number {
    const db = new Database(TEST_DB, { readonly: true })
    try {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM sessions WHERE task_id = ?')
        .get(taskId) as { n: number }
      return row.n
    } finally {
      db.close()
    }
  }

  it('a rejected call creates no session row', async () => {
    const msg = await callRaw('session_start', {
      projectId: 'proj-w',
      taskId: 'TASK-W1',
      workspaceId: 'companion'
    })
    expect(msg).toMatch(/WORKSPACE_RESOLUTION_FAILED|not a registered workspace/)
    expect(sessionRowsFor('TASK-W1')).toBe(0)
  })

  it('a rejected call leaves the task READY', async () => {
    await callRaw('session_start', {
      projectId: 'proj-w',
      taskId: 'TASK-W1',
      workspaceId: 'companion'
    })
    expect((await svc.getTask('TASK-W1'))?.status).toBe('READY')
  })

  it('a registered workspace still starts a session', async () => {
    const text = await callRaw('session_start', {
      projectId: 'proj-w',
      taskId: 'TASK-W1',
      workspaceId: 'choda-deck-companion'
    })
    expect(JSON.parse(text).workspaceId).toBe('choda-deck-companion')
    expect(sessionRowsFor('TASK-W1')).toBe(1)
  })
})
