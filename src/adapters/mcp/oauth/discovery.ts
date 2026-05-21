// ADR-027: OAuth metadata documents. Both are pure functions of `issuer` so
// they're trivially testable and the HTTP layer just serializes the result.
//
// `issuer` is the public origin the server is reachable at — e.g.
// `https://mcp.choda.dev`. No trailing slash (RFC 8414 §2 forbids it).
//
// We advertise:
//   - response_types: ['code']                — only auth-code flow
//   - grant_types:    ['authorization_code', 'refresh_token']
//   - PKCE method:    S256 only               — matches the schema CHECK
//   - token auth:     'none'                  — public clients, no secret;
//                                               PKCE replaces the secret
//   - DCR endpoint:   /register               — RFC 7591

export interface AuthServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string
  response_types_supported: string[]
  grant_types_supported: string[]
  code_challenge_methods_supported: string[]
  token_endpoint_auth_methods_supported: string[]
}

export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers: string[]
  bearer_methods_supported: string[]
}

export function authServerMetadata(issuer: string): AuthServerMetadata {
  const base = stripTrailingSlash(issuer)
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none']
  }
}

export function protectedResourceMetadata(issuer: string): ProtectedResourceMetadata {
  const base = stripTrailingSlash(issuer)
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header']
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}
