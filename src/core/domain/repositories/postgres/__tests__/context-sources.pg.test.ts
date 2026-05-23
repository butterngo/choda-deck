import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../../../test/postgres-harness'
import { migrate } from '../migrations'
import { PostgresProjectRepository } from '../project-repository.pg'
import { PostgresContextSourceRepository } from '../context-source-repository.pg'

describeIfDocker('PostgresContextSourceRepository', () => {
  let env: PgTestEnv
  let projects: PostgresProjectRepository
  let sources: PostgresContextSourceRepository

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
    projects = new PostgresProjectRepository(env.conn)
    sources = new PostgresContextSourceRepository(env.conn)
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    await env.conn.query('DELETE FROM context_sources')
    await env.conn.query('DELETE FROM projects')
    await projects.ensure('p', 'P', '/abs/p')
  })

  it('create defaults priority=100, isActive=true, mints CTXSRC id when none given', async () => {
    const created = await sources.create({
      projectId: 'p',
      sourceType: 'file',
      sourcePath: 'docs/foo.md',
      label: 'Foo',
      category: 'what'
    })
    expect(created.id).toMatch(/^CTXSRC-/)
    expect(created.priority).toBe(100)
    expect(created.isActive).toBe(true)
    expect(created.sourceType).toBe('file')
  })

  it('create with explicit isActive=false and custom priority round-trips', async () => {
    const created = await sources.create({
      id: 'CTXSRC-explicit',
      projectId: 'p',
      sourceType: 'mcp_tool',
      sourcePath: 'mcp:foo',
      label: 'Foo MCP',
      category: 'how',
      priority: 5,
      isActive: false
    })
    expect(created.priority).toBe(5)
    expect(created.isActive).toBe(false)
    expect(created.id).toBe('CTXSRC-explicit')
  })

  it('update sets only given fields; isActive boolean round-trips', async () => {
    const c = await sources.create({
      projectId: 'p',
      sourceType: 'file',
      sourcePath: 'x.md',
      label: 'X',
      category: 'state'
    })
    const u = await sources.update(c.id, { isActive: false, label: 'X renamed' })
    expect(u.isActive).toBe(false)
    expect(u.label).toBe('X renamed')
    expect(u.sourceType).toBe('file') // untouched
  })

  it('update with empty input returns existing row', async () => {
    const c = await sources.create({
      projectId: 'p',
      sourceType: 'file',
      sourcePath: 'y.md',
      label: 'Y',
      category: 'who'
    })
    const got = await sources.update(c.id, {})
    expect(got).toEqual(c)
  })

  it('findByProject sorts by priority then label; activeOnly filters', async () => {
    await sources.create({
      id: 'CTXSRC-low',
      projectId: 'p',
      sourceType: 'file',
      sourcePath: 'a.md',
      label: 'Beta',
      category: 'what',
      priority: 50
    })
    await sources.create({
      id: 'CTXSRC-high',
      projectId: 'p',
      sourceType: 'file',
      sourcePath: 'b.md',
      label: 'Alpha',
      category: 'what',
      priority: 5
    })
    await sources.create({
      id: 'CTXSRC-off',
      projectId: 'p',
      sourceType: 'file',
      sourcePath: 'c.md',
      label: 'Gamma',
      category: 'what',
      priority: 10,
      isActive: false
    })

    const all = await sources.findByProject('p')
    expect(all.map((s) => s.id)).toEqual(['CTXSRC-high', 'CTXSRC-off', 'CTXSRC-low'])

    const activeOnly = await sources.findByProject('p', true)
    expect(activeOnly.map((s) => s.id)).toEqual(['CTXSRC-high', 'CTXSRC-low'])
  })

  it('delete removes the row', async () => {
    const c = await sources.create({
      projectId: 'p',
      sourceType: 'file',
      sourcePath: 'gone.md',
      label: 'Gone',
      category: 'what'
    })
    await sources.delete(c.id)
    expect(await sources.get(c.id)).toBeNull()
  })
})
