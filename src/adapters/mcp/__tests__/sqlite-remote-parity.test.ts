// TASK-2253 — the live remote runs the SQLite backend, so membership, the
// member CLI, project scoping and INBOX-R ids must work there too. No Docker.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SqliteTaskService } from '../../../core/domain/sqlite-task-service'
import { createTaskService } from '../../../core/domain/task-service-factory'
import type { BackendTaskService } from '../../../core/domain/backend-task-service.interface'
import { runMemberCommand } from '../../cli/member-command'
import { startHttpTransport, type HttpTransportHandle } from '../http-transport'
import { createInstrumentedServer } from '../instrumented-server'
import { REMOTE_TOOL_ALLOWLIST, serviceOptionsForTransport } from '../server-bootstrap'
import { scopeServiceToCaller } from '../remote-scope'
import type { JwtVerifier } from '../oauth/jwt-verifier'
import * as taskTools from '../mcp-tools/task-tools'
import * as projectTools from '../mcp-tools/project-tools'

let svc: SqliteTaskService

beforeEach(async () => {
  svc = new SqliteTaskService(':memory:')
  for (const id of ['P1', 'P2']) {
    svc.syncDatabase.prepare('INSERT INTO projects (id, name, cwd) VALUES (?, ?, ?)').run(id, id, `/${id}`)
  }
})
afterEach(async () => svc.close())

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const [sub, ...args] = argv
  let stdout = ''
  let stderr = ''
  const code = await runMemberCommand(sub, args, svc.memberRepository, {
    out: (t) => (stdout += t),
    err: (t) => (stderr += t)
  })
  return { code, stdout, stderr }
}

function pairCount(projectId: string, member: string): number {
  return (
    svc.syncDatabase
      .prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND member = ?')
      .get(projectId, member) as { n: number }
  ).n
}

describe('TASK-2253 — member CLI against SQLite', () => {
  it('AC-2: add is idempotent; an unknown project is refused by name', async () => {
    expect((await cli('add', 'an', 'P1')).code).toBe(0)
    expect(pairCount('P1', 'an')).toBe(1)
    expect((await cli('add', 'an', 'P1')).code).toBe(0)
    expect(pairCount('P1', 'an')).toBe(1)
    const unknown = await cli('add', 'an', 'no-such-project')
    expect(unknown.code).not.toBe(0)
    expect(unknown.stdout + unknown.stderr).toContain('no-such-project')
  })

  it('AC-3: remove then remove again → 0 then 1 "not a member"; list prints exactly the ids', async () => {
    await cli('add', 'an', 'P1')
    await cli('add', 'an', 'P2')
    await cli('add', 'binh', 'P2')
    const listed = await cli('list', 'an')
    expect(listed.stdout).toBe('P1\nP2\n')
    expect(listed.stderr).toBe('')
    expect((await cli('remove', 'an', 'P1')).code).toBe(0)
    const again = await cli('remove', 'an', 'P1')
    expect(again.code).toBe(1)
    expect(again.stdout + again.stderr).toContain('not a member')
    expect((await cli('list', 'an')).stdout).toBe('P2\n')
  })
})

describe('TASK-2253 — scoped remote surface on SQLite (AC-4)', () => {
  let server: HttpTransportHandle
  let url: string

  beforeEach(async () => {
    await svc.memberRepository.add('an', 'P1')
    await svc.createTask({ id: 'TASK-P2', projectId: 'P2', title: 'foreign task' })
    const verifier: JwtVerifier = {
      verify: async (token) =>
        token === 'an.jwt'
          ? { sub: 'sub-an', iss: 'x', exp: Math.floor(Date.now() / 1000) + 600, preferred_username: 'an' }
          : null
    }
    const scoped = scopeServiceToCaller(svc, {
      listProjectsFor: (member) => svc.listProjectsForMember(member)
    }) as unknown as BackendTaskService
    server = await startHttpTransport(
      (): McpServer => {
        const mcp = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } })
        const instrumented = createInstrumentedServer(mcp, { recordToolInvocation: () => {} }, REMOTE_TOOL_ALLOWLIST)
        taskTools.register(instrumented, scoped)
        projectTools.register(instrumented, scoped)
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
  })
  afterEach(async () => server.close())

  async function call(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer an.jwt'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    })
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } }
    return body.result.content[0].text
  }

  it('project_list shows P1 and not P2; task_context on a P2 task replies like an unknown id', async () => {
    const projects = await call('project_list', {})
    expect(projects).toContain('"P1"')
    expect(projects).not.toContain('"P2"')
    const foreign = await call('task_context', { id: 'TASK-P2' })
    const unknown = await call('task_context', { id: 'TASK-NOPE' })
    expect(foreign.replace('TASK-P2', '<id>')).toBe(unknown.replace('TASK-NOPE', '<id>'))
  })
})

describe('TASK-2253 — INBOX-R ids on the SQLite remote', () => {
  it('AC-5: remote-ids option mints INBOX-R-001, INBOX-R-002; default mints INBOX-NNN', async () => {
    const remote = new SqliteTaskService(':memory:', { remoteInboxIds: true })
    try {
      expect((await remote.createInbox({ projectId: 'p', content: 'a' })).id).toBe('INBOX-R-001')
      expect((await remote.createInbox({ projectId: 'p', content: 'b' })).id).toBe('INBOX-R-002')
    } finally {
      await remote.close()
    }
    expect((await svc.createInbox({ projectId: 'P1', content: 'c' })).id).toMatch(/^INBOX-\d+$/)
  })

  it('AC-6: the HTTP transport path builds a SQLite service that mints INBOX-R-NNN; stdio does not', async () => {
    expect(serviceOptionsForTransport('http')).toEqual({ remoteInboxIds: true })
    expect(serviceOptionsForTransport('stdio')).toEqual({ remoteInboxIds: false })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-2253-'))
    const http = createTaskService({ kind: 'sqlite', dbPath: path.join(dir, 'http.db') }, serviceOptionsForTransport('http'))
    const stdio = createTaskService({ kind: 'sqlite', dbPath: path.join(dir, 'stdio.db') }, serviceOptionsForTransport('stdio'))
    try {
      expect((await http.createInbox({ projectId: 'p', content: 'x' })).id).toBe('INBOX-R-001')
      expect((await stdio.createInbox({ projectId: 'p', content: 'x' })).id).toMatch(/^INBOX-\d+$/)
    } finally {
      await (http as unknown as SqliteTaskService).close()
      await (stdio as unknown as SqliteTaskService).close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
