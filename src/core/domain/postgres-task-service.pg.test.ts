// PostgresTaskService — RemoteOperations smoke (2026-05-28 narrowing).
//
// Consolidated from the slice-by-slice tests deleted in TASK-934 cleanup.
// Verifies all 15 read+inbox-create methods + 2 lifecycle hooks. Setup uses
// raw INSERTs because the PG facade no longer has any write methods beyond
// createInbox — repository-level write tests no longer apply.

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../test/postgres-harness'
import { PostgresTaskService } from './postgres-task-service'

describeIfDocker('PostgresTaskService — RemoteOperations smoke', () => {
  let env: PgTestEnv
  let svc: PostgresTaskService

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    svc = new PostgresTaskService(env.conn)
    await svc.initializeAsync()
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    // Wipe in FK-aware order, then seed a fixed project + workspace + task tree.
    await env.conn.query('DELETE FROM conversation_actions')
    await env.conn.query('DELETE FROM conversation_links')
    await env.conn.query('DELETE FROM conversation_messages')
    await env.conn.query('DELETE FROM conversation_participants')
    await env.conn.query('DELETE FROM conversations')
    await env.conn.query('DELETE FROM inbox_items')
    await env.conn.query('DELETE FROM tags')
    await env.conn.query('DELETE FROM relationships')
    await env.conn.query('DELETE FROM tasks')
    await env.conn.query('DELETE FROM workspaces')
    await env.conn.query('DELETE FROM projects')
    await env.conn.query("UPDATE global_counters SET last_number = 0 WHERE entity_type = 'inbox'")

    await env.conn.query(
      "INSERT INTO projects (id, name, cwd) VALUES ('p1', 'P One', '/abs/p1'), ('p2', 'P Two', '/abs/p2')"
    )
    await env.conn.query(
      "INSERT INTO workspaces (id, project_id, label, cwd, archived_at) VALUES " +
        "('w1', 'p1', 'main', '/abs/p1/main', NULL), " +
        "('w-old', 'p1', 'archived', '/abs/p1/old', NOW())"
    )
  })

  it('initializeAsync runs migrations and is idempotent', async () => {
    const before = await env.conn.query<{ name: string }>('SELECT name FROM _migrations')
    await svc.initializeAsync()
    const after = await env.conn.query<{ name: string }>('SELECT name FROM _migrations')
    expect(after.rows.length).toBe(before.rows.length)
    expect(before.rows.length).toBeGreaterThanOrEqual(6)
  })

  it('getProject + listProjects', async () => {
    const p1 = await svc.getProject('p1')
    expect(p1).toEqual({ id: 'p1', name: 'P One', cwd: '/abs/p1' })
    expect(await svc.getProject('nope')).toBeNull()

    const all = await svc.listProjects()
    expect(all.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
  })

  it('findWorkspaces hides archived by default; surfaces with includeArchived', async () => {
    const defaultList = await svc.findWorkspaces('p1')
    expect(defaultList.map((w) => w.id)).toEqual(['w1'])

    const all = await svc.findWorkspaces('p1', true)
    expect(all.map((w) => w.id).sort()).toEqual(['w-old', 'w1'])
  })

  it('getTask + findTasks + getSubtasks + getDependencies', async () => {
    const now = new Date()
    await env.conn.query(
      `INSERT INTO tasks (id, project_id, parent_task_id, title, status, labels, created_at, updated_at)
       VALUES
         ('TASK-001', 'p1', NULL, 'Parent', 'TODO', '["urgent"]'::jsonb, $1, $1),
         ('TASK-002', 'p1', 'TASK-001', 'Child', 'TODO', NULL, $1, $1),
         ('TASK-003', 'p1', NULL, 'Solo', 'DONE', NULL, $1, $1)`,
      [now]
    )
    await env.conn.query(
      `INSERT INTO relationships (from_id, to_id, type) VALUES ('TASK-001', 'TASK-003', 'DEPENDS_ON')`
    )

    const t = await svc.getTask('TASK-001')
    expect(t?.title).toBe('Parent')
    expect(t?.labels).toEqual(['urgent'])
    expect(t?.blockedBy).toEqual(['TASK-003'])

    const todo = await svc.findTasks({ projectId: 'p1', status: 'TODO' })
    expect(todo.map((x) => x.id).sort()).toEqual(['TASK-001', 'TASK-002'])

    const subs = await svc.getSubtasks('TASK-001')
    expect(subs.map((x) => x.id)).toEqual(['TASK-002'])

    const deps = await svc.getDependencies('TASK-001')
    expect(deps).toEqual([{ sourceId: 'TASK-001', targetId: 'TASK-003' }])
  })

  it('getTags + getRelationships', async () => {
    await env.conn.query(
      "INSERT INTO tags (item_id, tag) VALUES ('item-1', 'backend'), ('item-1', 'urgent')"
    )
    await env.conn.query(
      "INSERT INTO relationships (from_id, to_id, type) VALUES " +
        "('item-1', 'item-2', 'IMPLEMENTS'), ('item-3', 'item-1', 'DECIDED_BY')"
    )

    expect(await svc.getTags('item-1')).toEqual(['backend', 'urgent'])

    const rels = await svc.getRelationships('item-1')
    expect(rels).toHaveLength(2)
    expect(rels.map((r) => r.type).sort()).toEqual(['DECIDED_BY', 'IMPLEMENTS'])
  })

  it('createInbox mints INBOX-NNN ids; findInbox + getInbox round-trip', async () => {
    const a = await svc.createInbox({ projectId: 'p1', content: 'first capture' })
    const b = await svc.createInbox({ projectId: 'p1', content: 'second capture' })
    expect(a.id).toBe('INBOX-001')
    expect(b.id).toBe('INBOX-002')
    expect(a.status).toBe('raw')

    const got = await svc.getInbox('INBOX-001')
    expect(got?.content).toBe('first capture')

    const list = await svc.findInbox({ projectId: 'p1', status: 'raw' })
    expect(list.map((i) => i.id).sort()).toEqual(['INBOX-001', 'INBOX-002'])
  })

  it('findConversationsByLink + getConversationMessages + getConversationActions', async () => {
    await env.conn.query(
      `INSERT INTO conversations (id, project_id, title, status, created_by)
       VALUES ('CONV-1', 'p1', 'Linked', 'open', 'butter')`
    )
    await env.conn.query(
      `INSERT INTO conversation_links (conversation_id, linked_type, linked_id)
       VALUES ('CONV-1', 'inbox', 'INBOX-001')`
    )
    await env.conn.query(
      `INSERT INTO conversation_messages (id, conversation_id, author_name, content, message_type)
       VALUES ('MSG-1', 'CONV-1', 'butter', 'hello', 'comment')`
    )
    await env.conn.query(
      `INSERT INTO conversation_actions (id, conversation_id, assignee, description, status, linked_task_id)
       VALUES ('ACT-1', 'CONV-1', 'butter', 'follow up', 'pending', NULL)`
    )

    const linked = await svc.findConversationsByLink('inbox', 'INBOX-001')
    expect(linked.map((c) => c.id)).toEqual(['CONV-1'])

    const msgs = await svc.getConversationMessages('CONV-1')
    expect(msgs.map((m) => m.content)).toEqual(['hello'])

    const acts = await svc.getConversationActions('CONV-1')
    expect(acts.map((a) => a.assignee)).toEqual(['butter'])
  })
})
