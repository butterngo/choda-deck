import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
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

const TEST_DB = path.join(__dirname, '__test-session-cancel__.db')

const noopGit: GitOps = {
  getHeadSha: () => '',
  countCommitsSince: () => 0,
  isAncestor: () => false,
  filesInCommit: () => [],
  commitsInWindow: () => []
}

describe('session_cancel — retire an active session without completing its task', () => {
  let svc: SqliteTaskService
  let server: ReturnType<typeof makeServerStub>

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
    svc = new SqliteTaskService(TEST_DB)
    svc.ensureProject('proj-c', 'Cancel Project', '/tmp/c')
    svc.createTask({ id: 'TASK-C1', projectId: 'proj-c', title: 'Cancel task', priority: 'medium' })
    server = makeServerStub()
    register(
      server as unknown as Parameters<typeof register>[0],
      svc as unknown as SessionToolsDeps,
      noopGit
    )
  })

  afterEach(() => {
    svc.close()
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  })

  async function callTool(
    name: string,
    args?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const tool = server.tools.find((t) => t.name === name)
    if (!tool) throw new Error(`Tool ${name} not registered`)
    const res = await tool.handler(args)
    return JSON.parse(res.content[0].text) as Record<string, unknown>
  }

  // LifecycleError is caught by tryLifecycle and returned as a RAW text message
  // (not JSON) — read content directly rather than via callTool's JSON.parse.
  async function callToolRaw(name: string, args?: Record<string, unknown>): Promise<string> {
    const tool = server.tools.find((t) => t.name === name)
    if (!tool) throw new Error(`Tool ${name} not registered`)
    const res = await tool.handler(args)
    return res.content[0].text
  }

  it('completes the session but leaves the bound task IN-PROGRESS (not DONE)', async () => {
    const start = await callTool('session_start', { projectId: 'proj-c', taskId: 'TASK-C1' })
    const sessionId = start.sessionId as string
    expect((await svc.getTask('TASK-C1'))?.status).toBe('IN-PROGRESS')

    const out = await callTool('session_cancel', {
      sessionId,
      reason: 'empty session — no work recorded'
    })

    expect(out.sessionId).toBe(sessionId)
    expect(out.status).toBe('completed')
    expect(out.taskUntouched).toBe(true)
    expect(out.endedAt).toBeTruthy()
    // Task is NOT marked DONE — the whole point vs session_end.
    expect((await svc.getTask('TASK-C1'))?.status).toBe('IN-PROGRESS')
  })

  it('drops the cancelled session out of the active set', async () => {
    const start = await callTool('session_start', { projectId: 'proj-c', taskId: 'TASK-C1' })
    const sessionId = start.sessionId as string

    await callTool('session_cancel', { sessionId })

    const active = await callTool('session_list', { projectId: 'proj-c', status: 'active' })
    expect(active.total).toBe(0)
  })

  it('defaults the reason when none is given', async () => {
    const start = await callTool('session_start', { projectId: 'proj-c', taskId: 'TASK-C1' })
    const sessionId = start.sessionId as string

    const out = await callTool('session_cancel', { sessionId })
    expect(out.status).toBe('completed')
  })

  it('rejects cancelling an already-completed session', async () => {
    const start = await callTool('session_start', { projectId: 'proj-c', taskId: 'TASK-C1' })
    const sessionId = start.sessionId as string
    await callTool('session_cancel', { sessionId })

    // LifecycleError is caught by tryLifecycle and returned as a text message,
    // not thrown — assert the surfaced error string.
    const msg = await callToolRaw('session_cancel', { sessionId })
    expect(msg).toMatch(/only active sessions/i)
  })
})
