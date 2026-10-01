// TASK-2243 — project_members on real Postgres + the `member` CLI run
// in-process against it (exit code + stdout/stderr captured). Self-skips when
// Docker is unavailable.

import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../test/postgres-harness'
import { migrate } from '../../core/domain/repositories/postgres/migrations'
import { PostgresProjectMemberRepository } from '../../core/domain/repositories/postgres/project-member-repository.pg'
import { runMemberCommand } from './member-command'

interface Run {
  code: number
  stdout: string
  stderr: string
}

describeIfDocker('TASK-2243 — project_members + member CLI against real Postgres', () => {
  let env: PgTestEnv
  let repo: PostgresProjectMemberRepository

  async function cli(...argv: string[]): Promise<Run> {
    const [sub, ...args] = argv
    let stdout = ''
    let stderr = ''
    const code = await runMemberCommand(sub, args, repo, {
      out: (t) => (stdout += t),
      err: (t) => (stderr += t)
    })
    return { code, stdout, stderr }
  }

  async function pairCount(projectId: string, member: string): Promise<number> {
    const r = await env.conn.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM project_members WHERE project_id = $1 AND member = $2',
      [projectId, member]
    )
    return Number(r.rows[0].n)
  }

  async function totalCount(): Promise<number> {
    const r = await env.conn.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM project_members')
    return Number(r.rows[0].n)
  }

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
    await env.conn.query(
      "INSERT INTO projects (id, name, cwd) VALUES ('choda-deck', 'Choda', '/c'), ('p2', 'P2', '/p2')"
    )
    repo = new PostgresProjectMemberRepository(env.conn)
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    await env.conn.query('DELETE FROM project_members')
  })

  it('AC-1: information_schema shows project_members with its columns and primary key', async () => {
    const cols = await env.conn.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'project_members' ORDER BY column_name`
    )
    expect(cols.rows).toEqual([
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'member', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'project_id', data_type: 'text', is_nullable: 'NO' }
    ])
    const pk = await env.conn.query<{ column_name: string }>(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name
       WHERE tc.table_name = 'project_members' AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`
    )
    expect(pk.rows.map((r) => r.column_name)).toEqual(['project_id', 'member'])
  })

  it('AC-3: a first member add exits 0 and leaves exactly one row', async () => {
    const run = await cli('add', 'an', 'choda-deck')
    expect(run.code).toBe(0)
    expect(await pairCount('choda-deck', 'an')).toBe(1)
  })

  it('AC-4: a second identical member add exits 0 and the pair is still one row', async () => {
    await cli('add', 'an', 'choda-deck')
    const again = await cli('add', 'an', 'choda-deck')
    expect(again.code).toBe(0)
    expect(await pairCount('choda-deck', 'an')).toBe(1)
  })

  it('AC-5: adding to an unknown project exits non-zero, names it, inserts nothing', async () => {
    const before = await totalCount()
    const run = await cli('add', 'an', 'no-such-project')
    expect(run.code).not.toBe(0)
    expect(run.stdout + run.stderr).toContain('no-such-project')
    expect(await totalCount()).toBe(before)
  })

  it('AC-6: remove exits 0 and deletes; removing again exits 1 with "not a member"', async () => {
    await cli('add', 'an', 'choda-deck')
    const first = await cli('remove', 'an', 'choda-deck')
    expect(first.code).toBe(0)
    expect(await pairCount('choda-deck', 'an')).toBe(0)
    const second = await cli('remove', 'an', 'choda-deck')
    expect(second.code).toBe(1)
    expect(second.stdout + second.stderr).toContain('not a member')
  })

  it('AC-7: member list prints exactly the two ids on stdout, one per line, nothing else', async () => {
    await cli('add', 'an', 'choda-deck')
    await cli('add', 'an', 'p2')
    await cli('add', 'binh', 'p2') // another member's row must not leak in
    const run = await cli('list', 'an')
    expect(run.code).toBe(0)
    expect(run.stdout).toBe('choda-deck\np2\n')
    expect(run.stderr).toBe('')
  })

  it('AC-8: listProjectsFor returns the same id set the CLI prints', async () => {
    await cli('add', 'an', 'choda-deck')
    await cli('add', 'an', 'p2')
    const printed = (await cli('list', 'an')).stdout.trim().split('\n')
    expect(new Set(await repo.listProjectsFor('an'))).toEqual(new Set(printed))
  })
})
