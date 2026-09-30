import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../../../test/postgres-harness'
import { migrate } from '../migrations'
import { PostgresProjectRepository } from '../project-repository.pg'

// TASK-2200 — projects.org on the Postgres side.
describeIfDocker('PostgresProjectRepository — org', () => {
  let env: PgTestEnv

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  it('015_project_org adds a nullable org and leaves a pre-migration row intact', async () => {
    // Roll the database back to its pre-015 shape, with a project already in it.
    await env.conn.query('ALTER TABLE projects DROP COLUMN org')
    await env.conn.query("DELETE FROM _migrations WHERE name = '015_project_org'")
    await env.conn.query(
      "INSERT INTO projects (id, name, cwd) VALUES ('old', 'Old Project', 'C:/dev/old')"
    )

    const result = await migrate(env.conn)

    expect(result.applied).toEqual(['015_project_org'])
    const row = await env.conn.query('SELECT id, name, cwd, org FROM projects WHERE id = $1', ['old'])
    expect(row.rows[0]).toEqual({ id: 'old', name: 'Old Project', cwd: 'C:/dev/old', org: null })
  })

  it('ensure/get/list carry org; list(org) filters; omitting org keeps it', async () => {
    const repo = new PostgresProjectRepository(env.conn)
    await repo.ensure('a', 'A', '/a', 'ichiba')
    await repo.ensure('b', 'B', '/b')
    await repo.ensure('a', 'A', '/a')

    expect((await repo.get('a'))?.org).toBe('ichiba')
    expect((await repo.get('b'))?.org).toBeNull()
    expect((await repo.list('ichiba')).map((p) => p.id)).toEqual(['a'])
  })
})
