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
    await call('project_add', { id: 'hc', name: 'Headless CMS', cwd: '/hc', org: 'ichiba', purpose: 'income' })
    await call('project_add', { id: 'cd', name: 'Choda Deck', cwd: '/cd', purpose: 'fun' })

    const all = JSON.parse(await call('project_list', {})) as Array<{ id: string; org: string | null }>
    expect(all.map((p) => [p.id, p.org])).toEqual([
      ['cd', null],
      ['hc', 'ichiba']
    ])
  })

  it('project_list with org returns that org only, excluding projects with no org', async () => {
    await call('project_add', { id: 'hc', name: 'Headless CMS', cwd: '/hc', org: 'ichiba', purpose: 'income' })
    await call('project_add', { id: 'mt', name: 'Mantu', cwd: '/mt', org: 'mantu', purpose: 'income' })
    await call('project_add', { id: 'cd', name: 'Choda Deck', cwd: '/cd', purpose: 'fun' })

    const ichiba = JSON.parse(await call('project_list', { org: 'ichiba' })) as Array<{ id: string }>
    expect(ichiba.map((p) => p.id)).toEqual(['hc'])
  })

  it('project_add without org on an existing project keeps its org', async () => {
    await call('project_add', { id: 'hc', name: 'Headless CMS', cwd: '/hc', org: 'ichiba', purpose: 'income' })
    const again = JSON.parse(await call('project_add', { id: 'hc', name: 'Headless CMS', cwd: '/hc' }))
    expect(again.org).toBe('ichiba')
  })

  it('project_remove removes an empty project', async () => {
    await call('project_add', { id: 'tv', name: 'test vu', cwd: '/tv', purpose: 'fun' })
    const out = JSON.parse(await call('project_remove', { id: 'tv' }))
    expect(out).toEqual({ id: 'tv', removed: true, workspacesRemoved: 0 })
    expect(await svc.getProject('tv')).toBeNull()
  })

  it('project_remove refuses a project with a task, says why, and deletes nothing', async () => {
    await call('project_add', { id: 'busy', name: 'Busy', cwd: '/busy', purpose: 'fun' })
    await svc.createTask({ projectId: 'busy', title: 'still here' })

    const out = await call('project_remove', { id: 'busy' })

    expect(out).toContain('in use')
    expect(out).toContain('tasks: 1')
    expect(await svc.getProject('busy')).not.toBeNull()
  })

  it('project_update changes cwd and keeps name + org', async () => {
    await call('project_add', { id: 'hc', name: 'Headless CMS', cwd: '/old', org: 'ichiba', purpose: 'reputation' })
    const out = JSON.parse(await call('project_update', { id: 'hc', cwd: '/definitely/missing' }))
    expect(out.project).toEqual({ id: 'hc', name: 'Headless CMS', cwd: '/definitely/missing', org: 'ichiba', purpose: 'reputation' })
    expect(out.warning).toContain('not found on disk')
    expect((await svc.getProject('hc'))?.cwd).toBe('/definitely/missing')
  })

  it('project_update refuses an unknown project and an empty patch', async () => {
    expect(JSON.parse(await call('project_update', { id: 'nope', cwd: '/x' })).ok).toBe(false)
    await call('project_add', { id: 'hc', name: 'Headless CMS', cwd: '/hc', purpose: 'fun' })
    expect(JSON.parse(await call('project_update', { id: 'hc' })).ok).toBe(false)
  })
})

// TASK-3128 — rule 4 of personal-operating-rules: every project says what it gives.
describe('project tools — purpose', () => {
  let svc: SqliteTaskService
  let call: (name: string, args: Record<string, unknown>) => Promise<string>

  beforeEach(() => {
    svc = new SqliteTaskService(':memory:')
    const { server, tools } = makeFakeServer()
    projectTools.register(server, svc)
    call = async (name, args) => text(await tools.get(name)!(args))
  })
  afterEach(() => svc.close())

  it('project_add without purpose on a new project errors naming purpose and its values, writing nothing', async () => {
    const out = JSON.parse(await call('project_add', { id: 'np', name: 'New', cwd: '/np' }))
    expect(out.ok).toBe(false)
    expect(out.error).toContain('purpose')
    expect(out.error).toContain('income | reputation | fun')
    expect(await svc.getProject('np')).toBeNull()
  })

  it('project_add with purpose "fame" is a validation error and writes nothing', async () => {
    const out = JSON.parse(
      await call('project_add', { id: 'np', name: 'New', cwd: '/np', purpose: 'fame' })
    )
    expect(out.ok).toBe(false)
    expect(out.error).toContain('"fame"')
    expect(await svc.getProject('np')).toBeNull()
  })

  it('project_add with purpose "fun" succeeds and project_list shows it', async () => {
    const added = JSON.parse(
      await call('project_add', { id: 'np', name: 'New', cwd: '/np', purpose: 'fun' })
    )
    expect(added.purpose).toBe('fun')
    const all = JSON.parse(await call('project_list', {})) as Array<{ id: string; purpose: string }>
    expect(all.find((p) => p.id === 'np')?.purpose).toBe('fun')
  })

  it('project_update sets purpose; an update without purpose leaves it unchanged', async () => {
    await call('project_add', { id: 'np', name: 'New', cwd: '/np', purpose: 'fun' })
    const set = JSON.parse(await call('project_update', { id: 'np', purpose: 'income' }))
    expect(set.project.purpose).toBe('income')
    const renamed = JSON.parse(await call('project_update', { id: 'np', name: 'Renamed' }))
    expect(renamed.project.purpose).toBe('income')
    expect((await svc.getProject('np'))?.purpose).toBe('income')
  })

  it('project_list missingPurpose returns only projects whose purpose is null', async () => {
    await call('project_add', { id: 'has', name: 'Has', cwd: '/has', purpose: 'reputation' })
    await svc.ensureProject('legacy', 'Legacy', '/legacy') // a pre-TASK-3128 project
    const missing = JSON.parse(await call('project_list', { missingPurpose: true })) as Array<{
      id: string
    }>
    expect(missing.map((p) => p.id)).toEqual(['legacy'])
  })
})
