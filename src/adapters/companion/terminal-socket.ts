// TASK-1877 — the adapter's first WebSocket, and it deliberately carries no PTY.
//
// Every other route in this adapter is request/response; nothing here has ever
// streamed. And the Electron proxy that injects the bridge token has never
// handled an `upgrade`. Two unknowns at once, under a shell, would mean a
// failure could be the socket, the proxy, or the PTY — and telling those apart
// costs more than proving the transport on its own.
//
// So this echoes. Useless by itself, and that is the point: when the PTY lands
// in TASK-1878 and misbehaves, the transport underneath it is already known
// good, and the search starts at the shell.
//
// The token cannot come from the page. A browser `WebSocket` cannot set request
// headers, so the proxy attaches it during the upgrade — which is exactly why
// AC-3 stands the proxy up in front of a stub and drives a real upgrade through
// it rather than assuming a relay works.

import type { Server, IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import { WebSocketServer, type WebSocket } from 'ws'

export const TERMINAL_PATH = '/terminal'

/**
 * A refusal during an upgrade has no response object to write a JSON body into,
 * so it is spelled out here: a status line, then the socket is DESTROYED.
 *
 * Refusing at the application layer while leaving the socket connected is a
 * half-open door — the caller holds a live TCP connection to a server that has
 * decided not to talk to it. A test asserts `socket.destroyed`, not merely that
 * no message arrived, because those two look identical from the client.
 */
function refuse(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
  } catch {
    // The peer may already be gone. Destroying is what matters, not the notice.
  }
  socket.destroy()
}

/** What a socket does with the frames it receives. */
export interface TerminalSession {
  handle: (raw: string) => Promise<void> | void
  dispose: () => void
}

export interface TerminalSocketOptions {
  bridgeToken: string
  /**
   * TASK-1878 — build the PTY session for one socket. Omitted, the socket
   * echoes, which is what the transport tests drive: they must keep proving
   * the socket without a shell in the way.
   */
  createSession?: (sink: { send: (frame: Record<string, unknown>) => void }) => TerminalSession
}

export interface TerminalSocketHandle {
  /** Open sockets right now — the number a leak would grow without bound. */
  readonly openCount: number
  close: () => Promise<void>
}

/**
 * Attach the terminal WebSocket to an existing http server.
 *
 * `noServer: true` rather than passing the server in: `ws` would then own the
 * `upgrade` event and answer every path, and the refusal above has to happen
 * before any handshake is completed, not after.
 */
export function attachTerminalSocket(
  server: Server,
  opts: TerminalSocketOptions
): TerminalSocketHandle {
  const wss = new WebSocketServer({ noServer: true })
  const open = new Set<WebSocket>()

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== TERMINAL_PATH) {
      // Not ours. Refuse rather than ignore: an unanswered upgrade leaves the
      // socket hanging until a timeout somebody else has to explain.
      refuse(socket, 404, 'Not Found')
      return
    }

    const given = req.headers['x-choda-bridge-token']
    if (typeof given !== 'string' || given !== opts.bridgeToken) {
      refuse(socket, 401, 'Unauthorized')
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      open.add(ws)
      // TASK-1878 — one PTY per socket. Without a session factory this is the
      // echo server TASK-1877 shipped, which is still what the transport tests
      // drive: they prove the socket, not the shell.
      const session = opts.createSession
        ? opts.createSession({ send: (frame) => ws.send(JSON.stringify(frame)) })
        : null
      ws.on('message', (data: unknown, isBinary: boolean) => {
        if (isBinary) return
        if (session) void session.handle(String(data))
        else ws.send(`echo:${String(data)}`)
      })
      // One removal path for every way a socket can end, so the set cannot
      // grow by one per terminal a reader opens and closes all day.
      const forget = (): void => {
        open.delete(ws)
        // The shell dies with its socket. Without this a day of opening the
        // terminal leaves a process per open.
        session?.dispose()
      }
      ws.on('close', forget)
      ws.on('error', forget)
    })
  }

  server.on('upgrade', onUpgrade)

  return {
    get openCount() {
      return open.size
    },
    close: () =>
      new Promise<void>((resolve) => {
        // The listener comes off the http server too. Leaving it attached would
        // keep this module alive across a restart of the thing that owns it.
        server.off('upgrade', onUpgrade)
        for (const ws of open) ws.close()
        wss.close(() => resolve())
      })
  }
}
