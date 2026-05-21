import { describe, it, expect } from 'vitest'
import { authServerMetadata, protectedResourceMetadata } from '../discovery'

describe('discovery — authServerMetadata (RFC 8414)', () => {
  it('emits all required spec fields with PKCE S256 only + no client secret', () => {
    const meta = authServerMetadata('https://mcp.choda.dev')
    expect(meta).toEqual({
      issuer: 'https://mcp.choda.dev',
      authorization_endpoint: 'https://mcp.choda.dev/authorize',
      token_endpoint: 'https://mcp.choda.dev/token',
      registration_endpoint: 'https://mcp.choda.dev/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none']
    })
  })

  it('strips a trailing slash from issuer (RFC 8414 §2)', () => {
    const meta = authServerMetadata('https://mcp.choda.dev/')
    expect(meta.issuer).toBe('https://mcp.choda.dev')
    expect(meta.authorization_endpoint).toBe('https://mcp.choda.dev/authorize')
  })
})

describe('discovery — protectedResourceMetadata (RFC 9728)', () => {
  it('points at /mcp on the same origin with the AS as authoritative', () => {
    const meta = protectedResourceMetadata('https://mcp.choda.dev')
    expect(meta).toEqual({
      resource: 'https://mcp.choda.dev/mcp',
      authorization_servers: ['https://mcp.choda.dev'],
      bearer_methods_supported: ['header']
    })
  })
})
