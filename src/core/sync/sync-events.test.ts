// TASK-1214 — sync_events log + loop instrumentation. Docker-free: in-memory
// SQLite + fake ApplySink / PullSource (mirrors sync-drain.test.ts + sync-pull.test.ts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../domain/repositories/schema'
import {
  createSyncEventsTable,
  appendSyncEvent,
  listSyncEvents,
  pruneSyncEvents,
  syncEventsCap,
  DEFAULT_SYNC_EVENTS_CAP
} from './sync-events'
import { enqueueOp } from './pending-ops'
import { runSyncCycle } from './sync-loop'
import type { ApplySink, ApplyResult, RowVerdict } from './sync-apply'
import type { PullSource, TableDelta, PulledRow } from './sync-pull'

// ---- fakes ---------------------------------------------------------------

function row(id: string, lamport: number): PulledRow {
  return { id, content: 'x', sync_updated_at: lamport, sync_deleted_at: null, sync_origin: 'laptop' }
}

// Sink whose verdict per row id is scripted; unknown ids default to 'applied'.
class ScriptedSink implements ApplySink {
  constructor(private readonly verdicts: Record<string, RowVerdict['verdict']> = {}) {}
  async applyDelta(deltas: TableDelta[], _origin: string): Promise<ApplyResult> {
    const verdicts: RowVerdict[] = []
    for (const d of deltas) {
      for (const r of d.rows) {
        const v = this.verdicts[r.id] ?? 'applied'
        verdicts.push({
          table: d.table,
          id: r.id,
          verdict: v,
          canonicalLamport: v === 'conflict' ? 99 : r.sync_updated_at
        })
      }
    }
    return {
      applied: verdicts.filter((v) => v.verdict === 'applied').length,
      tombstoned: verdicts.filter((v) => v.verdict === 'tombstoned').length,
      conflicts: verdicts.filter((v) => v.verdict === 'conflict').length,
      verdicts
    }
  }
}

function pullSource(deltas: TableDelta[]): PullSource {
  return { fetchSince: async () => deltas }
}

const taskRow = (id: string, sync_updated_at: number): Record<string, unknown> => ({
  id,
  project_id: 'p',
  title: 'remote',
  status: 'TODO',
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  sync_updated_at,
  sync_deleted_at: null
})

// ---- AC-1 / AC-4 : the events repo ---------------------------------------

describe('sync-events repo', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    createSyncEventsTable(db)
  })
  afterEach(() => db.close())

  it('AC-1: appends an event with all columns and reads it back newest-first', () => {
    appendSyncEvent(db, { at: 100, kind: 'pull', upserted: 3, tombstoned: 1 })
    appendSyncEvent(db, { at: 200, kind: 'drain', pushed: 2 })
    appendSyncEvent(db, { at: 300, kind: 'conflict', conflicts: 1, note: 'upsert tasks T1 dropped' })

    const events = listSyncEvents(db)
    expect(events.map((e) => e.kind)).toEqual(['conflict', 'drain', 'pull']) // newest-first
    expect(events[2]).toMatchObject({ at: 100, kind: 'pull', upserted: 3, tombstoned: 1, pushed: 0, conflicts: 0, note: null })
    expect(events[0]).toMatchObject({ at: 300, kind: 'conflict', conflicts: 1, note: 'upsert tasks T1 dropped' })
  })

  it('AC-1: rejects an unknown kind (CHECK constraint)', () => {
    expect(() => appendSyncEvent(db, { at: 1, kind: 'bogus' as never })).toThrow()
  })

  it('AC-4: retention prunes oldest-first, never exceeding the cap', () => {
    const cap = 5
    for (let i = 1; i <= 20; i++) appendSyncEvent(db, { at: i, kind: 'pull', upserted: i }, cap)

    const events = listSyncEvents(db)
    expect(events).toHaveLength(cap)
    // Kept the 5 newest (at 16..20), pruned 1..15.
    expect(events.map((e) => e.at)).toEqual([20, 19, 18, 17, 16])
  })

  it('AC-4: pruneSyncEvents is idempotent under the cap', () => {
    appendSyncEvent(db, { at: 1, kind: 'pull' }, 10)
    appendSyncEvent(db, { at: 2, kind: 'pull' }, 10)
    expect(pruneSyncEvents(db, 10)).toBe(0) // already within cap
    expect(listSyncEvents(db)).toHaveLength(2)
  })

  it('syncEventsCap reads CHODA_SYNC_EVENTS_CAP, else falls back to the default', () => {
    expect(syncEventsCap({} as NodeJS.ProcessEnv)).toBe(DEFAULT_SYNC_EVENTS_CAP)
    expect(syncEventsCap({ CHODA_SYNC_EVENTS_CAP: '42' } as never)).toBe(42)
    expect(syncEventsCap({ CHODA_SYNC_EVENTS_CAP: 'nope' } as never)).toBe(DEFAULT_SYNC_EVENTS_CAP)
    expect(syncEventsCap({ CHODA_SYNC_EVENTS_CAP: '-1' } as never)).toBe(DEFAULT_SYNC_EVENTS_CAP)
  })
})

// ---- AC-2 / AC-3 : loop instrumentation ----------------------------------

describe('runSyncCycle — sync_events instrumentation', () => {
  let db: Database.Database
  let at: number
  const nowMs = (): number => ++at // monotonic, deterministic
  const nowIso = (): string => '2026-06-30T00:00:00.000Z'
  const reachable = (): Promise<boolean> => Promise.resolve(true)

  beforeEach(() => {
    db = new Database(':memory:')
    initSchema(db) // full schema: pending_ops, sync_conflicts, sync_events, _sync_state, tasks…
    db.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p', 'P', '/p')").run()
    at = 0
  })
  afterEach(() => db.close())

  function enqueue(id: string, lamport: number): void {
    enqueueOp(db, { tableName: 'inbox_items', rowId: id, op: 'upsert', row: row(id, lamport), lamport, enqueuedAt: lamport })
  }

  it('AC-2: a draining + pulling cycle appends a drain event and a pull event', async () => {
    enqueue('A', 1)
    enqueue('B', 2)
    await runSyncCycle({
      db,
      client: new ScriptedSink(),
      pullSource: pullSource([{ table: 'tasks', rows: [taskRow('T1', 7) as never] }]),
      origin: 'laptop',
      isReachable: reachable,
      jwtState: 'none',
      nowMs,
      nowIso
    })

    const events = listSyncEvents(db)
    const pull = events.find((e) => e.kind === 'pull')
    const drain = events.find((e) => e.kind === 'drain')
    expect(drain).toMatchObject({ pushed: 2 })
    expect(pull).toMatchObject({ upserted: 1, tombstoned: 0 })
  })

  it('AC-2: a no-op cycle (nothing drained, nothing pulled) appends no event', async () => {
    await runSyncCycle({
      db,
      client: new ScriptedSink(),
      pullSource: pullSource([]),
      origin: 'laptop',
      isReachable: reachable,
      jwtState: 'none',
      nowMs,
      nowIso
    })
    expect(listSyncEvents(db)).toHaveLength(0)
  })

  it('AC-3: a dropped op appends a conflict event AND a sync_conflicts row + raw inbox item', async () => {
    enqueue('A', 1)
    await runSyncCycle({
      db,
      client: new ScriptedSink({ A: 'conflict' }),
      pullSource: pullSource([]),
      origin: 'laptop',
      isReachable: reachable,
      jwtState: 'none',
      nowMs,
      nowIso
    })

    const conflictEvents = listSyncEvents(db).filter((e) => e.kind === 'conflict')
    expect(conflictEvents).toHaveLength(1)
    expect(conflictEvents[0]).toMatchObject({ conflicts: 1 })
    expect(conflictEvents[0].note).toContain('A')
    expect(conflictEvents[0].note).toContain('inbox_items')

    // No double-loss: the durable conflict row and the raw inbox surface both exist.
    const conflictRows = db.prepare('SELECT row_id FROM sync_conflicts').all()
    expect(conflictRows).toEqual([{ row_id: 'A' }])
    const inbox = db.prepare("SELECT content FROM inbox_items WHERE content LIKE '%sync conflict%'").all()
    expect(inbox).toHaveLength(1)
  })
})

// ---- TASK-1508 : the inbox is for humans, not for every dropped upsert ----------

/**
 * Sink that returns the row's OWN lamport as the canonical value — the equality case.
 * ScriptedSink hardcodes canonicalLamport 99, which is always a strict loss, so it
 * cannot reach the branch this suite is about.
 */
class EqualityConflictSink implements ApplySink {
  async applyDelta(deltas: TableDelta[], _origin: string): Promise<ApplyResult> {
    const verdicts: RowVerdict[] = []
    for (const d of deltas) {
      for (const r of d.rows) {
        verdicts.push({
          table: d.table,
          id: r.id,
          verdict: 'conflict',
          canonicalLamport: r.sync_updated_at // equal → nothing was actually lost
        })
      }
    }
    return { applied: 0, tombstoned: 0, conflicts: verdicts.length, verdicts }
  }
}

describe('runSyncCycle — conflict inbox noise (TASK-1508)', () => {
  let db: Database.Database
  let at: number
  const nowMs = (): number => ++at
  const nowIso = (): string => '2026-08-05T00:00:00.000Z'
  const reachable = (): Promise<boolean> => Promise.resolve(true)

  beforeEach(() => {
    db = new Database(':memory:')
    initSchema(db)
    at = 0
  })
  afterEach(() => db.close())

  const enqueue = (id: string, lamport: number): void =>
    enqueueOp(db, {
      tableName: 'inbox_items',
      rowId: id,
      op: 'upsert',
      row: row(id, lamport),
      lamport,
      enqueuedAt: lamport
    })

  const cycle = (client: ApplySink): Promise<void> =>
    runSyncCycle({
      db,
      client,
      pullSource: pullSource([]),
      origin: 'laptop',
      isReachable: reachable,
      jwtState: 'none',
      nowMs,
      nowIso
    })

  const inboxRows = (): unknown[] =>
    db.prepare("SELECT content FROM inbox_items WHERE content LIKE '%sync conflict%'").all()

  it('AC-1: writes NO inbox item when local and canonical lamports are equal', async () => {
    enqueue('A', 7)
    await cycle(new EqualityConflictSink())
    expect(inboxRows()).toHaveLength(0)
  })

  it('AC-1: but still records the conflict durably — this suppresses noise, not evidence', async () => {
    // The discriminator. Without this assertion, deleting the whole conflict path
    // outright would also pass the test above.
    enqueue('A', 7)
    await cycle(new EqualityConflictSink())
    expect(db.prepare('SELECT row_id FROM sync_conflicts').all()).toEqual([{ row_id: 'A' }])
    expect(listSyncEvents(db).filter((e) => e.kind === 'conflict')).toHaveLength(1)
  })

  it('AC-1: a genuine loss (local strictly less than canonical) still reaches the inbox', async () => {
    enqueue('B', 1) // ScriptedSink answers canonical 99 → a real loss
    await cycle(new ScriptedSink({ B: 'conflict' }))
    expect(inboxRows()).toHaveLength(1)
  })

  it('AC-2: a repeated conflict on the same row does not add a second identical row', async () => {
    // The drain retries the same op across cycles, which produced byte-identical rows
    // 0.08s apart live (INBOX-1632/1633/1634 for TASK-1500).
    enqueue('C', 1)
    await cycle(new ScriptedSink({ C: 'conflict' }))
    enqueue('C', 1)
    await cycle(new ScriptedSink({ C: 'conflict' }))
    expect(inboxRows()).toHaveLength(1)
  })

  it('AC-2: a DIFFERENT row still gets its own item — dedup is not a global mute', async () => {
    enqueue('D', 1)
    await cycle(new ScriptedSink({ D: 'conflict' }))
    enqueue('E', 1)
    await cycle(new ScriptedSink({ E: 'conflict' }))
    expect(inboxRows()).toHaveLength(2)
  })

  it('reports the relation as strict, since equality no longer reaches this text', async () => {
    enqueue('F', 1)
    await cycle(new ScriptedSink({ F: 'conflict' }))
    const [item] = inboxRows() as { content: string }[]
    expect(item.content).toContain('local lamport 1 < canonical 99')
    expect(item.content).not.toContain('≤')
  })
})
