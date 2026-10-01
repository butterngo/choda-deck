// TASK-2244 — the real remote tool surface, scoped per caller, against real
// Postgres: the allowlisted tools are registered exactly as server-bootstrap
// does in HTTP mode, served through the OAuth transport with a stub verifier.
// Fixture: projects P1 and P2, member 'an' in P1 only, rows of every kind in
// both. Self-skips when Docker is unavailable.

import { afterAll, beforeAll, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../test/postgres-harness'
import { PostgresTaskService } from '../../../core/domain/postgres-task-service'
import type { BackendTaskService } from '../../../core/domain/backend-task-service.interface'
import { startHttpTransport, type HttpTransportHandle } from '../http-transport'
import { createInstrumentedServer } from '../instrumented-server'
import { REMOTE_TOOL_ALLOWLIST } from '../server-bootstrap'
import { scopeServiceToCaller } from '../remote-scope'
import { CONVERTER_ROLE } from '../caller-identity'
import type { JwtClaims, JwtVerifier } from '../oauth/jwt-verifier'
import * as taskTools from '../mcp-tools/task-tools'
import * as conversationTools from '../mcp-tools/conversation-tools'
import * as projectTools from '../mcp-tools/project-tools'
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

interface ToolReply {
  isError: boolean
  text: string
}

describeIfDocker('TASK-2244 — remote tools scoped to the caller’s projects (real Postgres)', () => {
  let env: PgTestEnv
  let svc: PostgresTaskService
  let server: HttpTransportHandle
  let url: string
  const ids: Record<string, string> = {}

  async function call(token: string, name: string, args: Record<string, unknown>): Promise<ToolReply> {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    const body = (await res.json()) as {
      result?: { isError?: boolean; content: Array<{ text: string }> }
      error?: { message: string }
    }
    if (body.error) return { isError: true, text: body.error.message }
    return { isError: body.result?.isError === true, text: body.result?.content[0]?.text ?? '' }
  }

  async function count(table: string): Promise<number> {
    const r = await env.conn.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`)
    return Number(r.rows[0].n)
  }

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    svc = new PostgresTaskService(env.conn)
    await svc.initializeAsync()
    await env.conn.query("INSERT INTO projects (id, name, cwd) VALUES ('P1', 'One', '/1'), ('P2', 'Two', '/2')")
    for (const [id, project] of [['TASK-P1', 'P1'], ['TASK-P2', 'P2']]) {
      await env.conn.query(
        `INSERT INTO tasks (id, project_id, title, status, labels, pinned, created_at, updated_at)
         VALUES ($1, $2, $3, 'TODO', '[]', false, NOW(), NOW())`,
        [id, project, `task in ${project}`]
      )
    }
    for (const project of ['P1', 'P2']) {
      ids[`inbox${project}`] = (await svc.createInbox({ projectId: project, content: `idea in ${project}` })).id
      ids[`conv${project}`] = (
        await svc.openConversation({
          projectId: project,
          title: `thread in ${project}`,
          createdBy: 'butter',
          initialMessage: { content: 'hello' }
        })
      ).id
    }
    await env.conn.query("INSERT INTO project_members (project_id, member) VALUES ('P1', 'an')")

    // Same wiring as server-bootstrap's HTTP branch, reduced to the four
    // modules that own the allowlisted tools.
    const scoped = scopeServiceToCaller(svc, {
      listProjectsFor: (member) => svc.listProjectsForMember(member)
    }) as unknown as BackendTaskService
    const factory = (): McpServer => {
      const mcp = new McpServer({ name: 'scope-test', version: '0' }, { capabilities: { tools: {} } })
      const instrumented = createInstrumentedServer(mcp, { recordToolInvocation: () => {} }, REMOTE_TOOL_ALLOWLIST)
      taskTools.register(instrumented, scoped)
      conversationTools.register(instrumented, scoped)
      projectTools.register(instrumented, scoped)
      inboxTools.register(instrumented, scoped)
      return mcp
    }
    server = await startHttpTransport(factory, {
      port: 0,
      bind: '127.0.0.1',
      token: 'unused',
      oauth: {
        origin: 'https://mcp.choda.dev',
        keycloak: { authorizationEndpoint: 'a', tokenEndpoint: 't', clientId: 'c' },
        verifier
      }
    })
    url = `http://127.0.0.1:${server.address.port}`
  }, 120_000)

  afterAll(async () => {
    if (server) await server.close()
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  it('AC-1: project_list lists P1 and not P2', async () => {
    const r = await call(MEMBER, 'project_list', {})
    expect(r.isError).toBe(false)
    expect(r.text).toContain('"P1"')
    expect(r.text).not.toContain('"P2"')
  })

  it('AC-2: list tools without a projectId return no P2 ids', async () => {
    const tasks = await call(MEMBER, 'task_list', { status: 'TODO' })
    expect(tasks.text).toContain('TASK-P1')
    expect(tasks.text).not.toContain('TASK-P2')
    const inbox = await call(MEMBER, 'inbox_list', {})
    expect(inbox.text).toContain(ids.inboxP1)
    expect(inbox.text).not.toContain(ids.inboxP2)
  })

  it('AC-3: list tools with projectId P2 return an empty list', async () => {
    expect(JSON.parse((await call(MEMBER, 'task_list', { status: 'TODO', projectId: 'P2' })).text)).toEqual([])
    expect(JSON.parse((await call(MEMBER, 'inbox_list', { projectId: 'P2' })).text)).toEqual([])
    expect(JSON.parse((await call(MEMBER, 'conversation_list', { projectId: 'P2' })).text)).toEqual([])
    // and conversation_list for the member's own project does return the P1 thread
    expect((await call(MEMBER, 'conversation_list', { projectId: 'P1' })).text).toContain(ids.convP1)
  })

  it('AC-4: get tools on a P2 id answer exactly like an unknown id', async () => {
    const pairs: Array<[string, string, string, string]> = [
      ['task_context', 'id', 'TASK-P2', 'TASK-NOPE'],
      ['inbox_get', 'id', ids.inboxP2, 'INBOX-NOPE'],
      ['conversation_read', 'conversationId', ids.convP2, 'CONV-NOPE']
    ]
    for (const [tool, key, foreign, unknown] of pairs) {
      const a = await call(MEMBER, tool, { [key]: foreign })
      const b = await call(MEMBER, tool, { [key]: unknown })
      expect(a.text.replace(foreign, '<id>')).toBe(b.text.replace(unknown, '<id>'))
      expect(a.text).toContain('not found')
    }
  })

  it('AC-5: inbox_add and conversation_open into P2 error and write nothing', async () => {
    const inboxBefore = await count('inbox_items')
    const convBefore = await count('conversations')
    expect((await call(MEMBER, 'inbox_add', { projectId: 'P2', content: 'x' })).isError).toBe(true)
    expect(
      (
        await call(MEMBER, 'conversation_open', {
          projectId: 'P2',
          title: 't',
          createdBy: 'an',
          participants: [{ name: 'an' }],
          initialMessage: { content: 'hi' }
        })
      ).isError
    ).toBe(true)
    expect(await count('inbox_items')).toBe(inboxBefore)
    expect(await count('conversations')).toBe(convBefore)
  })

  it('AC-6: inbox_add with no projectId errors and writes nothing', async () => {
    const before = await count('inbox_items')
    expect((await call(MEMBER, 'inbox_add', { content: 'x' })).isError).toBe(true)
    expect((await call(MEMBER, 'inbox_add', { projectId: '', content: 'x' })).isError).toBe(true)
    expect(await count('inbox_items')).toBe(before)
  })

  it('AC-7: conversation_add on a P2 thread gives the unknown-id error and appends nothing', async () => {
    const msgs = async (): Promise<number> => {
      const r = await env.conn.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM conversation_messages WHERE conversation_id = $1',
        [ids.convP2]
      )
      return Number(r.rows[0].n)
    }
    const before = await msgs()
    const foreign = await call(MEMBER, 'conversation_add', { conversationId: ids.convP2, author: 'an', content: 'x' })
    const unknown = await call(MEMBER, 'conversation_add', { conversationId: 'CONV-NOPE', author: 'an', content: 'x' })
    expect(foreign.isError).toBe(true)
    expect(foreign.text.replace(ids.convP2, '<id>')).toBe(unknown.text.replace('CONV-NOPE', '<id>'))
    expect(await msgs()).toBe(before)
  })

  it('discriminator: the member can still write into their own project', async () => {
    const before = await count('inbox_items')
    expect((await call(MEMBER, 'inbox_add', { projectId: 'P1', content: 'mine' })).isError).toBe(false)
    expect(await count('inbox_items')).toBe(before + 1)
  })

  it('AC-8: the converter sees and reads both projects, unchanged', async () => {
    const projects = await call(CONVERTER, 'project_list', {})
    expect(projects.text).toContain('"P1"')
    expect(projects.text).toContain('"P2"')
    expect((await call(CONVERTER, 'task_context', { id: 'TASK-P2' })).text).toContain('task in P2')
    expect((await call(CONVERTER, 'inbox_list', { projectId: 'P2' })).text).toContain(ids.inboxP2)
  })
})
