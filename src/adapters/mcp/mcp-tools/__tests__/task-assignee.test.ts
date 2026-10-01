// TASK-2246 — tasks.assignee on SQLite, exercised through the real tool
// handlers (task_update / task_context / task_list / inbox_convert) over a
// SqliteTaskService.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteTaskService } from '../../../../core/domain/sqlite-task-service'
import type { InstrumentedServer } from '../../instrumented-server'
import * as taskTools from '../task-tools'
import * as inboxTools from '../inbox-tools'

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>

function capture(): { server: InstrumentedServer; call: (name: string, args: Record<string, unknown>) => Promise<unknown> } {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool: (name: string, _def: unknown, handler: Handler) => {
      handlers.set(name, handler)
    },
    get registeredToolNames(): ReadonlyArray<string> {
      return [...handlers.keys()]
    }
  } as unknown as InstrumentedServer
  return {
    server,
    call: async (name, args) => {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`tool ${name} not registered`)
      const text = (await handler(args)).content[0].text
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
  }
}

let svc: SqliteTaskService
let call: (name: string, args: Record<string, unknown>) => Promise<unknown>

beforeEach(() => {
  svc = new SqliteTaskService(':memory:')
  const c = capture()
  taskTools.register(c.server, svc)
  inboxTools.register(c.server, svc)
  call = c.call
})
afterEach(() => svc.close())

describe('TASK-2246 — task assignee (SQLite)', () => {
  it('AC-1: the SQLite tasks table has an assignee column', () => {
    const cols = (svc.syncDatabase.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('assignee')
  })

  it('AC-2: task_update with assignee "an" → task_context shows assignee "an"', async () => {
    const task = (await call('task_create', { projectId: 'p', title: 't' })) as { id: string }
    await call('task_update', { id: task.id, assignee: 'an' })
    const ctx = (await call('task_context', { id: task.id })) as { task: { assignee: string | null } }
    expect(ctx.task.assignee).toBe('an')
  })

  it('AC-3: task_update with assignee null clears it', async () => {
    const task = (await call('task_create', { projectId: 'p', title: 't', assignee: 'an' })) as { id: string }
    await call('task_update', { id: task.id, assignee: null })
    const ctx = (await call('task_context', { id: task.id })) as { task: { assignee: string | null } }
    expect(ctx.task.assignee).toBeNull()
  })

  it('AC-4: inbox_convert with assignee "an" creates a task assigned to "an"', async () => {
    const item = await svc.createInbox({ projectId: 'p', content: 'draft' })
    const body = '## Context\n\nx\n\n## Acceptance\n\n- [ ] it works\n\n## Test Plan\n\n- t\n\n## Related\n\n- r\n'
    const result = (await call('inbox_convert', { id: item.id, title: 'converted', body, assignee: 'an' })) as {
      task: { id: string; assignee: string | null }
    }
    expect(result.task.assignee).toBe('an')
    expect((await svc.getTask(result.task.id))?.assignee).toBe('an')
  })

  it('AC-5: task_list status TODO + assignee "an" returns only an’s TODO tasks', async () => {
    const mk = async (title: string, assignee?: string, status?: string): Promise<string> =>
      ((await call('task_create', { projectId: 'p', title, assignee, status })) as { id: string }).id
    const mine = await mk('mine', 'an')
    await mk('binh’s', 'binh')
    await mk('nobody’s')
    await mk('mine but done', 'an', 'CANCELLED')
    const listed = (await call('task_list', { status: 'TODO', assignee: 'an' })) as Array<{ id: string }>
    expect(listed.map((t) => t.id)).toEqual([mine])
  })

  it('without the filter task_list still returns every TODO task (unchanged behaviour)', async () => {
    await call('task_create', { projectId: 'p', title: 'a', assignee: 'an' })
    await call('task_create', { projectId: 'p', title: 'b' })
    const listed = (await call('task_list', { status: 'TODO' })) as unknown[]
    expect(listed).toHaveLength(2)
  })
})
