import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../../../test/postgres-harness'
import { migrate } from '../migrations'
import { PostgresOAuthRepository } from '../oauth-repository.pg'

describeIfDocker('PostgresOAuthRepository', () => {
  let env: PgTestEnv
  let repo: PostgresOAuthRepository

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    await migrate(env.conn)
    repo = new PostgresOAuthRepository(env.conn)
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    // FK order: tokens + auth_codes both reference clients
    await env.conn.query('DELETE FROM oauth_tokens')
    await env.conn.query('DELETE FROM oauth_auth_codes')
    await env.conn.query('DELETE FROM oauth_clients')
  })

  // ── clients ──────────────────────────────────────────────────────────────
  it('registerClient mints cdck_cli_* id; getClient round-trips JSONB redirect_uris', async () => {
    const client = await repo.registerClient({
      clientName: 'My App',
      redirectUris: ['https://app.example.com/cb', 'http://localhost:3000/cb']
    })
    expect(client.clientId).toMatch(/^cdck_cli_/)
    expect(client.clientName).toBe('My App')
    expect(client.redirectUris).toEqual([
      'https://app.example.com/cb',
      'http://localhost:3000/cb'
    ])
    expect(client.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const fetched = await repo.getClient(client.clientId)
    expect(fetched).toEqual(client)

    expect(await repo.getClient('cdck_cli_missing')).toBeNull()
  })

  // ── auth codes ───────────────────────────────────────────────────────────
  it('createAuthCode mints code with S256; consumeAuthCode is single-use', async () => {
    const client = await repo.registerClient({ clientName: 'X', redirectUris: ['x://'] })
    const code = await repo.createAuthCode({
      clientId: client.clientId,
      codeChallenge: 'abc123',
      redirectUri: 'x://',
      ttlSeconds: 60
    })
    expect(code.code).toMatch(/^cdck_code_/)
    expect(code.codeChallenge).toBe('abc123')

    const first = await repo.consumeAuthCode(code.code)
    expect(first?.code).toBe(code.code)

    const second = await repo.consumeAuthCode(code.code)
    expect(second).toBeNull()
  })

  it('consumeAuthCode returns the row even when expired (caller is responsible)', async () => {
    const client = await repo.registerClient({ clientName: 'X', redirectUris: ['x://'] })
    const code = await repo.createAuthCode({
      clientId: client.clientId,
      codeChallenge: 'c',
      redirectUri: 'x://',
      ttlSeconds: -1 // already expired
    })
    const consumed = await repo.consumeAuthCode(code.code)
    expect(consumed?.code).toBe(code.code)
    expect(Date.parse(consumed!.expiresAt)).toBeLessThan(Date.now())
  })

  it('auth_codes CHECK rejects non-S256 code_challenge_method', async () => {
    const client = await repo.registerClient({ clientName: 'X', redirectUris: ['x://'] })
    await expect(
      env.conn.query(
        `INSERT INTO oauth_auth_codes
           (code, client_id, code_challenge, code_challenge_method, redirect_uri, expires_at)
         VALUES ('c-bad', $1, 'c', 'plain', 'x://', 'now')`,
        [client.clientId]
      )
    ).rejects.toThrow(/code_challenge_method|check constraint/i)
  })

  it('auth_codes FK rejects unknown client_id', async () => {
    await expect(
      repo.createAuthCode({
        clientId: 'cdck_cli_unknown',
        codeChallenge: 'c',
        redirectUri: 'x://',
        ttlSeconds: 60
      })
    ).rejects.toThrow(/foreign key|violates|client/i)
  })

  // ── tokens ───────────────────────────────────────────────────────────────
  it('createTokens mints cdck_at_*/cdck_rt_*; validateAccessToken filters revoked + expired', async () => {
    const client = await repo.registerClient({ clientName: 'X', redirectUris: ['x://'] })
    const tokens = await repo.createTokens({
      clientId: client.clientId,
      accessTtlSeconds: 300,
      refreshTtlSeconds: 3600
    })
    expect(tokens.accessToken).toMatch(/^cdck_at_/)
    expect(tokens.refreshToken).toMatch(/^cdck_rt_/)

    const valid = await repo.validateAccessToken(tokens.accessToken)
    expect(valid?.accessToken).toBe(tokens.accessToken)

    // Mint an already-expired access token directly
    const expired = await repo.createTokens({
      clientId: client.clientId,
      accessTtlSeconds: -1,
      refreshTtlSeconds: 3600
    })
    expect(await repo.validateAccessToken(expired.accessToken)).toBeNull()

    // Revoke via direct UPDATE then validate
    await env.conn.query('UPDATE oauth_tokens SET revoked = TRUE WHERE access_token = $1', [
      tokens.accessToken
    ])
    expect(await repo.validateAccessToken(tokens.accessToken)).toBeNull()
  })

  // ── rotateRefresh ────────────────────────────────────────────────────────
  it('rotateRefresh happy path: revokes old, returns fresh, old access invalid', async () => {
    const client = await repo.registerClient({ clientName: 'X', redirectUris: ['x://'] })
    const t1 = await repo.createTokens({
      clientId: client.clientId,
      accessTtlSeconds: 300,
      refreshTtlSeconds: 3600
    })
    const result = await repo.rotateRefresh(t1.refreshToken, {
      accessTtlSeconds: 300,
      refreshTtlSeconds: 3600
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tokens.accessToken).not.toBe(t1.accessToken)
    expect(result.tokens.refreshToken).not.toBe(t1.refreshToken)
    expect(result.tokens.clientId).toBe(client.clientId)

    // Old access token no longer validates
    expect(await repo.validateAccessToken(t1.accessToken)).toBeNull()
    // New one does
    expect(await repo.validateAccessToken(result.tokens.accessToken)).not.toBeNull()
  })

  it('rotateRefresh replay detection: re-using revoked refresh revokes whole client chain', async () => {
    const client = await repo.registerClient({ clientName: 'X', redirectUris: ['x://'] })
    const t1 = await repo.createTokens({
      clientId: client.clientId,
      accessTtlSeconds: 300,
      refreshTtlSeconds: 3600
    })
    const first = await repo.rotateRefresh(t1.refreshToken, {
      accessTtlSeconds: 300,
      refreshTtlSeconds: 3600
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // Replay the original refresh — should detect replay AND revoke the new chain
    const replay = await repo.rotateRefresh(t1.refreshToken, {
      accessTtlSeconds: 300,
      refreshTtlSeconds: 3600
    })
    expect(replay).toEqual({ ok: false, error: 'replay_detected' })

    // The fresh access from `first` should now be invalid too — whole chain revoked
    expect(await repo.validateAccessToken(first.tokens.accessToken)).toBeNull()
  })

  it('rotateRefresh unknown token returns invalid_grant', async () => {
    const r = await repo.rotateRefresh('cdck_rt_nope', {
      accessTtlSeconds: 300,
      refreshTtlSeconds: 3600
    })
    expect(r).toEqual({ ok: false, error: 'invalid_grant' })
  })

  it('rotateRefresh expired refresh returns invalid_grant (but does not revoke)', async () => {
    const client = await repo.registerClient({ clientName: 'X', redirectUris: ['x://'] })
    const t = await repo.createTokens({
      clientId: client.clientId,
      accessTtlSeconds: 300,
      refreshTtlSeconds: -1
    })
    const r = await repo.rotateRefresh(t.refreshToken, {
      accessTtlSeconds: 300,
      refreshTtlSeconds: 3600
    })
    expect(r).toEqual({ ok: false, error: 'invalid_grant' })

    // Access token (still valid by TTL) should remain valid — expired refresh
    // is NOT replay; nothing should be revoked.
    expect(await repo.validateAccessToken(t.accessToken)).not.toBeNull()
  })

  it('tokens FK rejects unknown client_id', async () => {
    await expect(
      repo.createTokens({
        clientId: 'cdck_cli_no',
        accessTtlSeconds: 300,
        refreshTtlSeconds: 3600
      })
    ).rejects.toThrow(/foreign key|violates|client/i)
  })
})
