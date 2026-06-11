// ADR-030 Phase 3 (979a) — write-apply LWW core. Docker-free: the pure decision
// function plus the SQLite sink against an in-memory DB. The Postgres sink +
// /sync/apply endpoint are covered by sync-apply.pg.test.ts (Docker-gated).

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../domain/repositories/schema'
import { applyDeltaToSqlite } from './sync-sink'
import { planApplyRow, assertApplyTables, type ApplyVerdict } from './sync-apply'
import { peek } from './lamport-clock'
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
  it('rejects conversation_messages (deferred to 979e)', () => {
    expect(() => assertApplyTables([{ table: 'conversation_messages', rows: [] }])).toThrow(/apply scope/)
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
      applyDeltaToSqlite(db, [{ table: 'conversation_messages', rows: [] }], 'remote')
    ).toThrow(/apply scope/)
  })
})
