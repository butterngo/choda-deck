import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { OAuthRepository } from '../../core/domain/repositories/oauth-repository'
import { authServerMetadata, protectedResourceMetadata } from './oauth/discovery'
import { handleRegister } from './oauth/register'
import { handleAuthorizeGet, handleAuthorizePost, type AuthorizeResult } from './oauth/authorize'
import { handleToken } from './oauth/token'

const MAX_BODY_BYTES = 4 * 1024 * 1024

// Stateless mode requires a fresh McpServer + transport per request — the SDK
// transport carries init state across calls, so reusing a single instance
// across requests breaks after the first initialize. The factory hands us a
// new server (with tools already registered against shared services) each
// time. See SDK example simpleStatelessStreamableHttp.js.
export type McpServerFactory = () => Promise<McpServer> | McpServer

export interface OAuthConfig {
  repo: OAuthRepository
  issuer: string // e.g. https://mcp.choda.dev — no trailing slash
  consentPasswordHashHex: string
}

export interface HttpTransportOptions {
  port: number
  bind: string
  token: string // legacy bearer — ignored when `oauth` is set
  oauth?: OAuthConfig
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
    handle(req, res, serverFactory, tokenBuf, oauth).catch((err) => {
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
        httpServer.close((err) => (err ? reject(err) : resolve()))
      })
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  serverFactory: McpServerFactory,
  tokenBuf: Buffer,
  oauth: OAuthConfig | undefined
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

  if (pathname === '/mcp' && method === 'POST') {
    return handleMcp(req, res, serverFactory, tokenBuf, oauth)
  }

  res.writeHead(404)
  res.end()
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
    sendJson(res, 200, authServerMetadata(oauth.issuer))
    return true
  }
  if (pathname === '/.well-known/oauth-protected-resource' && method === 'GET') {
    sendJson(res, 200, protectedResourceMetadata(oauth.issuer))
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
    const result = handleRegister(oauth.repo, parsed)
    sendJson(res, result.status, result.body)
    return true
  }
  if (pathname === '/authorize' && method === 'GET') {
    sendAuthorizeResult(res, handleAuthorizeGet(oauth.repo, parsedUrl.searchParams))
    return true
  }
  if (pathname === '/authorize' && method === 'POST') {
    let form: URLSearchParams
    try {
      form = await readForm(req)
    } catch (err) {
      writeBodyError(res, err)
      return true
    }
    sendAuthorizeResult(
      res,
      handleAuthorizePost(oauth.repo, form, oauth.consentPasswordHashHex)
    )
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
    const result = handleToken(oauth.repo, form)
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
  const authHeader = req.headers.authorization ?? ''
  const authorized = oauth
    ? verifyOAuthBearer(authHeader, oauth.repo)
    : verifyBearer(authHeader, tokenBuf)
  if (!authorized) {
    if (oauth) {
      const resourceMetadataUrl = `${oauth.issuer}/.well-known/oauth-protected-resource`
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`)
    }
    res.writeHead(401)
    res.end()
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

function verifyBearer(authHeader: string, tokenBuf: Buffer): boolean {
  const prefix = 'Bearer '
  if (!authHeader.startsWith(prefix)) return false
  const provided = Buffer.from(authHeader.slice(prefix.length), 'utf8')
  if (provided.length !== tokenBuf.length) return false
  return timingSafeEqual(provided, tokenBuf)
}

function verifyOAuthBearer(authHeader: string, repo: OAuthRepository): boolean {
  const prefix = 'Bearer '
  if (!authHeader.startsWith(prefix)) return false
  const token = authHeader.slice(prefix.length)
  return repo.validateAccessToken(token) !== null
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload).toString()
  })
  res.end(payload)
}

function sendAuthorizeResult(res: ServerResponse, result: AuthorizeResult): void {
  if (result.kind === 'redirect') {
    res.writeHead(302, { location: result.location })
    res.end()
    return
  }
  res.writeHead(result.status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(result.html)
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
