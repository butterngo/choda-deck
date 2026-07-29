// Unit test for the GET /tasks/:id task-detail route handler.

import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'http'
import { handleTaskDetailRoute } from './task-detail'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import type { Task } from '../../core/domain/task-types'

interface Captured {
  status: number
  body: unknown
}

function fakeRes(cap: Captured): ServerResponse {
  return {
    writeHead(status: number) {
      cap.status = status
      return this
    },
    end(payload?: string) {
      cap.body = payload ? JSON.parse(payload) : undefined
      return this
    }
  } as unknown as ServerResponse
}

function req(url: string, method = 'GET'): IncomingMessage {
  return { url, method } as IncomingMessage
}

const task: Task = {
  id: 'TASK-1',
  projectId: 'p1',
  parentTaskId: null,
  title: 'graph view',
  status: 'IMPLEMENTED',
  priority: 'medium',
  labels: ['companion'],
  dueDate: null,
  pinned: false,
  filePath: null,
  body: '## Context\nbody here\n## Acceptance\n- [ ] AC-1',
  blockedBy: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

function fakeSvc(): BackendTaskService {
  return {
    getTask: async (id: string) => (id === 'TASK-1' ? task : null)
  } as unknown as BackendTaskService
}

describe('handleTaskDetailRoute', () => {
  it('returns false for a non-task path', async () => {
    const cap = {} as Captured
    expect(await handleTaskDetailRoute(req('/knowledge/x'), fakeRes(cap), fakeSvc())).toBe(false)
  })

  it('returns false for POST (leaves /tasks/:id/ready to workflow.ts)', async () => {
    const cap = {} as Captured
    expect(await handleTaskDetailRoute(req('/tasks/TASK-1', 'POST'), fakeRes(cap), fakeSvc())).toBe(false)
  })

  it('returns the full task on GET /tasks/:id', async () => {
    const cap = {} as Captured
    await handleTaskDetailRoute(req('/tasks/TASK-1'), fakeRes(cap), fakeSvc())
    expect(cap.status).toBe(200)
    expect((cap.body as Task).body).toMatch(/Acceptance/)
  })

  it('404s an unknown task', async () => {
    const cap = {} as Captured
    await handleTaskDetailRoute(req('/tasks/TASK-999'), fakeRes(cap), fakeSvc())
    expect(cap.status).toBe(404)
  })
})
