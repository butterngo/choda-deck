import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { SqliteTaskService } from '../sqlite-task-service'
import { SYNCABLE_TABLES } from '../../sync/syncable-tables'
import { planDate } from '../daily/plan-date'

// TASK-2670 — the status log behind the daily report's "yesterday" (TASK-2669).

const TEST_DB = path.join(__dirname, '__task-status-changes-test__.db')

describe('task_status_changes', () => {
  let svc: SqliteTaskService

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
    svc = new SqliteTaskService(TEST_DB)
    await svc.ensureProject('p', 'P', '/tmp/p')
  })

  afterEach(async () => {
    await svc.close()
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  })

  const all = (): Promise<{ taskId: string; fromStatus: string; toStatus: string; at: string }[]> =>
    svc.listStatusChanges('0000', '9999')

  it('AC-1: TODO → READY writes exactly one row with from, to and an ISO at', async () => {
    await svc.createTask({ id: 'T1', projectId: 'p', title: 'A' })
    await svc.updateTask('T1', { status: 'READY' })

    const rows = await all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ taskId: 'T1', fromStatus: 'TODO', toStatus: 'READY' })
    expect(new Date(rows[0].at).toISOString()).toBe(rows[0].at)
  })

  it('AC-2: a title-only update writes zero rows', async () => {
    await svc.createTask({ id: 'T1', projectId: 'p', title: 'A' })
    await svc.updateTask('T1', { title: 'B' })
    expect(await all()).toHaveLength(0)
  })

  it('AC-3: an update to the status the task already has writes zero rows', async () => {
    await svc.createTask({ id: 'T1', projectId: 'p', title: 'A', status: 'READY' })
    await svc.updateTask('T1', { status: 'READY' })
    expect(await all()).toHaveLength(0)
  })

  it('AC-4: session_start writes a row ending IN-PROGRESS and session_end one ending IMPLEMENTED', async () => {
    await svc.createTask({ id: 'T1', projectId: 'p', title: 'A', status: 'READY' })
    const { session } = await svc.startSession({ projectId: 'p', taskId: 'T1' })
    expect((await all()).map((r) => r.toStatus)).toEqual(['IN-PROGRESS'])

    await svc.endSession(session.id, { handoff: { resumePoint: 'done' } })
    expect((await all()).map((r) => `${r.fromStatus}→${r.toStatus}`)).toEqual([
      'READY→IN-PROGRESS',
      'IN-PROGRESS→IMPLEMENTED'
    ])
  })

  it('AC-5: when the status-row insert throws, the task status is unchanged', async () => {
    await svc.createTask({ id: 'T1', projectId: 'p', title: 'A' })
    const raw = new Database(TEST_DB)
    raw.exec(
      "CREATE TRIGGER fail_status_log BEFORE INSERT ON task_status_changes BEGIN SELECT RAISE(ABORT, 'boom'); END"
    )
    raw.close()

    await expect(svc.updateTask('T1', { status: 'READY' })).rejects.toThrow('boom')
    expect((await svc.getTask('T1'))?.status).toBe('TODO')
  })

  it('AC-6: listStatusChanges returns only from ≤ at < to, oldest first', async () => {
    await svc.createTask({ id: 'T1', projectId: 'p', title: 'A' })
    const raw = new Database(TEST_DB)
    const ins = raw.prepare(
      'INSERT INTO task_status_changes (task_id, from_status, to_status, at) VALUES (?, ?, ?, ?)'
    )
    ins.run('T1', 'READY', 'IN-PROGRESS', '2026-10-22T03:00:00.000Z')
    ins.run('T1', 'TODO', 'READY', '2026-10-21T22:00:00.000Z') // == from: included
    ins.run('T1', 'IN-PROGRESS', 'DONE', '2026-10-22T22:00:00.000Z') // == to: excluded
    ins.run('T1', 'DONE', 'TODO', '2026-10-21T21:59:59.999Z') // before from: excluded
    raw.close()

    const rows = await svc.listStatusChanges('2026-10-21T22:00:00.000Z', '2026-10-22T22:00:00.000Z')
    expect(rows.map((r) => r.at)).toEqual(['2026-10-21T22:00:00.000Z', '2026-10-22T03:00:00.000Z'])
  })

  it('AC-8: task_status_changes is not synced', () => {
    expect(SYNCABLE_TABLES).not.toContain('task_status_changes')
  })
})

describe('planDate (AC-7) — a day runs 05:00 → 05:00 Asia/Ho_Chi_Minh', () => {
  it('22:00 +07 belongs to that day', () => {
    expect(planDate(Date.parse('2026-10-23T15:00:00Z'))).toBe('2026-10-23')
  })
  it('00:30 +07 the next day still belongs to the evening before', () => {
    expect(planDate(Date.parse('2026-10-23T17:30:00Z'))).toBe('2026-10-23')
  })
  it('06:00 +07 belongs to the new day', () => {
    expect(planDate(Date.parse('2026-10-23T23:00:00Z'))).toBe('2026-10-24')
  })
})
