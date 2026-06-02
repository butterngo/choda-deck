import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../../../../core/domain/sqlite-task-service'
import { register, type SessionToolsDeps } from '../session-tools'
import type { GitOps } from '../../../../core/domain/knowledge-git'
import type { TranscriptOps } from '../../../../core/domain/session-transcript'

// TASK-985 AC #5 + #6 — end-to-end through the MCP tool layer: session_start →
// session_end({ sessionId }) with no other fields derives commits[] + resumePoint
// into the persisted handoff. git + transcript are injected fakes (the FS/git I/O
// is covered by unit tests + the live tsx smoke); this test pins the WIRING +
// AI-wins override + ccSessionId capture, against a real SQLite-backed service.

interface RegisteredTool {
  name: string
  handler: (args?: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
}

function makeServerStub(): {
  tools: RegisteredTool[]
  registerTool: (name: string, _meta: unknown, handler: RegisteredTool['handler']) => void
} {
  const tools: RegisteredTool[] = []
  return { tools, registerTool: (name, _meta, handler) => tools.push({ name, handler }) }
}

const TEST_DB = path.join(__dirname, '__test-session-end-derivation__.db')

// fake git: a session window always yields these 2 commits (stands in for "2 commits made")
const DERIVED_COMMITS = ['aaa1111 TASK-IT first commit', 'bbb2222 TASK-IT second commit']
const twoCommitGit: GitOps = {
  getHeadSha: () => 'aaa1111',
  countCommitsSince: () => 2,
  isAncestor: () => true,
  filesInCommit: () => [],
  commitsInWindow: () => [...DERIVED_COMMITS]
}

const DERIVED_RESUME = 'derived: finished wiring the derivation path'
const fakeTranscript: TranscriptOps = { readResumePoint: () => DERIVED_RESUME }

describe('session_end derivation — AC #5/#6 integration', () => {
  let svc: SqliteTaskService
  let server: ReturnType<typeof makeServerStub>

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
    svc = new SqliteTaskService(TEST_DB)
    svc.ensureProject('proj-it', 'IT Project', 'C:/repo-it')
    svc.createTask({ id: 'TASK-IT', projectId: 'proj-it', title: 'IT task', priority: 'medium' })
    server = makeServerStub()
    register(
      server as unknown as Parameters<typeof register>[0],
      svc as unknown as SessionToolsDeps,
      twoCommitGit,
      fakeTranscript
    )
  })

  afterEach(() => {
    svc.close()
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  })

  async function callTool(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = server.tools.find((t) => t.name === name)
    if (!tool) throw new Error(`Tool ${name} not registered`)
    return JSON.parse((await tool.handler(args)).content[0].text) as Record<string, unknown>
  }

  async function persistedHandoff(): Promise<Record<string, unknown>> {
    const list = await callTool('session_list', {
      projectId: 'proj-it',
      status: 'completed',
      includeHandoff: true
    })
    const sessions = list.sessions as Array<{ handoff: Record<string, unknown> }>
    return sessions[0].handoff
  }

  it('session_start captures ccSessionId onto the session row', async () => {
    const start = await callTool('session_start', {
      projectId: 'proj-it',
      taskId: 'TASK-IT',
      ccSessionId: 'cc-uuid-xyz'
    })
    const session = await svc.getSession(start.sessionId as string)
    expect(session?.ccSessionId).toBe('cc-uuid-xyz')
  })

  it('session_end({ sessionId }) with NO other fields derives commits + resumePoint', async () => {
    const start = await callTool('session_start', {
      projectId: 'proj-it',
      taskId: 'TASK-IT',
      ccSessionId: 'cc-uuid-xyz'
    })
    const end = await callTool('session_end', { sessionId: start.sessionId })
    expect(end.sessionId).toBe(start.sessionId)
    expect(end.taskUpdated).toMatchObject({ id: 'TASK-IT' }) // task closed DONE

    const handoff = await persistedHandoff()
    expect(handoff.commits).toEqual(DERIVED_COMMITS)
    expect(handoff.resumePoint).toBe(DERIVED_RESUME)
  })

  it('AI-supplied commits + resumePoint win over derivation (explicit path preserved, AC #5)', async () => {
    const start = await callTool('session_start', { projectId: 'proj-it', taskId: 'TASK-IT' })
    await callTool('session_end', {
      sessionId: start.sessionId,
      commits: ['ccc9999 explicit commit'],
      resumePoint: 'I stopped here, explicitly'
    })
    const handoff = await persistedHandoff()
    expect(handoff.commits).toEqual(['ccc9999 explicit commit'])
    expect(handoff.resumePoint).toBe('I stopped here, explicitly')
  })

  it('bare session_end does NOT fabricate a summary row (filesChanged stays summary-bound)', async () => {
    const start = await callTool('session_start', { projectId: 'proj-it', taskId: 'TASK-IT' })
    await callTool('session_end', { sessionId: start.sessionId })
    const events = await svc.listSessionEvents(start.sessionId as string)
    const summaryRows = events.filter((e) => {
      try {
        return (JSON.parse(e.payloadJson) as { kind?: string }).kind === 'session_summary'
      } catch {
        return false
      }
    })
    expect(summaryRows).toHaveLength(0)
  })
})
