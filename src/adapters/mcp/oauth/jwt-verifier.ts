// ADR-034: Keycloak-issued JWT validation for HTTP `/mcp`. choda-deck is the
// resource server — it no longer mints tokens (ADR-027), it verifies tokens
// Keycloak signed. Zero-dep: JWK→KeyObject + RS256 verify via Node's built-in
// `crypto`, JWKS fetched from the realm's `…/certs` endpoint and cached by kid.
//
// verify() NEVER throws — malformed token, bad signature, wrong iss/aud, expiry,
// or a JWKS fetch error all return null. The caller (verifyOAuthBearer) maps
// null → 401. This keeps a flaky Keycloak from 500-ing the transport.

import {
  createPublicKey,
  createVerify,
  type KeyObject,
  type JsonWebKey as NodeJsonWebKey
} from 'crypto'

export interface KeycloakJwtConfig {
  issuer: string // https://id.choda.dev/realms/<realm> — expected `iss`
  audience: string // expected `aud` (or `azp` fallback)
  jwksUri: string // issuer + /protocol/openid-connect/certs
}

export interface JwtClaims {
  sub: string
  iss: string
  exp: number
  aud?: string | string[]
  azp?: string
  [claim: string]: unknown
}

export interface JwtVerifier {
  verify(token: string): Promise<JwtClaims | null>
}

interface Jwk {
  kid: string
  kty: string
  alg?: string
  use?: string
  n?: string
  e?: string
}

// Injectable for tests — defaults to fetching the realm JWKS over HTTP.
export type JwksLoader = () => Promise<Jwk[]>

const REFRESH_THROTTLE_MS = 10_000

export function createKeycloakVerifier(
  config: KeycloakJwtConfig,
  loadKeys?: JwksLoader
): JwtVerifier {
  return new KeycloakJwtVerifier(config, loadKeys ?? defaultJwksLoader(config.jwksUri))
}

class KeycloakJwtVerifier implements JwtVerifier {
  private keys = new Map<string, KeyObject>()
  private lastFetchMs = 0
  private inflight: Promise<void> | null = null

  constructor(
    private readonly config: KeycloakJwtConfig,
    private readonly loadKeys: JwksLoader
  ) {}

  async verify(token: string): Promise<JwtClaims | null> {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerB64, payloadB64, signatureB64] = parts

    const header = decodeJson<{ alg?: string; kid?: string }>(headerB64)
    if (!header || header.alg !== 'RS256' || !header.kid) return null

    const key = await this.resolveKey(header.kid)
    if (!key) return null

    if (!verifySignature(`${headerB64}.${payloadB64}`, signatureB64, key)) return null

    const claims = decodeJson<JwtClaims>(payloadB64)
    if (!claims) return null
    if (!this.claimsValid(claims)) return null
    return claims
  }

  private claimsValid(claims: JwtClaims): boolean {
    if (claims.iss !== this.config.issuer) return false
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return false
    return audienceMatches(claims, this.config.audience)
  }

  // Cache by kid; on an unknown kid (key rollover) refetch once, throttled so a
  // bogus-kid flood can't hammer Keycloak.
  private async resolveKey(kid: string): Promise<KeyObject | null> {
    const cached = this.keys.get(kid)
    if (cached) return cached
    if (Date.now() - this.lastFetchMs < REFRESH_THROTTLE_MS) return null
    await this.refresh()
    return this.keys.get(kid) ?? null
  }

  private async refresh(): Promise<void> {
    if (this.inflight) return this.inflight
    this.inflight = (async (): Promise<void> => {
      try {
        const jwks = await this.loadKeys()
        const next = new Map<string, KeyObject>()
        for (const jwk of jwks) {
          if (jwk.kty !== 'RSA' || !jwk.kid || !jwk.n || !jwk.e) continue
          try {
            next.set(
              jwk.kid,
              createPublicKey({ key: jwk as unknown as NodeJsonWebKey, format: 'jwk' })
            )
          } catch {
            // skip an unparseable key, keep the rest
          }
        }
        this.keys = next
        this.lastFetchMs = Date.now()
      } catch {
        // Network/parse failure — keep the stale cache, bump the throttle clock
        // so we don't retry-storm.
        this.lastFetchMs = Date.now()
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }
}

function audienceMatches(claims: JwtClaims, expected: string): boolean {
  const aud = claims.aud
  if (typeof aud === 'string' && aud === expected) return true
  if (Array.isArray(aud) && aud.includes(expected)) return true
  // Keycloak access tokens often carry the client in `azp` rather than `aud`
  // (it lacks full RFC 8707 resource-indicator support — see ADR-034).
  return claims.azp === expected
}

function verifySignature(signingInput: string, signatureB64: string, key: KeyObject): boolean {
  try {
    const verifier = createVerify('RSA-SHA256')
    verifier.update(signingInput)
    verifier.end()
    return verifier.verify(key, base64UrlToBuffer(signatureB64))
  } catch {
    return false
  }
}

function decodeJson<T>(segment: string): T | null {
  try {
    return JSON.parse(base64UrlToBuffer(segment).toString('utf8')) as T
  } catch {
    return null
  }
}

function base64UrlToBuffer(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(padded, 'base64')
}

function defaultJwksLoader(jwksUri: string): JwksLoader {
  return async (): Promise<Jwk[]> => {
    const res = await fetch(jwksUri, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`JWKS fetch ${res.status}`)
    const body = (await res.json()) as { keys?: Jwk[] }
    return body.keys ?? []
  }
}
