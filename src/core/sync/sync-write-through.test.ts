// ADR-030 Phase 3 (979b) — write-through wrapper against a real in-memory
// SqliteTaskService + a fake sink. Asserts: local write happens, the row is
// Lamport-stamped, the stamped row is pushed, and a sink failure enqueues to
// pending_ops while the tool call still succeeds.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SqliteTaskService } from '../domain/sqlite-task-service'
import { wrapWithSyncWriteThrough } from './sync-write-through'
import { countPendingOps, listPendingOps } from './pending-ops'
import type { ApplySink, ApplyResult } from './sync-apply'
import type { TableDelta } from './sync-pull'

class RecordingSink implements ApplySink {
  calls: Array<{ deltas: TableDelta[]; origin: string }> = []
  fail = false
  async applyDelta(deltas: TableDelta[], origin: string): Promise<ApplyResult> {
    if (this.fail) throw new Error('offline')
    this.calls.push({ deltas, origin })
    return { applied: 1, tombstoned: 0, conflicts: 0, verdicts: [] }
  }
}

describe('wrapWithSyncWriteThrough', () => {
  let svc: SqliteTaskService
  let sink: RecordingSink

  beforeEach(() => {
    svc = new SqliteTaskService(':memory:')
    sink = new RecordingSink()
  })
  afterEach(() => {
    svc.close()
  })

  function stamped(id: string): { sync_updated_at: number | null; sync_origin: string | null } {
    return svc.syncDatabase
      .prepare('SELECT sync_updated_at, sync_origin FROM tasks WHERE id = ?')
      .get(id) as never
  }

  it('createTask stamps the row and pushes an upsert delta', async () => {
    const wrapped = wrapWithSyncWriteThrough(svc, sink)
    const task = await wrapped.createTask({ projectId: 'p', title: 'hello' })

    const row = stamped(task.id)
    expect(row.sync_origin).toBe('laptop')
    expect(row.sync_updated_at).toBeGreaterThan(0)
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0].origin).toBe('laptop')
    const delta = sink.calls[0].deltas[0]
    expect(delta.table).toBe('tasks')
    expect(delta.rows[0]).toMatchObject({ id: task.id, title: 'hello', sync_origin: 'laptop' })
    expect(countPendingOps(svc.syncDatabase)).toBe(0)
  })

  it('updateTask pushes the updated row', async () => {
    const wrapped = wrapWithSyncWriteThrough(svc, sink)
    const task = await wrapped.createTask({ projectId: 'p', title: 'v1' })
    sink.calls = []
    await wrapped.updateTask(task.id, { title: 'v2' })
    expect(sink.calls[0].deltas[0].rows[0]).toMatchObject({ id: task.id, title: 'v2' })
  })

  it('enqueues to pending_ops when the remote push fails (and still returns)', async () => {
    const wrapped = wrapWithSyncWriteThrough(svc, sink)
    sink.fail = true
    const task = await wrapped.createTask({ projectId: 'p', title: 'offline-write' })

    expect(task.id).toBeTruthy() // tool call succeeded despite the remote failure
    expect(stamped(task.id).sync_updated_at).toBeGreaterThan(0) // stamped locally regardless
    const ops = listPendingOps(svc.syncDatabase)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ table_name: 'tasks', row_id: task.id, op: 'upsert' })
  })

  it('deleteTask pushes a tombstone (sync_deleted_at set)', async () => {
    const wrapped = wrapWithSyncWriteThrough(svc, sink)
    const task = await wrapped.createTask({ projectId: 'p', title: 'doomed' })
    sink.calls = []
    await wrapped.deleteTask(task.id)

    expect(await wrapped.getTask(task.id)).toBeNull() // locally hard-deleted
    const row = sink.calls[0].deltas[0].rows[0]
    expect(row.id).toBe(task.id)
    expect(row.sync_deleted_at).toBeGreaterThan(0) // pushed as a tombstone
  })

  it('passes non-mutating methods straight through', async () => {
    const wrapped = wrapWithSyncWriteThrough(svc, sink)
    const task = await wrapped.createTask({ projectId: 'p', title: 'readable' })
    const got = await wrapped.getTask(task.id)
    expect(got?.title).toBe('readable')
  })

  it('openConversation pushes the conversation skeleton + initial message (TASK-1136)', async () => {
    await svc.ensureProject('p', 'P', '/p')
    const wrapped = wrapWithSyncWriteThrough(svc, sink)
    const conv = await wrapped.openConversation({
      projectId: 'p',
      title: 'Sync chat',
      createdBy: 'Butter',
      participants: [{ name: 'Butter' }],
      initialMessage: { content: 'hi' }
    })
    const tables = sink.calls.flatMap((c) => c.deltas.map((d) => d.table))
    expect(tables).toContain('conversations')
    expect(tables).toContain('conversation_messages')
    const convDelta = sink.calls[0].deltas.find((d) => d.table === 'conversations')
    expect(convDelta?.rows[0]).toMatchObject({ id: conv.id, sync_origin: 'laptop' })
    expect(countPendingOps(svc.syncDatabase)).toBe(0)
  })

  it('addConversationMessage pushes only the new (unstamped) message', async () => {
    await svc.ensureProject('p', 'P', '/p')
    const wrapped = wrapWithSyncWriteThrough(svc, sink)
    const conv = await wrapped.openConversation({
      projectId: 'p',
      title: 'T',
      createdBy: 'Butter',
      participants: [{ name: 'Butter' }],
      initialMessage: { content: 'seed' }
    })
    sink.calls = []
    const msg = await wrapped.addConversationMessage({
      conversationId: conv.id,
      authorName: 'Butter',
      content: 'turn 2'
    })
    const msgDelta = sink.calls[0].deltas.find((d) => d.table === 'conversation_messages')
    expect(msgDelta?.rows.map((r) => r.id)).toEqual([msg.id]) // only the fresh turn
  })

  it('failed conversation push enqueues the skeleton + message rows', async () => {
    await svc.ensureProject('p', 'P', '/p')
    const wrapped = wrapWithSyncWriteThrough(svc, sink)
    sink.fail = true
    const conv = await wrapped.openConversation({
      projectId: 'p',
      title: 'Offline',
      createdBy: 'Butter',
      participants: [{ name: 'Butter' }],
      initialMessage: { content: 'hi' }
    })
    expect(conv.id).toBeTruthy() // tool call succeeded despite remote failure
    expect(countPendingOps(svc.syncDatabase)).toBe(2) // conversations + initial message
  })

  it('exposes syncDatabase through the proxy (bootstrap reads the loop db from it)', () => {
    const wrapped = wrapWithSyncWriteThrough(svc, sink)
    const db = (wrapped as unknown as { syncDatabase: typeof svc.syncDatabase }).syncDatabase
    expect(db).toBe(svc.syncDatabase)
  })
})
