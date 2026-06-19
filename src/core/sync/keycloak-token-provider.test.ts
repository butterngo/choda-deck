// TASK-1108 — KeycloakTokenProvider unit tests with injected fetch + clock.

import { describe, it, expect } from 'vitest'
import { KeycloakTokenProvider } from './keycloak-token-provider'

interface FakeCall {
  url: string
  grantType: string
  body: URLSearchParams
}

// Build a fetch stub that records grant calls and returns a scripted token grant
// per grant_type. `password` and `refresh_token` handlers can be swapped per test.
function makeFetch(handlers: {
  password?: () => Response
  refresh_token?: () => Response
}): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = new URLSearchParams(init.body as string)
    const grantType = body.get('grant_type') ?? ''
    calls.push({ url, grantType, body })
    const handler = handlers[grantType as 'password' | 'refresh_token']
    if (!handler) return new Response('', { status: 400 })
    return handler()
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function grant(body: {
  access_token: string
  expires_in: number
  refresh_token?: string
  refresh_expires_in?: number
}): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

const base = {
  issuer: 'https://id.test/realms/demo',
  clientId: 'claude-connector',
  clientSecret: 'secret',
  username: 'mcp-user',
  password: 'pw',
  refreshMarginSec: 30
}

describe('KeycloakTokenProvider', () => {
  it('mints via the password grant on first call and hits the realm token endpoint', async () => {
    const { fetchImpl, calls } = makeFetch({
      password: () => grant({ access_token: 'AT1', expires_in: 300, refresh_token: 'RT1', refresh_expires_in: 1800 })
    })
    const p = new KeycloakTokenProvider({ ...base, fetchImpl, now: () => 0 })
    expect(await p.getToken()).toBe('AT1')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://id.test/realms/demo/protocol/openid-connect/token')
    expect(calls[0].grantType).toBe('password')
    expect(calls[0].body.get('client_secret')).toBe('secret')
    expect(calls[0].body.get('username')).toBe('mcp-user')
  })

  it('returns the cached access token without a network call while inside the window', async () => {
    let t = 0
    const { fetchImpl, calls } = makeFetch({
      password: () => grant({ access_token: 'AT1', expires_in: 300, refresh_token: 'RT1', refresh_expires_in: 1800 })
    })
    const p = new KeycloakTokenProvider({ ...base, fetchImpl, now: () => t })
    await p.getToken()
    t = 200_000 // 200s in — still > 30s before the 300s expiry
    expect(await p.getToken()).toBe('AT1')
    expect(calls).toHaveLength(1)
  })

  it('refreshes via the refresh_token grant once inside the expiry margin', async () => {
    let t = 0
    const { fetchImpl, calls } = makeFetch({
      password: () => grant({ access_token: 'AT1', expires_in: 300, refresh_token: 'RT1', refresh_expires_in: 1800 }),
      refresh_token: () => grant({ access_token: 'AT2', expires_in: 300, refresh_token: 'RT2', refresh_expires_in: 1800 })
    })
    const p = new KeycloakTokenProvider({ ...base, fetchImpl, now: () => t })
    expect(await p.getToken()).toBe('AT1')
    t = 280_000 // within 30s of the 300s access expiry
    expect(await p.getToken()).toBe('AT2')
    expect(calls.map((c) => c.grantType)).toEqual(['password', 'refresh_token'])
    expect(calls[1].body.get('refresh_token')).toBe('RT1')
  })

  it('falls back to the password grant when the refresh token is rejected', async () => {
    let t = 0
    let refreshOk = false
    const { fetchImpl, calls } = makeFetch({
      password: () =>
        grant({ access_token: refreshOk ? 'X' : 'AT_PW', expires_in: 300, refresh_token: 'RTx', refresh_expires_in: 1800 }),
      refresh_token: () => new Response('', { status: 400 })
    })
    const p = new KeycloakTokenProvider({ ...base, fetchImpl, now: () => t })
    await p.getToken() // AT1 via password
    t = 280_000 // inside margin → tries refresh (400) → password fallback
    expect(await p.getToken()).toBe('AT_PW')
    expect(calls.map((c) => c.grantType)).toEqual(['password', 'refresh_token', 'password'])
  })

  it('falls back to the password grant when the refresh token itself expired (long sleep)', async () => {
    let t = 0
    const { fetchImpl, calls } = makeFetch({
      password: () => grant({ access_token: 'AT_PW2', expires_in: 300, refresh_token: 'RT1', refresh_expires_in: 1800 })
    })
    const p = new KeycloakTokenProvider({ ...base, fetchImpl, now: () => t })
    await p.getToken()
    t = 2_000_000 // > 1800s refresh TTL → skip refresh, password directly
    expect(await p.getToken()).toBe('AT_PW2')
    // no refresh_token grant attempted — refresh window already gone
    expect(calls.map((c) => c.grantType)).toEqual(['password', 'password'])
  })

  it('coalesces concurrent getToken calls into a single mint', async () => {
    const { fetchImpl, calls } = makeFetch({
      password: () => grant({ access_token: 'AT1', expires_in: 300, refresh_token: 'RT1', refresh_expires_in: 1800 })
    })
    const p = new KeycloakTokenProvider({ ...base, fetchImpl, now: () => 0 })
    const [a, b] = await Promise.all([p.getToken(), p.getToken()])
    expect(a).toBe('AT1')
    expect(b).toBe('AT1')
    expect(calls).toHaveLength(1)
  })

  it('omits client_secret for a public client', async () => {
    const { fetchImpl, calls } = makeFetch({
      password: () => grant({ access_token: 'AT1', expires_in: 300 })
    })
    const p = new KeycloakTokenProvider({ ...base, clientSecret: undefined, fetchImpl, now: () => 0 })
    await p.getToken()
    expect(calls[0].body.has('client_secret')).toBe(false)
  })
})
