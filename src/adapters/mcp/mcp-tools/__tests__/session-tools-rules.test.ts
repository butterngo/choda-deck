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

const TEST_DB = path.join(__dirname, '__test-session-tools-rules__.db')

const noopGit: GitOps = {
  filesChangedAtCommit: () => []
}

describe('session-tools — B+ rule injection contract', () => {
  let svc: SqliteTaskService
  let server: ReturnType<typeof makeServerStub>

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
    svc = new SqliteTaskService(TEST_DB)
    svc.ensureProject('proj-r', 'Rules Project', '/tmp/r')
    svc.createTask({ id: 'TASK-R1', projectId: 'proj-r', title: 'Rules task', priority: 'medium' })
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

  it('session_start response includes all 4 rule fields (B+: load once)', async () => {
    const out = await callTool('session_start', { projectId: 'proj-r', taskId: 'TASK-R1' })
    const rules = out.rules as Record<string, string>
    expect(rules).toBeDefined()
    expect(Object.keys(rules).sort()).toEqual([
      'onCheckpoint',
      'onResume',
      'onSessionEnd',
      'onSessionStart'
    ])
    // sanity: each section is non-empty (means the loader actually found the MD)
    expect(rules.onSessionStart.length).toBeGreaterThan(0)
    expect(rules.onCheckpoint.length).toBeGreaterThan(0)
    expect(rules.onResume.length).toBeGreaterThan(0)
    expect(rules.onSessionEnd.length).toBeGreaterThan(0)
  })

  it('session_checkpoint response does NOT include rules (B+: rules already in start)', async () => {
    const start = await callTool('session_start', { projectId: 'proj-r', taskId: 'TASK-R1' })
    const sessionId = start.sessionId as string
    const out = await callTool('session_checkpoint', {
      sessionId,
      resumePoint: 'midway through edit'
    })
    expect(out.rules).toBeUndefined()
    expect(out.checkpoint).toBeDefined()
  })

  it('session_resume response includes rules.onResume (B+: crash-recovery fallback)', async () => {
    const start = await callTool('session_start', { projectId: 'proj-r', taskId: 'TASK-R1' })
    const sessionId = start.sessionId as string
    await callTool('session_checkpoint', { sessionId, resumePoint: 'paused' })
    const out = await callTool('session_resume', { sessionId })
    const rules = out.rules as Record<string, string>
    expect(rules).toBeDefined()
    expect(Object.keys(rules)).toEqual(['onResume'])
    expect(rules.onResume.length).toBeGreaterThan(0)
  })

  it('session_end response does NOT include rules (B+: rules already in start)', async () => {
    const start = await callTool('session_start', { projectId: 'proj-r', taskId: 'TASK-R1' })
    const sessionId = start.sessionId as string
    const out = await callTool('session_end', {
      sessionId,
      resumePoint: 'wrapped up'
    })
    expect(out.rules).toBeUndefined()
    expect(out.sessionId).toBe(sessionId)
  })
})
