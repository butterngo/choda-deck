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
import { PostgresCounterRepository } from '../counter-repository.pg'
import { PostgresInboxRepository } from '../inbox-repository.pg'
import { PostgresKnowledgeRepository } from '../knowledge-repository.pg'

describeIfDocker('Postgres slice 8 — inbox + knowledge', () => {
  let env: PgTestEnv
  let projects: PostgresProjectRepository
  let workspaces: PostgresWorkspaceRepository
  let counters: PostgresCounterRepository
  let inbox: PostgresInboxRepository
  let knowledge: PostgresKnowledgeRepository

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
    projects = new PostgresProjectRepository(env.conn)
    workspaces = new PostgresWorkspaceRepository(env.conn)
    counters = new PostgresCounterRepository(env.conn)
    inbox = new PostgresInboxRepository(env.conn, counters)
    knowledge = new PostgresKnowledgeRepository(env.conn)
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    await env.conn.query('DELETE FROM knowledge_index')
    await env.conn.query('DELETE FROM inbox_items')
    await env.conn.query('DELETE FROM workspaces')
    await env.conn.query('DELETE FROM projects')
    await env.conn.query("UPDATE global_counters SET last_number = 0 WHERE entity_type = 'inbox'")
    await projects.ensure('p', 'P', '/abs/p')
  })

  // ── inbox ────────────────────────────────────────────────────────────────
  it('inbox: create mints INBOX-NNN ids sequentially; defaults status=raw', async () => {
    const a = await inbox.create({ projectId: 'p', content: 'first' })
    const b = await inbox.create({ projectId: 'p', content: 'second' })
    expect(a.id).toBe('INBOX-001')
    expect(b.id).toBe('INBOX-002')
    expect(a.status).toBe('raw')
    expect(a.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('inbox: create with projectId=null persists null and is findable via IS NULL', async () => {
    const a = await inbox.create({ projectId: null as unknown as string, content: 'unscoped' })
    const b = await inbox.create({ projectId: 'p', content: 'scoped' })

    const got = await inbox.get(a.id)
    expect(got?.projectId).toBeNull()

    const unscoped = await inbox.find({ projectId: null })
    expect(unscoped.map((i) => i.id)).toEqual([a.id])

    const scoped = await inbox.find({ projectId: 'p' })
    expect(scoped.map((i) => i.id)).toEqual([b.id])
  })

  it('inbox: update sets only given fields and bumps updated_at', async () => {
    const a = await inbox.create({ projectId: 'p', content: 'old' })
    await new Promise((r) => setTimeout(r, 5))
    const u = await inbox.update(a.id, {
      content: 'new',
      status: 'researching',
      linkedTaskId: 'TASK-999'
    })
    expect(u.content).toBe('new')
    expect(u.status).toBe('researching')
    expect(u.linkedTaskId).toBe('TASK-999')
    expect(u.updatedAt > a.updatedAt).toBe(true)
  })

  it('inbox: update with linkedTaskId=null clears the link', async () => {
    const a = await inbox.create({ projectId: 'p', content: 'x' })
    await inbox.update(a.id, { linkedTaskId: 'TASK-1' })
    const cleared = await inbox.update(a.id, { linkedTaskId: null })
    expect(cleared.linkedTaskId).toBeNull()
  })

  it('inbox: find filters by status; results ordered created_at DESC', async () => {
    const a = await inbox.create({ projectId: 'p', content: 'a' })
    const b = await inbox.create({ projectId: 'p', content: 'b' })
    await inbox.update(b.id, { status: 'converted' })

    const raw = await inbox.find({ projectId: 'p', status: 'raw' })
    expect(raw.map((i) => i.id)).toEqual([a.id])

    const all = await inbox.find({ projectId: 'p' })
    expect(all.map((i) => i.id)).toEqual([b.id, a.id])
  })

  it('inbox: delete removes the row', async () => {
    const a = await inbox.create({ projectId: 'p', content: 'gone' })
    await inbox.delete(a.id)
    expect(await inbox.get(a.id)).toBeNull()
  })

  // ── knowledge ─────────────────────────────────────────────────────────────
  it('knowledge: upsert inserts then updates same slug; created_at preserved', async () => {
    const initial = {
      slug: 'ADR-100',
      projectId: 'p',
      workspaceId: null,
      scope: 'project' as const,
      type: 'decision' as const,
      title: 'Original',
      filePath: 'docs/adr-100.md',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastVerifiedAt: '2026-01-01T00:00:00.000Z'
    }
    await knowledge.upsert(initial)
    const got1 = await knowledge.get('ADR-100')
    expect(got1?.title).toBe('Original')

    // Second upsert with different title + later verified — created_at unchanged
    await knowledge.upsert({
      ...initial,
      title: 'Renamed',
      lastVerifiedAt: '2026-05-23T00:00:00.000Z',
      createdAt: '2099-12-31T00:00:00.000Z' // ignored on conflict path
    })
    const got2 = await knowledge.get('ADR-100')
    expect(got2?.title).toBe('Renamed')
    expect(got2?.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(got2?.lastVerifiedAt).toBe('2026-05-23T00:00:00.000Z')
  })

  it('knowledge: workspace_id stores + filters; null vs explicit', async () => {
    await workspaces.add('p', 'w1', 'main', '/abs/w1')

    await knowledge.upsert({
      slug: 'ADR-A',
      projectId: 'p',
      workspaceId: 'w1',
      scope: 'project',
      type: 'spike',
      title: 'WS-scoped',
      filePath: 'a.md',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastVerifiedAt: '2026-01-01T00:00:00.000Z'
    })
    await knowledge.upsert({
      slug: 'ADR-B',
      projectId: 'p',
      workspaceId: null,
      scope: 'project',
      type: 'spike',
      title: 'Project-only',
      filePath: 'b.md',
      createdAt: '2026-01-02T00:00:00.000Z',
      lastVerifiedAt: '2026-01-02T00:00:00.000Z'
    })

    const wsScoped = await knowledge.list({ workspaceId: 'w1' })
    expect(wsScoped.map((k) => k.slug)).toEqual(['ADR-A'])

    const noWs = await knowledge.list({ workspaceId: null })
    expect(noWs.map((k) => k.slug)).toEqual(['ADR-B'])
  })

  it('knowledge: list filters by scope + type + ordering created_at DESC', async () => {
    const base = {
      projectId: 'p',
      workspaceId: null,
      title: 't',
      filePath: 'f.md',
      lastVerifiedAt: '2026-01-01T00:00:00.000Z'
    }
    await knowledge.upsert({
      ...base,
      slug: 'k1',
      scope: 'project',
      type: 'decision',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    await knowledge.upsert({
      ...base,
      slug: 'k2',
      scope: 'cross',
      type: 'spike',
      createdAt: '2026-01-02T00:00:00.000Z'
    })
    await knowledge.upsert({
      ...base,
      slug: 'k3',
      scope: 'project',
      type: 'learning',
      createdAt: '2026-01-03T00:00:00.000Z'
    })

    const projectOnly = await knowledge.list({ projectId: 'p', scope: 'project' })
    expect(projectOnly.map((k) => k.slug)).toEqual(['k3', 'k1'])

    const decisions = await knowledge.list({ type: 'decision' })
    expect(decisions.map((k) => k.slug)).toEqual(['k1'])
  })

  it('knowledge: scope CHECK rejects invalid value', async () => {
    await expect(
      env.conn.query(
        `INSERT INTO knowledge_index (slug, project_id, scope, type, title, file_path, created_at, last_verified_at)
         VALUES ('bad', 'p', 'bogus', 'spike', 't', 'f', 'now', 'now')`
      )
    ).rejects.toThrow(/scope|check constraint/i)
  })

  it('knowledge: type CHECK rejects invalid value', async () => {
    await expect(
      env.conn.query(
        `INSERT INTO knowledge_index (slug, project_id, scope, type, title, file_path, created_at, last_verified_at)
         VALUES ('bad', 'p', 'project', 'bogus', 't', 'f', 'now', 'now')`
      )
    ).rejects.toThrow(/type|check constraint/i)
  })

  it('knowledge: project FK rejects unknown project_id', async () => {
    await expect(
      knowledge.upsert({
        slug: 'orphan',
        projectId: 'no-such-project',
        workspaceId: null,
        scope: 'project',
        type: 'spike',
        title: 't',
        filePath: 'f.md',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastVerifiedAt: '2026-01-01T00:00:00.000Z'
      })
    ).rejects.toThrow(/foreign key|violates|project/i)
  })

  it('knowledge: updateLastVerified bumps the column without touching others', async () => {
    await knowledge.upsert({
      slug: 'k',
      projectId: 'p',
      workspaceId: null,
      scope: 'project',
      type: 'spike',
      title: 't',
      filePath: 'f',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastVerifiedAt: '2026-01-01T00:00:00.000Z'
    })
    await knowledge.updateLastVerified('k', '2026-05-24T00:00:00.000Z')
    const got = await knowledge.get('k')
    expect(got?.lastVerifiedAt).toBe('2026-05-24T00:00:00.000Z')
    expect(got?.title).toBe('t') // untouched
  })

  it('knowledge: delete removes the row', async () => {
    await knowledge.upsert({
      slug: 'k-del',
      projectId: 'p',
      workspaceId: null,
      scope: 'project',
      type: 'spike',
      title: 't',
      filePath: 'f',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastVerifiedAt: '2026-01-01T00:00:00.000Z'
    })
    await knowledge.delete('k-del')
    expect(await knowledge.get('k-del')).toBeNull()
  })
})
