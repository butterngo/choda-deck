// ADR-034: OAuth metadata documents. The AS endpoints live on choda-deck's
// origin (they proxy to Keycloak — see keycloak-proxy.ts) because the claude.ai
// web connector hardcodes them on the MCP origin (anthropics/claude-ai-mcp#82).
// So `authorization_servers` and the AS-metadata endpoints all point at the
// public origin, not directly at Keycloak. `realmIssuer` is surfaced only for
// reference / debugging — well-behaved clients (CLI/ChatGPT) still work because
// the origin endpoints proxy through.
//
// `origin` is the public origin the server is reachable at — e.g.
// `https://mcp.choda.dev`. No trailing slash (RFC 8414 §2 forbids it).

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

export function authServerMetadata(origin: string): AuthServerMetadata {
  const base = stripTrailingSlash(origin)
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

export function protectedResourceMetadata(origin: string): ProtectedResourceMetadata {
  const base = stripTrailingSlash(origin)
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header']
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}
