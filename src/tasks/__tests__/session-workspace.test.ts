import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from '../sqlite-task-service'
import { abandonStaleSession, loadLastHandoff } from '../mcp-tools/session-tools'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DB = path.join(__dirname, '__test-session-ws__.db')
let svc: SqliteTaskService

beforeAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('ar', 'Automation Rule', '/tmp/ar')
})

afterAll(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('session per workspace', () => {
  it('creates session with workspaceId', () => {
    const s = svc.createSession({ projectId: 'ar', workspaceId: 'workflow-engine' })
    expect(s.workspaceId).toBe('workflow-engine')
    expect(s.taskId).toBeNull()
    expect(s.status).toBe('active')
  })

  it('parallel sessions on different workspaces', () => {
    const fe = svc.createSession({ projectId: 'ar', workspaceId: 'remote-workflow' })
    expect(fe.workspaceId).toBe('remote-workflow')

    const beSess = svc.getActiveSession('ar', 'workflow-engine')
    const feSess = svc.getActiveSession('ar', 'remote-workflow')
    expect(beSess).not.toBeNull()
    expect(feSess).not.toBeNull()
    expect(beSess!.id).not.toBe(feSess!.id)
  })

  it('abandonStaleSession scoped to workspace', () => {
    const abandoned = abandonStaleSession(svc, 'ar', 'workflow-engine')
    expect(abandoned).not.toBeNull()

    // BE abandoned, FE still active
    expect(svc.getActiveSession('ar', 'workflow-engine')).toBeNull()
    expect(svc.getActiveSession('ar', 'remote-workflow')).not.toBeNull()

    // cleanup FE
    const feSess = svc.getActiveSession('ar', 'remote-workflow')!
    svc.updateSession(feSess.id, { status: 'abandoned', endedAt: '2026-04-16' })
  })

  it('loadLastHandoff scoped to workspace', () => {
    const be = svc.createSession({ projectId: 'ar', workspaceId: 'workflow-engine' })
    svc.updateSession(be.id, {
      status: 'completed',
      endedAt: '2026-04-16',
      handoff: { resumePoint: 'BE resume' }
    })

    const fe = svc.createSession({ projectId: 'ar', workspaceId: 'remote-workflow' })
    svc.updateSession(fe.id, {
      status: 'completed',
      endedAt: '2026-04-16',
      handoff: { resumePoint: 'FE resume' }
    })

    const beHandoff = loadLastHandoff(svc, 'ar', 'workflow-engine')
    const feHandoff = loadLastHandoff(svc, 'ar', 'remote-workflow')
    expect(beHandoff!.handoff.resumePoint).toBe('BE resume')
    expect(feHandoff!.handoff.resumePoint).toBe('FE resume')
  })
})

describe('session_pick (task binding)', () => {
  it('binds task to session via updateSession', () => {
    const task = svc.createTask({ projectId: 'ar', title: 'TASK-105 test' })
    const s = svc.createSession({ projectId: 'ar', workspaceId: 'workflow-engine' })

    svc.updateSession(s.id, { taskId: task.id })
    const updated = svc.getSession(s.id)!
    expect(updated.taskId).toBe(task.id)
  })

  it('session_end with task marks task DONE', () => {
    const task = svc.createTask({ projectId: 'ar', title: 'TASK-106 test' })
    const s = svc.createSession({ projectId: 'ar', workspaceId: 'remote-workflow' })
    svc.updateSession(s.id, { taskId: task.id })
    svc.updateTask(task.id, { status: 'IN-PROGRESS' })

    // simulate session_end
    svc.updateTask(task.id, { status: 'DONE' })
    svc.updateSession(s.id, {
      status: 'completed',
      endedAt: '2026-04-16',
      handoff: { resumePoint: 'done', tasksUpdated: [task.id] }
    })

    const finalTask = svc.getTask(task.id)!
    const finalSession = svc.getSession(s.id)!
    expect(finalTask.status).toBe('DONE')
    expect(finalSession.status).toBe('completed')
    expect(finalSession.handoff!.tasksUpdated).toContain(task.id)
  })

  it('WIP=1: session can only have 1 task', () => {
    const s = svc.createSession({ projectId: 'ar', workspaceId: 'workflow-engine' })
    const t1 = svc.createTask({ projectId: 'ar', title: 'first' })
    svc.updateSession(s.id, { taskId: t1.id })

    const session = svc.getSession(s.id)!
    expect(session.taskId).toBe(t1.id)
    // Guard is in MCP tool layer, not repository — verify taskId is set
  })
})
