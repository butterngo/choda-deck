import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  createSyncClockTables,
  tick,
  peek,
  getLastPullAt,
  setLastPullAt
} from './lamport-clock'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  createSyncClockTables(db)
})

afterEach(() => {
  db.close()
})

describe('lamport-clock', () => {
  it('starts at 0 before any tick', () => {
    expect(peek(db)).toBe(0)
  })

  it('tick returns a strictly monotonic increasing value', () => {
    expect(tick(db)).toBe(1)
    expect(tick(db)).toBe(2)
    expect(tick(db)).toBe(3)
    expect(peek(db)).toBe(3)
  })

  it('createSyncClockTables is idempotent and preserves the counter', () => {
    tick(db)
    tick(db)
    createSyncClockTables(db) // second call must not reset
    expect(peek(db)).toBe(2)
    expect(tick(db)).toBe(3)
  })

  it('pins a single _sync_clock row (CHECK id = 0)', () => {
    const rows = db.prepare('SELECT id FROM _sync_clock').all() as Array<{ id: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(0)
  })

  it('tick throws when the clock table is missing', () => {
    const bare = new Database(':memory:')
    // better-sqlite3 throws "no such table" at prepare-time before the row guard.
    expect(() => tick(bare)).toThrow(/_sync_clock/)
    bare.close()
  })

  it('last_pull_at defaults to 0 and round-trips', () => {
    expect(getLastPullAt(db)).toBe(0)
    setLastPullAt(db, 42)
    expect(getLastPullAt(db)).toBe(42)
  })
})
