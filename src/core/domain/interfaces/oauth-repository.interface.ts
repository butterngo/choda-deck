// ADR-027 OAuth storage contract. Both SQLite and Postgres repos implement
// this — the HTTP-layer handlers (authorize/register/token/verifyOAuthBearer)
// program against this interface, not the concrete classes.

export interface OAuthClient {
  clientId: string
  clientName: string
  redirectUris: string[]
  createdAt: string
}

export interface OAuthAuthCodeInput {
  clientId: string
  codeChallenge: string
  redirectUri: string
  ttlSeconds: number
}

export interface OAuthAuthCode {
  code: string
  clientId: string
  codeChallenge: string
  redirectUri: string
  expiresAt: string
}

export interface OAuthAccessToken {
  accessToken: string
  refreshToken: string
  clientId: string
  accessExpiresAt: string
  refreshExpiresAt: string
}

export type RotateResult =
  | { ok: true; tokens: OAuthAccessToken }
  | { ok: false; error: 'invalid_grant' | 'replay_detected' }

export interface OAuthOperations {
  registerClient(input: { clientName: string; redirectUris: string[] }): Promise<OAuthClient>
  getClient(clientId: string): Promise<OAuthClient | null>

  createAuthCode(input: OAuthAuthCodeInput): Promise<OAuthAuthCode>
  // Single-use: deletes the row even if expired. Caller must check expiresAt.
  consumeAuthCode(code: string): Promise<OAuthAuthCode | null>

  createTokens(input: {
    clientId: string
    accessTtlSeconds: number
    refreshTtlSeconds: number
  }): Promise<OAuthAccessToken>

  // Returns the row only if not revoked AND not expired. Otherwise null.
  validateAccessToken(accessToken: string): Promise<OAuthAccessToken | null>

  // Atomic: detect replay (revoked refresh) → revoke chain;
  // detect expiry → invalid_grant; happy path → mark old revoked + insert new.
  rotateRefresh(
    refreshToken: string,
    ttls: { accessTtlSeconds: number; refreshTtlSeconds: number }
  ): Promise<RotateResult>
}
