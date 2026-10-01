import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { startHttpTransport, type HttpTransportHandle } from '../http-transport'
import { currentCaller, CONVERTER_ROLE } from '../caller-identity'
import type { JwtClaims, JwtVerifier } from '../oauth/jwt-verifier'
import type { TableDelta } from '../../../core/sync/sync-pull'

// TASK-2242 — the OAuth gate turns verified claims into a CallerIdentity that
// tool handlers can read, and /sync/* is converter-only. Keycloak is stubbed;
// no database is needed (the sink and source are spies).

const ORIGIN = 'https://mcp.choda.dev'
const REALM = 'https://id.choda.dev/realms/demo'
const MEMBER_TOKEN = 'an.jwt'
const CONVERTER_TOKEN = 'butter.jwt'
const STATIC_TOKEN = 'static-bearer-secret'

function claims(username: string, roles: string[]): JwtClaims {
  return {
    sub: `sub-${username}`,
    iss: REALM,
    exp: Math.floor(Date.now() / 1000) + 600,
    azp: 'choda-connector',
    preferred_username: username,
    realm_access: { roles }
  }
}

const stubVerifier: JwtVerifier = {
  verify: async (token: string): Promise<JwtClaims | null> => {
    if (token === MEMBER_TOKEN) return claims('an', ['offline_access'])
    if (token === CONVERTER_TOKEN) return claims('butter', ['offline_access', CONVERTER_ROLE])
    return null
  }
}

// One tool that echoes the identity it observes from inside the handler.
function whoamiFactory(): McpServer {
  const server = new McpServer({ name: 'test-mcp', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.registerTool(
    'whoami',
    { description: 'echo the caller', inputSchema: {} },
    (async () => ({
      content: [{ type: 'text', text: JSON.stringify(currentCaller() ?? null) }]
    })) as never
  )
  return server
}

interface Spies {
  fetchSinceCalls: number
  applyCalls: number
}

const DELTAS: TableDelta[] = [{ table: 'tasks', rows: [] }]

async function startTransport(
  spies: Spies,
  mode: 'oauth' | 'static'
): Promise<HttpTransportHandle> {
  return startHttpTransport(whoamiFactory, {
    port: 0,
    bind: '127.0.0.1',
    token: STATIC_TOKEN,
    oauth:
      mode === 'oauth'
        ? {
            origin: ORIGIN,
            keycloak: {
              authorizationEndpoint: `${REALM}/protocol/openid-connect/auth`,
              tokenEndpoint: `${REALM}/protocol/openid-connect/token`,
              clientId: 'choda-connector'
            },
            verifier: stubVerifier
          }
        : undefined,
    syncSource: {
      fetchSince: async () => {
        spies.fetchSinceCalls++
        return DELTAS
      }
    },
    syncSink: {
      applyDelta: async () => {
        spies.applyCalls++
        return { applied: 0, tombstoned: 0, conflicts: 0, verdicts: [] }
      }
    }
  })
}

async function whoami(baseUrl: string, token: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} }
    })
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result?: { content: Array<{ text: string }> } }
  return JSON.parse(body.result?.content[0]?.text ?? 'null')
}

function syncSince(baseUrl: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/sync/since?since=0`, { headers: { authorization: `Bearer ${token}` } })
}

function syncApply(baseUrl: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/sync/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ origin: 'laptop', deltas: DELTAS })
  })
}

describe('TASK-2242 — caller identity under OAuth', () => {
  const spies: Spies = { fetchSinceCalls: 0, applyCalls: 0 }
  let handle: HttpTransportHandle
  let baseUrl: string

  beforeAll(async () => {
    handle = await startTransport(spies, 'oauth')
    baseUrl = `http://127.0.0.1:${handle.address.port}`
  })

  afterAll(async () => {
    await handle.close()
  })

  beforeEach(() => {
    spies.fetchSinceCalls = 0
    spies.applyCalls = 0
  })

  it('AC-2: a member token reaches the tool handler as { member: an, isConverter: false }', async () => {
    expect(await whoami(baseUrl, MEMBER_TOKEN)).toEqual({ member: 'an', isConverter: false })
  })

  it('AC-3: a token with the choda-converter realm role reaches the handler as a converter', async () => {
    expect(await whoami(baseUrl, CONVERTER_TOKEN)).toEqual({ member: 'butter', isConverter: true })
  })

  it('falls back to sub when preferred_username is absent', async () => {
    const verifier: JwtVerifier = {
      verify: async () => ({ sub: 'kc-uuid-1', iss: REALM, exp: Math.floor(Date.now() / 1000) + 600 })
    }
    const h = await startHttpTransport(whoamiFactory, {
      port: 0,
      bind: '127.0.0.1',
      token: STATIC_TOKEN,
      oauth: {
        origin: ORIGIN,
        keycloak: { authorizationEndpoint: 'x', tokenEndpoint: 'y', clientId: 'z' },
        verifier
      }
    })
    try {
      const url = `http://127.0.0.1:${h.address.port}`
      expect(await whoami(url, 'any')).toEqual({ member: 'kc-uuid-1', isConverter: false })
    } finally {
      await h.close()
    }
  })

  it('AC-4: GET /sync/since with a member token → 403, empty body, source never read', async () => {
    const res = await syncSince(baseUrl, MEMBER_TOKEN)
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('')
    expect(spies.fetchSinceCalls).toBe(0)
  })

  it('AC-5 (wiring): POST /sync/apply with a member token → 403 and the sink is never called', async () => {
    const res = await syncApply(baseUrl, MEMBER_TOKEN)
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('')
    expect(spies.applyCalls).toBe(0)
  })

  it('AC-6: the converter token still gets 200 from both /sync endpoints', async () => {
    const since = await syncSince(baseUrl, CONVERTER_TOKEN)
    expect(since.status).toBe(200)
    expect(await since.json()).toEqual({ since: 0, deltas: DELTAS })
    const apply = await syncApply(baseUrl, CONVERTER_TOKEN)
    expect(apply.status).toBe(200)
    expect(spies.fetchSinceCalls).toBe(1)
    expect(spies.applyCalls).toBe(1)
  })

  it('an invalid token is still 401, not 403', async () => {
    expect((await syncSince(baseUrl, 'nope')).status).toBe(401)
    expect((await syncApply(baseUrl, 'nope')).status).toBe(401)
  })
})

describe('TASK-2242 — static-bearer mode is unchanged', () => {
  const spies: Spies = { fetchSinceCalls: 0, applyCalls: 0 }
  let handle: HttpTransportHandle
  let baseUrl: string

  beforeAll(async () => {
    handle = await startTransport(spies, 'static')
    baseUrl = `http://127.0.0.1:${handle.address.port}`
  })

  afterAll(async () => {
    await handle.close()
  })

  it('AC-7: the configured static bearer gets 200 from /sync/since', async () => {
    const res = await syncSince(baseUrl, STATIC_TOKEN)
    expect(res.status).toBe(200)
  })

  it('the static bearer is treated as the converter inside tool handlers', async () => {
    expect(await whoami(baseUrl, STATIC_TOKEN)).toEqual({
      member: 'static-bearer',
      isConverter: true
    })
  })
})
