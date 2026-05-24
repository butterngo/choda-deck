import type { OAuthOperations } from '../../../core/domain/interfaces/oauth-repository.interface'

// ADR-027: RFC 7591 Dynamic Client Registration. Public-client-only — we don't
// issue a client_secret because PKCE replaces it. Validation is intentionally
// minimal (just `redirect_uris`) so Anthropic's broker request shape isn't
// over-constrained; unknown metadata fields are ignored rather than rejected.

export interface RegisterResult {
  status: number
  body: object
}

interface RawRegisterRequest {
  client_name?: unknown
  redirect_uris?: unknown
}

export async function handleRegister(
  repo: OAuthOperations,
  raw: unknown
): Promise<RegisterResult> {
  if (raw === null || typeof raw !== 'object') {
    return errorResponse(400, 'invalid_client_metadata', 'request body must be a JSON object')
  }
  const req = raw as RawRegisterRequest

  if (!Array.isArray(req.redirect_uris) || req.redirect_uris.length === 0) {
    return errorResponse(
      400,
      'invalid_redirect_uri',
      'redirect_uris must be a non-empty array of URLs'
    )
  }
  if (!req.redirect_uris.every((u: unknown) => typeof u === 'string' && isHttpUrl(u))) {
    return errorResponse(
      400,
      'invalid_redirect_uri',
      'each redirect_uri must be an http(s) URL'
    )
  }

  const clientName = typeof req.client_name === 'string' ? req.client_name : 'mcp-client'

  const client = await repo.registerClient({
    clientName,
    redirectUris: req.redirect_uris as string[]
  })

  return {
    status: 201,
    body: {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }
}

function errorResponse(status: number, error: string, errorDescription: string): RegisterResult {
  return {
    status,
    body: { error, error_description: errorDescription }
  }
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}
