// TASK-2242 AC-5 — a member token pushing to POST /sync/apply is refused with
// 403 and nothing reaches canonical Postgres. Counts every APPLY_TABLES table
// before and after the push. Self-skips when Docker is unavailable.

import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../test/postgres-harness'
import { PostgresTaskService } from '../domain/postgres-task-service'
import { startHttpTransport, type HttpTransportHandle } from '../../adapters/mcp/http-transport'
import { CONVERTER_ROLE } from '../../adapters/mcp/caller-identity'
import type { JwtClaims, JwtVerifier } from '../../adapters/mcp/oauth/jwt-verifier'
import { APPLY_TABLES } from './sync-apply'
import type { TableDelta } from './sync-pull'

const REALM = 'https://id.choda.dev/realms/demo'
const MEMBER_TOKEN = 'an.jwt'
const CONVERTER_TOKEN = 'butter.jwt'

function claims(username: string, roles: string[]): JwtClaims {
  return {
    sub: `sub-${username}`,
    iss: REALM,
    exp: Math.floor(Date.now() / 1000) + 600,
    preferred_username: username,
    realm_access: { roles }
  }
}

const verifier: JwtVerifier = {
  verify: async (token) => {
    if (token === MEMBER_TOKEN) return claims('an', [])
    if (token === CONVERTER_TOKEN) return claims('butter', [CONVERTER_ROLE])
    return null
  }
}

function newTask(id: string): TableDelta {
  return {
    table: 'tasks',
    rows: [
      {
        id,
        project_id: 'p',
        parent_task_id: null,
        title: 'pushed by a member',
        status: 'TODO',
        priority: null,
        labels: '[]',
        due_date: null,
        pinned: 0,
        file_path: null,
        body: 'b',
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        sync_updated_at: 999_999,
        sync_deleted_at: null,
        sync_origin: 'laptop'
      }
    ]
  }
}

describeIfDocker('TASK-2242 — POST /sync/apply is converter-only against real Postgres', () => {
  let env: PgTestEnv
  let svc: PostgresTaskService
  let server: HttpTransportHandle
  let url: string

  async function rowCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const table of APPLY_TABLES) {
      const r = await env.conn.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`)
      out[table] = Number(r.rows[0].n)
    }
    return out
  }

  function push(token: string, delta: TableDelta): Promise<Response> {
    return fetch(`${url}/sync/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ origin: 'laptop', deltas: [delta] })
    })
  }

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    svc = new PostgresTaskService(env.conn)
    await svc.initializeAsync()
    await env.conn.query("INSERT INTO projects (id, name, cwd) VALUES ('p', 'P', '/p')")
    server = await startHttpTransport(() => Promise.reject(new Error('mcp factory unused')), {
      port: 0,
      bind: '127.0.0.1',
      token: 'unused-in-oauth-mode',
      oauth: {
        origin: 'https://mcp.choda.dev',
        keycloak: { authorizationEndpoint: 'a', tokenEndpoint: 't', clientId: 'c' },
        verifier
      },
      syncSink: { applyDelta: (deltas, origin) => svc.applyDelta(deltas, origin) }
    })
    url = `http://127.0.0.1:${server.address.port}`
  }, 120_000)

  afterAll(async () => {
    if (server) await server.close()
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  it('AC-5: a member push → 403 and every APPLY_TABLES row count is unchanged', async () => {
    const before = await rowCounts()
    const res = await push(MEMBER_TOKEN, newTask('TASK-MEMBER-1'))
    expect(res.status).toBe(403)
    expect(await rowCounts()).toEqual(before)
  })

  it('discriminator: the identical push with the converter token does land', async () => {
    const before = await rowCounts()
    const res = await push(CONVERTER_TOKEN, newTask('TASK-CONVERTER-1'))
    expect(res.status).toBe(200)
    const after = await rowCounts()
    expect(after.tasks).toBe(before.tasks + 1)
  })
})
