import { describe, it, expect } from 'vitest'
import {
  handleAuthorizeRedirect,
  handleRegisterStatic,
  handleTokenProxy,
  type KeycloakProxyConfig
} from '../keycloak-proxy'

const CFG: KeycloakProxyConfig = {
  authorizationEndpoint: 'https://id.choda.dev/realms/choda/protocol/openid-connect/auth',
  tokenEndpoint: 'https://id.choda.dev/realms/choda/protocol/openid-connect/token',
  clientId: 'choda-connector'
}

describe('keycloak-proxy — handleAuthorizeRedirect', () => {
  it('forwards PKCE + state + redirect_uri to the Keycloak authorize endpoint', () => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'choda-connector',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: 'xyz',
      code_challenge_method: 'S256',
      state: 's1',
      scope: 'openid'
    })
    const { location } = handleAuthorizeRedirect(CFG, params)
    const url = new URL(location)
    expect(url.origin + url.pathname).toBe(CFG.authorizationEndpoint)
    expect(url.searchParams.get('code_challenge')).toBe('xyz')
    expect(url.searchParams.get('state')).toBe('s1')
    expect(url.searchParams.get('scope')).toBe('openid')
  })

  it('defaults client_id + response_type when the client omits them', () => {
    const { location } = handleAuthorizeRedirect(CFG, new URLSearchParams({ state: 's' }))
    const url = new URL(location)
    expect(url.searchParams.get('client_id')).toBe('choda-connector')
    expect(url.searchParams.get('response_type')).toBe('code')
  })
})

describe('keycloak-proxy — handleRegisterStatic', () => {
  it('returns the pinned public client with echoed redirect_uris', () => {
    const result = handleRegisterStatic(CFG, {
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback']
    })
    expect(result.status).toBe(201)
    expect(result.body).toMatchObject({
      client_id: 'choda-connector',
      token_endpoint_auth_method: 'none',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback']
    })
  })

  it('tolerates a missing/!array redirect_uris', () => {
    const result = handleRegisterStatic(CFG, { client_name: 'x' })
    expect((result.body as { redirect_uris: string[] }).redirect_uris).toEqual([])
  })
})

describe('keycloak-proxy — handleTokenProxy', () => {
  it('forwards the grant to Keycloak and returns its body verbatim', async () => {
    let capturedUrl = ''
    let capturedBody = ''
    const fetchStub = (async (url: string, init: { body: string }) => {
      capturedUrl = url
      capturedBody = init.body
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'kc-at', refresh_token: 'kc-rt', token_type: 'Bearer' })
      }
    }) as unknown as typeof fetch

    const form = new URLSearchParams({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v' })
    const result = await handleTokenProxy(CFG, form, fetchStub)

    expect(capturedUrl).toBe(CFG.tokenEndpoint)
    expect(capturedBody).toContain('grant_type=authorization_code')
    expect(capturedBody).toContain('client_id=choda-connector') // injected default
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ access_token: 'kc-at', token_type: 'Bearer' })
  })

  it('passes through a Keycloak error response (e.g. invalid_grant)', async () => {
    const fetchStub = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' })
    })) as unknown as typeof fetch
    const result = await handleTokenProxy(CFG, new URLSearchParams(), fetchStub)
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ error: 'invalid_grant' })
  })

  it('maps an unreachable Keycloak to a 502 server_error', async () => {
    const fetchStub = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const result = await handleTokenProxy(CFG, new URLSearchParams(), fetchStub)
    expect(result.status).toBe(502)
    expect(result.body).toMatchObject({ error: 'server_error' })
  })
})
