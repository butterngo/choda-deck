// TASK-1158 — the companion's local HTTP surface. A plain Node http server (no
// MCP SDK, no transport, registers no tools) bound to 127.0.0.1 ONLY (AC-4). The
// web app is its single client; the laptop's sync engine owns laptop↔remote, so
// this process never talks to the remote and never holds an OAuth credential.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import type { CompanionServices } from './service-factory'
import { computeLedger } from './sync-ledger'
import { computeHealth } from './sync-health'
import { SyncNotConfiguredError } from './sync-actions'

// Hard-coded loopback bind — never read from env. AC-4: the adapter must not be
// exposable on a public interface.
export const COMPANION_BIND = '127.0.0.1'

export interface CompanionServerHandle {
  address: { port: number; bind: string }
  close: () => Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  services: CompanionServices
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  // TASK-1175 — mutating sync actions are POST-only. A SyncNotConfiguredError
  // (no remote on this laptop) maps to 409 so the UI shows a real reason, never a
  // silent success (AC-3).
  if (method === 'POST' && (path === '/sync/pull' || path === '/sync/push')) {
    try {
      const result = path === '/sync/pull' ? await services.pull() : await services.push()
      return sendJson(res, 200, result)
    } catch (err) {
      if (err instanceof SyncNotConfiguredError) {
        return sendJson(res, 409, { error: err.message })
      }
      throw err
    }
  }

  if (method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }

  switch (path) {
    case '/healthz':
      return sendJson(res, 200, { ok: true })
    case '/projects':
      return sendJson(res, 200, { projects: await services.svc.listProjects() })
    case '/tasks':
      return sendJson(res, 200, { tasks: await services.svc.findTasks({}) })
    case '/inbox':
      return sendJson(res, 200, { inbox: await services.svc.findInbox({}) })
    case '/conversations':
      return sendJson(res, 200, { conversations: await listAllConversations(services) })
    case '/sync/ledger':
      return sendJson(res, 200, { ledger: computeLedger(services.db) })
    case '/sync/health':
      return sendJson(
        res,
        200,
        computeHealth(services.db, { intervalMs: services.intervalMs, nowMs: Date.now() })
      )
    default:
      return sendJson(res, 404, { error: 'not found' })
  }
}

// findConversations is project-scoped; the companion shows them across projects,
// so fan out over the project list and flatten.
async function listAllConversations(services: CompanionServices): Promise<unknown[]> {
  const projects = await services.svc.listProjects()
  const all: unknown[] = []
  for (const p of projects) {
    all.push(...(await services.svc.findConversations(p.id)))
  }
  return all
}

export function startCompanionServer(
  services: CompanionServices,
  port: number
): Promise<CompanionServerHandle> {
  const server: Server = createServer((req, res) => {
    route(req, res, services).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, COMPANION_BIND, () => {
      const addr = server.address()
      const boundPort = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        address: { port: boundPort, bind: COMPANION_BIND },
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          })
      })
    })
  })
}
