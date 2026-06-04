// ADR-034: on-origin OAuth endpoints that proxy to Keycloak. The claude.ai web
// connector ignores external authorization/token endpoints from metadata and
// hardcodes /authorize, /token, /register on the MCP origin (anthropics/
// claude-ai-mcp#82, closed not-planned). So these endpoints stay on choda-deck's
// origin but delegate everything to Keycloak:
//   - GET  /authorize → 302 to Keycloak's authorize (browser logs in there)
//   - POST /token     → forward the grant to Keycloak's token endpoint verbatim
//   - POST /register  → return a pinned Keycloak public client (no live DCR)
//
// PKCE is verified BY Keycloak — choda-deck forwards code_challenge / code_verifier
// untouched. No local token store, no consent screen.

export interface KeycloakProxyConfig {
  authorizationEndpoint: string // …/protocol/openid-connect/auth
  tokenEndpoint: string // …/protocol/openid-connect/token
  clientId: string // pinned public client registered in Keycloak
  clientSecret?: string // only if the pinned client is confidential
}

export interface ProxyResult {
  status: number
  body: object
}

export interface RedirectResult {
  location: string
}

// Authorization-request params we forward to Keycloak. Anything else (consent
// password etc. from the old self-issued flow) is intentionally dropped.
const FORWARDED_AUTHORIZE_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'scope',
  'code_challenge',
  'code_challenge_method',
  'nonce',
  'resource'
] as const

export function handleAuthorizeRedirect(
  cfg: KeycloakProxyConfig,
  params: URLSearchParams
): RedirectResult {
  const forwarded = new URLSearchParams()
  for (const key of FORWARDED_AUTHORIZE_PARAMS) {
    const value = params.get(key)
    if (value !== null) forwarded.set(key, value)
  }
  // Default the public client + auth-code flow when the client omits them.
  if (!forwarded.has('client_id')) forwarded.set('client_id', cfg.clientId)
  if (!forwarded.has('response_type')) forwarded.set('response_type', 'code')
  return { location: `${cfg.authorizationEndpoint}?${forwarded.toString()}` }
}

export async function handleTokenProxy(
  cfg: KeycloakProxyConfig,
  form: URLSearchParams,
  fetchImpl: typeof fetch = fetch
): Promise<ProxyResult> {
  const upstream = new URLSearchParams(form)
  if (!upstream.has('client_id')) upstream.set('client_id', cfg.clientId)
  if (cfg.clientSecret && !upstream.has('client_secret')) {
    upstream.set('client_secret', cfg.clientSecret)
  }

  try {
    const res = await fetchImpl(cfg.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body: upstream.toString()
    })
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body: body as object }
  } catch {
    // Keycloak unreachable — surface as an OAuth server_error per RFC 6749 §5.2.
    return {
      status: 502,
      body: { error: 'server_error', error_description: 'authorization server unreachable' }
    }
  }
}

// No live DCR — return the pre-registered Keycloak client. Shape mirrors an
// RFC 7591 registration response so the connector accepts it. token_endpoint_
// auth_method 'none' = public client (PKCE replaces the secret).
export function handleRegisterStatic(cfg: KeycloakProxyConfig, parsed: unknown): ProxyResult {
  const redirectUris =
    isObject(parsed) && Array.isArray(parsed.redirect_uris)
      ? (parsed.redirect_uris as unknown[]).filter((u): u is string => typeof u === 'string')
      : []
  return {
    status: 201,
    body: {
      client_id: cfg.clientId,
      token_endpoint_auth_method: cfg.clientSecret ? 'client_secret_post' : 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: redirectUris
    }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
