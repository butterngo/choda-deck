// TASK-2758 — the adapter starts the assistant service and forwards /assistant/*
// to it (Butter, discovery CONV-1792980384690-64, round 3).
//
// Why the adapter and not the launchers: the companion has two ways to start
// (the Task Scheduler service on 7338 and the Electron app on an ephemeral
// port), and a process only one of them started would be silently absent
// under the other (gotcha registered-to-auto-start-is-not-serving-prove-which-
// path-owns-the-port). Both start this adapter, so both get the assistant, and
// the web keeps calling /api/assistant/* exactly as before.
//
// The child is `assistant-server.cjs` beside the adapter bundle, run on the
// same executable the adapter runs on (under Electron that is the Electron
// binary with ELECTRON_RUN_AS_NODE, gotcha packaging-the-companion-adapter-for-
// electron-needs-electron-run-as-node-a-native). It binds port 0 and prints
// `[assistant] listening on http://127.0.0.1:<port>` on stdout; until that line
// arrives, and after the child exits, every /assistant/* request answers 503.
// An exit is followed by one respawn on the next request; a second exit within
// 60 s of the first leaves it down. No model call happens here.

import { spawn, type ChildProcess } from 'child_process'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'http'
import * as fs from 'fs'
import * as path from 'path'

const LISTEN_LINE = /\[assistant\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const RESPAWN_WINDOW_MS = 60_000
export const ASSISTANT_CHILD_FILE = 'assistant-server.cjs'

export interface AssistantChildOptions {
  /** The assistant bundle to run. */
  entry: string
  dataDir: string
  bridgeToken: string
  /** The adapter's own port, handed to the child as CHODA_ADAPTER_URL. */
  adapterPort: number
  /** Defaults to process.execPath, the executable this adapter runs on. */
  execPath?: string
  log?: (line: string) => void
  now?: () => number
}

/** Where the assistant bundle sits for this adapter process, or null when absent. */
export function resolveAssistantEntry(): string | null {
  const override = process.env.CHODA_ASSISTANT_ENTRY?.trim()
  const candidates = [override, path.join(__dirname, ASSISTANT_CHILD_FILE)].filter(Boolean) as string[]
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

/** True for every path the assistant service owns. */
export function isAssistantPath(url: string | undefined): boolean {
  const p = (url ?? '').split('?')[0] ?? ''
  return p === '/assistant/models' || p === '/assistant/chats' || p.startsWith('/assistant/')
}

function sendUnavailable(res: ServerResponse): void {
  res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'assistant service unavailable' }))
}

export class AssistantChild {
  private child: ChildProcess | null = null
  private port: number | null = null
  private exits: number[] = []
  private stopped = false
  private closing = false
  private readonly log: (line: string) => void
  private readonly now: () => number

  constructor(private readonly opts: AssistantChildOptions) {
    this.log = opts.log ?? ((l) => console.error(l))
    this.now = opts.now ?? Date.now
  }

  /** The child's pid while one is running (tests, diagnostics). */
  get pid(): number | null {
    return this.child?.pid ?? null
  }

  get listeningPort(): number | null {
    return this.port
  }

  /** How many children have been spawned so far. */
  spawns = 0

  start(): void {
    if (this.child || this.stopped || this.closing) return
    this.spawns += 1
    const child = spawn(this.opts.execPath ?? process.execPath, [this.opts.entry], {
      env: {
        ...process.env,
        // Harmless under plain node; required when execPath is the Electron binary.
        ELECTRON_RUN_AS_NODE: '1',
        CHODA_ASSISTANT_PORT: '0',
        CHODA_DATA_DIR: this.opts.dataDir,
        CHODA_BRIDGE_TOKEN: this.opts.bridgeToken,
        CHODA_ADAPTER_URL: `http://127.0.0.1:${this.opts.adapterPort}`
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    this.port = null

    const lines = (stream: NodeJS.ReadableStream | null, onLine: (l: string) => void): void => {
      let buf = ''
      stream?.setEncoding?.('utf8')
      stream?.on('data', (chunk: string) => {
        buf += chunk
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, nl).replace(/\r$/, ''))
          buf = buf.slice(nl + 1)
        }
      })
    }
    lines(child.stdout, (l) => {
      const m = LISTEN_LINE.exec(l)
      if (m && this.child === child) this.port = Number(m[1])
      if (l.trim() !== '') this.log(l.startsWith('[assistant]') ? l : `[assistant] ${l}`)
    })
    lines(child.stderr, (l) => {
      if (l.trim() !== '') this.log(l.startsWith('[assistant]') ? l : `[assistant] ${l}`)
    })

    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.port = null
      if (this.closing) return
      const at = this.now()
      const previous = this.exits.at(-1)
      this.exits.push(at)
      this.log(`[assistant] exited (${signal ?? code})`)
      if (previous !== undefined && at - previous <= RESPAWN_WINDOW_MS) {
        this.stopped = true
        this.log('[assistant] stopped after two exits')
      }
    })
    child.on('error', (err) => this.log(`[assistant] could not start: ${err.message}`))
  }

  /** Forwards one /assistant/* request. Always answers. */
  handle(req: IncomingMessage, res: ServerResponse): void {
    if (this.port === null) {
      // Down after an exit: answer now, and bring one back for the next request.
      if (!this.child && !this.stopped) this.start()
      sendUnavailable(res)
      return
    }
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: this.port,
        method: req.method,
        path: req.url,
        headers: req.headers
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        // Piped as it arrives: a text/event-stream reply must reach the client
        // event by event, never buffered.
        upRes.pipe(res)
      }
    )
    upstream.on('error', () => {
      if (!res.headersSent) sendUnavailable(res)
      else res.destroy()
    })
    // The client hanging up ends the upstream request too, so the service sees
    // the close and aborts its provider call.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    req.pipe(upstream)
  }

  stop(): void {
    this.closing = true
    this.child?.kill()
    this.child = null
    this.port = null
  }
}
