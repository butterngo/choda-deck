import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../../../test/postgres-harness'
import { migrate } from '../migrations'
import { PostgresProjectRepository } from '../project-repository.pg'
import { PostgresCounterRepository } from '../counter-repository.pg'
import { PostgresTagRepository } from '../tag-repository.pg'
import { PostgresRelationshipRepository } from '../relationship-repository.pg'
import { PostgresDocumentRepository } from '../document-repository.pg'
import { PostgresTaskRepository } from '../task-repository.pg'
import { TaskBlockedError } from '../../../task-types'

describeIfDocker('Postgres slice 3 — tasks/documents/tags/relationships', () => {
  let env: PgTestEnv
  let projects: PostgresProjectRepository
  let counters: PostgresCounterRepository
  let tags: PostgresTagRepository
  let relationships: PostgresRelationshipRepository
  let documents: PostgresDocumentRepository
  let tasks: PostgresTaskRepository

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
    projects = new PostgresProjectRepository(env.conn)
    counters = new PostgresCounterRepository(env.conn)
    tags = new PostgresTagRepository(env.conn)
    relationships = new PostgresRelationshipRepository(env.conn)
    documents = new PostgresDocumentRepository(env.conn)
    tasks = new PostgresTaskRepository(env.conn, relationships, counters)
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    // Order matters — tasks/documents reference projects via FK, and the
    // children (tags/relationships) reference task IDs by string.
    await env.conn.query('DELETE FROM relationships')
    await env.conn.query('DELETE FROM tags')
    await env.conn.query('DELETE FROM documents')
    await env.conn.query('DELETE FROM tasks')
    await env.conn.query('DELETE FROM projects')
    await env.conn.query("UPDATE global_counters SET last_number = 0 WHERE entity_type = 'task'")
    await projects.ensure('p', 'P', '/abs/p')
  })

  // ── tags ────────────────────────────────────────────────────────────────
  it('tags: add is idempotent, getForItem returns sorted, findItemsByTag works', async () => {
    await tags.add('item-1', 'urgent')
    await tags.add('item-1', 'urgent') // ON CONFLICT DO NOTHING
    await tags.add('item-1', 'backend')
    await tags.add('item-2', 'urgent')

    expect(await tags.getForItem('item-1')).toEqual(['backend', 'urgent'])
    expect(await tags.findItemsByTag('urgent')).toEqual(['item-1', 'item-2'])

    await tags.remove('item-1', 'urgent')
    expect(await tags.getForItem('item-1')).toEqual(['backend'])
  })

  // ── relationships ───────────────────────────────────────────────────────
  it('relationships: add dedupes, getForItem returns both directions, getFrom filters by type', async () => {
    await relationships.add('a', 'b', 'DEPENDS_ON')
    await relationships.add('a', 'b', 'DEPENDS_ON') // ON CONFLICT DO NOTHING
    await relationships.add('a', 'c', 'IMPLEMENTS')
    await relationships.add('x', 'a', 'DECIDED_BY')

    const aAll = await relationships.getForItem('a')
    expect(aAll).toHaveLength(3)

    const aFrom = await relationships.getFrom('a')
    expect(aFrom).toHaveLength(2)

    const aFromDeps = await relationships.getFrom('a', 'DEPENDS_ON')
    expect(aFromDeps).toEqual([{ fromId: 'a', toId: 'b', type: 'DEPENDS_ON' }])

    await relationships.remove('a', 'b', 'DEPENDS_ON')
    expect(await relationships.getFrom('a', 'DEPENDS_ON')).toEqual([])
  })

  // ── documents ───────────────────────────────────────────────────────────
  it('documents: create + get returns ISO strings; findByProject filters by type', async () => {
    const created = await documents.create({
      id: 'DOC-1',
      projectId: 'p',
      type: 'adr',
      title: 'ADR 1',
      filePath: 'docs/adr-1.md'
    })
    expect(created.id).toBe('DOC-1')
    expect(typeof created.createdAt).toBe('string')
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    await documents.create({ id: 'DOC-2', projectId: 'p', type: 'guide', title: 'G' })

    const adrs = await documents.findByProject('p', 'adr')
    expect(adrs.map((d) => d.id)).toEqual(['DOC-1'])

    const all = await documents.findByProject('p')
    expect(all.map((d) => d.id).sort()).toEqual(['DOC-1', 'DOC-2'])
  })

  it('documents: update only touches given fields and bumps updated_at', async () => {
    const created = await documents.create({ id: 'DOC-3', projectId: 'p', type: 'note', title: 'Old' })
    await new Promise((r) => setTimeout(r, 5))
    const updated = await documents.update('DOC-3', { title: 'New' })
    expect(updated.title).toBe('New')
    expect(updated.type).toBe('note')
    expect(updated.updatedAt > created.updatedAt).toBe(true)
  })

  it('documents: delete also cleans up tags for the same id', async () => {
    await documents.create({ id: 'DOC-4', projectId: 'p', type: 'note', title: 'D' })
    await tags.add('DOC-4', 'review')
    await documents.delete('DOC-4')
    expect(await documents.get('DOC-4')).toBeNull()
    expect(await tags.getForItem('DOC-4')).toEqual([])
  })

  // ── tasks: id minting + shape ────────────────────────────────────────────
  it('tasks: create mints TASK-NNN ids from the counter and returns full shape', async () => {
    const t1 = await tasks.create({ projectId: 'p', title: 'A' })
    const t2 = await tasks.create({ projectId: 'p', title: 'B' })
    expect(t1.id).toBe('TASK-001')
    expect(t2.id).toBe('TASK-002')
    expect(t1.status).toBe('TODO')
    expect(t1.labels).toEqual([])
    expect(t1.pinned).toBe(false)
    expect(t1.blockedBy).toEqual([])
    expect(t1.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('tasks: create with labels stores as JSONB and reads back as string[]', async () => {
    const t = await tasks.create({
      projectId: 'p',
      title: 'Tagged',
      labels: ['urgent', 'backend'],
      pinned: undefined,
      dueDate: '2026-12-31',
      priority: 'high',
      filePath: 'src/foo.ts',
      body: '# body'
    })
    const got = await tasks.get(t.id)
    expect(got?.labels).toEqual(['urgent', 'backend'])
    expect(got?.dueDate).toBe('2026-12-31') // TEXT col → round-trips verbatim
    expect(got?.priority).toBe('high')
    expect(got?.filePath).toBe('src/foo.ts')
    expect(got?.body).toBe('# body')
  })

  it('tasks: update partial fields, pinned boolean round-trip', async () => {
    const t = await tasks.create({ projectId: 'p', title: 'Initial' })
    const u1 = await tasks.update(t.id, { title: 'Renamed', pinned: true })
    expect(u1.title).toBe('Renamed')
    expect(u1.pinned).toBe(true)
    const u2 = await tasks.update(t.id, { pinned: false })
    expect(u2.pinned).toBe(false)
  })

  it('tasks: delete clears relationships + tags + nulls children', async () => {
    const parent = await tasks.create({ projectId: 'p', title: 'Parent' })
    const child = await tasks.create({
      projectId: 'p',
      title: 'Child',
      parentTaskId: parent.id
    })
    await relationships.add(parent.id, 'other', 'IMPLEMENTS')
    await tags.add(parent.id, 'review')

    await tasks.delete(parent.id)

    expect(await tasks.get(parent.id)).toBeNull()
    expect(await tags.getForItem(parent.id)).toEqual([])
    expect(await relationships.getForItem(parent.id)).toEqual([])
    const reread = await tasks.get(child.id)
    expect(reread?.parentTaskId).toBeNull()
  })

  // ── tasks: find + filters ────────────────────────────────────────────────
  it('tasks: find supports status, priority, labels (jsonb ?|), query LIKE, limit', async () => {
    await tasks.create({ projectId: 'p', title: 'Alpha urgent', labels: ['urgent'], priority: 'high' })
    await tasks.create({ projectId: 'p', title: 'Beta backend', labels: ['backend'] })
    await tasks.create({ projectId: 'p', title: 'Gamma misc' })

    expect((await tasks.find({ projectId: 'p' })).length).toBe(3)
    expect((await tasks.find({ priority: 'high' })).length).toBe(1)
    expect((await tasks.find({ labels: ['urgent'] })).map((t) => t.title)).toEqual(['Alpha urgent'])
    expect((await tasks.find({ labels: ['urgent', 'backend'] })).length).toBe(2)
    expect((await tasks.find({ query: 'Beta' })).map((t) => t.title)).toEqual(['Beta backend'])
    expect((await tasks.find({ projectId: 'p', limit: 2 })).length).toBe(2)
  })

  it('tasks: find status=READY post-filters tasks with open blockers', async () => {
    const blocker = await tasks.create({ projectId: 'p', title: 'Blocker', status: 'READY' })
    await tasks.create({
      projectId: 'p',
      title: 'Ready clear',
      status: 'READY'
    })
    await tasks.create({
      projectId: 'p',
      title: 'Ready blocked',
      status: 'READY',
      blockedBy: [blocker.id]
    })

    const ready = await tasks.find({ status: 'READY' })
    const titles = ready.map((t) => t.title).sort()
    expect(titles).toEqual(['Blocker', 'Ready clear'])
  })

  it('tasks: getSubtasks / getPinned / getDue', async () => {
    const parent = await tasks.create({ projectId: 'p', title: 'P' })
    const c1 = await tasks.create({ projectId: 'p', title: 'C1', parentTaskId: parent.id })
    await tasks.create({ projectId: 'p', title: 'C2', parentTaskId: parent.id })

    const subs = await tasks.getSubtasks(parent.id)
    expect(subs.map((t) => t.id).sort()).toEqual([c1.id, subs[1].id].sort())

    await tasks.update(parent.id, { pinned: true })
    const pinned = await tasks.getPinned()
    expect(pinned.map((t) => t.id)).toContain(parent.id)

    await tasks.create({ projectId: 'p', title: 'Due soon', dueDate: '2025-01-01' })
    await tasks.create({ projectId: 'p', title: 'Due later', dueDate: '2099-01-01' })
    const due = await tasks.getDue('2026-01-01')
    expect(due.map((t) => t.title)).toEqual(['Due soon'])
  })

  // ── tasks: blockedBy + DONE-guard ────────────────────────────────────────
  it('blockedBy: createTask with blockedBy populates field on readback', async () => {
    const a = await tasks.create({ projectId: 'p', title: 'A' })
    const b = await tasks.create({ projectId: 'p', title: 'B', blockedBy: [a.id] })
    expect(b.blockedBy).toEqual([a.id])
    expect((await tasks.get(b.id))?.blockedBy).toEqual([a.id])
  })

  it('blockedBy: update with [] clears blockers', async () => {
    const a = await tasks.create({ projectId: 'p', title: 'A' })
    const b = await tasks.create({ projectId: 'p', title: 'B', blockedBy: [a.id] })
    const cleared = await tasks.update(b.id, { blockedBy: [] })
    expect(cleared.blockedBy).toEqual([])
  })

  it('blockedBy: rejects self-reference, unknown task, and direct cycle', async () => {
    const a = await tasks.create({ projectId: 'p', title: 'A' })
    await expect(tasks.update(a.id, { blockedBy: [a.id] })).rejects.toThrow('cannot be blocked by itself')
    await expect(tasks.update(a.id, { blockedBy: ['TASK-MISSING'] })).rejects.toThrow('unknown task')
    const b = await tasks.create({ projectId: 'p', title: 'B', blockedBy: [a.id] })
    await expect(tasks.update(a.id, { blockedBy: [b.id] })).rejects.toThrow('Cycle detected')
  })

  it('DONE guard: blocked by non-DONE dependency', async () => {
    const blocker = await tasks.create({ projectId: 'p', title: 'Block', status: 'TODO' })
    const blocked = await tasks.create({ projectId: 'p', title: 'Blocked', blockedBy: [blocker.id] })
    let err: TaskBlockedError | null = null
    try {
      await tasks.update(blocked.id, { status: 'DONE' })
    } catch (e) {
      err = e as TaskBlockedError
    }
    expect(err).toBeInstanceOf(TaskBlockedError)
    expect(err?.blockers.map((b) => b.id)).toEqual([blocker.id])
    expect(err?.blockers[0].type).toBe('dependency')
  })

  it('DONE guard: blocked by non-DONE subtask', async () => {
    const parent = await tasks.create({ projectId: 'p', title: 'Parent' })
    const child = await tasks.create({ projectId: 'p', title: 'Child', parentTaskId: parent.id })
    let err: TaskBlockedError | null = null
    try {
      await tasks.update(parent.id, { status: 'DONE' })
    } catch (e) {
      err = e as TaskBlockedError
    }
    expect(err).toBeInstanceOf(TaskBlockedError)
    expect(err?.blockers.map((b) => b.id)).toEqual([child.id])
    expect(err?.blockers[0].type).toBe('subtask')
  })

  it('DONE guard: succeeds when all blockers DONE/CANCELLED', async () => {
    const a = await tasks.create({ projectId: 'p', title: 'A' })
    const b = await tasks.create({ projectId: 'p', title: 'B', status: 'CANCELLED' })
    const c = await tasks.create({ projectId: 'p', title: 'C', blockedBy: [a.id, b.id] })
    await tasks.update(a.id, { status: 'DONE' })
    const done = await tasks.update(c.id, { status: 'DONE' })
    expect(done.status).toBe('DONE')
  })

  // ── tasks: dependencies API ──────────────────────────────────────────────
  it('addDependency + getDependencies + removeDependency', async () => {
    const a = await tasks.create({ projectId: 'p', title: 'A' })
    const b = await tasks.create({ projectId: 'p', title: 'B' })
    await tasks.addDependency(a.id, b.id)
    const deps = await tasks.getDependencies(a.id)
    expect(deps).toEqual([{ sourceId: a.id, targetId: b.id }])
    await tasks.removeDependency(a.id, b.id)
    expect(await tasks.getDependencies(a.id)).toEqual([])
  })
})
