import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { startHttpTransport, type HttpTransportHandle } from '../http-transport'
import type { JwtClaims, JwtVerifier } from '../oauth/jwt-verifier'

// ADR-034: choda-deck proxies the OAuth endpoints to Keycloak and validates
// Keycloak-issued JWTs. These tests exercise the on-origin surface (metadata,
// /authorize redirect, /register pinned client, /mcp bearer gate) with a stub
// verifier — Keycloak itself is not contacted. Token-proxy network behavior is
// covered in keycloak-proxy.test.ts; JWT validation in jwt-verifier.test.ts.

const ORIGIN = 'https://mcp.choda.dev'
const REALM = 'https://id.choda.dev/realms/choda'
const CLIENT_ID = 'choda-connector'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const GOOD_TOKEN = 'good.keycloak.jwt'

// Accept only GOOD_TOKEN; everything else is rejected (null) — mirrors the real
// verifier's null-on-failure contract without needing a signed JWT here.
const stubVerifier: JwtVerifier = {
  verify: async (token: string): Promise<JwtClaims | null> =>
    token === GOOD_TOKEN
      ? { sub: 'butter', iss: REALM, exp: Math.floor(Date.now() / 1000) + 600, azp: CLIENT_ID }
      : null
}

function buildServerFactory(): () => McpServer {
  return (): McpServer => {
    const server = new McpServer(
      { name: 'test-mcp', version: '0.0.0' },
      { capabilities: { tools: {} } }
    )
    server.registerTool(
      'ping',
      { description: 'ping', inputSchema: {} },
      (async () => ({ content: [{ type: 'text', text: 'pong' }] })) as never
    )
    return server
  }
}

describe('startHttpTransport — Keycloak-backed OAuth (ADR-034)', () => {
  let handle: HttpTransportHandle
  let baseUrl: string

  beforeAll(async () => {
    handle = await startHttpTransport(buildServerFactory(), {
      port: 0,
      bind: '127.0.0.1',
      token: 'legacy-ignored',
      oauth: {
        origin: ORIGIN,
        keycloak: {
          authorizationEndpoint: `${REALM}/protocol/openid-connect/auth`,
          tokenEndpoint: `${REALM}/protocol/openid-connect/token`,
          clientId: CLIENT_ID
        },
        verifier: stubVerifier
      }
    })
    baseUrl = `http://127.0.0.1:${handle.address.port}`
  })

  afterAll(async () => {
    await handle.close()
  })

  it('GET /healthz still works without auth', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    expect(res.status).toBe(200)
  })

  it('GET /.well-known/oauth-authorization-server → on-origin endpoints (claude.ai web hardcodes these)', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.issuer).toBe(ORIGIN)
    expect(body.authorization_endpoint).toBe(`${ORIGIN}/authorize`)
    expect(body.token_endpoint).toBe(`${ORIGIN}/token`)
    expect(body.code_challenge_methods_supported).toEqual(['S256'])
  })

  it('GET /.well-known/oauth-protected-resource → RFC 9728 metadata on origin', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { resource: string; authorization_servers: string[] }
    expect(body.resource).toBe(`${ORIGIN}/mcp`)
    expect(body.authorization_servers).toEqual([ORIGIN])
  })

  it('GET /authorize → 302 to Keycloak with PKCE params forwarded', async () => {
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: 'abc123',
      code_challenge_method: 'S256',
      state: 'opaque-state'
    })
    const res = await fetch(`${baseUrl}/authorize?${qs.toString()}`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location') ?? '')
    expect(loc.origin + loc.pathname).toBe(`${REALM}/protocol/openid-connect/auth`)
    expect(loc.searchParams.get('code_challenge')).toBe('abc123')
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256')
    expect(loc.searchParams.get('state')).toBe('opaque-state')
    expect(loc.searchParams.get('redirect_uri')).toBe(REDIRECT)
  })

  it('POST /register → 201 with the pinned public client_id', async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'claude.ai', redirect_uris: [REDIRECT] })
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { client_id: string; token_endpoint_auth_method: string }
    expect(body.client_id).toBe(CLIENT_ID)
    expect(body.token_endpoint_auth_method).toBe('none')
  })

  it('POST /mcp without bearer → 401 with WWW-Authenticate → protected-resource metadata', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`
    )
  })

  it('POST /mcp with an invalid token → 401', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: '{}'
    })
    expect(res.status).toBe(401)
  })

  it('POST /mcp with a valid Keycloak token → MCP responds', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${GOOD_TOKEN}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result?: { tools: Array<{ name: string }> } }
    expect(body.result?.tools.map((t) => t.name)).toContain('ping')
  })
})
