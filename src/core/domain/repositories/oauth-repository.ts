import { randomBytes } from 'crypto'
import type Database from 'better-sqlite3'

// ADR-027: minimal OAuth 2.0 + DCR storage. CRUD over oauth_clients,
// oauth_auth_codes, oauth_tokens. Token rotation uses the "keep-revoked"
// pattern so a replayed refresh token can be detected and revoke its whole
// chain (OAuth 2.1 §4.13.2).

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

interface ClientRow {
  client_id: string
  client_name: string
  redirect_uris: string
  created_at: string
}

interface AuthCodeRow {
  code: string
  client_id: string
  code_challenge: string
  redirect_uri: string
  expires_at: string
}

interface TokenRow {
  access_token: string
  refresh_token: string
  client_id: string
  access_expires_at: string
  refresh_expires_at: string
  revoked: number
}

export class OAuthRepository {
  private readonly insertClient: Database.Statement
  private readonly selectClient: Database.Statement
  private readonly insertAuthCode: Database.Statement
  private readonly consumeAuthCodeStmt: Database.Statement
  private readonly insertToken: Database.Statement
  private readonly selectAccessToken: Database.Statement
  private readonly selectRefreshToken: Database.Statement
  private readonly markRevoked: Database.Statement
  private readonly revokeAllForClient: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.insertClient = db.prepare(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
       VALUES (?, ?, ?)`
    )
    this.selectClient = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?')
    this.insertAuthCode = db.prepare(
      `INSERT INTO oauth_auth_codes
         (code, client_id, code_challenge, code_challenge_method, redirect_uri, expires_at)
       VALUES (?, ?, ?, 'S256', ?, ?)`
    )
    // RETURNING makes this atomic single-use: row vanishes the moment we read it.
    this.consumeAuthCodeStmt = db.prepare(
      'DELETE FROM oauth_auth_codes WHERE code = ? RETURNING *'
    )
    this.insertToken = db.prepare(
      `INSERT INTO oauth_tokens
         (access_token, refresh_token, client_id, access_expires_at, refresh_expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    this.selectAccessToken = db.prepare(
      'SELECT * FROM oauth_tokens WHERE access_token = ? AND revoked = 0'
    )
    this.selectRefreshToken = db.prepare(
      'SELECT * FROM oauth_tokens WHERE refresh_token = ?'
    )
    this.markRevoked = db.prepare(
      'UPDATE oauth_tokens SET revoked = 1 WHERE access_token = ?'
    )
    this.revokeAllForClient = db.prepare(
      'UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ?'
    )
  }

  registerClient(input: { clientName: string; redirectUris: string[] }): OAuthClient {
    const clientId = `cdck_cli_${randomToken(16)}`
    this.insertClient.run(clientId, input.clientName, JSON.stringify(input.redirectUris))
    const row = this.selectClient.get(clientId) as ClientRow
    return rowToClient(row)
  }

  getClient(clientId: string): OAuthClient | null {
    const row = this.selectClient.get(clientId) as ClientRow | undefined
    return row ? rowToClient(row) : null
  }

  createAuthCode(input: OAuthAuthCodeInput): OAuthAuthCode {
    const code = `cdck_code_${randomToken(32)}`
    const expiresAt = isoFromNow(input.ttlSeconds)
    this.insertAuthCode.run(
      code,
      input.clientId,
      input.codeChallenge,
      input.redirectUri,
      expiresAt
    )
    return {
      code,
      clientId: input.clientId,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      expiresAt
    }
  }

  // Single-use: deletes the row even if expired. Caller must check expiresAt.
  consumeAuthCode(code: string): OAuthAuthCode | null {
    const row = this.consumeAuthCodeStmt.get(code) as AuthCodeRow | undefined
    if (!row) return null
    return {
      code: row.code,
      clientId: row.client_id,
      codeChallenge: row.code_challenge,
      redirectUri: row.redirect_uri,
      expiresAt: row.expires_at
    }
  }

  createTokens(input: {
    clientId: string
    accessTtlSeconds: number
    refreshTtlSeconds: number
  }): OAuthAccessToken {
    const accessToken = `cdck_at_${randomToken(32)}`
    const refreshToken = `cdck_rt_${randomToken(32)}`
    const accessExpiresAt = isoFromNow(input.accessTtlSeconds)
    const refreshExpiresAt = isoFromNow(input.refreshTtlSeconds)
    this.insertToken.run(
      accessToken,
      refreshToken,
      input.clientId,
      accessExpiresAt,
      refreshExpiresAt
    )
    return {
      accessToken,
      refreshToken,
      clientId: input.clientId,
      accessExpiresAt,
      refreshExpiresAt
    }
  }

  // Returns the row only if not revoked and not expired. Otherwise null.
  validateAccessToken(accessToken: string): OAuthAccessToken | null {
    const row = this.selectAccessToken.get(accessToken) as TokenRow | undefined
    if (!row) return null
    if (Date.parse(row.access_expires_at) <= Date.now()) return null
    return rowToToken(row)
  }

  // Atomic transaction: detect replay (revoked refresh) → revoke chain;
  // detect expiry → invalid_grant; happy path → mark old revoked + insert new.
  rotateRefresh(
    refreshToken: string,
    ttls: { accessTtlSeconds: number; refreshTtlSeconds: number }
  ): RotateResult {
    const tx = this.db.transaction((): RotateResult => {
      const row = this.selectRefreshToken.get(refreshToken) as TokenRow | undefined
      if (!row) return { ok: false, error: 'invalid_grant' }
      if (row.revoked === 1) {
        // Replay of an already-rotated refresh token → revoke the whole chain.
        this.revokeAllForClient.run(row.client_id)
        return { ok: false, error: 'replay_detected' }
      }
      if (Date.parse(row.refresh_expires_at) <= Date.now()) {
        return { ok: false, error: 'invalid_grant' }
      }
      this.markRevoked.run(row.access_token)
      const fresh = this.createTokens({
        clientId: row.client_id,
        accessTtlSeconds: ttls.accessTtlSeconds,
        refreshTtlSeconds: ttls.refreshTtlSeconds
      })
      return { ok: true, tokens: fresh }
    })
    return tx()
  }
}

function rowToClient(row: ClientRow): OAuthClient {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    createdAt: row.created_at
  }
}

function rowToToken(row: TokenRow): OAuthAccessToken {
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    clientId: row.client_id,
    accessExpiresAt: row.access_expires_at,
    refreshExpiresAt: row.refresh_expires_at
  }
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

function isoFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString()
}
