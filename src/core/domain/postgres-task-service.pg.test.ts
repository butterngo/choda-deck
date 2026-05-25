import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../test/postgres-harness'
import { PostgresTaskService } from './postgres-task-service'
import { PostgresNotImplementedError } from './postgres-not-implemented-error'

describeIfDocker('PostgresTaskService facade (TASK-934 slice 11)', () => {
  let env: PgTestEnv
  let svc: PostgresTaskService

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    svc = new PostgresTaskService(env.conn)
    await svc.initializeAsync()
  }, 120_000)

  afterAll(async () => {
    // svc.close() ends the same pool as env.conn — stopPostgresTestEnv
    // tolerates a double-close, so order is fine either way.
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  it('initializeAsync runs migrations and is idempotent across calls', async () => {
    const existing = await env.conn.query<{ name: string }>('SELECT name FROM _migrations')
    expect(existing.rows.length).toBeGreaterThan(0)
    // Second call must not re-run or throw — backed by a cached promise.
    await svc.initializeAsync()
    const after = await env.conn.query<{ name: string }>('SELECT name FROM _migrations')
    expect(after.rows.length).toBe(existing.rows.length)
  })

  it('project + workspace round-trip through the facade', async () => {
    await svc.ensureProject('facade-p1', 'Facade Test', '/abs/facade')
    const project = await svc.getProject('facade-p1')
    expect(project).toEqual({ id: 'facade-p1', name: 'Facade Test', cwd: '/abs/facade' })

    const ws = await svc.addWorkspace('facade-p1', 'facade-w1', 'main', '/abs/facade/main')
    expect(ws.id).toBe('facade-w1')

    const found = await svc.findWorkspaces('facade-p1')
    expect(found.map((w) => w.id)).toEqual(['facade-w1'])
  })

  it('task create + update + find round-trip', async () => {
    await svc.ensureProject('facade-p2', 'Task Host', '/abs/p2')
    const created = await svc.createTask({
      projectId: 'facade-p2',
      title: 'first task',
      priority: 'high'
    })
    expect(created.title).toBe('first task')
    expect(created.status).toBe('TODO')

    const updated = await svc.updateTask(created.id, { status: 'READY' })
    expect(updated.status).toBe('READY')

    const found = await svc.findTasks({ projectId: 'facade-p2', status: 'READY' })
    expect(found.map((t) => t.id)).toContain(created.id)
  })

  it('session create + getActive round-trip', async () => {
    await svc.ensureProject('facade-p3', 'Session Host', '/abs/p3')
    const session = await svc.createSession({
      id: 'facade-s1',
      projectId: 'facade-p3',
      startedAt: '2026-05-24T00:00:00.000Z'
    })
    expect(session.status).toBe('active')

    const active = await svc.getActiveSession('facade-p3')
    expect(active?.id).toBe('facade-s1')
  })

  it('inbox create + update + find round-trip', async () => {
    await svc.ensureProject('facade-p4', 'Inbox Host', '/abs/p4')
    const item = await svc.createInbox({ projectId: 'facade-p4', content: 'hello' })
    expect(item.status).toBe('raw')

    const updated = await svc.updateInbox(item.id, { content: 'goodbye' })
    expect(updated.content).toBe('goodbye')

    const list = await svc.findInbox({ projectId: 'facade-p4', status: 'raw' })
    expect(list.map((r) => r.id)).toContain(item.id)
  })

  it('tool-invocations record + count round-trip', async () => {
    const before = await svc.countToolInvocations()
    await svc.recordToolInvocation({
      toolName: 'facade-test-tool',
      ts: '2026-05-24T00:00:00.000Z',
      durationMs: 1,
      ok: true,
      errorKind: null
    })
    const after = await svc.countToolInvocations()
    expect(after).toBe(before + 1)
  })

  // ── lifecycle / composite / knowledge / backup throw NotImplementedError ──
  // Inbox lifecycle implemented in slice 15 (inbox-lifecycle.pg.test.ts).
  // Conversation lifecycle implemented in slice 16 (conversation-lifecycle.pg.test.ts).
  // Session lifecycle implemented in slice 17 (session-lifecycle.pg.test.ts).
  // Task review + ac-check implemented in slice 18 (task-review-ac-check.pg.test.ts).
  // Queue lifecycle implemented in slice 19 (queue-lifecycle.pg.test.ts).
  it.each([
    ['createKnowledge', () =>
      svc.createKnowledge({
        projectId: 'facade-p1',
        scope: 'project',
        type: 'decision',
        title: 't',
        body: 'b'
      })],
    ['getKnowledge', () => svc.getKnowledge('slug')],
    ['searchKnowledge', () => svc.searchKnowledge('q')],
    ['backup', () => svc.backup('/tmp/bk.sql')]
  ])('%s throws PostgresNotImplementedError', async (_name, callIt) => {
    await expect(callIt()).rejects.toBeInstanceOf(PostgresNotImplementedError)
  })
})
