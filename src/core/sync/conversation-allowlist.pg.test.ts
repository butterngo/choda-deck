// TASK-1136 (AC-4) — the remote allowlist's conversation tools backed by real
// Postgres: open + add + read + list round-trip, and a laptop-synced decision
// recomputes the PG header so a direct read shows `decided`. Self-skips w/o Docker.

import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../test/postgres-harness'
import { PostgresTaskService } from '../domain/postgres-task-service'
import type { PulledRow } from './sync-pull'

describeIfDocker('TASK-1136 AC-4 — conversation tools on Postgres', () => {
  let env: PgTestEnv
  let pgSvc: PostgresTaskService

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    pgSvc = new PostgresTaskService(env.conn)
    await pgSvc.initializeAsync()
    await env.conn.query("INSERT INTO projects (id, name, cwd) VALUES ('p', 'P', '/p')")
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  it('open + add + read + list round-trip directly on PG', async () => {
    const conv = await pgSvc.openConversation({
      projectId: 'p',
      title: 'Design auth',
      createdBy: 'Design',
      participants: [{ name: 'Design' }, { name: 'Code' }],
      initialMessage: { content: 'kickoff' }
    })
    expect(conv.status).toBe('open')

    await pgSvc.addConversationMessage({
      conversationId: conv.id,
      authorName: 'Design',
      content: 'a question'
    })

    const got = await pgSvc.getConversation(conv.id)
    expect(got?.title).toBe('Design auth')

    const msgs = await pgSvc.getConversationMessages(conv.id)
    expect(msgs.map((m) => m.content)).toEqual(['kickoff', 'a question'])
    expect(msgs.map((m) => m.kind)).toEqual(['message', 'message'])

    const parts = await pgSvc.getConversationParticipants(conv.id)
    expect(parts.map((p) => p.name).sort()).toEqual(['Code', 'Design'])

    const all = await pgSvc.findConversations('p')
    expect(all.some((c) => c.id === conv.id)).toBe(true)
    const open = await pgSvc.findConversations('p', 'open')
    expect(open.some((c) => c.id === conv.id)).toBe(true)
  })

  it('a laptop-synced decision recomputes the PG header to decided', async () => {
    const conv = await pgSvc.openConversation({
      projectId: 'p',
      title: 'Ship?',
      createdBy: 'Code',
      participants: [{ name: 'Code' }],
      initialMessage: { content: 'proposal' }
    })

    const msgRow = (id: string, kind: string, content: string, author: string, lamport: number, at: string): PulledRow => ({
      id,
      conversation_id: conv.id,
      author_name: author,
      content,
      kind,
      created_at: at,
      sync_updated_at: lamport,
      sync_deleted_at: null,
      sync_origin: 'laptop'
    })

    // Decision + the sole participant's signoff arrive from the laptop via /sync/apply.
    await pgSvc.applyDelta(
      [
        {
          table: 'conversation_messages',
          rows: [
            msgRow('MSG-DEC', 'decision', 'Ship it', 'Code', 500, '2026-06-19T11:00:00Z'),
            msgRow('MSG-SIG', 'signoff', '', 'Code', 501, '2026-06-19T11:01:00Z')
          ]
        }
      ],
      'laptop'
    )

    const got = await pgSvc.getConversation(conv.id)
    expect(got?.status).toBe('decided')
    expect(got?.decisionSummary).toBe('Ship it')
    expect(got?.signedOff).toEqual(['Code'])
  })
})
