import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../../../test/postgres-harness'
import { migrate } from '../migrations'
import { PostgresProjectRepository } from '../project-repository.pg'
import { PostgresWorkspaceRepository } from '../workspace-repository.pg'

describeIfDocker('PostgresProjectRepository + PostgresWorkspaceRepository', () => {
  let env: PgTestEnv

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  it('ensure is idempotent and preserves first write', async () => {
    const projects = new PostgresProjectRepository(env.conn)
    await projects.ensure('p1', 'First', '/abs/p1')
    await projects.ensure('p1', 'Second-name-should-be-ignored', '/abs/p1-other')
    const got = await projects.get('p1')
    expect(got).toEqual({ id: 'p1', name: 'First', cwd: '/abs/p1' })
  })

  it('list returns projects ordered by name', async () => {
    const projects = new PostgresProjectRepository(env.conn)
    await projects.ensure('p2', 'Zebra', '/abs/p2')
    await projects.ensure('p3', 'Apple', '/abs/p3')
    const all = await projects.list()
    const names = all.map((p) => p.name)
    expect(names.indexOf('Apple')).toBeLessThan(names.indexOf('Zebra'))
  })

  it('workspace add → get → findByProject round-trip', async () => {
    const projects = new PostgresProjectRepository(env.conn)
    const workspaces = new PostgresWorkspaceRepository(env.conn)
    await projects.ensure('p4', 'WSHost', '/abs/p4')

    const added = await workspaces.add('p4', 'w1', 'main', '/abs/p4/main')
    expect(added).toEqual({
      id: 'w1',
      projectId: 'p4',
      label: 'main',
      cwd: '/abs/p4/main',
      archivedAt: null
    })

    const fetched = await workspaces.get('w1')
    expect(fetched).toEqual(added)

    await workspaces.add('p4', 'w2', 'feature', '/abs/p4/feature')
    const list = await workspaces.findByProject('p4')
    expect(list.map((w) => w.id).sort()).toEqual(['w1', 'w2'])
  })

  it('archive marks archivedAt, hides from default findByProject, surfaces with includeArchived', async () => {
    const projects = new PostgresProjectRepository(env.conn)
    const workspaces = new PostgresWorkspaceRepository(env.conn)
    await projects.ensure('p5', 'ArchHost', '/abs/p5')
    await workspaces.add('p5', 'wA', 'live', '/abs/p5/live')
    await workspaces.add('p5', 'wB', 'archived-soon', '/abs/p5/old')

    const archived = await workspaces.archive('wB')
    expect(archived?.archivedAt).toBeTruthy()
    expect(typeof archived?.archivedAt).toBe('string')

    const defaultList = await workspaces.findByProject('p5')
    expect(defaultList.map((w) => w.id)).toEqual(['wA'])

    const allList = await workspaces.findByProject('p5', true)
    expect(allList.map((w) => w.id).sort()).toEqual(['wA', 'wB'])

    const unarchived = await workspaces.unarchive('wB')
    expect(unarchived?.archivedAt).toBeNull()
  })

  it('archive is idempotent (re-archiving returns existing row, no timestamp churn)', async () => {
    const projects = new PostgresProjectRepository(env.conn)
    const workspaces = new PostgresWorkspaceRepository(env.conn)
    await projects.ensure('p6', 'IdempHost', '/abs/p6')
    await workspaces.add('p6', 'wX', 'idemp', '/abs/p6/x')

    const first = await workspaces.archive('wX')
    const second = await workspaces.archive('wX')
    expect(second?.archivedAt).toBe(first?.archivedAt)
  })

  it('delete removes the row', async () => {
    const projects = new PostgresProjectRepository(env.conn)
    const workspaces = new PostgresWorkspaceRepository(env.conn)
    await projects.ensure('p7', 'DelHost', '/abs/p7')
    await workspaces.add('p7', 'wDel', 'gone', '/abs/p7/d')

    await workspaces.delete('wDel')
    const after = await workspaces.get('wDel')
    expect(after).toBeNull()
  })

  it('countReferences throws clearly until slice 3 ships sessions table', async () => {
    const workspaces = new PostgresWorkspaceRepository(env.conn)
    await expect(workspaces.countReferences('anything')).rejects.toThrow(/slice 3/)
  })
})
