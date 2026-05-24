// ADR-030 — Postgres sibling of OAuthRepository (ADR-027).
//
// Shape parity with SQLite via the shared OAuthOperations interface — both
// repos implement it so the HTTP transport (authorize/register/token/
// verifyOAuthBearer) is backend-agnostic.
//
// Schema differences:
//   - redirect_uris JSONB (vs SQLite JSON-encoded TEXT) — node-pg auto-parses
//   - revoked BOOLEAN (vs SQLite INTEGER 0/1)
//   - code_challenge_method CHECK = 'S256' (same as SQLite)
//
// rotateRefresh stays atomic via BEGIN/COMMIT in conn.transaction — same
// replay-detect / revoke-chain semantics as the SQLite repo.

import { randomBytes } from 'crypto'
import type { PgConnection, TxClient } from './connection'
import type {
  OAuthAccessToken,
  OAuthAuthCode,
  OAuthAuthCodeInput,
  OAuthClient,
  OAuthOperations,
  RotateResult
} from '../../interfaces/oauth-repository.interface'

interface ClientDbRow {
  client_id: string
  client_name: string
  redirect_uris: string[]
  created_at: Date
}

interface AuthCodeDbRow {
  code: string
  client_id: string
  code_challenge: string
  redirect_uri: string
  expires_at: string
}

interface TokenDbRow {
  access_token: string
  refresh_token: string
  client_id: string
  access_expires_at: string
  refresh_expires_at: string
  revoked: boolean
}

function rowToClient(row: ClientDbRow): OAuthClient {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    createdAt: row.created_at.toISOString()
  }
}

function rowToToken(row: TokenDbRow): OAuthAccessToken {
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

export class PostgresOAuthRepository implements OAuthOperations {
  constructor(private readonly conn: PgConnection) {}

  async registerClient(input: {
    clientName: string
    redirectUris: string[]
  }): Promise<OAuthClient> {
    const clientId = `cdck_cli_${randomToken(16)}`
    const result = await this.conn.query<ClientDbRow>(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
       VALUES ($1, $2, $3::jsonb)
       RETURNING client_id, client_name, redirect_uris, created_at`,
      [clientId, input.clientName, JSON.stringify(input.redirectUris)]
    )
    return rowToClient(result.rows[0])
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const result = await this.conn.query<ClientDbRow>(
      `SELECT client_id, client_name, redirect_uris, created_at
       FROM oauth_clients WHERE client_id = $1`,
      [clientId]
    )
    const row = result.rows[0]
    return row ? rowToClient(row) : null
  }

  async createAuthCode(input: OAuthAuthCodeInput): Promise<OAuthAuthCode> {
    const code = `cdck_code_${randomToken(32)}`
    const expiresAt = isoFromNow(input.ttlSeconds)
    await this.conn.query(
      `INSERT INTO oauth_auth_codes
         (code, client_id, code_challenge, code_challenge_method, redirect_uri, expires_at)
       VALUES ($1, $2, $3, 'S256', $4, $5)`,
      [code, input.clientId, input.codeChallenge, input.redirectUri, expiresAt]
    )
    return {
      code,
      clientId: input.clientId,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      expiresAt
    }
  }

  // Single-use: DELETE...RETURNING removes the row even if expired.
  // Caller is expected to check expiresAt.
  async consumeAuthCode(code: string): Promise<OAuthAuthCode | null> {
    const result = await this.conn.query<AuthCodeDbRow>(
      `DELETE FROM oauth_auth_codes WHERE code = $1
       RETURNING code, client_id, code_challenge, redirect_uri, expires_at`,
      [code]
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      code: row.code,
      clientId: row.client_id,
      codeChallenge: row.code_challenge,
      redirectUri: row.redirect_uri,
      expiresAt: row.expires_at
    }
  }

  async createTokens(input: {
    clientId: string
    accessTtlSeconds: number
    refreshTtlSeconds: number
  }): Promise<OAuthAccessToken> {
    const accessToken = `cdck_at_${randomToken(32)}`
    const refreshToken = `cdck_rt_${randomToken(32)}`
    const accessExpiresAt = isoFromNow(input.accessTtlSeconds)
    const refreshExpiresAt = isoFromNow(input.refreshTtlSeconds)
    await this.conn.query(
      `INSERT INTO oauth_tokens
         (access_token, refresh_token, client_id, access_expires_at, refresh_expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [accessToken, refreshToken, input.clientId, accessExpiresAt, refreshExpiresAt]
    )
    return {
      accessToken,
      refreshToken,
      clientId: input.clientId,
      accessExpiresAt,
      refreshExpiresAt
    }
  }

  // Returns the row only if not revoked AND not expired. Otherwise null.
  async validateAccessToken(accessToken: string): Promise<OAuthAccessToken | null> {
    const result = await this.conn.query<TokenDbRow>(
      `SELECT access_token, refresh_token, client_id, access_expires_at,
              refresh_expires_at, revoked
       FROM oauth_tokens WHERE access_token = $1 AND revoked = FALSE`,
      [accessToken]
    )
    const row = result.rows[0]
    if (!row) return null
    if (Date.parse(row.access_expires_at) <= Date.now()) return null
    return rowToToken(row)
  }

  // Atomic: detect replay (revoked refresh) → revoke chain;
  // detect expiry → invalid_grant; happy path → mark old revoked + insert new.
  async rotateRefresh(
    refreshToken: string,
    ttls: { accessTtlSeconds: number; refreshTtlSeconds: number }
  ): Promise<RotateResult> {
    return this.conn.transaction(async (tx: TxClient): Promise<RotateResult> => {
      const lookup = await tx.query<TokenDbRow>(
        `SELECT access_token, refresh_token, client_id, access_expires_at,
                refresh_expires_at, revoked
         FROM oauth_tokens WHERE refresh_token = $1`,
        [refreshToken]
      )
      const row = lookup.rows[0]
      if (!row) return { ok: false, error: 'invalid_grant' }
      if (row.revoked) {
        // Replay of an already-rotated refresh token → revoke the whole chain.
        await tx.query('UPDATE oauth_tokens SET revoked = TRUE WHERE client_id = $1', [
          row.client_id
        ])
        return { ok: false, error: 'replay_detected' }
      }
      if (Date.parse(row.refresh_expires_at) <= Date.now()) {
        return { ok: false, error: 'invalid_grant' }
      }
      await tx.query('UPDATE oauth_tokens SET revoked = TRUE WHERE access_token = $1', [
        row.access_token
      ])
      // Mint fresh inside the same transaction — inlined (not calling createTokens
      // outside the tx) so the rotate is a single atomic unit.
      const accessToken = `cdck_at_${randomToken(32)}`
      const newRefreshToken = `cdck_rt_${randomToken(32)}`
      const accessExpiresAt = isoFromNow(ttls.accessTtlSeconds)
      const refreshExpiresAt = isoFromNow(ttls.refreshTtlSeconds)
      await tx.query(
        `INSERT INTO oauth_tokens
           (access_token, refresh_token, client_id, access_expires_at, refresh_expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [accessToken, newRefreshToken, row.client_id, accessExpiresAt, refreshExpiresAt]
      )
      return {
        ok: true,
        tokens: {
          accessToken,
          refreshToken: newRefreshToken,
          clientId: row.client_id,
          accessExpiresAt,
          refreshExpiresAt
        }
      }
    })
  }
}
