import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { computeHealth } from './sync-health'
import {
  ensureLoopStatusColumns,
  writeLoopHeartbeat,
  readLoopStatus
} from '../../core/sync/sync-loop-status'

// `_sync_state` is the singleton heartbeat row; create it the way lamport-clock
// does, then let the loop-status module add its columns.
function fixtureDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE _sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 0),
      last_pull_at INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec('INSERT INTO _sync_state (id, last_pull_at) VALUES (0, 0)')
  ensureLoopStatusColumns(db)
  return db
}

describe('loop-status heartbeat', () => {
  it('round-trips a written heartbeat', () => {
    const db = fixtureDb()
    writeLoopHeartbeat(db, {
      at: '2026-06-20T10:00:00.000Z',
      pulled: true,
      reachable: true,
      jwtState: 'refresh'
    })
    expect(readLoopStatus(db)).toEqual({
      lastRunAt: '2026-06-20T10:00:00.000Z',
      lastPullAt: '2026-06-20T10:00:00.000Z',
      reachable: true,
      jwtState: 'refresh'
    })
    db.close()
  })

  it('does not advance lastPullAt on an offline (non-pulled) cycle', () => {
    const db = fixtureDb()
    writeLoopHeartbeat(db, {
      at: '2026-06-20T10:00:00.000Z',
      pulled: true,
      reachable: true,
      jwtState: 'static'
    })
    writeLoopHeartbeat(db, {
      at: '2026-06-20T10:05:00.000Z',
      pulled: false,
      reachable: false,
      jwtState: 'static'
    })
    const status = readLoopStatus(db)!
    expect(status.lastRunAt).toBe('2026-06-20T10:05:00.000Z')
    expect(status.lastPullAt).toBe('2026-06-20T10:00:00.000Z')
    db.close()
  })
})

describe('computeHealth', () => {
  const intervalMs = 30000

  it('reports loop down when no heartbeat exists', () => {
    const db = fixtureDb()
    expect(computeHealth(db, { intervalMs, nowMs: Date.parse('2026-06-20T10:00:00Z') })).toEqual({
      loopAlive: false,
      lastPullAgeSec: null,
      jwtState: 'unknown',
      reachable: false
    })
    db.close()
  })

  it('reports alive within the staleness window and a real pull age', () => {
    const db = fixtureDb()
    writeLoopHeartbeat(db, {
      at: '2026-06-20T10:00:00.000Z',
      pulled: true,
      reachable: true,
      jwtState: 'refresh'
    })
    // 20s later — inside 2× the 30s window.
    const health = computeHealth(db, { intervalMs, nowMs: Date.parse('2026-06-20T10:00:20Z') })
    expect(health.loopAlive).toBe(true)
    expect(health.lastPullAgeSec).toBe(20)
    expect(health.jwtState).toBe('refresh')
    db.close()
  })

  it('reports loop down when the heartbeat is older than 2× the cadence', () => {
    const db = fixtureDb()
    writeLoopHeartbeat(db, {
      at: '2026-06-20T10:00:00.000Z',
      pulled: true,
      reachable: true,
      jwtState: 'static'
    })
    // 90s later — past 2×30s.
    const health = computeHealth(db, { intervalMs, nowMs: Date.parse('2026-06-20T10:01:30Z') })
    expect(health.loopAlive).toBe(false)
    db.close()
  })
})
