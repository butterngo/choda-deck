import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../../../test/postgres-harness'
import { migrate } from '../migrations'
import { PostgresToolInvocationsRepository } from '../tool-invocations-repository.pg'

describeIfDocker('PostgresToolInvocationsRepository', () => {
  let env: PgTestEnv
  let repo: PostgresToolInvocationsRepository

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
    repo = new PostgresToolInvocationsRepository(env.conn)
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    await env.conn.query('DELETE FROM tool_invocations')
  })

  it('record + count: empty count is 0, then bumps per insert', async () => {
    expect(await repo.countToolInvocations()).toBe(0)
    await repo.recordToolInvocation({
      toolName: 'task_list',
      ts: '2026-05-24T10:00:00.000Z',
      durationMs: 5,
      ok: true,
      errorKind: null
    })
    expect(await repo.countToolInvocations()).toBe(1)
  })

  it('record: ok BOOLEAN round-trip; errorKind nullable', async () => {
    await repo.recordToolInvocation({
      toolName: 'task_create',
      ts: '2026-05-24T10:00:00.000Z',
      durationMs: 12,
      ok: false,
      errorKind: 'ValidationError'
    })
    const row = await env.conn.query<{ ok: boolean; error_kind: string | null }>(
      'SELECT ok, error_kind FROM tool_invocations LIMIT 1'
    )
    expect(row.rows[0].ok).toBe(false)
    expect(row.rows[0].error_kind).toBe('ValidationError')
  })

  it('queryToolInvocations: aggregates calls + errors per tool, all-time window', async () => {
    const base = '2026-05-24T10:00:00.000Z'
    await repo.recordToolInvocation({ toolName: 'A', ts: base, durationMs: 10, ok: true, errorKind: null })
    await repo.recordToolInvocation({ toolName: 'A', ts: base, durationMs: 30, ok: true, errorKind: null })
    await repo.recordToolInvocation({ toolName: 'A', ts: base, durationMs: 20, ok: false, errorKind: 'Boom' })
    await repo.recordToolInvocation({ toolName: 'B', ts: base, durationMs: 5, ok: true, errorKind: null })

    const aggs = await repo.queryToolInvocations({ since: null, until: null })
    const byTool = Object.fromEntries(aggs.map((a) => [a.tool, a]))

    expect(byTool.A.calls).toBe(3)
    expect(byTool.A.errors).toBe(1)
    expect(byTool.A.avgDurationMs).toBe(20) // (10+30+20)/3
    expect(byTool.B.calls).toBe(1)
    expect(byTool.B.errors).toBe(0)
    expect(byTool.B.avgDurationMs).toBe(5)
  })

  it('queryToolInvocations: since + until filter narrows the window', async () => {
    await repo.recordToolInvocation({
      toolName: 'X',
      ts: '2026-05-23T00:00:00.000Z',
      durationMs: 1,
      ok: true,
      errorKind: null
    })
    await repo.recordToolInvocation({
      toolName: 'X',
      ts: '2026-05-24T00:00:00.000Z',
      durationMs: 1,
      ok: true,
      errorKind: null
    })
    await repo.recordToolInvocation({
      toolName: 'X',
      ts: '2026-05-25T00:00:00.000Z',
      durationMs: 1,
      ok: true,
      errorKind: null
    })

    const inWindow = await repo.queryToolInvocations({
      since: '2026-05-24T00:00:00.000Z',
      until: '2026-05-24T23:59:59.999Z'
    })
    expect(inWindow[0].calls).toBe(1)
  })

  it('queryToolInvocations: only `since` is honored when `until` is null', async () => {
    await repo.recordToolInvocation({
      toolName: 'Y',
      ts: '2026-05-23T00:00:00.000Z',
      durationMs: 1,
      ok: true,
      errorKind: null
    })
    await repo.recordToolInvocation({
      toolName: 'Y',
      ts: '2026-05-24T00:00:00.000Z',
      durationMs: 1,
      ok: true,
      errorKind: null
    })

    const since23 = await repo.queryToolInvocations({
      since: '2026-05-24T00:00:00.000Z',
      until: null
    })
    expect(since23[0].calls).toBe(1)
  })

  it('queryToolInvocations: lastUsedAt is MAX(ts) across rows for the tool', async () => {
    const early = '2026-05-23T10:00:00.000Z'
    const late = '2026-05-23T11:00:00.000Z'
    await repo.recordToolInvocation({ toolName: 'Z', ts: late, durationMs: 1, ok: true, errorKind: null })
    await repo.recordToolInvocation({ toolName: 'Z', ts: early, durationMs: 1, ok: true, errorKind: null })

    const aggs = await repo.queryToolInvocations({ since: null, until: null })
    expect(aggs[0].lastUsedAt).toBe(late)
  })

  it('queryToolInvocations: empty table returns []', async () => {
    expect(await repo.queryToolInvocations({ since: null, until: null })).toEqual([])
  })

  it('id is auto-generated (caller never passes it) and increments per insert', async () => {
    await repo.recordToolInvocation({
      toolName: 'A',
      ts: 'now',
      durationMs: 1,
      ok: true,
      errorKind: null
    })
    await repo.recordToolInvocation({
      toolName: 'B',
      ts: 'now',
      durationMs: 1,
      ok: true,
      errorKind: null
    })
    const ids = await env.conn.query<{ id: string }>(
      'SELECT id FROM tool_invocations ORDER BY id'
    )
    expect(ids.rows).toHaveLength(2)
    expect(Number(ids.rows[1].id)).toBeGreaterThan(Number(ids.rows[0].id))
  })
})
