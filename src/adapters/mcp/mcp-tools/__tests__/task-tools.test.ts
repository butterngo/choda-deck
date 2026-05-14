import { describe, it, expect, vi } from 'vitest'
import * as taskTools from '../task-tools'
import { defaultBody } from '../task-tools'
import type { InstrumentedServer } from '../../instrumented-server'
import type { Task, TaskStatus, UpdateTaskInput } from '../../../../core/domain/task-types'

describe('defaultBody template', () => {
  it('contains the 4 canonical sections', () => {
    const body = defaultBody('TASK-001', 'Example')
    expect(body).toContain('## Context')
    expect(body).toContain('## Acceptance')
    expect(body).toContain('## Test Plan')
    expect(body).toContain('## Related')
  })

  it('does NOT include removed legacy sections', () => {
    const body = defaultBody('TASK-001', 'Example')
    expect(body).not.toContain('## Why')
    expect(body).not.toContain('## Acceptance criteria')
    expect(body).not.toContain('## Scope')
    expect(body).not.toContain('## Out of scope')
    expect(body).not.toContain('## Notes')
  })

  it('interpolates id + title into H1', () => {
    const body = defaultBody('TASK-042', 'Wire feature X')
    expect(body).toMatch(/^# TASK-042: Wire feature X\n/)
  })

  it('seeds Acceptance with an empty checkbox for the first criterion', () => {
    const body = defaultBody('TASK-001', 'x')
    expect(body).toContain('## Acceptance\n\n- [ ]')
  })
})

interface CapturedTool {
  name: string
  cb: (args: unknown) => Promise<unknown>
}

function makeFakeServer(): { server: InstrumentedServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = []
  const server: InstrumentedServer = {
    registerTool: vi.fn(
      (name: string, _config: unknown, cb: (args: unknown) => Promise<unknown>) => {
        tools.push({ name, cb })
        return { name } as never
      }
    ) as unknown as InstrumentedServer['registerTool'],
    get registeredToolNames(): ReadonlyArray<string> {
      return []
    }
  }
  return { server, tools }
}

function makeTask(status: TaskStatus, overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-1',
    projectId: 'proj',
    parentTaskId: null,
    title: 'orig title',
    status,
    priority: 'medium',
    labels: [],
    dueDate: null,
    pinned: false,
    filePath: null,
    body: 'orig body',
    blockedBy: [],
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
    ...overrides
  }
}

function makeFakeSvc(task: Task): {
  svc: Parameters<typeof taskTools.register>[1]
  updateCalls: Array<{ id: string; input: UpdateTaskInput }>
} {
  const updateCalls: Array<{ id: string; input: UpdateTaskInput }> = []
  const svc = {
    getTask: (id: string): Task | null => (id === task.id ? task : null),
    updateTask: (id: string, input: UpdateTaskInput): Task => {
      updateCalls.push({ id, input })
      return { ...task, ...(input as Partial<Task>) }
    }
  } as unknown as Parameters<typeof taskTools.register>[1]
  return { svc, updateCalls }
}

function getTaskUpdate(tools: CapturedTool[]): CapturedTool {
  const t = tools.find((x) => x.name === 'task_update')
  if (!t) throw new Error('task_update not registered')
  return t
}

describe('task_update body/title lock', () => {
  describe('body update', () => {
    it.each(['TODO', 'READY'] as const)('allows body update when status=%s', async (status) => {
      const { server, tools } = makeFakeServer()
      const { svc, updateCalls } = makeFakeSvc(makeTask(status))
      taskTools.register(server, svc)

      await getTaskUpdate(tools).cb({ id: 'TASK-1', body: 'new body' })

      expect(updateCalls).toHaveLength(1)
      expect(updateCalls[0].input.body).toBe('new body')
    })

    it.each(['IN-PROGRESS', 'DONE', 'CANCELLED'] as const)(
      'rejects body update when status=%s',
      async (status) => {
        const { server, tools } = makeFakeServer()
        const { svc, updateCalls } = makeFakeSvc(makeTask(status))
        taskTools.register(server, svc)

        await expect(
          getTaskUpdate(tools).cb({ id: 'TASK-1', body: 'new body' })
        ).rejects.toThrow(/cannot update body when status=/)
        expect(updateCalls).toHaveLength(0)
      }
    )

    it('rejects body=null when locked (null still mutates content)', async () => {
      const { server, tools } = makeFakeServer()
      const { svc, updateCalls } = makeFakeSvc(makeTask('IN-PROGRESS'))
      taskTools.register(server, svc)

      await expect(
        getTaskUpdate(tools).cb({ id: 'TASK-1', body: null })
      ).rejects.toThrow(/cannot update body/)
      expect(updateCalls).toHaveLength(0)
    })
  })

  describe('title update', () => {
    it.each(['TODO', 'READY'] as const)('allows title update when status=%s', async (status) => {
      const { server, tools } = makeFakeServer()
      const { svc, updateCalls } = makeFakeSvc(makeTask(status))
      taskTools.register(server, svc)

      await getTaskUpdate(tools).cb({ id: 'TASK-1', title: 'new title' })

      expect(updateCalls).toHaveLength(1)
      expect(updateCalls[0].input.title).toBe('new title')
    })

    it.each(['IN-PROGRESS', 'DONE', 'CANCELLED'] as const)(
      'rejects title update when status=%s',
      async (status) => {
        const { server, tools } = makeFakeServer()
        const { svc, updateCalls } = makeFakeSvc(makeTask(status))
        taskTools.register(server, svc)

        await expect(
          getTaskUpdate(tools).cb({ id: 'TASK-1', title: 'new title' })
        ).rejects.toThrow(/cannot update title when status=/)
        expect(updateCalls).toHaveLength(0)
      }
    )
  })

  describe('body + title combined', () => {
    it('reports body/title in error when both fields are touched and locked', async () => {
      const { server, tools } = makeFakeServer()
      const { svc, updateCalls } = makeFakeSvc(makeTask('IN-PROGRESS'))
      taskTools.register(server, svc)

      await expect(
        getTaskUpdate(tools).cb({ id: 'TASK-1', body: 'b', title: 't' })
      ).rejects.toThrow(/cannot update body\/title when status=IN-PROGRESS/)
      expect(updateCalls).toHaveLength(0)
    })
  })

  describe('other fields stay editable at every status', () => {
    const allStatuses = ['TODO', 'READY', 'IN-PROGRESS', 'DONE', 'CANCELLED'] as const

    it.each(allStatuses)('status field updates OK from %s', async (status) => {
      const { server, tools } = makeFakeServer()
      const { svc, updateCalls } = makeFakeSvc(makeTask(status))
      taskTools.register(server, svc)

      await getTaskUpdate(tools).cb({ id: 'TASK-1', status: 'READY' })

      expect(updateCalls).toHaveLength(1)
    })

    it.each(allStatuses)('labels/priority/pinned update OK at status=%s', async (status) => {
      const { server, tools } = makeFakeServer()
      const { svc, updateCalls } = makeFakeSvc(makeTask(status))
      taskTools.register(server, svc)

      await getTaskUpdate(tools).cb({
        id: 'TASK-1',
        labels: ['x'],
        priority: 'high',
        pinned: true
      })

      expect(updateCalls).toHaveLength(1)
      expect(updateCalls[0].input.labels).toEqual(['x'])
      expect(updateCalls[0].input.priority).toBe('high')
      expect(updateCalls[0].input.pinned).toBe(true)
    })

    it.each(allStatuses)(
      'dueDate/blockedBy/parentTaskId update OK at status=%s',
      async (status) => {
        const { server, tools } = makeFakeServer()
        const { svc, updateCalls } = makeFakeSvc(makeTask(status))
        taskTools.register(server, svc)

        await getTaskUpdate(tools).cb({
          id: 'TASK-1',
          dueDate: '2026-12-01',
          blockedBy: ['TASK-2'],
          parentTaskId: 'TASK-PARENT'
        })

        expect(updateCalls).toHaveLength(1)
      }
    )
  })

  describe('error message format', () => {
    it('includes reason + workaround hint', async () => {
      const { server, tools } = makeFakeServer()
      const { svc } = makeFakeSvc(makeTask('IN-PROGRESS'))
      taskTools.register(server, svc)

      await expect(
        getTaskUpdate(tools).cb({ id: 'TASK-1', body: 'x' })
      ).rejects.toThrow(/silent spec drift/)
      await expect(
        getTaskUpdate(tools).cb({ id: 'TASK-1', body: 'x' })
      ).rejects.toThrow(/reset status to TODO or READY/)
    })
  })

  describe('missing task', () => {
    it('skips lock check when task does not exist (delegates to updateTask)', async () => {
      const { server, tools } = makeFakeServer()
      const { svc } = makeFakeSvc(makeTask('IN-PROGRESS', { id: 'OTHER' }))
      taskTools.register(server, svc)

      await expect(
        getTaskUpdate(tools).cb({ id: 'NOT-FOUND', body: 'x' })
      ).resolves.toBeDefined()
    })
  })
})
