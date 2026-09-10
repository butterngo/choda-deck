// TASK-1773 — the tests are split deliberately.
//
// The unit tests below pin the parsing and the cascade. They are NOT sufficient
// on their own: TASK-1748 shipped a GET /tasks/:id that 500'd for every single
// task while sixteen unit tests stayed green, because all sixteen stubbed the
// service and none went through the router. So the second half of this file
// starts the real server and talks to it over HTTP.
//
// The route tests also assert what findTasks was CALLED WITH. A route that
// accepts `?projectId=` and then quietly discards it returns a 200 and a
// plausible list — indistinguishable from a working filter unless you look at
// the call. That is the exact defect this task exists to remove, so it gets an
// assertion rather than trust.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import type { Task, TaskFilter } from '../../core/domain/task-types'
import { parseTaskListQuery, toTaskListRow, scopeTasksToWorkspace } from './task-list'

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    projectId: 'choda-deck',
    parentTaskId: null,
    title: `title of ${id}`,
    status: 'TODO',
    priority: 'high',
    labels: [],
    dueDate: null,
    pinned: false,
    filePath: null,
    body: 'x'.repeat(2800), // the ~2.8 KB average that made the old response 4 MB
    blockedBy: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

describe('parseTaskListQuery — reject rather than ignore', () => {
  it('reads projectId, status and limit into the filter', () => {
    const parsed = parseTaskListQuery(
      new URLSearchParams('projectId=choda-deck&status=READY&limit=5')
    )
    expect(parsed).toEqual({
      filter: { projectId: 'choda-deck', status: 'READY', limit: 5 },
      workspaceId: null
    })
  })

  it('rejects an unknown status instead of dropping it', () => {
    // Dropping it is the old behaviour: the caller gets every status back and
    // reads that as "my filter matched everything".
    expect(parseTaskListQuery(new URLSearchParams('status=ALMOST-DONE'))).toEqual({
      error: expect.stringContaining('unknown status "ALMOST-DONE"')
    })
  })

  it('rejects a limit that is not a positive integer', () => {
    expect(parseTaskListQuery(new URLSearchParams('limit=abc'))).toHaveProperty('error')
    expect(parseTaskListQuery(new URLSearchParams('limit=0'))).toHaveProperty('error')
    expect(parseTaskListQuery(new URLSearchParams('limit=-3'))).toHaveProperty('error')
  })

  it('rejects an empty projectId or workspaceId', () => {
    expect(parseTaskListQuery(new URLSearchParams('projectId='))).toHaveProperty('error')
    expect(parseTaskListQuery(new URLSearchParams('workspaceId='))).toHaveProperty('error')
  })

  // CONTROL — with no parameters the parse must succeed and filter nothing, or
  // the "reject" tests above would pass on a function that rejects everything.
  it('CONTROL — no parameters is a valid, empty filter', () => {
    expect(parseTaskListQuery(new URLSearchParams(''))).toEqual({ filter: {}, workspaceId: null })
  })
})

describe('toTaskListRow', () => {
  it('omits body, which was nearly the whole payload', () => {
    const row = toTaskListRow(task('TASK-1'))
    expect(row).not.toHaveProperty('body')
    // CONTROL — the field it strips really was present on the input, otherwise
    // this asserts nothing about stripping.
    expect(task('TASK-1').body).toHaveLength(2800)
  })

  it('keeps what a list actually renders', () => {
    const row = toTaskListRow(task('TASK-1', { status: 'READY', labels: ['ui'] }))
    expect(row).toMatchObject({ id: 'TASK-1', title: 'title of TASK-1', status: 'READY', labels: ['ui'] })
  })
})

describe('scopeTasksToWorkspace — the §5.3 cascade', () => {
  const svc = {
    listCodeRefsByPrefix: async () => [
      { slug: 'ref-mine', projectId: 'choda-deck', workspaceId: 'w1', path: 'src/a.ts' },
      { slug: 'ref-theirs', projectId: 'choda-deck', workspaceId: 'w2', path: 'src/b.ts' }
    ],
    getTouchesForCodeRef: async (slug: string) =>
      slug === 'ref-mine'
        ? [{ taskId: 'TASK-TOUCHES', codeRefSlug: slug, relation: 'modifies' }]
        : [{ taskId: 'TASK-OTHER-WS', codeRefSlug: slug, relation: 'modifies' }],
    findSessions: async () => [
      { id: 'S1', workspaceId: 'w1', taskId: 'TASK-SESSION' },
      { id: 'S2', workspaceId: 'w1', taskId: 'TASK-TOUCHES' }, // already claimed by touches
      { id: 'S3', workspaceId: 'w2', taskId: 'TASK-OTHER-WS' },
      { id: 'S4', workspaceId: 'w1', taskId: null } // a session bound to no task
    ]
  } as unknown as BackendTaskService

  it('claims a task whose code_ref belongs to this workspace', async () => {
    const scopes = await scopeTasksToWorkspace(svc, 'choda-deck', 'w1')
    expect(scopes.get('TASK-TOUCHES')).toBe('touches')
  })

  it('falls back to a session when touches says nothing', async () => {
    const scopes = await scopeTasksToWorkspace(svc, 'choda-deck', 'w1')
    expect(scopes.get('TASK-SESSION')).toBe('session')
  })

  it('lets touches win over a session for the same task — code beats seating', async () => {
    const scopes = await scopeTasksToWorkspace(svc, 'choda-deck', 'w1')
    expect(scopes.get('TASK-TOUCHES')).toBe('touches')
  })

  // CONTROL — without this the cascade could return 'touches' for everything and
  // all three tests above would still pass.
  it("CONTROL — another workspace's code_ref and session claim nothing here", async () => {
    const scopes = await scopeTasksToWorkspace(svc, 'choda-deck', 'w1')
    expect(scopes.has('TASK-OTHER-WS')).toBe(false)
  })

  it('survives a session bound to no task', async () => {
    const scopes = await scopeTasksToWorkspace(svc, 'choda-deck', 'w1')
    expect([...scopes.keys()]).not.toContain(null)
  })
})

// ---------------------------------------------------------------------------
// Route level. Everything above stubs the service; none of it would notice the
// route forgetting to pass the parsed filter through.
// ---------------------------------------------------------------------------

describe('GET /tasks over the real server', () => {
  let handle: CompanionServerHandle
  let base: string
  let db: Database.Database
  const seen: TaskFilter[] = []

  const ALL = [
    task('TASK-TOUCHES'),
    task('TASK-SESSION'),
    task('TASK-LONELY'),
    task('TASK-ELSEWHERE', { projectId: 'other-project' })
  ]

  const svc = {
    listProjects: async () => [{ id: 'choda-deck' }, { id: 'other-project' }],
    findWorkspaces: async (projectId: string) =>
      projectId === 'choda-deck'
        ? [{ id: 'w1', projectId, label: 'Main', cwd: 'C:/x', archivedAt: null }]
        : [],
    findTasks: async (filter: TaskFilter) => {
      seen.push(filter)
      let rows = ALL
      if (filter.projectId !== undefined) rows = rows.filter((t) => t.projectId === filter.projectId)
      if (filter.status !== undefined) rows = rows.filter((t) => t.status === filter.status)
      return rows
    },
    listCodeRefsByPrefix: async () => [
      { slug: 'ref-mine', projectId: 'choda-deck', workspaceId: 'w1', path: 'src/a.ts' }
    ],
    getTouchesForCodeRef: async () => [
      { taskId: 'TASK-TOUCHES', codeRefSlug: 'ref-mine', relation: 'modifies' }
    ],
    findSessions: async () => [{ id: 'S1', workspaceId: 'w1', taskId: 'TASK-SESSION' }]
  } as unknown as BackendTaskService

  beforeAll(async () => {
    db = new Database(':memory:')
    const services: CompanionServices = {
      svc,
      db,
      dbPath: ':memory:',
      intervalMs: 30000,
      bridgeToken: 'test-token',
      pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
      push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
      close: () => db.close()
    } as unknown as CompanionServices
    handle = await startCompanionServer(services, 0)
    base = `http://${COMPANION_BIND}:${handle.address.port}`
  })

  afterAll(async () => {
    await handle.close()
  })

  it('passes projectId THROUGH to findTasks, and returns fewer rows for it', async () => {
    seen.length = 0
    const unfiltered = await (await fetch(`${base}/tasks`)).json()
    const filtered = await (await fetch(`${base}/tasks?projectId=choda-deck`)).json()

    // The assertion that would have caught the original bug: not "did it 200",
    // but "did the filter reach the query".
    expect(seen[1]).toEqual({ projectId: 'choda-deck' })
    expect(filtered.tasks.length).toBeLessThan(unfiltered.tasks.length)
    expect(filtered.tasks.every((t: { projectId: string }) => t.projectId === 'choda-deck')).toBe(true)
  })

  it('answers an unusable filter with 400, never the unfiltered table', async () => {
    const res = await fetch(`${base}/tasks?status=ALMOST-DONE`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).not.toHaveProperty('tasks')
  })

  it('serves no bodies, and is far smaller for it', async () => {
    const res = await fetch(`${base}/tasks`)
    const text = await res.text()
    expect(text).not.toContain('"body"')
    // Same rows, same database, with and without: the size claim is measured
    // rather than asserted from the shape.
    const withBodies = JSON.stringify({ tasks: ALL }).length
    expect(text.length).toBeLessThan(withBodies / 4)
  })

  it('rejects an unregistered workspace instead of calling it empty', async () => {
    const res = await fetch(`${base}/tasks?workspaceId=nope`)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('nope')
  })

  it('marks all three buckets, and drops none of them', async () => {
    const { tasks } = await (await fetch(`${base}/tasks?workspaceId=w1`)).json()
    const byId = Object.fromEntries(tasks.map((t: { id: string; scope: string }) => [t.id, t.scope]))

    expect(byId['TASK-TOUCHES']).toBe('touches')
    expect(byId['TASK-SESSION']).toBe('session')
    expect(byId['TASK-LONELY']).toBe('unscoped')
    // The rule the whole task hangs on: a task matching neither arm is still
    // in the response, flagged. Dropping it would make the list read as a
    // complete answer while hiding work.
    expect(Object.keys(byId)).toContain('TASK-LONELY')
  })

  it('does not annotate when no workspace was asked about', async () => {
    const { tasks } = await (await fetch(`${base}/tasks`)).json()
    expect(tasks.every((t: { scope?: string }) => t.scope === undefined)).toBe(true)
  })
})
