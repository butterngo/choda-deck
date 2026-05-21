import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

const MAX_BODY_BYTES = 4 * 1024 * 1024

// Stateless mode requires a fresh McpServer + transport per request — the SDK
// transport carries init state across calls, so reusing a single instance
// across requests breaks after the first initialize. The factory hands us a
// new server (with tools already registered against shared services) each
// time. See SDK example simpleStatelessStreamableHttp.js.
export type McpServerFactory = () => Promise<McpServer> | McpServer

export interface HttpTransportOptions {
  port: number
  bind: string
  token: string
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

  const httpServer = createServer((req, res) => {
    handle(req, res, serverFactory, tokenBuf).catch((err) => {
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
  process.stderr.write(`[choda-deck] MCP HTTP listening on ${bound.bind}:${bound.port}\n`)

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
  tokenBuf: Buffer
): Promise<void> {
  const url = req.url ?? ''
  const method = req.method ?? 'GET'

  if (url === '/healthz' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
    return
  }

  if (url === '/mcp' && method === 'POST') {
    if (!verifyBearer(req.headers.authorization ?? '', tokenBuf)) {
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
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413)
        res.end()
        return
      }
      res.writeHead(400)
      res.end()
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
    return
  }

  res.writeHead(404)
  res.end()
}

function verifyBearer(authHeader: string, tokenBuf: Buffer): boolean {
  const prefix = 'Bearer '
  if (!authHeader.startsWith(prefix)) return false
  const provided = Buffer.from(authHeader.slice(prefix.length), 'utf8')
  if (provided.length !== tokenBuf.length) return false
  return timingSafeEqual(provided, tokenBuf)
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
