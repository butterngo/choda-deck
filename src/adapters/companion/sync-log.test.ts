import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSyncEventsTable, appendSyncEvent } from '../../core/sync/sync-events'
import {
  computeSyncLog,
  resolveSyncLogLimit,
  DEFAULT_SYNC_LOG_LIMIT,
  MAX_SYNC_LOG_LIMIT
} from './sync-log'

// Seed the real sync_events table with N events; `at` ascending so newest-by-id is
// also newest-by-time. Returns the db.
function seededDb(n: number): Database.Database {
  const db = new Database(':memory:')
  createSyncEventsTable(db)
  for (let i = 0; i < n; i++) {
    // cap high enough that seeding never triggers retention pruning
    appendSyncEvent(db, { at: 1000 + i, kind: 'pull', upserted: i }, 10_000)
  }
  return db
}

describe('resolveSyncLogLimit', () => {
  it('defaults when the limit is omitted or NaN', () => {
    expect(resolveSyncLogLimit(undefined)).toBe(DEFAULT_SYNC_LOG_LIMIT)
    expect(resolveSyncLogLimit(NaN)).toBe(DEFAULT_SYNC_LOG_LIMIT)
  })

  it('hard-caps an over-large limit and floors at 1', () => {
    expect(resolveSyncLogLimit(9999)).toBe(MAX_SYNC_LOG_LIMIT)
    expect(resolveSyncLogLimit(0)).toBe(1)
    expect(resolveSyncLogLimit(-5)).toBe(1)
  })

  it('passes a sane limit through, truncating fractions', () => {
    expect(resolveSyncLogLimit(25)).toBe(25)
    expect(resolveSyncLogLimit(25.9)).toBe(25)
  })
})

describe('computeSyncLog', () => {
  it('returns events newest-first', () => {
    const db = seededDb(3)
    const events = computeSyncLog(db, 10)
    expect(events.map((e) => e.at)).toEqual([1002, 1001, 1000])
    db.close()
  })

  it('honors an explicit limit', () => {
    const db = seededDb(5)
    expect(computeSyncLog(db, 2)).toHaveLength(2)
    db.close()
  })

  it('caps at MAX even when more rows exist', () => {
    const db = seededDb(MAX_SYNC_LOG_LIMIT + 20)
    expect(computeSyncLog(db, 9999)).toHaveLength(MAX_SYNC_LOG_LIMIT)
    db.close()
  })

  it('defaults to DEFAULT_SYNC_LOG_LIMIT when limit is omitted', () => {
    const db = seededDb(DEFAULT_SYNC_LOG_LIMIT + 10)
    expect(computeSyncLog(db)).toHaveLength(DEFAULT_SYNC_LOG_LIMIT)
    db.close()
  })

  it('returns an empty array when the log is empty', () => {
    const db = new Database(':memory:')
    createSyncEventsTable(db)
    expect(computeSyncLog(db)).toEqual([])
    db.close()
  })
})
