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
  it('mints a client_id and persists redirect_uris JSON', async () => {
    const client = await repo.registerClient({
      clientName: 'test-client',
      redirectUris: ['https://example.com/cb', 'https://claude.ai/api/mcp/auth_callback']
    })
    expect(client.clientId).toMatch(/^cdck_cli_/)
    const fetched = await repo.getClient(client.clientId)
    expect(fetched?.redirectUris).toEqual([
      'https://example.com/cb',
      'https://claude.ai/api/mcp/auth_callback'
    ])
  })

  it('returns null for unknown client_id', async () => {
    expect(await repo.getClient('cdck_cli_nonexistent')).toBeNull()
  })
})

describe('OAuthRepository — auth codes', () => {
  it('consumes a code exactly once (single-use)', async () => {
    const client = await repo.registerClient({
      clientName: 'c',
      redirectUris: ['https://x/cb']
    })
    const ac = await repo.createAuthCode({
      clientId: client.clientId,
      codeChallenge: 'challenge',
      redirectUri: 'https://x/cb',
      ttlSeconds: 60
    })
    const first = await repo.consumeAuthCode(ac.code)
    const second = await repo.consumeAuthCode(ac.code)
    expect(first?.code).toBe(ac.code)
    expect(second).toBeNull()
  })

  it('returns the expired row from consume — caller checks expiresAt', async () => {
    const client = await repo.registerClient({
      clientName: 'c',
      redirectUris: ['https://x/cb']
    })
    const ac = await repo.createAuthCode({
      clientId: client.clientId,
      codeChallenge: 'challenge',
      redirectUri: 'https://x/cb',
      ttlSeconds: -1 // already expired
    })
    const consumed = await repo.consumeAuthCode(ac.code)
    expect(consumed).not.toBeNull()
    expect(Date.parse(consumed!.expiresAt)).toBeLessThanOrEqual(Date.now())
  })
})

describe('OAuthRepository — tokens', () => {
  async function mintTokens(): Promise<{
    clientId: string
    refreshToken: string
    accessToken: string
  }> {
    const client = await repo.registerClient({
      clientName: 'c',
      redirectUris: ['https://x/cb']
    })
    const t = await repo.createTokens({
      clientId: client.clientId,
      accessTtlSeconds: 3600,
      refreshTtlSeconds: 60 * 60 * 24 * 30
    })
    return { clientId: client.clientId, refreshToken: t.refreshToken, accessToken: t.accessToken }
  }

  it('validateAccessToken returns the row for a fresh, non-revoked token', async () => {
    const { accessToken } = await mintTokens()
    expect((await repo.validateAccessToken(accessToken))?.accessToken).toBe(accessToken)
  })

  it('validateAccessToken returns null for an expired token', async () => {
    const client = await repo.registerClient({
      clientName: 'c',
      redirectUris: ['https://x/cb']
    })
    const t = await repo.createTokens({
      clientId: client.clientId,
      accessTtlSeconds: -1,
      refreshTtlSeconds: 60
    })
    expect(await repo.validateAccessToken(t.accessToken)).toBeNull()
  })
})

describe('OAuthRepository — refresh rotation', () => {
  const ttls = { accessTtlSeconds: 3600, refreshTtlSeconds: 60 * 60 * 24 * 30 }

  async function setup(): Promise<{ clientId: string; refresh: string; access: string }> {
    const client = await repo.registerClient({
      clientName: 'c',
      redirectUris: ['https://x/cb']
    })
    const t = await repo.createTokens({ clientId: client.clientId, ...ttls })
    return { clientId: client.clientId, refresh: t.refreshToken, access: t.accessToken }
  }

  it('happy path: rotates to a new pair, old access becomes invalid', async () => {
    const { access, refresh } = await setup()
    const result = await repo.rotateRefresh(refresh, ttls)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tokens.accessToken).not.toBe(access)
    expect(result.tokens.refreshToken).not.toBe(refresh)
    // Old access token now revoked.
    expect(await repo.validateAccessToken(access)).toBeNull()
    // New access token works.
    expect((await repo.validateAccessToken(result.tokens.accessToken))?.accessToken).toBe(
      result.tokens.accessToken
    )
  })

  it('unknown refresh token → invalid_grant', async () => {
    const result = await repo.rotateRefresh('cdck_rt_nope', ttls)
    expect(result).toEqual({ ok: false, error: 'invalid_grant' })
  })

  it('expired refresh token → invalid_grant', async () => {
    const client = await repo.registerClient({
      clientName: 'c',
      redirectUris: ['https://x/cb']
    })
    const t = await repo.createTokens({
      clientId: client.clientId,
      accessTtlSeconds: -1,
      refreshTtlSeconds: -1
    })
    const result = await repo.rotateRefresh(t.refreshToken, ttls)
    expect(result).toEqual({ ok: false, error: 'invalid_grant' })
  })

  it('replay of already-rotated refresh → revokes the entire chain', async () => {
    const { clientId, refresh } = await setup()
    const first = await repo.rotateRefresh(refresh, ttls)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // Now replay the original refresh — should detect + revoke chain.
    const replay = await repo.rotateRefresh(refresh, ttls)
    expect(replay).toEqual({ ok: false, error: 'replay_detected' })

    // The successor that was minted on the first rotation is now revoked too.
    expect(await repo.validateAccessToken(first.tokens.accessToken)).toBeNull()

    // Any future rotation on the chain fails too.
    const subsequent = await repo.rotateRefresh(first.tokens.refreshToken, ttls)
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
