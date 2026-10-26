// TASK-2755 — the assistant service's HTTP server: its own process, its own
// assistant.db, bound to 127.0.0.1 only. The companion adapter spawns it and
// forwards /assistant/* to it (TASK-2758); nothing else reaches it.
//
// Every request must carry x-choda-bridge-token. The service has no route of
// its own outside /assistant/, and answers anything else with 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import * as path from 'path'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import Database from 'better-sqlite3'
import { ChatStore } from './chat-store'
import { migrateSharedChats } from './migrate'
import { handleAssistantRoute, sendJson } from './routes'

export const ASSISTANT_BIND = '127.0.0.1'
export const ASSISTANT_DB_FILE = 'assistant.db'

export interface AssistantServiceOptions {
  dataDir: string
  /** The shared choda-deck.db, read once for the migration. */
  sharedDbPath: string
  bridgeToken: string
  fetchImpl?: typeof fetch
  /** Where the listening line goes; stdout in production. */
  log?: (line: string) => void
}

export interface AssistantServiceHandle {
  port: number
  store: ChatStore
  busy: Set<string>
  migrated: number
  close: () => Promise<void>
}

/** A further route handler, tried after the free routes (the message routes, TASK-2757). */
export type ExtraRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { store: ChatStore; busy: Set<string>; dataDir: string; fetchImpl?: typeof fetch }
) => Promise<boolean>

function tokenMatches(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const a = Buffer.from(header, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function startAssistantService(
  opts: AssistantServiceOptions,
  port: number,
  extraRoutes: ExtraRoute[] = []
): Promise<AssistantServiceHandle> {
  const db = new Database(path.join(opts.dataDir, ASSISTANT_DB_FILE))
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  const store = new ChatStore(db)
  const migrated = migrateSharedChats(store, opts.sharedDbPath)
  const busy = new Set<string>()
  const ctx = { store, busy, dataDir: opts.dataDir, fetchImpl: opts.fetchImpl }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!tokenMatches(req.headers['x-choda-bridge-token'], opts.bridgeToken)) {
      sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
      return
    }
    if (await handleAssistantRoute(req, res, { ...ctx, bridgeToken: opts.bridgeToken })) return
    for (const extra of extraRoutes) {
      if (await extra(req, res, ctx)) return
    }
    sendJson(res, 404, { error: 'not found' })
  }

  const server: Server = createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, ASSISTANT_BIND, () => resolve())
  })
  const bound = (server.address() as AddressInfo).port
  ;(opts.log ?? ((l) => process.stdout.write(`${l}\n`)))(`[assistant] listening on http://${ASSISTANT_BIND}:${bound}`)

  return {
    port: bound,
    store,
    busy,
    migrated,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close()
          resolve()
        })
        server.closeAllConnections?.()
      })
  }
}
