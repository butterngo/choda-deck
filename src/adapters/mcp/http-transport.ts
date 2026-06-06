import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { authServerMetadata, protectedResourceMetadata } from './oauth/discovery'
import {
  handleAuthorizeRedirect,
  handleRegisterStatic,
  handleTokenProxy,
  type KeycloakProxyConfig
} from './oauth/keycloak-proxy'
import type { JwtVerifier } from './oauth/jwt-verifier'
import type { PullSource } from '../../core/sync/sync-pull'

const MAX_BODY_BYTES = 4 * 1024 * 1024

// Stateless mode requires a fresh McpServer + transport per request — the SDK
// transport carries init state across calls, so reusing a single instance
// across requests breaks after the first initialize. The factory hands us a
// new server (with tools already registered against shared services) each
// time. See SDK example simpleStatelessStreamableHttp.js.
export type McpServerFactory = () => Promise<McpServer> | McpServer

// ADR-034: Keycloak-backed auth. choda-deck proxies the OAuth endpoints to
// Keycloak and validates Keycloak-issued JWTs on /mcp — it no longer mints or
// stores tokens (ADR-027's oauth_* store is gone).
export interface OAuthConfig {
  origin: string // public origin, e.g. https://mcp.choda.dev — no trailing slash
  keycloak: KeycloakProxyConfig
  verifier: JwtVerifier
}

export interface HttpTransportOptions {
  port: number
  bind: string
  token: string // legacy bearer — ignored when `oauth` is set
  oauth?: OAuthConfig
  // ADR-030 Phase 2 — read-only pull source backing GET /sync/since. Omitted
  // when the backend can't produce deltas; the route then 404s.
  syncSource?: PullSource
}

export interface HttpTransportHandle {
  address: { port: number; bind: string }
  close: () => Promise<void>
}

class BodyTooLargeError extends Error {
  constructor() {
    super('body too large')
    this.name = 'BodyTooLargeError'
  }
}

export async function startHttpTransport(
  serverFactory: McpServerFactory,
  opts: HttpTransportOptions
): Promise<HttpTransportHandle> {
  const tokenBuf = Buffer.from(opts.token, 'utf8')
  const oauth = opts.oauth

  const httpServer = createServer((req, res) => {
    handle(req, res, serverFactory, tokenBuf, oauth, opts.syncSource).catch((err) => {
      console.error('[choda-deck] http handler error', err)
      if (!res.headersSent) {
        res.writeHead(500)
      }
      try {
        res.end()
      } catch {
        // socket already closed
      }
    })
  })

  const bound = await listen(httpServer, opts.port, opts.bind)
  const modeSuffix = oauth ? ' (OAuth)' : ''
  process.stderr.write(
    `[choda-deck] MCP HTTP listening on ${bound.bind}:${bound.port}${modeSuffix}\n`
  )

  return {
    address: bound,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // close() resolves only once every existing connection is gone. HTTP
        // keep-alive sockets (e.g. undici's global fetch pool used by the tests,
        // or a long-lived client in prod) sit idle for ~5s before they close on
        // their own — long enough that in the full vitest run the callback fires
        // after suite teardown, surfacing as a non-deterministic late error and
        // a dangling 127.0.0.1:xxxxx listener (TASK-1033). Drop idle sockets now
        // so the callback fires promptly; any in-flight request still finishes.
        httpServer.close((err) => (err ? reject(err) : resolve()))
        httpServer.closeIdleConnections()
      })
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  serverFactory: McpServerFactory,
  tokenBuf: Buffer,
  oauth: OAuthConfig | undefined,
  syncSource: PullSource | undefined
): Promise<void> {
  const parsedUrl = new URL(req.url ?? '/', 'http://placeholder')
  const pathname = parsedUrl.pathname
  const method = req.method ?? 'GET'

  if (pathname === '/healthz' && method === 'GET') {
    return sendJson(res, 200, { ok: true })
  }

  if (oauth && (await tryHandleOAuthRoute(req, res, pathname, method, parsedUrl, oauth))) {
    return
  }

  if (pathname === '/sync/since' && method === 'GET') {
    return handleSyncSince(req, res, tokenBuf, oauth, syncSource, parsedUrl)
  }

  if (pathname === '/mcp' && method === 'POST') {
    return handleMcp(req, res, serverFactory, tokenBuf, oauth)
  }

  res.writeHead(404)
  res.end()
}

// ADR-030 Phase 2 — read-only pull endpoint. Auth-gated exactly like /mcp.
// `since` is the caller's Lamport cursor (default 0). Returns the canonical
// row deltas the local reconcile core applies.
async function handleSyncSince(
  req: IncomingMessage,
  res: ServerResponse,
  tokenBuf: Buffer,
  oauth: OAuthConfig | undefined,
  syncSource: PullSource | undefined,
  parsedUrl: URL
): Promise<void> {
  if (!syncSource) {
    res.writeHead(404)
    res.end()
    return
  }
  if (!(await isAuthorized(req.headers.authorization ?? '', tokenBuf, oauth))) {
    sendUnauthorized(res, oauth)
    return
  }
  const sinceRaw = parsedUrl.searchParams.get('since')
  const since = Number.parseInt(sinceRaw ?? '0', 10)
  if (!Number.isFinite(since) || since < 0) {
    res.writeHead(400)
    res.end()
    return
  }
  const deltas = await syncSource.fetchSince(since)
  sendJson(res, 200, { since, deltas })
}

async function tryHandleOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  parsedUrl: URL,
  oauth: OAuthConfig
): Promise<boolean> {
  if (pathname === '/.well-known/oauth-authorization-server' && method === 'GET') {
    sendJson(res, 200, authServerMetadata(oauth.origin))
    return true
  }
  if (pathname === '/.well-known/oauth-protected-resource' && method === 'GET') {
    sendJson(res, 200, protectedResourceMetadata(oauth.origin))
    return true
  }
  if (pathname === '/register' && method === 'POST') {
    let parsed: unknown
    try {
      parsed = await readJson(req)
    } catch (err) {
      writeBodyError(res, err)
      return true
    }
    // No live DCR — return the pinned Keycloak public client.
    const result = handleRegisterStatic(oauth.keycloak, parsed)
    sendJson(res, result.status, result.body)
    return true
  }
  if (pathname === '/authorize' && method === 'GET') {
    // Redirect the browser to Keycloak — login + consent happen there.
    const { location } = handleAuthorizeRedirect(oauth.keycloak, parsedUrl.searchParams)
    res.writeHead(302, { location })
    res.end()
    return true
  }
  if (pathname === '/token' && method === 'POST') {
    let form: URLSearchParams
    try {
      form = await readForm(req)
    } catch (err) {
      writeBodyError(res, err)
      return true
    }
    const result = await handleTokenProxy(oauth.keycloak, form)
    // RFC 6749 §5.1: token endpoint MUST send Cache-Control: no-store
    res.setHeader('Cache-Control', 'no-store')
    sendJson(res, result.status, result.body)
    return true
  }
  return false
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  serverFactory: McpServerFactory,
  tokenBuf: Buffer,
  oauth: OAuthConfig | undefined
): Promise<void> {
  if (!(await isAuthorized(req.headers.authorization ?? '', tokenBuf, oauth))) {
    sendUnauthorized(res, oauth)
    return
  }

  const contentType = (req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.includes('application/json')) {
    res.writeHead(415)
    res.end()
    return
  }

  let raw: Buffer
  try {
    raw = await readBody(req)
  } catch (err) {
    writeBodyError(res, err)
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    res.writeHead(400)
    res.end()
    return
  }

  const server = await serverFactory()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, parsed)
  } finally {
    try {
      await transport.close()
    } catch {
      // already closed
    }
    try {
      await server.close()
    } catch {
      // already closed
    }
  }
}

// Shared gate for /mcp and /sync/since: OAuth JWT when configured, else the
// legacy static bearer.
async function isAuthorized(
  authHeader: string,
  tokenBuf: Buffer,
  oauth: OAuthConfig | undefined
): Promise<boolean> {
  return oauth ? verifyOAuthBearer(authHeader, oauth.verifier) : verifyBearer(authHeader, tokenBuf)
}

function sendUnauthorized(res: ServerResponse, oauth: OAuthConfig | undefined): void {
  if (oauth) {
    const resourceMetadataUrl = `${oauth.origin}/.well-known/oauth-protected-resource`
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`)
  }
  res.writeHead(401)
  res.end()
}

function verifyBearer(authHeader: string, tokenBuf: Buffer): boolean {
  const prefix = 'Bearer '
  if (!authHeader.startsWith(prefix)) return false
  const provided = Buffer.from(authHeader.slice(prefix.length), 'utf8')
  if (provided.length !== tokenBuf.length) return false
  return timingSafeEqual(provided, tokenBuf)
}

async function verifyOAuthBearer(authHeader: string, verifier: JwtVerifier): Promise<boolean> {
  const prefix = 'Bearer '
  if (!authHeader.startsWith(prefix)) return false
  const token = authHeader.slice(prefix.length)
  const claims = await verifier.verify(token)
  // v1: any valid Keycloak token grants the full REMOTE_TOOL_ALLOWLIST surface.
  // TODO(ADR-034): map claims.realm_access.roles / scope → per-tool scoping here.
  return claims !== null
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload).toString()
  })
  res.end(payload)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req)
  return JSON.parse(raw.toString('utf8'))
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readBody(req)
  return new URLSearchParams(raw.toString('utf8'))
}

function writeBodyError(res: ServerResponse, err: unknown): void {
  if (err instanceof BodyTooLargeError) {
    res.writeHead(413)
  } else {
    res.writeHead(400)
  }
  res.end()
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cl = Number.parseInt(req.headers['content-length'] ?? '', 10)
    if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
      reject(new BodyTooLargeError())
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // Settle the promise so the handler can write 413, but keep draining
        // the rest of the request body — closing the socket mid-upload makes
        // the client see a network error before reading the response.
        settle(() => reject(new BodyTooLargeError()))
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks))))
    req.on('error', (err) => settle(() => reject(err)))
  })
}

function listen(
  server: Server,
  port: number,
  bind: string
): Promise<{ port: number; bind: string }> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const addr = server.address()
      const boundPort = typeof addr === 'object' && addr ? addr.port : port
      resolve({ port: boundPort, bind })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, bind)
  })
}
