import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, createSign, type KeyObject } from 'crypto'
import { createKeycloakVerifier } from '../jwt-verifier'

// ADR-034: validates Keycloak-issued RS256 JWTs against the realm JWKS. We
// generate a real RSA keypair, publish its public half as a JWK (the stub
// "JWKS"), and sign tokens with the private half — so this exercises the actual
// signature path, not a mock.

const ISSUER = 'https://id.choda.dev/realms/choda'
const AUDIENCE = 'choda-connector'
const JWKS_URI = `${ISSUER}/protocol/openid-connect/certs`
const KID = 'test-key-1'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function signJwt(
  claims: Record<string, unknown>,
  opts: { kid?: string; key?: KeyObject; alg?: string } = {}
): string {
  const header = { alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? KID }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const sig = b64url(signer.sign(opts.key ?? privateKey))
  return `${signingInput}.${sig}`
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'butter',
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides
  }
}

function makeVerifier(): ReturnType<typeof createKeycloakVerifier> {
  return createKeycloakVerifier(
    { issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI },
    async () => [jwk as never]
  )
}

describe('jwt-verifier — Keycloak RS256 validation', () => {
  it('accepts a correctly signed, in-date token with matching iss + aud', async () => {
    const claims = await makeVerifier().verify(signJwt(validClaims()))
    expect(claims?.sub).toBe('butter')
  })

  it('accepts when the client is in azp (not aud) — Keycloak audience quirk', async () => {
    const token = signJwt(validClaims({ aud: 'account', azp: AUDIENCE }))
    expect(await makeVerifier().verify(token)).not.toBeNull()
  })

  it('rejects a tampered signature', async () => {
    const token = signJwt(validClaims())
    const tampered = token.slice(0, -4) + 'AAAA'
    expect(await makeVerifier().verify(tampered)).toBeNull()
  })

  it('rejects a token signed by a different key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const token = signJwt(validClaims(), { key: other.privateKey })
    expect(await makeVerifier().verify(token)).toBeNull()
  })

  it('rejects a wrong issuer', async () => {
    const token = signJwt(validClaims({ iss: 'https://evil.example/realms/x' }))
    expect(await makeVerifier().verify(token)).toBeNull()
  })

  it('rejects a wrong audience (no azp match either)', async () => {
    const token = signJwt(validClaims({ aud: 'someone-else', azp: 'someone-else' }))
    expect(await makeVerifier().verify(token)).toBeNull()
  })

  it('rejects an expired token', async () => {
    const token = signJwt(validClaims({ exp: Math.floor(Date.now() / 1000) - 10 }))
    expect(await makeVerifier().verify(token)).toBeNull()
  })

  it('rejects a non-RS256 alg', async () => {
    const token = signJwt(validClaims(), { alg: 'none' })
    expect(await makeVerifier().verify(token)).toBeNull()
  })

  it('rejects an unknown kid', async () => {
    const token = signJwt(validClaims(), { kid: 'unknown-kid' })
    expect(await makeVerifier().verify(token)).toBeNull()
  })

  it('rejects a structurally malformed token', async () => {
    expect(await makeVerifier().verify('not-a-jwt')).toBeNull()
  })
})
