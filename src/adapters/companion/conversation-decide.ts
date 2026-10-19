// TASK-2541 (from INBOX-1738) — record a conversation's decision from the companion.
//
// The bridge could read a thread (GET /conversations/:id, TASK-1568) but not
// decide one, so the companion's "close" could only hide it for the reader.
// The domain already decides threads; this is the missing HTTP surface.
//
// It keeps the domain's meaning on purpose: a decide appends a `decision` turn
// and sets decisionSummary, and the thread folds to `decided` only once every
// participant has signed off (conversation-fold.test.ts). Signing off for
// everyone from here would make a signoff mean nothing, so this route does not.
//
// POST /conversations/:id/decide { decision, author? } — bridge-token gated,
// because it writes. Any other method on this path is 405 here rather than
// falling through to the detail route, which only matches the bare id.

import type { IncomingMessage, ServerResponse } from 'http'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

const MAX_BODY_BYTES = 64 * 1024
const DECIDE_PATH = /^\/conversations\/([^/]+)\/decide$/

export interface ConversationDecideOptions {
  bridgeToken: string
  svc: Pick<BackendTaskService, 'getConversation' | 'decideConversation'>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** Returns true when it handled the request. */
export async function handleConversationDecideRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ConversationDecideOptions
): Promise<boolean> {
  const match = (req.url ?? '').split('?')[0]?.match(DECIDE_PATH)
  if (!match) return false

  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  const given = req.headers['x-choda-bridge-token']
  if (typeof given !== 'string' || given !== opts.bridgeToken) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }

  const raw = await readBody(req)
  if (raw === null) {
    sendJson(res, 413, { error: 'too large' })
    return true
  }
  let parsed: { decision?: unknown; author?: unknown }
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as typeof parsed)
  } catch {
    sendJson(res, 400, { error: 'body is not valid JSON' })
    return true
  }
  if (typeof parsed.decision !== 'string' || parsed.decision.trim() === '') {
    sendJson(res, 400, { error: 'decision is required' })
    return true
  }

  const id = decodeURIComponent(match[1] ?? '')
  if (!(await opts.svc.getConversation(id))) {
    sendJson(res, 404, { error: `unknown conversation: ${id}` })
    return true
  }

  const author = typeof parsed.author === 'string' && parsed.author.trim() !== '' ? parsed.author.trim() : 'companion'
  const { conversation } = await opts.svc.decideConversation(id, { author, decision: parsed.decision.trim() })
  sendJson(res, 200, { conversation })
  return true
}
