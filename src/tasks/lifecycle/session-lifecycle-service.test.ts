import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import { SessionNotFoundError, SessionStatusError } from './errors'

const TEST_DB = path.join(__dirname, '__test-session-lifecycle__.db')
let svc: SqliteTaskService

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('proj-s', 'Session Project', '/tmp/s')
})

afterEach(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('startSession', () => {
  it('happy path: creates session + auto-conv + returns active context sources', () => {
    svc.createContextSource({
      projectId: 'proj-s',
      sourceType: 'file',
      sourcePath: 'docs/context.md',
      label: 'Context',
      category: 'what'
    })
    svc.createContextSource({
      projectId: 'proj-s',
      sourceType: 'file',
      sourcePath: 'docs/inactive.md',
      label: 'Inactive',
      category: 'what',
      isActive: false
    })

    const r = svc.startSession({ projectId: 'proj-s', workspaceId: 'ws-a' })

    expect(r.session.status).toBe('active')
    expect(r.session.workspaceId).toBe('ws-a')
    expect(r.conversationId).toMatch(/^CONV-/)
    expect(r.contextSources).toHaveLength(1)
    expect(r.contextSources[0].label).toBe('Context')
  })

  it('links auto-conv to session via "session" link type', () => {
    const r = svc.startSession({ projectId: 'proj-s' })
    const linked = svc.findConversationsByLink('session', r.session.id)
    expect(linked).toHaveLength(1)
    expect(linked[0].id).toBe(r.conversationId)
    expect(linked[0].status).toBe('open')
  })

  it('default participants include Butter + Claude', () => {
    const r = svc.startSession({ projectId: 'proj-s' })
    const participants = svc.getConversationParticipants(r.conversationId)
    const names = participants.map((p) => p.name).sort()
    expect(names).toEqual(['Butter', 'Claude'])
  })

  it('works without workspaceId', () => {
    const r = svc.startSession({ projectId: 'proj-s' })
    expect(r.session.workspaceId).toBeNull()
    expect(r.conversationId).toBeTruthy()
  })
})

describe('endSession', () => {
  it('happy path: active → completed, handoff persisted, linked conv closed', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const r = svc.endSession(started.session.id, {
      handoff: { resumePoint: 'done for the day', decisions: ['chose option A'] }
    })

    expect(r.session.status).toBe('completed')
    expect(r.session.endedAt).not.toBeNull()
    expect(r.session.handoff?.resumePoint).toBe('done for the day')
    expect(r.closedConversationIds).toEqual([started.conversationId])

    const conv = svc.getConversation(started.conversationId)
    expect(conv?.status).toBe('closed')
    expect(conv?.decisionSummary).toBe('done for the day')
  })

  it('marks linked task DONE when session had a taskId', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const task = svc.createTask({ projectId: 'proj-s', title: 'Do X' })
    svc.updateSession(started.session.id, { taskId: task.id })

    const r = svc.endSession(started.session.id, {
      handoff: { resumePoint: 'x' }
    })

    expect(r.taskUpdated).toEqual({ id: task.id, title: 'Do X', newStatus: 'DONE' })
    expect(svc.getTask(task.id)?.status).toBe('DONE')
  })

  it('uses custom decisionSummary when provided', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.endSession(started.session.id, {
      handoff: { resumePoint: 'r' },
      decisionSummary: 'custom summary'
    })
    expect(svc.getConversation(started.conversationId)?.decisionSummary).toBe('custom summary')
  })

  it('throws SessionNotFoundError on missing id', () => {
    expect(() => svc.endSession('SESSION-999', { handoff: { resumePoint: 'x' } })).toThrowError(
      SessionNotFoundError
    )
  })

  it('throws SessionStatusError when session already completed', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(() =>
      svc.endSession(started.session.id, { handoff: { resumePoint: 'again' } })
    ).toThrowError(SessionStatusError)
  })
})

describe('startSession existingActiveSessions', () => {
  it('returns empty array when no prior active sessions', () => {
    const r = svc.startSession({ projectId: 'proj-s' })
    expect(r.existingActiveSessions).toEqual([])
  })

  it('surfaces prior active sessions without blocking new session creation', () => {
    const first = svc.startSession({ projectId: 'proj-s', workspaceId: 'ws-a' })
    const second = svc.startSession({ projectId: 'proj-s', workspaceId: 'ws-b' })

    expect(second.session.id).not.toBe(first.session.id)
    expect(second.existingActiveSessions).toHaveLength(1)
    expect(second.existingActiveSessions[0].id).toBe(first.session.id)
  })

  it('excludes completed sessions from existingActiveSessions', () => {
    const first = svc.startSession({ projectId: 'proj-s' })
    svc.endSession(first.session.id, { handoff: { resumePoint: 'r' } })

    const second = svc.startSession({ projectId: 'proj-s' })
    expect(second.existingActiveSessions).toEqual([])
  })
})

describe('checkpointSession', () => {
  it('happy path: sets checkpoint + checkpointAt, session stays active', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const r = svc.checkpointSession(started.session.id, {
      checkpoint: { resumePoint: 'mid-refactor', dirtyFiles: ['src/a.ts'] }
    })

    expect(r.session.status).toBe('active')
    expect(r.session.checkpoint?.resumePoint).toBe('mid-refactor')
    expect(r.session.checkpoint?.dirtyFiles).toEqual(['src/a.ts'])
    expect(r.session.checkpointAt).not.toBeNull()
  })

  it('overwrite on second call, checkpointAt bumps', async () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const r1 = svc.checkpointSession(started.session.id, {
      checkpoint: { resumePoint: 'first', notes: 'n1' }
    })
    // tick so the timestamp second differs — SQLite datetime('now') has second granularity
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const r2 = svc.checkpointSession(started.session.id, {
      checkpoint: { resumePoint: 'second' }
    })

    expect(r2.session.checkpoint?.resumePoint).toBe('second')
    expect(r2.session.checkpoint?.notes).toBeUndefined()
    expect(r2.session.checkpointAt).not.toBe(r1.session.checkpointAt)
  })

  it('throws SessionNotFoundError on missing id', () => {
    expect(() =>
      svc.checkpointSession('SESSION-999', { checkpoint: { resumePoint: 'r' } })
    ).toThrowError(SessionNotFoundError)
  })

  it('throws SessionStatusError on completed session', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })
    expect(() =>
      svc.checkpointSession(started.session.id, { checkpoint: { resumePoint: 'r' } })
    ).toThrowError(SessionStatusError)
  })
})

describe('resumeSession', () => {
  it('returns session + null checkpoint + linked conversations + context sources', () => {
    svc.createContextSource({
      projectId: 'proj-s',
      sourceType: 'file',
      sourcePath: 'docs/ctx.md',
      label: 'Ctx',
      category: 'what'
    })
    const started = svc.startSession({ projectId: 'proj-s' })

    const r = svc.resumeSession(started.session.id)
    expect(r.session.id).toBe(started.session.id)
    expect(r.checkpoint).toBeNull()
    expect(r.conversations.map((c) => c.id)).toEqual([started.conversationId])
    expect(r.contextSources.map((c) => c.label)).toEqual(['Ctx'])
  })

  it('returns checkpoint when one exists', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.checkpointSession(started.session.id, {
      checkpoint: { resumePoint: 'pause', lastCommit: 'abc123' }
    })

    const r = svc.resumeSession(started.session.id)
    expect(r.checkpoint?.resumePoint).toBe('pause')
    expect(r.checkpoint?.lastCommit).toBe('abc123')
  })

  it('works on completed sessions (read-only replay)', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    svc.endSession(started.session.id, { handoff: { resumePoint: 'r' } })

    const r = svc.resumeSession(started.session.id)
    expect(r.session.status).toBe('completed')
  })

  it('throws SessionNotFoundError on missing id', () => {
    expect(() => svc.resumeSession('SESSION-999')).toThrowError(SessionNotFoundError)
  })
})

describe('transaction rollback (atomicity)', () => {
  it('rolls back session creation when auto-conv link fails mid-start', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).sessionLifecycle
    const orig = lifecycle.conversations.link.bind(lifecycle.conversations)
    lifecycle.conversations.link = () => {
      throw new Error('simulated link failure')
    }

    expect(() => svc.startSession({ projectId: 'proj-s' })).toThrow('simulated link failure')

    lifecycle.conversations.link = orig

    expect(svc.findSessions('proj-s')).toHaveLength(0)
    expect(svc.findConversations('proj-s')).toHaveLength(0)
  })

  it('rolls back session status + conv close when task update fails mid-end', () => {
    const started = svc.startSession({ projectId: 'proj-s' })
    const task = svc.createTask({ projectId: 'proj-s', title: 'Y' })
    svc.updateSession(started.session.id, { taskId: task.id })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).sessionLifecycle
    const orig = lifecycle.tasks.update.bind(lifecycle.tasks)
    lifecycle.tasks.update = () => {
      throw new Error('simulated task failure')
    }

    expect(() => svc.endSession(started.session.id, { handoff: { resumePoint: 'x' } })).toThrow(
      'simulated task failure'
    )

    lifecycle.tasks.update = orig

    expect(svc.getSession(started.session.id)?.status).toBe('active')
    expect(svc.getConversation(started.conversationId)?.status).toBe('open')
    expect(svc.getTask(task.id)?.status).not.toBe('DONE')
  })
})
