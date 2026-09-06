// TASK-1877 — a real ws client against a real http server on an ephemeral port.
// Nothing is stubbed here: the whole point of this step is that the transport
// is proven, so a mock of the transport would prove nothing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import WebSocket from 'ws'
import { attachTerminalSocket, type TerminalSocketHandle } from './terminal-socket'

const TOKEN = 'terminal-token'

let server: Server
let handle: TerminalSocketHandle
let base: string

/** Connect with a token in the header, the way the proxy will. */
function connect(token: string | null, path = '/terminal'): WebSocket {
  return new WebSocket(`${base}${path}`, {
    headers: token === null ? {} : { 'x-choda-bridge-token': token }
  })
}

const opened = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })

const closed = (ws: WebSocket): Promise<void> =>
  new Promise((resolve) => ws.once('close', () => resolve()))

beforeEach(async () => {
  server = createServer((req, res) => {
    // An ordinary route, so AC-5 has something real to keep answering.
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, url: req.url }))
  })
  handle = attachTerminalSocket(server, { bridgeToken: TOKEN })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await handle.close()
  await new Promise<void>((r) => server.close(() => r()))
})

// ---------------------------------------------------------------------------

describe('AC-1 — the handshake completes AND the socket carries traffic', () => {
  it('echoes a frame back', async () => {
    const ws = connect(TOKEN)
    await opened(ws)
    const reply = await new Promise<string>((resolve) => {
      ws.once('message', (d) => resolve(String(d)))
      ws.send('hello')
    })
    // Not just "it opened". A socket that handshakes and never answers is open
    // and dead, and looks identical from the client until something is sent.
    expect(reply).toBe('echo:hello')
    ws.close()
    await closed(ws)
  })
})

describe('AC-2 — a refusal destroys the socket', () => {
  it('refuses a missing token and destroys the underlying socket', async () => {
    // A raw socket, not a ws client: `ws` swallows the error once a caller
    // handles `unexpected-response`, and this criterion is about the socket
    // itself, not about what the library reports.
    const { connect: netConnect } = await import('net')
    const port = (server.address() as AddressInfo).port
    const sock = netConnect(port, '127.0.0.1')
    const raw = await new Promise<string>((resolve) => {
      let buf = ''
      sock.on('data', (d) => {
        buf += String(d)
      })
      sock.on('close', () => resolve(buf))
      sock.on('connect', () => {
        // Built by joining rather than embedded escapes: a literal CRLF in a
        // source file survives no round trip through the tooling here.
        const CRLF = String.fromCharCode(13, 10)
        sock.write(
          [
            'GET /terminal HTTP/1.1',
            'Host: 127.0.0.1',
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            '',
            ''
          ].join(CRLF)
        )
      })
    })
    expect(raw).toContain('401')
    // The discriminator: refusing at the application layer while leaving the
    // connection up is a half-open door, and it looks identical to this from
    // the client unless the socket itself is asserted. The `close` above only
    // fires because the server destroyed it.
    expect(sock.destroyed).toBe(true)
  })

  it('refuses a WRONG token too, not merely an absent one', async () => {
    const ws = connect('not-the-token')
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.once('error', () => resolve(-1))
    })
    expect(status).toBe(401)
  })

  it('refuses a path that is not /terminal rather than leaving it hanging', async () => {
    const ws = connect(TOKEN, '/not-terminal')
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.once('error', () => resolve(-1))
    })
    expect(status).toBe(404)
  })
})

describe('AC-4 — nothing leaks per open', () => {
  it('closing the client drops the adapter side', async () => {
    const ws = connect(TOKEN)
    await opened(ws)
    expect(handle.openCount).toBe(1)
    ws.close()
    await closed(ws)
    await new Promise((r) => setTimeout(r, 50))
    // A terminal opened and closed all day is what finds this.
    expect(handle.openCount).toBe(0)
  })

  it('ten opens and closes leave nothing behind', async () => {
    for (let i = 0; i < 10; i++) {
      const ws = connect(TOKEN)
      await opened(ws)
      ws.close()
      await closed(ws)
    }
    await new Promise((r) => setTimeout(r, 50))
    // One count after one open would pass against a set that never deletes;
    // ten would not.
    expect(handle.openCount).toBe(0)
  })

  it('closing the adapter side closes the client', async () => {
    const ws = connect(TOKEN)
    await opened(ws)
    const done = closed(ws)
    await handle.close()
    await done
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('close() removes the upgrade listener from the http server', async () => {
    expect(server.listenerCount('upgrade')).toBe(1)
    await handle.close()
    // Left attached, this module outlives the thing that owns it.
    expect(server.listenerCount('upgrade')).toBe(0)
  })
})

describe('AC-5 — ordinary requests are untouched', () => {
  it('answers a plain GET with the socket attached', async () => {
    const httpBase = base.replace('ws://', 'http://')
    const res = await fetch(`${httpBase}/anything`)
    expect(res.status).toBe(200)
    // Attaching an upgrade handler that swallows normal traffic is easy to do
    // and easy to miss.
    expect(await res.json()).toEqual({ ok: true, url: '/anything' })
  })
})

describe('AC-6 — no child process on this path', () => {
  it('the module imports no process-spawning API', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync(new URL('./terminal-socket.ts', import.meta.url), 'utf8')
    // Read from the source rather than asserted about behaviour: step two
    // arriving early would make this whole step prove nothing, and the cheapest
    // way to notice is that the import appeared.
    expect(src).not.toMatch(/child_process|node-pty|\bspawn\b|execFile/)
  })
})
