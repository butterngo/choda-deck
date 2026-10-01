// TASK-2247 — inbox_convert refuses a body that does not follow the task
// template, through the real tool handler over a SqliteTaskService.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteTaskService } from '../../../../core/domain/sqlite-task-service'
import type { InstrumentedServer } from '../../instrumented-server'
import * as taskTools from '../task-tools'
import * as inboxTools from '../inbox-tools'

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>

const CONTEXT = '## Context\n\nwhy\n\n'
const ACCEPTANCE = '## Acceptance\n\n- [ ] the draft converts\n\n'
const TEST_PLAN = '## Test Plan\n\n- unit\n\n'
const RELATED = '## Related\n\n- TASK-2241\n'

let svc: SqliteTaskService
const handlers = new Map<string, Handler>()

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const handler = handlers.get(name)
  if (!handler) throw new Error(`tool ${name} not registered`)
  return (await handler(args)).content[0].text
}

async function taskCount(): Promise<number> {
  return (await svc.findTasks({})).length
}

beforeEach(() => {
  svc = new SqliteTaskService(':memory:')
  handlers.clear()
  const server = {
    registerTool: (name: string, _def: unknown, handler: Handler) => handlers.set(name, handler),
    get registeredToolNames(): ReadonlyArray<string> {
      return [...handlers.keys()]
    }
  } as unknown as InstrumentedServer
  taskTools.register(server, svc)
  inboxTools.register(server, svc)
})
afterEach(() => svc.close())

describe('TASK-2247 — template guard on inbox_convert', () => {
  it('AC-1: a body without ## Test Plan is refused by name; no task, draft unchanged', async () => {
    const item = await svc.createInbox({ projectId: 'p', content: 'draft' })
    const before = await taskCount()
    const reply = await call('inbox_convert', { id: item.id, title: 't', body: CONTEXT + ACCEPTANCE + RELATED })
    expect(reply).toContain('## Test Plan')
    expect(reply).toContain('does not follow the task template')
    expect(await taskCount()).toBe(before)
    expect((await svc.getInbox(item.id))?.status).toBe('raw')
  })

  it('AC-2: all four headings but no checkbox under ## Acceptance is refused; no task', async () => {
    const item = await svc.createInbox({ projectId: 'p', content: 'draft' })
    const body = CONTEXT + '## Acceptance\n\nprose only, no checkbox\n\n' + TEST_PLAN + RELATED
    const reply = await call('inbox_convert', { id: item.id, title: 't', body })
    expect(reply).toContain('empty ## Acceptance section')
    expect(await taskCount()).toBe(0)
    expect((await svc.getInbox(item.id))?.status).toBe('raw')
  })

  it('AC-3: only the blank "- [ ]" placeholder is refused like AC-2', async () => {
    const item = await svc.createInbox({ projectId: 'p', content: 'draft' })
    for (const placeholder of ['- [ ]', '- [ ] ']) {
      const body = CONTEXT + `## Acceptance\n\n${placeholder}\n\n` + TEST_PLAN + RELATED
      const reply = await call('inbox_convert', { id: item.id, title: 't', body })
      expect(reply).toContain('empty ## Acceptance section')
    }
    expect(await taskCount()).toBe(0)
  })

  it('AC-4: a conforming body converts and marks the draft converted', async () => {
    const item = await svc.createInbox({ projectId: 'p', content: 'draft' })
    const reply = JSON.parse(
      await call('inbox_convert', { id: item.id, title: 't', body: CONTEXT + ACCEPTANCE + TEST_PLAN + RELATED })
    ) as { taskId: string }
    expect(reply.taskId).toMatch(/^TASK-/)
    expect((await svc.getInbox(item.id))?.status).toBe('converted')
  })

  it('a conversion with no body at all is refused (the task would have no template)', async () => {
    const item = await svc.createInbox({ projectId: 'p', content: 'draft' })
    const reply = await call('inbox_convert', { id: item.id, title: 't' })
    expect(reply).toContain('does not follow the task template')
    expect(await taskCount()).toBe(0)
  })

  it('AC-5: task_create with no body still gets defaultBody and succeeds', async () => {
    const created = JSON.parse(await call('task_create', { projectId: 'p', title: 'plain task' })) as {
      id: string
      body: string
    }
    expect(created.id).toMatch(/^TASK-/)
    expect(created.body).toContain('## Acceptance')
    expect(created.body).toContain('## Test Plan')
  })
})
