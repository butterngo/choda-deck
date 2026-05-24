import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../../../test/postgres-harness'
import { migrate } from '../migrations'
import { PostgresProjectRepository } from '../project-repository.pg'
import { PostgresSessionRepository } from '../session-repository.pg'
import { PostgresSessionEventRepository } from '../session-event-repository.pg'
import { PostgresAgentMemoryRepository } from '../agent-memory-repository.pg'

describeIfDocker('Postgres slice 7 — session_events + agent_memories', () => {
  let env: PgTestEnv
  let projects: PostgresProjectRepository
  let sessions: PostgresSessionRepository
  let events: PostgresSessionEventRepository
  let memories: PostgresAgentMemoryRepository

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
    projects = new PostgresProjectRepository(env.conn)
    sessions = new PostgresSessionRepository(env.conn)
    events = new PostgresSessionEventRepository(env.conn)
    memories = new PostgresAgentMemoryRepository(env.conn)
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    // FK order: session_events → sessions → projects.
    await env.conn.query('DELETE FROM agent_memories')
    await env.conn.query('DELETE FROM session_events')
    await env.conn.query('DELETE FROM sessions')
    await env.conn.query('DELETE FROM projects')
    await projects.ensure('p', 'P', '/abs/p')
  })

  // ── session_events ────────────────────────────────────────────────────────
  it('session_events: create + get round-trip; payload_json stays opaque string', async () => {
    const s = await sessions.create({ projectId: 'p' })
    const evt = await events.create({
      sessionId: s.id,
      eventType: 'tool_call',
      payloadJson: '{"name":"Read","args":["foo"]}'
    })
    expect(evt.id).toMatch(/^EVT-/)
    expect(evt.payloadJson).toBe('{"name":"Read","args":["foo"]}')
    expect(evt.memoryCandidate).toBe(false)

    const got = await events.get(evt.id)
    expect(got).toEqual(evt)
  })

  it('session_events: memoryCandidate boolean round-trip + listMemoryCandidates filter', async () => {
    const s = await sessions.create({ projectId: 'p' })
    await events.create({ sessionId: s.id, eventType: 'tool_call' })
    const cand = await events.create({
      sessionId: s.id,
      eventType: 'decision',
      memoryCandidate: true
    })

    expect(cand.memoryCandidate).toBe(true)
    const candidates = await events.listMemoryCandidates(s.id)
    expect(candidates.map((e) => e.id)).toEqual([cand.id])
  })

  it('session_events: listBySession ordered by created_at ASC; eventType filter', async () => {
    const s = await sessions.create({ projectId: 'p' })
    const e1 = await events.create({ sessionId: s.id, eventType: 'tool_call' })
    const e2 = await events.create({ sessionId: s.id, eventType: 'observation' })
    const e3 = await events.create({ sessionId: s.id, eventType: 'tool_call' })

    const all = await events.listBySession(s.id)
    expect(all.map((e) => e.id)).toEqual([e1.id, e2.id, e3.id])

    const toolCalls = await events.listBySession(s.id, 'tool_call')
    expect(toolCalls.map((e) => e.id)).toEqual([e1.id, e3.id])
  })

  it('session_events: FK rejects unknown session_id', async () => {
    await expect(
      events.create({ sessionId: 'NOT-A-SESSION', eventType: 'tool_call' })
    ).rejects.toThrow(/foreign key|violates|session/i)
  })

  // ── agent_memories ────────────────────────────────────────────────────────
  it('agent_memories: create defaults importance=50, recall_count=0; JSONB tags round-trip', async () => {
    const m = await memories.create({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'episodic',
      content: 'butter likes terse responses',
      tags: ['preference', 'communication']
    })
    expect(m.id).toMatch(/^MEM-/)
    expect(m.importance).toBe(50)
    expect(m.recallCount).toBe(0)
    expect(m.tags).toEqual(['preference', 'communication'])
    expect(m.lastRecalledAt).toBeNull()

    const got = await memories.get(m.id)
    expect(got).toEqual(m)
  })

  it('agent_memories: scope_type CHECK rejects invalid value', async () => {
    await expect(
      env.conn.query(
        `INSERT INTO agent_memories (id, scope_type, scope_id, memory_type, content, created_at)
         VALUES ('M-bad', 'bogus-scope', 'p', 'episodic', 'x', 'now')`
      )
    ).rejects.toThrow(/scope_type|check constraint/i)
  })

  it('agent_memories: memory_type CHECK rejects invalid value', async () => {
    await expect(
      env.conn.query(
        `INSERT INTO agent_memories (id, scope_type, scope_id, memory_type, content, created_at)
         VALUES ('M-bad', 'project', 'p', 'bogus-type', 'x', 'now')`
      )
    ).rejects.toThrow(/memory_type|check constraint/i)
  })

  it('agent_memories: recall sorts by importance DESC, recall_count DESC, created_at DESC', async () => {
    const lo = await memories.create({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'episodic',
      content: 'low',
      importance: 20
    })
    const hi = await memories.create({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'episodic',
      content: 'high',
      importance: 80
    })
    const mid = await memories.create({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'episodic',
      content: 'mid',
      importance: 50
    })

    const got = await memories.recall({ scopeType: 'project', scopeId: 'p' })
    expect(got.map((m) => m.id)).toEqual([hi.id, mid.id, lo.id])
  })

  it('agent_memories: recall filters by memoryType + applies LIMIT', async () => {
    await memories.create({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'episodic',
      content: 'ep1'
    })
    await memories.create({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'procedural',
      content: 'proc1'
    })
    await memories.create({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'episodic',
      content: 'ep2'
    })

    const eps = await memories.recall({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'episodic'
    })
    expect(eps).toHaveLength(2)

    const limited = await memories.recall({ scopeType: 'project', scopeId: 'p', limit: 1 })
    expect(limited).toHaveLength(1)
  })

  it('agent_memories: recall tag filter is client-side (any-of OR semantics)', async () => {
    await memories.create({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'episodic',
      content: 'a',
      tags: ['urgent', 'backend']
    })
    await memories.create({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'episodic',
      content: 'b',
      tags: ['frontend']
    })
    await memories.create({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'episodic',
      content: 'c'
    })

    const urgent = await memories.recall({
      scopeType: 'project',
      scopeId: 'p',
      tags: ['urgent']
    })
    expect(urgent.map((m) => m.content)).toEqual(['a'])

    const frontOrBackend = await memories.recall({
      scopeType: 'project',
      scopeId: 'p',
      tags: ['frontend', 'backend']
    })
    expect(frontOrBackend.map((m) => m.content).sort()).toEqual(['a', 'b'])
  })

  it('agent_memories: updateRecallStats bumps count + sets lastRecalledAt', async () => {
    const m = await memories.create({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'episodic',
      content: 'x'
    })
    await memories.updateRecallStats(m.id)
    await memories.updateRecallStats(m.id)
    const got = await memories.get(m.id)
    expect(got?.recallCount).toBe(2)
    expect(got?.lastRecalledAt).toBeTruthy()
  })

  it('agent_memories: promoteMarkPromoted appends marker idempotently', async () => {
    const m = await memories.create({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'procedural',
      content: 'reusable',
      tags: ['existing']
    })
    await memories.promoteMarkPromoted(m.id, 'ADR-099')
    await memories.promoteMarkPromoted(m.id, 'ADR-099') // idempotent
    const got = await memories.get(m.id)
    expect(got?.tags).toEqual(['existing', 'promoted:ADR-099'])
  })

  it('agent_memories: promoteMarkPromoted on unknown id is a no-op', async () => {
    await expect(memories.promoteMarkPromoted('MEM-missing', 'ADR-1')).resolves.toBeUndefined()
  })

  it('agent_memories: scope isolation — different scopeId returns no rows', async () => {
    await memories.create({
      scopeType: 'project',
      scopeId: 'p',
      memoryType: 'episodic',
      content: 'p-mem'
    })
    const otherScope = await memories.recall({ scopeType: 'project', scopeId: 'q' })
    expect(otherScope).toEqual([])
  })
})
