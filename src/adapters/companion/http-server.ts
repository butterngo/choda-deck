// TASK-1158 — the companion's local HTTP surface. A plain Node http server (no
// MCP SDK, no transport, registers no tools) bound to 127.0.0.1 ONLY (AC-4). The
// web app is its single client; the laptop's sync engine owns laptop↔remote, so
// this process never talks to the remote and never holds an OAuth credential.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import type { CompanionServices } from './service-factory'
import type { WorkspaceRow } from '../../core/domain/repositories/workspace-repository'
import { computeLedger } from './sync-ledger'
import { computeSyncLog } from './sync-log'
import { computeHealth } from './sync-health'
import { SyncNotConfiguredError } from './sync-actions'
import { handleWorkflowRoute } from './workflow'
import { handleKnowledgeRoute } from './knowledge'
import { handleGraphRoute } from './graph'
import { handleSearchRoute } from './search'
import { handleTaskDetailRoute } from './task-detail'
import { handleArtifactsRoute } from './artifacts'
import { handleConversationDetailRoute } from './conversation-detail'
import {
  CAPTURE_MAX_IMAGE_BYTES,
  capForKind,
  CaptureBadRequestError,
  CaptureNotFoundError,
  CaptureNotImplementedError,
  validateCapture
} from './capture-contract'

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

  // TASK-1330 — capture bridge. Token-gated (writes triggered from a web page),
  // contract-validated. Dispatch onto inbox/task/conversation/knowledge is
  // TASK-1331; without a dispatcher a valid capture 501s.
  if (method === 'POST' && path === '/capture') {
    return handleCapture(req, res, services)
  }

  // TASK-1171 — workflow focus feed + the light task/session actions (the only
  // mutating task routes on this surface). Handled before the GET-only guard so
  // its POSTs work; returns false when the path isn't a workflow route.
  if (await handleWorkflowRoute(req, res, services.svc)) {
    return
  }

  // TASK-1172 — knowledge + graph read endpoints (pillar-3). GET-only, so they
  // fall through cleanly to the method guard below if unmatched.
  if (await handleKnowledgeRoute(req, res, services.svc)) {
    return
  }
  if (await handleGraphRoute(req, res, services.svc)) {
    return
  }

  // TASK-1493 — cross-project search (tasks + knowledge). GET-only.
  if (await handleSearchRoute(req, res, services.svc)) {
    return
  }

  // Task-detail read for the graph node panel. GET /tasks/:id (POST
  // /tasks/:id/ready is a workflow route, handled above).
  if (await handleTaskDetailRoute(req, res, services.svc)) {
    return
  }

  // TASK-1568 — conversation detail. Only matches /conversations/:id, so bare
  // /conversations still falls through to the exact-match switch below.
  if (await handleConversationDetailRoute(req, res, services.svc)) {
    return
  }

  // TASK-1566 — capture artifacts (bytes, not JSON). Matched on the RAW url
  // before the exact-match switch below, because `new URL()` would collapse a
  // traversal attempt into a path that never reaches this route. Token-gated:
  // these files carry cookies, auth headers and screenshots.
  if (
    handleArtifactsRoute(req, res, {
      artifactsDir: services.artifactsDir,
      bridgeToken: services.bridgeToken
    })
  ) {
    return
  }

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
    case '/workspaces':
      return sendJson(res, 200, { workspaces: await listAllWorkspaces(services) })
    case '/tasks':
      return sendJson(res, 200, { tasks: await services.svc.findTasks({}) })
    case '/inbox':
      return sendJson(res, 200, { inbox: await services.svc.findInbox({}) })
    case '/conversations':
      return sendJson(res, 200, { conversations: await listAllConversations(services) })
    case '/sync/ledger':
      return sendJson(res, 200, { ledger: computeLedger(services.db) })
    case '/sync/log': {
      const rawLimit = url.searchParams.get('limit')
      const limit = rawLimit === null ? undefined : Number(rawLimit)
      return sendJson(res, 200, { events: computeSyncLog(services.db, limit) })
    }
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

// findWorkspaces is project-scoped; the companion needs a flat list for a
// workspace picker, so fan out over the project list and flatten. Archived
// workspaces excluded by default (findWorkspaces' own default) so they don't
// clutter the picker.
async function listAllWorkspaces(services: CompanionServices): Promise<WorkspaceRow[]> {
  const projects = await services.svc.listProjects()
  const all: WorkspaceRow[] = []
  for (const p of projects) {
    all.push(...(await services.svc.findWorkspaces(p.id)))
  }
  return all
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

class BodyTooLargeError extends Error {
  constructor() {
    super('body too large')
    this.name = 'BodyTooLargeError'
  }
}

// Constant-time compare of the x-choda-bridge-token header against the profile
// token. Length-guarded so timingSafeEqual never throws on a mismatched size.
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const provided = Buffer.from(header, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return false
  return timingSafeEqual(provided, expectedBuf)
}

// Read the request body up to `cap` bytes, rejecting once it exceeds. Mirrors the
// MCP http-transport reader: settle early on overflow but keep draining so the
// client reads our 413 instead of a socket reset. The route reads at the image
// ceiling, then applies the tighter per-kind cap once the kind is known.
function readCappedBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cl = Number.parseInt(req.headers['content-length'] ?? '', 10)
    if (Number.isFinite(cl) && cl > cap) {
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
      if (size > cap) settle(() => reject(new BodyTooLargeError()))
      else chunks.push(chunk)
    })
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks))))
    req.on('error', (err) => settle(() => reject(err)))
  })
}

async function handleCapture(
  req: IncomingMessage,
  res: ServerResponse,
  services: CompanionServices
): Promise<void> {
  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, services.bridgeToken)) {
    return sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
  }
  const contentType = (req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.includes('application/json')) {
    return sendJson(res, 415, { error: 'content-type must be application/json' })
  }
  let raw: Buffer
  try {
    // Read to the absolute (image) ceiling; the tighter per-kind cap is applied
    // below once the kind is known.
    raw = await readCappedBody(req, CAPTURE_MAX_IMAGE_BYTES)
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return sendJson(res, 413, { error: `body exceeds ${CAPTURE_MAX_IMAGE_BYTES} bytes` })
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return sendJson(res, 400, { error: 'body is not valid JSON' })
  }
  const validation = validateCapture(parsed)
  if (!validation.ok) {
    return sendJson(res, 400, { error: validation.error })
  }
  // Per-kind body cap: text/network 64 KB, image larger. Checked against the raw
  // bytes so an oversize payload of any kind returns 413 (not a downstream error).
  const cap = capForKind(validation.value.kind)
  if (raw.length > cap) {
    return sendJson(res, 413, { error: `${validation.value.kind} body exceeds ${cap} bytes` })
  }
  // No dispatcher wired yet (TASK-1331) → the contract is accepted but nothing
  // routes it. Distinct from 400: the request was well-formed.
  if (!services.dispatch) {
    return sendJson(res, 501, { error: 'capture dispatch not implemented' })
  }
  try {
    const result = await services.dispatch.dispatch(validation.value)
    return sendJson(res, 200, result)
  } catch (err) {
    if (err instanceof CaptureBadRequestError) {
      return sendJson(res, 400, { error: err.message })
    }
    if (err instanceof CaptureNotFoundError) {
      return sendJson(res, 404, { error: err.message })
    }
    if (err instanceof CaptureNotImplementedError) {
      return sendJson(res, 501, { error: err.message })
    }
    throw err
  }
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
