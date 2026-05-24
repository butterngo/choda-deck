import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { initSchema } from '../../../../core/domain/repositories/schema'
import {
  OAuthRepository,
  type OAuthClient
} from '../../../../core/domain/repositories/oauth-repository'
import { handleAuthorizeGet, handleAuthorizePost } from '../authorize'

let tmpDir: string
let db: Database.Database
let repo: OAuthRepository
let client: OAuthClient

const PASSWORD = 'correct-horse-battery-staple'
const PASSWORD_HASH_HEX = createHash('sha256').update(PASSWORD, 'utf8').digest('hex')

const VALID_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' // 43 chars, RFC vector
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-authz-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  initSchema(db)
  repo = new OAuthRepository(db)
  client = await repo.registerClient({ clientName: 'claude.ai', redirectUris: [REDIRECT] })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function validParams(): URLSearchParams {
  return new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: REDIRECT,
    code_challenge: VALID_CHALLENGE,
    code_challenge_method: 'S256',
    state: 'xyz123'
  })
}

describe('handleAuthorizeGet — fatal errors (no redirect, 400 HTML)', () => {
  it('rejects missing client_id', async () => {
    const p = validParams()
    p.delete('client_id')
    const r = await handleAuthorizeGet(repo, p)
    expect(r.kind).toBe('html')
    if (r.kind !== 'html') return
    expect(r.status).toBe(400)
  })

  it('rejects unknown client_id', async () => {
    const p = validParams()
    p.set('client_id', 'cdck_cli_unknown')
    const r = await handleAuthorizeGet(repo, p)
    expect(r.kind).toBe('html')
    if (r.kind !== 'html') return
    expect(r.status).toBe(400)
  })

  it('rejects unregistered redirect_uri', async () => {
    const p = validParams()
    p.set('redirect_uri', 'https://attacker.test/cb')
    const r = await handleAuthorizeGet(repo, p)
    expect(r.kind).toBe('html')
    if (r.kind !== 'html') return
    expect(r.status).toBe(400)
  })
})

describe('handleAuthorizeGet — redirect errors (302 with ?error=...)', () => {
  it('redirects with unsupported_response_type when response_type != code', async () => {
    const p = validParams()
    p.set('response_type', 'token')
    const r = await handleAuthorizeGet(repo, p)
    expect(r.kind).toBe('redirect')
    if (r.kind !== 'redirect') return
    const url = new URL(r.location)
    expect(url.origin + url.pathname).toBe(REDIRECT)
    expect(url.searchParams.get('error')).toBe('unsupported_response_type')
    expect(url.searchParams.get('state')).toBe('xyz123')
  })

  it('redirects with invalid_request when code_challenge_method != S256', async () => {
    const p = validParams()
    p.set('code_challenge_method', 'plain')
    const r = await handleAuthorizeGet(repo, p)
    expect(r.kind).toBe('redirect')
    if (r.kind !== 'redirect') return
    expect(new URL(r.location).searchParams.get('error')).toBe('invalid_request')
  })

  it('redirects with invalid_request when code_challenge missing', async () => {
    const p = validParams()
    p.delete('code_challenge')
    const r = await handleAuthorizeGet(repo, p)
    expect(r.kind).toBe('redirect')
    if (r.kind !== 'redirect') return
    expect(new URL(r.location).searchParams.get('error')).toBe('invalid_request')
  })

  it('redirects with invalid_request when code_challenge wrong length', async () => {
    const p = validParams()
    p.set('code_challenge', 'short')
    const r = await handleAuthorizeGet(repo, p)
    expect(r.kind).toBe('redirect')
    if (r.kind !== 'redirect') return
    expect(new URL(r.location).searchParams.get('error')).toBe('invalid_request')
  })
})

describe('handleAuthorizeGet — happy path renders consent form', () => {
  it('returns 200 HTML with hidden fields carrying every param', async () => {
    const r = await handleAuthorizeGet(repo, validParams())
    expect(r.kind).toBe('html')
    if (r.kind !== 'html') return
    expect(r.status).toBe(200)
    expect(r.html).toContain('claude.ai')
    expect(r.html).toContain(client.clientId)
    expect(r.html).toContain(REDIRECT)
    expect(r.html).toContain(VALID_CHALLENGE)
    expect(r.html).toContain('value="xyz123"') // state preserved
    expect(r.html).toContain('name="consent_password"')
    expect(r.html).toContain('action="/authorize"')
  })
})

describe('handleAuthorizePost — password gate', () => {
  it('rejects missing password with 401 + re-rendered form', async () => {
    const r = await handleAuthorizePost(repo, validParams(), PASSWORD_HASH_HEX)
    expect(r.kind).toBe('html')
    if (r.kind !== 'html') return
    expect(r.status).toBe(401)
    expect(r.html).toContain('Incorrect consent password')
  })

  it('rejects wrong password with 401', async () => {
    const form = validParams()
    form.set('consent_password', 'wrong')
    const r = await handleAuthorizePost(repo, form, PASSWORD_HASH_HEX)
    expect(r.kind).toBe('html')
    if (r.kind !== 'html') return
    expect(r.status).toBe(401)
  })

  it('rejects when configured hash is empty', async () => {
    const form = validParams()
    form.set('consent_password', PASSWORD)
    const r = await handleAuthorizePost(repo, form, '')
    expect(r.kind).toBe('html')
    if (r.kind !== 'html') return
    expect(r.status).toBe(401)
  })
})

describe('handleAuthorizePost — happy path', () => {
  it('mints a code, persists it w/ challenge, redirects to redirect_uri?code=...&state=...', async () => {
    const form = validParams()
    form.set('consent_password', PASSWORD)
    const r = await handleAuthorizePost(repo, form, PASSWORD_HASH_HEX)
    expect(r.kind).toBe('redirect')
    if (r.kind !== 'redirect') return
    const url = new URL(r.location)
    expect(url.origin + url.pathname).toBe(REDIRECT)
    expect(url.searchParams.get('state')).toBe('xyz123')
    const code = url.searchParams.get('code')
    expect(code).toMatch(/^cdck_code_/)

    // Consume from repo to confirm persistence + correct binding
    const consumed = await repo.consumeAuthCode(code as string)
    expect(consumed).not.toBeNull()
    expect(consumed?.clientId).toBe(client.clientId)
    expect(consumed?.codeChallenge).toBe(VALID_CHALLENGE)
    expect(consumed?.redirectUri).toBe(REDIRECT)
  })

  it('omits state from redirect when client did not send one', async () => {
    const form = validParams()
    form.delete('state')
    form.set('consent_password', PASSWORD)
    const r = await handleAuthorizePost(repo, form, PASSWORD_HASH_HEX)
    expect(r.kind).toBe('redirect')
    if (r.kind !== 'redirect') return
    const url = new URL(r.location)
    expect(url.searchParams.has('state')).toBe(false)
    expect(url.searchParams.has('code')).toBe(true)
  })

  it('still validates params on POST (no trust in re-submitted hidden fields)', async () => {
    const form = validParams()
    form.set('client_id', 'cdck_cli_swapped')
    form.set('consent_password', PASSWORD)
    const r = await handleAuthorizePost(repo, form, PASSWORD_HASH_HEX)
    expect(r.kind).toBe('html')
    if (r.kind !== 'html') return
    expect(r.status).toBe(400)
  })
})
