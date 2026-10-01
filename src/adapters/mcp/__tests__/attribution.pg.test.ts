// TASK-2245 — attribution on the real remote surface: inbox created_by and
// conversation authorship come from the token, remote inbox ids are
// INBOX-R-NNN, and both reach the converter's SQLite through a real pull.
// Self-skips when Docker is unavailable.

import { afterAll, beforeAll, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../test/postgres-harness'
import { PostgresTaskService } from '../../../core/domain/postgres-task-service'
import type { BackendTaskService } from '../../../core/domain/backend-task-service.interface'
import { initSchema } from '../../../core/domain/repositories/schema'
import { CounterRepository } from '../../../core/domain/repositories/counter-repository'
import { InboxRepository } from '../../../core/domain/repositories/inbox-repository'
import { pull } from '../../../core/sync/sync-pull'
import { fetchSinceFromPg } from '../../../core/sync/sync-source'
import { startHttpTransport, type HttpTransportHandle } from '../http-transport'
import { createInstrumentedServer } from '../instrumented-server'
import { REMOTE_TOOL_ALLOWLIST } from '../server-bootstrap'
import { scopeServiceToCaller } from '../remote-scope'
import { CONVERTER_ROLE } from '../caller-identity'
import type { JwtClaims, JwtVerifier } from '../oauth/jwt-verifier'
import * as conversationTools from '../mcp-tools/conversation-tools'
import * as inboxTools from '../mcp-tools/inbox-tools'

const MEMBER = 'an.jwt'
const CONVERTER = 'butter.jwt'

function claims(username: string, roles: string[]): JwtClaims {
  return {
    sub: `sub-${username}`,
    iss: 'https://id.choda.dev/realms/demo',
    exp: Math.floor(Date.now() / 1000) + 600,
    preferred_username: username,
    realm_access: { roles }
  }
}

const verifier: JwtVerifier = {
  verify: async (token) =>
    token === MEMBER
      ? claims('an', [])
      : token === CONVERTER
        ? claims('butter', [CONVERTER_ROLE])
        : null
}

describeIfDocker('TASK-2245 — remote attribution against real Postgres', () => {
  let env: PgTestEnv
  let svc: PostgresTaskService
  let server: HttpTransportHandle
  let url: string
  let laptop: Database.Database

  async function call(token: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    const body = (await res.json()) as { result?: { isError?: boolean; content: Array<{ text: string }> } }
    expect(body.result?.isError).not.toBe(true)
    return JSON.parse(body.result?.content[0]?.text ?? 'null')
  }

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    svc = new PostgresTaskService(env.conn)
    await svc.initializeAsync()
    await env.conn.query("INSERT INTO projects (id, name, cwd) VALUES ('P1', 'One', '/1')")
    await env.conn.query("INSERT INTO project_members (project_id, member) VALUES ('P1', 'an')")

    const scoped = scopeServiceToCaller(svc, {
      listProjectsFor: (member) => svc.listProjectsForMember(member)
    }) as unknown as BackendTaskService
    server = await startHttpTransport(
      (): McpServer => {
        const mcp = new McpServer({ name: 'attr-test', version: '0' }, { capabilities: { tools: {} } })
        const instrumented = createInstrumentedServer(mcp, { recordToolInvocation: () => {} }, REMOTE_TOOL_ALLOWLIST)
        conversationTools.register(instrumented, scoped)
        inboxTools.register(instrumented, scoped)
        return mcp
      },
      {
        port: 0,
        bind: '127.0.0.1',
        token: 'unused',
        oauth: {
          origin: 'https://mcp.choda.dev',
          keycloak: { authorizationEndpoint: 'a', tokenEndpoint: 't', clientId: 'c' },
          verifier
        }
      }
    )
    url = `http://127.0.0.1:${server.address.port}`

    laptop = new Database(':memory:')
    initSchema(laptop)
  }, 120_000)

  afterAll(async () => {
    laptop?.close()
    if (server) await server.close()
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  // Runs first on this fresh database, so the remote counter starts at 0.
  it('AC-7 + AC-2: two remote inbox_add calls mint INBOX-R-001/002, attributed to the token', async () => {
    const a = (await call(MEMBER, 'inbox_add', {
      projectId: 'P1',
      content: 'first',
      created_by: 'butter' // not part of the tool schema — must not be stored
    })) as { id: string; createdBy: string | null }
    const b = (await call(MEMBER, 'inbox_add', { projectId: 'P1', content: 'second' })) as { id: string }
    expect(a.id).toBe('INBOX-R-001')
    expect(b.id).toBe('INBOX-R-002')
    const row = await env.conn.query<{ created_by: string | null }>(
      'SELECT created_by FROM inbox_items WHERE id = $1',
      ['INBOX-R-001']
    )
    expect(row.rows[0].created_by).toBe('an')
  })

  it('AC-1: the Postgres inbox_items table has created_by', async () => {
    const cols = await env.conn.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'inbox_items'"
    )
    expect(cols.rows.map((r) => r.column_name)).toContain('created_by')
  })

  it('AC-3 + AC-8: a pull carries created_by to SQLite and leaves the laptop counter alone', async () => {
    const counters = new CounterRepository(laptop)
    const local = new InboxRepository(laptop, counters)
    local.create({ projectId: 'P1', content: 'captured on the laptop' })
    const previous = (
      laptop.prepare("SELECT last_number FROM global_counters WHERE entity_type = 'inbox'").get() as {
        last_number: number
      }
    ).last_number

    await pull(laptop, { fetchSince: (since) => fetchSinceFromPg(env.conn, since) })

    expect(laptop.prepare("SELECT created_by FROM inbox_items WHERE id = 'INBOX-R-001'").get()).toEqual({
      created_by: 'an'
    })
    const next = local.create({ projectId: 'P1', content: 'after the pull' })
    expect(next.id).toBe(`INBOX-${String(previous + 1).padStart(3, '0')}`)
  })

  it('AC-4: conversation_open by a member is recorded as the member, not the client-sent name', async () => {
    const opened = (await call(MEMBER, 'conversation_open', {
      projectId: 'P1',
      title: 'review',
      createdBy: 'butter',
      participants: [{ name: 'an' }, { name: 'butter' }],
      initialMessage: { content: 'please review' }
    })) as { conversationId: string }
    const row = await env.conn.query<{ created_by: string }>('SELECT created_by FROM conversations WHERE id = $1', [
      opened.conversationId
    ])
    expect(row.rows[0].created_by).toBe('an')
  })

  it('AC-5: conversation_add by a member stores the member as author', async () => {
    const opened = (await call(CONVERTER, 'conversation_open', {
      projectId: 'P1',
      title: 'thread',
      createdBy: 'butter',
      participants: [{ name: 'an' }, { name: 'butter' }],
      initialMessage: { content: 'hello' }
    })) as { conversationId: string }
    await call(MEMBER, 'conversation_add', {
      conversationId: opened.conversationId,
      author: 'butter',
      content: 'from an'
    })
    const row = await env.conn.query<{ author_name: string }>(
      "SELECT author_name FROM conversation_messages WHERE conversation_id = $1 AND content = 'from an'",
      [opened.conversationId]
    )
    expect(row.rows.map((r) => r.author_name)).toEqual(['an'])
  })

  it('AC-6: the converter keeps the client-supplied author', async () => {
    const opened = (await call(CONVERTER, 'conversation_open', {
      projectId: 'P1',
      title: 'thread 2',
      createdBy: 'butter',
      participants: [{ name: 'claude' }, { name: 'butter' }],
      initialMessage: { content: 'hello' }
    })) as { conversationId: string }
    await call(CONVERTER, 'conversation_add', {
      conversationId: opened.conversationId,
      author: 'claude',
      content: 'from claude'
    })
    const row = await env.conn.query<{ author_name: string }>(
      "SELECT author_name FROM conversation_messages WHERE conversation_id = $1 AND content = 'from claude'",
      [opened.conversationId]
    )
    expect(row.rows.map((r) => r.author_name)).toEqual(['claude'])
  })
})
