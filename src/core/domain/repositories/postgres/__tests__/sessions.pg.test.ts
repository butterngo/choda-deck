import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../../../test/postgres-harness'
import { migrate } from '../migrations'
import { PostgresProjectRepository } from '../project-repository.pg'
import { PostgresWorkspaceRepository } from '../workspace-repository.pg'
import { PostgresSessionRepository } from '../session-repository.pg'

describeIfDocker('PostgresSessionRepository', () => {
  let env: PgTestEnv
  let projects: PostgresProjectRepository
  let workspaces: PostgresWorkspaceRepository
  let sessions: PostgresSessionRepository

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
    projects = new PostgresProjectRepository(env.conn)
    workspaces = new PostgresWorkspaceRepository(env.conn)
    sessions = new PostgresSessionRepository(env.conn)
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    await env.conn.query('DELETE FROM sessions')
    await env.conn.query('DELETE FROM workspaces')
    await env.conn.query('DELETE FROM projects')
    await projects.ensure('p', 'P', '/abs/p')
  })

  it('create + get round-trip with auto-generated id and default status', async () => {
    const created = await sessions.create({ projectId: 'p' })
    expect(created.id).toMatch(/^SESSION-/)
    expect(created.status).toBe('active')
    expect(created.handoff).toBeNull()
    expect(created.checkpoint).toBeNull()
    expect(typeof created.startedAt).toBe('string')
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const got = await sessions.get(created.id)
    expect(got).toEqual(created)
  })

  it('create with handoff serializes JSONB and round-trips as object', async () => {
    const handoff = { commits: ['abc', 'def'], resumePoint: 'mid-refactor' }
    const created = await sessions.create({
      id: 'SESSION-explicit',
      projectId: 'p',
      handoff
    })
    expect(created.handoff).toEqual(handoff)
    const reread = await sessions.get('SESSION-explicit')
    expect(reread?.handoff).toEqual(handoff)
  })

  it('create rejects invalid status via CHECK constraint', async () => {
    // Bypass the typed input to exercise the DB-level CHECK
    await expect(
      env.conn.query(
        "INSERT INTO sessions (id, project_id, started_at, status, created_at) VALUES ('S-bad', 'p', 'now', 'bogus', 'now')"
      )
    ).rejects.toThrow(/sessions_status_check|check constraint/i)
  })

  it('update sets only the given fields', async () => {
    const s = await sessions.create({ projectId: 'p', taskId: 'TASK-001' })
    const updated = await sessions.update(s.id, {
      checkpoint: { resumePoint: 'here', notes: 'work in progress' },
      checkpointAt: '2026-05-23T11:00:00.000Z'
    })
    expect(updated.checkpoint).toEqual({ resumePoint: 'here', notes: 'work in progress' })
    expect(updated.checkpointAt).toBe('2026-05-23T11:00:00.000Z')
    expect(updated.taskId).toBe('TASK-001') // untouched
    expect(updated.status).toBe('active') // untouched
  })

  it('update with empty input returns existing row unchanged', async () => {
    const s = await sessions.create({ projectId: 'p' })
    const got = await sessions.update(s.id, {})
    expect(got).toEqual(s)
  })

  it('update sets checkpoint=null to clear it', async () => {
    const s = await sessions.create({ projectId: 'p' })
    await sessions.update(s.id, { checkpoint: { resumePoint: 'x' } })
    const cleared = await sessions.update(s.id, { checkpoint: null })
    expect(cleared.checkpoint).toBeNull()
  })

  it('findByProject sorts started_at DESC, filters by status when given', async () => {
    const a = await sessions.create({
      id: 'S-a',
      projectId: 'p',
      startedAt: '2026-05-23T10:00:00.000Z'
    })
    const b = await sessions.create({
      id: 'S-b',
      projectId: 'p',
      startedAt: '2026-05-23T11:00:00.000Z'
    })
    await sessions.update(a.id, { status: 'completed' })

    const all = await sessions.findByProject('p')
    expect(all.map((s) => s.id)).toEqual([b.id, a.id])

    const active = await sessions.findByProject('p', 'active')
    expect(active.map((s) => s.id)).toEqual([b.id])
  })

  it('findActiveByTask returns only active sessions for the task', async () => {
    const a = await sessions.create({ id: 'S-A', projectId: 'p', taskId: 'T1' })
    await sessions.create({ id: 'S-B', projectId: 'p', taskId: 'T1' })
    const done = await sessions.create({ id: 'S-C', projectId: 'p', taskId: 'T1' })
    await sessions.update(done.id, { status: 'completed' })

    const active = await sessions.findActiveByTask('T1')
    const ids = active.map((s) => s.id).sort()
    expect(ids).toEqual([a.id, 'S-B'].sort())
  })

  it('getActive returns most-recent active for project / scoped by workspace', async () => {
    await workspaces.add('p', 'w1', 'main', '/abs/w1')
    await workspaces.add('p', 'w2', 'feat', '/abs/w2')

    await sessions.create({ id: 'S-1', projectId: 'p', workspaceId: 'w1', startedAt: '2026-05-23T09:00:00.000Z' })
    const newer = await sessions.create({
      id: 'S-2',
      projectId: 'p',
      workspaceId: 'w2',
      startedAt: '2026-05-23T10:00:00.000Z'
    })

    const active = await sessions.getActive('p')
    expect(active?.id).toBe(newer.id)

    const scoped = await sessions.getActive('p', 'w1')
    expect(scoped?.id).toBe('S-1')

    const noMatch = await sessions.getActive('p', 'w-nope')
    expect(noMatch).toBeNull()
  })

  it('delete removes the row', async () => {
    const s = await sessions.create({ projectId: 'p' })
    await sessions.delete(s.id)
    expect(await sessions.get(s.id)).toBeNull()
  })

  // ── workspace.countReferences (slice 2 stub now wired up) ─────────────────
  it('workspace.countReferences counts sessions referencing the workspace', async () => {
    await workspaces.add('p', 'wx', 'main', '/abs/wx')
    await sessions.create({ projectId: 'p', workspaceId: 'wx' })
    await sessions.create({ projectId: 'p', workspaceId: 'wx' })
    await sessions.create({ projectId: 'p', workspaceId: 'other' })

    expect(await workspaces.countReferences('wx')).toEqual({ sessions: 2 })
    expect(await workspaces.countReferences('untouched')).toEqual({ sessions: 0 })
  })
})
