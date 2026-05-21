import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { initSchema } from '../../../../core/domain/repositories/schema'
import {
  OAuthRepository,
  type OAuthClient
} from '../../../../core/domain/repositories/oauth-repository'
import { computeChallengeS256 } from '../pkce'
import { handleToken } from '../token'

let tmpDir: string
let db: Database.Database
let repo: OAuthRepository
let client: OAuthClient

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = computeChallengeS256(VERIFIER)

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-token-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  initSchema(db)
  repo = new OAuthRepository(db)
  client = repo.registerClient({ clientName: 'claude.ai', redirectUris: [REDIRECT] })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function mintCode(opts?: { ttlSeconds?: number; redirectUri?: string }): string {
  const ac = repo.createAuthCode({
    clientId: client.clientId,
    codeChallenge: CHALLENGE,
    redirectUri: opts?.redirectUri ?? REDIRECT,
    ttlSeconds: opts?.ttlSeconds ?? 60
  })
  return ac.code
}

function codeGrant(overrides: Record<string, string>): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code: 'placeholder',
    redirect_uri: REDIRECT,
    client_id: client.clientId,
    code_verifier: VERIFIER,
    ...overrides
  })
}

describe('handleToken — authorization_code grant happy path', () => {
  it('exchanges code for access+refresh tokens', () => {
    const code = mintCode()
    const r = handleToken(repo, codeGrant({ code }))
    expect(r.status).toBe(200)
    const body = r.body as {
      access_token: string
      refresh_token: string
      token_type: string
      expires_in: number
    }
    expect(body.access_token).toMatch(/^cdck_at_/)
    expect(body.refresh_token).toMatch(/^cdck_rt_/)
    expect(body.token_type).toBe('Bearer')
    expect(body.expires_in).toBe(3600)
    expect(repo.validateAccessToken(body.access_token)?.clientId).toBe(client.clientId)
  })
})

describe('handleToken — authorization_code grant errors', () => {
  it('unknown code → invalid_grant', () => {
    const r = handleToken(repo, codeGrant({ code: 'cdck_code_nope' }))
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_grant')
  })

  it('expired code → invalid_grant', () => {
    const code = mintCode({ ttlSeconds: -1 })
    const r = handleToken(repo, codeGrant({ code }))
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_grant')
  })

  it('bad PKCE verifier → invalid_grant', () => {
    const code = mintCode()
    const r = handleToken(repo, codeGrant({ code, code_verifier: 'x'.repeat(64) }))
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_grant')
  })

  it('redirect_uri mismatch → invalid_grant', () => {
    const code = mintCode()
    const r = handleToken(repo, codeGrant({ code, redirect_uri: 'https://attacker.test/cb' }))
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_grant')
  })

  it('client_id mismatch → invalid_grant', () => {
    const code = mintCode()
    const r = handleToken(repo, codeGrant({ code, client_id: 'cdck_cli_other' }))
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_grant')
  })

  it('missing required params → invalid_request', () => {
    const form = codeGrant({ code: 'cdck_code_x' })
    form.delete('code_verifier')
    const r = handleToken(repo, form)
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_request')
  })

  it('a replayed code (already burned) → invalid_grant', () => {
    const code = mintCode()
    handleToken(repo, codeGrant({ code })) // first burn — success
    const r = handleToken(repo, codeGrant({ code })) // replay
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_grant')
  })
})

describe('handleToken — refresh_token grant', () => {
  function bootstrap(): { refresh: string; access: string } {
    const code = mintCode()
    const r = handleToken(repo, codeGrant({ code }))
    const body = r.body as { access_token: string; refresh_token: string }
    return { refresh: body.refresh_token, access: body.access_token }
  }

  it('rotates: new pair issued, old access revoked', () => {
    const { access, refresh } = bootstrap()
    const r = handleToken(
      repo,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh })
    )
    expect(r.status).toBe(200)
    const body = r.body as { access_token: string; refresh_token: string }
    expect(body.access_token).not.toBe(access)
    expect(body.refresh_token).not.toBe(refresh)
    expect(repo.validateAccessToken(access)).toBeNull()
    expect(repo.validateAccessToken(body.access_token)).not.toBeNull()
  })

  it('replayed refresh → invalid_grant + chain revoked', () => {
    const { refresh } = bootstrap()
    const first = handleToken(
      repo,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh })
    )
    expect(first.status).toBe(200)
    const newRefresh = (first.body as { refresh_token: string }).refresh_token

    // Replay the original refresh — should fail AND revoke the new tokens too.
    const replay = handleToken(
      repo,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh })
    )
    expect(replay.status).toBe(400)
    expect((replay.body as { error: string }).error).toBe('invalid_grant')

    // The successor refresh that was minted on the first rotation is now also dead.
    const subsequent = handleToken(
      repo,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: newRefresh })
    )
    expect(subsequent.status).toBe(400)
  })

  it('unknown refresh_token → invalid_grant', () => {
    const r = handleToken(
      repo,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'cdck_rt_nope' })
    )
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_grant')
  })

  it('missing refresh_token → invalid_request', () => {
    const r = handleToken(repo, new URLSearchParams({ grant_type: 'refresh_token' }))
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('invalid_request')
  })
})

describe('handleToken — grant type dispatch', () => {
  it('unknown grant_type → unsupported_grant_type', () => {
    const r = handleToken(repo, new URLSearchParams({ grant_type: 'password' }))
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('unsupported_grant_type')
  })

  it('missing grant_type → unsupported_grant_type', () => {
    const r = handleToken(repo, new URLSearchParams())
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('unsupported_grant_type')
  })
})
