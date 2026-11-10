// ADR-030 Phase 3 (979a) — write-apply LWW core. Docker-free: the pure decision
// function plus the SQLite sink against an in-memory DB. The Postgres sink +
// /sync/apply endpoint are covered by sync-apply.pg.test.ts (Docker-gated).

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../domain/repositories/schema'
import { applyDeltaToSqlite } from './sync-sink'
import { planApplyRow, assertApplyTables, type ApplyVerdict } from './sync-apply'
import { mergeClock, peek } from './lamport-clock'
import type { PulledRow } from './sync-pull'

function inboxRow(id: string, lamport: number, extra: Partial<PulledRow> = {}): PulledRow {
  return {
    id,
    content: `content-${lamport}`,
    status: 'raw',
    created_at: '2026-06-11T00:00:00.000Z',
    updated_at: '2026-06-11T00:00:00.000Z',
    sync_updated_at: lamport,
    sync_deleted_at: null,
    sync_origin: 'laptop',
    ...extra
  }
}

describe('planApplyRow — pure LWW decision (canonical wins ties)', () => {
  const cases: Array<[string, number | null, PulledRow, ApplyVerdict]> = [
    ['new row (no canonical) → applied', null, inboxRow('a', 5), 'applied'],
    ['new tombstone → tombstoned', null, inboxRow('a', 5, { sync_deleted_at: 5 }), 'tombstoned'],
    ['strictly newer push → applied', 3, inboxRow('a', 4), 'applied'],
    ['equal Lamport → conflict (canonical wins tie)', 4, inboxRow('a', 4), 'conflict'],
    ['stale push → conflict', 9, inboxRow('a', 4), 'conflict'],
    ['newer tombstone → tombstoned', 3, inboxRow('a', 7, { sync_deleted_at: 7 }), 'tombstoned']
  ]
  for (const [name, canonical, row, expected] of cases) {
    it(name, () => {
      expect(planApplyRow(canonical, row)).toBe(expected)
    })
  }
})

describe('assertApplyTables — scope guard', () => {
  it('accepts tasks + inbox_items', () => {
    expect(() => assertApplyTables([{ table: 'inbox_items', rows: [] }, { table: 'tasks', rows: [] }])).not.toThrow()
  })
  it('accepts conversation tables (TASK-1136 — append-only fold sync)', () => {
    expect(() =>
      assertApplyTables([{ table: 'conversations', rows: [] }, { table: 'conversation_messages', rows: [] }])
    ).not.toThrow()
  })
  it('rejects a non-syncable table (e.g. sessions)', () => {
    expect(() => assertApplyTables([{ table: 'sessions', rows: [] }])).toThrow(/apply scope/)
  })
  it('rejects an unknown table before any DB access', () => {
    expect(() => assertApplyTables([{ table: 'sqlite_master', rows: [] }])).toThrow(/apply scope/)
  })
})

describe('applyDeltaToSqlite — sink against in-memory SQLite', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initSchema(db)
  })

  function rawInbox(id: string): { content: string; sync_updated_at: number; sync_deleted_at: number | null; sync_origin: string } | undefined {
    return db
      .prepare('SELECT content, sync_updated_at, sync_deleted_at, sync_origin FROM inbox_items WHERE id = ?')
      .get(id) as never
  }

  it('applies a fresh push and advances the canonical clock', () => {
    const res = applyDeltaToSqlite(db, [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 5)] }], 'remote')
    expect(res).toMatchObject({ applied: 1, conflicts: 0, tombstoned: 0 })
    expect(res.verdicts[0]).toMatchObject({ id: 'INBOX-1', verdict: 'applied', canonicalLamport: 5 })
    expect(rawInbox('INBOX-1')).toMatchObject({ content: 'content-5', sync_updated_at: 5, sync_origin: 'laptop' })
    // mergeClock advanced the local counter past the pushed value.
    expect(peek(db)).toBe(5)
  })

  it('drops a stale push as a conflict, leaving the canonical row intact', () => {
    applyDeltaToSqlite(db, [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 5)] }], 'remote')
    const res = applyDeltaToSqlite(db, [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 3)] }], 'remote')
    expect(res).toMatchObject({ applied: 0, conflicts: 1 })
    expect(res.verdicts[0]).toMatchObject({ verdict: 'conflict', canonicalLamport: 5 })
    expect(rawInbox('INBOX-1')?.content).toBe('content-5') // unchanged
  })

  it('applies a strictly-newer push over an existing row', () => {
    applyDeltaToSqlite(db, [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 5)] }], 'remote')
    const res = applyDeltaToSqlite(db, [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 7)] }], 'remote')
    expect(res).toMatchObject({ applied: 1 })
    expect(rawInbox('INBOX-1')?.content).toBe('content-7')
  })

  it('soft-deletes on a winning tombstone (keeps the row for propagation)', () => {
    applyDeltaToSqlite(db, [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 5)] }], 'remote')
    const res = applyDeltaToSqlite(
      db,
      [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 9, { sync_deleted_at: 9 })] }],
      'remote'
    )
    expect(res).toMatchObject({ tombstoned: 1 })
    const row = rawInbox('INBOX-1')
    expect(row).toBeDefined() // still present (soft delete)
    expect(row?.sync_deleted_at).toBe(9)
  })

  it('refuses an out-of-scope table without writing', () => {
    expect(() =>
      applyDeltaToSqlite(db, [{ table: 'sessions', rows: [] }], 'remote')
    ).toThrow(/apply scope/)
  })
})

// TASK-1508 AC-5 — a tie is not always a loss.
//
// sync-write-through enqueues to pending_ops in its CATCH block, so a push that SUCCEEDS
// remotely but whose response is lost gets re-pushed at the same Lamport. Under a bare
// `<=` the store reports our own accepted write back as dropped, and the laptop says
// "your local change was not applied" about a write that WAS applied.
describe('planApplyRow — idempotent re-delivery vs a genuine tie (TASK-1508 AC-5)', () => {
  const at = (lamport: number, origin: string | null = 'laptop'): PulledRow => ({
    id: 'R1',
    content: 'x',
    sync_updated_at: lamport,
    sync_deleted_at: null,
    sync_origin: origin
  })

  it('equal lamport from the SAME origin is a re-delivery, not a conflict', () => {
    expect(planApplyRow(7, at(7), { origin: 'laptop', pushOrigin: 'laptop' })).toBe('applied')
  })

  it('equal lamport from a DIFFERENT origin is still a genuine tie and still loses', () => {
    // The discriminator. Without this, "never conflict at equality" would also pass the
    // test above while silently dropping a real concurrent write from another device.
    expect(planApplyRow(7, at(7), { origin: 'desktop', pushOrigin: 'laptop' })).toBe('conflict')
  })

  it('a strictly lower lamport still loses, even from the same origin', () => {
    // Same device, genuinely stale write — that IS a loss and must still be reported.
    expect(planApplyRow(9, at(7), { origin: 'laptop', pushOrigin: 'laptop' })).toBe('conflict')
  })

  it('equal lamport with an UNKNOWN canonical origin stays a conflict', () => {
    // Conservative: a null origin (seeded/imported row) proves nothing about ownership,
    // so the old behaviour stands rather than assuming the write is ours.
    expect(planApplyRow(7, at(7), { origin: null, pushOrigin: 'laptop' })).toBe('conflict')
  })

  it('keeps the old behaviour when no canonical state is supplied', () => {
    // The third argument is optional so existing callers are unaffected.
    expect(planApplyRow(7, at(7))).toBe('conflict')
  })

  it('a re-delivered TOMBSTONE at equal lamport is applied as a tombstone, not a conflict', () => {
    const deleted: PulledRow = { ...at(7), sync_deleted_at: 123 }
    expect(planApplyRow(7, deleted, { origin: 'laptop', pushOrigin: 'laptop' })).toBe('tombstoned')
  })

  it('a higher lamport is unaffected by any of this', () => {
    expect(planApplyRow(5, at(9), { origin: 'desktop', pushOrigin: 'laptop' })).toBe('applied')
    expect(planApplyRow(null, at(1))).toBe('applied')
  })
})

// TASK-3128 — a pushed project row carrying `purpose` sets it on the receiving side.
describe('applyDeltaToSqlite — projects.purpose', () => {
  it('applies a project row and stores its purpose', () => {
    const db = new Database(':memory:')
    initSchema(db)
    const row: PulledRow = {
      id: 'np',
      name: 'New Project',
      cwd: '/np',
      org: null,
      purpose: 'reputation',
      sync_updated_at: 7,
      sync_deleted_at: null,
      sync_origin: 'laptop'
    }
    const result = applyDeltaToSqlite(db, [{ table: 'projects', rows: [row] }], 'laptop')
    expect(result.applied).toBe(1)
    const stored = db.prepare('SELECT purpose FROM projects WHERE id = ?').get('np') as {
      purpose: string
    }
    expect(stored.purpose).toBe('reputation')
    db.close()
  })
})

// TASK-3202 — a node that writes before its first pull stamps rows 1..n, below
// the cursor every other node already holds; `since` is strictly greater-than,
// so nobody would ever fetch them. The sink lifts such a row to clock + 1 and
// says so in the verdict. Rows already above the clock are untouched.
describe('applyDeltaToSqlite — re-stamp below the canonical clock (TASK-3202)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initSchema(db)
    mergeClock(db, 5000) // canonical already holds rows up to 5000
  })

  function stampOf(id: string): { sync_updated_at: number; sync_deleted_at: number | null } {
    return db
      .prepare('SELECT sync_updated_at, sync_deleted_at FROM inbox_items WHERE id = ?')
      .get(id) as never
  }

  it('a row stamped below the clock is stored at clock + 1, and the verdict carries it', () => {
    const res = applyDeltaToSqlite(db, [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 1)] }], 'laptop')
    expect(res.verdicts[0]).toMatchObject({ verdict: 'applied', canonicalLamport: 5001, stamped: 5001 })
    expect(stampOf('INBOX-1').sync_updated_at).toBe(5001)
    expect(peek(db)).toBe(5001)
  })

  it('CONTROL — a row stamped above the clock keeps its own value (LWW order intact)', () => {
    const res = applyDeltaToSqlite(db, [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 7000)] }], 'laptop')
    expect(res.verdicts[0]).toMatchObject({ canonicalLamport: 7000, stamped: 7000 })
    expect(stampOf('INBOX-1').sync_updated_at).toBe(7000)
    expect(peek(db)).toBe(7000)
  })

  it('rows in one push get distinct, ascending stamps', () => {
    const res = applyDeltaToSqlite(
      db,
      [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 1), inboxRow('INBOX-2', 2)] }],
      'laptop'
    )
    expect(res.verdicts.map((v) => v.stamped)).toEqual([5001, 5002])
    expect(peek(db)).toBe(5002)
  })

  it('a tombstone below the clock is lifted on both columns', () => {
    // A row that sits below the clock: written at 10 while the clock was 0, then
    // the clock moved on to 5000 (other nodes' pushes).
    const fresh = new Database(':memory:')
    initSchema(fresh)
    applyDeltaToSqlite(fresh, [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 10)] }], 'laptop')
    mergeClock(fresh, 5000)
    const res = applyDeltaToSqlite(
      fresh,
      [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 11, { sync_deleted_at: 11 })] }],
      'laptop'
    )
    expect(res.verdicts[0]).toMatchObject({ verdict: 'tombstoned', stamped: 5001 })
    const row = fresh
      .prepare('SELECT sync_updated_at, sync_deleted_at FROM inbox_items WHERE id = ?')
      .get('INBOX-1')
    expect(row).toEqual({ sync_updated_at: 5001, sync_deleted_at: 5001 })
  })

  it('a tombstone for a row canonical never saw still reports a lifted stamp', () => {
    const res = applyDeltaToSqlite(
      db,
      [{ table: 'inbox_items', rows: [inboxRow('INBOX-9', 1, { sync_deleted_at: 1 })] }],
      'laptop'
    )
    expect(res.verdicts[0]).toMatchObject({ verdict: 'tombstoned', stamped: 5001 })
    expect(peek(db)).toBe(5001)
  })

  it('an idempotent re-delivery keeps its value — the TASK-1508 tie exemption survives', () => {
    applyDeltaToSqlite(db, [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 7000)] }], 'laptop')
    const again = applyDeltaToSqlite(db, [{ table: 'inbox_items', rows: [inboxRow('INBOX-1', 7000)] }], 'laptop')
    expect(again.verdicts[0]).toMatchObject({ verdict: 'applied', stamped: 7000 })
    expect(stampOf('INBOX-1').sync_updated_at).toBe(7000)
    expect(peek(db)).toBe(7000) // not bumped — nothing changed
  })
})
