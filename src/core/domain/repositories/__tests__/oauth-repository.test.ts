import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { initSchema } from '../schema'
import { OAuthRepository } from '../oauth-repository'

let tmpDir: string
let db: Database.Database
let repo: OAuthRepository

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-repo-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  initSchema(db)
  repo = new OAuthRepository(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('OAuthRepository — clients', () => {
  it('mints a client_id and persists redirect_uris JSON', () => {
    const client = repo.registerClient({
      clientName: 'test-client',
      redirectUris: ['https://example.com/cb', 'https://claude.ai/api/mcp/auth_callback']
    })
    expect(client.clientId).toMatch(/^cdck_cli_/)
    const fetched = repo.getClient(client.clientId)
    expect(fetched?.redirectUris).toEqual([
      'https://example.com/cb',
      'https://claude.ai/api/mcp/auth_callback'
    ])
  })

  it('returns null for unknown client_id', () => {
    expect(repo.getClient('cdck_cli_nonexistent')).toBeNull()
  })
})

describe('OAuthRepository — auth codes', () => {
  it('consumes a code exactly once (single-use)', () => {
    const client = repo.registerClient({ clientName: 'c', redirectUris: ['https://x/cb'] })
    const ac = repo.createAuthCode({
      clientId: client.clientId,
      codeChallenge: 'challenge',
      redirectUri: 'https://x/cb',
      ttlSeconds: 60
    })
    const first = repo.consumeAuthCode(ac.code)
    const second = repo.consumeAuthCode(ac.code)
    expect(first?.code).toBe(ac.code)
    expect(second).toBeNull()
  })

  it('returns the expired row from consume — caller checks expiresAt', () => {
    const client = repo.registerClient({ clientName: 'c', redirectUris: ['https://x/cb'] })
    const ac = repo.createAuthCode({
      clientId: client.clientId,
      codeChallenge: 'challenge',
      redirectUri: 'https://x/cb',
      ttlSeconds: -1 // already expired
    })
    const consumed = repo.consumeAuthCode(ac.code)
    expect(consumed).not.toBeNull()
    expect(Date.parse(consumed!.expiresAt)).toBeLessThanOrEqual(Date.now())
  })
})

describe('OAuthRepository — tokens', () => {
  function mintTokens(): { clientId: string; refreshToken: string; accessToken: string } {
    const client = repo.registerClient({ clientName: 'c', redirectUris: ['https://x/cb'] })
    const t = repo.createTokens({
      clientId: client.clientId,
      accessTtlSeconds: 3600,
      refreshTtlSeconds: 60 * 60 * 24 * 30
    })
    return { clientId: client.clientId, refreshToken: t.refreshToken, accessToken: t.accessToken }
  }

  it('validateAccessToken returns the row for a fresh, non-revoked token', () => {
    const { accessToken } = mintTokens()
    expect(repo.validateAccessToken(accessToken)?.accessToken).toBe(accessToken)
  })

  it('validateAccessToken returns null for an expired token', () => {
    const client = repo.registerClient({ clientName: 'c', redirectUris: ['https://x/cb'] })
    const t = repo.createTokens({
      clientId: client.clientId,
      accessTtlSeconds: -1,
      refreshTtlSeconds: 60
    })
    expect(repo.validateAccessToken(t.accessToken)).toBeNull()
  })
})

describe('OAuthRepository — refresh rotation', () => {
  const ttls = { accessTtlSeconds: 3600, refreshTtlSeconds: 60 * 60 * 24 * 30 }

  function setup(): { clientId: string; refresh: string; access: string } {
    const client = repo.registerClient({ clientName: 'c', redirectUris: ['https://x/cb'] })
    const t = repo.createTokens({ clientId: client.clientId, ...ttls })
    return { clientId: client.clientId, refresh: t.refreshToken, access: t.accessToken }
  }

  it('happy path: rotates to a new pair, old access becomes invalid', () => {
    const { access, refresh } = setup()
    const result = repo.rotateRefresh(refresh, ttls)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tokens.accessToken).not.toBe(access)
    expect(result.tokens.refreshToken).not.toBe(refresh)
    // Old access token now revoked.
    expect(repo.validateAccessToken(access)).toBeNull()
    // New access token works.
    expect(repo.validateAccessToken(result.tokens.accessToken)?.accessToken).toBe(
      result.tokens.accessToken
    )
  })

  it('unknown refresh token → invalid_grant', () => {
    const result = repo.rotateRefresh('cdck_rt_nope', ttls)
    expect(result).toEqual({ ok: false, error: 'invalid_grant' })
  })

  it('expired refresh token → invalid_grant', () => {
    const client = repo.registerClient({ clientName: 'c', redirectUris: ['https://x/cb'] })
    const t = repo.createTokens({
      clientId: client.clientId,
      accessTtlSeconds: -1,
      refreshTtlSeconds: -1
    })
    const result = repo.rotateRefresh(t.refreshToken, ttls)
    expect(result).toEqual({ ok: false, error: 'invalid_grant' })
  })

  it('replay of already-rotated refresh → revokes the entire chain', () => {
    const { clientId, refresh } = setup()
    const first = repo.rotateRefresh(refresh, ttls)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // Now replay the original refresh — should detect + revoke chain.
    const replay = repo.rotateRefresh(refresh, ttls)
    expect(replay).toEqual({ ok: false, error: 'replay_detected' })

    // The successor that was minted on the first rotation is now revoked too.
    expect(repo.validateAccessToken(first.tokens.accessToken)).toBeNull()

    // Any future rotation on the chain fails too.
    const subsequent = repo.rotateRefresh(first.tokens.refreshToken, ttls)
    expect(subsequent.ok).toBe(false)
    if (subsequent.ok) return
    // The refresh token row still exists but is revoked → replay_detected.
    expect(subsequent.error).toBe('replay_detected')

    // No tokens for this client are valid anymore.
    const stillThere = db
      .prepare('SELECT COUNT(*) AS n FROM oauth_tokens WHERE client_id = ? AND revoked = 0')
      .get(clientId) as { n: number }
    expect(stillThere.n).toBe(0)
  })
})
