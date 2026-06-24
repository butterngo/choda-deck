import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { initSchema } from '../../core/domain/repositories/schema'
import { createPendingOpsTable, enqueueOp } from '../../core/sync/pending-ops'
import type { PullSource, TableDelta } from '../../core/sync/sync-pull'
import type { ApplySink } from '../../core/sync/sync-apply'
import { runPull, runPush, resolveRemoteConfig, SyncNotConfiguredError } from './sync-actions'

const cfg = { remoteUrl: 'http://fake', token: 't' }
let dbFiles: string[] = []

function tempDbPath(tag: string): string {
  // unique per call without Date.now() — counter + tag
  const p = join(tmpdir(), `companion-sync-${tag}-${dbFiles.length}.db`)
  dbFiles.push(p)
  return p
}

afterEach(() => {
  for (const f of dbFiles) {
    try {
      rmSync(f, { force: true })
      rmSync(`${f}-wal`, { force: true })
      rmSync(`${f}-shm`, { force: true })
    } catch {
      /* best effort */
    }
  }
  dbFiles = []
})

describe('resolveRemoteConfig (AC-3 guard)', () => {
  it('throws SyncNotConfiguredError when CHODA_PULL_REMOTE_URL is unset', () => {
    expect(() => resolveRemoteConfig({})).toThrow(SyncNotConfiguredError)
  })

  it('resolves url + token (falling back to MCP_HTTP_TOKEN)', () => {
    expect(resolveRemoteConfig({ CHODA_PULL_REMOTE_URL: 'http://r', MCP_HTTP_TOKEN: 'k' })).toEqual({
      remoteUrl: 'http://r',
      token: 'k'
    })
  })
})

describe('runPull (AC-1)', () => {
  it('drains a remote delta into local SQLite and reports the summary', async () => {
    const dbPath = tempDbPath('pull')
    // pre-create the file + schema so the row has somewhere to land
    const seed = new Database(dbPath)
    initSchema(seed)
    seed.close()

    const delta: TableDelta = {
      table: 'inbox_items',
      rows: [
        {
          id: 'INBOX-900',
          sync_updated_at: 5,
          sync_deleted_at: null,
          sync_origin: 'remote',
          project_id: null,
          content: 'from remote',
          status: 'raw',
          created_at: '2026-06-21T00:00:00.000Z',
          updated_at: '2026-06-21T00:00:00.000Z'
        }
      ]
    }
    const source: PullSource = { fetchSince: async () => [delta] }

    const result = await runPull(dbPath, cfg, { source })
    expect(result.upserted).toBe(1)

    const check = new Database(dbPath, { readonly: true })
    const row = check.prepare("SELECT sync_origin FROM inbox_items WHERE id = 'INBOX-900'").get() as
      | { sync_origin: string }
      | undefined
    check.close()
    expect(row?.sync_origin).toBe('remote')
  })
})

describe('runPush (AC-2)', () => {
  it('drains the pending_ops queue to the remote via the sink', async () => {
    const dbPath = tempDbPath('push')
    const seed = new Database(dbPath)
    initSchema(seed)
    createPendingOpsTable(seed)
    enqueueOp(seed, {
      tableName: 'tasks',
      rowId: 'TASK-900',
      op: 'upsert',
      row: { id: 'TASK-900', sync_updated_at: 9, sync_deleted_at: null },
      lamport: 9,
      enqueuedAt: 1
    })
    seed.close()

    // fake remote that accepts everything (no LWW conflict)
    const sink: ApplySink = {
      applyDelta: async (deltas) => {
        const verdicts = deltas.flatMap((d) =>
          d.rows.map((r) => ({
            table: d.table,
            id: r.id,
            verdict: 'applied' as const,
            canonicalLamport: r.sync_updated_at
          }))
        )
        return { applied: verdicts.length, tombstoned: 0, conflicts: 0, verdicts }
      }
    }

    const result = await runPush(dbPath, cfg, { sink, isReachable: async () => true })
    expect(result).toMatchObject({ drained: 1, conflicts: 0, remaining: 0, reachable: true })
  })

  it('is a no-op when the remote is unreachable (nothing drained, queue intact)', async () => {
    const dbPath = tempDbPath('push-offline')
    const seed = new Database(dbPath)
    initSchema(seed)
    createPendingOpsTable(seed)
    enqueueOp(seed, {
      tableName: 'tasks',
      rowId: 'TASK-901',
      op: 'upsert',
      row: { id: 'TASK-901', sync_updated_at: 1, sync_deleted_at: null },
      lamport: 1,
      enqueuedAt: 1
    })
    seed.close()

    const sink: ApplySink = {
      applyDelta: async () => ({ applied: 0, tombstoned: 0, conflicts: 0, verdicts: [] })
    }
    const result = await runPush(dbPath, cfg, { sink, isReachable: async () => false })
    expect(result).toMatchObject({ drained: 0, remaining: 1, reachable: false })
  })
})
