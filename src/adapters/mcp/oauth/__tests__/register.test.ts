import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { initSchema } from '../../../../core/domain/repositories/schema'
import { OAuthRepository } from '../../../../core/domain/repositories/oauth-repository'
import { handleRegister } from '../register'

let tmpDir: string
let db: Database.Database
let repo: OAuthRepository

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-register-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  initSchema(db)
  repo = new OAuthRepository(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('handleRegister — happy path', () => {
  it('mints a client_id, persists, returns RFC 7591 response (201)', async () => {
    const result = await handleRegister(repo, {
      client_name: 'claude.ai',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback']
    })
    expect(result.status).toBe(201)
    const body = result.body as Record<string, unknown>
    expect(body.client_id).toMatch(/^cdck_cli_/)
    expect(body.client_name).toBe('claude.ai')
    expect(body.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback'])
    expect(body.token_endpoint_auth_method).toBe('none')
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(body.response_types).toEqual(['code'])
    expect(typeof body.client_id_issued_at).toBe('number')

    // Persisted
    const fetched = await repo.getClient(body.client_id as string)
    expect(fetched?.redirectUris).toEqual(['https://claude.ai/api/mcp/auth_callback'])
  })

  it('defaults client_name when omitted', async () => {
    const result = await handleRegister(repo, {
      redirect_uris: ['https://x.test/cb']
    })
    expect(result.status).toBe(201)
    expect((result.body as { client_name: string }).client_name).toBe('mcp-client')
  })

  it('accepts multiple redirect_uris', async () => {
    const result = await handleRegister(repo, {
      client_name: 'multi',
      redirect_uris: ['https://a.test/cb', 'https://b.test/cb']
    })
    expect(result.status).toBe(201)
    expect((result.body as { redirect_uris: string[] }).redirect_uris).toEqual([
      'https://a.test/cb',
      'https://b.test/cb'
    ])
  })
})

describe('handleRegister — validation', () => {
  it('rejects non-object body with invalid_client_metadata', async () => {
    expect(await handleRegister(repo, null)).toEqual({
      status: 400,
      body: {
        error: 'invalid_client_metadata',
        error_description: 'request body must be a JSON object'
      }
    })
    expect((await handleRegister(repo, 'string')).status).toBe(400)
  })

  it('rejects missing or empty redirect_uris', async () => {
    expect((await handleRegister(repo, {})).status).toBe(400)
    expect((await handleRegister(repo, { redirect_uris: [] })).status).toBe(400)
    expect((await handleRegister(repo, { redirect_uris: 'https://x/cb' })).status).toBe(400)
  })

  it('rejects non-http(s) redirect_uris', async () => {
    const result = await handleRegister(repo, {
      redirect_uris: ['ftp://x.test/cb']
    })
    expect(result.status).toBe(400)
    expect((result.body as { error: string }).error).toBe('invalid_redirect_uri')
  })

  it('rejects malformed redirect_uris', async () => {
    const result = await handleRegister(repo, {
      redirect_uris: ['not a url']
    })
    expect(result.status).toBe(400)
    expect((result.body as { error: string }).error).toBe('invalid_redirect_uri')
  })

  it('rejects when any one of several redirect_uris is bad', async () => {
    const result = await handleRegister(repo, {
      redirect_uris: ['https://a.test/cb', 'javascript:alert(1)']
    })
    expect(result.status).toBe(400)
  })
})
