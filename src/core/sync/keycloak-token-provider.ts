// TASK-1108 (ADR-030 §Update 2026-06-18) — Option A: client-side refresh-token
// flow so the CHODA_BACKEND=sync drain/pull loop survives Keycloak access-token
// expiry (access TTL ~300s). The loop's HTTP clients call getToken() per request
// instead of holding the boot-time bearer, so a long-running laptop keeps syncing.
//
// Token lifecycle (verified live against id.choda.dev/realms/demo, 2026-06-18):
//   - ROPC password grant returns a rotating refresh_token (no offline_access
//     scope needed). access expires_in=300s, refresh refresh_expires_in=1800s.
//   - The refresh_token grant rotates the refresh token on each use.
// Strategy: serve the cached access token until it is within `refreshMarginSec`
// of expiry, then refresh; if the refresh token is itself expired (laptop slept
// > 30 min) fall back to a fresh password grant. The durable credential is the
// ROPC username/password — the refresh token is only a warm-path optimization.

export interface TokenProvider {
  getToken(): Promise<string>
}

export interface KeycloakRopcConfig {
  // Realm issuer, e.g. https://id.choda.dev/realms/demo (no trailing slash).
  issuer: string
  clientId: string
  // Confidential-client secret; omit for a public client.
  clientSecret?: string
  username: string
  password: string
  // Refresh this many seconds before access-token expiry. Default 30.
  refreshMarginSec?: number
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch
  // Injectable clock in epoch ms; defaults to Date.now.
  now?: () => number
}

interface TokenGrant {
  access_token: string
  expires_in: number
  refresh_token?: string
  refresh_expires_in?: number
}

export class KeycloakTokenProvider implements TokenProvider {
  private readonly tokenUrl: string
  private readonly clientId: string
  private readonly clientSecret?: string
  private readonly username: string
  private readonly password: string
  private readonly marginMs: number
  private readonly fetchImpl: typeof fetch
  private readonly nowMs: () => number

  private accessToken: string | null = null
  private accessExpMs = 0
  private refreshToken: string | null = null
  private refreshExpMs = 0
  // Coalesce concurrent refreshes (write-through + loop) into one network call.
  private inflight: Promise<string> | null = null

  constructor(config: KeycloakRopcConfig) {
    this.tokenUrl = `${config.issuer.replace(/\/$/, '')}/protocol/openid-connect/token`
    this.clientId = config.clientId
    this.clientSecret = config.clientSecret
    this.username = config.username
    this.password = config.password
    this.marginMs = (config.refreshMarginSec ?? 30) * 1000
    this.fetchImpl = config.fetchImpl ?? fetch
    this.nowMs = config.now ?? Date.now
  }

  async getToken(): Promise<string> {
    if (this.accessToken && this.nowMs() < this.accessExpMs - this.marginMs) {
      return this.accessToken
    }
    if (this.inflight) return this.inflight
    this.inflight = this.mint().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  // Refresh when the refresh token is still live, else fall back to a fresh ROPC
  // password grant. Either path repopulates the cached access + refresh tokens.
  private async mint(): Promise<string> {
    if (this.refreshToken && this.nowMs() < this.refreshExpMs - this.marginMs) {
      try {
        return this.store(await this.grant({ grant_type: 'refresh_token', refresh_token: this.refreshToken }))
      } catch {
        // Refresh token rejected (revoked/rotated/expired) — fall through to ROPC.
      }
    }
    return this.store(
      await this.grant({ grant_type: 'password', username: this.username, password: this.password })
    )
  }

  private store(grant: TokenGrant): string {
    const at = this.nowMs()
    this.accessToken = grant.access_token
    this.accessExpMs = at + grant.expires_in * 1000
    this.refreshToken = grant.refresh_token ?? null
    this.refreshExpMs = grant.refresh_expires_in ? at + grant.refresh_expires_in * 1000 : 0
    return grant.access_token
  }

  private async grant(fields: Record<string, string>): Promise<TokenGrant> {
    const body = new URLSearchParams({ client_id: this.clientId, ...fields })
    if (this.clientSecret) body.set('client_secret', this.clientSecret)
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString()
    })
    if (!res.ok) {
      throw new Error(`keycloak token: ${fields.grant_type} grant -> HTTP ${res.status}`)
    }
    return (await res.json()) as TokenGrant
  }
}

// Adapt a static bearer into the provider shape, so non-OAuth deployments
// (MCP_HTTP_TOKEN) keep working unchanged through the getToken() seam.
export function staticTokenProvider(token: string): TokenProvider {
  return { getToken: async () => token }
}

// Resolve the token seam for the HTTP sync clients: a getToken provider wins;
// else a static bearer string; else throw (a client with no credential is a bug).
export function resolveTokens(
  getToken?: () => Promise<string>,
  token?: string
): TokenProvider {
  if (getToken) return { getToken }
  if (token !== undefined) return staticTokenProvider(token)
  throw new Error('HTTP sync client requires either getToken or token')
}
