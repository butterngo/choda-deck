// TASK-1136 — end-to-end conversation sync against real Postgres: laptop1 opens
// + decides + signs off (write-through → POST /sync/apply → canonical PG), then a
// second laptop pulls and the folded header (status/decisionSummary) converges.
// Self-skips when Docker is unavailable.

import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../test/postgres-harness'
import { PostgresTaskService } from '../domain/postgres-task-service'
import { SqliteTaskService } from '../domain/sqlite-task-service'
import { startHttpTransport, type HttpTransportHandle } from '../../adapters/mcp/http-transport'
import { wrapWithSyncWriteThrough } from './sync-write-through'
import { HttpWriteClient } from './http-write-client'
import { startSyncLoop } from './sync-loop'

const TOKEN = 'conv-e2e-token'

describeIfDocker('TASK-1136 — conversation sync laptop → PG → laptop', () => {
  let env: PgTestEnv
  let pgSvc: PostgresTaskService
  let server: HttpTransportHandle
  let remoteUrl: string

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    pgSvc = new PostgresTaskService(env.conn)
    await pgSvc.initializeAsync()
    await env.conn.query("INSERT INTO projects (id, name, cwd) VALUES ('p', 'P', '/p')")
    server = await startHttpTransport(() => Promise.reject(new Error('mcp factory unused')), {
      port: 0,
      bind: '127.0.0.1',
      token: TOKEN,
      syncSource: { fetchSince: (since) => pgSvc.fetchSince(since) },
      syncSink: { applyDelta: (deltas, origin) => pgSvc.applyDelta(deltas, origin) }
    })
    remoteUrl = `http://127.0.0.1:${server.address.port}`
  }, 120_000)

  afterAll(async () => {
    if (server) await server.close()
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  it('a decided conversation round-trips to a second laptop with a converged header', async () => {
    // laptop1 — write-through to the real canonical PG.
    const lap1 = new SqliteTaskService(':memory:')
    await lap1.ensureProject('p', 'P', '/p')
    const wrapped = wrapWithSyncWriteThrough(lap1, new HttpWriteClient({ remoteUrl, token: TOKEN }))
    const conv = await wrapped.openConversation({
      projectId: 'p',
      title: 'Design auth',
      createdBy: 'Butter',
      participants: [{ name: 'Butter' }],
      initialMessage: { content: 'how?' }
    })
    await wrapped.decideConversation(conv.id, { author: 'Butter', decision: 'Use Option A' })
    await wrapped.signoffConversation(conv.id, 'Butter')
    expect((await lap1.getConversation(conv.id))?.status).toBe('decided')

    // Canonical PG has the typed turns.
    const pgKinds = await env.conn.query<{ kind: string }>(
      'SELECT kind FROM conversation_messages WHERE conversation_id = $1 ORDER BY created_at',
      [conv.id]
    )
    expect(pgKinds.rows.map((r) => r.kind)).toEqual(['message', 'decision', 'signoff'])

    // laptop2 — fresh SQLite, pulls from canonical PG. Project must exist locally
    // for the FK (the test project was inserted directly, so it isn't synced).
    const lap2 = new SqliteTaskService(':memory:')
    await lap2.ensureProject('p', 'P', '/p')
    const loop2 = startSyncLoop({ db: lap2.syncDatabase, remoteUrl, token: TOKEN, intervalMs: 10_000_000 })
    await loop2.runOnce()
    loop2.stop()

    const conv2 = await lap2.getConversation(conv.id)
    expect(conv2?.status).toBe('decided')
    expect(conv2?.decisionSummary).toBe('Use Option A')
    const msgs2 = await lap2.getConversationMessages(conv.id)
    expect(msgs2.map((m) => m.kind)).toEqual(['message', 'decision', 'signoff'])

    lap1.close()
    lap2.close()
  })
})
