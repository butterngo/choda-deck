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

  // TASK-3128 — projects.purpose (rule 4 of personal-operating-rules).
  it('020_project_purpose adds a nullable purpose; a pre-migration row reads back null', async () => {
    await env.conn.query('ALTER TABLE projects DROP COLUMN purpose')
    await env.conn.query("DELETE FROM _migrations WHERE name = '020_project_purpose'")
    await env.conn.query(
      "INSERT INTO projects (id, name, cwd) VALUES ('pre', 'Pre Purpose', 'C:/dev/pre')"
    )

    const result = await migrate(env.conn)

    expect(result.applied).toEqual(['020_project_purpose'])
    const col = await env.conn.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'purpose'"
    )
    expect(col.rows[0]).toEqual({ is_nullable: 'YES' })
    const repo = new PostgresProjectRepository(env.conn)
    expect((await repo.get('pre'))?.purpose).toBeNull()
    await repo.ensure('pre', 'Pre Purpose', 'C:/dev/pre', undefined, 'reputation')
    expect((await repo.get('pre'))?.purpose).toBe('reputation')
  })
})
