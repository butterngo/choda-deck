import { afterAll, beforeAll, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { startHttpTransport, type HttpTransportHandle } from '../http-transport'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../test/postgres-harness'
import { migrate } from '../../../core/domain/repositories/postgres/migrations'
import { PostgresOAuthRepository } from '../../../core/domain/repositories/postgres/oauth-repository.pg'
import { computeChallengeS256 } from '../oauth/pkce'

// PG sibling of http-transport-oauth.test.ts. Same end-to-end OAuth flow
// (/register → /authorize → /token → /mcp + refresh rotation) but with the
// transport wired to PostgresOAuthRepository instead of the SQLite one.
// Proves OAuthOperations is the backend boundary the HTTP layer programs
// against (slice 12) AND that the Postgres OAuth path works against a real
// Postgres instance.

const ISSUER = 'https://test.local'
const PASSWORD = 'super-secret-pg'
const PASSWORD_HASH_HEX = createHash('sha256').update(PASSWORD, 'utf8').digest('hex')

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = computeChallengeS256(VERIFIER)
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

function buildServerFactory(): () => McpServer {
  return (): McpServer => {
    const server = new McpServer(
      { name: 'test-mcp-pg', version: '0.0.0' },
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

describeIfDocker('startHttpTransport — OAuth mode against Postgres', () => {
  let env: PgTestEnv
  let handle: HttpTransportHandle
  let baseUrl: string

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
    const repo = new PostgresOAuthRepository(env.conn)
    handle = await startHttpTransport(buildServerFactory(), {
      port: 0,
      bind: '127.0.0.1',
      token: 'legacy-ignored',
      oauth: { repo, issuer: ISSUER, consentPasswordHashHex: PASSWORD_HASH_HEX }
    })
    baseUrl = `http://127.0.0.1:${handle.address.port}`
  }, 120_000)

  afterAll(async () => {
    if (handle) await handle.close()
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  it('end-to-end: /register → /authorize → /token → POST /mcp with the access token (PG-backed)', async () => {
    // 1. /register
    const regRes = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'claude.ai', redirect_uris: [REDIRECT] })
    })
    expect(regRes.status).toBe(201)
    const reg = (await regRes.json()) as { client_id: string }

    // 2. GET /authorize → form HTML
    const authQs = new URLSearchParams({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'opaque-state-pg'
    })
    const authGet = await fetch(`${baseUrl}/authorize?${authQs.toString()}`)
    expect(authGet.status).toBe(200)
    expect(await authGet.text()).toContain('consent_password')

    // 3. POST /authorize with the password → 302 to redirect_uri?code=...&state=...
    const authForm = new URLSearchParams(authQs)
    authForm.set('consent_password', PASSWORD)
    const authPost = await fetch(`${baseUrl}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: authForm.toString(),
      redirect: 'manual'
    })
    expect(authPost.status).toBe(302)
    const location = authPost.headers.get('location') ?? ''
    const locUrl = new URL(location)
    expect(locUrl.origin + locUrl.pathname).toBe(REDIRECT)
    expect(locUrl.searchParams.get('state')).toBe('opaque-state-pg')
    const code = locUrl.searchParams.get('code') ?? ''
    expect(code).toMatch(/^cdck_code_/)

    // 4. POST /token (authorization_code grant) → access+refresh
    const tokenForm = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: reg.client_id,
      code_verifier: VERIFIER
    })
    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenForm.toString()
    })
    expect(tokenRes.status).toBe(200)
    expect(tokenRes.headers.get('cache-control')).toBe('no-store')
    const tokens = (await tokenRes.json()) as {
      access_token: string
      refresh_token: string
      token_type: string
    }
    expect(tokens.token_type).toBe('Bearer')

    // 5. Call /mcp with the access token — MCP responds.
    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(mcpRes.status).toBe(200)
    const mcpBody = (await mcpRes.json()) as { result?: { tools: Array<{ name: string }> } }
    expect(mcpBody.result?.tools.map((t) => t.name)).toContain('ping')

    // 6. Refresh rotation works.
    const refreshRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token
      }).toString()
    })
    expect(refreshRes.status).toBe(200)
    const refreshed = (await refreshRes.json()) as {
      access_token: string
      refresh_token: string
    }
    expect(refreshed.access_token).not.toBe(tokens.access_token)
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)
  })

  it('POST /mcp without bearer → 401 with WWW-Authenticate', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`
    )
  })
})
