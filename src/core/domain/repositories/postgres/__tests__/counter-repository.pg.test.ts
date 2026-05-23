import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../../../test/postgres-harness'
import { migrate } from '../migrations'
import { PostgresCounterRepository } from '../counter-repository.pg'

describeIfDocker('PostgresCounterRepository', () => {
  let env: PgTestEnv

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  it('mints sequential numbers per entity_type', async () => {
    const counters = new PostgresCounterRepository(env.conn)
    const a1 = await counters.nextNumber('task')
    const a2 = await counters.nextNumber('task')
    const b1 = await counters.nextNumber('inbox')
    expect(a1).toBe(1)
    expect(a2).toBe(2)
    expect(b1).toBe(1)
  })

  it('migrate is idempotent (second run skips all)', async () => {
    const result = await migrate(env.conn)
    expect(result.applied).toEqual([])
    expect(result.skipped.length).toBeGreaterThan(0)
  })
})
