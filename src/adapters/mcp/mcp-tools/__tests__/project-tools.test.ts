import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SqliteTaskService } from '../../../../core/domain/sqlite-task-service'
import * as projectTools from '../project-tools'
import type { InstrumentedServer } from '../../instrumented-server'

// TASK-2200 — project_add org, project_list org filter, project_remove.

type ToolCb = (args: Record<string, unknown>) => Promise<unknown>

function makeFakeServer(): { server: InstrumentedServer; tools: Map<string, ToolCb> } {
  const tools = new Map<string, ToolCb>()
  const server: InstrumentedServer = {
    registerTool: vi.fn((name: string, _config: unknown, cb: ToolCb) => {
      tools.set(name, cb)
      return { name } as never
    }) as unknown as InstrumentedServer['registerTool'],
    get registeredToolNames(): ReadonlyArray<string> {
      return [...tools.keys()]
    }
  }
  return { server, tools }
}

function text(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text
}

describe('project tools', () => {
  let svc: SqliteTaskService
  let call: (name: string, args: Record<string, unknown>) => Promise<string>

  beforeEach(() => {
    svc = new SqliteTaskService(':memory:')
    const { server, tools } = makeFakeServer()
    projectTools.register(server, svc)
    call = async (name, args) => text(await tools.get(name)!(args))
  })
  afterEach(() => svc.close())

  it('project_add stores org and project_list returns it on every project', async () => {
    await call('project_add', { id: 'hc', name: 'Headless CMS', cwd: '/hc', org: 'ichiba' })
    await call('project_add', { id: 'cd', name: 'Choda Deck', cwd: '/cd' })

    const all = JSON.parse(await call('project_list', {})) as Array<{ id: string; org: string | null }>
    expect(all.map((p) => [p.id, p.org])).toEqual([
      ['cd', null],
      ['hc', 'ichiba']
    ])
  })

  it('project_list with org returns that org only, excluding projects with no org', async () => {
    await call('project_add', { id: 'hc', name: 'Headless CMS', cwd: '/hc', org: 'ichiba' })
    await call('project_add', { id: 'mt', name: 'Mantu', cwd: '/mt', org: 'mantu' })
    await call('project_add', { id: 'cd', name: 'Choda Deck', cwd: '/cd' })

    const ichiba = JSON.parse(await call('project_list', { org: 'ichiba' })) as Array<{ id: string }>
    expect(ichiba.map((p) => p.id)).toEqual(['hc'])
  })

  it('project_add without org on an existing project keeps its org', async () => {
    await call('project_add', { id: 'hc', name: 'Headless CMS', cwd: '/hc', org: 'ichiba' })
    const again = JSON.parse(await call('project_add', { id: 'hc', name: 'Headless CMS', cwd: '/hc' }))
    expect(again.org).toBe('ichiba')
  })

  it('project_remove removes an empty project', async () => {
    await call('project_add', { id: 'tv', name: 'test vu', cwd: '/tv' })
    const out = JSON.parse(await call('project_remove', { id: 'tv' }))
    expect(out).toEqual({ id: 'tv', removed: true, workspacesRemoved: 0 })
    expect(await svc.getProject('tv')).toBeNull()
  })

  it('project_remove refuses a project with a task, says why, and deletes nothing', async () => {
    await call('project_add', { id: 'busy', name: 'Busy', cwd: '/busy' })
    await svc.createTask({ projectId: 'busy', title: 'still here' })

    const out = await call('project_remove', { id: 'busy' })

    expect(out).toContain('in use')
    expect(out).toContain('tasks: 1')
    expect(await svc.getProject('busy')).not.toBeNull()
  })
})
