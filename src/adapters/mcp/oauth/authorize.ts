import { createHash, timingSafeEqual } from 'crypto'
import { Buffer } from 'buffer'
import type { OAuthRepository } from '../../../core/domain/repositories/oauth-repository'
import type { OAuthClient } from '../../../core/domain/repositories/oauth-repository'
import { renderConsentScreen } from './consent-template'

// ADR-027: /authorize handlers. GET renders the consent screen; POST validates
// the pre-shared password, mints a PKCE-bound auth code, and redirects to the
// client's registered redirect_uri with ?code=...&state=...
//
// RFC 6749 §4.1.2.1: if client_id or redirect_uri is missing/invalid, we MUST
// NOT redirect — render a 400 HTML error page instead. All other validation
// failures redirect to the client's redirect_uri with ?error=...

export type AuthorizeResult =
  | { kind: 'html'; status: number; html: string }
  | { kind: 'redirect'; status: 302; location: string }

const AUTH_CODE_TTL_SECONDS = 60
const CHALLENGE_MIN_LEN = 43
const CHALLENGE_MAX_LEN = 128

interface Params {
  responseType: string | null
  clientId: string | null
  redirectUri: string | null
  state: string | null
  codeChallenge: string | null
  codeChallengeMethod: string | null
}

export function handleAuthorizeGet(
  repo: OAuthRepository,
  query: URLSearchParams
): AuthorizeResult {
  const params = parseParams(query)
  const v = validate(repo, params)
  if (v.kind !== 'ok') return v.result
  return renderForm(params, v.client.clientName)
}

export function handleAuthorizePost(
  repo: OAuthRepository,
  form: URLSearchParams,
  consentPasswordHashHex: string
): AuthorizeResult {
  const params = parseParams(form)
  const v = validate(repo, params)
  if (v.kind !== 'ok') return v.result

  const submitted = form.get('consent_password') ?? ''
  if (!verifyConsentPassword(submitted, consentPasswordHashHex)) {
    return {
      kind: 'html',
      status: 401,
      html: renderConsentScreen({
        clientName: v.client.clientName,
        clientId: params.clientId as string,
        redirectUri: params.redirectUri as string,
        state: params.state,
        codeChallenge: params.codeChallenge as string,
        codeChallengeMethod: 'S256',
        responseType: 'code',
        errorMessage: 'Incorrect consent password.'
      })
    }
  }

  const ac = repo.createAuthCode({
    clientId: params.clientId as string,
    codeChallenge: params.codeChallenge as string,
    redirectUri: params.redirectUri as string,
    ttlSeconds: AUTH_CODE_TTL_SECONDS
  })

  const url = new URL(params.redirectUri as string)
  url.searchParams.set('code', ac.code)
  if (params.state !== null) url.searchParams.set('state', params.state)
  return { kind: 'redirect', status: 302, location: url.toString() }
}

function parseParams(p: URLSearchParams): Params {
  return {
    responseType: p.get('response_type'),
    clientId: p.get('client_id'),
    redirectUri: p.get('redirect_uri'),
    state: p.get('state'),
    codeChallenge: p.get('code_challenge'),
    codeChallengeMethod: p.get('code_challenge_method')
  }
}

type Validation =
  | { kind: 'ok'; client: OAuthClient }
  | { kind: 'fatal'; result: AuthorizeResult }
  | { kind: 'redirectError'; result: AuthorizeResult }

function validate(repo: OAuthRepository, p: Params): Validation {
  if (!p.clientId) {
    return { kind: 'fatal', result: htmlError(400, 'Missing client_id.') }
  }
  const client = repo.getClient(p.clientId)
  if (!client) {
    return { kind: 'fatal', result: htmlError(400, 'Unknown client_id.') }
  }
  if (!p.redirectUri || !client.redirectUris.includes(p.redirectUri)) {
    return {
      kind: 'fatal',
      result: htmlError(400, 'Missing or unregistered redirect_uri.')
    }
  }

  if (p.responseType !== 'code') {
    return {
      kind: 'redirectError',
      result: redirectWithError(p.redirectUri, p.state, 'unsupported_response_type')
    }
  }
  if (p.codeChallengeMethod !== 'S256') {
    return {
      kind: 'redirectError',
      result: redirectWithError(
        p.redirectUri,
        p.state,
        'invalid_request',
        'code_challenge_method must be S256'
      )
    }
  }
  if (
    !p.codeChallenge ||
    p.codeChallenge.length < CHALLENGE_MIN_LEN ||
    p.codeChallenge.length > CHALLENGE_MAX_LEN
  ) {
    return {
      kind: 'redirectError',
      result: redirectWithError(
        p.redirectUri,
        p.state,
        'invalid_request',
        'code_challenge missing or wrong length'
      )
    }
  }

  return { kind: 'ok', client }
}

function renderForm(p: Params, clientName: string): AuthorizeResult {
  return {
    kind: 'html',
    status: 200,
    html: renderConsentScreen({
      clientName,
      clientId: p.clientId as string,
      redirectUri: p.redirectUri as string,
      state: p.state,
      codeChallenge: p.codeChallenge as string,
      codeChallengeMethod: 'S256',
      responseType: 'code'
    })
  }
}

function htmlError(status: number, message: string): AuthorizeResult {
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>OAuth error</title></head><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Authorization error</h1><p>${escapeHtml(message)}</p></body></html>`
  return { kind: 'html', status, html }
}

function redirectWithError(
  redirectUri: string,
  state: string | null,
  error: string,
  errorDescription?: string
): AuthorizeResult {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  if (errorDescription) url.searchParams.set('error_description', errorDescription)
  if (state !== null) url.searchParams.set('state', state)
  return { kind: 'redirect', status: 302, location: url.toString() }
}

function verifyConsentPassword(submitted: string, expectedHashHex: string): boolean {
  if (submitted.length === 0 || expectedHashHex.length === 0) return false
  const submittedHash = createHash('sha256').update(submitted, 'utf8').digest()
  let expected: Buffer
  try {
    expected = Buffer.from(expectedHashHex, 'hex')
  } catch {
    return false
  }
  if (submittedHash.length !== expected.length) return false
  return timingSafeEqual(submittedHash, expected)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
