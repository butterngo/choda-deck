// TASK-1171 — unit: NOW/NEXT/DONE focus derivation. Integration: boot the
// adapter, read the focus feed, flip a task READY (the action round-trip, AC-5).

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { deriveFocus } from './workflow'
import { startCompanionServer, COMPANION_BIND } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import type { Session, Task } from '../../core/domain/task-types'
import { LEDGER_ENTITIES } from './sync-ledger'
import { ensureLoopStatusColumns } from '../../core/sync/sync-loop-status'
import { createSyncEventsTable } from '../../core/sync/sync-events'

const task = (id: string, status: string, priority: string | null = null): Task =>
  ({ id, projectId: 'p1', title: id, status, priority }) as unknown as Task

const session = (id: string, taskId: string | null): Session =>
  ({ id, projectId: 'p1', workspaceId: 'w1', taskId, status: 'active' }) as unknown as Session

describe('deriveFocus', () => {
  it('picks the active session task as focus over higher-priority in-progress', () => {
    const out = deriveFocus({
      activeSession: session('S1', 'TASK-2'),
      inProgress: [task('TASK-1', 'IN-PROGRESS', 'critical'), task('TASK-2', 'IN-PROGRESS', 'low')],
      ready: [],
      recentlyDone: []
    })
    expect(out.focusTask?.id).toBe('TASK-2')
  })

  it('falls back to highest-priority in-progress, then ready, then null', () => {
    expect(
      deriveFocus({
        activeSession: null,
        inProgress: [task('TASK-3', 'IN-PROGRESS', 'low'), task('TASK-4', 'IN-PROGRESS', 'high')],
        ready: [],
        recentlyDone: []
      }).focusTask?.id
    ).toBe('TASK-4')

    expect(
      deriveFocus({
        activeSession: null,
        inProgress: [],
        ready: [task('TASK-5', 'READY', 'medium')],
        recentlyDone: []
      }).focusTask?.id
    ).toBe('TASK-5')

    expect(
      deriveFocus({ activeSession: null, inProgress: [], ready: [], recentlyDone: [] }).focusTask
    ).toBeNull()
  })

  it('sorts NOW and NEXT buckets by priority', () => {
    const out = deriveFocus({
      activeSession: null,
      inProgress: [task('a', 'IN-PROGRESS', 'low'), task('b', 'IN-PROGRESS', 'critical')],
      ready: [task('c', 'READY', 'medium'), task('d', 'READY', 'high')],
      recentlyDone: [task('e', 'DONE')]
    })
    expect(out.now.map((t) => t.id)).toEqual(['b', 'a'])
    expect(out.next.map((t) => t.id)).toEqual(['d', 'c'])
    expect(out.done.map((t) => t.id)).toEqual(['e'])
  })
})

function fixtureDb(): Database.Database {
  const db = new Database(':memory:')
  for (const { table } of LEDGER_ENTITIES) {
    db.exec(
      `CREATE TABLE ${table} (id TEXT PRIMARY KEY, sync_origin TEXT, sync_updated_at INTEGER, sync_deleted_at INTEGER)`
    )
  }
  db.exec(
    `CREATE TABLE _sync_state (id INTEGER PRIMARY KEY CHECK (id = 0), last_pull_at INTEGER NOT NULL DEFAULT 0)`
  )
  db.exec('INSERT INTO _sync_state (id, last_pull_at) VALUES (0, 0)')
  ensureLoopStatusColumns(db)
  createSyncEventsTable(db)
  return db
}

// Stateful fake covering exactly the surface the workflow routes touch.
function fakeWorkflowSvc(): BackendTaskService {
  const tasks = new Map<string, Task>([
    ['TASK-10', task('TASK-10', 'TODO', 'high')],
    ['TASK-11', task('TASK-11', 'IN-PROGRESS', 'medium')],
    ['TASK-12', task('TASK-12', 'DONE')]
  ])
  const sessions = new Map<string, Session>([['S-1', session('S-1', 'TASK-11')]])
  return {
    getWorkspace: async (id: string) =>
      id === 'w1' ? { id: 'w1', projectId: 'p1', label: 'W', cwd: 'C:/x', archivedAt: null } : null,
    getActiveSession: async () => sessions.get('S-1') ?? null,
    findTasks: async (f: { status?: string }) =>
      [...tasks.values()].filter((t) => t.status === f.status),
    findSessions: async () => [...sessions.values()],
    getTask: async (id: string) => tasks.get(id) ?? null,
    updateTask: async (id: string, input: { status: string }) => {
      const t = { ...tasks.get(id)!, status: input.status } as Task
      tasks.set(id, t)
      return t
    },
    getSession: async (id: string) => sessions.get(id) ?? null,
    startSession: async (input: { projectId: string; taskId: string }) => ({
      session: session('S-2', input.taskId),
      contextSources: [],
      existingActiveSessions: [],
      recalledMemories: []
    }),
    endSession: async (id: string) => {
      const s = { ...sessions.get(id)!, status: 'completed' } as Session
      sessions.set(id, s)
      return {
        session: s,
        closedConversationIds: [],
        taskUpdated: null,
        memoryCandidates: [],
        selfEditPrompt: ''
      }
    }
  } as unknown as BackendTaskService
}

describe('workflow routes (integration)', () => {
  it('serves the focus feed and completes an action round-trip', async () => {
    const db = fixtureDb()
    const services: CompanionServices = {
      svc: fakeWorkflowSvc(),
      db,
      dbPath: ':memory:',
      intervalMs: 30000,
      bridgeToken: 'tok',
      pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
      push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
      close: () => db.close()
    }
    const handle = await startCompanionServer(services, 0)
    const base = `http://${COMPANION_BIND}:${handle.address.port}`
    try {
      // AC-1 — focus feed with buckets
      const focus = await (await fetch(`${base}/workflow/focus?workspaceId=w1`)).json()
      expect(focus.projectId).toBe('p1')
      expect(focus.activeSession.id).toBe('S-1')
      expect(focus.focusTask.id).toBe('TASK-11')
      expect(focus.now.map((t: Task) => t.id)).toEqual(['TASK-11'])
      expect(focus.done.map((t: Task) => t.id)).toEqual(['TASK-12'])
      expect((await fetch(`${base}/workflow/focus`)).status).toBe(400)

      // AC-2 — sessions incl. workspace scoping
      const sessionsRes = await (await fetch(`${base}/sessions?workspaceId=w1&status=active`)).json()
      expect(sessionsRes.sessions.map((s: Session) => s.id)).toEqual(['S-1'])
      expect((await fetch(`${base}/sessions?workspaceId=w1&status=bogus`)).status).toBe(400)

      // AC-3 — mark READY round-trip + idempotence + guard
      const ready = await fetch(`${base}/tasks/TASK-10/ready`, { method: 'POST' })
      expect(ready.status).toBe(200)
      expect((await ready.json()).task.status).toBe('READY')
      const again = await fetch(`${base}/tasks/TASK-10/ready`, { method: 'POST' })
      expect(again.status).toBe(200) // idempotent-safe
      expect((await fetch(`${base}/tasks/TASK-12/ready`, { method: 'POST' })).status).toBe(400)
      expect((await fetch(`${base}/tasks/NOPE/ready`, { method: 'POST' })).status).toBe(400)

      // AC-3 — session start + end
      const started = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'p1', workspaceId: 'w1', taskId: 'TASK-10' })
      })
      expect(started.status).toBe(200)
      expect((await started.json()).session.id).toBe('S-2')
      expect(
        (await fetch(`${base}/sessions`, { method: 'POST', body: '{}' })).status
      ).toBe(400)

      const ended = await fetch(`${base}/sessions/S-1/end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resumePoint: 'done from cockpit' })
      })
      expect(ended.status).toBe(200)
      expect((await ended.json()).session.status).toBe('completed')
      // no longer active → clear 400, not corruption
      expect((await fetch(`${base}/sessions/S-1/end`, { method: 'POST' })).status).toBe(400)
    } finally {
      await handle.close()
      db.close()
    }
  })
})
